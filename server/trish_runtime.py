#!/usr/bin/env python3
"""
Trish's engine runtime — a project-owned Hermes checkout, not the user's install.

Everything here is file-and-process management around `vendor/hermes-agent`:

  runtime/venv            the venv the engine runs in (Python 3.14, uv.lock)
  runtime/hermes/         HERMES_HOME: config.yaml, .env, memories, skills, pending
  runtime/hermes-gateway.log / .pid

The engine is reached over its OpenAI-compatible API on 127.0.0.1:8642. This
module never imports Hermes; it shells out for the few operations that need it
(applying a staged skill/memory write) and reads the same files the engine reads.

Nothing here talks to the browser — `market_service.py` exposes it behind
`/api/trish/*`.
"""
from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
SOURCE = PROJECT / "vendor" / "hermes-agent"
HOME = PROJECT / "runtime" / "hermes"
VENV = PROJECT / "runtime" / "venv"
HERMES_BIN = VENV / "bin" / "hermes"
LOG = PROJECT / "runtime" / "hermes-gateway.log"
PIDFILE = PROJECT / "runtime" / "hermes-gateway.pid"
LEDGER = PROJECT / "runtime" / "trish-ledger.jsonl"
SKILLS_ROOT = PROJECT / "skills"
PORT = 8642
BASE_URL = f"http://127.0.0.1:{PORT}"
PROFILE = "cairnline"
# tools/fake_model.py answers here. It is a scripted double, never a model, so the
# runtime treats any model pointed at this port as a dev override that has to be
# switched on in .env — never something that engages by accident.
FAKE_PROVIDER_PORT = 8801
DEV_OVERRIDE_VAR = "TRISH_DEV_FAKE_MODEL"


# ------------------------------------------------------------------ plumbing
def _env() -> dict:
    env = dict(os.environ)
    env["HERMES_HOME"] = str(HOME)
    env.pop("PYTHONPATH", None)
    return env


def _dev_marker() -> bool:
    try:
        for line in (HOME / ".env").read_text().splitlines():
            if line.strip() == f"{DEV_OVERRIDE_VAR}=1":
                return True
    except OSError:
        pass
    return False


def _is_fake_provider(url: str) -> bool:
    return bool(url) and f":{FAKE_PROVIDER_PORT}" in url and (
        "127.0.0.1" in url or "localhost" in url)


def provider_status() -> dict:
    base = (_cfg("model", "base_url") or "").strip()
    fake = _is_fake_provider(base)
    marker = _dev_marker()
    warning = None
    if fake and not marker:
        warning = (f"model.base_url points at the dev fake provider (:{FAKE_PROVIDER_PORT}) "
                   f"but {DEV_OVERRIDE_VAR} is not set in runtime/hermes/.env — treat this as a "
                   "misconfiguration, not a model.")
    elif fake:
        warning = (f"DEV ONLY: the deterministic fake provider on :{FAKE_PROVIDER_PORT} answers "
                   "every turn. Set a real provider here before using Trish for anything real.")
    return {"base_url": base or None, "fake_model": fake,
            "dev_override": marker, "warning": warning}


def _api_key() -> str:
    try:
        for line in (HOME / ".env").read_text().splitlines():
            if line.startswith("API_SERVER_KEY="):
                return line.split("=", 1)[1].strip()
    except OSError:
        pass
    return ""


def _http(path: str, timeout: float = 3.0) -> dict | None:
    key = _api_key()
    req = urllib.request.Request(BASE_URL + path)
    if key:
        req.add_header("Authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except Exception:  # noqa: BLE001 — a down gateway is a state, not an error
        return None


def _config_text() -> str:
    try:
        return (HOME / "config.yaml").read_text()
    except OSError:
        return ""


def _yaml_min(text: str) -> dict:
    """A small indentation parser: mappings, block lists, scalars. Enough for
    config.yaml as Hermes writes it, and no PyYAML dependency in the app."""
    root: dict = {}
    stack = [(-1, root)]
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        line = raw.strip()
        while stack and indent <= stack[-1][0]:
            stack.pop()
        parent = stack[-1][1]
        if line.startswith("- "):
            if isinstance(parent, list):
                parent.append(line[2:].strip().strip("'\""))
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip()
        if value:
            parent[key] = value.strip("'\"")
        else:
            parent[key] = {}
            stack.append((indent, parent[key]))
    return root


def _cfg(*path: str):
    node = _yaml_min(_config_text())
    for key in path:
        if not isinstance(node, dict) or key not in node:
            return None
        node = node[key]
    return node if not isinstance(node, dict) else None


def _cfg_set(key: str, value: str) -> tuple[bool, str]:
    proc = subprocess.run([str(HERMES_BIN), "config", "set", key, str(value)],
                          capture_output=True, text=True, timeout=60, env=_env(), cwd=str(HOME))
    return proc.returncode == 0, (proc.stdout or proc.stderr).strip()[:300]


HAVE_PROC = Path("/proc/self/stat").exists()


def _proc_start(pid: int) -> int | None:
    """Kernel start time of *pid* (field 22 of /proc/<pid>/stat, clock ticks since boot).

    Paired with the pid this pins a process identity: a recycled pid gets a
    different start time, so a stale pidfile can never name a stranger.
    """
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
        return int(stat.rsplit(")", 1)[1].split()[19])
    except (OSError, IndexError, ValueError):
        return None


def _looks_like_gateway(pid: int) -> bool:
    """Fallback identity check for pidfiles written before start times were recorded."""
    try:
        return b"hermes" in Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return False


def _pid() -> int | None:
    """The recorded pid, but only if that pid is still the process we started."""
    try:
        pid_text, _, start_text = PIDFILE.read_text().strip().partition(" ")
        pid = int(pid_text)
    except (OSError, ValueError):
        return None
    try:
        os.kill(pid, 0)
    except OSError:
        return None
    if not HAVE_PROC:                    # nothing to check identity against
        return pid
    start = _proc_start(pid)
    if start is None:                    # the process went away, or is not ours to read
        return None
    if start_text.strip().isdigit():
        return pid if int(start_text) == start else None
    return pid if _looks_like_gateway(pid) else None   # pre-upgrade single-number pidfile


def _git_head() -> str | None:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=SOURCE,
                              capture_output=True, text=True, timeout=10).stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


# --------------------------------------------------------------------- state
def skills_catalogue() -> list[dict]:
    try:
        data = json.loads((SKILLS_ROOT / "index.json").read_text())
    except (OSError, json.JSONDecodeError):
        return []
    seen, out = set(), []
    for e in data.get("entries") or []:
        if e.get("name") in seen:
            continue
        seen.add(e.get("name"))
        out.append({"name": e.get("name"), "layer": e.get("layer"),
                    "description": (e.get("description") or "")[:200]})
    return out


def memory_files() -> list[dict]:
    out = []
    for name in ("MEMORY.md", "USER.md"):
        p = HOME / "memories" / name
        try:
            text = p.read_text()
            updated = datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc).isoformat(timespec="seconds")
        except OSError:
            text, updated = "", None
        out.append({"name": name, "text": text, "updated": updated, "chars": len(text)})
    return out


def pending() -> list[dict]:
    root = HOME / "pending"
    items = []
    if not root.is_dir():
        return items
    for kind in ("skills", "memory"):
        for f in sorted((root / kind).glob("*.json")):
            try:
                rec = json.loads(f.read_text())
            except (OSError, json.JSONDecodeError):
                continue
            payload = rec.get("payload") or {}
            diff = rec.get("diff") or rec.get("patch") or ""
            if not diff and payload:
                diff = json.dumps(payload, indent=1, ensure_ascii=False)
            created = rec.get("created") or rec.get("created_at")
            if isinstance(created, (int, float)):
                created = datetime.fromtimestamp(created, tz=timezone.utc).isoformat(timespec="seconds")
            items.append({
                "id": rec.get("id") or f.stem,
                "kind": kind,
                "title": rec.get("summary") or rec.get("name") or rec.get("title") or f.stem,
                "action": rec.get("action") or rec.get("kind") or "",
                "created": created,
                "origin": rec.get("origin"),
                "diff": str(diff)[:4000],
                "path": str(f),
            })
    items.sort(key=lambda i: str(i.get("created") or ""), reverse=True)
    return items


def journey(limit: int = 20) -> list[dict]:
    if not LEDGER.exists():
        return []
    lines = [l for l in LEDGER.read_text().splitlines() if l.strip()]
    out = []
    for line in lines[-limit:]:
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return list(reversed(out))


def _log_ledger(entry: dict) -> None:
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    with LEDGER.open("a") as fh:
        fh.write(json.dumps(entry) + "\n")


def state() -> dict:
    pid = _pid()
    models = _http("/v1/models") if pid else None
    toolsets = _http("/v1/toolsets") if pid else None
    rows = (toolsets or {}).get("data") or []
    enabled = [t["name"] for t in rows if t.get("enabled")]
    try:
        import trish_mcp  # noqa: PLC0415 — same directory, only for the tool count
        mcp_tools = len(trish_mcp.TOOLS)
    except Exception:  # noqa: BLE001
        mcp_tools = None
    return {
        "profile": PROFILE,
        "installed": HERMES_BIN.exists() and SOURCE.is_dir(),
        "source": str(SOURCE),
        "revision": _git_head(),
        "home": str(HOME),
        "gateway": {
            "up": bool(models and models.get("data")),
            "pid": pid,
            "port": PORT,
            "url": BASE_URL + "/v1",
            "auth": bool(_api_key()),
            "log": str(LOG),
        },
        "model": {
            "provider": _cfg("model", "provider"),
            "model": _cfg("model", "default"),
            "base_url": _cfg("model", "base_url"),
            "has_key": bool(re.search(r"^[A-Z0-9_]*_API_KEY=\S", (HOME / ".env").read_text() if (HOME / ".env").exists() else "", re.M)),
        },
        "provider": provider_status(),
        "learning": {
            "skills_write_approval": _cfg("skills", "write_approval") == "true",
            "memory_write_approval": _cfg("memory", "write_approval") == "true",
            "suggest_after_turn": _cfg("skills", "suggest_after_turn") == "true",
        },
        "skills": {"count": len(skills_catalogue()), "external_dir": str(SKILLS_ROOT)},
        "mcp": {"server": "cairnline", "tools": mcp_tools,
                "registered": "mcp_servers" in _config_text()},
        "toolsets_enabled": len(enabled),
        "deferred_toolsets": max(0, len(rows) - len(enabled)),
        "pending": len(pending()),
    }


# ----------------------------------------------------------------- processes
def start() -> dict:
    if _pid():
        return {"started": False, "reason": "already running", **state()}
    if not HERMES_BIN.exists():
        return {"started": False, "error": "engine not installed — run tools/setup_hermes.sh"}
    LOG.parent.mkdir(parents=True, exist_ok=True)
    log = LOG.open("ab")
    proc = subprocess.Popen([str(HERMES_BIN), "gateway", "run"], cwd=str(HOME), env=_env(),
                            stdout=log, stderr=log, start_new_session=True)
    PIDFILE.write_text(f"{proc.pid} {_proc_start(proc.pid) or ''}".strip())
    # Gateway boot takes ~20–40 s here (skills scan + MCP connect), so wait for the
    # API to actually answer rather than reporting a process that is still starting.
    for _ in range(120):
        time.sleep(0.5)
        if _http("/v1/models", timeout=1.0):
            break
    return {"started": True, **state()}


def stop() -> dict:
    pid = _pid()
    if not pid:
        return {"stopped": False, "reason": "not running", **state()}
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass
    for _ in range(20):
        time.sleep(0.25)
        if not _pid():
            break
    if _pid():                 # it ignored the signal: still running, so still ours
        return {"stopped": False, "reason": "still running after SIGTERM", **state()}
    try:
        PIDFILE.unlink()
    except OSError:
        pass
    return {"stopped": True, **state()}


def restart() -> dict:
    stop()
    return {"restarted": True, **start()}


# ----------------------------------------------------------------- settings
def set_engine(payload: dict) -> dict:
    """Provider the engine uses. Only the keys the user sends are touched."""
    target = str(payload.get("base_url") or "")
    if _is_fake_provider(target) and not _dev_marker():
        raise ValueError(
            f"refusing to point Trish at the dev fake provider on :{FAKE_PROVIDER_PORT}; "
            f"set {DEV_OVERRIDE_VAR}=1 in runtime/hermes/.env if that is deliberate")
    changed = []
    for key, cfg_key in (("provider", "model.provider"), ("model", "model.default"),
                         ("base_url", "model.base_url"), ("context_length", "model.context_length")):
        if payload.get(key):
            ok, msg = _cfg_set(cfg_key, str(payload[key]))
            changed.append({"key": cfg_key, "ok": ok, "msg": msg if not ok else "set"})
    if payload.get("api_key"):
        env_path = HOME / ".env"
        lines = [l for l in env_path.read_text().splitlines()
                 if not re.match(r"^(CUSTOM_API_KEY|OPENAI_API_KEY)=", l)]
        lines += [f"CUSTOM_API_KEY={payload['api_key'].strip()}",
                  f"OPENAI_API_KEY={payload['api_key'].strip()}"]
        env_path.write_text("\n".join(lines) + "\n")
        env_path.chmod(0o600)
        changed.append({"key": ".env provider key", "ok": True, "msg": "set"})
    if changed and _pid():
        restart()
    return {"changed": changed, **state()}


def set_learning(payload: dict) -> dict:
    mapping = {
        "skills_write_approval": ("skills.write_approval", True),
        "memory_write_approval": ("memory.write_approval", True),
        "suggest_after_turn": ("skills.suggest_after_turn", True),
    }
    changed = []
    for field, (key, _default) in mapping.items():
        if field in payload:
            value = "true" if payload[field] else "false"
            ok, msg = _cfg_set(key, value)
            changed.append({"key": key, "ok": ok, "value": value, "msg": msg if not ok else "set"})
    if changed and _pid():
        restart()
    return {"changed": changed, **state()}


def write_memory(name: str, text: str) -> dict:
    if name not in ("MEMORY.md", "USER.md"):
        raise ValueError("memory file must be MEMORY.md or USER.md")
    target = HOME / "memories" / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(str(text)[:20000])
    _log_ledger({"at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                 "kind": "memory-edit", "title": name, "decision": "saved",
                 "chars": len(str(text)), "by": "operator"})
    return {"saved": True, "files": memory_files()}


# ------------------------------------------------------------------ approve
_APPLY = r"""
import json, sys
from pathlib import Path
payload = json.loads(sys.stdin.read())
kind = payload["kind"]
inner = (payload["record"] or {}).get("payload") or {}
if kind == "skills":
    from tools.skill_manager_tool import apply_skill_pending
    print(apply_skill_pending(inner, origin="operator"))
else:
    from tools.memory_tool import load_on_disk_store, apply_memory_pending
    store = load_on_disk_store()
    print(json.dumps(apply_memory_pending(inner, store)))
"""


def decide(item_id: str, action: str) -> dict:
    """Approve replays the staged write inside the engine; reject archives it."""
    if action not in ("approve", "reject"):
        raise ValueError("action must be approve or reject")
    for item in pending():
        if item["id"] != item_id:
            continue
        path = Path(item["path"])
        record = json.loads(path.read_text())
        if action == "reject":
            archive = HOME / "pending" / "rejected"
            archive.mkdir(parents=True, exist_ok=True)
            path.rename(archive / path.name)
            _log_ledger({"at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                         "kind": item["kind"], "id": item_id, "title": item["title"],
                         "decision": "rejected", "by": "operator"})
            return {"ok": True, "decision": "rejected", "pending": len(pending())}

        script = PROJECT / "runtime" / "_apply_pending.py"
        script.write_text(_APPLY)
        proc = subprocess.run([str(VENV / "bin" / "python"), str(script)], input=json.dumps(
            {"kind": item["kind"], "record": record}), capture_output=True, text=True,
            timeout=120, env=_env(), cwd=str(SOURCE))
        output = (proc.stdout or "").strip()
        if proc.returncode != 0:
            return {"ok": False, "error": (proc.stderr or output).strip()[:500]}
        # The engine answers JSON; a refusal is a failed approval, so the item stays queued
        # rather than disappearing with nothing written.
        try:
            verdict = json.loads(output)
        except json.JSONDecodeError:
            verdict = None
        if isinstance(verdict, dict) and verdict.get("success") is False:
            return {"ok": False, "error": str(verdict.get("error") or "engine refused")[:500],
                    "pending": len(pending())}
        try:
            path.unlink()
        except OSError:
            pass
        _log_ledger({"at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                     "kind": item["kind"], "id": item_id, "title": item["title"],
                     "decision": "approved", "by": "operator",
                     "engine": (proc.stdout or "").strip()[:300]})
        return {"ok": True, "decision": "approved", "engine": (proc.stdout or "").strip()[:300],
                "pending": len(pending())}
    raise ValueError(f"no pending item {item_id}")
