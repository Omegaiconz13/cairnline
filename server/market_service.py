#!/usr/bin/env python3
"""
Cairnline market data service.

One local process that serves real market data and real indicator values to the
static dashboard. The browser cannot call Yahoo directly (CORS) and PineTS needs
a JS runtime, so both live here.

    python3 server/market_service.py          # http://127.0.0.1:8788

Providers, in order: cache -> yfinance -> lse-data (only when LSE_API_KEY is set)
-> last known value (labelled stale). Every response carries source, fetched_at
and stale so the UI can be honest instead of pretending.
"""
from __future__ import annotations

import gzip
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
CACHE_DIR = ROOT / "cache"
CACHE_DIR.mkdir(exist_ok=True)

# Ceiling on a POST body, checked before any read: without it a caller could
# make the service buffer an arbitrary amount of memory.
MAX_BODY = 1 << 20
PINETS_RUNNER = ROOT / "pinets_run.mjs"
CONFIG_PATH = ROOT / "config.json"
ENV_PATH = ROOT / ".env"          # secrets: gitignored, owner read/write only

TTL = {"quotes": 30, "candles": 60, "indicators": 60, "public_record": 6 * 3600,
       "public_raw": 6 * 3600, "public_raw_patents": 24 * 3600}

# Yahoo symbol aliases: the dashboard speaks broker-style pair names.
SYMBOL_MAP = {
    "EURUSD": "EURUSD=X", "GBPUSD": "GBPUSD=X", "USDJPY": "USDJPY=X",
    "AUDUSD": "AUDUSD=X", "USDCHF": "USDCHF=X", "USDCAD": "USDCAD=X",
    "NZDUSD": "NZDUSD=X", "EURJPY": "EURJPY=X", "GBPJPY": "GBPJPY=X",
    "XAUUSD": "GC=F", "XAGUSD": "SI=F", "USOIL": "CL=F",
    "BTCUSD": "BTC-USD", "ETHUSD": "ETH-USD",
    "SPX": "^GSPC", "NAS100": "^NDX", "US30": "^DJI",
    "DXY": "DX-Y.NYB", "US10Y": "^TNX",
}

MARKET_BASKET = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "XAUUSD", "GBPJPY", "USDCHF", "EURJPY"]

# LSE Data 3.0 spellings. Forex carries an underscore, crypto is quoted in Tether.
# A list means "try in order, remember the winner" — gold's spelling is the one
# genuinely uncertain case (forex XAU_USD vs a commodities symbol).
LSE_SYMBOLS = {
    "EURUSD": ["EUR_USD"], "GBPUSD": ["GBP_USD"], "USDJPY": ["USD_JPY"],
    "AUDUSD": ["AUD_USD"], "USDCHF": ["USD_CHF"], "USDCAD": ["USD_CAD"],
    "NZDUSD": ["NZD_USD"], "EURJPY": ["EUR_JPY"], "GBPJPY": ["GBP_JPY"],
    "XAUUSD": ["XAU_USD", "GOLD"], "XAGUSD": ["XAG_USD", "SILVER"],
    "USOIL": ["WTI_USD", "CRUDE"],
    "BTCUSD": ["BTCUSDT"], "ETHUSD": ["ETHUSDT"],
    "SPX": ["SPX"], "NAS100": ["NDX"], "US30": ["DJI"],
}

# Our interval names -> LSE timeframes (LSE has a native 4h; yfinance does not).
LSE_TF = {"1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
          "1h": "1h", "4h": "4h", "1d": "1d", "1wk": "1w", "1mo": "1mo"}

# Our range names -> how far back to ask LSE (a date, computed at call time).
LSE_RANGE_DAYS = {"1d": 1, "5d": 5, "1mo": 31, "3mo": 92, "6mo": 183,
                  "1y": 366, "2y": 731, "5y": 1827, "max": 3650}

_lock = threading.Lock()
_lse_state = {"key": None, "client": None, "resolved": {}}


# ------------------------------------------------------------------- config
def load_config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text())
    except Exception:  # noqa: BLE001 - missing or unreadable config is not fatal
        return {}


def save_config(cfg: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2))
    try:
        CONFIG_PATH.chmod(0o600)   # the key is a secret: owner read/write only
    except OSError:
        pass


def env_file() -> dict:
    """KEY=value pairs from server/.env (no dependency on python-dotenv)."""
    out = {}
    try:
        for line in ENV_PATH.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            out[k.strip()] = v.strip().strip('"').strip("'").strip()
    except OSError:
        return {}
    return out


def lse_key() -> str | None:
    """The key comes from the environment only: a real env var, or server/.env.

    It is never read from config.json — that file is ordinary configuration and
    safe to share, so no secret may live in it.
    """
    return os.environ.get("LSE_API_KEY") or env_file().get("LSE_API_KEY") or None


def save_lse_key(key: str | None) -> None:
    """Write (or clear) LSE_API_KEY in server/.env, owner-readable only."""
    kept = []
    if ENV_PATH.exists():
        kept = [ln for ln in ENV_PATH.read_text().splitlines()
                if not ln.strip().startswith("LSE_API_KEY=")]
    if key:
        kept.append(f"LSE_API_KEY={key}")
    ENV_PATH.write_text("\n".join(kept).rstrip() + "\n")
    try:
        ENV_PATH.chmod(0o600)
    except OSError:
        pass


def lse_client():
    """A cached LSE client, rebuilt whenever the configured key changes."""
    key = lse_key()
    if not key:
        return None
    if _lse_state["client"] is not None and _lse_state["key"] == key:
        return _lse_state["client"]
    from lse import LSE  # type: ignore

    _lse_state["client"] = LSE(api_key=key)
    _lse_state["key"] = key
    _lse_state["resolved"] = {}
    return _lse_state["client"]


def lse_status() -> dict:
    """Plan facts for the Settings page. Never returns the key itself."""
    key = lse_key()
    if not key:
        return {"configured": False}
    hint = f"{key[:9]}…{key[-4:]}" if len(key) > 16 else "configured"
    out = {"configured": True, "key_hint": hint,
           "source": "env" if os.environ.get("LSE_API_KEY") else "env-file"}
    try:
        client = lse_client()
        usage = client.usage()
        out.update({
            "ok": True,
            "plan": usage.get("plan"),
            "markets": usage.get("markets"),
            "calls_per_minute": usage.get("calls_per_minute"),
            "weekly": usage.get("weekly"),
            "withheld": usage.get("withheld"),
        })
    except Exception as exc:  # noqa: BLE001 - a bad key must not break the page
        out.update({"ok": False, "error": str(exc)[:200]})
    return out


# --------------------------------------------------------------------- cache
def cache_path(key: str) -> Path:
    safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in key)
    return CACHE_DIR / f"{safe}.json"


def cache_get(key: str, ttl: int):
    p = cache_path(key)
    if not p.exists():
        return None
    try:
        blob = json.loads(p.read_text())
    except Exception:
        return None
    age = time.time() - blob.get("cached_at", 0)
    if age <= ttl:
        return blob["payload"], False, age
    return blob["payload"], True, age  # stale but usable


def cache_put(key: str, payload):
    try:
        cache_path(key).write_text(json.dumps({"cached_at": time.time(), "payload": payload}))
    except Exception:
        pass


# ------------------------------------------------------------------ providers
def yahoo_symbol(symbol: str) -> str:
    return SYMBOL_MAP.get(symbol.upper(), symbol)


def fetch_quotes(symbols: list[str]) -> dict:
    import yfinance as yf

    out = {}
    tickers = {s: yahoo_symbol(s) for s in symbols}
    joined = " ".join(sorted(set(tickers.values())))
    data = yf.download(joined, period="2d", interval="1d", progress=False, auto_adjust=True, group_by="ticker")
    for name, ysym in tickers.items():
        try:
            if joined.count(" ") == 0:
                series = data
            else:
                series = data[ysym]
            closes = series["Close"].dropna()
            if len(closes) < 2:
                continue
            last, prev = float(closes.iloc[-1]), float(closes.iloc[-2])
            high = float(series["High"].dropna().iloc[-1])
            low = float(series["Low"].dropna().iloc[-1])
            out[name] = {
                "symbol": name,
                "yahoo": ysym,
                "price": round(last, 6),
                "prev_close": round(prev, 6),
                "change": round(last - prev, 6),
                "change_pct": round((last - prev) / prev * 100, 3) if prev else 0.0,
                "day_high": round(high, 6),
                "day_low": round(low, 6),
            }
        except Exception:
            continue
    return out


def fetch_candles(symbol: str, interval: str, period: str) -> list[dict]:
    import yfinance as yf

    t = yf.Ticker(yahoo_symbol(symbol))
    hist = t.history(period=period, interval=interval)
    rows = []
    for ts, r in hist.iterrows():
        try:
            rows.append({
                "openTime": int(ts.timestamp() * 1000),
                "open": float(r["Open"]), "high": float(r["High"]),
                "low": float(r["Low"]), "close": float(r["Close"]),
                "volume": float(r["Volume"] or 0),
            })
        except Exception:
            continue
    return rows


def fetch_lse_candles(symbol: str, interval: str, period: str):
    """Primary provider: LSE Data 3.0 candles. Returns None when unavailable."""
    client = lse_client()
    if client is None:
        return None
    tf = LSE_TF.get(interval)
    if not tf:
        return None
    days = LSE_RANGE_DAYS.get(period, 5)
    start = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
    candidates = LSE_SYMBOLS.get(symbol, [symbol])
    resolved = _lse_state["resolved"].get(symbol)
    if resolved:
        candidates = [resolved] + [c for c in candidates if c != resolved]
    last_exc = None
    for cand in candidates:
        try:
            rows = client.candles(cand, tf, start=start, limit=5000, order="asc")
            if not rows:
                continue
            _lse_state["resolved"][symbol] = cand
            bars = []
            for r in rows:
                ts = r.get("timestamp") or r.get("time")
                if not ts:
                    continue
                dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                bars.append({
                    "openTime": int(dt.timestamp() * 1000),
                    "open": float(r["open"]), "high": float(r["high"]),
                    "low": float(r["low"]), "close": float(r["close"]),
                    "volume": float(r.get("volume") or 0),
                })
            return bars or None
        except Exception as exc:  # noqa: BLE001 - try the next spelling, then fall back
            last_exc = exc
            continue
    if last_exc is not None:
        print(f"[lse] candles {symbol} {interval}: {last_exc}", file=sys.stderr)
    return None


def aggregate_bars(bars: list[dict], factor: int) -> list[dict]:
    """Roll `factor` consecutive bars into one (4h, which yfinance cannot serve)."""
    out = []
    for i in range(0, len(bars), factor):
        chunk = bars[i:i + factor]
        if len(chunk) < factor:
            break               # never emit a partial bucket as a full bar
        out.append({
            "openTime": chunk[0]["openTime"],
            "open": chunk[0]["open"],
            "high": max(b["high"] for b in chunk),
            "low": min(b["low"] for b in chunk),
            "close": chunk[-1]["close"],
            "volume": sum(b.get("volume") or 0 for b in chunk),
        })
    return out


def bars_for_analysis(symbol: str, interval: str, period: str) -> list[dict]:
    """Bars for the PineTS rail: the same chain the chart is served from."""
    return live_bars(symbol, interval, period)[0] or []


def fetch_lse_quotes(symbols: list[str]) -> dict | None:
    """Primary provider: last two daily closes per symbol via /v3/preview (JSON, cheap)."""
    client = lse_client()
    if client is None:
        return None
    out = {}
    for sym in symbols:
        candidates = LSE_SYMBOLS.get(sym, [sym])
        resolved = _lse_state["resolved"].get(sym)
        if resolved:
            candidates = [resolved] + [c for c in candidates if c != resolved]
        for cand in candidates:
            try:
                market = "crypto" if cand.endswith("USDT") else "forex"
                page = client.preview(market, cand, "1d")
                rows = page.get("rows") or []
                if len(rows) < 1:
                    continue
                last = float(rows[-1]["close"])
                prev = float(rows[-2]["close"]) if len(rows) > 1 else last
                _lse_state["resolved"][sym] = cand
                out[sym] = {
                    "price": last,
                    "change_pct": round((last - prev) / prev * 100, 3) if prev else 0.0,
                    "source": "lse-data",
                }
                break
            except Exception:  # noqa: BLE001 - next spelling, else yfinance covers it
                continue
    return out or None


# Events that move FX/gold hardest. LSE's calendar carries no impact field, so we
# derive one from the event name and SAY SO in the payload rather than invent a rating.
HIGH_IMPACT = (
    "nonfarm", "nfp", "non-farm", "cpi", "consumer price", "ppi", "producer price",
    "fomc", "interest rate", "rate decision", "gdp", "unemployment", "retail sales",
    "pce", "ecb", "boe", "boj", "snb", "rba", "rbnz", "boc", "average earnings",
)
MEDIUM_IMPACT = (
    "pmi", "ism", "durable", "trade balance", "industrial production", "jobless",
    "housing", "sentiment", "confidence", "inflation", "payroll", "building permits",
)


def event_impact(name: str) -> str:
    low = (name or "").lower()
    if any(k in low for k in HIGH_IMPACT):
        return "high"
    if any(k in low for k in MEDIUM_IMPACT):
        return "medium"
    return "low"


def fetch_calendar(region: str, days: int) -> dict:
    """Upcoming macro events from LSE Data 3.0's economic_calendar reference."""
    client = lse_client()
    if client is None:
        raise RuntimeError("no LSE key configured")
    start = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    end = (datetime.now(timezone.utc) + timedelta(days=days)).strftime("%Y-%m-%d")
    rows = client.economic_calendar(region=region, start=start, end=end, limit=500)
    now = datetime.now(timezone.utc)
    out = []
    for r in rows:
        when = r.get("datetime") or r.get("date")
        try:
            dt = datetime.fromisoformat(str(when).replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
        except Exception:  # noqa: BLE001
            continue
        mins = int((dt - now).total_seconds() // 60)
        if mins < -30:           # "Upcoming": drop anything older than half an hour
            continue
        out.append({
            "id": r.get("id"),
            "event": r.get("event"),
            "region": r.get("region_code"),
            "at": dt.isoformat(),
            "in_minutes": mins,
            "impact": event_impact(r.get("event") or ""),
            "actual": r.get("actual"),
            "previous": r.get("previous"),
            "consensus": r.get("consensus") or r.get("forecast"),
        })
    # Upcoming first (soonest on top), then the ones that just released.
    out.sort(key=lambda e: (1 if e["in_minutes"] < 0 else 0, e["at"]))
    return {
        "source": "lse-data",
        "stale": False,
        "region": region,
        "fetched_at": now.isoformat(),
        "impact_note": "impact is derived from the event type, not supplied by the data source",
        "events": out,
    }


def fetch_cot(symbol: str) -> dict:
    """Commitments of Traders: net non-commercial positioning + where today sits."""
    client = lse_client()
    if client is None:
        raise RuntimeError("no LSE key configured")
    rows = client.cot(symbol)
    series = []
    for r in rows:
        try:
            net = float(r.get("noncomm_long") or 0) - float(r.get("noncomm_short") or 0)
        except (TypeError, ValueError):
            continue
        series.append({"date": r.get("date"), "net": net,
                       "open_interest": r.get("open_interest"),
                       "long": r.get("noncomm_long"), "short": r.get("noncomm_short")})
    series.sort(key=lambda x: x["date"] or "")
    if not series:
        raise RuntimeError(f"no COT rows for {symbol}")
    latest = series[-1]
    window = [x["net"] for x in series[-156:]]          # ~3 years weekly
    below = sum(1 for v in window if v <= latest["net"])
    pct = round(below / len(window) * 100, 1) if window else None
    return {
        "source": "lse-data", "stale": False, "symbol": symbol.upper(),
        "name": rows[-1].get("name"), "sector": rows[-1].get("sector"),
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "latest": latest, "percentile_3y": pct, "weeks": len(window),
        "series": window[-52:],
    }


TRISH_RANGES = {"5m": "5d", "15m": "5d", "30m": "1mo", "1h": "3mo", "4h": "1y", "1d": "2y"}


def trish_indicators(symbol: str, interval: str, period: str) -> dict:
    """Indicators for Trish, cached exactly like the HTTP endpoint."""
    key = f"indicators_{symbol}_{interval}_{period}_core"
    hit = cache_get(key, TTL["indicators"])
    if hit and not hit[1]:
        return hit[0]
    bars = fetch_lse_candles(symbol, interval, period) or fetch_candles(symbol, interval, period)
    if not bars:
        raise RuntimeError(f"no bars for {symbol} {interval}")
    result = run_pinets(bars, "core")
    payload = {"source": "pinets", "stale": False, "symbol": symbol, "interval": interval,
               "range": period, "fetched_at": datetime.now(timezone.utc).isoformat(),
               "bars": len(bars), **result}
    cache_put(key, payload)
    return payload


def trish_basket(interval: str) -> dict:
    key = f"basket_{interval}"
    hit = cache_get(key, TTL["indicators"])
    if hit and not hit[1]:
        return hit[0]
    with ThreadPoolExecutor(max_workers=8) as pool:
        rows = list(pool.map(lambda s: _basket_one(s, interval), MARKET_BASKET))
    ranked = sorted([r for r in rows if not r.get("error")],
                    key=lambda r: r.get("confidence") or 0, reverse=True)
    payload = {"source": "pinets", "interval": interval,
               "fetched_at": datetime.now(timezone.utc).isoformat(),
               "signals": rows, "top": ranked[0] if ranked else None}
    cache_put(key, payload)
    return payload


def trish_config() -> dict:
    """Provider config. The key is never returned, only a masked hint."""
    cfg = dict(load_config().get("trish") or {})
    out = {k: v for k, v in cfg.items() if k != "api_key"}
    out["configured"] = bool(cfg.get("base_url"))
    out["has_key"] = bool(cfg.get("api_key"))
    if cfg.get("api_key"):
        k = str(cfg["api_key"])
        out["key_hint"] = f"{k[:6]}…{k[-4:]}" if len(k) > 12 else "set"
    return out


def trish_deps() -> dict:
    return {
        "quotes": lambda syms: fetch_lse_quotes(syms) or fetch_quotes(syms),
        "indicators": trish_indicators,
        "basket": trish_basket,
        "cot": fetch_cot,
        "calendar": fetch_calendar,
        "range_for": lambda interval: TRISH_RANGES.get(interval, "5d"),
    }


def run_pinets(candles: list[dict], preset: str) -> dict:
    """Real Pine Script math via PineTS (AGPL-3.0)."""
    proc = subprocess.run(
        ["node", str(PINETS_RUNNER)],
        input=json.dumps({"candles": candles, "preset": preset}),
        capture_output=True, text=True, timeout=90,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip()[:400] or "pinets failed")
    return json.loads(proc.stdout)


DATA_ROOT = "https://raw.githubusercontent.com/LuxAlgo/market-trackers-data/main"


PUBLIC_DATASETS = {
    "congress":      {"path": "congress/trades/latest.json", "date": "transactedAt"},
    "insider":       {"path": "insider/transactions/latest.json", "date": "transactedAt"},
    "thirteenf":     {"path": "thirteenf/holdings/latest.json", "date": "filedAt"},
    "contracts":     {"path": "contracts/awards/latest.json", "date": "actionDate"},
    "lobbying":      {"path": "lobbying/filings/latest.json", "date": "filingYear"},
    "short-volume":  {"path": "short-volume/daily/latest.json", "date": "date"},
    # Patents publish yearly snapshots, not a daily latest.json: the newest one is
    # 377,953 grants (17 MB gzipped), so we keep only the ticker-mapped rows — the
    # ones a trader can actually act on — and sort them newest first.
    "patents":       {"path": "patents/grants/snapshot-2025.json.gz", "gz": True,
                      "date": "grantDate", "tickers_only": True},
    "fed":           {"path": "fed/communications/latest.json", "date": "date"},
}


def _row_tickers(row: dict) -> list[str]:
    """Ticker symbols on a public-record row, whether flat or nested in an entity."""
    found = []
    if row.get("ticker"):
        found.append(str(row["ticker"]).upper())
    for key in ("assignee", "client", "recipient", "member"):
        ent = row.get(key)
        if isinstance(ent, dict):
            found.extend(str(t).upper() for t in (ent.get("tickers") or []))
    return found


def _public_rows(dataset: str, spec: dict) -> list[dict]:
    """Raw rows for one dataset, cached on disk so a ticker change is not a refetch."""
    gz = bool(spec.get("gz"))
    hit = cache_get(f"public_raw_{dataset}", TTL["public_raw_patents" if gz else "public_raw"])
    if hit:
        return hit[0]
    with urllib.request.urlopen(f"{DATA_ROOT}/{spec['path']}", timeout=180) as resp:  # noqa: S310 - fixed host
        raw = resp.read()
    if gz:
        raw = gzip.decompress(raw)
    rows = json.loads(raw)
    if spec.get("tickers_only"):
        rows = [r for r in rows if _row_tickers(r)]
    rows.sort(key=lambda r: str(r.get(spec["date"]) or ""), reverse=True)
    cache_put(f"public_raw_{dataset}", rows)
    return rows


def fetch_public_record(dataset: str, ticker: str | None, limit: int) -> dict:
    spec = PUBLIC_DATASETS.get(dataset)
    if spec is None:
        raise KeyError(dataset)
    rows = _public_rows(dataset, spec)
    if ticker:
        t = ticker.upper()
        rows = [r for r in rows if t in _row_tickers(r)]
    return {
        "dataset": dataset,
        "source": "LuxAlgo market-trackers-data (CC0)",
        "rows": rows[:limit],
        "total": len(rows),
        "available": bool(rows),
        "note": None if rows else (
            f"{dataset} has no rows matched in the current dump." if ticker else
            f"{dataset} has no rows in the current dump."),
    }


def _basket_one(sym: str, interval: str) -> dict:
    """One symbol of the basket: cached indicator summary, or compute it now."""
    key = f"indicators_{sym}_{interval}_5d_core"
    hit = cache_get(key, TTL["indicators"])
    if hit and not hit[1]:
        return {"symbol": sym, **hit[0].get("summary", {})}
    try:
        bars = fetch_candles(sym, interval, "5d")
        if not bars:
            return {"symbol": sym, "error": "no bars"}
        res = run_pinets(bars, "core")
        payload = {"source": "pinets", "stale": False, "symbol": sym, "interval": interval,
                   "range": "5d", "fetched_at": datetime.now(timezone.utc).isoformat(),
                   "bars": len(bars), **res}
        cache_put(key, payload)
        return {"symbol": sym, **res.get("summary", {})}
    except Exception as exc:  # noqa: BLE001
        if hit:
            return {"symbol": sym, "stale": True, **hit[0].get("summary", {})}
        return {"symbol": sym, "error": str(exc)[:120]}


# ------------------------------------------------------- live quote/bar pair
# One place that answers "a quote right now" and "bars right now" for the paper
# desk, using the same provider order as the public routes.

def live_quotes(symbols: list[str]):
    quotes = fetch_lse_quotes(symbols)
    if quotes:
        missing = [s for s in symbols if s not in quotes]
        if missing:
            try:
                quotes.update(fetch_quotes(missing))
            except Exception:  # noqa: BLE001 - partial is fine
                pass
        return quotes, "lse-data"
    return fetch_quotes(symbols), "yfinance"


def live_bars(symbol: str, interval: str, period: str):
    bars = fetch_lse_candles(symbol, interval, period)
    if bars:
        return bars, "lse-data"
    if interval == "4h":
        bars = aggregate_bars(fetch_candles(symbol, "1h", "3mo"), 4)
        if bars:
            return bars, "yfinance"
    bars = fetch_candles(symbol, interval, period)
    return bars, ("yfinance" if bars else None)


def paper_desk():
    """Import the paper engine and give it the live providers once per process."""
    import paper_trader
    if not paper_trader.bound():
        paper_trader.bind(
            quotes=lambda syms: live_quotes([str(s).upper() for s in syms])[0],
            bars=lambda sym, interval, period: live_bars(sym, interval, period)[0],
        )
    return paper_trader


# ------------------------------------------------------------------- handler
# The API is bound to loopback and the dashboard is served from another port, so
# a grant is needed for a loopback Origin, and for a dashboard served over http
# on any other host it points the service at (`http://<app host>:8788`). A page
# on any other site gets no grant, and its writes are refused outright — that is
# what stops a random tab from posting to the paper desk. The page's own origin
# is what decides: a cross-site POST always carries the attacker's Origin, so it
# never matches the host the request was addressed to.
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def origin_host(value: str):
    """Host of an Origin header, lowercased; None when absent or unparsable."""
    if not value:
        return None
    try:
        return (urlparse(value).hostname or "").lower() or None
    except ValueError:
        return None


def header_host(value: str):
    """Host of a bare `host[:port]` authority, lowercased, without its port.

    A Host header carries no scheme, and urlparse reads `mybox.local:8788` as the
    scheme `mybox.local`, so it has to be parsed as an authority instead.
    """
    if not value:
        return None
    try:
        return (urlparse(f"//{value}").hostname or "").lower() or None
    except ValueError:
        return None


class Handler(BaseHTTPRequestHandler):
    server_version = "CairnlineMarket/1.0"

    def log_message(self, fmt, *args):  # quieter log
        sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def _request_host(self):
        """Host of this request's own Host header, lowercased; None if absent."""
        return header_host(self.headers.get("Host") or "")

    def _allowed_origin(self):
        """The Origin to echo back, or None when it is not this page's own site."""
        origin = self.headers.get("Origin") or ""
        host = origin_host(origin)
        if host is None:
            return None
        return origin if host in LOOPBACK_HOSTS or host == self._request_host() else None

    def _foreign_write(self) -> bool:
        """True for a write carrying an Origin that is not this host.

        Requests with no Origin at all (curl, local scripts) are allowed: a
        browser always sends Origin on a cross-site POST, so CSRF is covered
        without a token or any config.
        """
        origin = self.headers.get("Origin") or ""
        return bool(origin) and self._allowed_origin() is None

    def _send(self, payload, status=200):
        body = json.dumps(payload).encode()
        origin = self._allowed_origin()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802
        origin = self.headers.get("Origin") or ""
        allowed = self._allowed_origin()
        if origin and not allowed:
            self.send_response(403)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(204)
        if allowed:
            self.send_header("Access-Control-Allow-Origin", allowed)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _body(self) -> dict:
        try:
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n) or b"{}")
        except Exception:  # noqa: BLE001
            return {}

    def _drain_body(self):
        """Discard up to MAX_BODY bytes so a refused client can still read the reply.

        Closing while the caller is mid-write loses the 413 to a broken pipe.
        """
        try:
            remaining = min(int(self.headers.get("Content-Length") or 0), MAX_BODY)
        except (TypeError, ValueError):
            return
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 65536))
            if not chunk:
                return
            remaining -= len(chunk)

    def _body_too_large(self) -> bool:
        try:
            size = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            return True
        return not 0 <= size <= MAX_BODY

    def do_POST(self):  # noqa: N802
        if self._foreign_write():
            return self._send({"error": "cross-origin writes are refused"}, 403)
        if self._body_too_large():
            self._drain_body()
            return self._send({"error": "request body too large", "limit": MAX_BODY}, 413)
        url = urlparse(self.path)

        # ---- Paper desk: server-side rails, paper fills, no broker ----
        if url.path.startswith("/api/paper/"):
            try:
                desk = paper_desk()
                body = self._body()
                if url.path == "/api/paper/order":
                    return self._send(desk.submit(body))
                if url.path == "/api/paper/close":
                    return self._send(desk.close(str(body.get("id") or ""),
                                                 reason=body.get("reason")))
                if url.path == "/api/paper/kill":
                    return self._send(desk.kill(bool(body.get("engaged")),
                                                reason=body.get("reason")))
                if url.path == "/api/paper/rails":
                    return self._send(desk.set_rails(body.get("rails") or body))
                if url.path == "/api/paper/deploy":
                    return self._send(desk.deploy(body))
                if url.path == "/api/paper/cycle":
                    return self._send(desk.cycle(body.get("id")))
                return self._send({"error": "unknown paper route", "path": url.path}, 404)
            except ValueError as exc:
                return self._send({"error": str(exc)[:300]}, 400)
            except Exception as exc:  # noqa: BLE001
                return self._send({"error": type(exc).__name__, "message": str(exc)[:400]}, 500)

        # Edge Stats: one preset, one instrument, answered by the engine in edge_stats.py.
        if url.path == "/api/edge-stats/run":
            body = self._body()
            symbol = str(body.get("symbol") or "EURUSD").upper()
            interval = str(body.get("interval") or "1h")
            period = str(body.get("range") or "1y")
            preset_id = str(body.get("presetId") or "")
            params = body.get("params") or {}
            try:
                import edge_stats as es
            except Exception as exc:  # noqa: BLE001
                return self._send({"error": f"edge stats engine unavailable: {exc}"}, 500)
            preset = next((p for p in es.load_presets() if p["id"] == preset_id), None)
            if preset is None:
                return self._send({"error": f"unknown preset {preset_id!r}"}, 400)
            bars, source = live_bars(symbol, interval, period)
            if not bars:
                return self._send({"error": f"no bars for {symbol} {interval} {period}"}, 400)
            try:
                result = es.run_preset(preset, params, bars, symbol, interval, period)
            except getattr(es, "DslError", ValueError) as exc:
                return self._send({"error": str(exc), "preset": preset_id}, 400)
            except Exception as exc:  # noqa: BLE001
                return self._send({"error": type(exc).__name__, "message": str(exc)[:300]}, 500)
            result.update({"source": source, "stale": False})
            return self._send(result)

        # Backtest Studio: signals on closed bars, fills on the next open, costs both sides.
        if url.path == "/api/backtest":
            body = self._body()
            symbol = str(body.get("symbol") or "EURUSD").upper()
            interval = str(body.get("interval") or "1h")
            period = str(body.get("range") or "1y")
            try:
                import backtest as bt
            except Exception as exc:  # noqa: BLE001
                return self._send({"error": f"backtest engine unavailable: {exc}"}, 500)
            bars, source = live_bars(symbol, interval, period)
            if not bars:
                return self._send({"error": f"no bars for {symbol} {interval} {period}"}, 400)
            try:
                result = bt.run(bars, body)
            except ValueError as exc:
                return self._send({"error": str(exc)}, 400)
            except Exception as exc:  # noqa: BLE001
                return self._send({"error": type(exc).__name__, "message": str(exc)[:300]}, 500)
            result.update({"symbol": symbol, "interval": interval, "range": period,
                           "source": source, "stale": False})
            return self._send(result)

        if url.path == "/api/trish/config":
            body = self._body()
            cfg = load_config()
            cur = dict(cfg.get("trish") or {})
            for k in ("backend", "base_url", "model", "extra_instructions"):
                if k in body:
                    cur[k] = body[k]
            if "temperature" in body:
                try:
                    cur["temperature"] = float(body["temperature"])
                except (TypeError, ValueError):
                    pass
            if body.get("api_key"):
                cur["api_key"] = str(body["api_key"]).strip()
            cur["backend"] = cur.get("backend") or "direct"
            cur["base_url"] = (cur.get("base_url") or "").rstrip("/")
            cfg["trish"] = cur
            save_config(cfg)
            return self._send({"saved": True, "trish": trish_config()})

        # ---- Trish's engine controls ----
        if url.path in ("/api/trish/engine", "/api/trish/memory", "/api/trish/pending"):
            body = self._body()
            try:
                import trish_runtime
                if url.path == "/api/trish/engine":
                    action = str(body.get("action") or "")
                    if action in ("start", "stop", "restart"):
                        result = getattr(trish_runtime, action)()
                    elif body.get("provider") or body.get("model") or body.get("base_url") or body.get("api_key"):
                        result = trish_runtime.set_engine(body)
                    elif "learning" in body or any(k.endswith("_approval") or k == "suggest_after_turn" for k in body):
                        result = trish_runtime.set_learning(body)
                    else:
                        result = trish_runtime.state()
                    return self._send(result)
                if url.path == "/api/trish/memory":
                    return self._send(trish_runtime.write_memory(str(body.get("name") or "MEMORY.md"),
                                                                 str(body.get("text") or "")))
                return self._send(trish_runtime.decide(str(body.get("id") or ""),
                                                       str(body.get("action") or "")))
            except ValueError as exc:
                return self._send({"error": str(exc)[:300]}, 400)
            except Exception as exc:  # noqa: BLE001
                return self._send({"error": type(exc).__name__, "message": str(exc)[:400]}, 500)

        if url.path == "/api/trish/chat":
            body = self._body()
            messages = body.get("messages") or []
            if not isinstance(messages, list) or not messages:
                return self._send({"error": "messages required"}, 400)
            clean = [{"role": m.get("role", "user"), "content": str(m.get("content", ""))[:8000]}
                     for m in messages[-24:] if m.get("content")]
            cfg = load_config().get("trish") or {}
            if not cfg.get("base_url"):
                return self._send({"error": "Trish has no provider yet — add one in Settings → Trish"}, 400)
            try:
                import trish as trish_mod  # local module
                result = trish_mod.chat(cfg, clean, trish_deps(), body.get("context") or {})
                return self._send(result)
            except Exception as exc:  # noqa: BLE001
                return self._send({"error": str(exc)[:400]}, 502)

        if url.path != "/api/config/lse":
            return self._send({"error": "not found"}, 404)
        key = str(self._body().get("key") or "").strip()
        if not key:
            return self._send({"error": "missing key"}, 400)
        # Validate before storing: a bad key must never be persisted.
        try:
            from lse import LSE  # type: ignore

            usage = LSE(api_key=key).usage()
        except Exception as exc:  # noqa: BLE001
            return self._send({"error": str(exc)[:200], "saved": False}, 400)
        save_lse_key(key)
        _lse_state.update({"key": None, "client": None, "resolved": {}})
        return self._send({"saved": True, "lse": lse_status(), "plan": usage.get("plan")})

    def do_DELETE(self):  # noqa: N802
        if self._foreign_write():
            return self._send({"error": "cross-origin writes are refused"}, 403)
        url = urlparse(self.path)
        if url.path == "/api/trish/config":
            cfg = load_config()
            cfg.pop("trish", None)
            save_config(cfg)
            return self._send({"saved": True, "trish": trish_config()})
        if url.path != "/api/config/lse":
            return self._send({"error": "not found"}, 404)
        save_lse_key(None)
        _lse_state.update({"key": None, "client": None, "resolved": {}})
        return self._send({"saved": True, "lse": lse_status()})

    def do_GET(self):  # noqa: N802
        url = urlparse(self.path)
        q = parse_qs(url.query)
        one = lambda k, d=None: (q.get(k) or [d])[0]  # noqa: E731
        try:
            if url.path == "/api/health":
                st = lse_status()
                return self._send({
                    "ok": True,
                    "providers": {
                        "lse": bool(st.get("configured") and st.get("ok")),
                        "lse_configured": bool(st.get("configured")),
                        "lse_plan": st.get("plan"),
                        "yfinance": _yfinance_ok(),
                        "pinets": PINETS_RUNNER.exists(),
                        "backtest": (ROOT / "backtest.py").exists(),
                        "edge_stats": (ROOT / "edge_stats.py").exists(),
                        "paper": (ROOT / "paper_trader.py").exists(),
                        "public_record": "LuxAlgo market-trackers-data (CC0)",
                    },
                    "order": ["lse-data", "yfinance", "cache"],
                    "cache_entries": len(list(CACHE_DIR.glob("*.json"))),
                    "time": datetime.now(timezone.utc).isoformat(),
                })

            if url.path == "/api/calendar":
                region = one("region", "US").upper()
                days = int(one("days", "7"))
                key = f"calendar_{region}_{days}"
                hit = cache_get(key, 3600)
                if hit and not hit[1]:
                    payload = dict(hit[0]); payload["cached"] = True
                    return self._send(payload)
                try:
                    payload = fetch_calendar(region, days)
                    cache_put(key, payload)
                    return self._send(payload)
                except Exception as exc:  # noqa: BLE001
                    if hit:
                        payload = dict(hit[0]); payload.update({"stale": True, "error": str(exc)[:200]})
                        return self._send(payload)
                    return self._send({"source": None, "events": [], "error": str(exc)[:200],
                                       "fetched_at": datetime.now(timezone.utc).isoformat()})

            if url.path == "/api/cot":
                symbol = one("symbol", "GC").upper()
                key = f"cot_{symbol}"
                hit = cache_get(key, 6 * 3600)
                if hit and not hit[1]:
                    payload = dict(hit[0]); payload["cached"] = True
                    return self._send(payload)
                try:
                    payload = fetch_cot(symbol)
                    cache_put(key, payload)
                    return self._send(payload)
                except Exception as exc:  # noqa: BLE001
                    if hit:
                        payload = dict(hit[0]); payload.update({"stale": True, "error": str(exc)[:200]})
                        return self._send(payload)
                    return self._send({"source": None, "series": [], "error": str(exc)[:200]})

            if url.path == "/api/trish/config":
                return self._send({"trish": trish_config()})

            # ---- Trish's engine (project-owned Hermes checkout) ----
            if url.path == "/api/trish/engine":
                import trish_runtime
                return self._send(trish_runtime.state())

            if url.path == "/api/trish/memory":
                import trish_runtime
                return self._send({"files": trish_runtime.memory_files()})

            if url.path == "/api/trish/pending":
                import trish_runtime
                return self._send({"items": trish_runtime.pending()})

            if url.path == "/api/trish/skills":
                import trish_runtime
                return self._send({"skills": trish_runtime.skills_catalogue()})

            if url.path == "/api/trish/journey":
                import trish_runtime
                return self._send({"items": trish_runtime.journey()})

            if url.path == "/api/config":
                return self._send({"lse": lse_status(), "order": ["lse-data", "yfinance", "cache"]})

            if url.path == "/api/quotes":
                symbols = [s.strip().upper() for s in one("symbols", ",".join(MARKET_BASKET)).split(",") if s.strip()]
                key = "quotes_" + "_".join(sorted(symbols))
                hit = cache_get(key, TTL["quotes"])
                if hit and not hit[1]:
                    payload = hit[0]
                    payload["cached"] = True
                    payload["age_s"] = round(hit[2], 1)
                    return self._send(payload)
                try:
                    quotes = None
                    source = None
                    lse_quotes = fetch_lse_quotes(symbols)
                    if lse_quotes:
                        quotes, source = lse_quotes, "lse-data"
                        missing = [s for s in symbols if s not in quotes]
                        if missing:
                            try:
                                quotes.update(fetch_quotes(missing))
                            except Exception:  # noqa: BLE001 - partial is fine
                                pass
                    if not quotes:
                        quotes, source = fetch_quotes(symbols), "yfinance"
                    payload = {"source": source, "stale": False,
                               "fetched_at": datetime.now(timezone.utc).isoformat(), "quotes": quotes}
                    cache_put(key, payload)
                    return self._send(payload)
                except Exception as exc:  # noqa: BLE001
                    if hit:
                        payload = hit[0]
                        payload.update({"stale": True, "age_s": round(hit[2], 1), "error": str(exc)[:200]})
                        return self._send(payload)
                    raise

            if url.path == "/api/candles":
                symbol = one("symbol", "EURUSD").upper()
                interval = one("interval", "15m")
                period = one("range", "5d")
                key = f"candles_{symbol}_{interval}_{period}"
                hit = cache_get(key, TTL["candles"])
                if hit and not hit[1]:
                    payload = dict(hit[0]); payload["cached"] = True; payload["age_s"] = round(hit[2], 1)
                    return self._send(payload)
                try:
                    # One provider chain for every consumer: live_bars().
                    bars, source = live_bars(symbol, interval, period)
                    if not bars:
                        raise RuntimeError(f"no bars for {symbol} {interval} {period}")
                    payload = {"source": source, "stale": False, "symbol": symbol,
                               "yahoo": yahoo_symbol(symbol), "interval": interval, "range": period,
                               "fetched_at": datetime.now(timezone.utc).isoformat(), "bars": bars}
                    cache_put(key, payload)
                    return self._send(payload)
                except Exception as exc:  # noqa: BLE001
                    if hit:
                        payload = dict(hit[0]); payload.update({"stale": True, "age_s": round(hit[2], 1),
                                                                "error": str(exc)[:200]})
                        return self._send(payload)
                    raise

            if url.path == "/api/indicators":
                symbol = one("symbol", "EURUSD").upper()
                interval = one("interval", "15m")
                period = one("range", "5d")
                preset = one("preset", "core")
                key = f"indicators_{symbol}_{interval}_{period}_{preset}"
                hit = cache_get(key, TTL["indicators"])
                if hit and not hit[1]:
                    payload = dict(hit[0]); payload["cached"] = True; payload["age_s"] = round(hit[2], 1)
                    return self._send(payload)
                try:
                    bars = bars_for_analysis(symbol, interval, period)
                    if not bars:
                        raise RuntimeError(f"no bars for {symbol}")
                    result = run_pinets(bars, preset)
                    payload = {"source": "pinets", "stale": False, "symbol": symbol,
                               "interval": interval, "range": period,
                               "fetched_at": datetime.now(timezone.utc).isoformat(),
                               "bars": len(bars), **result}
                    cache_put(key, payload)
                    return self._send(payload)
                except Exception as exc:  # noqa: BLE001
                    if hit:
                        payload = dict(hit[0]); payload.update({"stale": True, "age_s": round(hit[2], 1),
                                                                "error": str(exc)[:300]})
                        return self._send(payload)
                    raise

            if url.path == "/api/options-flow":
                q = parse_qs(url.query)
                underlying = (q.get("underlying", ["SPY"])[0] or "SPY").upper()
                window = q.get("window", ["7d"])[0] or "7d"
                try:
                    limit = max(50, min(5000, int(q.get("limit", ["1000"])[0])))
                except ValueError:
                    limit = 1000
                min_premium = q.get("min_premium", [None])[0]
                max_dte = q.get("max_dte", [None])[0]
                if not lse_key():
                    return self._send({
                        "available": False,
                        "engine": "cairnline-options-flow",
                        "source": "lse-data",
                        "reason": "LSE_API_KEY is not configured, so no options feed is reachable from this machine",
                        "unavailable": [{"metric": "options chain", "reason": "no LSE key configured"}],
                    }, 503)
                try:
                    import options_flow as options_engine
                except Exception as exc:  # noqa: BLE001
                    return self._send({"available": False, "engine": "cairnline-options-flow",
                                       "reason": f"options engine unavailable: {exc}"}, 500)
                try:
                    payload = options_engine.build(lse_client(), underlying, window=window, limit=limit,
                                                   min_premium=min_premium, max_dte=max_dte)
                except Exception as exc:  # noqa: BLE001
                    return self._send({"available": False, "engine": "cairnline-options-flow",
                                       "source": "lse-data",
                                       "reason": f"{type(exc).__name__}: {str(exc)[:200]}"}, 502)
                # 200 even when the engine found nothing: the query succeeded, the
                # answer is "no feed", and the payload carries the reason. A 5xx
                # here would only make the browser log a network error for a state
                # the page renders deliberately.
                return self._send(payload)

            if url.path == "/api/paper":
                try:
                    return self._send(paper_desk().snapshot())
                except Exception as exc:  # noqa: BLE001
                    return self._send({"mode": "paper", "error": f"paper desk unavailable: {exc}"}
                                      , 500)

            if url.path == "/api/edge-stats/presets":
                try:
                    import edge_stats as es
                except Exception as exc:  # noqa: BLE001
                    return self._send({"error": f"edge stats engine unavailable: {exc}"}, 500)
                presets = es.load_presets()
                return self._send({
                    "engine": "cairnline-edge-stats",
                    "catalog": "LuxAlgo edge-stats preset catalog (MIT), vendored in server/presets/",
                    "preset_count": len(presets),
                    "presets": [
                        {
                            "id": p["id"], "title": p["title"], "category": p.get("category"),
                            "summary": p.get("summary"), "version": p.get("version"),
                            "outcome": p["outcome"], "where": p.get("where"),
                            "groupBy": p.get("groupBy"),
                            "needs_intraday": p["id"] in es.NEEDS_INTRADAY,
                            "params": p.get("params", []),
                        }
                        for p in presets
                    ],
                    "sessions": [
                        {"key": k, "label": lbl, "utc": f"{a:02d}:00-{b:02d}:00"}
                        for k, lbl, a, b in es.SESSIONS
                    ],
                    "gap_floor_pct": es.GAP_FLOOR_PCT,
                })

            if url.path == "/api/backtest/strategies":
                try:
                    import backtest as bt
                except Exception as exc:  # noqa: BLE001
                    return self._send({"error": f"backtest engine unavailable: {exc}"}, 500)
                return self._send({
                    "engine": "cairnline-backtest",
                    "strategies": [
                        {"id": k, "label": v["label"], "note": v["note"],
                         "params": v["params"], "shared": v["shared"]}
                        for k, v in bt.STRATEGIES.items()
                    ],
                })

            if url.path == "/api/public-record":
                dataset = one("dataset", "insider")
                limit = int(one("limit", "40"))
                ticker = one("ticker")
                key = f"public_record_{dataset}_{ticker or 'all'}_{limit}"
                hit = cache_get(key, TTL["public_record"])
                if hit:
                    payload = dict(hit[0]); payload["age_s"] = round(hit[2], 1)
                    payload.setdefault("available", bool(payload.get("rows")))
                    return self._send(payload)
                if dataset not in PUBLIC_DATASETS:
                    return self._send({"error": f"unknown dataset {dataset}",
                                       "datasets": sorted(PUBLIC_DATASETS)}, 400)
                payload = fetch_public_record(dataset, ticker, limit)
                payload["fetched_at"] = datetime.now(timezone.utc).isoformat()
                cache_put(key, payload)
                return self._send(payload)

            if url.path == "/api/basket/signals":
                """Indicator-derived signals across the basket — the real 'Signal of the Day'.

                Runs the symbols concurrently: eight sequential yfinance round-trips took
                ~30 s, which is too slow for a dashboard card.
                """
                interval = one("interval", "15m")
                out = []
                with ThreadPoolExecutor(max_workers=6) as pool:
                    results = list(pool.map(lambda s: _basket_one(s, interval), MARKET_BASKET))
                out = [r for r in results if r]
                ranked = sorted([s for s in out if "confidence" in s], key=lambda s: -s["confidence"])
                return self._send({"source": "pinets", "interval": interval,
                                   "fetched_at": datetime.now(timezone.utc).isoformat(),
                                   "signals": out, "top": ranked[0] if ranked else None})

            return self._send({"error": "unknown route", "path": url.path}, 404)
        except Exception as exc:  # noqa: BLE001
            return self._send({"error": type(exc).__name__, "message": str(exc)[:400]}, 500)


_yf_state = {"checked": False, "ok": False}


def _yfinance_ok() -> bool:
    if not _yf_state["checked"]:
        try:
            import yfinance  # noqa: F401
            _yf_state["ok"] = True
        except Exception:
            _yf_state["ok"] = False
        _yf_state["checked"] = True
    return _yf_state["ok"]


def main():
    port = int(os.environ.get("MARKET_PORT", "8788"))
    if not _yfinance_ok():
        print("warning: yfinance is not installed (pip install yfinance); only cached data will serve",
              file=sys.stderr)
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Cairnline market service on http://127.0.0.1:{port}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
