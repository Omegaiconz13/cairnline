# Chart page fixes, LuxAlgo plan, Pipnex gap analysis

Written 2026-11-17. Scope: the `#/chart` page (Cairnline AI Trading), what
LuxAlgo publishes for free that we can legally build on, and what Pipnex AI
ships that we do not.

## 1. Chart page — fixed in this pass

| Problem | Cause | Fix |
|---|---|---|
| 4h timeframe produced no indicators | `/api/indicators` only called `fetch_candles`; Yahoo has no 4h interval, so every 4h request failed and the rail fell back to stale data | `bars_for_analysis()` in `market_service.py`: LSE first (native 4h), then yfinance, then `aggregate_bars(1h × 4)` for the no-LSE path. Verified: 1,614 bars, live, RSI 39.35 |
| Rail numbers mislabelled on 4h | `TF.fromVela[TF.toVela['4h']]` resolves `240 → '1h'`, so 1h indicators were displayed as 4h | new `PY_INTERVAL` map used for the PineTS rail; the Vela timeframe map is now only for the chart |
| "· live quote" appended on every 30 s tick | `innerHTML` write followed by `insertAdjacentHTML` | single innerHTML write |
| Page could crash on a partial indicator response | `s.bias.toUpperCase()` and `s.reasons.join()` assumed both exist | guarded (`String(s.bias ?? 'neutral')`, `(s.reasons ?? [])`) |
| Risk calculator could read stale numbers | `cairnline:indicators` was dispatched before the box was repainted | dispatched after repaint, including the empty state |

### Indicator dropdown (new)

A single `Indicators` control in the chart toolbar, listing every study Vela
registers that this build can draw: **24 on the price** (21 studies + three EMA
presets) and **54 in their own pane** — **78 rows**, because two of the 77
registry studies are excluded (see below).

- `chart.addNativeIndicator(type, { inputs })`, reconciled by `syncIndicators()`;
  removal is `handle.remove()` (this build has no `chart.removeIndicator`).
- Selection persists in `localStorage.cairnline_indicators`; default is the old
  seed set (EMA 9/21/50 + RSI), so nothing changes for an existing trader.
- The count badge reads the live selection; menu closes on outside click or
  Escape and carries `role="menuitemcheckbox"` + `aria-checked` for screen readers.
- Adding a study needs no wiring at all: the menu reads the registry, so a
  study Vela registers appears in it; there is no `INDICATORS` list to edit.

Every active study carries its own controls: an **eye** that hides it without
removing it (inputs, pane and placement stay), a **placement switch** between the
price pane and a pane of its own, a **pane-height stepper** (weights 1–8 through
`panesControl.setHeightWeight`), maximise/collapse, and the schema-driven inputs
panel. Visibility, placement and geometry are saved per study in
`localStorage.cairnline_indicator_layout` and re-applied after a reload; Vela's
own hover controls and legend eye are mirrored into the same store via
`pane:changed` / `indicator:moved` / `indicator:visibility`, so the two surfaces
cannot disagree.

Two of the 77 registry studies are excluded, with reasons in the code
(`EXCLUDED_STUDIES` in `terminal.js`): `volume` and `vpvr` add, remove and accept
inputs but draw nothing (checked on EURUSD and BTCUSD by reading
`chart.inspect()`), so they would be blank rows in the menu and the legend.
Everything else is offered: **75 studies + 3 EMA presets = 78 rows**, 24 on the
price and 54 in their own panes.

Known remaining limits: the fallback SVG renderer (no Vela) only draws EMA
overlays, so the menu changes nothing there; pane heights use a stepper rather
than a drag handle.

## 2. LuxAlgo — what is actually free, and what we may ship

LuxAlgo publishes **15** public repositories. Every licence below was re-checked
against the repository's own `LICENSE` through GitHub's `/license` API on
**2026-11-18** (the Library row is not a repo — it comes from
<https://www.luxalgo.com/library/license/>). Vendored artefacts were read from
disk as well: Vela's Apache text and NOTICE, PineTS's AGPL text in
`server/node_modules/pinets/LICENSE`, and the MIT notices for prop-firm-sim and
the edge-stats presets. The full inventory (stars, what each is for, what we
would take) is in `RESEARCH-2026-11-17.md` §1, the consolidated licence
comparison in §4.1 of that file, the per-repo verification in §6, and the
guardrails in §4.

| Repo | What it gives us | Licence | Usable in a paid product? |
|---|---|---|---|
| **Vela** | The charting core we already vendor (`app/dashboard/vendor/vela`) — **75 of its 77** native studies are offered plus three EMA presets (two excluded because they draw nothing) | Apache-2.0 (+ NOTICE) | **Yes**, keep copyright, NOTICE and the visible Vela attribution |
| **PineTS** | Pine Script runtime — already our indicator engine (`server/pinets_run.mjs`) | AGPL-3.0 (or commercial) | **Only with care**: network use triggers source-release for the whole app |
| **Vela-pinets** | Pine indicators running in-process or a Web Worker on Vela | AGPL-3.0 | Same AGPL constraint |
| **pinets-cli** | Command-line PineTS: run a `.pine` file against bars | AGPL-3.0 | Dev tool only, same constraint |
| **edge-stats** | The 42-preset catalog behind Edge Stats; its definitions are vendored and answered by our own engine | MIT | **Yes** — shipped as workstream C2 (2026-11-17, §5.6) |
| **prop-firm-sim** | Prop-firm rule simulator (vendored in `app/dashboard/vendor/luxalgo/` with its NOTICE) | MIT | **Yes**, already shipped |
| **whale-options** | Options prints scoring, GEX, max pain | MIT | **Yes** — shipped as workstream C3 (2026-11-17, §4b); its method was reimplemented, not vendored |
| **broker-sdk** | Normalised broker/exchange API: accounts, positions, history, performance | MIT | **Yes** — not vendored; C6 reimplemented the account shape for the paper desk, and real broker accounts are still unbuilt |
| **trade-relay** | Order/event relay between a strategy and a broker | MIT | **Yes** — not vendored; C6 reimplemented its 14 rails in `server/paper_trader.py` |
| **trade-journal** | Trade journal + performance analytics | MIT | **Yes** — fits the Wallet/account surface |
| **market-trackers** | Pipeline for congress trades, insider filings, 13F, contracts, lobbying, short volume, patents, hearings, Fed comms | MIT | **Yes** |
| **market-trackers-data** | Daily dumps of the above, JSON + Parquet, provenance per row | CC0 | **Yes**, no attribution required |
| **luxalgo-mcp-server** | The ecosystem as MCP tools for agents | MIT | **Yes** as code; their hosted service is not part of the licence — dev tooling only |
| **cla-signatures** | CLA tooling for their org | **Unverified — no licence file** (GitHub `/license` → 404, re-checked 2026-11-18) | **No grant** — not used |
| **.github** | Org defaults | **Unverified — no licence file** | n/a — no code |
| **LuxAlgo Library** (indicator source, not one of the 15) | Hundreds of studies: SMC/ICT, Wyckoff, Elliott, patterns, ML | **CC BY-NC-SA 4.0** | **No.** NonCommercial + ShareAlike; using them to trade your own account is fine, shipping them in a paid product is not |

Two decisions fall out of that table:

1. **Do not copy LuxAlgo Library indicator source into Cairnline.** It is the
   most tempting shortcut (SMC, order blocks, liquidity sweeps — exactly what
   Pipnex's Lens advertises) and the one that breaks the licence. Reimplement
   concepts in our own Pine/PineTS presets instead; ideas are not copyrightable,
   their code is.
2. **PineTS/AGPL is a live risk for a hosted SaaS.** Today it runs on the user's
   own machine, which is the low-risk case. The moment analysis runs on our
   servers for paying users, AGPL §13 asks for the corresponding source. Either
   keep PineTS client-side/local, or buy LuxAlgo's commercial licence, or keep
   our own indicator math server-side.

### OpenMarket — the comparator that is not a source (2026-11-18)

OpenMarket (openmarket.xyz) is the nearest commercial neighbour to Cairnline:
one canvas over stocks, crypto, futures, options, forex and prediction markets,
with an order-flow suite, a twelve-indicator options suite, a strategy tester,
and **wrun** — its own TypeScript-to-WebAssembly indicator engine with a paid
indicator registry. It is closed source: no repository, no licence instrument in
any of the pages read. The full inventory, the options math it publishes and the
licence boundary are in `RESEARCH-2026-11-17.md` §8; this is only the effect on
our roadmap.

Where it changes what we think about our build:

- **Options.** They ship twelve chart-native indicators off a Deribit board with
  open interest (GEX profile/heatmap/curve, walls, gamma flip, IV smile, term
  structure, surface, vol matrix, implied move, flow pulse). We have one page,
  tape-weighted, because LSE's free feed carries no open interest. Breadth here
  is a feed problem before it is a code problem — do not fake OI.
- **Backtesting.** Their `strategy()` file declares its own commission, slippage
  and (in perps mode) leverage, maker/taker fees and funding, and their docs
  publish every stat formula with its edge cases. Ours works, but the cost model
  is a parameter of the run, not of the strategy document — that is the concrete
  gap worth closing before adding more stats.
- **Distribution.** A published wrun package is versioned on their registry, run
  in the reader's browser (or their servers), and monetised through an Access
  API driven by Stripe, Patreon, Discord or Whop. Our C7 MCP server is local
  tooling, not a marketplace; a registry is a product decision, not a sprint.
- **What we will not copy.** Their indicator packages (other authors' work), their
  docs text, or the words "dealer positioning" — that estimate is built from
  Deribit's trade tape, which we do not have. Standard options math (Black-Scholes
  greeks, GEX, max pain, risk reversals) is textbook and reimplementable.

### Exploitation plan, cheapest first

**Phase A — more value from what is already vendored (days) — SHIPPED 2026-11-17**
- The dropdown is now built from Vela's own registry at runtime
  (`nativeIndicatorDescriptors()`), so it lists **75 of the 77** native studies
  plus the three EMA seeds — 78 rows, 24 on the price and 54 in their own panes —
  searchable, grouped into price overlays and own-pane studies. The two excluded
  (`volume`, `vpvr`) are documented in `EXCLUDED_STUDIES`. Nothing is hard-coded,
  so a study cannot drift out of existence
  again (the previous list shipped five ids Vela does not know: `bb`, `adx`,
  `cci`, `obv`, `atr`).
- Per-study inputs are editable from the tick menu's gear, driven by the live
  schema (`handle.inputs`) — number, select, colour and checkbox fields, with
  values persisted in `cairnline_indicator_inputs` and applied through
  `handle.setInput`.
- Removal goes through `handle.remove()`; this vendored build has no
  `chart.removeIndicator`, which is why unticking a study used to leave it on
  the chart.
- **Pane controls — done 2026-11-17.** `chart.panesControl` is the supported
  facade (`supported`, `list()`, `collapse(id, on)`, `maximize(id | null)`,
  `setHeightWeight()`, `moveIndicator()`), gated on the renderer capability
  `paneManagement`, and the renderer already draws hover controls
  (`.vela-pc-btn`, `data-role` `up`/`down`/`collapse`/`maximize`). Every own-pane
  study in the Indicators menu now has a maximise/restore and a collapse/expand
  button wired to that facade, keyed off the study's pane id, so it works for
  any registry study. Verified on the running chart: maximise and collapse take
  effect and restore, other panes and all study inputs are untouched, and
  removing/re-adding a study afterwards is clean (`checks/chart-pane-controls.png`).
  Still missing: layout is not persisted across reloads, and pane height weights
  have no drag handle in our chrome.

**Phase B — Vela-pinets in the browser (1–2 weeks)**
- Run Pine indicators in a Web Worker beside the chart, which removes the
  round-trip to `market_service` on every symbol or timeframe change and makes
  the rail match the chart exactly.
- Keep AGPL exposure local-first: the engine ships to the browser, the source is
  already public in `vendor/`, and no server-side paid use is introduced.

**Phase C — market-trackers as a real Research page (1–2 weeks)**
- Import the CC0 dumps (congress trades, insider filings, 13F, short volume) into
  a local SQLite/Postgres and replace the current placeholder dataset lists.
- Every row keeps its primary-source link, which is the honest-data posture
  PRODUCT.md already commits to.
- This is the cheapest differentiator against Pipnex: they have no public-record
  surface at all.

**Phase D — broker-sdk instead of pretend broker pages (3–4 weeks) — C6 SHIPPED 2026-11-17**
- `Manage Bots` / `Auto Trading` are still placeholders, but the order path they
  needed now exists: `server/paper_trader.py` **reimplements** broker-sdk's
  read-only schema shape and trade-relay's rail list in our own code rather than
  vendoring either. Paper only — no broker is contacted, no key is stored.
- Real read-only broker accounts are the next step and still need broker-sdk
  itself plus keys held locally (never on a server).

**Phase E — commercial negotiation (as needed)**
- If the product needs LuxAlgo Library studies or hosted PineTS, talk to LuxAlgo
  about a commercial licence rather than testing the AGPL/NC boundary.

## 3. Pipnex AI — feature gap

Pipnex's public pages advertise: AI market analysis, chart upload & pattern
recognition, live TradingView charts, Backtesting Studio, AI Strategy Builder,
PropPass, market heatmap, position size calculator, Pulse signals (1–2/day),
Signal of the Day, AI news analysis around NFP/CPI, Trade Lens Chrome extension,
MT5 connection, cloud bots + free VPS, voice interaction, 10 MT5 accounts,
referral cash payouts, plus a Play Store app. Plans: Pro $49.99, Ultimate
$99.99, Platinum $299.99.

| Pipnex capability | Cairnline today | Gap / next step |
|---|---|---|
| AI market analysis (entry/stop/target) | Real: PineTS summary, bias, confidence, reasoned plan | Parity. Ours is computed from live bars, not narrated |
| Chart upload + pattern recognition | Multi-timeframe upload, confluence table, levels from live bars | Parity, and honest about not reading pixels |
| Live TradingView charts | Vela (Apache-2.0) with drawings, 75 of 77 native studies offered | Parity on charting; no TradingView embed needed |
| Backtesting Studio | **Shipped** — `#/backtest`: strategy file, costs, next-open fills, metrics, Monte Carlo, sweep, trades replayed on Vela | Parity on bars; tick-level fills still need a licensed feed |
| Options flow | **Shipped** — `#/options-flow`: live LSE prints, gamma exposure by strike, max pain, whale score with components | No open interest in the free feed, so exposure and max pain are trade-weighted; full OI-based GEX needs a paid tier |
| AI Strategy Builder | **Partial** — a strategy file (`cairnline-strategy/1`) round-trips through Backtest Studio, gets validated, and can be deployed to the Paper Desk, which takes one decision per cycle. The *prompt → strategy* authoring step is still missing (bots page is a shell) | Prompt→strategy generation on top of the existing strategy file |
| PropPass | Prop Firm Sim page exists | Wire real drawdown/compliance rules to the simulator |
| Market heatmap | **Missing** | Cheap: currency-strength grid from our quotes endpoint |
| Position size calculator | Shipped, sized from the live ATR stop | Parity |
| Pulse signals / Signal of the Day | Pulse Signals page + basket endpoint | Parity |
| AI news analysis (NFP/CPI) | Economic calendar endpoint + Research page | Partially; add an event-driven note in the rail |
| Trade Lens Chrome extension | `Cairnline Lens` page only | Extension is a real Pipnex moat; out of scope until the page is finished |
| MT5 connection, cloud bots, VPS | **Missing** — the Paper Desk is local paper trading, not MT5 execution | Deliberately out: needs infrastructure we do not have |
| Voice interaction | **Missing** | Low priority; browser Speech API is a weekend project |
| Referral cash payouts | Refer & Earn page, links gated behind `BRAND_DOMAIN` | Needs a payout processor before it can be real |
| Mobile app | **Missing** | PWA manifest first; store listing later |

Sequenced recommendation: **indicator presets → backtesting studio → heatmap →
market-trackers research → broker-sdk paper trading**. Those four are all buildable
from components we already vendor or from CC0/MIT data, and together they cover
the Pipnex features a trader actually uses daily.

## 4. Backtest Studio (workstream C4, shipped 2026-11-17)

`server/backtest.py` is the engine; `POST /api/backtest` runs it; the page is
`app/dashboard/js/pages/backtest.js` at `#/backtest`.

What it assumes, because a backtest is only honest if its fills are stated:

- a signal is decided on a **closed** bar and filled at the **next bar's open**;
- slippage is charged against the fill on both sides, commission in bps of
  notional on both sides;
- every position has an ATR stop and an R-multiple target, and when a bar spans
  both the **stop** is assumed to have hit first;
- size = risk % of current equity ÷ stop distance, one position at a time.

Three strategies: `ema-cross` (trend state), `rsi-reversion` (buy oversold /
sell overbought, exit at the midline) and `breakout` (Donchian). The page builds
its parameter inputs from `GET /api/backtest/strategies`, so the form cannot
drift from the engine's defaults.

**The strategy file.** A run is one JSON document (`cairnline-strategy/1`):
`{ strategy, market: {symbol, interval, range}, costs: {commission_bps,
slippage_bps}, balance, risk_pct, params }`. `Save strategy file` downloads the
current form; `Load strategy file` validates the strategy id against the engine
and fills the same form, so the request the engine sees is identical either way.
That is the plan's "strategy file → costs → metrics → replay" path: the file is
the strategy definition, not a Pine script — PineTS `strategy.*` stays AGPL and
off the server path, and `brue` is 0.0.1, exactly as §2's out-of-scope notes say. The optimiser sweeps one parameter and reports
the first and second half separately — a fit that only works once is labelled
`ONE HALF ONLY` rather than being recommended. Monte Carlo bootstraps the
strategy's own trades at the same risk, so it answers "the same edge in a
different order" and says so.

Sample sizes below 30 trades are called out as noise in the response itself.

**Replay on Vela.** `Show trades on chart` hands the finished run to the chart
page, which draws it with Vela's own marks API: `chart.marks`
(`defineGroup` / `add` / `clear`, gated on `marks.supported`) puts a green or red
glyph on each entry bar and a blue or grey one on each exit bar, so a trade list
becomes something you can see on the candles. The ticker line shows
`Clear N backtest marks` while a run is drawn. The chart follows the run's own
symbol and interval, and the marks paint as soon as that symbol's bars are in
(the first 4h fetch can take ~10 s; the paint retries for 14 s). This build has no `ReplayControl`
wired up, so "replay" here means the trades landing on their real bars, not a
bar-by-bar play button.

## 4b. Options Flow (workstream C3, shipped 2026-11-17; levels + smile 2026-11-18)

`server/options_flow.py` is the engine; `GET /api/options-flow` is the route;
the page is `app/dashboard/js/pages/options.js` at `#/options-flow`, linked from
the Overview "Your Tools" card and from the sidebar.

**What the feed gives, verified against live responses.** LSE Data 3.0's
`/v3/options/chain` returns strike, expiry, type, last price, today's volume,
today's premium, IV and the newest Greeks with the underlying price;
`/v3/options/flow` returns the prints with size, dollar premium, IV and the
Greeks of that minute. 14,139 underlyings are listed.

**What it does not give, and what that forced.** No open interest anywhere in
the payload (the client passes the response through unmodified); no exchange
condition codes; no bid/ask. So:

- **Gamma exposure** = Γ × contracts × 100 × S² × 0.01 per strike, calls
  positive, puts negative, weighted by the contracts that actually traded in the
  window — chain `volume_today` first (it was zero for every SPY contract), the
  tape second. `gex.basis` names which was used, so the number cannot be
  mistaken for OI-based GEX.
- **Max pain** uses the same traded-contract weights, publishes the whole payout
  curve and lists the ten cheapest strikes so the minimum can be checked.
- **Whale score** is five weighted 0–1 components — size, breadth,
  concentration, short-dated lottery share, IV richness — each returned with the
  input it was computed from. `block` vs `print` is a ≥50-contract convention
  because the tape has no condition codes; the aggressor side is reported as
  unknown rather than guessed.
- Every payload carries `source`, `feed`, `generated_at`, `as_of` (the newest
  Greeks or print timestamp) and an `unavailable` list with a reason per missing
  metric. When the provider has nothing, the engine returns `available: false`
  with that reason and the page renders "Options data unavailable" — no sample
  prints, no invented notional.

**Levels and the IV smile (added 2026-11-18).** The chain carries IV, gamma and
`dte` per contract, so the board can be repriced — three metrics built on that,
still on traded-contract weights:

- **Gamma flip** (`levels.gamma_flip`): the price nearest spot where net
exposure crosses zero, recomputed at every candidate price in ±25% of spot in
0.5% steps. Each leg is repriced with Black-Scholes gamma (zero rate, no
dividend yield) from its own IV and `dte`, with IV held at its quoted level; a
same-day or `dte`-less contract is modelled at one day rather than dividing by
zero, and the payload says so. It is deliberately **not** the cumulative strike-sum
crossing — that older number stays as `gex.flip_strike` — because the running
sum is not exposure at any one price. `legs_with_iv / legs` discloses how much of the board was actually repriced.
The payload carries the crossings, not a 101-point curve — nothing plotted it.
- **Call / put walls** (`levels.walls`): the largest call exposure above spot and
the largest put exposure below it, each with its distance and dollar exposure.
- **IV smile** (`iv_smile`): IV by strike for the three nearest expiries, using
an out-of-the-money stitch (puts below spot, calls above). Spot stands in for the
forward because the feed publishes none; only strikes with a published IV are
drawn, and the page's y-axis spans the 5th–95th percentile with that clip stated
so deep wings cannot flatten the near-the-money smile. "Nearest IV" is the
closest listed strike, not an interpolation at spot.

When the board cannot be repriced, or no expiry has enough IV points, the metric
returns `available: false` with its reason and the metric joins the `unavailable`
list — no substitute number is printed.

**Licence.** The engine is ours; no LuxAlgo Library (CC BY-NC-SA) code is used
and whale-options' method was reimplemented rather than vendored. The data stays
LSE's: this is a single-user local page reading the operator's own key, which is
permitted internal use under LSE ToS §6 — serving these candles or prints to
other users would need LSE's written permission first.

## 4c. Validation — C5 (shipped 2026-11-17)

`POST /api/backtest` with `mode: "validate"`; the checks live in
`server/backtest.py` (`walk_forward`, `optimal_risk`, `validate`), and the page
is the **Validate** button in `#/backtest`.

A sweep answers "which settings fit this history". Validation asks the question
the plan actually wanted — *does the setting hold up* — with five named checks,
all reported whether they pass or fail:

1. **Out-of-sample folds.** Expanding in-sample window, parameters chosen on it,
   then traded unchanged on the next segment, with a 20-bar **embargo** dropped
   at the boundary so a stop cannot resolve across it. Needs at least two folds
   to count; one fold is reported as "robustness was not demonstrated".
2. **Plateau, not spike.** The whole simulated grid is reported: if the best cell
   sits alone among losers, it is a fit, not an edge.
3. **Doubled costs.** The same setting with 2× commission and 2× slippage.
4. **Sample size.** Out-of-sample trades, 30 is the floor.
5. **Risk cap.** `optimal_risk()` bootstraps the trade R-multiples at nine risk
   levels and returns the largest one whose p95 drawdown stays under the cap
   (20% default); "none" is a real answer.

Verdict is `holds up` only when all five pass, `partly holds up` at three or
more, otherwise `does not hold up`. Every payload carries the leader, the grid,
the fold rows, the surface, the cost-stress result, the Monte Carlo and the
verdict sentence — no single number to take on faith.

## 4d. Paper Desk — C6 (shipped 2026-11-17)

`server/paper_trader.py` is the engine; `GET /api/paper` and the
`POST /api/paper/{order,close,kill,rails,deploy,cycle}` routes; the page is
`app/dashboard/js/pages/paper.js` at `#/paper`, linked from the sidebar,
Overview and Backtest Studio's **Deploy to paper desk**.

**What it is.** A local paper account with a real order path: 14 rails checked
server-side on every submit, fills priced from the **live quote** plus slippage,
a flight recorder that stores every check, and a kill switch. trade-relay's rail
list and broker-sdk's schema shape were reimplemented, not vendored; `broker`
reads `none — no order leaves this machine` in every payload.

**Rails** (all enforced in `submit()`, so a deployment cannot skip them):
kill switch · symbol allowlist · trading hours (UTC) · a live quote exists ·
stop on the losing side · minimum reward:risk · positive size · risk per trade
≤ 2% of equity · notional ≤ 1000% of equity · open positions < 3 · day loss
< 3% · orders/day < 10 · duplicate protection.

Two definitions that had to be chosen, and are stated here because they are
definitions rather than facts:

- **Duplicate** means the *same* order (symbol, side, size, stop, target)
  resubmitted inside 60 s. A second entry after the first was closed is a new
  decision. The first implementation compared only symbol and side and blocked
  legitimate re-entries; that was a defect, fixed and re-verified.
- **Notional cap.** FX notional is levered: 1% risk on a 12-pip stop already
  implies ~7× equity. Risk per trade is the real cap; the notional rail exists to
  stop runaway unit counts, and a deployment **sizes down** to it instead of
  being refused (that too was a defect found in verification).

**Deployments.** `POST /api/paper/deploy` takes the `cairnline-strategy/1`
document Backtest Studio writes (including the validation verdict as `basis`).
`POST /api/paper/cycle` makes **one** decision from the newest *closed* bar —
open, close, hold, or "no new bar" — and refuses to trade the same bar twice.
There is no background daemon: nothing happens between calls, and nothing is
invented in between.

**What it is not.** No broker, no MT5, no live account, no tick data. A stop is
not watched between requests — a position exits when the operator closes it or a
cycle decides to — and the payload says so in `rails_note` and on the page.

## 4e. Public MCP server — C7 (shipped 2026-11-17)

`server/trish_mcp.py`, protocol `2024-11-05`, **20 tools**; distribution docs in
`server/mcp/README.md` with registration snippets for Claude Code, Codex and
Cursor/Claude Desktop, plus `server/mcp/cairnline-mcp`, a launcher that resolves
its own path.

New in C7: `options_flow`, `paper_account`, `paper_order`, `paper_close`,
`paper_kill`, `paper_cycle`, and `mode: "validate"` on `backtest`. The six paper
tools go through the same routes (and therefore the same rails) the page uses, so
an agent cannot bypass them; `paper_order` returns the full rail list with the
rejection reasons.

`python3 server/trish_mcp.py --selftest` prints the tool count and whether the
desk is reachable — the first thing a new host should check.

## 5. Verification for this pass (2026-11-17)

Every number below comes from a command that was run, against the market service
on `127.0.0.1:8788` and the dashboard served from `127.0.0.1:8805` with a fresh
browser profile (Chromium via Playwright, headless, real render).

### 5.1 Static checks

`node --check` on `terminal.js`, `pages/backtest.js`, `pages/tools.js`,
`market.js`, `router.js`; `python3 -m py_compile` on `server/backtest.py`,
`server/edge_stats.py` and `server/market_service.py`. All clean.

### 5.2 Chart studies (C1, extended 2026-11-18)

The menu is built from Vela's runtime registry, so its coverage is the
registry's: **75 of the 77 studies in this build** plus three EMA presets —
**78 rows**, **24 on the price** and **54 in their own pane**. Two studies are
held back by a documented exclusion list (`EXCLUDED_STUDIES` in `terminal.js`):
`volume` and `vpvr` register, remove and accept inputs but draw nothing on
EURUSD or BTCUSD (each study added, then `chart.inspect()` read), so offering
them would put a blank row on the chart.

Browser run, 2026-11-18, Chromium headless on `#/chart`, **37 assertions, zero
console errors**, fresh profile:

| what | evidence |
|---|---|
| add an own-pane multi-series study | MACD opened its own pane (3 series); selection persisted |
| add an overlay | SuperTrend landed in the `price` pane |
| add a rail/profile-style study | Pivot Points, 7 series, price pane |
| change an input | MACD Fast Length 12 → 33 reached the live study, persisted to `cairnline_indicator_inputs`, chart instance unchanged (no rebuild) |
| inputs panel | schema-driven fields rendered from the handle's own `inputs` |
| pane controls | maximise → restore, height 1 → 2, collapse → expand, each written to the layout store |
| visibility | the eye hid MACD while keeping its pane and inputs; show restored it |
| placement | MACD moved to `price` and back to its own pane, both persisted |
| reload | selection, MACD's Fast Length 33, own-pane placement and height 2 all survived |
| remove | handles and panes returned to the pre-add state (4 studies, 2 panes) |
| legacy saved chart | `["ema9","bb","adx","rsi"]` + `{"bollinger-bands":{"length":34}}` loaded as 4 studies, BB length 34 |

An add-all sweep over the registry separately confirmed 77/77 add and remove,
the pane count returns to its baseline and the console stays clean; three drew
nothing (`volume` and `vpvr` on both symbols, `zigzag` on FX only — it draws
polylines on BTCUSD, so it stays available).

Two defects were found and fixed in this pass. Loading prefs filtered saved keys
against a catalog that is empty before the first chart exists, so any saved
non-seed study was dropped on every reload; prefs are now kept raw and pruned
after the registry is adopted. And a pane height or collapse applied in the same
tick as the study's creation was discarded by the renderer, so the layout pass
is deferred one frame and recorded only after the chart accepts it.

**Simplification pass, 2026-11-18.** `paneFlags` now reads Vela's public pane
record (`id`, `indicators`, `collapsed`, `maximized`) instead of reaching into
`panesControl.controller.registry` and rebuilding ids from a `pane-<id>`
convention; that removed `paneIdFor` and the fallback branch. `applyStudyLayoutNow`
is one study-at-a-time loop — place, then resize/restore the pane the move
actually produced, then set visibility — instead of three passes over the whole
catalogue, and each menu row computes its handle, hidden flag and pane record
once. Maximising now records the layout like every other control. No behaviour
changed: the 37-assertion suite was re-run after the edits, **37/37, zero console
errors**.

### 5.3 Backtest Studio (C4)

`/api/backtest` over LSE data: EURUSD 1h/1y → 5,000 bars, `ema-cross` 484
trades, `-89.85%`, PF 0.49, Monte Carlo p5/p50/p95 `-93.48 / -89.84 / -84.17`;
XAUUSD 4h/2y → 1,884 bars, `rsi-reversion` +6.93% (PF 1.2), `breakout` -16.67%
(PF 0.7). Optimiser sweep returned 4 and then 8 ranked rows with half-split
columns. In the browser the page rendered from server metadata, Run produced the
metrics, the equity SVG, the Monte Carlo card and 200 trade rows, and Optimise
produced the 8-row sweep table.

### 5.4 Replay marks, proved

Run: EURUSD 1h/1y, `ema-cross`, 5,000 bars, 200 trades.

- **State.** `chart.marks.all()` held exactly 400 marks after `Show trades on
  chart` — 200 entries + 200 exits — and `chart.drawings.all()` held 200
  `trendline` objects, one per trade.
- **Timestamps.** All 400 mark timestamps matched the trade list's entry/exit
  bar times exactly (400/400, no rounding), and every one fell on a real bar open
  inside the loaded 5,000-bar range.
- **Price anchors.** Three sampled trendlines had anchors equal to the trade's
  entry time+price and exit time+price (exact equality on all six values), so the
  price-pane segments really join entry to exit rather than floating.
- **Pixels.** An in-page canvas diff of the same viewport with and without the
  drawings found 2,476 changed pixels inside the bounding box x338–1008,
  y330–645, of which 513 were the entry colour and 544 the exit colour: the
  marks are painted, not merely registered. Screenshots:
  `checks/backtest-marks-on-chart.png`, `checks/backtest-replay-zoom.png`.
- **Clearing.** `Clear 400 backtest marks` removed the marks, the drawings and the
  `localStorage` entry, and hid the control; the chart redrew identically to the
  pre-run state (`checks/backtest-replay-cleared.png`).
- **Console.** The only error in the buffer is the TradingView embed's
  `Cannot listen to the event from the provided iframe`, which comes from the
  vendored embed, not from our code.

**Limits of the marks API in this build.** `chart.marks` draws rings on the
timeline band only, and there is no public way to feed `scene.tradeMarkers`
(it renders an indicator's own `trades`). Price anchoring is therefore done with
`chart.drawings.add('trendline', {paneId:'price', anchors:[…]})`, 200
entry→exit segments, white for winners and orange for losers. Framing to the run
needed `setRangeOverride` in `vela-provider.js`, because the 1h default range is
3 months and a 1-year run only fits by clamping to the minimum bar spacing — the
viewport then shows ~3 months and 317 of the 400 marks. That is a range limit,
not a data limit.

### 5.5 Fallback renderer and studio focus states

Both were open items from the previous pass and are now closed:

- **Fallback SVG renderer.** With the Vela bundle blocked at the network layer,
  the chart page still rendered 331 SVG elements with the legend
  `EURUSD 15m · 370 bars EMA 9EMA 21EMA 50` and no console errors.
- **Studio focus.** A focused input in `#/backtest` computes
  `border-color: rgb(229, 9, 20)` with a `0 0 0 3px` brand-soft shadow, and
  `:focus-visible` matches too (an earlier "no focus ring" reading was taken
  mid-transition).

### 5.6 Edge Stats (C2)

**What was built.** `server/edge_stats.py` is a real engine, not three
hand-rolled conditions:

- sessions are built from bars (UTC day, open/high/low/close from the bar
  series), then features (gaps, ranges, ATR, streaks, weekday, month, inside/
  outside days, NR4/NR7, doji, engulfing, initial balance, opening range, FVG
  state, event calendars) are computed once per session;
- a small DSL evaluates the presets' `where` fragments and outcome calls
  (`hit(rangeVsAtr, gte, {r})`, `streak(green, {n})`, `eventDay('FOMC')`, …),
  with bare words read as enum values and mismatched comparisons raised as
  errors rather than silently false;
- 16 outcome evaluators cover the catalog's outcomes, each attaching the date of
  the *condition* session so a `where` clause filters the right bar even when the
  outcome is measured on the next session;
- every result carries a Wilson 95% interval, the unconditional baseline for the
  same outcome, the lift in points, a time-ordered half-split stability score,
  per-year counts, a per-session drill-down and a verdict sentence that says when
  the sample is too thin to trust.

**Preset registry.** All **42** presets from the LuxAlgo edge-stats catalog
(MIT, vendored under `server/presets/` with `LICENSE-MIT.txt`) plus four event
calendars (`cpi`, `fomc`, `nfp`, `opex`). `GET /api/edge-stats/presets` returns
42 with 9 flagged `needs_intraday`; nothing was dropped and nothing was invented.
All 42 execute without an exception on XAUUSD (1d/5y for the 33 daily-safe
presets, 1h/3mo for the 9 intraday ones): `ok=42 refusal=0 fail=0`.

**Two presets × two instruments, through the API and through the page.**

| preset | symbol / tf / history | source | n | rate | 95% CI | baseline | stability |
|---|---|---|---|---|---|---|---|
| gap-fill | XAUUSD 1d 5y | yfinance | 1001 | 76.7% | 74.0–79.2 | same (no condition) | 88 stable |
| gap-fill `minGapPct=1` | XAUUSD 1d 5y | yfinance | 55 | 27.3% | 17.3–40.2 | 76.7% | — too wide |
| green-rate | XAUUSD 1d 5y | yfinance | 1258 | 53.2% | 50.4–55.9 | same | 75 stable |
| orb-target `window=60` | XAUUSD 1h 3mo | yfinance | 72 | 68.1% | 56.6–77.7 | same | 58 shaky |
| high-time `within=60` | XAUUSD 1h 3mo | yfinance | 73 | 38.4% | 28.1–49.8 | same | 81 stable |
| orb-false-break `window=60` | EURUSD 1h 1y | yfinance | 260 | 83.8% | 78.9–87.8 | same | 66 shaky |

The page (fresh browser, real responses) rendered all 42 rows in 11 category
groups, and for the runs above it showed the estimate next to its interval, the
observation count, the baseline, the lift, the stability score and label, the
half-split table, the per-year table, the session table (3 rows for the EURUSD
1h ORB run, with explicit `00:00-07:00` / `07:00-12:00` / … windows) and the
`How this was computed` card. Screenshot: `checks/edge-stats.png`.

**Guards that fired, as designed.**

- **Thin sample.** `event-day-fomc` on XAUUSD 1d/3mo → `n=2`, and the page shows
  the engine's own sentence: *"2 observations — too thin to trust. The interval
  spans 81.1 points; treat this as noise until the sample is bigger."*
- **Data quality.** `gap-fill` on EURUSD daily/5y is refused: *"This EURUSD 1d
  series has open == close on 73% of sessions (953 of 1300), so open-to-close
  outcomes cannot be computed honestly."* The page renders that as
  `The engine refused this run` rather than a number. This is the yfinance
  daily-FX back-filled-open problem, and the guard exists because of it.
- **Session drill-down** only runs for outcomes with an intraday event time
  (ORB breaks, gap fills on intraday bars, time of high/low). A whole-session
  outcome gets a note saying a session split would be a clock artefact instead of
  a fake table.
- **Gap floor.** A session counts as gapped only at `0.05%` away from the prior
  close; the number is in every response's `definitions` and on the page, because
  FX trades 24/5 and produces micro-gaps at the UTC day boundary.
- **Window vs bar size.** A 15-minute opening range on hourly bars raises
  *"this series has one bar every 60 minutes … choose a finer timeframe"* instead
  of silently reporting zero sessions.

**Licence.** The catalog's JSON definitions are MIT and vendored with their
licence; the engine is ours, written from the definitions. No LuxAlgo Library
indicator code (CC BY-NC-SA) is copied, and no server-side PineTS/Vela-pinets is
used for paying users. Bars come from our own LSE key through the existing
provider chain (the `source` field says which provider answered).

### 5.7 Not verified

- **Optimiser depth.** The optimise sweep and `mode=validate` now use
  expanding-window walk-forward with an embargo (C5); a purged k-fold, a
  multi-symbol sweep and a genetic/Bayesian search are still not implemented.
- **Cross-checks against an independent implementation.** The preset *definitions*
  are upstream's; the *implementations* are ours, so the numbers are not compared
  against LuxAlgo's site or another engine. Where a definition is ambiguous (for
  example a session-level FVG's invalidation rule) the code states its choice.
- **Other instruments/timeframes.** Two instruments and two timeframes are covered
  above; the remaining symbols in the picker (GBPJPY, BTCUSD, GBPUSD, USDJPY) were
  not run through the page.
- **Data-source stability.** LSE and yfinance both answer for XAUUSD daily and the
  provider can change between runs, which moves the gap rate materially (1120
  gapped sessions from LSE vs 1001 from yfinance on the same 5 years). Every
  response reports `source`; the numbers above are yfinance.
- **Pixels of the Edge Stats page** were captured (`checks/edge-stats.png`) but not
  reviewed image by image; the DOM and computed values were checked instead.

### 5.8 Options Flow (C3)

Engine, called directly against the live feed:

| underlying | contracts | prints | premium | P/C | gamma exposure | max pain | whale |
|---|---|---|---|---|---|---|---|
| SPY | 1,000 | 1,000 | $2,540,722 | 1.005 | $3,313,667.98 / 1% over 82 strikes | 742 (+0.25%) | 38.4 notable |
| AAPL | 1,000 | 1,000 | $2,199,611 | — | $7,853,613.52 / 1% over 41 strikes | 350 (−1.02%) | 27.7 quiet |

Route: `GET /api/options-flow?underlying=SPY&window=7d` → HTTP 200 in 4.97 s,
with `source: lse-data`, `feed: us_options (LSE Data 3.0)`, `generated_at`,
`as_of` (newest print), `gex.basis: tape_contracts_traded`, and four named
unavailable metrics. Unknown underlying: `ZZZZQ` → HTTP 200,
`available: false`, reason *"the provider has no listed options for ZZZZQ"*,
`detail: [404] no listed options for ZZZZQ` — a real refused provider call, not
a mocked error.

The page (`#/options-flow`, Chromium, real render): metrics 740.17 / $3.31M /
742 / 38.4 — identical to the API; 16 exposure bars (8 positive, 8 negative);
59 table rows across the flow, pain and whale tables; 5 collapsible sections,
whose button took the body from visible → hidden → visible with
`aria-expanded` following; sidebar marks Options Flow active; the Overview tool
card links `#/options-flow` with "Live prints, gamma exposure and max pain from
LSE". **Zero console errors** on both the populated and the unavailable state.
The unavailable run renders the heading, the provider's reason and the sentence
that no sample prints are drawn, with zero tables and zero bars.
Screenshot: `checks/options-flow.png`.

**Filters, exercised.** `min_premium=250000` keeps 2 prints, moves the whale
score 38.4 → 27.5 and leaves exposure unchanged at $3,313,667.98 — a display
filter must not re-weight the curve, and the payload's `filters.applied_to` says
so. `max_dte=2` caps every returned print at 2 days and moves max pain to 740.
The premium filter was also driven through the page's own select: same numbers,
zero console errors.

Not verified: any instrument other than SPY and AAPL, and how `option_candles`
would extend the page — it is unused.

**Levels and smile (2026-11-18).** Same SPY chain and tape, 6.7 s for the whole
build (chain page plus tape):

| metric | value |
|---|---|
| underlying | 737.5 |
| gamma flip | **732.3374** (−0.70% from spot), crossings 732.3374 and 893.7505, 772/772 legs repriced |
| call wall | **738.0** (+0.07%), $10,478,130.90 exposure |
| put wall | **716.0** (−2.92%), −$5,629,307.85 exposure |
| IV smile | 3 expiries — 2026-11-18 (0 dte, nearest IV 28.55%, 95 strikes), 2026-11-19 (1 dte, 28.50%, 110), 2026-11-20 (2 dte, 26.95%, 170) |

The page (`#/options-flow`, Chromium, real render) showed the Key levels card
with those numbers, the three-line smile SVG with its expiry/ATM legend, and all
six collapsible sections; **10 assertions, zero console errors**. The engine's
`unavailable` list still names only the four feed gaps (OI gamma, OI max pain,
condition codes, aggressor) — the new metrics did not silently degrade.

One page defect was fixed here: `section()` passed its note through `card()`'s
`action` branch, so every section subtitle was dropped whenever a collapse
button existed. The header now renders note and button together.

**Review pass, same day.** The maths was checked against the live chain: BS
gamma matches a finite difference of the BS delta to <0.1%, the flip has a real
sign change across it (net −$1.08M at 731.84 → +$1.23M at 732.84), the flip is
the crossing nearest spot, each wall is the maximum on its side, and every smile
series is sorted and at least four strikes. Four things were corrected rather
than left: IV normalisation now lives in one `_iv_fraction` helper (it ran twice
per leg), `legs_with_iv` counts `dte`-less legs that are priced at the one-day
floor instead of excluding them, the smile refuses a missing spot instead of
comparing a strike to `None`, and "ATM" was relabelled "nearest IV" because it
is the closest listed strike, not an interpolation. The unused 101-point flip
curve was dropped from the payload, and the zero-crossing test/interpolation is
now one `_zero_crossing` helper shared by the cumulative and repriced flips.
Values did not move: flip 732.3374, walls 738/716, smile 28.55/28.50/26.95, and
the page's 10 browser assertions still pass with zero console errors.

### 5.9 Validation (C5)

Run against the live service, both instruments end-to-end in 43 s:

| run | bars | verdict | checks | leader | walk-forward | surface | cost stress | safe risk |
|---|---|---|---|---|---|---|---|---|
| EURUSD 1h 1y `ema-cross` | 6,172 | **does not hold up** | 1/5 | `fast 11` → −95.53%, 650 trades | 0/2 folds held, aggregate OOS −135.78%, 433 OOS trades | 0% positive, median −95.71% | −99.84% at 4/2 bps | none under a 20% cap (0.25% risk → 59.58% p95 DD) |
| XAUUSD 4h 2y `breakout` | 373 | **partly holds up** | 3/5 | `length 18` → +1.41%, 14 trades | 1/1 fold held, aggregate OOS +2.57%, 5 OOS trades | 100% positive, median 1.07% | +0.85% at 4/2 bps | 2.0% for a 20% cap |

The EURUSD row is the point of the feature: the same strategy that produced
−89.85% in the C4 verification is now labelled `does not hold up` rather than
presented as a result. XAUUSD's two failures are `out_of_sample` (only one fold
had enough bars — 104 IS, 124 OOS — so robustness was not demonstrated) and
`sample` (5 OOS trades). Neither is a silently passing check.

In the page: **Validate** produced the verdict card (`does not hold up · 1/5
checks pass`), the 5-row checks table, the 2-row fold table, the 5-row surface
table and the 9-row risk table, and enabled **Deploy to paper desk**. Zero
console errors.

### 5.10 Paper Desk (C6)

Live quote at the time: EURUSD 1.0998 from `lse-data`. Every case below was run
through `POST /api/paper/order` and then re-read through `GET /api/paper`.

| case | result |
|---|---|
| long, no stop | rejected — *Stop is on the losing side of the entry: no stop supplied* (and the four rails that depend on it) |
| stop 5 pips, target 4 pips | rejected — *Reward:risk is at least 1.5: 0.8* |
| 1,000 units, stop −5 pips, target +12 pips | **accepted**, entry 1.09990998 (quote + 1 bp slippage), 14/14 rails pass, risk 0.051% of $10,000 |
| the same order again | rejected — duplicate of the order 0.4 s earlier |
| any new entry with the kill switch on | rejected — *Kill switch is clear: engaged: verification* |
| closing the open position while killed | **allowed** — closed for −$0.66 (commission + slippage) |
| deploy `ema-cross` EURUSD 1h 6mo, then one cycle | **opened** 65,933 units at 1.09990, stop 1.09828, target 1.10283 (ATR 0.00101105) |
| the same cycle again | `no new bar` — the newest closed bar was already traded on |

Page (`#/paper`, Chromium, real render): equity $9,989.45 with balance and start
in the note, open P&L −$9.89 marked from `lse-data`, realised today −$0.66,
orders today 2/10, open positions 1/3; a rejection through the ticket rendered
`Order rejected · 9/14 rails passed` with all 14 rail rows (5 blocked); the
rails card lists 10 rails; the flight recorder 9 orders; the deployment row shows
`opened`; **zero console errors** on the page and after the cycle.

Two defects were found here and fixed before this table was taken: duplicate
protection compared only symbol+side (blocking legitimate re-entries), and
deployment sizing used risk-sized units that exceeded the notional rail on FX
(now sized down to the cap, and the cap defaults to 1000% because FX notional is
levered).

### 5.11 Public MCP server (C7)

`python3 server/trish_mcp.py --selftest` → `tools: 20`, `api_health: true`,
server `cairnline 1.1.0`. A `tools/list` over stdio returns the same 20 names.
Two tool calls were driven end-to-end against the live service:

- `paper_account` → `mode: paper`, `broker: none — no order leaves this
  machine`, equity $9,988.79, one EURUSD position with its stop/target and
  `quote_source: lse-data`, deployment `EMA cross 9/21`.
- `options_flow {underlying: SPY, window: 7d, min_premium: 250000}` → underlying
  740.17, GEX $3,313,667.98 on `tape_contracts_traded`, max pain 742, whale 27.5,
  2 prints, and four named unavailable metrics.

Not verified: registration inside a real MCP host (Claude Code / Codex / Cursor)
— the protocol was exercised over stdio with the calls above, not through a
client's server manager.

### 5.12 Not verified, this pass

- **Paper stops are not watched between requests.** There is no broker and no
  background loop; a position exits when the operator closes it or a deployment
  cycle decides to. The payload says this in `rails_note` and so does the page.
- **Paper fills are quote-at-request, not tick data.** The quote and its source
  are stored on every order, so the fill can be audited, but a real broker's
  book would fill differently.
- **No broker, no MT5, no live account.** Nothing in C6 contacts a broker; a
  read-only broker-sdk account is the remaining step.
- **Validation shares the engine with the backtest.** A bug in the fill model
  would appear in both. It is checked against the stated assumptions (next open,
  stop before target, costs both sides), not against an independent engine.
- **Validation coverage.** Two instruments, one grid per run (five values by
  default), three folds at most on the history used here.
