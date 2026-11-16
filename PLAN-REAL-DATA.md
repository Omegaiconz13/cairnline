# Replacing simulated features with real engines

Research date: 2026-11-11. Sources: `github.com/LuxAlgo/*`, `github.com/londonstrategicedge/lse-data`, Yahoo Finance via `yfinance`.

---

## 1. What the rebuild currently fakes

| Where | Fake now | Real source available |
|---|---|---|
| AI Trading chart (`/chart`) | `candles()` — a seeded PRNG drawing a plausible-shaped chart | **yfinance** real OHLCV |
| Trish assistant replies | hard-coded strings with invented confidence 87 % / entry / SL / TP | **PineTS** real Pine Script on real bars → EMA/RSI/ATR/MACD → derived levels |
| Market Pulse heatmap | hard-coded `[['EURUSD', 0.24], …]` | yfinance quote deltas |
| Signal of the Day / Pulse Signals | static rows in `data.js` | indicator output on live bars + persisted `strategy_signals` |
| Quick Performance Snapshot (analyses/signals/charts today) | mock counters | real `analysis_history` / `strategy_signals` counts (live mode) |
| Position size calculator (dashboard tile) | label only | real formula (risk %, stop distance from ATR, pip value) |
| Subscription / Wallet / Tutorials / Profile | mock (live adapter exists) | Supabase read-only adapter — already shipped |
| Dashboard metrics “AI Confidence (Avg)” | `—` | mean of the real confidence column |
| No market context at all | — | **LuxAlgo market-trackers** CC0 public record (insider filings, short volume, congress trades, Fed communications) |

---

## 2. Research findings

### LuxAlgo — 15 public repos

| Repo | License | Stars | What it gives us |
|---|---|---|---|
| **PineTS** | **AGPL-3.0** (or commercial) | 940 | Pine Script® v5/v6 runtime in JS. Runs TradingView indicators unchanged on any OHLCV array. **The core win** — replaces all hand-rolled indicator math |
| **Vela** (`@luxalgo/vela`) | **Apache-2.0** | 1 296 | WebGL2 financial chart, headless core + plugin SDK. Drop-in upgrade for the hand-drawn SVG candles |
| market-trackers | MIT (code) | 45 | Pipeline that ingests 18 US public-record datasets |
| market-trackers-data | **CC0-1.0** (data) | 26 | Free daily dumps: insider transactions (17.5 k), short volume (122 k), 13F holdings (111 k), congress trades, Fed communications, lobbying, COT (empty today), patents |
| luxalgo-mcp-server | MIT | 110 | MCP surface over LuxAlgo tooling |
| trade-journal / edge-stats / prop-firm-sim / broker-sdk / whale-options / trade-relay | MIT | 33–587 | Reference implementations (journal metrics, prop-firm rules, broker adapters, options flow) |
| pinets-cli / Vela-pinets | AGPL-3.0 | 43–77 | CLI + Vela↔PineTS bridge |

**Verified locally**: `npm i pinets` (v0.13.1) accepts a plain OHLCV array and returns plot series.
Feeding it 409 real EURUSD 15 m bars from yfinance produced real values on the last bar —
EMA 9 `1.115258`, EMA 21 `1.115759`, RSI 14 `35.41`, ATR 14 `0.000455`, MACD hist `-0.000104`.

**AGPL note**: PineTS is copyleft. Running it as a local service for this rebuild is fine; if the app
is ever distributed or hosted for others, either publish the source (AGPL requires it) or buy LuxAlgo's
commercial licence. Vela (Apache-2.0) and all market-trackers data (CC0) carry no such obligation.

### lse-data (London Strategic Edge)

MIT-licensed Python client for **LSE Data 3.0**: 76 000+ instruments across 11 markets — US/UK/CA
stocks, forex, crypto, futures, indices, commodities, US options, CME Globex, Nasdaq TotalView L2/L3,
macro series and 18 reference collections. `candles()`, `stream()`, `series()`, `export()` (CSV/Parquet).

**Free plan: 50 GB/month, but it needs an API key** (sign-up). So: wire it as an optional provider that
activates when `LSE_API_KEY` is present; yfinance is the always-on default.

### yfinance

`pip install yfinance` → v1.8.0, working. Free, keyless, and the widest free symbol coverage for FX,
metals, indices, futures and equities. Confirmed live: `EURUSD=X` 15 m → 409 bars, multi-ticker download
works. Caveat found: `XAUUSD=X` does not exist — gold is `GC=F` (futures) or `XAUUSD=X` alternatives
are broker-specific, so the symbol map needs explicit aliases.

---

## 3. Architecture

Static app + one local service. Browser cannot call Yahoo directly (CORS), and PineTS needs a runtime,
so both live in one process:

```
server/
  market_service.py       # HTTP JSON API: /api/quotes /api/candles /api/indicators /api/public-record
  pinets_run.mjs          # PineTS bridge: candles JSON in → plot series JSON out
  cache/                  # TTL disk cache (quotes 30 s, candles 60 s, indicators 60 s, dumps 6 h)

app/dashboard/js/market.js # client adapter (same shape as data.js/api)
```

Endpoints:

| Route | Returns |
|---|---|
| `GET /api/health` | provider status (yfinance, LSE key, PineTS, dumps age) |
| `GET /api/quotes?symbols=EURUSD=X,GC=F,…` | last price, change %, day range |
| `GET /api/candles?symbol=EURUSD%3DX&interval=15m&range=5d` | OHLCV bars |
| `GET /api/indicators?symbol=…&interval=…&preset=core` | EMA9/21/50, RSI14, ATR14, MACD, BB, plus derived bias/confidence |
| `GET /api/public-record?dataset=insider&ticker=ARW&limit=50` | CC0 rows with provenance links |

Provider chain per request: **cache → yfinance → lse-data (if key) → cached stale**. Every response
carries `source`, `fetched_at`, and `stale` so the UI can label data honestly instead of pretending.

---

## 4. Replacement map (what changes in the app)

1. **`/chart`** — real candles from `/api/candles`; overlay real EMA 9/21/50; right rail shows a real
   indicator table (RSI, ATR, MACD hist, trend state) instead of a static "Awaiting parameters…";
   *Analyze Current Chart* runs `/api/indicators` and writes a plan from ATR-derived stop/target, not
   invented numbers.
2. **Overview → Market Pulse** — real quotes for a basket (EURUSD, GBPUSD, USDJPY, XAUUSD→GC=F, BTC-USD,
   DXY, US10Y proxy), each cell showing live % change; source + age shown.
3. **Overview → Signal of the Day** — from the indicator service: bias from EMA stack + RSI, entry/stop/
   target from ATR multiples, confidence from agreement count of the signals.
4. **Signals page** — same engine across a symbol basket, persisted to `strategy_signals` when live mode
   and the user has a plan; otherwise shown as session-only.
5. **Performance Snapshot** — real counts from `analysis_history` (live) or session counters.
6. **New page `/research`** — LuxAlgo public record: insider filings, short volume, Fed communications,
   each row linking to its primary-source document (provenance is in the data).
7. **Dashboard tiles** — position size calculator becomes functional (risk % × equity ÷ (entry−stop) ×
   pip value).

## 5. Build order

| Step | Work | State |
|---|---|---|
| 1 | `server/market_service.py` + `pinets_run.mjs` + cache | **done** |
| 2 | `market.js` client + health panel in Settings | **done** |
| 3 | `/chart` on real candles + real indicator rail + risk calculator | **done** |
| 4 | Overview: real Market Pulse + Signal of the Day | **done** |
| 5 | `/research` public-record page (insider / short volume / congress / Fed) | **done** |
| 5b | Pulse Signals page + Overview counters on the real basket engine (fake `sg_*` rows removed) | **done** |
| 6 | ~~Optional: swap SVG chart for Vela (Apache-2.0)~~ → done, see PLAN-VELA.md | **done** |
| 7 | LSE Data 3.0 as primary provider + key in Settings (see PLAN-LSE.md) | **done** |

### Measured results (2026-11-11)

- `/api/quotes` — 8 pairs, ~5 s cold, 30 s cache. `EURUSD 1.114703 -0.67%`, `XAUUSD 4066.80 +0.91%`
  (gold resolved through the `GC=F` alias).
- `/api/indicators?symbol=EURUSD&interval=15m` — PineTS on 409 real bars: EMA9 `1.115258`,
  EMA21 `1.115759`, EMA50 `1.116491`, RSI `35.41`, ATR `0.000455`, MACD hist `-0.000104`,
  bias `short` at 75 % from the EMA stack + MACD + RSI agreement.
- `/api/basket/signals` — 8 pairs ranked, top `EURUSD short 85 %`; cold run 10 s after making the
  per-symbol work concurrent (it was ~30 s sequential).
- `/api/public-record?dataset=insider` — 1 413 rows, each with an EDGAR provenance URL.
- All 14 app routes render with zero console errors; no horizontal overflow at 1440/900/390 px.

### Last pass (2026-11-12)

- **Pulse Signals** was the one page still showing invented rows (`XAUUSD 3412.40`, `EURUSD 1.08420`,
  "just now / 1d ago"). It now calls `/api/basket/signals` and sorts by confidence: 8 pairs,
  real prices (`XAUUSD 3953.7`, `EURUSD 1.10926`), RSI and R:R per row, plus a provenance line
  (`source pinets · interval 15m`) and a warn banner instead of guesses when the service is down.
- **Overview** counters no longer borrow the demo signal array: "Signals Generated" reads the usage
  counter (real `usage_counters_daily` in live mode), and the `sg_1..sg_3` fixtures were deleted
  from `data.js` so nothing can silently replay them.
- 14/14 routes re-verified in Chromium 155: zero JS errors, no overflow at 1440/900/390 px.

## 6. Honest limits

- yfinance is unofficial and rate-limited; the service caches and degrades to stale data with a label.
- Intraday FX from Yahoo is indicative, not tick-accurate; fine for analysis, not for execution.
- PineTS covers the Pine API broadly but not every builtin (see LuxAlgo's API-coverage badge); unsupported
  calls return an error the service reports rather than silently substituting a fake value.
- market-trackers datasets are US-centric and update daily.
- No broker/execution integration: the app analyses and plans, it does not place orders.
