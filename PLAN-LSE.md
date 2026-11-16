# LSE Data as primary provider — plan

Research date: 2026-11-12 · Source: https://github.com/londonstrategicedge/lse-data (v3.0, PyPI `lse-data`)

## What the repo is

A **Python client** (MIT) for LSE Data 3.0 — one HTTPS service at
`https://download.londonstrategicedge.com`, every call a GET under `/v3`, key in the
`X-API-Key` header. Not a JS library: it belongs in our Python market service, which is
already the only thing that talks to providers.

| Capability | Endpoint | Use for us |
|---|---|---|
| Candles as rows | `/v3/export` (alias `/v3/candles`), CSV → parsed | **Primary OHLCV** |
| Last 10 rows as JSON | `/v3/preview` | **Primary quotes** (cheap, no CSV) |
| Plan + usage | `/v3/usage` | Key validation + Settings status |
| Catalogue | `/v3/markets`, `/v3/pairs` | Symbol resolution |
| Live stream | `wss://data-ws.londonstrategicedge.com` | Not used yet (Vela polls) |

**Free plan**: 60 calls/min, 50 GB/month, and it includes `forex`, `crypto`, `commodities`,
`indices`, `futures`, `us_stocks`, `uk_stocks`, `ca_stocks`, `us_options`. CME Globex and
Nasdaq TotalView are paid — irrelevant to us.

**Symbols**: forex is `EUR_USD` (name `EUR/USD`), crypto is `BTCUSDT` (quoted in Tether).
The client resolves `EUR/USD` → `EUR_USD` and `BTC/USD` → `BTCUSDT` itself, and caches the
resolution per client instance.

**Timeframes**: `1s 5s 15s 30s 1m 3m 5m 15m 30m 1h 4h 1d 1w 1mo` — a superset of what we
serve today, and it has a native **4h** (yfinance does not; we currently aggregate).

## Design decisions

1. **LSE first, yfinance fallback, cache last.** Invert the current order in
   `market_service.py`. Every payload keeps `source` (`lse-data` | `yfinance`) so the UI
   stays honest; a fallback is visible, never silent.
2. **The key lives server-side only.** The browser posts it once to the local service,
   which validates it against `/v3/usage` and writes it to `server/config.json`
   (mode 600, gitignored). The key is never embedded in a page, never in a URL, and never
   returned by any GET — only a masked hint (`lse_live_…abcd`) and the plan facts.
3. **`LSE_API_KEY` env var still works** and takes precedence, so CI/headless runs need no
   config file.
4. **Rate-limit discipline.** 60 calls/min is generous but not infinite: candles cache 60 s,
   quotes 30 s, and the basket (8 pairs) is fetched concurrently but shares the cache. A
   `429` is retried once honouring `Retry-After` (the client does this), then we fall back
   to yfinance for that call rather than failing the page.
5. **Symbol map with candidates.** Gold is the one uncertain spelling (`XAU_USD` in forex
   vs a commodities symbol). The provider tries candidates in order and caches the winner,
   so a wrong guess costs one call, once.
6. **4h becomes native** on LSE; the yfinance path keeps its 4×1h aggregation.

## Implementation

### Server (`server/market_service.py`)

| Piece | Detail |
|---|---|
| `CONFIG_PATH` | `server/config.json`, `chmod 600`, gitignored |
| `load_config()` / `save_config()` | read/write `{"lse_api_key": "…"}` |
| `lse_key()` | env `LSE_API_KEY` → config file → `None` |
| `lse_client()` | cached `LSE(api_key=…)`, rebuilt when the key changes |
| `LSE_SYMBOLS` | `EURUSD→EUR_USD`, `GBPUSD→GBP_USD`, `USDJPY→USD_JPY`, `AUDUSD→AUD_USD`, `USDCHF→USD_CHF`, `EURJPY→EUR_JPY`, `GBPJPY→GBP_JPY`, `XAUUSD→[XAU_USD, GOLD]`, `BTCUSD→BTCUSDT`, `ETHUSD→ETHUSDT` |
| `LSE_TF` | `1m→1m, 5m→5m, 15m→15m, 30m→30m, 1h→1h, 4h→4h, 1d→1d, 1wk→1w, 1mo→1mo` |
| `fetch_lse_candles()` | `client.candles(sym, tf, start=<period start>, limit=…)` → bars with `openTime` ms |
| `fetch_lse_quotes()` | `client.preview(market, sym, '1d')` → last two daily closes → price + `change_pct` |
| `GET /api/config` | `{lse:{configured, key_hint, plan, markets, calls_per_minute, weekly, withheld, error}}` |
| `POST /api/config/lse` | body `{key}` → validate via `usage()` → save → return the same shape |
| `DELETE /api/config/lse` | remove key, return `{configured:false}` |
| `/api/health` | `lse: bool`, `lse_plan` |

### Client

| File | Change |
|---|---|
| `js/market.js` | `config()`, `setLseKey(key)`, `clearLseKey()` |
| `js/pages/account.js` (Settings) | **Data providers** card: key input (password), Save / Remove, live status (plan, calls/min, weekly used, withheld reason), and a line stating the fallback order |
| `js/pages/terminal.js` | source note already prints `candles.source`; add the provider name to the chart bar |

## Verification

1. `POST /api/config/lse` with a bogus key → `401 key-unknown` surfaced in the UI, nothing saved.
2. With a real key: `/api/config` shows plan `free`, 60 calls/min, weekly allowance.
3. `/api/candles?symbol=EURUSD` → `source: "lse-data"`, bars ascending, ms open times.
4. Kill the key (DELETE) → same call returns `source: "yfinance"` — fallback proven, not assumed.
5. Chart page renders LSE bars; 4h works natively.
6. `config.json` is `600` and absent from git.

## Honest limits

- No key is bundled: without one the app runs exactly as today on yfinance.
- LSE free plan is 60 calls/min; a cold basket + indicators can approach that, so caching
  stays mandatory and the UI must show `source` per payload.
- The live WebSocket stream is not wired (Vela polls); it is the natural next step and
  would remove the polling cost entirely.
- `us_options`/CME/Nasdaq feeds are out of scope.
