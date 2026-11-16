# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **[inferred]** Retail forex and gold traders evaluating an AI-assisted trading tool, and existing
  Pipnex customers running analyses, signals and bots from the dashboard.
- **[inferred]** Two secondary readers: the person building this clone (comparing it against the
  production app at `pipnex-ai.com`) and anyone they show it to.

Interview substituted: the one product question was answered with "just continue from where the
other agent stopped and build on", so every fact below is either read from the repository or marked
`[inferred]`. Nothing here is confirmed user approval.

## Product Purpose

**[inferred]** A working replica of the Pipnex AI web product: a public marketing site plus a
signed-in trading dashboard (chart analysis, pulse signals, rumours-free bot management, wallet,
subscription, EA marketplace). Success is a visitor being able to walk the whole production route
map — landing page to dashboard to plan selection — and recognise the real product's behaviour at
each step, running from a plain static server with no build step.

## Positioning

**[inferred]** Not a competing product: a faithful, editable reconstruction. The differentiator of
the real product is the Pipnex "Market Brain" — Smart Money Concepts chart reads with a
confidence-scored trade plan — plus the Trade Lens Chrome extension that applies it inside
TradingView. The clone's own differentiator is legibility: readable vanilla source and a data layer
that shows only real reads — no demo rows, no generated series.

## Operating Context

- Static site served from `app/` (`index.html`, `styles.css`, `app.js`, plus `app/dashboard/`).
- `server/market_service.py` (Flask-free, plain HTTP on `:8788`) supplies real bars and indicator
  values from yfinance so the browser keeps working around CORS.
- Account data reads the production Supabase project through PostgREST, GET only, using an access
  token pasted in Settings. There is **no demo, mock or simulated data anywhere**: with no session
  a page states what it cannot read (`NO_ACCOUNT`) instead of inventing rows.
- Reference material for the rebuild lives in `/home/omega/pipnex-reference` (captured DOM, tokens,
  measured layout, full-page screenshots at 1440/768/390).

## Capabilities and Constraints

- No build step, no framework, no bundler: plain HTML/CSS/ES modules, hash routing.
- Mock data and the live adapter share one API surface (`data.js`); pages never know which is active.
- Read-only live mode. There are no writes, no payments, no MT5 socket bridge, no cloud-bot
  execution, no Realtime subscriptions, no email or push delivery.
- Dashboard ships: overview, AI trading terminal, upload chart, manage bots, auto trading, pulse
  signals, subscription, wallet, settings, trade lens, referral, tutorials, market research, prop
  firm simulator, edge stats, support, and EA marketplace.
- Missing versus the production route map: `#/synthetic-chart`, `#/trades`, `#/alerts`, and the
  public-side `/auth`, `/choose-plan`, `/checkout`, `/terms`, `/privacy`, `/refund`.
- Operator/admin routes on the real product (`/gateway`, `/terminals`, `/events`, `/incidents`,
  `/watchdog`, `/bridges`, `/analytics`) are out of scope by design.
- Open decision: whether this may keep the PipNex name, copy and logo, or must be rebranded before
  being shown. Unanswered; treated as "keep the reference brand, it is a study clone" for now.

## Brand Commitments

**[inferred]** The name PipNex, the product copy captured in `/home/omega/pipnex-reference`, and the
route names are carried over from production so the clone reads as the same product. The clone's own
visual language (marketing: black / ice / aurora green; dashboard: black / brand red / lime data) is
local work, not a Pipnex asset.

## Evidence on Hand

- `/home/omega/pipnex-reference/`: rendered DOM, computed tokens, measured layout at three widths,
  full-page screenshots, and the full text of the pricing, FAQ and about sections.
- Production `plans` rows verified live: basic $9.99, pro $49.99, ultimate $99.99, platinum $299.99.
- Production `tutorials` (14 rows) with real YouTube ids.
- Absent and must not be invented: customer testimonials, win-rate claims, audited performance,
  press coverage, team photos, regulatory status, or any statement that AI analysis is profitable.

## Product Principles

1. **Walkable before impressive.** Every production route reachable and recognisable — with an
   honest empty state where a real source is absent.
2. **Label the truth.** Real feed, live read and cached value are visibly different things. Nothing
   is fabricated to fill a layout: no seeded catalogues, no generated price series, no chart
   mockups that look like live product screens.
3. **The data layer is the contract.** Pages speak PostgREST column names so swapping sources stays
   a one-file change.
4. **No build step, no magic.** What ships is what a reader can open and edit.
5. **Refuse financial promises.** The product describes analysis and confidence, never returns.

## Accessibility & Inclusion

WCAG AA on the dark surfaces (4.5:1 body, 3:1 large), visible keyboard focus, `prefers-reduced-motion`
honoured for every entrance and live-tick animation, and no meaning carried by colour alone
(bias and P&L always pair colour with a sign or word).
