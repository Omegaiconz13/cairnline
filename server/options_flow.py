"""Options Flow — LSE Data 3.0 options chain and tape, turned into exposure and flow.

What this feed actually gives us (read from the live `/v3/options/chain` and
`/v3/options/flow` responses, 2026-11-17):

  * chain, per contract: strike, expiry, `dte`, type, last price, **today's
    volume**, today's premium, IV and the newest Greeks (delta, gamma, theta,
    vega), with the underlying price and the Greeks timestamp;
  * so the smile, the walls and a **repriced** gamma flip can be built from the
    chain itself — not just from the tape;
  * tape, per print: timestamp, price, size, dollar premium, IV and the Greeks
    of that minute, venue, and the underlying price at that moment.

What it does **not** give us: **open interest** and exchange condition codes.
That decides the honesty of every metric below:

  * **Gamma exposure** is weighted by today's traded volume, not open interest,
    and is labelled as such (`gex.basis = "chain_volume_today"`). It is a real
    computation over real numbers, just not the OI-based GEX a paid feed yields.
  * **The gamma flip** is the price nearest spot where net exposure crosses
    zero, re-derived by repricing every leg at each candidate price with
    Black-Scholes gamma. It is *not* the cumulative strike-sum crossing, which
    is reported separately as `flip_strike`. Same-day contracts are modelled at
    one day rather than dividing by zero, and the payload says so.
  * **Max pain** is likewise volume-weighted, labelled, and reported with the
    whole payout curve so the number can be checked.
  * **Sweep / block** classification is size- and time-based; the feed has no
    condition codes to read.
  * **Aggressor side** is unknown and reported as unknown, never guessed.

No synthetic prints, no sample rows, no invented notionals: when the provider
returns nothing, `build()` returns `available: False` with the reason.
"""

from __future__ import annotations

import math
import statistics
from datetime import datetime, timedelta, timezone

ENGINE = "cairnline-options-flow"
CONTRACT_MULTIPLIER = 100          # US equity options: 100 shares per contract
GEX_MOVE = 0.01                    # dealer gamma exposure per 1% move
BLOCK_SIZE = 50                    # contracts; a size convention, not a condition code
SWEEP_WINDOW_S = 120               # same contract, prints this close = one burst
FLIP_SPAN = 0.25                   # gamma flip searched within ±25% of spot
FLIP_STEP = 0.005                  # repricing grid: 0.5% of spot


def _num(v, default=None):
    try:
        if v is None or v == "":
            return default
        f = float(v)
        return f if math.isfinite(f) else default
    except (TypeError, ValueError):
        return default


def _iv_fraction(v):
    """IV as a decimal fraction; the feed mixes 1.28 and 128 for the same 128%."""
    iv = _num(v)
    if iv is None or iv <= 0:
        return None
    return iv / 100.0 if iv > 3 else iv


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _parse_ts(raw):
    if not raw:
        return None
    text = str(raw).strip().replace("Z", "+00:00")
    for parse in (datetime.fromisoformat,):
        try:
            dt = parse(text)
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def resolve_window(window: str) -> tuple[datetime, datetime, str]:
    """The tape is bounded to seven days by the provider, so a window is too."""
    now = datetime.now(timezone.utc)
    if window in ("1d", "today"):
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        return start, now, "today (UTC)"
    start = now - timedelta(days=6)
    return start, now, "last 7 days (UTC)"


def fetch_chain(client, underlying: str, *, limit: int = 1000, max_dte=None) -> dict:
    """One page of the live chain. Raises whatever the client raises."""
    kwargs = {"limit": limit}
    if max_dte is not None:
        kwargs["max_dte"] = int(max_dte)
    return client.options_chain(underlying, **kwargs)


def fetch_prints(client, underlying: str, start: datetime, end: datetime, *, limit: int = 1000,
                 min_premium=None, max_dte=None) -> list:
    kwargs = {
        "start": start.strftime("%Y-%m-%d"),
        "end": end.strftime("%Y-%m-%d"),
        "limit": limit,
    }
    if min_premium is not None:
        kwargs["min_premium"] = float(min_premium)
    if max_dte is not None:
        kwargs["max_dte"] = int(max_dte)
    rows = client.options_flow(underlying, **kwargs)
    return rows or []


def _chain_rows(chain: dict) -> list:
    return [r for r in (chain.get("rows") or chain.get("contracts") or []) if isinstance(r, dict)]


def _leg(strike, kind, weight, gamma, iv, dte) -> dict:
    return {"strike": strike, "kind": kind, "weight": weight, "gamma": gamma, "iv": iv, "dte": dte}


def exposure_legs(chain_rows: list, prints: list) -> tuple[list, str]:
    """The weighted legs exposure is built from, and the basis.

    Preference order, because the feed is uneven: the chain's `volume_today`
    when any contract actually reports it, otherwise the tape — every print
    carries its size and the Greeks of its minute. Both are real; the payload
    names which one was used rather than letting the reader assume open
    interest. IV and `dte` travel with each leg because the gamma flip has to
    reprice the leg at prices other than today's.
    """
    chain_legs = []
    for r in chain_rows:
        gamma = _num(r.get("gamma"))
        volume = _num(r.get("volume_today"), 0.0)
        strike = _num(r.get("strike"))
        kind = str(r.get("contract_type") or "").lower()
        if gamma is None or strike is None or not volume or kind not in ("call", "put"):
            continue
        iv = _iv_fraction(r.get("iv"))
        chain_legs.append(_leg(strike, kind, volume * CONTRACT_MULTIPLIER, gamma, iv, _num(r.get("dte"))))
    if chain_legs:
        return chain_legs, "chain_volume_today"

    tape_legs = []
    for p in prints:
        gamma = _num(p.get("gamma"))
        size = _num(p.get("size"), 0.0)
        strike = _num(p.get("strike"))
        kind = str(p.get("contract_type") or "").lower()
        if gamma is None or strike is None or not size or kind not in ("call", "put"):
            continue
        iv = _iv_fraction(p.get("iv"))
        tape_legs.append(_leg(strike, kind, size * CONTRACT_MULTIPLIER, gamma, iv, _num(p.get("dte"))))
    return tape_legs, "tape_contracts_traded"


def _zero_crossing(p0: float, v0: float, p1: float, v1: float):
    """Price where a segment between (p0, v0) and (p1, v1) crosses zero."""
    if not ((v0 < 0 <= v1) or (v0 > 0 >= v1)):
        return None
    span = v1 - v0
    return p0 if not span else p0 + (p1 - p0) * (-v0 / span)


def gamma_exposure(legs: list, spot: float, basis: str) -> dict:
    """Dealer gamma exposure per 1% move.

    Calls add, puts subtract (the dealer is short the calls sold into the flow
    and long the puts, the usual dealer-positioning convention). The weight is
    whatever `exposure_legs` found and named — never open interest, which this
    feed does not carry.
    """
    by_strike: dict[float, dict] = {}
    weighted_contracts = 0
    total = 0.0
    for leg in legs:
        strike, kind, weight, gamma = leg["strike"], leg["kind"], leg["weight"], leg["gamma"]
        signed = gamma * weight * spot * spot * GEX_MOVE
        if kind == "put":
            signed = -signed
        slot = by_strike.setdefault(strike, {"strike": strike, "call": 0.0, "put": 0.0, "volume": 0})
        slot[kind] += signed
        slot["volume"] += weight / CONTRACT_MULTIPLIER
        total += signed
        weighted_contracts += 1

    if not weighted_contracts:
        return {
            "available": False,
            "reason": "neither the chain volume nor the tape produced a weighted contract, so every strike would be zero",
            "basis": basis,
            "by_strike": [],
            "total_usd_per_pct": None,
            "flip_strike": None,
        }

    curve = sorted(by_strike.values(), key=lambda x: x["strike"])
    for row in curve:
        row["net"] = row["call"] + row["put"]
        row["call"] = round(row["call"], 2)
        row["put"] = round(row["put"], 2)
        row["net"] = round(row["net"], 2)

    # Gamma flip: the strike where cumulative exposure crosses zero.
    flip = None
    running = 0.0
    prev = None
    for row in curve:
        running += row["net"]
        if prev is not None:
            crossing = _zero_crossing(prev[0], prev[1], row["strike"], running)
            if crossing is not None:
                flip = round(crossing, 2)
                break
        prev = (row["strike"], running)

    near = min(curve, key=lambda x: abs(x["strike"] - spot)) if spot else None
    return {
        "available": True,
        "basis": basis,
        "unit": "USD of dealer gamma exposure per 1% move, calls positive, puts negative",
        "total_usd_per_pct": round(total, 2),
        "flip_strike": flip,
        "nearest_strike": near["strike"] if near else None,
        "nearest_net": near["net"] if near else None,
        "contracts": weighted_contracts,
        "by_strike": curve,
    }


def _bs_gamma(spot: float, strike: float, iv: float, dte) -> float | None:
    """Black-Scholes gamma (r=0, no dividend yield) at a candidate spot.

    `iv` is already a fraction here: `_iv_fraction` is the single place that
    normalises the feed's percent/fraction ambiguity. Missing or same-day `dte`
    is priced at one day, the smallest step that does not divide by zero.
    """
    if not spot or not strike or not iv or iv <= 0:
        return None
    days = dte if dte is not None and dte > 0 else 1.0
    t = days / 365.0
    try:
        d1 = (math.log(spot / strike) + 0.5 * iv * iv * t) / (iv * math.sqrt(t))
        return math.exp(-0.5 * d1 * d1) / math.sqrt(2 * math.pi) / (spot * iv * math.sqrt(t))
    except (ValueError, ZeroDivisionError):
        return None


def gamma_flip_level(legs: list, spot: float) -> dict:
    """The price nearest spot where net exposure crosses zero, repriced.

    Every candidate price re-computes each leg's gamma from its own IV and dte,
    then applies the same weight and sign as the exposure curve. The result is
    therefore a property of the board at that price, not the strike where a
    running cumulative sum happens to cross zero (that number stays available
    as `gex.flip_strike`).

    Every leg with an IV is repriced, including one whose `dte` is missing: that
    leg is priced at the one-day floor, so it counts in `legs_with_iv`. A leg
    without an IV holds today's quoted gamma instead, and `legs_with_iv`
    discloses how much of the board was actually repriced.
    """
    if not legs or not spot:
        return {"available": False, "reason": "no weighted legs and no spot to reprice"}
    if not any(leg.get("iv") for leg in legs):
        return {"available": False,
                "reason": "the feed supplied no implied volatility on any weighted leg, so the board cannot be repriced"}

    steps = max(1, int(round((2 * FLIP_SPAN) / FLIP_STEP)))
    step = (2 * FLIP_SPAN) / steps
    crossings = []
    prev = None
    for i in range(steps + 1):
        px = spot * (1 - FLIP_SPAN + i * step)
        net = 0.0
        for leg in legs:
            gamma = _bs_gamma(px, leg["strike"], leg["iv"], leg["dte"])
            if gamma is None:
                gamma = leg["gamma"] or 0.0
            signed = gamma * leg["weight"] * px * px * GEX_MOVE
            net += -signed if leg["kind"] == "put" else signed
        if prev is not None:
            crossing = _zero_crossing(prev[0], prev[1], px, net)
            if crossing is not None:
                crossings.append(round(crossing, 4))
        prev = (px, net)

    if not crossings:
        return {"available": False,
                "reason": f"net exposure does not cross zero inside ±{FLIP_SPAN:.0%} of spot on this board"}

    flip = min(crossings, key=lambda p: abs(p - spot))
    return {
        "available": True,
        "price": round(flip, 4),
        "distance_pct": round((flip - spot) / spot * 100, 2),
        "basis": "repriced board: Black-Scholes gamma (zero rate, no dividend yield) at each candidate price from each leg's IV and dte; IV held at its quoted level; weight is contracts traded",
        "model": {
            "span_pct": FLIP_SPAN * 100,
            "step_pct": round(step * 100, 4),
            "dte_rule": "same-day or missing dte priced at 1 day",
            "legs": len(legs),
            "legs_with_iv": sum(1 for leg in legs if leg.get("iv")),
        },
        "crossings": crossings,
    }


def walls(by_strike: list, spot: float) -> dict:
    """Largest call exposure above spot and largest put exposure below it."""
    if not by_strike or not spot:
        return {"available": False, "reason": "no exposure curve at a known spot"}
    calls = [row for row in by_strike if row["strike"] > spot and row["call"] > 0]
    puts = [row for row in by_strike if row["strike"] < spot and row["put"] < 0]

    def top(rows: list, key: str):
        if not rows:
            return None
        row = max(rows, key=lambda r: abs(r[key]))
        return {
            "strike": row["strike"],
            "exposure": round(row[key], 2),
            "distance_pct": round((row["strike"] - spot) / spot * 100, 2),
        }

    return {
        "available": bool(calls or puts),
        "call": top(calls, "call"),
        "put": top(puts, "put"),
        "basis": "largest call exposure above spot and largest put exposure below it, on the same traded-contract weights as the curve",
    }


def iv_smile(chain_rows: list, spot: float, max_expiries: int = 3, min_points: int = 4) -> dict:
    """IV by strike for the nearest expiries, out-of-the-money stitched.

    Puts are used below spot and calls above it, per expiry, so a wide bid/ask on
    the in-the-money side cannot distort the curve. The feed publishes no
    forward, so spot is the anchor and the payload says so.
    """
    if not spot:
        return {"available": False,
                "reason": "the chain came back without an underlying price to anchor the smile"}

    groups: dict[str, dict] = {}
    for row in chain_rows:
        iv = _iv_fraction(row.get("iv"))
        strike = _num(row.get("strike"))
        kind = str(row.get("contract_type") or "").lower()
        expiry = row.get("expiry")
        if iv is None or strike is None or not expiry or kind not in ("call", "put"):
            continue
        if iv >= 5:                            # 500% is beyond any usable smile point
            continue
        slot = groups.setdefault(str(expiry), {
            "expiry": str(expiry),
            "dte": _num(row.get("dte")),
            "points": {},
        })
        if strike <= spot and kind == "put":
            slot["points"][strike] = iv
        elif strike > spot and kind == "call":
            slot["points"][strike] = iv

    series = []
    for slot in groups.values():
        points = [{"strike": s, "iv": round(v * 100, 2)} for s, v in sorted(slot["points"].items())]
        if len(points) < min_points:
            continue
        nearest = min(points, key=lambda p: abs(p["strike"] - spot))
        series.append({
            "expiry": slot["expiry"],
            "dte": slot["dte"],
            "nearest_iv_pct": nearest["iv"],
            "points": points,
        })

    series.sort(key=lambda s: (s["dte"] is None, s["dte"] or 0, s["expiry"]))
    series = series[:max_expiries]
    if not series:
        return {"available": False,
                "reason": f"no expiry had at least {min_points} implied-volatility strikes to draw a smile"}
    return {
        "available": True,
        "expiries": series,
        "basis": "out-of-the-money stitch: puts below spot, calls above, per expiry; IV as a percentage. Nearest IV is the closest listed strike, not an interpolation at spot. Spot is the forward anchor because the feed publishes no forward, and only strikes with a published IV are drawn.",
    }


def max_pain(legs: list, basis: str) -> dict:
    """The strike where option holders' payout is smallest.

    Standard max pain weights by open interest; this feed has none. The weight
    is kept identical to the exposure legs so the two agree, and the basis says
    which weight it is.
    """
    if not legs:
        return {
            "available": False,
            "reason": "no weighted contract exists, so the payout curve has no weights",
            "basis": basis,
            "curve": [],
        }

    strikes = sorted({leg["strike"] for leg in legs})
    curve = []
    for candidate in strikes:
        payout = 0.0
        for leg in legs:
            strike, kind, weight = leg["strike"], leg["kind"], leg["weight"]
            if kind == "call" and candidate > strike:
                payout += (candidate - strike) * weight
            elif kind == "put" and candidate < strike:
                payout += (strike - candidate) * weight
        curve.append({"strike": candidate, "payout": round(payout, 2)})

    best = min(curve, key=lambda x: x["payout"])
    return {
        "available": True,
        "basis": basis,
        "strike": best["strike"],
        "payout": best["payout"],
        "curve": curve,
        "candidates": len(curve),
    }


def _classify(print_row: dict) -> str:
    size = _num(print_row.get("size"), 0) or 0
    return "block" if size >= BLOCK_SIZE else "print"


def whale(prints: list, chain_rows: list, spot) -> dict:
    """A large-print score with every input exposed.

    Components are each 0..1 and weighted; nothing is hidden behind the number.
    """
    if not prints:
        return {
            "available": False,
            "reason": "the tape returned no prints for this underlying and window",
            "score": None,
            "components": [],
        }

    notionals = [(_num(p.get("premium"), 0.0) or 0.0) for p in prints]
    total_premium = sum(notionals)
    largest = max(notionals)
    counts = len(prints)

    chain_ivs = [_num(r.get("iv")) for r in chain_rows]
    chain_ivs = [x for x in chain_ivs if x and 0 < x < 20]
    median_iv = statistics.median(chain_ivs) if chain_ivs else None

    short_dated_premium = 0.0
    for p, n in zip(prints, notionals):
        dte = _num(p.get("dte"))
        delta = abs(_num(p.get("delta"), 0.0) or 0.0)
        if dte is not None and dte <= 7 and delta <= 0.35:
            short_dated_premium += n

    top = None
    for p, n in zip(prints, notionals):
        if n == largest:
            top = p
            break

    # $10k -> 0, $100k -> 0.33, $1M -> 0.67, $10M -> 1
    size_factor = 0.0 if largest <= 10_000 else min(1.0, math.log10(largest / 10_000) / 3)
    breadth = min(1.0, counts / 500)
    concentration = (largest / total_premium) if total_premium else 0.0
    short_dated = (short_dated_premium / total_premium) if total_premium else 0.0
    iv_rich = 0.0
    top_iv = _num(top.get("iv")) if top else None
    if median_iv and top_iv:
        iv_rich = max(0.0, min(1.0, (top_iv / median_iv - 1.0)))

    weights = {"size": 0.40, "breadth": 0.15, "concentration": 0.15, "short_dated_lottery": 0.20, "iv_rich": 0.10}
    parts = {
        "size": size_factor,
        "breadth": breadth,
        "concentration": concentration,
        "short_dated_lottery": short_dated,
        "iv_rich": iv_rich,
    }
    score = round(100 * sum(weights[k] * parts[k] for k in weights), 1)
    label = "quiet" if score < 35 else "notable" if score < 60 else "large" if score < 80 else "whale"

    components = [
        {
            "key": "size",
            "weight": weights["size"],
            "value": round(size_factor, 3),
            "input": f"largest print ${largest:,.0f}",
            "meaning": "log-scaled notional of the single biggest print",
        },
        {
            "key": "breadth",
            "weight": weights["breadth"],
            "value": round(breadth, 3),
            "input": f"{counts} prints",
            "meaning": "how many prints the window holds (500 fills it)",
        },
        {
            "key": "concentration",
            "weight": weights["concentration"],
            "value": round(concentration, 3),
            "input": f"largest / total premium = ${largest:,.0f} / ${total_premium:,.0f}",
            "meaning": "share of the window's premium in one print",
        },
        {
            "key": "short_dated_lottery",
            "weight": weights["short_dated_lottery"],
            "value": round(short_dated, 3),
            "input": f"${short_dated_premium:,.0f} in dte ≤ 7 with |delta| ≤ 0.35",
            "meaning": "premium share in short-dated out-of-the-money contracts",
        },
        {
            "key": "iv_rich",
            "weight": weights["iv_rich"],
            "value": round(iv_rich, 3),
            "input": (f"biggest print IV {round(top_iv, 3)} vs chain median {round(median_iv, 3)}"
                      if median_iv and top_iv else "chain IV unavailable"),
            "meaning": "how far the biggest print's IV sits above the chain median",
        },
    ]

    return {
        "available": True,
        "score": score,
        "label": label,
        "components": components,
        "classification": "size- and time-based; this feed carries no exchange condition codes, so sweep vs block is a convention here",
        "aggressor": "unknown — the tape has no bid/ask, so the side that crossed is not observable",
        "top_print": {
            "ts": top.get("ts") if top else None,
            "ticker": top.get("ticker") if top else None,
            "type": top.get("contract_type") if top else None,
            "strike": top.get("strike") if top else None,
            "expiry": top.get("expiry") if top else None,
            "size": top.get("size") if top else None,
            "premium": round(largest, 2),
        },
    }


def _print_row(p: dict) -> dict:
    return {
        "ts": p.get("ts"),
        "ticker": p.get("ticker"),
        "type": p.get("contract_type"),
        "strike": _num(p.get("strike")),
        "expiry": p.get("expiry"),
        "dte": _num(p.get("dte")),
        "size": _num(p.get("size")),
        "price": _num(p.get("price")),
        "premium": round(_num(p.get("premium"), 0.0) or 0.0, 2),
        "iv": _num(p.get("iv")),
        "delta": _num(p.get("delta")),
        "gamma": _num(p.get("gamma")),
        "spot": _num(p.get("underlying_price")),
        "venue": p.get("venue"),
        "kind": _classify(p),
    }


def build(client, underlying: str, *, window: str = "7d", limit: int = 1000,
          min_premium=None, max_dte=None) -> dict:
    """The whole page payload, or an explicit unavailable state with its reason."""
    underlying = (underlying or "").upper().strip()
    generated = datetime.now(timezone.utc)
    if not underlying:
        return _unavailable("no underlying was requested", generated)

    try:
        chain = fetch_chain(client, underlying, limit=limit, max_dte=max_dte)
    except Exception as exc:  # noqa: BLE001
        text = str(exc)
        if "no listed options" in text.lower() or "[404]" in text:
            reason = f"the provider has no listed options for {underlying}"
        else:
            reason = f"the chain request failed: {type(exc).__name__}: {text[:200]}"
        payload = _unavailable(reason, generated)
        payload["detail"] = text[:300]
        return payload

    rows = _chain_rows(chain)
    spot = _num(chain.get("underlying_price"))
    if not rows or not spot:
        return _unavailable(
            f"the provider returned no listed contracts for {underlying}" if not rows
            else f"the chain came back without an underlying price for {underlying}",
            generated,
        )

    start, end, window_label = resolve_window(window)
    tape_error = None
    try:
        # The premium filter is applied *after* the tape is read: exposure must not
        # change just because the trader narrowed what the table shows. max_dte is a
        # real tape filter, so it is passed down.
        prints = fetch_prints(client, underlying, start, end, limit=limit, max_dte=max_dte)
    except Exception as exc:  # noqa: BLE001
        prints = []
        tape_error = f"{type(exc).__name__}: {str(exc)[:200]}"

    minp = _num(min_premium)
    scored = [p for p in prints if ((_num(p.get("premium"), 0.0) or 0.0) >= minp)] if minp else prints
    flow_rows = [_print_row(p) for p in scored]
    notionals = [r["premium"] for r in flow_rows]
    calls = [r for r in flow_rows if r["type"] == "call"]
    puts = [r for r in flow_rows if r["type"] == "put"]
    call_premium = sum(r["premium"] for r in calls)
    put_premium = sum(r["premium"] for r in puts)

    legs, basis = exposure_legs(rows, prints)
    gex = gamma_exposure(legs, spot, basis)
    flip = gamma_flip_level(legs, spot)
    walls_out = walls(gex.get("by_strike") or [], spot)
    smile = iv_smile(rows, spot)
    pain = max_pain(legs, basis)
    if pain.get("available") and spot:
        pain["distance_pct"] = round((pain["strike"] - spot) / spot * 100, 2)
        pain["underlying_price"] = spot
    whale_out = whale(scored, rows, spot)

    greeks_at = chain.get("greeks_as_of")
    as_of = greeks_at
    for r in flow_rows:
        ts = r.get("ts")
        if ts and (as_of is None or str(ts) > str(as_of)):
            as_of = ts

    expiries = sorted({str(r.get("expiry")) for r in rows if r.get("expiry")})

    unavailable = [
        {
            "metric": "open-interest gamma exposure",
            "reason": "this feed exposes no open interest (and its chain volume_today was zero for every contract), so exposure is weighted by contracts that actually traded in the window",
        },
        {
            "metric": "open-interest max pain",
            "reason": "no open interest in the feed; the payout curve uses the same traded-contract weights as the exposure curve",
        },
        {
            "metric": "sweep / block condition codes",
            "reason": "the tape has no exchange condition codes; block vs print is a size convention (≥ 50 contracts)",
        },
        {
            "metric": "aggressor side",
            "reason": "no bid/ask in the tape, so which side crossed the spread is not observable",
        },
    ]
    if tape_error:
        unavailable.append({"metric": "options tape", "reason": f"tape request failed: {tape_error}"})
    if not flip.get("available"):
        unavailable.append({"metric": "gamma flip", "reason": flip.get("reason") or "the board could not be repriced"})
    if not walls_out.get("available"):
        unavailable.append({"metric": "call / put walls", "reason": walls_out.get("reason") or "no exposure on either side of spot"})
    if not smile.get("available"):
        unavailable.append({"metric": "IV smile", "reason": smile.get("reason") or "no IV points to draw"})

    return {
        "available": True,
        "engine": ENGINE,
        "source": "lse-data",
        "feed": "us_options (LSE Data 3.0)",
        "underlying": underlying,
        "underlying_price": spot,
        "generated_at": _iso(generated),
        "as_of": str(as_of) if as_of else None,
        "window": {"start": _iso(start), "end": _iso(end), "label": window_label},
        "counts": {"contracts": len(rows), "prints": len(flow_rows), "expiries": len(expiries)},
        "filters": {
            "min_premium": minp,
            "max_dte": _num(max_dte),
            "applied_to": "the flow table and the whale score; exposure and max pain use every print the tape returned",
        },
        "expiries": expiries[:40],
        "flow": {
            "available": bool(flow_rows),
            "reason": None if flow_rows else (
                "the tape returned no prints for this underlying in the selected window"
                + (f" ({tape_error})" if tape_error else "")
            ),
            "total_premium": round(sum(notionals), 2),
            "call_premium": round(call_premium, 2),
            "put_premium": round(put_premium, 2),
            "put_call_ratio": (round(put_premium / call_premium, 3) if call_premium else None),
            "largest_premium": round(max(notionals), 2) if notionals else None,
            "median_premium": round(statistics.median(notionals), 2) if notionals else None,
            "prints": sorted(flow_rows, key=lambda r: r["premium"], reverse=True)[:40],
        },
        "gex": gex,
        "levels": {
            "gamma_flip": flip,
            "walls": walls_out,
        },
        "iv_smile": smile,
        "max_pain": pain,
        "whale": whale_out,
        "definitions": {
            "gamma_exposure": "Γ × weight × 100 × S² × 0.01 per strike; calls add, puts subtract. Weight is the contracts traded in the window (chain volume first, tape second) because the feed has no open interest.",
            "flip": "`gex.flip_strike` is the strike where the running cumulative net exposure crosses zero, linearly interpolated between strikes. `levels.gamma_flip` is a different number: the price nearest spot where a repriced board's net exposure crosses zero.",
            "gamma_flip": "Net exposure is recomputed at candidate prices ±25% around spot, each leg repriced with Black-Scholes gamma (zero rate, no dividend yield) from its own IV and dte; IV is held at its quoted level and same-day or missing dte is priced at one day. Weight is contracts traded, puts subtract, and the flip is the crossing nearest spot.",
            "walls": "The strike with the largest call exposure above spot and the largest put exposure below it, on the same weights as the curve.",
            "iv_smile": "IV by strike per expiry, using out-of-the-money contracts (puts below spot, calls above). Nearest IV is the closest listed strike, not an interpolation at spot. Spot stands in for the forward, which this feed does not publish.",
            "max_pain": "the strike minimising total payout to holders, weighted by the same traded contracts as the exposure curve.",
            "whale_score": "weighted sum of five 0..1 components, each listed with its input; a size convention, not a claim about intent.",
            "contract_multiplier": CONTRACT_MULTIPLIER,
        },
        "unavailable": unavailable,
    }


def _unavailable(reason: str, generated: datetime) -> dict:
    return {
        "available": False,
        "engine": ENGINE,
        "source": "lse-data",
        "reason": reason,
        "generated_at": _iso(generated),
        "unavailable": [{"metric": "options chain", "reason": reason}],
    }
