#!/usr/bin/env python3
"""
Normalise a Claude-Code skill pack into a host-neutral one.

Why: the trader packs write their commands as
    python3 "${CLAUDE_SKILL_DIR}/size.py"
`CLAUDE_SKILL_DIR` is a Claude Code variable. Under any other host it expands to
nothing, so the command silently becomes `python3 "/size.py"`. This port rewrites
those host-specific variables into {{SKILL_DIR}} (resolved by every host we run)
and records provenance.

Usage:
    python3 tools/port_skill.py --src <vendor-dir> --out <skills-dir> [--pack NAME]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path

# host-specific variables -> the neutral placeholder
VARS = {
    "${CLAUDE_SKILL_DIR}": "{{SKILL_DIR}}",
    "$CLAUDE_SKILL_DIR": "{{SKILL_DIR}}",
    "${CLAUDE_PLUGIN_ROOT}": "{{SKILLS_ROOT}}",
    "$CLAUDE_PLUGIN_ROOT": "{{SKILLS_ROOT}}",
}

# Claude-only frontmatter keys we drop
DROP_KEYS = ("allowed-tools", "argument-hint-claude")

COPY_SUFFIXES = {".py", ".md", ".json", ".txt", ".csv", ".yaml", ".yml"}
TEXT_FILES = {".md", ".py", ".json", ".yaml", ".yml"}


def digest(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()[:16]


def rewrite_text(text: str) -> tuple[str, list[str]]:
    hits = []
    for old, new in VARS.items():
        if old in text:
            hits.append(old)
            text = text.replace(old, new)
    # make the interpreter explicit so a host can substitute it
    text = re.sub(r'\bpython3\s+"\{\{SKILL_DIR\}\}', '{{PY}} "{{SKILL_DIR}}', text)
    return text, hits


def parse_frontmatter(text: str) -> tuple[dict, str]:
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end < 0:
        return {}, text
    raw = text[3:end].strip("\n")
    body = text[end + 4:]
    meta = {}
    key = None
    for line in raw.splitlines():
        if re.match(r"^[A-Za-z0-9_-]+:", line):
            key, _, val = line.partition(":")
            meta[key.strip()] = val.strip()
        elif key and line.strip():
            meta[key] += " " + line.strip()
    return meta, body


def port_skill(src: Path, out: Path, pack: str, commit: str) -> dict | None:
    skill_md = src / "SKILL.md"
    if not skill_md.exists():
        return None

    dst = out / src.name
    dst.mkdir(parents=True, exist_ok=True)

    changed = []
    # copy payload files with the variable rewrite applied to text
    for f in src.rglob("*"):
        if not f.is_file() or f.name == "SKILL.md":
            continue
        if f.suffix.lower() not in COPY_SUFFIXES:
            continue
        rel = f.relative_to(src)
        target = dst / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if f.suffix.lower() in TEXT_FILES:
            text = f.read_text(errors="replace")
            new, hits = rewrite_text(text)
            if hits:
                changed.append(str(rel))
            target.write_text(new)
        else:
            shutil.copy2(f, target)

    meta, body = parse_frontmatter(skill_md.read_text(errors="replace"))
    body, body_hits = rewrite_text(body)
    if body_hits:
        changed.append("SKILL.md")

    name = meta.get("name") or src.name
    desc = re.sub(r"\s+", " ", meta.get("description", "")).strip()
    desc = desc.replace(">-", "").strip()

    front = [
        "---",
        f"name: {name}",
        f"description: {json.dumps(desc[:900])}",
        f"version: 1.0.0",
        f"license: MIT",
        f"metadata:",
        f"  pipnex:",
        f"    pack: {pack}",
        f"    upstream: {src.name}",
        f"    upstream_commit: {commit}",
        f"    provider_neutral: true",
        f"    requires: [python3]",
        "---",
    ]
    (dst / "SKILL.md").write_text("\n".join(front) + "\n" + body.lstrip("\n"))

    return {
        "name": name,
        "description": desc[:400],
        "dir": str(dst),
        "pack": pack,
        "upstream": src.name,
        "commit": commit,
        "rewritten": changed,
        "files": sorted(p.name for p in dst.rglob("*") if p.is_file()),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="cloned upstream repo")
    ap.add_argument("--out", required=True, help="normalised skills dir")
    ap.add_argument("--pack", required=True, help="pack label, e.g. day-trader")
    args = ap.parse_args()

    src_root = Path(args.src).resolve()
    out_root = Path(args.out).resolve()
    out_root.mkdir(parents=True, exist_ok=True)

    # upstream commit, if it is a git checkout
    commit = "unknown"
    head = src_root / ".git" / "HEAD"
    if head.exists():
        ref = head.read_text().strip()
        if ref.startswith("ref:"):
            p = src_root / ".git" / ref.split(":", 1)[1].strip()
            if p.exists():
                commit = p.read_text().strip()[:12]
        else:
            commit = ref[:12]

    results = []
    for child in sorted(src_root.iterdir()):
        if not child.is_dir() or child.name.startswith("."):
            continue
        r = port_skill(child, out_root, args.pack, commit)
        if r:
            results.append(r)

    leftover = []
    for r in results:
        for f in (Path(r["dir"])).rglob("*.md"):
            if "CLAUDE_" in f.read_text(errors="replace"):
                leftover.append(str(f))

    print(json.dumps({
        "pack": args.pack, "commit": commit, "count": len(results),
        "skills": results, "unresolved_vars": leftover,
    }, indent=2))
    return 1 if leftover else 0


if __name__ == "__main__":
    raise SystemExit(main())
