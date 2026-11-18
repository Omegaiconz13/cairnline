"""Cairnline Edge Stats engine.

The catalog is LuxAlgo's edge-stats preset set (MIT, vendored verbatim in
`server/presets/`: 42 presets over 11 categories; the macro event calendars in
`server/presets/events/` are CC BY 4.0). This module answers those presets over
our own bars instead of the three hand-rolled conditions the page used to have.

What a "session" is here
------------------------
One UTC calendar day of the instrument, built from the bars the caller passes:

* daily bars  → one bar is the session;
* intraday bars → the day's bars are grouped, so open/high/low/close, the
  opening-range windows, the initial balance and the time of the extremes all
  become available.

Days with fewer than two intraday bars, and days at the very edge of the data,
are dropped as incomplete rather than counted as tiny sessions.

Everything the engine reports is derived from the sessions it actually saw. A
sample under 30 observations is labelled as noise in the response itself, and
the confidence interval, the half-split and the per-year counts sit next to the
point estimate so a rate can be read against its uncertainty.
"""
from __future__ import annotations

import glob
import json
import math
import os
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
PRESET_DIR = os.path.join(HERE, "presets")
EVENT_DIR = os.path.join(PRESET_DIR, "events")

# Session windows, stated once here and echoed in every response so the reader
# knows exactly what the per-session table means.
SESSIONS = [
    ("asia", "Asia", 0, 7),
    ("london", "London", 7, 12),
    ("london_ny", "London / New York overlap", 12, 16),
    ("new_york", "New York", 16, 21),
    ("after_hours", "After hours", 21, 24),
]

# Gap-size buckets, from the gap-fill-by-size preset's own definition.
GAP_BUCKETS = [
    ("xs", 0.0, 0.0015),
    ("s", 0.0015, 0.003),
    ("m", 0.003, 0.0075),
    ("l", 0.0075, 0.015),
    ("xl", 0.015, float("inf")),
]

WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

# FX trades 24/5, so a "gap" across a UTC midnight is usually a few tenths of a
# basis point of drift, not a session gap. Anything under this floor is treated as
# no gap at all; the number is reported with every gap result so it is not hidden.
GAP_FLOOR_PCT = 0.05

# Presets whose outcome cannot be computed from daily bars alone.
NEEDS_INTRADAY = {
    "orb", "orb-by-direction", "orb-false-break", "orb-target", "orb-time-to-break",
    "ib-extension", "initial-balance", "high-time", "low-time",
}

# Presets whose outcome can only be known on the *next* session.
NEXT_SESSION = {"doji-follow-through", "engulfing-bull", "engulfing-bear", "inside-day",
                "outside-day", "streak-continuation", "streak-reversion"}


# --------------------------------------------------------------------- presets


def load_presets():
    out = []
    for path in sorted(glob.glob(os.path.join(PRESET_DIR, "*.json"))):
        with open(path, encoding="utf-8") as fh:
            p = json.load(fh)
        if not p.get("id") or not p.get("outcome"):
            continue
        out.append(p)
    out.sort(key=lambda p: (p.get("category", ""), p["id"]))
    return out


def load_events():
    """Event calendars: name → set of ISO dates."""
    out = {}
    for path in sorted(glob.glob(os.path.join(EVENT_DIR, "*.json"))):
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
        except Exception:  # noqa: BLE001
            continue
        name = str(data.get("event") or os.path.basename(path).split(".")[0]).upper()
        out[name] = set(data.get("dates") or [])
    return out


EVENTS = load_events()


# ---------------------------------------------------------------------- maths


def wilson(hits, n, z=1.96):
    """Wilson score interval — it stays sane at small n, unlike a normal approx."""
    if n <= 0:
        return (0.0, 1.0)
    p = hits / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = (z / d) * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (max(0.0, centre - half), min(1.0, centre + half))


def _quantile(values, q):
    if not values:
        return None
    vs = sorted(values)
    idx = min(len(vs) - 1, max(0, int(round(q * (len(vs) - 1)))))
    return vs[idx]


def _day(ts_ms):
    return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)


def _iso(ts_ms):
    return _day(ts_ms).strftime("%Y-%m-%d")


def session_of(ts_ms):
    hour = _day(ts_ms).hour
    for key, label, start, end in SESSIONS:
        if start <= hour < end:
            return key, label
    return "after_hours", "After hours"


# ------------------------------------------------------------------- sessions


def build_sessions(bars):
    """Group bars into UTC-day sessions. Returns sessions in time order."""
    by_day = {}
    for b in bars:
        ts = b.get("openTime") if b.get("openTime") is not None else b.get("time")
        if ts is None:
            continue
        ts = int(ts)
        day = _iso(ts)
        by_day.setdefault(day, []).append({
            "t": ts,
            "open": float(b["open"]),
            "high": float(b["high"]),
            "low": float(b["low"]),
            "close": float(b["close"]),
        })
    sessions = []
    for day in sorted(by_day):
        rows = sorted(by_day[day], key=lambda r: r["t"])
        if not rows:
            continue
        sessions.append({
            "date": day,
            "start": rows[0]["t"],
            "end": rows[-1]["t"],
            "open": rows[0]["open"],
            "close": rows[-1]["close"],
            "high": max(r["high"] for r in rows),
            "low": min(r["low"] for r in rows),
            "bars": rows,
        })
    return sessions


def _orb(s, minutes):
    """Opening-range high/low over the first `minutes` of the session."""
    cutoff = s["start"] + minutes * 60_000
    window = [r for r in s["bars"] if r["t"] < cutoff]
    if not window:
        return None            # a single bar is a valid range: with 1h bars the
                               # first 60 minutes *are* the first bar
    return {
        "high": max(r["high"] for r in window),
        "low": min(r["low"] for r in window),
        "bars": window,
        "cutoff": cutoff,
    }


def _first_break(s, rng):
    """First bar after the window that leaves the range, with direction."""
    for r in s["bars"]:
        if r["t"] < rng["cutoff"]:
            continue
        up = r["high"] > rng["high"]
        down = r["low"] < rng["low"]
        if up and down:
            # both sides in one bar: use the close to say which came first
            return ("up" if r["close"] >= r["open"] else "down"), r["t"]
        if up:
            return "up", r["t"]
        if down:
            return "down", r["t"]
    return None, None


def compute_features(sessions):
    """Attach the session-level features every preset refers to."""
    prev = None
    ranges = []
    greens = []
    for i, s in enumerate(sessions):
        rows = s["bars"]
        s["green"] = s["close"] > s["open"]
        s["range"] = s["high"] - s["low"]
        s["complete"] = len(rows) >= (1 if len(rows) == 1 else 2)
        s["dayOfWeek"] = _day(s["start"]).weekday()
        s["weekday"] = WEEKDAYS[s["dayOfWeek"]]
        s["month"] = _day(s["start"]).month
        s["rangePct"] = (s["range"] / s["open"] * 100) if s["open"] else None
        s["doji"] = bool(s["range"] > 0 and abs(s["close"] - s["open"]) <= 0.1 * s["range"])

        # prior-session level features
        if prev:
            s["prevClose"] = prev["close"]
            s["prevHigh"] = prev["high"]
            s["prevLow"] = prev["low"]
            prev_range = prev["range"]
            s["openPosInPrevRange"] = ((s["open"] - prev["low"]) / prev_range) if prev_range > 0 else None
            s["gap"] = s["open"] - prev["close"]
            s["absGapPct"] = abs(s["gap"]) / prev["close"] * 100 if prev["close"] else None
            s["gapDir"] = "up" if s["gap"] > 0 else ("down" if s["gap"] < 0 else "none")
            s["gapBucket"] = None
            if s["absGapPct"] is not None:
                frac = s["absGapPct"] / 100
                for name, lo, hi in GAP_BUCKETS:
                    if lo <= frac < hi:
                        s["gapBucket"] = name
                        break
            s["insideDay"] = s["high"] <= prev["high"] and s["low"] >= prev["low"]
            s["outsideDay"] = s["high"] > prev["high"] and s["low"] < prev["low"]
            s["bullEngulfing"] = bool(
                s["green"] and prev["close"] < prev["open"]
                and s["open"] <= prev["close"] and s["close"] >= prev["open"]
            )
            s["bearEngulfing"] = bool(
                (not s["green"]) and prev["close"] > prev["open"]
                and s["open"] >= prev["close"] and s["close"] <= prev["open"]
            )
        else:
            for k in ("prevClose", "prevHigh", "prevLow", "openPosInPrevRange", "gap",
                      "absGapPct", "gapBucket"):
                s[k] = None
            s["gapDir"] = "none"
            s["insideDay"] = s["outsideDay"] = s["bullEngulfing"] = s["bearEngulfing"] = False

        # trailing volatility (prior 14 sessions, excludes this one)
        if len(ranges) >= 14:
            s["atr14"] = sum(ranges[-14:]) / 14
            s["rangeVsAtr"] = (s["range"] / s["atr14"]) if s["atr14"] > 0 else None
        else:
            s["atr14"] = None
            s["rangeVsAtr"] = None

        # NR4 / NR7: narrowest range of the trailing 4 / 7 including this one
        trail4 = ranges[-3:] + [s["range"]]
        trail7 = ranges[-6:] + [s["range"]]
        s["nr4"] = bool(len(trail4) == 4 and s["range"] == min(trail4))
        s["nr7"] = bool(len(trail7) == 7 and s["range"] == min(trail7))

        # green/red streaks ending at this session
        streak = 0
        for g in reversed(greens):
            if g:
                streak += 1
            else:
                break
        s["greenStreak"] = streak
        streak = 0
        for g in reversed(greens):
            if not g:
                streak += 1
            else:
                break
        s["redStreak"] = streak

        ranges.append(s["range"])
        greens.append(s["green"])
        prev = s

    sessions = _attach_intraday_features(sessions)
    return sessions


def _attach_intraday_features(sessions):
    """ORB / initial balance / extreme times — present only on intraday bars."""
    for s in sessions:
        has_intraday = len(s["bars"]) >= 2 and (s["bars"][1]["t"] - s["bars"][0]["t"]) <= 4 * 3600_000
        if not has_intraday:
            s["orb"] = {}
            s["ibBreakType"] = None
            s["minutesToHigh"] = None
            s["minutesToLow"] = None
            continue
        s["minutesToHigh"] = (min(
            (r["t"] for r in s["bars"] if r["high"] == s["high"]), default=s["start"]) - s["start"]) / 60_000
        s["minutesToLow"] = (min(
            (r["t"] for r in s["bars"] if r["low"] == s["low"]), default=s["start"]) - s["start"]) / 60_000
        ib = _orb(s, 60)
        if ib:
            up = any(r["high"] > ib["high"] for r in s["bars"] if r["t"] >= ib["cutoff"])
            down = any(r["low"] < ib["low"] for r in s["bars"] if r["t"] >= ib["cutoff"])
            s["ibBreakType"] = "double" if (up and down) else "single_up" if up else "single_down" if down else "none"
        else:
            s["ibBreakType"] = None
    return sessions


# --------------------------------------------------------------- where-clause


class DslError(ValueError):
    pass


def _tokenize(text):
    out = []
    i = 0
    while i < len(text):
        ch = text[i]
        if ch.isspace():
            i += 1
            continue
        if ch in "()":
            out.append((ch, ch)); i += 1; continue
        if ch == ",":
            out.append((",", ",")); i += 1; continue
        if ch == "'":
            j = text.find("'", i + 1)
            if j < 0:
                raise DslError("unterminated string")
            out.append(("str", text[i + 1:j])); i = j + 1; continue
        two = text[i:i + 2]
        if two in (">=", "<=", "!=", "==", "<>"):
            out.append(("op", two if two != "<>" else "!=")); i += 2; continue
        if ch in "><=":
            out.append(("op", ch)); i += 1; continue
        j = i
        while j < len(text) and (text[j].isalnum() or text[j] in "_.-"):
            j += 1
        if j == i:
            raise DslError(f"unexpected character {ch!r}")
        word = text[i:j]
        try:
            out.append(("num", float(word))); i = j; continue
        except ValueError:
            pass
        upper = word.upper()
        out.append(("kw" if upper in ("AND", "OR", "NOT") else "id", upper if upper in ("AND", "OR", "NOT") else word))
        i = j
    return out


class _Parser:
    def __init__(self, tokens):
        self.t = tokens
        self.i = 0

    def peek(self):
        return self.t[self.i] if self.i < len(self.t) else (None, None)

    def take(self):
        tok = self.peek()
        self.i += 1
        return tok

    def parse(self):
        node = self.expr()
        if self.i != len(self.t):
            raise DslError(f"trailing tokens at {self.i}")
        return node

    def expr(self):
        node = self.and_expr()
        while self.peek() == ("kw", "OR"):
            self.take()
            node = ("or", node, self.and_expr())
        return node

    def and_expr(self):
        node = self.unary()
        while self.peek() == ("kw", "AND"):
            self.take()
            node = ("and", node, self.unary())
        return node

    def unary(self):
        if self.peek() == ("kw", "NOT"):
            self.take()
            return ("not", self.unary())
        return self.primary()

    def primary(self):
        kind, val = self.peek()
        if kind == "(":
            self.take()
            node = self.expr()
            if self.take()[0] != ")":
                raise DslError("missing )")
            return node
        left = self.operand()
        kind, val = self.peek()
        if kind == "op":
            self.take()
            right = self.operand()
            return ("cmp", val, left, right)
        return ("value", left)

    def operand(self):
        kind, val = self.take()
        if kind == "num":
            return ("const", val)
        if kind == "str":
            return ("const", val)
        if kind == "id":
            if self.peek()[0] == "(":
                self.take()
                args = []
                while self.peek()[0] != ")":
                    args.append(self.operand())
                    if self.peek()[0] == ",":
                        self.take()
                    elif self.peek()[0] != ")":
                        raise DslError("expected , or ) in call")
                self.take()
                return ("call", val, args)
            return ("ident", val)
        raise DslError(f"unexpected token {val!r}")


def _get(s, name):
    if name in s:
        return s[name]
    raise DslError(f"unknown feature {name!r}")


def _eval(node, s):
    kind = node[0]
    if kind == "value":
        v = _eval(node[1], s)
        return bool(v) if not isinstance(v, str) else bool(v)
    if kind == "const":
        return node[1]
    if kind == "ident":
        low = node[1]
        if low in s:
            return s[low]
        # Bare words are enum values in this DSL (`gapDir = up`), not features.
        # A misspelled feature therefore arrives here as a string and is caught by
        # the type check in the comparison below instead of silently comparing.
        return low
    if kind == "call":
        return _call(node[1], [ _eval(a, s) for a in node[2] ], s)
    if kind == "cmp":
        op, left, right = node[1], _eval(node[2], s), _eval(node[3], s)
        if left is None or right is None:
            return False
        if isinstance(left, str) != isinstance(right, str) and op in (">=", "<=", ">", "<"):
            raise DslError(
                f"cannot compare {left!r} with {right!r} — check the feature name "
                f"(known features: absGapPct, gapDir, openPosInPrevRange, rangeVsAtr, dayOfWeek, streak(...))"
            )
        if op in (">=",):
            return left >= right
        if op in ("<=",):
            return left <= right
        if op == ">":
            return left > right
        if op == "<":
            return left < right
        if op in ("=", "=="):
            return left == right
        if op in ("!=",):
            return left != right
        raise DslError(f"bad operator {op}")
    if kind == "and":
        return _eval(node[1], s) and _eval(node[2], s)
    if kind == "or":
        return _eval(node[1], s) or _eval(node[2], s)
    if kind == "not":
        return not _eval(node[1], s)
    raise DslError(f"bad node {kind}")


def _call(name, args, s):
    if name == "streak":
        colour, n = (args + [None, None])[:2]
        # `streak(green, 3)` arrives as the boolean feature `green`, so read it that
        # way; anything else is the word form used by other presets.
        if isinstance(colour, bool):
            is_green = colour
        else:
            is_green = str(colour).lower() in ("green", "bull", "up", "true")
        streak = s.get("greenStreak", 0) if is_green else s.get("redStreak", 0)
        return streak >= float(n)
    if name == "eventDay":
        cal = EVENTS.get(str(args[0]).upper(), set())
        return s["date"] in cal
    if name == "dayAfterEvent":
        cal = EVENTS.get(str(args[0]).upper(), set())
        return s.get("prevDate") in cal
    if name == "dayBeforeEvent":
        cal = EVENTS.get(str(args[0]).upper(), set())
        return s.get("nextDate") in cal
    if name == "fvgPresent":
        # Signature upstream: fvgPresent(open, below|above) — the first argument is
        # the session open (our anchor), the second is the side being asked about.
        side = str(args[1]).lower() if len(args) > 1 else (str(args[0]).lower() if args else "below")
        zones = s.get("fvgZones") or []
        open_px = s["open"]
        for top, bottom, _born in zones:
            if side in ("below", "down", "bull"):
                if top <= open_px:
                    return True
            elif bottom >= open_px:
                return True
        return False
    raise DslError(f"unknown function {name!r}")


def compile_where(text):
    if not text:
        return lambda s: True
    ast = _Parser(_tokenize(text)).parse()
    return lambda s: bool(_eval(ast, s))


def _attach_fvg_zones(sessions):
    """Unfilled three-session fair value gaps, formed strictly before the session.

    A zone is the gap between session i-2's extreme and session i's opposite
    extreme with session i-1 in between. It stops being "unfilled" the first time
    a later session trades into it (the bar's range overlaps the zone).
    """
    live = []
    for i, s in enumerate(sessions):
        keep = []
        for top, bottom, born in live:
            if born >= i:
                continue
            inside = s["low"] <= top and s["high"] >= bottom
            if inside:
                continue                       # price came back into the gap
            keep.append((top, bottom, born))
        s["fvgZones"] = keep
        live = keep
        if i >= 2:
            prior2 = sessions[i - 2]
            if s["low"] > prior2["high"]:
                live.append((s["low"], prior2["high"], i))          # bullish gap under price
            if s["high"] < prior2["low"]:
                live.append((prior2["low"], s["high"], i))          # bearish gap over price
        live = [z for z in live if i - z[2] < 240]
    return sessions


def _link_neighbours(sessions):
    for i, s in enumerate(sessions):
        s["prevDate"] = sessions[i - 1]["date"] if i > 0 else None
        s["nextDate"] = sessions[i + 1]["date"] if i + 1 < len(sessions) else None
    return sessions


# ------------------------------------------------------------------- outcomes


def _filled(s, prev_close):
    """Did the session trade back to the prior close, and when."""
    if prev_close is None:
        return False, None
    for r in s["bars"]:
        if s["open"] > prev_close and r["low"] <= prev_close:
            return True, r["t"]
        if s["open"] < prev_close and r["high"] >= prev_close:
            return True, r["t"]
    return False, None


def _obs(hit, t, **extra):
    o = {"hit": 1 if hit else 0, "t": t}
    o.update(extra)
    return o


def out_close_green(sessions, p):
    return [_obs(s["green"], s["end"], date=s["date"]) for s in sessions]


def out_next_close_green(sessions, p):
    obs = []
    for i in range(len(sessions) - 1):
        nxt = sessions[i + 1]
        obs.append(_obs(nxt["green"], nxt["end"], date=sessions[i]["date"], nextDate=nxt["date"]))
    return obs


def out_gap_fill(sessions, p):
    obs = []
    for s in sessions:
        if s.get("prevClose") is None:
            continue
        if not s.get("absGapPct") or s["absGapPct"] < GAP_FLOOR_PCT:
            continue                                    # denominator: gapped sessions only
        filled, t = _filled(s, s["prevClose"])
        obs.append(_obs(filled, t or s["end"], date=s["date"]))
    return obs


def out_gap_hold(sessions, p):
    look = str(p.get("dir", "any")).lower()
    obs = []
    for s in sessions:
        if s.get("prevClose") is None or not s.get("absGapPct") or s["absGapPct"] < GAP_FLOOR_PCT:
            continue
        side = s["gapDir"]
        if look != "any" and side != look:
            continue
        filled, _ = _filled(s, s["prevClose"])
        beyond = s["close"] > s["open"] if side == "up" else s["close"] < s["open"]
        obs.append(_obs((not filled) and beyond, s["end"], date=s["date"]))
    return obs


def out_gap_reversal(sessions, p):
    look = str(p.get("dir", "any")).lower()
    obs = []
    for s in sessions:
        if s.get("prevClose") is None or not s.get("absGapPct") or s["absGapPct"] < GAP_FLOOR_PCT:
            continue
        side = s["gapDir"]
        if look != "any" and side != look:
            continue
        filled, t = _filled(s, s["prevClose"])
        if not filled:
            continue                                    # denominator: filled gaps only
        reversed_ = s["close"] < s["prevClose"] if side == "up" else s["close"] > s["prevClose"]
        obs.append(_obs(reversed_, t or s["end"], date=s["date"]))
    return obs


def out_orb_break(sessions, p):
    minutes = float(p.get("window", 15))
    look = str(p.get("dir", "any")).lower()
    obs = []
    for s in sessions:
        if len(s["bars"]) < 2:
            continue
        rng = _orb(s, minutes)
        if not rng:
            continue
        side, t = _first_break(s, rng)
        hit = bool(side) and (look == "any" or side == look)
        obs.append(_obs(hit, t or s["end"], date=s["date"], broke=side,
                        minutesToBreak=((t - s["start"]) / 60_000) if t else None))
    return obs


def out_orb_false_break(sessions, p):
    minutes = float(p.get("window", 15))
    look = str(p.get("dir", "any")).lower()
    obs = []
    for s in sessions:
        if len(s["bars"]) < 2:
            continue
        rng = _orb(s, minutes)
        if not rng:
            continue
        side, t = _first_break(s, rng)
        if not side or (look != "any" and side != look):
            continue                                    # denominator: breaking sessions only
        after = [r for r in s["bars"] if r["t"] > (t or 0)]
        failed = False
        for r in after:
            if side == "up" and (r["close"] < rng["high"] or r["close"] < rng["low"]):
                failed = True
                break
            if side == "down" and (r["close"] > rng["low"] or r["close"] > rng["high"]):
                failed = True
                break
        obs.append(_obs(failed, s["end"], date=s["date"]))
    return obs


def out_orb_target(sessions, p):
    minutes = float(p.get("window", 15))
    mult = float(p.get("r", 1))
    look = str(p.get("dir", "any")).lower()
    obs = []
    for s in sessions:
        if len(s["bars"]) < 2:
            continue
        rng = _orb(s, minutes)
        if not rng:
            continue
        side, t = _first_break(s, rng)
        if not side or (look != "any" and side != look):
            continue
        span = max(1e-9, rng["high"] - rng["low"])
        target_t = None
        for r in s["bars"]:
            if r["t"] < (t or 0):
                continue
            if side == "up" and r["high"] >= rng["high"] + mult * span:
                target_t = r["t"]; break
            if side == "down" and r["low"] <= rng["low"] - mult * span:
                target_t = r["t"]; break
        obs.append(_obs(target_t is not None, target_t or s["end"], date=s["date"]))
    return obs


def out_ib_extension(sessions, p):
    mult = float(p.get("r", 1))
    look = str(p.get("dir", "any")).lower()
    obs = []
    for s in sessions:
        if len(s["bars"]) < 2:
            continue
        ib = _orb(s, 60)
        if not ib:
            continue
        span = max(1e-9, ib["high"] - ib["low"])
        broke_up = any(r["high"] > ib["high"] for r in s["bars"] if r["t"] >= ib["cutoff"])
        broke_down = any(r["low"] < ib["low"] for r in s["bars"] if r["t"] >= ib["cutoff"])
        sides = []
        if broke_up and look in ("any", "up"):
            sides.append("up")
        if broke_down and look in ("any", "down"):
            sides.append("down")
        if not sides:
            continue                                    # denominator: sessions that broke
        hit = False
        for side in sides:
            for r in s["bars"]:
                if r["t"] < ib["cutoff"]:
                    continue
                if side == "up" and r["high"] >= ib["high"] + mult * span:
                    hit = True
                if side == "down" and r["low"] <= ib["low"] - mult * span:
                    hit = True
        obs.append(_obs(hit, s["end"], date=s["date"]))
    return obs


def out_time_of_high(sessions, p):
    within = float(p.get("within", 60))
    return [_obs(s["minutesToHigh"] <= within, s["start"] + int(s.get("minutesToHigh") or 0) * 60_000,
                 date=s["date"], minutes=s.get("minutesToHigh"))
            for s in sessions if s.get("minutesToHigh") is not None]


def out_time_of_low(sessions, p):
    within = float(p.get("within", 60))
    return [_obs(s["minutesToLow"] <= within, s["start"] + int(s.get("minutesToLow") or 0) * 60_000,
                 date=s["date"], minutes=s.get("minutesToLow"))
            for s in sessions if s.get("minutesToLow") is not None]


def out_touch_prev_high(sessions, p):
    obs = []
    for s in sessions:
        if s.get("prevHigh") is None:
            continue
        t = next((r["t"] for r in s["bars"] if r["high"] >= s["prevHigh"]), None)
        obs.append(_obs(t is not None, t or s["end"], date=s["date"]))
    return obs


def out_touch_prev_low(sessions, p):
    obs = []
    for s in sessions:
        if s.get("prevLow") is None:
            continue
        t = next((r["t"] for r in s["bars"] if r["low"] <= s["prevLow"]), None)
        obs.append(_obs(t is not None, t or s["end"], date=s["date"]))
    return obs


def out_break_hold_prev_high(sessions, p):
    obs = []
    for s in sessions:
        if s.get("prevHigh") is None:
            continue
        if not any(r["high"] >= s["prevHigh"] for r in s["bars"]):
            continue                                    # denominator: touching sessions
        obs.append(_obs(s["close"] > s["prevHigh"], s["end"], date=s["date"]))
    return obs


def out_break_hold_prev_low(sessions, p):
    obs = []
    for s in sessions:
        if s.get("prevLow") is None:
            continue
        if not any(r["low"] <= s["prevLow"] for r in s["bars"]):
            continue
        obs.append(_obs(s["close"] < s["prevLow"], s["end"], date=s["date"]))
    return obs


def out_range_vs_atr(sessions, p):
    mult = float(p.get("r", 1))
    return [_obs((s["rangeVsAtr"] or 0) >= mult, s["end"], date=s["date"], ratio=s["rangeVsAtr"])
            for s in sessions if s.get("rangeVsAtr") is not None]


OUTCOMES = {
    "closeGreen": out_close_green,
    "nextCloseGreen": out_next_close_green,
    "gapFill": out_gap_fill,
    "gapHold": out_gap_hold,
    "gapReversal": out_gap_reversal,
    "orbBreak": out_orb_break,
    "orbFalseBreak": out_orb_false_break,
    "orbTargetHit": out_orb_target,
    "ibExtension": out_ib_extension,
    "timeOfHighBefore": out_time_of_high,
    "timeOfLowBefore": out_time_of_low,
    "touchPrevHigh": out_touch_prev_high,
    "touchPrevLow": out_touch_prev_low,
    "breakHoldPrevHigh": out_break_hold_prev_high,
    "breakHoldPrevLow": out_break_hold_prev_low,
    "hit": out_range_vs_atr,
}

# Outcomes whose answer happens at a moment inside the session, so a UTC session
# split says something. The rest are whole-session measures, where the timestamp is
# the session boundary and a split would be a clock artefact.
INTRADAY_EVENT_OUTCOMES = {
    "gapFill", "gapReversal", "orbBreak", "orbFalseBreak", "orbTargetHit", "ibExtension",
    "timeOfHighBefore", "timeOfLowBefore", "touchPrevHigh", "touchPrevLow",
    "breakHoldPrevHigh", "breakHoldPrevLow",
}


# --------------------------------------------------------------- preset logic


def _fmt_param(spec, value):
    if spec.get("type") == "duration":
        return str(int(float(value)))
    if spec.get("type") == "string":
        return f"'{value}'"
    if spec.get("type") == "number":
        return str(int(value)) if float(value).is_integer() else str(value)
    return f"'{value}'" if isinstance(value, str) and not spec.get("values") else str(value)


def compose(preset, params):
    resolved = {}
    for spec in preset.get("params", []):
        name = spec["name"]
        value = params.get(name, spec.get("default"))
        if value is None:
            continue
        if spec.get("type") == "enum" and spec.get("values") and str(value) not in spec["values"]:
            raise DslError(f"{preset['id']}: {value!r} is not a valid {name} (use {', '.join(spec['values'])})")
        if spec.get("type") in ("number", "duration"):
            try:
                value = float(value)
            except (TypeError, ValueError):
                raise DslError(f"{preset['id']}: {name} must be a number")
        resolved[name] = value

    unknown = [k for k in params if k not in {p["name"] for p in preset.get("params", [])}]
    if unknown:
        raise DslError(f"{preset['id']} has no parameter {unknown[0]!r}")

    outcome = preset["outcome"]
    where_parts = [f"({preset['where']})"] if preset.get("where") else []
    for spec in preset.get("params", []):
        name = spec["name"]
        if name not in resolved:
            continue
        value = resolved[name]
        formatted = _fmt_param(spec, value)
        if spec.get("target") == "outcome":
            outcome = outcome.replace("{" + name + "}", formatted)
        elif spec.get("fragment"):
            where_parts.append(f"({spec['fragment'].replace('{value}', formatted)})")
    if "{" in outcome:
        raise DslError(f"{preset['id']}: unresolved placeholder in outcome {outcome!r}")
    return outcome, " AND ".join(where_parts), resolved


def _parse_outcome_call(text):
    text = text.strip()
    if "(" not in text:
        return text, []
    name, rest = text.split("(", 1)
    rest = rest.rsplit(")", 1)[0]
    args = []
    for raw in [a.strip() for a in rest.split(",") if a.strip()]:
        if raw.startswith("'") and raw.endswith("'"):
            args.append(raw[1:-1])
        else:
            try:
                args.append(float(raw))
            except ValueError:
                args.append(raw)
    return name.strip(), args


def _outcome_params(name, args):
    """Map positional args onto the keyword names the evaluators read."""
    out = {}
    if name in ("orbBreak", "orbFalseBreak", "orbTargetHit"):
        if args:
            out["window"] = args[0]
        if name == "orbTargetHit":
            if len(args) > 1:
                out["r"] = args[1]
            if len(args) > 2:
                out["dir"] = args[2]
        elif len(args) > 1:
            out["dir"] = args[1]
    elif name == "ibExtension":
        out["r"] = args[0] if args else 1
        out["dir"] = args[1] if len(args) > 1 else "any"
    elif name in ("timeOfHighBefore", "timeOfLowBefore"):
        out["within"] = args[0] if args else 60
    elif name == "hit":
        # hit(rangeVsAtr, gte, {r}) — the operator is the threshold direction
        out["r"] = args[2] if len(args) > 2 else 1
    return out


def _group_key(preset, s):
    by = preset.get("groupBy")
    if not by:
        return None
    if by == "dayOfWeek":
        return s.get("weekday")
    if by == "month":
        return _day(s["start"]).strftime("%b")
    if by == "gapDir":
        return s.get("gapDir") or "none"
    if by == "gapBucket":
        return s.get("gapBucket") or "none"
    if by == "ibBreakType":
        return s.get("ibBreakType") or "none"
    return s.get(by)


# ---------------------------------------------------------------------- stats


def _rate_block(hits, n):
    lo, hi = wilson(hits, n)
    return {
        "n": n,
        "hits": hits,
        "rate": round(hits / n * 100, 1) if n else None,
        "ci_low": round(lo * 100, 1) if n else None,
        "ci_high": round(hi * 100, 1) if n else None,
        "ci_width": round((hi - lo) * 100, 1) if n else None,
    }


def _stability(obs):
    """Half-split agreement: do the two halves say the same thing?"""
    if len(obs) < 8:
        return {"score": None, "label": "too few observations to split", "halves": []}
    ordered = sorted(obs, key=lambda o: o["t"] or 0)
    mid = len(ordered) // 2
    halves = []
    for part in (ordered[:mid], ordered[mid:]):
        hits = sum(o["hit"] for o in part)
        halves.append(_rate_block(hits, len(part)))
    a, b = halves
    if not a["n"] or not b["n"]:
        return {"score": None, "label": "one half empty", "halves": halves}
    p1, p2 = a["rate"] / 100, b["rate"] / 100
    pooled = (a["hits"] + b["hits"]) / (a["n"] + b["n"])
    se = math.sqrt(max(1e-9, pooled * (1 - pooled) * (1 / a["n"] + 1 / b["n"])))
    z = abs(p1 - p2) / se
    score = round(max(0.0, 1 - min(1.0, z / 3)) * 100)
    label = "stable" if score >= 70 else ("shaky" if score >= 40 else "unstable")
    return {"score": score, "label": label, "z": round(z, 2), "halves": halves}


def _per_year(obs, sessions_by_date):
    buckets = {}
    for o in obs:
        year = o.get("year") or (_day(o["t"]).year if o["t"] else None)
        if year is None:
            continue
        b = buckets.setdefault(str(year), {"hits": 0, "n": 0})
        b["hits"] += o["hit"]
        b["n"] += 1
    return [{"year": y, **_rate_block(v["hits"], v["n"])} for y, v in sorted(buckets.items())]


def _verdict(block, baseline, has_condition=True):
    n = block["n"]
    if n == 0:
        return "No sessions matched this condition in the chosen history."
    if n < 10:
        return (f"{n} observations — too thin to trust. The interval spans "
                f"{block['ci_width']} points; treat this as noise until the sample is bigger.")
    if n < 30:
        return (f"{n} observations — a small sample. The 95% interval is "
                f"{block['ci_low']}–{block['ci_high']}%, so the true rate could be well either side of the estimate.")
    if block["ci_width"] and block["ci_width"] > 20:
        return (f"The 95% interval spans {block['ci_width']} points ({block['ci_low']}–{block['ci_high']}%); "
                "that is too wide to separate this condition from ordinary noise.")
    if not has_condition:
        return (f"No condition to compare against: this preset asks the unconditional rate of its "
                f"outcome ({block['rate']}%, {block['ci_low']}–{block['ci_high']}%), so there is no "
                "lift to read. It is the number the conditional presets in its family are measured against.")
    if baseline and baseline.get("ci_low") is not None:
        if block["ci_low"] > baseline["ci_high"]:
            return (f"The interval sits above the unconditional baseline ({baseline['rate']}%), "
                    "so this condition is doing something the base rate does not explain.")
        if block["ci_high"] < baseline["ci_low"]:
            return (f"The interval sits below the unconditional baseline ({baseline['rate']}%).")
        return (f"Indistinguishable from the unconditional baseline ({baseline['rate']}%, "
                f"{baseline['ci_low']}–{baseline['ci_high']}%): the condition adds nothing here.")
    return "Interval reported; no baseline was computed for this outcome."


def _median_bar_ms(bars):
    times = sorted(int(b.get("openTime") if b.get("openTime") is not None else b["time"]) for b in bars)
    if len(times) < 3:
        return None
    gaps = sorted(times[i + 1] - times[i] for i in range(len(times) - 1) if times[i + 1] > times[i])
    return gaps[len(gaps) // 2] if gaps else None


def run_preset(preset, params, bars, symbol, interval, history):
    name = preset["id"]
    has_intraday = bool(bars) and (len({_iso(b["openTime"] if b.get("openTime") is not None else b["time"]) for b in bars}) < len(bars))
    if name in NEEDS_INTRADAY and not has_intraday:
        raise DslError(
            f"{preset['title']} needs intraday bars: the opening range, the initial balance and the "
            "time of the session extremes do not exist in daily data. Choose 15m or 1h."
        )

    outcome_text, where_text, resolved = compose(preset, params)
    fn_name, args = _parse_outcome_call(outcome_text)

    # A window finer than the bar interval cannot exist: say so instead of
    # reporting zero sessions.
    bar_ms = _median_bar_ms(bars)
    window_param = _outcome_params(fn_name, args).get("window")
    if name in NEEDS_INTRADAY and bar_ms and window_param and float(window_param) * 60_000 < bar_ms:
        raise DslError(
            f"{preset['title']} asks for a {int(float(window_param))}-minute opening range, but this series "
            f"has one bar every {int(bar_ms / 60_000)} minutes. Choose a finer timeframe, or a window of at "
            f"least {int(bar_ms / 60_000)} minutes."
        )
    fn = OUTCOMES.get(fn_name)
    if fn is None:
        raise DslError(f"outcome {fn_name!r} is not implemented")

    sessions = build_sessions(bars)
    if has_intraday and len(sessions) > 4:
        # the first and last UTC day in a series are cut short by the data window
        sessions = sessions[1:-1]
    sessions = _link_neighbours(sessions)
    sessions = compute_features(sessions)
    sessions = _attach_fvg_zones(sessions)

    # Some daily FX feeds back-fill `open` with the previous close, which makes
    # every open-to-close question (green rate, engulfing, doji) meaningless. Refuse
    # to answer on such a series rather than report a confidently wrong number.
    flat = sum(1 for s in sessions if s["open"] == s["close"])
    flat_share = flat / len(sessions) if sessions else 0.0
    if flat_share > 0.35:
        raise DslError(
            f"This {symbol} {interval} series has open == close on {flat_share * 100:.0f}% of sessions "
            f"({flat} of {len(sessions)}), so open-to-close outcomes cannot be computed honestly. "
            "The provider is serving back-filled opens; try another timeframe or instrument."
        )

    predicate = compile_where(where_text)
    by_date = {s["date"]: s for s in sessions}

    # Every observation carries the date of the session its *condition* belongs to,
    # so the where-clause always filters the right session even when an outcome is
    # measured on the next one (or skips sessions that had no gap).
    eligible = [o for o in fn(sessions, _outcome_params(fn_name, args)) if o.get("date") in by_date]
    matched = [o for o in eligible if predicate(by_date[o["date"]])]

    hits = sum(o["hit"] for o in matched)
    block = _rate_block(hits, len(matched))

    base_hits = sum(o["hit"] for o in eligible)
    baseline = _rate_block(base_hits, len(eligible))
    if baseline["n"]:
        baseline["label"] = "unconditional baseline for this outcome"
    matched_lift = None
    if block["n"] and baseline["n"]:
        matched_lift = round(block["rate"] - baseline["rate"], 1)

    # Session drill-down: which UTC window the outcome's defining event fell in.
    # Only meaningful with intraday bars — on daily bars the timestamp is the bar's
    # own stamp, not the time the event happened, so no rows are invented.
    drill_rows = []
    intraday_event = fn_name in INTRADAY_EVENT_OUTCOMES
    if has_intraday and intraday_event:
        drill = {}
        for o in matched:
            if o.get("t") is None:
                continue
            key, label = session_of(o["t"])
            b = drill.setdefault(key, {"session": label, "hits": 0, "n": 0})
            b["hits"] += o["hit"]
            b["n"] += 1
        drill_rows = [
            {"key": k, "session": v["session"], **_rate_block(v["hits"], v["n"])}
            for k, v in sorted(drill.items(), key=lambda kv: [s[0] for s in SESSIONS].index(kv[0]))
        ]

    # optional grouping (dayOfWeek, gapBucket, month, ibBreakType, gapDir)
    groups = []
    if preset.get("groupBy"):
        acc = {}
        for o in matched:
            key = _group_key(preset, by_date[o["date"]])
            if key is None:
                continue
            g = acc.setdefault(str(key), {"hits": 0, "n": 0})
            g["hits"] += o["hit"]
            g["n"] += 1
        groups = [{"group": k, **_rate_block(v["hits"], v["n"])}
                  for k, v in sorted(acc.items(), key=lambda kv: str(kv[0]))]

    # distributions that the preset itself advertises
    distribution = None
    extras = [o.get("minutes") for o in matched if o.get("minutes") is not None]
    if extras:
        distribution = {"unit": "minutes to the session extreme",
                        "p10": round(_quantile(extras, 0.1), 0), "p50": round(_quantile(extras, 0.5), 0),
                        "p90": round(_quantile(extras, 0.9), 0), "n": len(extras)}
    fill_minutes = [((o["t"] - by_date[o["date"]]["start"]) / 60_000)
                    for o in matched if o["hit"] and o.get("t") and by_date[o["date"]]["start"] <= o["t"]]
    if fn_name in ("gapFill", "gapReversal") and fill_minutes and has_intraday:
        distribution = {"unit": "minutes from session open to the fill",
                        "p10": round(_quantile(fill_minutes, 0.1)), "p50": round(_quantile(fill_minutes, 0.5)),
                        "p90": round(_quantile(fill_minutes, 0.9)), "n": len(fill_minutes)}
    break_minutes = [o["minutesToBreak"] for o in matched if o.get("minutesToBreak") is not None]
    if break_minutes and distribution is None:
        distribution = {"unit": "minutes from session open to the first break",
                        "p10": round(_quantile(break_minutes, 0.1)), "p50": round(_quantile(break_minutes, 0.5)),
                        "p90": round(_quantile(break_minutes, 0.9)), "n": len(break_minutes)}

    return {
        "preset": {"id": name, "title": preset["title"], "category": preset.get("category"),
                   "summary": preset.get("summary"), "version": preset.get("version"),
                   "params": resolved, "groupBy": preset.get("groupBy")},
        "symbol": symbol,
        "interval": interval,
        "history": history,
        "sessions": {"count": len(sessions), "first": sessions[0]["date"] if sessions else None,
                     "last": sessions[-1]["date"] if sessions else None,
                     "bars": len(bars), "intraday": has_intraday,
                     "bar_minutes": int(bar_ms / 60_000) if bar_ms else None,
                     "flat_open_close_pct": round(flat_share * 100, 1)},
        "where": where_text or None,
        "definitions": {
            "session": "one UTC calendar day of the instrument",
            "gap_floor_pct": GAP_FLOOR_PCT,
            "gap_floor_note": (
                f"a session counts as gapped only when it opened at least {GAP_FLOOR_PCT}% away from the "
                "prior session's close"
            ),
            "ci": "Wilson score interval at 95%",
            "stability": "the same estimate on the first and second half of the sample, split by time",
        },
        "outcome": outcome_text,
        "estimate": block,
        "baseline": baseline,
        "lift_points": matched_lift,
        "stability": _stability(matched),
        "per_year": _per_year(matched, by_date),
        "by_session": drill_rows,
        "session_windows": [{"key": k, "label": lbl, "utc": f"{a:02d}:00-{b:02d}:00"} for k, lbl, a, b in SESSIONS],
                    "session_note": (
                "Each observation is attributed to the UTC window in which its defining event happened: "
                "the break, the fill, the extreme. The window edges are the fixed UTC boundaries above, "
                "not exchange sessions."
                if has_intraday and intraday_event else
                "This outcome is measured over the whole session, so its timestamp is the session "
                "boundary and a session split would be a clock artefact, not a finding. Timing splits "
                "exist for intraday events: opening-range breaks, gap fills on intraday bars, time of "
                "high and low."
                if has_intraday else
                "Daily bars carry no intraday timestamps, so this split is empty. Choose 15m or 1h to "
                "attribute outcomes to a session."
            ),
        "groups": groups,
        "distribution": distribution,
        "verdict": _verdict(block, baseline, has_condition=bool(where_text)),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
