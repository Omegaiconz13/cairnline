# Market data service

Real market data and real indicator values for the static dashboard. The browser
cannot call Yahoo directly (CORS) and PineTS needs a JS runtime, so both run here.

```bash
pip install yfinance                  # free provider, no key
npm install pinets                    # or: ln -s <dir with pinets> server/node_modules
python3 server/market_service.py      # http://127.0.0.1:8788
```

The dashboard finds it on `http://<app host>:8788`. Override with
`?market=http://127.0.0.1:9999` on the dashboard URL, or store
`cairnline_market_api` in localStorage.

## API keys

Secrets live in `server/.env` (gitignored, mode 600), never in `config.json`:

```bash
cp server/.env.example server/.env    # then set LSE_API_KEY=…
```

A real `LSE_API_KEY` environment variable wins over the file, so CI and headless runs need no
file. Saving a key from the dashboard's Settings page writes it to `server/.env`, not to
`config.json` — that file holds ordinary configuration and is safe to share.

## Endpoints

| Route | Provider | Cache |
|---|---|---|
| `GET /api/health` | local | — |
| `GET /api/quotes?symbols=EURUSD,GBPUSD,…` | yfinance | 30 s |
| `GET /api/candles?symbol=EURUSD&interval=15m&range=5d` | yfinance → lse-data | 60 s |
| `GET /api/indicators?symbol=EURUSD&interval=15m&preset=core\|smc` | PineTS | 60 s |
| `GET /api/basket/signals?interval=15m` | PineTS over 8 pairs, concurrent | 60 s per pair |
| `GET /api/public-record?dataset=insider\|short-volume\|congress\|fed&limit=40&ticker=AAPL` | LuxAlgo market-trackers-data (CC0) | 6 h |
| `POST /api/backtest` — `mode: run\|optimize\|validate` | local engine (`backtest.py`) over LSE → yfinance bars | — |
| `GET /api/options-flow?underlying=SPY&window=7d` | LSE Data 3.0 options chain + tape: flow, tape-weighted GEX, max pain, whale score, repriced gamma flip, call/put walls, IV smile (`options_flow.py`) | — |
| `GET /api/paper` | local paper ledger (`paper_trader.py`) + live marks | — |
| `POST /api/paper/{order,close,kill,rails,deploy,cycle}` | local paper ledger; fills at the live quote | — |

`server/trish_mcp.py` speaks MCP over stdio (20 tools, `--selftest` to check
it); see `server/mcp/README.md` for registration.

Every payload carries `source`, `fetched_at` and (when serving cached data after a
provider failure) `stale` + `error`, so the UI never presents stale data as live.

## Providers and licences

- **yfinance** — free, keyless, unofficial. Rate-limited; the service caches and degrades to
  labelled stale data.
- **PineTS** (`npm i pinets`, AGPL-3.0) — runs the Pine Script in `pinets_run.mjs` on real OHLCV.
  AGPL is copyleft: fine for local use; publishing this app means publishing the source or buying
  LuxAlgo's commercial licence.
- **LSE Data 3.0** (`pip install lse-data`, MIT) — activates only when `LSE_API_KEY` is set in
  the environment or `server/.env`.
  Free plan is 50 GB/month but requires a sign-up key.
- **market-trackers-data** (CC0-1.0) — daily dumps of the US public record with a primary-source
  provenance link on every row.

## Symbol map

Broker-style names are translated in `SYMBOL_MAP`. Gold is `GC=F`, not `XAUUSD=X` (which does not
exist on Yahoo); DXY is `DX-Y.NYB`, US 10-year is `^TNX`, BTC is `BTC-USD`.

## Cache

`server/cache/*.json`, TTLs in `TTL`. Safe to delete at any time.

## What is still not real

- Screenshot → vision analysis (Upload Chart): needs a vision model, not wired.
- Order placement / MT5 execution: out of scope, no broker integration. The
  Paper Desk fills locally at the live quote and never contacts a broker, and it
  does not watch stops between requests.
- Intraday FX from Yahoo is indicative, not tick-accurate.
