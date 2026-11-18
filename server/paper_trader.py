"""Cairnline paper desk — trade-relay's rail set, with paper fills.

No broker is contacted. A proposal is checked against every rail in order, the
failures are all reported, and an accepted order is filled at the **live
quote** plus slippage, journalled with the quote it was priced from. The account
is a local JSON ledger, so this is a paper deployment, not a live one — the
payload says `mode: "paper"` and `broker: "none"` on every response.

Rails (the list trade-relay (MIT) uses, reimplemented here rather than vendored):

    kill switch · symbol allowlist · trading hours · stop on the correct side
    · minimum reward:risk · risk per trade · position notional · open positions
    · daily loss · orders per day · duplicate protection

Deployments take a `cairnline-strategy/1` document (the same one Backtest
Studio writes) and make one decision per call, from the latest *closed* bar, so
there is no background daemon inventing ticks between requests.
"""
from __future__ import annotations

import copy
import json
import math
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATE_DIR = ROOT / "state"
STATE_PATH = STATE_DIR / "paper.json"

SYMBOLS = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "XAUUSD", "GBPJPY", "USDCHF",
           "EURJPY", "BTCUSD", "ETHUSD", "SPX", "NAS100", "US30"]

DEFAULT_RAILS = {
    "symbol_allowlist": SYMBOLS,
    "max_risk_pct_per_trade": 2.0,
    # FX/CFD notional is levered: 1% risk on a 12-pip stop already implies several
    # times equity. Risk per trade is the real cap; this one exists to stop runaway
    # unit counts, and a deployment sizes down to it instead of being refused.
    "max_position_notional_pct": 1000.0,
    "max_open_positions": 3,
    "max_daily_loss_pct": 3.0,
    "max_orders_per_day": 10,
    "min_reward_risk": 1.5,
    "duplicate_window_s": 60,
    "trading_hours_utc": {"start": 0, "end": 24},
    "slippage_bps": 1.0,
    "commission_bps": 2.0,
}

# Ceilings for the numeric rails. Rails are the risk gate, so widening one past
# these is not a configuration, it is switching the gate off. Tightening a rail
# is always allowed.
RAIL_CAPS = {
    "max_risk_pct_per_trade": 10.0,
    "max_position_notional_pct": 10_000.0,
    "max_open_positions": 100,
    "max_daily_loss_pct": 20.0,
    "max_orders_per_day": 500,
    "min_reward_risk": 100.0,
    "duplicate_window_s": 86_400,
    "slippage_bps": 1_000.0,
    "commission_bps": 1_000.0,
}

_lock = threading.RLock()
_providers: dict = {"quotes": None, "bars": None}


# ---------------------------------------------------------------- providers
def bind(*, quotes, bars) -> None:
    """Wire the market service's live providers in (never called from tests)."""
    _providers["quotes"] = quotes
    _providers["bars"] = bars


def bound() -> bool:
    return callable(_providers["quotes"]) and callable(_providers["bars"])


def _quote(symbol: str) -> dict | None:
    fn = _providers["quotes"]
    if not callable(fn):
        return None
    try:
        quotes = fn([symbol]) or {}
    except Exception:  # noqa: BLE001 - a dead provider is a refusal, not a crash
        return None
    q = quotes.get(symbol)
    if not q or q.get("price") is None:
        return None
    return q


def _bars(symbol: str, interval: str, period: str):
    fn = _providers["bars"]
    if not callable(fn):
        return []
    try:
        return fn(symbol, interval, period) or []
    except Exception:  # noqa: BLE001
        return []


# -------------------------------------------------------------------- state
def _empty_account(balance: float = 10000.0) -> dict:
    return {
        "balance": float(balance),
        "starting_balance": float(balance),
        "positions": [],
        "closed": [],
        "orders": [],
        "deployments": [],
        "kill_switch": {"engaged": False, "reason": None, "at": None},
        "day": {"date": _today(), "orders": 0, "realized": 0.0},
    }


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _load() -> dict:
    try:
        data = json.loads(STATE_PATH.read_text())
    except Exception:  # noqa: BLE001 - first run, or a corrupt file
        data = {}
    acct = data.get("account") or _empty_account()
    # The rails on disk are validated too: a file written before the ceilings
    # existed, or edited by hand, must not hand the gate a rail it would have
    # refused. Loading cannot raise, so a bad value keeps its default.
    rails = copy.deepcopy(DEFAULT_RAILS)
    for key, value in (data.get("rails") or {}).items():
        if key not in DEFAULT_RAILS:
            continue
        try:
            rails[key] = _check_rail(key, value)
        except (TypeError, ValueError):
            pass
    for key in ("positions", "closed", "orders", "deployments"):
        acct.setdefault(key, [])
    acct.setdefault("kill_switch", {"engaged": False, "reason": None, "at": None})
    acct.setdefault("day", {"date": _today(), "orders": 0, "realized": 0.0})
    if acct["day"].get("date") != _today():
        acct["day"] = {"date": _today(), "orders": 0, "realized": 0.0}
    return {"account": acct, "rails": rails}


def _save(state: dict) -> None:
    STATE_DIR.mkdir(exist_ok=True)
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2))
    os.replace(tmp, STATE_PATH)
    try:
        STATE_PATH.chmod(0o600)
    except OSError:
        pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# --------------------------------------------------------------------- rails
def _check_rail(key: str, value):
    """Coerce and validate one rail. Raises on anything it cannot stand behind.

    One validator for both doors: `set_rails` refuses what this rejects, and
    `_load` keeps the default instead.
    """
    if key == "symbol_allowlist":
        if not isinstance(value, list) or not value:
            raise ValueError("symbol_allowlist must be a non-empty list")
        return [str(v).upper() for v in value]
    if key == "trading_hours_utc":
        if not isinstance(value, dict):
            raise ValueError("trading_hours_utc must be {start, end} in whole UTC hours")
        start = int(value.get("start", 0))
        end = int(value.get("end", 24))
        if not (0 <= start <= 24 and 0 <= end <= 24):
            raise ValueError("trading hours must be between 0 and 24")
        return {"start": start, "end": end}
    num = float(value)
    if not math.isfinite(num):
        raise ValueError(f"{key} must be a finite number")
    if num < 0:
        raise ValueError(f"{key} cannot be negative")
    if num > RAIL_CAPS[key]:
        raise ValueError(f"{key} cannot exceed {RAIL_CAPS[key]}")
    return int(num) if key in ("max_open_positions", "max_orders_per_day",
                               "duplicate_window_s") else num


def set_rails(patch: dict) -> dict:
    """Change rails. Values are validated rather than trusted."""
    with _lock:
        state = _load()
        rails = state["rails"]
        for key, value in (patch or {}).items():
            if key not in DEFAULT_RAILS:
                raise ValueError(f"unknown rail {key!r}; known rails: {', '.join(DEFAULT_RAILS)}")
            rails[key] = _check_rail(key, value)
        _save(state)
        return {"rails": rails}


def kill(engaged: bool, reason: str | None = None) -> dict:
    """Engage or clear the kill switch. Engaged blocks new entries, never exits."""
    with _lock:
        state = _load()
        state["account"]["kill_switch"] = {
            "engaged": bool(engaged),
            "reason": (str(reason)[:200] if reason else None) if engaged else None,
            "at": _now() if engaged else None,
        }
        state["account"]["orders"].append({
            "id": uuid.uuid4().hex[:12], "ts": _now(),
            "type": "kill" if engaged else "resume", "accepted": True,
            "reason": reason if engaged else None,
        })
        _save(state)
        return {"kill_switch": state["account"]["kill_switch"]}


# ------------------------------------------------------------------- checks
def _in_hours(rails: dict) -> bool:
    start = int(rails["trading_hours_utc"].get("start", 0))
    end = int(rails["trading_hours_utc"].get("end", 24))
    hour = datetime.now(timezone.utc).hour
    if start == end:
        return True
    if start < end:
        return start <= hour < end
    return hour >= start or hour < end


def _equity(account: dict, marks: dict | None = None) -> float:
    equity = float(account["balance"])
    for pos in account["positions"]:
        price = (marks or {}).get(pos["symbol"], {}).get("price")
        if price is None:
            continue
        side = 1 if pos["side"] == "long" else -1
        equity += (price - pos["entry"]) * side * pos["units"]
    return round(equity, 2)


def _pct_of_equity(amount: float, equity: float) -> float | None:
    """`amount` as a percentage of equity, or None when equity cannot measure it.

    A percentage rail over a non-positive equity is not a small number, it is an
    undefined comparison: `0.0` and negative ratios both sit below every ceiling,
    so a blown account would sail through the gate it most needs. None makes the
    rail fail closed instead of passing.
    """
    return amount / equity * 100.0 if equity > 0 else None


def _position_for(account: dict, symbol: str, strategy: str | None = None):
    for pos in account["positions"]:
        if pos["symbol"] == symbol and (strategy is None or pos.get("strategy") == strategy):
            return pos
    return None


def _duplicate(account: dict, symbol: str, side: str, window_s: float,
               units=None, stop=None, target=None) -> dict | None:
    """A duplicate is the *same* order resubmitted — not any order on the symbol.

    Comparing the size and the brackets is what makes this rail useful: a second
    entry after the first was closed is a new decision, while a double-click is
    the thing the rail exists to stop.
    """
    now = datetime.now(timezone.utc)
    def same(a, b, tol=1e-6):
        if a in (None, "") or b in (None, ""):
            return a in (None, "") and b in (None, "")
        try:
            return abs(float(a) - float(b)) <= tol * max(1.0, abs(float(b)))
        except (TypeError, ValueError):
            return False
    for order in reversed(account["orders"]):
        if order.get("type") != "open" or not order.get("accepted"):
            continue
        if order.get("symbol") != symbol or order.get("side") != side:
            continue
        if not (same(order.get("units"), units)
                and same(order.get("stop"), stop)
                and same(order.get("target"), target)):
            continue
        try:
            age = (now - datetime.fromisoformat(order["ts"])).total_seconds()
        except Exception:  # noqa: BLE001
            continue
        if age <= window_s:
            return order
    return None


def submit(proposal: dict) -> dict:
    """Check every rail, then fill at the live quote. All failures are returned."""
    with _lock:
        state = _load()
        account, rails = state["account"], state["rails"]
        symbol = str(proposal.get("symbol") or "").upper()
        side = str(proposal.get("side") or "").lower()
        checks: list[dict] = []

        def check(key, label, ok, detail):
            checks.append({"key": key, "label": label, "pass": bool(ok), "detail": detail})
            return bool(ok)

        ks = account["kill_switch"]
        check("kill_switch", "Kill switch is clear", not ks.get("engaged"),
              "engaged: " + str(ks.get("reason") or "no reason given") if ks.get("engaged") else "clear")
        check("symbol", "Symbol is on the allowlist", symbol in rails["symbol_allowlist"],
              f"{symbol or '(none)'} in {len(rails['symbol_allowlist'])} allowed symbols")
        check("side", "Side is long or short", side in ("long", "short"), side or "(none)")
        check("hours", "Inside the trading-hours window", _in_hours(rails),
              f"{rails['trading_hours_utc']['start']:02d}:00–{rails['trading_hours_utc']['end']:02d}:00 UTC")

        quote = _quote(symbol) if symbol else None
        price = quote.get("price") if quote else None
        check("quote", "A live quote priced the order", price is not None,
              f"{price} from {quote.get('source', 'provider')}" if price is not None
              else "the provider returned no price for this symbol")

        stop = proposal.get("stop")
        target = proposal.get("target")
        try:
            stop = float(stop) if stop is not None else None
            target = float(target) if target is not None else None
        except (TypeError, ValueError):
            stop = target = None
        if price is not None and side in ("long", "short"):
            dirn = 1 if side == "long" else -1
            stop_ok = stop is not None and (price - stop) * dirn > 0
            check("stop", "Stop is on the losing side of the entry", stop_ok,
                  f"stop {stop} vs price {price}" if stop is not None else "no stop supplied")
            rr = None
            if stop_ok and target is not None:
                risk = abs(price - stop)
                reward = abs(target - price)
                rr = reward / risk if risk else 0.0
            check("reward_risk", f"Reward:risk is at least {rails['min_reward_risk']}",
                  rr is not None and rr >= rails["min_reward_risk"],
                  f"{round(rr, 2)}" if rr is not None else "no target, or the stop is invalid")
        else:
            rr = None
            check("stop", "Stop is on the losing side of the entry", False, "no usable price")
            check("reward_risk", f"Reward:risk is at least {rails['min_reward_risk']}", False, "no usable price")

        equity = _equity(account)
        slip = float(rails["slippage_bps"]) / 1e4
        dirn = 1 if side == "long" else -1
        entry = round(price * (1 + slip * dirn), 8) if price is not None else None

        units = proposal.get("units")
        risk_pct = proposal.get("risk_pct")
        if units is None and entry is not None and stop is not None and abs(entry - stop) > 0:
            use_risk = float(risk_pct if risk_pct is not None else 1.0)
            units = (equity * use_risk / 100.0) / abs(entry - stop)
        units = float(units) if units not in (None, "") else None

        check("units", "Order has a positive size", units is not None and units > 0,
              f"{round(units, 6)} units" if units else "no size could be derived")

        if units and entry and stop is not None:
            risk_pct_actual = _pct_of_equity(abs(entry - stop) * units, equity)
            notional_pct = _pct_of_equity(units * entry, equity)
        else:
            risk_pct_actual = notional_pct = None
        check("risk_per_trade", f"Risk is at most {rails['max_risk_pct_per_trade']}% of equity",
              risk_pct_actual is not None and risk_pct_actual <= rails["max_risk_pct_per_trade"] + 1e-9,
              f"{round(risk_pct_actual, 2)}% of {equity}" if risk_pct_actual is not None
              else f"unknown (equity {equity})")
        check("notional", f"Notional is at most {rails['max_position_notional_pct']}% of equity",
              notional_pct is not None and notional_pct <= rails["max_position_notional_pct"] + 1e-9,
              f"{round(notional_pct, 2)}% of {equity}" if notional_pct is not None
              else f"unknown (equity {equity})")
        check("open_positions", f"Open positions are below {rails['max_open_positions']}",
              len(account["positions"]) < int(rails["max_open_positions"]),
              f"{len(account['positions'])} open")
        day_loss_pct = _pct_of_equity(-account["day"].get("realized", 0.0), equity)
        check("daily_loss", f"Day loss is under {rails['max_daily_loss_pct']}%",
              day_loss_pct is not None and day_loss_pct <= rails["max_daily_loss_pct"] + 1e-9,
              f"{round(max(day_loss_pct, 0), 2)}% realised today" if day_loss_pct is not None
              else f"unknown (equity {equity})")
        check("orders_per_day", f"Orders today are below {rails['max_orders_per_day']}",
              account["day"].get("orders", 0) < int(rails["max_orders_per_day"]),
              f"{account['day'].get('orders', 0)} placed today")
        dup = _duplicate(account, symbol, side, float(rails["duplicate_window_s"]),
                         units=units, stop=stop, target=target)
        check("duplicate", f"No identical order in the last {int(rails['duplicate_window_s'])}s",
              dup is None, f"duplicate of {dup['id']} at {dup['ts']}" if dup else "none")

        failed = [c for c in checks if not c["pass"]]
        order = {
            "id": uuid.uuid4().hex[:12], "ts": _now(), "type": "open",
            "symbol": symbol, "side": side,
            "units": round(units, 6) if units else None,
            "requested_units": proposal.get("units"),
            "risk_pct": round(risk_pct_actual, 3) if risk_pct_actual is not None else None,
            "stop": stop, "target": target,
            "price": price, "entry": entry,
            "quote_source": (quote or {}).get("source"),
            "reason": str(proposal.get("reason") or "")[:300] or None,
            "strategy": proposal.get("strategy"),
            "accepted": not failed,
            "rejections": [c["detail"] for c in failed],
            "checks": checks,
        }
        account["orders"].append(order)
        account["orders"] = account["orders"][-500:]

        if failed:
            _save(state)
            return {"accepted": False, "mode": "paper", "order": order,
                    "reasons": [f"{c['label']}: {c['detail']}" for c in failed],
                    "account": _account_view(account)}

        account["day"]["orders"] = account["day"].get("orders", 0) + 1
        position = {
            "id": uuid.uuid4().hex[:12], "symbol": symbol, "side": side,
            "units": round(units, 6), "entry": entry, "stop": stop, "target": target,
            "opened_at": _now(), "order_id": order["id"],
            "strategy": proposal.get("strategy"), "quote_source": (quote or {}).get("source"),
        }
        account["positions"].append(position)
        _save(state)
        return {"accepted": True, "mode": "paper", "order": order, "position": position,
                "account": _account_view(account),
                "note": "Paper fill at the live quote plus slippage. No broker was contacted."}


def close(position_id: str, reason: str | None = None) -> dict:
    """Close one paper position at the live quote. Allowed while the kill switch is on."""
    with _lock:
        state = _load()
        account, rails = state["account"], state["rails"]
        pos = next((p for p in account["positions"] if p["id"] == position_id), None)
        if pos is None:
            return {"error": f"no open position {position_id}", "account": _account_view(account)}
        quote = _quote(pos["symbol"])
        price = quote.get("price") if quote else None
        if price is None:
            return {"error": f"no live quote for {pos['symbol']}, so the close cannot be priced",
                    "account": _account_view(account)}
        dirn = 1 if pos["side"] == "long" else -1
        slip = float(rails["slippage_bps"]) / 1e4
        exit_px = round(price * (1 - slip * dirn), 8)
        gross = (exit_px - pos["entry"]) * dirn * pos["units"]
        fee = (pos["entry"] + exit_px) * pos["units"] * float(rails["commission_bps"]) / 1e4
        pnl = round(gross - fee, 4)
        account["balance"] = round(account["balance"] + pnl, 4)
        account["day"]["realized"] = round(account["day"].get("realized", 0.0) + pnl, 4)
        account["positions"] = [p for p in account["positions"] if p["id"] != position_id]
        trade = {**pos, "exit": exit_px, "closed_at": _now(), "pnl": pnl,
                 "fees": round(fee, 4), "exit_price_source": (quote or {}).get("source"),
                 "close_reason": str(reason or "manual")[:200]}
        account["closed"].append(trade)
        account["closed"] = account["closed"][-500:]
        account["orders"].append({
            "id": uuid.uuid4().hex[:12], "ts": _now(), "type": "close",
            "symbol": pos["symbol"], "side": pos["side"], "units": pos["units"],
            "price": price, "entry": exit_px, "accepted": True,
            "pnl": pnl, "reason": trade["close_reason"],
        })
        account["orders"] = account["orders"][-500:]
        _save(state)
        return {"closed": trade, "mode": "paper", "account": _account_view(account)}


# --------------------------------------------------------------- deployments
def deploy(strategy_file: dict) -> dict:
    """Register a `cairnline-strategy/1` document as a paper deployment."""
    with _lock:
        state = _load()
        if not isinstance(strategy_file, dict):
            raise ValueError("a deployment takes the strategy JSON document")
        fmt = strategy_file.get("format") or "cairnline-strategy/1"
        if fmt != "cairnline-strategy/1":
            raise ValueError(f"unsupported strategy file format {fmt!r}")
        strategy = strategy_file.get("strategy")
        try:
            import backtest as bt
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"backtest engine unavailable: {exc}") from exc
        if strategy not in bt.STRATEGIES:
            raise ValueError(f"unknown strategy {strategy!r}; the engine has "
                             f"{', '.join(bt.STRATEGIES)}")
        market = strategy_file.get("market") or {}
        symbol = str(market.get("symbol") or "EURUSD").upper()
        deployment = {
            "id": uuid.uuid4().hex[:10],
            "created_at": _now(),
            "strategy": strategy,
            "label": strategy_file.get("label") or bt.STRATEGIES[strategy]["label"],
            "symbol": symbol,
            "interval": str(market.get("interval") or "1h"),
            "range": str(market.get("range") or "6mo"),
            "params": strategy_file.get("params") or {},
            "basis": strategy_file.get("validation") or None,
            "cycles": 0,
            "last_cycle": None,
            "last_bar": None,
            "last_decision": None,
        }
        state["account"]["deployments"].append(deployment)
        state["account"]["deployments"] = state["account"]["deployments"][-20:]
        _save(state)
        return {"deployment": deployment, "mode": "paper",
                "note": ("Registered only. Nothing trades until a cycle is run, and every "
                         "order a cycle proposes still goes through the rails.")}


def cycle(deployment_id: str | None = None) -> dict:
    """One decision per deployment, from the newest closed bar. No background loop."""
    with _lock:
        state = _load()
        account = state["account"]
        targets = [d for d in account["deployments"]
                   if deployment_id in (None, d["id"])]
        if not targets:
            return {"error": "no such deployment" if deployment_id else "nothing is deployed",
                    "mode": "paper"}
        import backtest as bt

        results = []
        for dep in targets:
            bars = _bars(dep["symbol"], dep["interval"], dep["range"])
            if len(bars) < 60:
                results.append({"deployment": dep["id"], "action": "refused",
                                "reason": f"only {len(bars)} bars returned for "
                                          f"{dep['symbol']} {dep['interval']} {dep['range']}"})
                continue
            params = dict(dep.get("params") or {})
            for spec in bt.STRATEGIES[dep["strategy"]]["params"] + bt.STRATEGIES[dep["strategy"]]["shared"]:
                params.setdefault(spec["key"], spec["default"])
            sig = bt._signals(bars, dep["strategy"], params)
            atr = bt._atr(bars, int(params.get("atr_length", 14)))
            i = len(bars) - 1
            last_bar = bars[i].get("openTime") or bars[i].get("open_time")
            if dep.get("last_bar") == last_bar:
                results.append({"deployment": dep["id"], "action": "no new bar",
                                "bar": last_bar,
                                "reason": "the newest closed bar was already traded on"})
                continue
            want = int(sig[i] or 0)
            stop_mult = float(params.get("stop_atr", 1.5))
            target_r = float(params.get("target_r", 2.0))
            a = atr[i]
            pos = _position_for(account, dep["symbol"], dep["id"])
            decision = {"bar": last_bar, "signal": want, "atr": round(a, 8) if a else None}

            if pos and (want == 0 or want != (1 if pos["side"] == "long" else -1)):
                out = close(pos["id"], reason=f"signal {want} on {last_bar}")
                decision.update({"action": "closed", "position": pos["id"],
                                 "pnl": (out.get("closed") or {}).get("pnl")})
                account = _load()["account"]
            elif not pos and want and a:
                q = _quote(dep["symbol"])
                price = q.get("price") if q else None
                if price is None:
                    decision.update({"action": "refused", "reason": "no live quote to price the entry"})
                else:
                    stop = price - want * stop_mult * a
                    equity = _equity(account)
                    risk_units = (equity * 1.0 / 100.0) / abs(price - stop)
                    cap_pct = float(state["rails"]["max_position_notional_pct"])
                    cap_units = (equity * cap_pct / 100.0) / price if price else 0.0
                    units = min(risk_units, cap_units)
                    if units < risk_units:
                        decision["sized_down_to_notional_cap"] = True
                    prop = {
                        "symbol": dep["symbol"], "side": "long" if want == 1 else "short",
                        "units": round(units, 6),
                        "stop": stop, "target": price + want * target_r * stop_mult * a,
                        "reason": f"{dep['label']} on {last_bar}",
                        "strategy": dep["id"],
                    }
                    out = submit(prop)
                    decision.update({"action": "opened" if out.get("accepted") else "rejected",
                                     "order": (out.get("order") or {}).get("id"),
                                     "reasons": out.get("reasons")})
                    account = _load()["account"]
            else:
                decision.update({"action": "held",
                                 "reason": ("already positioned" if pos else "no signal")})

            for d in account["deployments"]:
                if d["id"] == dep["id"]:
                    d["cycles"] = d.get("cycles", 0) + 1
                    d["last_cycle"] = _now()
                    d["last_bar"] = last_bar
                    d["last_decision"] = decision
            results.append({"deployment": dep["id"], **decision})

        state = _load()
        state["account"]["deployments"] = account["deployments"]
        _save(state)
        return {"mode": "paper", "results": results, "generated_at": _now(),
                "account": _account_view(state["account"]),
                "note": ("Each cycle reads the newest closed bar, computes the strategy's "
                         "state, and proposes at most one order — which still has to pass "
                         "every rail.")}


# ---------------------------------------------------------------- snapshot
def _account_view(account: dict, marks: dict | None = None) -> dict:
    equity = _equity(account, marks)
    open_pnl = round(sum(
        ((marks or {}).get(p["symbol"], {}).get("price", p["entry"]) - p["entry"])
        * (1 if p["side"] == "long" else -1) * p["units"] for p in account["positions"]), 2)
    return {
        "balance": round(account["balance"], 2),
        "starting_balance": account.get("starting_balance"),
        "equity": equity,
        "open_pnl": open_pnl,
        "realized_today": account["day"].get("realized", 0.0),
        "day": account["day"],
        "positions": account["positions"],
        "closed": account["closed"][-50:],
        "orders": account["orders"][-50:],
        "deployments": account["deployments"],
        "kill_switch": account["kill_switch"],
    }


def snapshot() -> dict:
    with _lock:
        state = _load()
        account = state["account"]
        symbols = sorted({p["symbol"] for p in account["positions"]})
        marks = {}
        if symbols:
            fn = _providers["quotes"]
            if callable(fn):
                try:
                    raw = fn(symbols) or {}
                    marks = {s: raw[s] for s in symbols if s in raw}
                except Exception:  # noqa: BLE001
                    marks = {}
        return {
            "mode": "paper",
            "engine": "cairnline-paper-desk",
            "broker": "none — no order leaves this machine",
            "generated_at": _now(),
            "account": _account_view(account, marks),
            "rails": state["rails"],
            "marks": marks,
            "mark_source": next((m.get("source") for m in marks.values() if m.get("source")), None),
            "rails_note": ("Rails are enforced server-side in server/paper_trader.py on every "
                           "submit, including the ones a deployment proposes; the browser "
                           "cannot bypass them. A stop is not watched between requests — "
                           "there is no broker and no background loop, so a position exits "
                           "when you close it or a cycle decides to."),
        }
