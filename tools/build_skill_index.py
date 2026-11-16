#!/usr/bin/env python3
"""Build skills/index.json — the progressive-disclosure catalogue Trish loads.

Only name + description go into the prompt; the body is fetched on demand by the
read_skill tool, so 27 skills cost ~2 KB of context instead of 200 KB.
"""
import json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKILLS = ROOT / "skills"


def parse(p: Path) -> dict | None:
    text = p.read_text(errors="replace")
    if not text.startswith("---"):
        return None
    end = text.find("\n---", 3)
    if end < 0:
        return None
    raw, body = text[3:end], text[end + 4:]
    meta, key = {}, None
    for line in raw.splitlines():
        if re.match(r"^[A-Za-z0-9_-]+:", line):
            key, _, val = line.partition(":")
            meta[key.strip()] = val.strip()
        elif key and line.strip():
            meta[key] += " " + line.strip()
    name = meta.get("name") or p.parent.name
    desc = meta.get("description", "").strip()
    desc = re.sub(r"^[>\-|]\s*", "", desc)
    desc = re.sub(r"\s+", " ", desc).strip().strip('"')
    layer = "L1" if name == "trish-desk-method" else ("L3" if (p.parent.parent.name == "trish") else "L2")
    return {
        "name": name,
        "description": desc[:400],
        "layer": layer,
        "path": str(p.relative_to(ROOT)),
        "chars": len(body),
    }


def main() -> int:
    entries = []
    for p in sorted(SKILLS.rglob("SKILL.md")):
        e = parse(p)
        if e:
            entries.append(e)
    entries.sort(key=lambda e: ({"L1": 0, "L3": 1, "L2": 2}[e["layer"]], e["name"]))
    out = {"count": len(entries), "entries": entries}
    (SKILLS / "index.json").write_text(json.dumps(out, indent=2) + "\n")
    print(json.dumps({"count": len(entries),
                      "layers": {k: sum(1 for e in entries if e["layer"] == k) for k in ("L1", "L2", "L3")},
                      "prompt_chars": sum(len(e["name"]) + len(e["description"]) + 4 for e in entries)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
