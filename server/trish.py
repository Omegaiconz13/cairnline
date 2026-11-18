#!/usr/bin/env python3
"""
Trish — the desk assistant runtime.

Provider-agnostic: any OpenAI-compatible endpoint (OpenRouter, OpenAI, Anthropic
via proxy, Ollama, LM Studio, a local gateway) works through one wire shape.
Tools are our own market-data functions, so Trish can act on real Cairnline data.

Backends:
  direct  — we run the tool loop ourselves against the configured endpoint.
  hermes  — forward to a local Hermes gateway (:8642/v1), which brings its own
            skills, MCP servers, memory and learning loop. Same request shape.

The desk method (what Trish must and must not do) is TRISH_METHOD below, kept
short on purpose: it is in every prompt.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path

SKILLS_ROOT = Path(__file__).resolve().parent.parent / "skills"
_INDEX_CACHE: dict | None = None


def skill_index() -> list[dict]:
    """The catalogue. Only name + a short description reach the prompt."""
    global _INDEX_CACHE
    if _INDEX_CACHE is not None:
        return _INDEX_CACHE["entries"]
    try:
        _INDEX_CACHE = json.loads((SKILLS_ROOT / "index.json").read_text())
    except Exception:  # noqa: BLE001 - no skills is a valid state
        _INDEX_CACHE = {"entries": [], "count": 0}
    return _INDEX_CACHE["entries"]


def read_skill(name: str) -> dict:
    """Resolve one skill body. Progressive disclosure: nothing but the index is
    in context until the model asks for a specific skill."""
    for e in skill_index():
        if e["name"].lower() == str(name).lower().strip():
            p = SKILLS_ROOT.parent / e["path"]
            try:
                text = p.read_text(errors="replace")
            except OSError as exc:
                return {"error": f"cannot read {name}: {exc}"}
            return {"name": e["name"], "path": str(p), "content": text[:24000]}
    names = ", ".join(e["name"] for e in skill_index()[:40])
    return {"error": f"no skill named '{name}'", "available": names}


def skill_catalogue(max_desc: int = 200) -> str:
    entries = skill_index()
    if not entries:
        return ""
    lines = []
    for e in entries:
        d = e["description"]
        lines.append(f"- {e['name']} [{e['layer']}]: {d[:max_desc]}")
    return "\n".join(lines)

TRISH_METHOD = """You are Trish, the trading desk assistant inside Cairnline.

How you work, in order:
1. CONTEXT - which symbol, which timeframe, what the account allows. Ask only if
   it cannot be inferred.
2. STRUCTURE - read the market with your tools before saying anything about it.
3. LEVELS - entry, stop and target must come from data you fetched (ATR or
   structure), never from memory or guesswork.
4. RISK - a plan without a stop is not a plan. Size it or refuse it.
5. VERDICT - state the bias with the evidence that produced it.

Hard rules:
- Never invent a price, a level, an indicator value or an event. If a tool
  returns nothing, say so and stop.
- You never place an order. You produce a plan; the operator approves it.
- Prefer numbers with their source (yfinance / lse-data / PineTS).
- Be brief. A trader reading this is watching the market.
"""


class TrishError(Exception):
    pass


# --------------------------------------------------------------------- tools
# Each tool maps to data the market service already serves. No new data code.

TRISH_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "read_skill",
            "description": "Load a skill's full instructions by name. Call this before using a skill you only know by its description.",
            "parameters": {
                "type": "object",
                "properties": {"name": {"type": "string", "description": "skill name from the catalogue"}},
                "required": ["name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_quote",
            "description": "Live price and session change for one symbol.",
            "parameters": {
                "type": "object",
                "properties": {"symbol": {"type": "string", "description": "e.g. EURUSD, XAUUSD, GBPJPY"}},
                "required": ["symbol"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_indicators",
            "description": "Compute real Pine indicators (EMA 9/21/50, RSI, ATR, MACD, Bollinger) and a bias summary for a symbol and timeframe.",
            "parameters": {
                "type": "object",
                "properties": {
                    "symbol": {"type": "string"},
                    "interval": {"type": "string", "description": "5m, 15m, 30m, 1h, 4h or 1d"},
                },
                "required": ["symbol"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_signals",
            "description": "Ranked signals across the whole symbol basket at one interval.",
            "parameters": {
                "type": "object",
                "properties": {"interval": {"type": "string"}},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_cot",
            "description": "CFTC Commitments of Traders net non-commercial positioning and its 3-year percentile.",
            "parameters": {
                "type": "object",
                "properties": {"symbol": {"type": "string", "description": "GC gold, SI silver, CL crude, 6E euro, 6B pound, 6J yen, BTC"}},
                "required": ["symbol"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_calendar",
            "description": "Upcoming macro events with impact, consensus and previous values.",
            "parameters": {
                "type": "object",
                "properties": {
                    "region": {"type": "string", "description": "US, EU, GB..."},
                    "days": {"type": "integer"},
                    "high_only": {"type": "boolean"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "position_size",
            "description": "Position size from account equity, risk percent, entry and stop.",
            "parameters": {
                "type": "object",
                "properties": {
                    "equity": {"type": "number"},
                    "risk_pct": {"type": "number"},
                    "entry": {"type": "number"},
                    "stop": {"type": "number"},
                },
                "required": ["equity", "risk_pct", "entry", "stop"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "risk_gate",
            "description": "Check a proposed trade against the desk limits. Returns PASS or BLOCK with the reason. A BLOCK is final.",
            "parameters": {
                "type": "object",
                "properties": {
                    "symbol": {"type": "string"},
                    "entry": {"type": "number"},
                    "stop": {"type": "number"},
                    "target": {"type": "number"},
                    "equity": {"type": "number"},
                    "risk_pct": {"type": "number"},
                    "min_rr": {"type": "number", "description": "minimum reward:risk, default 1.5"},
                },
                "required": ["symbol", "entry", "stop", "target"],
            },
        },
    },
]

RISK_LIMITS = {
    "max_risk_pct_per_trade": 2.0,
    "min_reward_risk": 1.5,
    "require_stop": True,
}


def run_tool(name: str, args: dict, deps: dict) -> dict:
    """Execute one tool by name. `deps` carries the market-service callables."""
    try:
        if name == "read_skill":
            return read_skill(args.get("name", ""))

        if name == "get_quote":
            sym = str(args.get("symbol", "")).upper()
            q = deps["quotes"]([sym]).get(sym)
            if not q:
                return {"error": f"no quote for {sym}"}
            return {"symbol": sym, "price": q.get("price"), "change_pct": q.get("change_pct"),
                    "source": q.get("source") or deps.get("source_hint", "market service")}

        if name == "get_indicators":
            sym = str(args.get("symbol", "")).upper()
            interval = str(args.get("interval") or "15m")
            ind = deps["indicators"](sym, interval, deps["range_for"](interval))
            s = ind.get("summary") or {}
            return {
                "symbol": sym, "interval": interval, "bars": ind.get("bars"),
                "source": ind.get("source"),
                "bias": s.get("bias"), "confidence": s.get("confidence"),
                "entry": s.get("entry"), "stop_loss": s.get("stop_loss"), "take_profit": s.get("take_profit"),
                "risk_reward": s.get("risk_reward"),
                "rsi": s.get("rsi"), "atr": s.get("atr"), "macd_hist": s.get("macd_hist"),
                "ema9": s.get("ema9"), "ema21": s.get("ema21"), "ema50": s.get("ema50"),
                "trend": s.get("trend"), "reasons": s.get("reasons"),
            }

        if name == "get_signals":
            interval = str(args.get("interval") or "15m")
            b = deps["basket"](interval)
            sigs = [s for s in (b.get("signals") or []) if not s.get("error")]
            sigs.sort(key=lambda s: s.get("confidence") or 0, reverse=True)
            return {"interval": interval, "source": b.get("source"),
                    "signals": [{k: s.get(k) for k in
                                 ("symbol", "bias", "confidence", "entry", "stop_loss", "take_profit", "rsi")}
                                for s in sigs[:6]]}

        if name == "get_cot":
            sym = str(args.get("symbol", "GC")).upper()
            c = deps["cot"](sym)
            latest = c.get("latest") or {}
            return {"symbol": sym, "name": c.get("name"),
                    "net": latest.get("net"), "as_of": latest.get("date"),
                    "percentile_3y": c.get("percentile_3y"), "weeks": c.get("weeks")}

        if name == "get_calendar":
            region = str(args.get("region") or "US").upper()
            days = int(args.get("days") or 7)
            cal = deps["calendar"](region, days)
            events = cal.get("events") or []
            if args.get("high_only"):
                events = [e for e in events if e.get("impact") == "high"]
            return {"region": region, "count": len(events),
                    "events": [{k: e.get(k) for k in
                                ("event", "at", "impact", "consensus", "previous", "in_minutes")}
                               for e in events[:12]]}

        if name == "position_size":
            equity = float(args["equity"]); risk_pct = float(args["risk_pct"])
            entry = float(args["entry"]); stop = float(args["stop"])
            dist = abs(entry - stop)
            if dist <= 0:
                return {"error": "entry and stop are the same price"}
            risk_amount = equity * risk_pct / 100.0
            units = risk_amount / dist
            return {"risk_amount": round(risk_amount, 2), "stop_distance": round(dist, 6),
                    "units": round(units, 2), "notional": round(units * entry, 2)}

        if name == "risk_gate":
            entry = float(args["entry"]); stop = float(args["stop"]); target = float(args["target"])
            risk_pct = float(args.get("risk_pct") or 0)
            min_rr = float(args.get("min_rr") or RISK_LIMITS["min_reward_risk"])
            reasons = []
            if RISK_LIMITS["require_stop"] and stop == entry:
                reasons.append("no stop")
            if stop == entry:
                return {"verdict": "BLOCK", "reasons": ["entry and stop are identical"]}
            risk = abs(entry - stop); reward = abs(target - entry)
            if (entry - stop) * (entry - target) > 0:
                reasons.append("stop and target are on the same side of the entry")
            rr = reward / risk if risk else 0
            if rr < min_rr:
                reasons.append(f"reward:risk {rr:.2f} is below the {min_rr:.1f} minimum")
            if risk_pct > RISK_LIMITS["max_risk_pct_per_trade"]:
                reasons.append(f"risk {risk_pct}% exceeds the {RISK_LIMITS['max_risk_pct_per_trade']}% cap")
            return {"verdict": "BLOCK" if reasons else "PASS",
                    "reasons": reasons, "reward_risk": round(rr, 2)}

        return {"error": f"unknown tool {name}"}
    except Exception as exc:  # noqa: BLE001 - a tool failure must reach the model, not kill the turn
        return {"error": str(exc)[:200]}


# ------------------------------------------------------------------ provider

def _post(url: str, key: str | None, payload: dict, timeout: int = 120) -> dict:
    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    if key:
        req.add_header("Authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:400]
        raise TrishError(f"{exc.code} from provider: {detail}") from exc
    except urllib.error.URLError as exc:
        raise TrishError(f"cannot reach provider: {exc.reason}") from exc


def chat(cfg: dict, messages: list[dict], deps: dict, context: dict | None = None,
         max_steps: int = 6) -> dict:
    """One Trish turn: run the tool loop, return the reply plus a trace."""
    base = (cfg.get("base_url") or "").rstrip("/")
    if not base:
        raise TrishError("no provider configured — add one in Settings -> Trish")
    key = cfg.get("api_key")
    model = cfg.get("model") or "hermes-agent"
    backend = cfg.get("backend") or "direct"

    system = TRISH_METHOD
    if context:
        bits = [f"{k}={v}" for k, v in context.items() if v]
        if bits:
            system += "\nCurrent desk context: " + ", ".join(bits) + "."
    cat = skill_catalogue()
    if cat and backend != "hermes":
        system += ("\n\nSkills you can load with read_skill (load the ones the "
                   "question needs; do not load them all):\n" + cat)
    if cfg.get("extra_instructions"):
        system += "\n" + str(cfg["extra_instructions"])[:2000]

    convo = [{"role": "system", "content": system}, *messages]
    trace = []
    use_tools = backend != "hermes"      # Hermes brings its own toolset

    for _ in range(max_steps):
        payload = {
            "model": model,
            "messages": convo,
            "temperature": float(cfg.get("temperature") or 0.2),
        }
        if use_tools:
            payload["tools"] = TRISH_TOOLS
            payload["tool_choice"] = "auto"
        try:
            data = _post(f"{base}/chat/completions", key, payload,
                         timeout=int(cfg.get("timeout") or 120))
        except TrishError:
            if use_tools:                # provider may not support tools: retry plainly
                use_tools = False
                payload.pop("tools", None)
                payload.pop("tool_choice", None)
                data = _post(f"{base}/chat/completions", key, payload,
                             timeout=int(cfg.get("timeout") or 120))
            else:
                raise

        choice = (data.get("choices") or [{}])[0]
        msg = choice.get("message") or {}
        calls = msg.get("tool_calls") or []

        if calls:
            convo.append({"role": "assistant", "content": msg.get("content") or "",
                          "tool_calls": calls})
            for call in calls:
                fn = call.get("function") or {}
                name = fn.get("name") or ""
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except json.JSONDecodeError:
                    args = {}
                result = run_tool(name, args, deps)
                trace.append({"tool": name, "args": args, "result": result})
                convo.append({
                    "role": "tool",
                    "tool_call_id": call.get("id"),
                    "content": json.dumps(result)[:6000],
                })
            continue

        return {
            "reply": (msg.get("content") or "").strip(),
            "model": data.get("model") or model,
            "usage": data.get("usage"),
            "trace": trace,
            "backend": backend,
        }

    # Ran out of steps: return the last thing we have rather than hanging.
    last = ""
    for m in reversed(convo):
        if m.get("role") == "assistant" and m.get("content"):
            last = m["content"]
            break
    return {"reply": last or "I could not finish that in one turn — try narrowing the question.",
            "model": model, "trace": trace, "backend": backend, "stopped": "max_steps"}
