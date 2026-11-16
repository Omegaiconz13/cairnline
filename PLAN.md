# Pipnex AI — rebuild plan (authenticated app)

Study date: 2026-11-11 · Target: `https://pipnex-ai.com` (production, authenticated as `nandejeclinton@gmail.com`, user id `8aa02895-8758-4628-bfe3-8ac80f03594c`, account id `OME4770`)

---

## 1. What the real product is

**Pipnex AI** is an AI-assisted Forex trading platform: chart analysis (Smart Money Concepts),
signal delivery, MT5 broker connection, cloud bots, an EA marketplace, a points wallet, and a
Chrome "Trade Lens" extension.

### Frontend stack (fingerprint from 82 shipped Vite chunks)

| Layer | Technology | Evidence |
|---|---|---|
| Framework | React 18.3.1 | `vendor-react-DpVssyrz.js` (`version:"18.3.1"`), `createRoot` |
| Routing | React Router 6 (`useNavigate`, `path:"/dashboard/*"`) | `index-BjjH0aki.js` |
| Data fetching | TanStack Query (`QueryClient`, 131 `queryKey` uses) | `vendor-data-sb3qsAle.js` |
| Build | Vite, code-split per route (`MT5AccountConnection-*.js`, `LightweightChart-*.js`, …) | `/assets/*.js` |
| UI kit | shadcn/ui — Radix primitives + `class-variance-authority` | `vendor-ui-CNfAmx92.js` |
| Styling | Tailwind CSS (utility vars `--tw-*` on `:root`) | rendered CSS vars |
| Motion | framer-motion | `vendor-animation-DmlcjbHi.js` |
| Icons | lucide-react | chunk icon names (`bell`, `avatar`, `wallet`, …) |
| Charts | `lightweight-charts` (TradingView) for the terminal; `recharts` for stats | `LightweightChart-CYKbxKYi.js` |
| Backend | **Supabase** — project `jwaplyyxkxfrhmbcycmc` — Auth + Postgres + RLS + Realtime + Storage | `sb-jwaplyyxkxfrhmbcycmc-auth-token` |
| Toasts | sonner | `vendor-utils` |

### Data model — 33 tables (read live through PostgREST with the user JWT)

- **Identity** — `profiles` (display_name, plan_id, account_id `OME4770`, points, country, trial,
  device_fingerprint, email_preferences, is_frozen), `user_roles`, `device_registrations`,
  `device_transfer_requests`
- **Billing** — `plans`, `subscriptions`, `payment_transactions`, `wallets`,
  `wallet_transactions`, `withdrawal_requests`, `usage_counters_daily`, `referrals`,
  `referral_rewards`
- **AI analysis** — `analysis_history`, `strategies`, `strategy_signals`,
  `strategy_signal_deliveries`, `fx_rates`
- **Trading** — `trades`, `cloud_bots`, `cloud_bot_logs`, `cloud_bot_trades`,
  `auto_trading_workspaces`, `prompt_trading_sessions`, `prompt_trading_messages`,
  `prompt_trading_autopilot`, `signal_auto_execution_prefs`, `pulse_signal_preferences`,
  `funded_account_configs`, `funded_account_logs`
- **Broker / MT5** — `MT5AccountConnection`, `custom_broker_sessions`, `ea_downloads`
- **Content / support** — `tutorials`, `support_conversations`, `support_messages`,
  `feature_flags`

**RPCs** — `get_user_permissions`, `can_user_perform_action`, `increment_usage_counter`,
`generate_account_id`, `get_custom_broker_session_token`, `set_custom_broker_session_token`,
`mirror_custom_broker_connection`, `set_my_subscription_auto_renew`

**Real plan catalogue** (from `plans`):

| key | price | MT5 accounts | uploads/day | voice/day | auto-trading | EA branding | priority |
|---|---|---|---|---|---|---|---|
| basic | $9.99 | 1 | 3 | 0 | ✗ | none | 1 |
| pro | $49.99 | 3 | 12 | 10 | ✓ | site | 2 |
| ultimate | $99.99 | 5 | 24 | ∞ | ✓ | user | 10 |
| platinum | $299.99 | ∞ | ∞ | ∞ | ✓ | user | 100 |

### Route map (from the router table in `index-BjjH0aki.js`)

**Public / marketing** — `/`, `/lens`, `/lens/auth`, `/lens/support`, `/download`,
`/tutorials`, `/referral`, `/choose-plan`, `/subscribe/:planId`, `/checkout`, `/checkout-ea`,
`/payment-success`, `/payment-failed`, `/privacy`, `/terms`, `/refund`, `/privacy-security`,
`/auth`, `/auth/callback`, `/reset-password`, `/recovery`, `/unsubscribe`, `/complete-profile`

**Authenticated app** — `/dashboard` (Overview), `/dashboard/settings`, `/chart` (AI Trading /
Upload Chart), `/auto-trading`, `/manage-bots`, `/signals` (Pulse Signals), `/subscription`,
`/wallet`, `/ea-marketplace`, `/synthetic-chart`, `/gateway`, `/gateway/access`, `/terminals`,
`/events`, `/incidents`, `/trades`, `/alerts`, `/watchdog`, `/bridges`, `/analytics`

The last group (gateway/terminals/events/incidents/trades/alerts/watchdog/bridges/analytics)
returns **404 for this user** — they are role-gated operator/admin surfaces.

### App shell (measured from the live DOM)

- Left sidebar (fixed, 250 px): logo → **Overview**, **Quick Access Tools** → *Pipnex Trade Lens*,
  *Auto Trading*, *AI Trading*, *Upload Chart*, *Manage Bots*, *Pulse Signals*, **Subscription**,
  **How to Use**, **Contact Support**, **Settings**. Platinum-only items carry a diamond badge.
- Top bar: sidebar toggle · page title ("PipNex Dashboard") · theme toggle · notifications bell ·
  avatar.
- Overview: welcome banner → **Quick Performance Snapshot** (AI Analyses Today, Signals Generated,
  Charts Analyzed, Preferred Strategy, AI Confidence (Avg), Auto-Trading, Copy Trading) →
  *Start AI Trading* → **Market Pulse** (LIVE) → **Signal of the Day**.
- `/chart`: full-bleed terminal — symbol selector (XAU/USD (Gold)), timeframe tabs M1…W1, live
  price, TradingView lightweight-charts canvas, right rail **TRISH AI ASSISTANT** with
  *Analyze Current Chart*, SYMBOL/INTERVAL/STATUS chips, chat transcript, message box,
  "PIPNEX DESK" footer.
- `/manage-bots`: ACTIVE BOTS / TOTAL BOTS / TOTAL TRADES / NET P&L, tabs Stats · Trades · Logs.
- `/subscription`: current plan + history, Export PDF, Upgrade/Change plan.
- `/wallet`: AI Credits balance, Add money / Withdraw / Transfer, FAQ.

---

## 2. Our rebuild: architecture

Constraint carried from the marketing site: **no build step** — plain HTML/CSS/ES modules, so the
app runs from any static server and stays editable.

```
app/
  index.html  styles.css  app.js          # marketing site (done, aurora theme)
  dashboard/
    index.html                            # app shell: sidebar + topbar + <main id="view">
    dashboard.css                         # aurora design system for the app surface
    js/
      router.js                           # hash router, route table, guards
      data.js                             # data layer: Supabase-shaped API + mock adapter
      ui.js                               # DOM helpers: el(), card(), table(), spark(), candles()
      pages/
        overview.js  chart.js  bots.js  signals.js  subscription.js
        wallet.js    settings.js  lens.js  referral.js  tutorials.js
```

### Decisions

1. **Same information architecture as the real app** — same sidebar items, same route names, same
   card/table compositions — so behaviour learned from production carries over.
2. **Same schema vocabulary** — the mock data uses the real column names (`daily_upload_limit`,
   `available_cents`, `mt5_limit`, `priority_score`, `analysis_history`, `cloud_bots`, …). When the
   rebuild goes live, swapping `data.js` from the mock adapter to `supabase-js` is a one-file
   change; every page already speaks the production shape.
3. **Hash routing** (`#/overview`) so the static app needs no server rewrite rules, while the URL
   names match the production routes.
4. **Theme**: black `#05070A`, ice `#E9F2F1`, aurora `#35F0A8` — the same token set as the
   marketing site, with the operator surfaces (terminal, tables, charts) tuned for long sessions:
   dimmed chrome, aurora only for live data and primary actions.
5. **Charts are hand-drawn SVG** (candles, sparklines, heat cells) — no charting dependency, same
   visual language as the marketing hero mock.

### Data layer contract (`data.js`)

```js
api.profile.get()          → { display_name, plan_id, account_id, points, country, … }
api.plans.list()           → [{ key, price_cents, mt5_limit, daily_upload_limit, voice_limit, … }]
api.subscription.get()      → { plan_key, status, current_period_end, … }
api.wallet.get()           → { available_cents, pending_cents, withdrawable_cents, … }
api.analysis.list({limit}) → [{ symbol, interval, confidence, bias, created_at, … }]
api.bots.list()            → [{ id, name, symbol, status, pnl, … }]
api.signals.list()         → [{ id, symbol, bias, entry, sl, tp, confidence, delivered_at, … }]
api.trades.list()          → [{ id, symbol, side, qty, price, pnl, opened_at, … }]
api.usage.today()          → { analyses, signals, charts }
api.tutorials.list()       → [{ title, youtube_id, category, duration_label, … }]
```

Each returns a promise and reads from `mock` in this build; the Supabase adapter implements the
same signatures against PostgREST + RPCs.

---

## 3. Build phases

| Phase | Scope | State |
|---|---|---|
| 0 | Marketing site, aurora theme | **done** |
| 1 | App shell, sidebar, topbar, router, design system | **done** — `app/dashboard/` |
| 2 | Overview, AI Trading terminal, Manage Bots, Upload Chart, Auto Trading | **done** |
| 3 | Pulse Signals, Subscription, Wallet, Settings | **done** |
| 4 | Trade Lens, Referral, Tutorials, Contact Support | **done** |
| 5 | Live Supabase adapter (read-only), verified against production | **done** |

### Live data mode (shipped)

`app/dashboard/js/supabase.js` implements the **same API surface** as the mock against the production
PostgREST project — reads only, every call a GET, RLS still enforced by Postgres.

- `js/config.js` — project URL, project ref and the anon key (a public client key: it ships in the
  pipnex-ai.com bundle).
- `js/data.js` — `api` is a proxy over both adapters. In demo mode it serves the mock; in live mode
  it calls Supabase and **falls back to mock per call** if a table errors, so one failing table never
  blanks a page. `setMode()`, `getMode()`, `setSession()` and friends are exported.
- Settings → **Data source** panel: paste an access token (or the whole `sb-…-auth-token` JSON) and
  the app switches to live mode; the top bar then shows a `LIVE` badge. “Sign out” clears the session
  and returns to demo data.

**Verified against production** (read-only, using the signed-in session): the plan catalogue comes
back as basic 9.99 / pro 49.99 / ultimate 99.99 / platinum 299.99 with the production `mt5_limit`,
`daily_upload_limit` and `priority_score`; 14 live tutorials; the user’s own `profiles` row
(Omega Iconz / OME4770) and `wallets` row. The account has no `subscriptions` row, so the UI shows
“no active plan” — matching production, where Trade Lens, Auto Trading and Manage Bots are
platinum-locked for this user.

### What ships in this build

- `app/dashboard/index.html` — shell: collapsible 252 px sidebar (13 entries, platinum badges, active-state
  underline), sticky top bar (page title, LIVE badge, appearance, notifications, avatar), `#view` outlet.
- `app/dashboard/dashboard.css` — the aurora token system re-tuned for operator surfaces (dimmed chrome,
  aurora only for live data and primary actions), 13 component classes, responsive at 1180/900/620 px.
- `app/dashboard/js/data.js` — the Supabase-shaped data layer: 33 production table names, the real plan
  catalogue (basic/pro/ultimate/platinum with `price_cents`, `mt5_limit`, `daily_upload_limit`,
  `voice_limit`, `priority_score`), `permissionsFor()` mirroring the `get_user_permissions` RPC.
- `app/dashboard/js/router.js` — hash router, route table, nav highlighting, permission context.
- `app/dashboard/js/ui.js` — `el()`, `card()`, `table()`, `switchRow()`, plus hand-drawn SVG
  candlesticks and sparklines (no charting dependency).
- `app/dashboard/js/pages/` — overview, terminal (+upload), trading (bots/auto-trading/signals),
  account (subscription/wallet/settings), content (lens/referral/tutorials/support).

**Live in the browser**: `http://127.0.0.1:36249/dashboard/` (craft-anything's preview server) and
`http://192.168.1.108:8766/dashboard/` (LAN copy for a phone).

### Verified

All 13 routes render with zero console errors; no horizontal overflow at 1440/900/390 px (data grids
scroll inside their own wrapper); the terminal chart, pricing tiers, FAQ accordion and form
validation were checked in Chromium 155.

### Not yet reproducible from production

Payments (Stripe-style checkout), MT5 socket bridge, cloud-bot execution, push/email delivery and
Realtime subscriptions — these need the backend to write to and are out of scope for the static
rebuild. The live adapter is deliberately read-only.
