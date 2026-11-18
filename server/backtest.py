"""Cairnline backtest engine — stdlib only, deterministic.

One model, stated plainly so the numbers can be read:

* A signal is decided on a **closed** bar and filled at the **next bar's open**.
* Slippage is charged against the fill on entry and on exit.
* Every position carries an ATR stop and an R-multiple target; when a bar
  touches both, the stop is assumed to have hit first.
* Commission is charged on both sides, in basis points of notional.
* Position size comes from risk percent of current equity divided by the stop
  distance, so `risk_pct` is the loss if the stop is hit (before costs).
* One position at a time, long or short, no pyramiding.

Everything in the report is derived from the trades that actually happened. If
the sample is thin, the report says so instead of quoting a confident number.
"""
from __future__ import annotations

import math
import random
from datetime import datetime, timezone

# --------------------------------------------------------------------- helpers


def _ema(values, n):
    out = [None] * len(values)
    if n <= 0 or len(values) < n:
        return out
    k = 2.0 / (n + 1.0)
    seed = sum(values[:n]) / n
    out[n - 1] = seed
    prev = seed
    for i in range(n, len(values)):
        prev = values[i] * k + prev * (1 - k)
        out[i] = prev
    return out


def _rsi(values, n):
    out = [None] * len(values)
    if len(values) <= n:
        return out
    gain = loss = 0.0
    for i in range(1, n + 1):
        d = values[i] - values[i - 1]
        gain += max(d, 0.0)
        loss += max(-d, 0.0)
    avg_gain, avg_loss = gain / n, loss / n
    out[n] = 100.0 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)
    for i in range(n + 1, len(values)):
        d = values[i] - values[i - 1]
        avg_gain = (avg_gain * (n - 1) + max(d, 0.0)) / n
        avg_loss = (avg_loss * (n - 1) + max(-d, 0.0)) / n
        out[i] = 100.0 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)
    return out


def _atr(bars, n):
    out = [None] * len(bars)
    if len(bars) <= n:
        return out
    trs = []
    for i in range(1, len(bars)):
        h, l, pc = bars[i]["high"], bars[i]["low"], bars[i - 1]["close"]
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    seed = sum(trs[:n]) / n
    out[n] = seed
    prev = seed
    for i in range(n, len(trs)):
        prev = (prev * (n - 1) + trs[i]) / n
        out[i + 1] = prev
    return out


def _highest(values, n, i):
    """Highest value of the n bars BEFORE index i (no lookahead)."""
    if i - n < 0:
        return None
    return max(values[i - n:i])


def _lowest(values, n, i):
    if i - n < 0:
        return None
    return min(values[i - n:i])


# ------------------------------------------------------------------ strategies

STRATEGIES = {
    "ema-cross": {
        "label": "EMA cross (trend)",
        "note": "Long while the fast EMA is above the slow one, short while it is below.",
        "params": [
            {"key": "fast", "label": "Fast EMA", "default": 9, "min": 2, "max": 200, "step": 1},
            {"key": "slow", "label": "Slow EMA", "default": 21, "min": 3, "max": 400, "step": 1},
        ],
        "shared": [
            {"key": "atr_length", "label": "ATR length", "default": 14, "min": 2, "max": 100, "step": 1},
            {"key": "stop_atr", "label": "Stop (× ATR)", "default": 1.5, "min": 0.2, "max": 10, "step": 0.1},
            {"key": "target_r", "label": "Target (R)", "default": 2, "min": 0.2, "max": 10, "step": 0.1},
        ],
    },
    "rsi-reversion": {
        "label": "RSI reversion",
        "note": "Buy oversold, sell overbought, exit when RSI returns to the midline.",
        "params": [
            {"key": "length", "label": "RSI length", "default": 14, "min": 2, "max": 100, "step": 1},
            {"key": "low", "label": "Oversold", "default": 30, "min": 1, "max": 49, "step": 1},
            {"key": "high", "label": "Overbought", "default": 70, "min": 51, "max": 99, "step": 1},
        ],
        "shared": [
            {"key": "atr_length", "label": "ATR length", "default": 14, "min": 2, "max": 100, "step": 1},
            {"key": "stop_atr", "label": "Stop (× ATR)", "default": 1.5, "min": 0.2, "max": 10, "step": 0.1},
            {"key": "target_r", "label": "Target (R)", "default": 2, "min": 0.2, "max": 10, "step": 0.1},
        ],
    },
    "breakout": {
        "label": "Donchian breakout",
        "note": "Go with a close beyond the prior N-bar range.",
        "params": [
            {"key": "length", "label": "Lookback", "default": 20, "min": 3, "max": 300, "step": 1},
        ],
        "shared": [
            {"key": "atr_length", "label": "ATR length", "default": 14, "min": 2, "max": 100, "step": 1},
            {"key": "stop_atr", "label": "Stop (× ATR)", "default": 1.5, "min": 0.2, "max": 10, "step": 0.1},
            {"key": "target_r", "label": "Target (R)", "default": 2, "min": 0.2, "max": 10, "step": 0.1},
        ],
    },
}


def _signals(bars, strategy, p):
    """Desired direction after each closed bar: 1 long, -1 short, 0 flat."""
    closes = [b["close"] for b in bars]
    n = len(bars)
    sig = [0] * n
    if strategy == "ema-cross":
        fast = _ema(closes, int(p["fast"]))
        slow = _ema(closes, int(p["slow"]))
        for i in range(n):
            if fast[i] is None or slow[i] is None:
                continue
            sig[i] = 1 if fast[i] > slow[i] else -1
    elif strategy == "rsi-reversion":
        r = _rsi(closes, int(p["length"]))
        low, high = float(p["low"]), float(p["high"])
        mid = (low + high) / 2
        for i in range(n):
            if r[i] is None:
                continue
            if r[i] <= low:
                sig[i] = 1
            elif r[i] >= high:
                sig[i] = -1
            else:
                # hold until the midline is crossed back
                prev = sig[i - 1] if i else 0
                sig[i] = prev if (prev == 1 and r[i] < mid) or (prev == -1 and r[i] > mid) else 0
                if prev == 1 and r[i] >= mid:
                    sig[i] = 0
                if prev == -1 and r[i] <= mid:
                    sig[i] = 0
    elif strategy == "breakout":
        highs = [b["high"] for b in bars]
        lows = [b["low"] for b in bars]
        length = int(p["length"])
        for i in range(n):
            hi, lo = _highest(highs, length, i), _lowest(lows, length, i)
            if hi is None or lo is None:
                continue
            if closes[i] > hi:
                sig[i] = 1
            elif closes[i] < lo:
                sig[i] = -1
    return sig


# ---------------------------------------------------------------------- engine


def simulate(bars, strategy, params, *, commission_bps=2.0, slippage_bps=1.0,
             balance=10000.0, risk_pct=1.0):
    """Run one strategy over one bar series. Returns trades + metrics + curve."""
    p = dict(params or {})
    for spec in STRATEGIES.get(strategy, {}).get("params", []) + STRATEGIES.get(strategy, {}).get("shared", []):
        p.setdefault(spec["key"], spec["default"])
    if strategy not in STRATEGIES:
        raise ValueError(f"unknown strategy: {strategy}")

    sig = _signals(bars, strategy, p)
    atr_series = _atr(bars, int(p.get("atr_length", 14)))
    stop_mult = float(p.get("stop_atr", 1.5))
    target_r = float(p.get("target_r", 2.0))
    slip = float(slippage_bps) / 1e4
    fee = float(commission_bps) / 1e4

    equity = float(balance)
    trades = []
    curve = []
    pos = None
    bars_in_market = 0
    i = 0
    n = len(bars)

    while i < n:
        bar = bars[i]
        if pos is None:
            want = sig[i]
            a = atr_series[i]
            if want and a and a > 0 and i + 1 < n:
                entry = bars[i + 1]["open"] * (1 + slip * want)
                stop_dist = stop_mult * a
                units = (equity * risk_pct / 100.0) / stop_dist
                pos = {
                    "side": int(want),
                    "entry": entry,
                    "units": units,
                    "stop": entry - want * stop_dist,
                    "target": entry + want * target_r * stop_dist,
                    "stop_dist": stop_dist,
                    "entry_time": bars[i + 1]["openTime"],
                    "entry_index": i + 1,
                }
                i += 1
                continue
        else:
            bars_in_market += 1
            hi, lo = bar["high"], bar["low"]
            side = pos["side"]
            hit = None
            # stop first when a bar spans both levels: the conservative assumption
            if side == 1 and lo <= pos["stop"]:
                hit = ("stop", pos["stop"])
            elif side == -1 and hi >= pos["stop"]:
                hit = ("stop", pos["stop"])
            elif side == 1 and hi >= pos["target"]:
                hit = ("target", pos["target"])
            elif side == -1 and lo <= pos["target"]:
                hit = ("target", pos["target"])
            flip = sig[i] != side and sig[i] != 0
            if hit or flip or i + 1 >= n:
                if hit:
                    exit_px, reason = hit[1] * (1 - slip * side), hit[0]
                else:
                    exit_px = bar["close"] * (1 - slip * side)
                    reason = "signal" if flip else "end"
                gross = (exit_px - pos["entry"]) * side * pos["units"]
                notional = (pos["entry"] + exit_px) * pos["units"]
                cost = notional * fee
                pnl = gross - cost
                equity += pnl
                r = pnl / (pos["stop_dist"] * pos["units"]) if pos["stop_dist"] else 0.0
                trades.append({
                    "entry_time": pos["entry_time"],
                    "exit_time": bar["openTime"],
                    "side": "long" if side == 1 else "short",
                    "entry": round(pos["entry"], 8),
                    "exit": round(exit_px, 8),
                    "stop": round(pos["stop"], 8),
                    "units": round(pos["units"], 6),
                    "pnl": round(pnl, 4),
                    "r": round(r, 4),
                    "bars": i - pos["entry_index"] + 1,
                    "reason": reason,
                    "equity": round(equity, 4),
                })
                pos = None
        curve.append({"t": bar["openTime"], "v": round(equity, 4)})
        i += 1

    metrics = _metrics(trades, curve, balance, bars_in_market, n, risk_pct)
    return {"trades": trades, "metrics": metrics, "curve": curve, "params": p}


def _metrics(trades, curve, balance, bars_in_market, bars_n, risk_pct):
    n = len(trades)
    net = sum(t["pnl"] for t in trades)
    wins = [t for t in trades if t["pnl"] > 0]
    losses = [t for t in trades if t["pnl"] <= 0]
    gross_win = sum(t["pnl"] for t in wins)
    gross_loss = -sum(t["pnl"] for t in losses)

    peak = balance
    max_dd = 0.0
    for point in curve:
        peak = max(peak, point["v"])
        if peak > 0:
            max_dd = max(max_dd, (peak - point["v"]) / peak)

    rets = []
    for a, b in zip(curve, curve[1:]):
        if a["v"]:
            rets.append((b["v"] - a["v"]) / a["v"])
    sharpe = None
    if len(rets) > 2:
        mean = sum(rets) / len(rets)
        var = sum((x - mean) ** 2 for x in rets) / (len(rets) - 1)
        sd = math.sqrt(var)
        if sd > 0:
            # bars are not daily, so this is a per-bar Sharpe scaled to 252 bars:
            # a comparison figure, never an annual claim.
            sharpe = round(mean / sd * math.sqrt(252), 3)

    streak = worst = 0
    for t in trades:
        streak = streak + 1 if t["pnl"] <= 0 else 0
        worst = max(worst, streak)

    return {
        "trades": n,
        "net_pnl": round(net, 2),
        "net_pct": round(net / balance * 100, 2) if balance else 0.0,
        "final_equity": round(balance + net, 2),
        "win_rate": round(len(wins) / n * 100, 1) if n else None,
        "wins": len(wins),
        "losses": len(losses),
        "profit_factor": round(gross_win / gross_loss, 2) if gross_loss > 0 else None,
        "expectancy_r": round(sum(t["r"] for t in trades) / n, 3) if n else None,
        "avg_win_r": round(sum(t["r"] for t in wins) / len(wins), 3) if wins else None,
        "avg_loss_r": round(sum(t["r"] for t in losses) / len(losses), 3) if losses else None,
        "max_drawdown_pct": round(max_dd * 100, 2),
        "max_consecutive_losses": worst,
        "sharpe_per_bar_252": sharpe,
        "exposure_pct": round(bars_in_market / bars_n * 100, 1) if bars_n else 0.0,
        "avg_bars_held": round(sum(t["bars"] for t in trades) / n, 1) if n else None,
        "risk_pct": risk_pct,
    }


# ------------------------------------------------------------------ validation

def monte_carlo(rs, *, risk_pct=1.0, paths=1000, seed=7):
    """Bootstrap the trade sequence: same edge, different order."""
    if not rs:
        return None
    rng = random.Random(seed)
    finals, dds = [], []
    for _ in range(paths):
        eq = 1.0
        peak = 1.0
        dd = 0.0
        for _ in rs:
            eq *= (1 + rng.choice(rs) * risk_pct / 100.0)
            peak = max(peak, eq)
            dd = max(dd, (peak - eq) / peak if peak > 0 else 0.0)
        finals.append(eq - 1)
        dds.append(dd)
    finals.sort()
    dds.sort()

    def q(vals, f):
        idx = min(len(vals) - 1, max(0, int(round(f * (len(vals) - 1)))))
        return vals[idx]

    return {
        "paths": paths,
        "trades_per_path": len(rs),
        "final_return": {
            "p5": round(q(finals, 0.05) * 100, 2),
            "p50": round(q(finals, 0.50) * 100, 2),
            "p95": round(q(finals, 0.95) * 100, 2),
        },
        "max_drawdown_pct": {
            "p50": round(q(dds, 0.50) * 100, 2),
            "p95": round(q(dds, 0.95) * 100, 2),
        },
        "loss_probability_pct": round(sum(1 for f in finals if f < 0) / len(finals) * 100, 1),
        "seed": seed,
        "note": "Bootstrap of this strategy's own trades: the same edge in a different order. Not a forecast.",
    }


def optimize(bars, strategy, base_params, grid, *, commission_bps, slippage_bps,
             balance, risk_pct, limit=60):
    """Grid search over one or two parameters, split in halves for stability."""
    combos = [{}]
    for key, values in (grid or {}).items():
        nxt = []
        for combo in combos:
            for v in values:
                nxt.append({**combo, key: v})
        combos = nxt
    combos = combos[:limit]

    half = len(bars) // 2
    rows = []
    for combo in combos:
        params = {**base_params, **combo}
        full = simulate(bars, strategy, params, commission_bps=commission_bps,
                        slippage_bps=slippage_bps, balance=balance, risk_pct=risk_pct)
        first = simulate(bars[:half], strategy, params, commission_bps=commission_bps,
                         slippage_bps=slippage_bps, balance=balance, risk_pct=risk_pct)
        second = simulate(bars[half:], strategy, params, commission_bps=commission_bps,
                          slippage_bps=slippage_bps, balance=balance, risk_pct=risk_pct)
        m = full["metrics"]
        rows.append({
            "params": combo,
            "trades": m["trades"],
            "net_pct": m["net_pct"],
            "win_rate": m["win_rate"],
            "profit_factor": m["profit_factor"],
            "max_drawdown_pct": m["max_drawdown_pct"],
            "expectancy_r": m["expectancy_r"],
            "first_half_pct": first["metrics"]["net_pct"],
            "second_half_pct": second["metrics"]["net_pct"],
            "stable": first["metrics"]["net_pct"] > 0 and second["metrics"]["net_pct"] > 0,
        })
    rows.sort(key=lambda r: (r["net_pct"], r["trades"]), reverse=True)
    return {
        "rows": rows,
        "combos": len(rows),
        "note": "Ranked on the full period. The halves are shown so a result that only works once is visible.",
    }


# ------------------------------------------------------- validation (C5)
#
# A sweep finds settings that fit one history. Validation asks the harder
# question the plan calls "settings that hold up": does the setting chosen on
# earlier bars still make money on bars it never saw, is it a plateau or a
# spike, does it survive doubled costs, and how much risk can it carry before
# the drawdown gets uncomfortable. Every check is reported by name so a pass
# can be read, not just believed.


def _combos(grid, limit=24):
    combos = [{}]
    for key, values in (grid or {}).items():
        nxt = []
        for combo in combos:
            for v in values:
                nxt.append({**combo, key: v})
        combos = nxt
    return combos[:limit]


def default_grid(strategy, params):
    """A small grid around the first tunable parameter, inside its own bounds."""
    spec = (STRATEGIES.get(strategy) or {}).get("params") or []
    if not spec:
        return {}
    s = spec[0]
    base = float((params or {}).get(s["key"], s["default"]))
    step = float(s["step"]) or 1.0
    lo = max(float(s["min"]), base - 2 * step * max(1.0, round(base * 0.1 / step)))
    hi = min(float(s["max"]), base + 2 * step * max(1.0, round(base * 0.1 / step)))
    values = []
    v = lo
    while v <= hi + 1e-9:
        values.append(round(v, 4))
        v += step * max(1.0, round((hi - lo) / (step * 4)))
    if base not in values:
        values.append(base)
    values = sorted({round(x, 4) for x in values})[:7]
    return {s["key"]: values}


def _segments(n, folds):
    """OOS windows in order. The first segment is in-sample only."""
    folds = max(3, min(6, int(folds or 3)))
    size = n // folds
    out = []
    for k in range(1, folds):
        start = k * size
        end = n if k == folds - 1 else (k + 1) * size
        out.append((start, end))
    return out


def walk_forward(bars, strategy, base_params, grid, *, commission_bps, slippage_bps,
                 balance, risk_pct, folds=3, embargo=20):
    """Choose on earlier bars, test on later bars, once per fold.

    The in-sample window expands; an `embargo` gap between the two is dropped so
    a position opened near the end of the in-sample window cannot resolve inside
    the out-of-sample one and leak its outcome.
    """
    combos = _combos(grid, limit=24)
    rows, oos_rs = [], []
    oos_pnl = 0.0
    for idx, (start, end) in enumerate(_segments(len(bars), folds), start=1):
        is_end = max(0, start - int(embargo))
        is_bars, oos_bars = bars[:is_end], bars[start:end]
        if len(is_bars) < 120 or len(oos_bars) < 30:
            rows.append({"fold": idx, "evaluated": False,
                         "skipped": f"not enough bars (IS {len(is_bars)}, OOS {len(oos_bars)})"})
            continue
        ranked = []
        for combo in combos:
            res = simulate(is_bars, strategy, {**base_params, **combo},
                           commission_bps=commission_bps, slippage_bps=slippage_bps,
                           balance=balance, risk_pct=risk_pct)
            ranked.append((res["metrics"]["net_pct"], combo, res["metrics"]["trades"]))
        ranked.sort(key=lambda r: (r[0], r[2]), reverse=True)
        best_is_pct, best_combo, is_trades = ranked[0]
        oos = simulate(oos_bars, strategy, {**base_params, **best_combo},
                       commission_bps=commission_bps, slippage_bps=slippage_bps,
                       balance=balance, risk_pct=risk_pct)
        om = oos["metrics"]
        oos_pnl += om["net_pnl"]
        oos_rs.extend(t["r"] for t in oos["trades"])
        rows.append({
            "fold": idx, "evaluated": True,
            "is_bars": len(is_bars), "oos_bars": len(oos_bars),
            "is_trades": is_trades, "is_params": best_combo, "is_net_pct": best_is_pct,
            "oos_trades": om["trades"], "oos_net_pct": om["net_pct"],
            "oos_win_rate": om["win_rate"], "oos_profit_factor": om["profit_factor"],
            "oos_max_drawdown_pct": om["max_drawdown_pct"],
            "held_up": bool(om["trades"] >= 5 and om["net_pct"] > 0),
        })
    evaluated = [r for r in rows if r.get("evaluated")]
    return {
        "folds": len(_segments(len(bars), folds)),
        "embargo_bars": int(embargo),
        "rows": rows,
        "folds_evaluated": len(evaluated),
        "folds_held": sum(1 for r in evaluated if r["held_up"]),
        "aggregate_oos_pct": round(oos_pnl / balance * 100, 2) if balance else 0.0,
        "aggregate_oos_trades": len(oos_rs),
        "oos_rs": oos_rs,
        "method": ("Expanding in-sample window, parameters chosen on it, then traded "
                   "unchanged on the next segment. The embargo drops bars between the "
                   "two so a stop cannot resolve across the boundary."),
    }


def optimal_risk(rs, *, cap_dd_pct=20.0, paths=600, seed=7, max_risk=5.0):
    """Largest risk per trade whose p95 Monte Carlo drawdown stays under the cap."""
    if not rs:
        return None
    grid = [r for r in (0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0) if r <= max_risk]
    rows, best = [], None
    for r in grid:
        mc = monte_carlo(rs, risk_pct=r, paths=paths, seed=seed)
        dd = mc["max_drawdown_pct"]["p95"]
        rows.append({"risk_pct": r, "p95_drawdown_pct": dd,
                     "p50_return_pct": mc["final_return"]["p50"],
                     "loss_probability_pct": mc["loss_probability_pct"]})
        if dd <= cap_dd_pct:
            best = r
    return {
        "cap_dd_pct": cap_dd_pct,
        "recommended_risk_pct": best,
        "rows": rows,
        "note": (f"Bootstrap of the tested trade R-multiples at each risk level; the "
                 f"recommendation is the largest one whose 95th-percentile drawdown stays "
                 f"at or under {cap_dd_pct}%." if best is not None else
                 f"No tested risk keeps the 95th-percentile drawdown at or under "
                 f"{cap_dd_pct}% — this sequence is too rough for that cap."),
    }


def validate(bars, body):
    """Out-of-sample, plateau, cost-stress and risk checks for C4's strategy."""
    strategy = body.get("strategy") or "ema-cross"
    if strategy not in STRATEGIES:
        raise ValueError(f"unknown strategy: {strategy}")
    params = body.get("params") or {}
    commission_bps = float(body.get("commission_bps", 2))
    slippage_bps = float(body.get("slippage_bps", 1))
    balance = float(body.get("balance", 10000))
    risk_pct = float(body.get("risk_pct", 1))
    grid = body.get("grid") or default_grid(strategy, params)
    combos = _combos(grid, limit=24)

    # Parameter surface over the whole period: plateau or spike?
    surface = []
    for combo in combos:
        res = simulate(bars, strategy, {**params, **combo}, commission_bps=commission_bps,
                       slippage_bps=slippage_bps, balance=balance, risk_pct=risk_pct)
        surface.append({"params": combo, "net_pct": res["metrics"]["net_pct"],
                        "trades": res["metrics"]["trades"]})
    surface.sort(key=lambda r: (r["net_pct"], r["trades"]), reverse=True)
    leader = surface[0]
    nets = sorted(r["net_pct"] for r in surface)
    median = nets[len(nets) // 2] if nets else 0.0
    positive_share = (sum(1 for n in nets if n > 0) / len(nets)) if nets else 0.0

    wf = walk_forward(bars, strategy, params, grid, commission_bps=commission_bps,
                      slippage_bps=slippage_bps, balance=balance, risk_pct=risk_pct,
                      folds=int(body.get("folds") or 3),
                      embargo=int(body.get("embargo") or 20))

    # Cost stress: the same setting with doubled commission and slippage.
    stressed = simulate(bars, strategy, {**params, **leader["params"]},
                        commission_bps=commission_bps * 2, slippage_bps=slippage_bps * 2,
                        balance=balance, risk_pct=risk_pct)

    base = simulate(bars, strategy, {**params, **leader["params"]},
                    commission_bps=commission_bps, slippage_bps=slippage_bps,
                    balance=balance, risk_pct=risk_pct)
    rs = [t["r"] for t in base["trades"]]
    mc = monte_carlo(rs, risk_pct=risk_pct)
    risk = optimal_risk(rs, cap_dd_pct=float(body.get("drawdown_cap_pct") or 20.0))

    checks = []
    wf_ok = (wf["folds_evaluated"] >= 2 and wf["aggregate_oos_pct"] > 0
             and wf["folds_held"] >= max(1, (wf["folds_evaluated"] * 2 + 2) // 3))
    checks.append({
        "key": "out_of_sample", "label": "Out-of-sample folds hold", "pass": wf_ok,
        "detail": (f"{wf['folds_held']} of {wf['folds_evaluated']} folds positive on bars the "
                   f"parameters were not chosen on; aggregate {wf['aggregate_oos_pct']}%")
        if wf["folds_evaluated"] >= 2 else
        (f"only {wf['folds_evaluated']} fold had enough bars — a walk-forward needs at least 2, "
         f"so robustness was not demonstrated" if wf["folds_evaluated"] == 1 else
         "not enough history for a single fold"),
    })
    plateau_ok = positive_share >= 0.5 and (leader["net_pct"] <= 0 or median > 0)
    checks.append({
        "key": "plateau", "label": "Surface is a plateau, not a spike", "pass": plateau_ok,
        "detail": (f"{round(positive_share * 100)}% of the {len(surface)} tested settings are "
                   f"positive; median {median}% vs best {leader['net_pct']}%"),
    })
    cost_ok = stressed["metrics"]["net_pct"] > 0
    checks.append({
        "key": "cost_stress", "label": "Survives doubled costs", "pass": cost_ok,
        "detail": (f"at {commission_bps * 2} bps commission and {slippage_bps * 2} bps slippage "
                   f"the same setting returns {stressed['metrics']['net_pct']}% "
                   f"(vs {base['metrics']['net_pct']}%)"),
    })
    sample_ok = wf["aggregate_oos_trades"] >= 30
    checks.append({
        "key": "sample", "label": "Out-of-sample sample is usable", "pass": sample_ok,
        "detail": f"{wf['aggregate_oos_trades']} out-of-sample trades (30 is the floor)",
    })
    dd_p95 = (mc or {}).get("max_drawdown_pct", {}).get("p95")
    risk_ok = bool(risk and risk["recommended_risk_pct"] is not None)
    checks.append({
        "key": "risk_cap", "label": "A risk level exists under the drawdown cap", "pass": risk_ok,
        "detail": (f"largest safe risk {risk['recommended_risk_pct']}% for a "
                   f"{risk['cap_dd_pct']}% p95 drawdown cap; at {risk_pct}% the p95 drawdown is {dd_p95}%")
        if risk else "no trades to bootstrap",
    })

    passed = sum(1 for c in checks if c["pass"])
    holds_up = passed == len(checks)
    label = "holds up" if holds_up else ("partly holds up" if passed >= 3 else "does not hold up")
    failing = [c["key"] for c in checks if not c["pass"]]
    sentence = (
        f"{label.replace('holds up', 'Holds up')} out of sample: {passed}/{len(checks)} checks pass."
        if holds_up else
        f"{label.capitalize()}: {passed}/{len(checks)} checks pass; {', '.join(failing)} did not."
    )

    return {
        "mode": "validate", "strategy": strategy, "strategy_label": STRATEGIES[strategy]["label"],
        "bars": len(bars),
        "costs": {"commission_bps": commission_bps, "slippage_bps": slippage_bps},
        "grid": grid,
        "leader": leader,
        "surface": {"rows": surface[:12], "tested": len(surface),
                    "positive_share": round(positive_share, 2),
                    "median_net_pct": median, "best_net_pct": leader["net_pct"]},
        "walk_forward": {k: v for k, v in wf.items() if k != "oos_rs"},
        "cost_stress": {"net_pct": stressed["metrics"]["net_pct"],
                        "commission_bps": commission_bps * 2, "slippage_bps": slippage_bps * 2},
        "monte_carlo": mc,
        "optimal_risk": risk,
        "checks": checks,
        "verdict": {"holds_up": holds_up, "label": label, "sentence": sentence,
                    "failed_checks": failing},
        "note": ("Walk-forward here is expanding-window with an embargo; it is not a purged "
                 "k-fold and it cannot invent history the feed does not have. The surface is "
                 "the grid actually simulated, nothing interpolated."),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


def run(bars, body):
    """Entry point used by the HTTP service."""
    strategy = body.get("strategy") or "ema-cross"
    params = body.get("params") or {}
    commission_bps = float(body.get("commission_bps", 2))
    slippage_bps = float(body.get("slippage_bps", 1))
    balance = float(body.get("balance", 10000))
    risk_pct = float(body.get("risk_pct", 1))

    if len(bars) < 60:
        raise ValueError(f"only {len(bars)} bars — a backtest needs at least 60")

    mode = body.get("mode") or "run"
    if mode == "validate":
        return validate(bars, body)
    if mode == "optimize":
        result = optimize(bars, strategy, params, body.get("grid") or {},
                          commission_bps=commission_bps, slippage_bps=slippage_bps,
                          balance=balance, risk_pct=risk_pct)
        return {
            "mode": "optimize", "strategy": strategy, "bars": len(bars),
            "costs": {"commission_bps": commission_bps, "slippage_bps": slippage_bps},
            **result,
        }

    out = simulate(bars, strategy, params, commission_bps=commission_bps,
                   slippage_bps=slippage_bps, balance=balance, risk_pct=risk_pct)
    rs = [t["r"] for t in out["trades"]]
    thin = len(rs) < 30
    return {
        "mode": "run",
        "strategy": strategy,
        "strategy_label": STRATEGIES[strategy]["label"],
        "bars": len(bars),
        "costs": {"commission_bps": commission_bps, "slippage_bps": slippage_bps},
        "params": out["params"],
        "metrics": out["metrics"],
        "trades": out["trades"][-200:],
        "curve": out["curve"][-600:],
        "monte_carlo": monte_carlo(rs, risk_pct=risk_pct),
        "sample_note": (
            f"{len(rs)} trades — under 30, so these figures are noise; widen the range or trade a longer history."
            if thin else
            f"{len(rs)} trades. Costs are charged on both sides; the stop is assumed to hit before the target when a bar spans both."
        ),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
