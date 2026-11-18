#!/usr/bin/env python3
"""
Cairnline MCP server — Trish's market data, spoken over MCP.

Hermes (or any MCP host) spawns this on stdio. Every tool is a thin wrapper over
the market service the dashboard already talks to, so there is exactly one data
path and one set of risk limits (`server/trish.py` owns them; this file imports
them rather than copying).

Protocol: JSON-RPC 2.0 over stdin/stdout, one message per line. Methods:
`initialize`, `notifications/initialized`, `tools/list`, `tools/call`, `ping`.

Run: python3 server/trish_mcp.py        (env CAIRNLINE_API overrides the base URL)
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import trish  # noqa: E402  — RISK_LIMITS, run_tool, read_skill live there

API = os.environ.get("CAIRNLINE_API", "http://127.0.0.1:8788").rstrip("/")
PROTOCOL = "2024-11-05"
SERVER = {"name": "cairnline", "version": "1.1.0"}


# ------------------------------------------------------------------ transport
def _get(path: str, params: dict | None = None, timeout: int = 90):
    url = API + path
    if params:
        url += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _post(path: str, payload: dict, timeout: int = 180):
    req = urllib.request.Request(API + path, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _quotes(syms: list[str]) -> dict:
    """`/api/quotes` answers with a symbol-keyed object; accept a list too."""
    raw = _get("/api/quotes", {"symbols": ",".join(syms)}).get("quotes") or {}
    if isinstance(raw, dict):
        return raw
    return {q["symbol"]: q for q in raw if q.get("symbol")}


PROP_SIM = Path(__file__).resolve().parent / "prop_sim.mjs"


def _prop_sim(payload: dict) -> dict:
    """The dashboard's own prop-firm engine, run headless through node."""
    node = shutil.which("node")
    if not node:
        return {"error": "node is not on PATH, so the prop-firm engine cannot run"}
    proc = subprocess.run([node, str(PROP_SIM)], input=json.dumps(payload),
                          capture_output=True, text=True, timeout=180)
    if proc.returncode != 0 and not proc.stdout.strip():
        return {"error": (proc.stderr or "prop_sim failed").strip()[:400]}
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {"error": (proc.stdout or proc.stderr).strip()[:400]}


def deps() -> dict:
    """The same callables `server/trish.py` expects, served over HTTP."""
    return {
        "quotes": lambda syms: _quotes(syms),
        "indicators": lambda sym, interval, period: _get(
            "/api/indicators", {"symbol": sym, "interval": interval, "range": period}),
        "basket": lambda interval: _get("/api/basket/signals", {"interval": interval}),
        "cot": lambda sym: _get("/api/cot", {"symbol": sym}),
        "calendar": lambda region, days: _get("/api/calendar", {"region": region, "days": days}),
        "range_for": lambda interval: {"5m": "5d", "15m": "5d", "30m": "1mo",
                                       "1h": "3mo", "4h": "1y", "1d": "2y"}.get(interval, "5d"),
    }


# ---------------------------------------------------------------------- tools
TOOLS = [
    {
        "name": "get_quote",
        "description": "Live price and session change for one symbol (EURUSD, XAUUSD, GBPJPY…).",
        "inputSchema": {"type": "object", "properties": {"symbol": {"type": "string"}}, "required": ["symbol"]},
    },
    {
        "name": "get_indicators",
        "description": "Real Pine indicators (EMA 9/21/50, RSI, ATR, MACD, Bollinger) plus the engine's bias, entry, stop, target and confidence for a symbol and timeframe.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "symbol": {"type": "string"},
                "interval": {"type": "string", "description": "5m, 15m, 30m, 1h, 4h or 1d"},
            },
            "required": ["symbol"],
        },
    },
    {
        "name": "get_signals",
        "description": "Ranked bias across the whole symbol basket at one interval.",
        "inputSchema": {"type": "object", "properties": {"interval": {"type": "string"}}, "required": []},
    },
    {
        "name": "get_cot",
        "description": "CFTC Commitments of Traders net non-commercial positioning and its 3-year percentile.",
        "inputSchema": {
            "type": "object",
            "properties": {"symbol": {"type": "string", "description": "GC gold, SI silver, CL crude, 6E euro, 6B pound, 6J yen, BTC"}},
            "required": ["symbol"],
        },
    },
    {
        "name": "get_calendar",
        "description": "Upcoming macro events with impact, consensus and previous values.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "region": {"type": "string"},
                "days": {"type": "integer"},
                "high_only": {"type": "boolean"},
            },
            "required": [],
        },
    },
    {
        "name": "position_size",
        "description": "Position size from account equity, risk percent, entry and stop.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "equity": {"type": "number"}, "risk_pct": {"type": "number"},
                "entry": {"type": "number"}, "stop": {"type": "number"},
            },
            "required": ["equity", "risk_pct", "entry", "stop"],
        },
    },
    {
        "name": "risk_gate",
        "description": "Check a proposed trade against the desk limits. Returns PASS or BLOCK with the reason. A BLOCK is final.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "symbol": {"type": "string"}, "entry": {"type": "number"},
                "stop": {"type": "number"}, "target": {"type": "number"},
                "equity": {"type": "number"}, "risk_pct": {"type": "number"},
                "min_rr": {"type": "number"},
            },
            "required": ["symbol", "entry", "stop", "target"],
        },
    },
    {
        "name": "edge_stats",
        "description": "Ask the Edge Stats engine one question from the 42-preset catalog — base rate with a 95% interval, baseline, lift, stability and per-session split. Use this instead of claiming an edge from memory.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "preset_id": {"type": "string", "description": "e.g. green-rate, gap-fill, orb-target"},
                "symbol": {"type": "string"},
                "interval": {"type": "string"},
                "range": {"type": "string", "description": "3mo, 6mo, 1y, 2y, 5y"},
                "params": {"type": "object"},
            },
            "required": ["preset_id", "symbol"],
        },
    },
    {
        "name": "edge_stats_presets",
        "description": "List the Edge Stats preset catalog: id, title, category, one-line summary.",
        "inputSchema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "backtest",
        "description": (
            "Run a Cairnline backtest: one strategy over real bars, commission and slippage "
            "charged both ways, stop assumed to hit before target when a bar spans both. "
            "Returns metrics, Monte Carlo of the trade R-multiples and an equity-curve summary. "
            "mode='optimize' sweeps one parameter; mode='validate' runs the hold-up checks: "
            "expanding-window walk-forward with an embargo, a plateau test on the parameter surface, "
            "a doubled-cost stress, sample size and a safe risk level for a drawdown cap."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "symbol": {"type": "string", "description": "EURUSD, XAUUSD, GBPJPY…"},
                "interval": {"type": "string", "description": "5m, 15m, 30m, 1h, 4h or 1d (default 1h)"},
                "range": {"type": "string", "description": "how much history: 1mo, 3mo, 1y, 2y (default 1y)"},
                "strategy": {"type": "string", "description": "ema-cross, rsi-reversion, donchian-break (default ema-cross)"},
                "params": {"type": "object", "description": "strategy inputs; omitted keys use the strategy defaults"},
                "mode": {"type": "string", "description": "'run' (default) or 'optimize'"},
                "grid": {"type": "object", "description": "for optimize: {param: [values]}"},
                "commission_bps": {"type": "number", "description": "default 2"},
                "slippage_bps": {"type": "number", "description": "default 1"},
                "balance": {"type": "number", "description": "starting equity, default 10000"},
                "risk_pct": {"type": "number", "description": "risk per trade in percent, default 1"},
            },
            "required": [],
        },
    },
    {
        "name": "options_flow",
        "description": (
            "Options flow for one US underlying from LSE Data 3.0: prints with premium and Greeks, "
            "gamma exposure by strike and in total, max pain, and a whale score whose five components "
            "are all returned with their inputs. The feed has no open interest, so exposure and max pain "
            "are weighted by contracts traded in the window — `gex.basis` says so, and missing metrics "
            "are named in `unavailable` rather than approximated."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "underlying": {"type": "string", "description": "SPY, QQQ, AAPL… (default SPY)"},
                "window": {"type": "string", "description": "1d or 7d (default 7d)"},
                "min_premium": {"type": "number", "description": "display/whale filter only; exposure is unchanged"},
                "max_dte": {"type": "integer", "description": "drop prints expiring beyond this many days"},
            },
            "required": [],
        },
    },
    {
        "name": "paper_account",
        "description": (
            "The local paper desk: equity, open positions marked from live quotes, the order journal with "
            "every rail check, the deployed strategies, and the kill-switch state. Paper only — no broker "
            "is contacted and no order leaves the machine."
        ),
        "inputSchema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "paper_order",
        "description": (
            "Submit a paper order. Server-side rails decide: kill switch, symbol allowlist, trading hours, "
            "stop on the losing side, minimum reward:risk, risk per trade, position notional, open positions, "
            "daily loss, orders per day and duplicate protection. A rejection returns every rail and why it "
            "failed; nothing is silently accepted."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "symbol": {"type": "string"},
                "side": {"type": "string", "description": "long or short"},
                "units": {"type": "number", "description": "omit to size from risk_pct and the stop"},
                "risk_pct": {"type": "number", "description": "used when units is omitted (default 1)"},
                "stop": {"type": "number"},
                "target": {"type": "number"},
                "reason": {"type": "string"},
            },
            "required": ["symbol", "side", "stop", "target"],
        },
    },
    {
        "name": "paper_close",
        "description": "Close one open paper position at the live quote. Allowed even while the kill switch is engaged.",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "string", "description": "position id from paper_account"},
                           "reason": {"type": "string"}},
            "required": ["id"],
        },
    },
    {
        "name": "paper_kill",
        "description": "Engage or clear the paper desk kill switch. Engaged blocks new entries; exits still work.",
        "inputSchema": {
            "type": "object",
            "properties": {"engaged": {"type": "boolean"}, "reason": {"type": "string"}},
            "required": ["engaged"],
        },
    },
    {
        "name": "paper_cycle",
        "description": (
            "Run one decision for a deployed strategy (or all of them): read the newest closed bar, "
            "compute the strategy's state, and propose at most one order — which still passes every rail. "
            "There is no background loop; nothing happens between calls."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "string", "description": "deployment id; omit for all"}},
            "required": [],
        },
    },
    {
        "name": "propfirm_firms",
        "description": "List the prop-firm challenges Cairnline can simulate, with account size, targets, drawdown rules and fee.",
        "inputSchema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "propfirm_simulate",
        "description": (
            "Monte Carlo a trader through a prop firm's exact rules: pass probability with a 95% "
            "confidence interval, expected attempts, EV in dollars, funded-probability and which rule "
            "kills most attempts. Same engine and firm specs the Prop Firm Simulator page uses."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "challenge_id": {"type": "string", "description": "id from propfirm_firms; default ftmo-100k"},
                "spec": {"type": "object", "description": "a full rule spec instead of a known challenge id"},
                "win_rate": {"type": "number", "description": "percent, 0-100 (55 means 55%)"},
                "avg_win_r": {"type": "number", "description": "average winner in R, default 1.5"},
                "avg_loss_r": {"type": "number", "description": "average loser in R, default 1"},
                "trades_per_day": {"type": "number", "description": "default 4"},
                "risk_pct": {"type": "number", "description": "risk per trade in percent of the account, default 1"},
                "paths": {"type": "integer", "description": "Monte Carlo paths, default 4000"},
                "seed": {"type": "integer", "description": "deterministic seed, default 42"},
            },
            "required": ["win_rate"],
        },
    },
    {
        "name": "read_skill",
        "description": "Load a skill's full instructions by name. Call before using a skill you only know by description.",
        "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
    },
    {
        "name": "skills_list",
        "description": "List the Cairnline skill catalogue (name, layer, description).",
        "inputSchema": {"type": "object", "properties": {}, "required": []},
    },
]


def call_tool(name: str, args: dict) -> dict:
    if name == "edge_stats":
        payload = {
            "presetId": args.get("preset_id"),
            "symbol": str(args.get("symbol", "")).upper(),
            "interval": args.get("interval") or "1d",
            "range": args.get("range") or "1y",
            "params": args.get("params") or {},
        }
        try:
            res = _post("/api/edge-stats/run", payload)
        except urllib.error.HTTPError as exc:
            return {"error": exc.read().decode(errors="replace")[:400]}
        keep = ("preset", "symbol", "interval", "history", "source", "estimate", "baseline",
                "lift_points", "stability", "verdict", "by_session", "per_year", "sessions")
        return {k: res.get(k) for k in keep if k in res}

    if name == "edge_stats_presets":
        res = _get("/api/edge-stats/presets")
        return {"count": res.get("preset_count"),
                "presets": [{k: p.get(k) for k in ("id", "title", "category", "summary", "needs_intraday")}
                            for p in res.get("presets", [])]}

    if name == "backtest":
        body = {
            "symbol": str(args.get("symbol") or "EURUSD").upper(),
            "interval": args.get("interval") or "1h",
            "range": args.get("range") or "1y",
            "strategy": args.get("strategy") or "ema-cross",
            "params": args.get("params") or {},
            "mode": args.get("mode") or "run",
        }
        for key in ("grid",):
            if args.get(key):
                body[key] = args[key]
        for key in ("commission_bps", "slippage_bps", "balance", "risk_pct"):
            if args.get(key) is not None:
                body[key] = args[key]
        try:
            res = _post("/api/backtest", body, timeout=300)
        except urllib.error.HTTPError as exc:
            return {"error": exc.read().decode(errors="replace")[:400]}
        if res.get("error"):
            return {"error": res["error"]}
        keep = ("mode", "strategy", "strategy_label", "bars", "costs", "params", "metrics",
                "monte_carlo", "sample_note", "source", "generated_at")
        out = {k: res.get(k) for k in keep if k in res}
        trades = res.get("trades") or []
        metrics = res.get("metrics") or {}
        out["trades"] = {"count": metrics.get("trades", len(trades)),
                         "returned": len(trades), "last": trades[-5:]}
        curve = res.get("curve") or []
        if curve:
            values = [c.get("v", c.get("equity")) for c in curve if isinstance(c, dict)]
            values = [v for v in values if isinstance(v, (int, float))]
            out["equity"] = {
                "points": len(curve),
                "start": curve[0],
                "end": curve[-1],
                "min": min(values) if values else None,
                "max": max(values) if values else None,
            }
        if res.get("mode") == "optimize":
            out.pop("params", None)
            out["folds"] = res.get("folds")
            out["best"] = res.get("best")
        return out

    if name == "options_flow":
        try:
            res = _get("/api/options-flow", {
                "underlying": str(args.get("underlying") or "SPY").upper(),
                "window": args.get("window") or "7d",
                "min_premium": args.get("min_premium"),
                "max_dte": args.get("max_dte"),
            })
        except urllib.error.HTTPError as exc:
            return {"available": False, "error": exc.read().decode(errors="replace")[:400]}
        if res.get("available") is False:
            return {"available": False, "reason": res.get("reason"),
                    "unavailable": res.get("unavailable")}
        keep = ("underlying", "underlying_price", "window", "counts", "flow", "gex",
                "max_pain", "whale", "unavailable", "source", "feed", "as_of", "generated_at")
        out = {k: res.get(k) for k in keep if k in res}
        out["flow"] = {k: (res.get("flow") or {}).get(k) for k in
                       ("total_premium", "call_premium", "put_premium", "put_call_ratio")}
        out["flow"]["prints_returned"] = len((res.get("flow") or {}).get("prints") or [])
        gex = res.get("gex") or {}
        if gex.get("by_strike"):
            top = sorted(gex["by_strike"], key=lambda r: -abs(r["net"]))[:8]
            out["gex"] = {**{k: gex.get(k) for k in ("available", "total_usd_per_pct", "basis", "unit", "flip_strike")},
                          "top_strikes": top}
        return out

    if name == "paper_account":
        res = _get("/api/paper", timeout=30)
        acct = res.get("account") or {}
        return {"mode": res.get("mode"), "broker": res.get("broker"),
                "equity": acct.get("equity"), "balance": acct.get("balance"),
                "open_pnl": acct.get("open_pnl"), "realized_today": acct.get("realized_today"),
                "positions": acct.get("positions"), "kill_switch": acct.get("kill_switch"),
                "rails": res.get("rails"), "deployments": acct.get("deployments"),
                "recent_orders": (acct.get("orders") or [])[-10:]}

    if name == "paper_order":
        body = {k: args.get(k) for k in ("symbol", "side", "units", "risk_pct", "stop", "target", "reason")
                if args.get(k) is not None}
        res = _post("/api/paper/order", body)
        order = res.get("order") or {}
        return {"accepted": res.get("accepted"), "reasons": res.get("reasons"),
                "position": res.get("position"),
                "order": {k: order.get(k) for k in ("id", "symbol", "side", "units", "entry", "price",
                                                   "stop", "target", "quote_source", "ts")},
                "rail_checks": order.get("checks")}

    if name == "paper_close":
        if not args.get("id"):
            return {"error": "id is required (position id from paper_account)"}
        res = _post("/api/paper/close", {"id": args.get("id"), "reason": args.get("reason")})
        return {"error": res.get("error"), "closed": res.get("closed")}

    if name == "paper_kill":
        return _post("/api/paper/kill", {"engaged": bool(args.get("engaged")),
                                         "reason": args.get("reason")})

    if name == "paper_cycle":
        res = _post("/api/paper/cycle", {"id": args.get("id")}, timeout=180)
        return {k: res.get(k) for k in ("results", "error", "note", "generated_at")}

    if name == "propfirm_firms":
        return _prop_sim({"mode": "list"})

    if name == "propfirm_simulate":
        if args.get("win_rate") is None:
            return {"error": "win_rate is required (percent, e.g. 55)"}
        win_rate = float(args["win_rate"])
        stats = {
            "winRate": win_rate / 100.0 if win_rate > 1 else win_rate,
            "avgWinR": float(args.get("avg_win_r") or 1.5),
            "avgLossR": float(args.get("avg_loss_r") or 1.0),
            "tradesPerDay": float(args.get("trades_per_day") or 4),
            "riskPct": float(args.get("risk_pct") or 1.0),
        }
        payload = {
            "mode": "simulate",
            "stats": stats,
            "options": {"seed": int(args.get("seed") or 42),
                        "paths": int(args.get("paths") or 4000)},
        }
        if args.get("spec"):
            payload["spec"] = args["spec"]
        elif args.get("challenge_id"):
            payload["challenge_id"] = args["challenge_id"]
        return _prop_sim(payload)

    if name == "skills_list":
        return {"skills": [{k: e.get(k) for k in ("name", "layer", "description")}
                           for e in trish.skill_index()]}

    if name in ("get_quote", "get_indicators", "get_signals", "get_cot", "get_calendar",
                "position_size", "risk_gate", "read_skill"):
        return trish.run_tool(name, args, deps())

    return {"error": f"unknown tool {name}"}


# ---------------------------------------------------------------------- serve
def _reply(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _error(msg_id, code, message):
    _reply({"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}})


def handle(msg: dict) -> None:
    method = msg.get("method")
    msg_id = msg.get("id")

    if method == "initialize":
        _reply({"jsonrpc": "2.0", "id": msg_id, "result": {
            "protocolVersion": PROTOCOL,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": SERVER,
        }})
        return
    if method in ("notifications/initialized", "initialized"):
        return
    if method == "ping":
        _reply({"jsonrpc": "2.0", "id": msg_id, "result": {}})
        return
    if method == "tools/list":
        _reply({"jsonrpc": "2.0", "id": msg_id, "result": {"tools": TOOLS}})
        return
    if method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name") or ""
        args = params.get("arguments") or {}
        try:
            result = call_tool(name, args)
        except Exception as exc:  # noqa: BLE001 — a tool failure is data for the model
            result = {"error": f"{type(exc).__name__}: {exc}"[:400]}
        _reply({"jsonrpc": "2.0", "id": msg_id, "result": {
            "content": [{"type": "text", "text": json.dumps(result)}],
            "isError": bool(result.get("error")) if isinstance(result, dict) else False,
        }})
        return
    if msg_id is not None:
        _error(msg_id, -32601, f"method not found: {method}")


def selftest() -> int:
    """`--selftest` answers what a new host needs to know: how many tools, and is the desk up."""
    probe = {"server": SERVER, "protocol": PROTOCOL, "api": API,
             "tools": len(TOOLS), "names": [t["name"] for t in TOOLS]}
    try:
        probe["api_health"] = bool(_get("/api/health", timeout=8).get("ok"))
    except Exception as exc:  # noqa: BLE001
        probe["api_health"] = f"unreachable: {type(exc).__name__}"
    print(json.dumps(probe, indent=2))
    return 0 if probe["api_health"] is True else 1


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(msg, list):
            for m in msg:
                handle(m)
        else:
            handle(msg)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
