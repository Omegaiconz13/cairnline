# Vela adaptation plan — /dashboard/#/chart

Research date: 2026-11-12 · Source: https://github.com/LuxAlgo/Vela (v0.10.6, npm `@luxalgo/vela`)

## Why Vela

LuxAlgo's open-source charting core: native WebGL2 renderer (canvas2d fallback), pan/zoom,
crosshair, 70+ built-in native studies, a drawing toolset, themes, and a pluggable data-provider
port. Replaces our hand-rolled SVG candle renderer, which has no pan/zoom, no crosshair, no
interactive indicators and fake toolbar buttons.

## Licensing (verified from the repos)

| Piece | License | Decision |
|---|---|---|
| `@luxalgo/vela` core (incl. renderer, native indicators, providers, theme) | **Apache-2.0** | Vendor it. Attribution mark stays enabled — the NOTICE requires a visible mark on every screen that renders a chart. |
| `@luxalgo/vela-pinets` (Pine engine addon) | **AGPL-3.0** | **Skip.** Pine stays server-side in `market_service.py` (PineTS). Client-side studies come from Vela's native indicators. |
| `@luxalgo/vela/workspace` + `@luxalgo/vela-ui` | Apache, but pulls the Zag.js dependency tree | **Skip.** Their ESM build imports bare `@luxalgo/vela-ui/*` / `@zag-js/*` specifiers — would need an import map with dozens of packages for a no-build static app. Our own chrome is already built. |

## Architecture decision

**Bare `Vela` core via the self-contained browser build + our existing chrome.**

- `dist/vela.global.min.js` (1.3 MB, single file) → `window.Vela` — no bundler, no import map,
  no transitive deps. The workspace is *not* in this build; that's accepted: we keep our
  symbol select, interval tabs, Trish rail and risk calculator, which are already integrated
  with the data service and match the Pipnex theme.
- Data flows through Vela's **DataProvider port**: our own provider over `market_service.py`,
  so Vela owns caching, routing, chunked history, live polling and indicator recomputation.

## The Pipnex data provider

Custom provider (plain object) against `/api/candles`:

- `getBars(ticker, timeframe, range)` — Vela timeframes map to yfinance intervals:
  `'1'→1m(5d) · '5'→5m · '15'→15m · '30'→30m · '60'→1h(3mo) · '240'→aggregated 4×1h(1y) ·
  'D'→1d(5y) · 'W'→1wk · 'M'→1mo`. Bars already carry epoch-ms open times
  (`openTime`) — exactly Vela's contract — but we still sort + de-dupe defensively.
  Timeframes yfinance can't serve throw `DataUnavailableError({ reason:'timeframe', default:'60' })`.
- `listSymbols()` — our basket (EURUSD… GBPJPY, XAUUSD→gold alias, BTC-USD) as
  descriptors with prefix `PIPNE`, which powers Vela's symbol routing and any search UI.
- `getSymbolInfo(ticker)` — `timezone: 'Etc/UTC'`, FX/gold `volume:false` (yfinance FX bars
  carry 0.0 volume), BTC `volume: true`.
- No `subscribe` → Vela **polls `getBars`** automatically for the forming candle (live mode
  with no WebSocket needed).

## Integration into terminal()

- Keep: Trish rail (facts, PineTS summary, chat), risk calculator, analyze flow, upload page.
- Replace: the SVG canvas + fake toolbar buttons with a mounted `Vela` chart. Keep a slim
  bar above it (Back link, live price ticker from `/api/quotes`, source note, refresh).
- Sync: `chart.on('market:changed')` updates `state.sym/interval` and re-runs the PineTS
  analysis for the rail. Our select/tabs were removed in favour of Vela's chrome (chart's
  own pan/zoom/timeframe via setMarket from our quick pills — kept, wired to `setMarket`).
- Theme: `createTheme({ colors: { background:'#050505', text:'#F5F7F8', grid:'#1a1b1e',
  border:'#26272A', up:'#B4FF3A', down:'#FF5A5F' }, accent:'#E50914' })`, registered as `'pipnex'`.
  (up/down drive candles, wicks and current-price line; accent drives chrome.)
- Seeded studies: EMA 9 / 21 / 50 overlays (`addNativeIndicator('ema', { inputs:{ length } })`)
  + RSI 14 in its own pane. More (BB, MACD, VWAP, Supertrend…) come free from Vela's catalog.
- **Signal plan overlay** (new capability): after "Analyze", the PineTS plan is drawn on the
  chart as real drawings — `chart.drawings.add('hline', { anchors:[{price}] })` for entry
  (white), stop (rose) and target (lime), so the trade plan is visible on the price, not just
  in the rail.

## Fallback

If `window.Vela` is absent (script blocked/cached-out), `terminal()` keeps the previous SVG
path, so the page degrades instead of blanking.

## Build steps

| Step | Work | State |
|---|---|---|
| 1 | Vendor `vela.global.min.js` + LICENSE + NOTICE under `app/dashboard/vendor/vela/` | done |
| 2 | Script tag in `dashboard/index.html` (before modules) | done |
| 3 | `js/vela-provider.js` — PipnexProvider over the market service | done |
| 4 | `terminal()` Vela mode + slim bar + market sync + fallback | done |
| 5 | Pipnex theme + seeded EMA×3 + RSI pane | done |
| 6 | Plan overlay (entry/stop/target hlines) on analyze | done |
| 7 | Headless verification: paint, switch symbol/timeframe, indicator legend, drawings, no console errors | done |

## Honest limits

- Without the workspace there is no built-in symbol-search dropdown or persistence; state is
  per-session. The upgrade path (import map + `@luxalgo/vela-ui` + Zag) is documented above
  if wanted later.
- The AGPL Pine addon stays out on purpose; server-side PineTS keeps the Pipnex rebuild
  Apache-clean on the client.
- The attribution mark must remain visible (license requirement) — it is not disabled.
- yfinance intraday depth still applies (1m ≈ 7 days, 5m–30m ≈ 60 days), now surfaced by
  Vela's chunked backfill rather than a fixed range.
