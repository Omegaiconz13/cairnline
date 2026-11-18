# Trish, self-improving — plan and brainstorm

Research date: 2026-11-17. Everything in §1 was checked on this machine, not read
off a blog.

---

## 0. Verdict

**Keep the idea, but split it in three.** Hermes is the right engine to sit behind
Trish: MIT, already installed here, already running, and it is the only open agent
with a real learning loop (memory files, self-written skills, curator, MCP). What
must **not** happen is "Trish evolves her own trading knowledge". An agent that
rewrites its beliefs from a handful of chart reads will learn noise, and a trading
desk is the worst possible place to discover that. So:

| What she may learn | Auto? | Why |
|---|---|---|
| **Memory** — desk facts, your preferences, symbol basket, flat-by time | writes gated by you | Cheap, useful, reversible, and wrong memories get caught in a week |
| **Procedure skills** — how to fetch, sequence, format, refuse | proposed, you approve the diff | This is where most real value is: she stops re-deriving the same workflow |
| **Market beliefs** — "gold fills gaps 77% of the time", "this pattern works" | **never** | Our Edge Stats and Backtest engines are the only source of statistical truth; a skill that encodes a claim is a liability, not an asset |

That split is the whole plan. Everything below is how to wire it.

---

## 1. What exists today (verified)

**The engine is the upstream repo, not the installed agent.** Trish runs on
`https://github.com/NousResearch/hermes-agent.git` vendored at
`vendor/hermes-agent` (HEAD `9dbaa77c4c5b6391510832602f841bc95d390b22`), with its
own venv (`runtime/venv`) and its own `HERMES_HOME` (`runtime/hermes`). Nothing
here reads or writes the home-directory Hermes install; that agent's `default` profile, its
`cua`/`composio` MCP servers and its memory are out of reach by construction.
Hermes is **not** imported as a library: it runs as a process behind its own API,
so an upstream change is an upgrade, not a refactor.

**Switch record, 17 Nov 2026.** Pinned `NousResearch/hermes-agent` at
`9dbaa77c4c5b6391510832602f841bc95d390b22` into `vendor/hermes-agent` (shallow
clone). Launch: `runtime/venv/bin/hermes gateway run` with
`HERMES_HOME=<workspace>/Project/runtime/hermes` — config `runtime/hermes/config.yaml`,
secrets `runtime/hermes/.env` (mode 600), pid `runtime/hermes-gateway.pid`, log
`runtime/hermes-gateway.log`, API on `127.0.0.1:8642`. No app code, config or plan
resolves a home-directory checkout; the single surviving mention is the superseded
note at the top of `PLAN-TRISH.md`.

| Fact | Evidence |
|---|---|
| Vendored checkout at `9dbaa77c`, shallow clone, 421 MB | `git -C vendor/hermes-agent rev-parse HEAD` |
| Own runtime: `runtime/venv` (Python 3.14.8, `uv sync --frozen --no-dev`, plus `aiohttp` for the API server and `mcp==2.3.0` for the MCP client) | `runtime/venv/bin/python -V`, `uv pip list` |
| Own home: `runtime/hermes` with `config.yaml`, `.env` (mode 600), `memories/`, `pending/{skills,memory,rejected}/`, `journey.jsonl` | tree |
| Gateway is ours and loopback-only: `API_SERVER_HOST=127.0.0.1`, `API_SERVER_KEY` random 64-hex, `127.0.0.1:8642`, pid in `runtime/hermes-gateway.pid`, log `runtime/hermes-gateway.log` | `ss -ltnp`, unauthenticated `/v1/models` → 401, bearer → 200 |
| Toolset lockdown: 7 on, 19 deferred (terminal, browser, code_execution, computer_use, web, image_gen, tts, video, video_gen, connections, delegation, kanban killed) | `GET /v1/toolsets` |
| `server/trish.py` **already has a `hermes` backend** — it forwards to `:8642/v1` with `model: hermes-agent` and drops our own tools, on the assumption Hermes brings its own | `trish.py` `chat()` |
| Settings **already has a Trish card**: backend (direct / Hermes), base URL, model, API key, Test, Remove | `pages/account.js` `settings()` |
| Trish's direct backend is real: an 8-tool loop (quote, indicators, signals, COT, calendar, size, risk gate, read_skill) over our market service | `server/trish.py` `TRISH_TOOLS` |
| Cairnline has **27 skill rows / 20 unique names** with Hermes-compatible frontmatter (`name`, `description`, `version`, `license`, `metadata.cairnline.layer`) | `skills/index.json` |
| Hermes **sees them**: `skills.external_dirs: ["Project/skills"]`, so `hermes skills list` reports 27 local skills beside its 39 builtins | `hermes skills list` |
| The data bridge is live: `server/trish_mcp.py` (14 tools, incl. `backtest` and `propfirm_simulate`) registered as `mcp_servers.cairnline`, reached by the agent through `tool_search` → `tool_describe` → `tool_call` | `GET /v1/toolsets`, `<untrusted_tool_result source="mcp__cairnline__get_indicators">` in a real turn |
| Upstream bug at this commit: `GET /v1/skills` raises `find_all_skills() got an unexpected keyword argument 'include_editorial'` | `curl :8642/v1/skills` → `{"error": {"message": "Failed to enumerate skills"}}` — read the catalogue from `skills/index.json` instead |

So the plumbing is 70% there and the missing 30% is not code — it is
**configuration, a bridge, and a UI for the learning loop**.

Hermes capabilities that matter, from its docs: `POST /v1/chat/completions` runs
with the full toolset; `GET /v1/skills` and `GET /v1/toolsets` enumerate
capabilities; `/api/sessions/...` supports fork and SSE streaming; toolsets are
per-profile/per-platform and `agent.disabled_toolsets` kills one everywhere; MCP
servers become `mcp-<server>` toolsets with per-server tool allowlists; skills can
live in `external_dirs`; `skills.write_approval` stages writes in
`$HERMES_HOME/pending/`; profiles are isolated config + memory + skills.

### 1.1 Reconciliation — what upstream forced us to change

The first draft of this plan described the Hermes already installed on this machine.
The vendored checkout differs in six ways that changed code, not just paths:

| Assumption from the installed agent | What upstream `9dbaa77c` actually does | What we changed |
|---|---|---|
| config keys `provider` / `model` / `base_url` at the root of the installed agent's `config.yaml` | `$HERMES_HOME/config.yaml` keeps them under `model:` (`provider`, `default`, `base_url`, `context_length`), beside `skills:`, `memory:`, `agent:`, `mcp_servers:` | `trish_runtime._cfg()` reads `model.default`, and writes go through `hermes config set <dotted.key>` |
| the gateway is a systemd user service someone else supervises | `hermes gateway run` is a plain foreground process we spawn and own | `start()` / `stop()` / `restart()` manage the pid, wait for the API to answer, and write `runtime/hermes-gateway.{pid,log}`; nothing touches systemd |
| the API server is off and needs enabling with a key | `API_SERVER_ENABLED`, `API_SERVER_HOST`, `API_SERVER_KEY` in `$HERMES_HOME/.env`; 401 without the bearer, 200 with it | `_api_key()` reads our `.env` and every probe sends the bearer |
| staged writes land in the installed agent's `pending/{skills,memory}` and replay through the tool helpers | same folder shape under `$HERMES_HOME`, but each record wraps the tool arguments in `payload`, and the helpers take that inner payload — `apply_memory_pending(payload, store)`, `apply_skill_pending(payload, origin=…)` | `decide()` generates `runtime/_apply_pending.py` and passes `record["payload"]`; a refusal now keeps the item queued instead of deleting it |
| `/v1/skills` enumerates the catalogue | broken at this commit — `TypeError: find_all_skills() got an unexpected keyword argument 'include_editorial'`, body `{"error": {"message": "Failed to enumerate skills"}}` | `/api/trish/skills` reads `skills/index.json` (27 rows, 20 unique names); `hermes skills list` is the CLI cross-check |
| a real model provider is configured | there is no cloud key on this machine | `tools/fake_model.py`, gated three ways — see the dev-override note in §7.1 |

---

## 2. Architecture — one engine, one bridge, one gate

```
Cairnline browser
   │  POST /api/trish/chat        (existing endpoint, unchanged)
   ▼
server/trish.py  ── backend = hermes ──▶  127.0.0.1:8642/v1   (Hermes profile: cairnline)
   │  backend = direct  ──▶ any OpenAI-compatible endpoint         │
   │                                                               ├─ memory: MEMORY.md / USER.md
   └─ /api/trish/evolution/*  ────────────────────────────────▶    ├─ skills: Project/skills (external_dirs)
        (new: state, pending, approve, memory, skills, eval)       ├─ MCP: cairnline (our data, below)
                                                                   └─ curator cron → proposes patches
                                                                        │
                                            server/trish_mcp.py ◀───────┘  stdio MCP server
                                            (quote, indicators, signals, cot,
                                             calendar, size, risk_gate, edge_stats,
                                             backtest)
```

**Why a separate profile.** `hermes profile create cairnline` gives Trish her own
`MEMORY.md`, `USER.md`, `skills/`, `mcp_servers`, model and gateway. The
alternative — reusing the `default` profile — means everything her personal agent
learns from Telegram leaks into the trading desk and vice versa, and every MCP
server you have wired for yourself (`composio`, `cua`, browser control) becomes
reachable from a dashboard chat box. Separate profile is the difference between a
desk assistant and an unattended general agent with your accounts.

**Why an MCP bridge instead of duplicating tools.** In `hermes` mode our
`TRISH_TOOLS` are dropped, so Trish loses `risk_gate` — the one tool that must
never be optional. Exposing the market service as an MCP server keeps one
implementation of the data path and gives Hermes a `mcp-cairnline` toolset we can
allowlist. It also makes the same data available to any other agent later
(the plan's "public Cairnline MCP server" is this file plus a transport).

**Why keep the direct backend.** Hermes is a second process that can be down,
upgraded, or misconfigured mid-session. With `direct` kept as fallback, Trish
still answers (without learning) and the UI shows `degraded: no learning`
instead of an error. That also keeps the app honest for anyone who runs Cairnline
without Hermes installed.

---

## 3. What the learning loop actually does

1. **After a turn** — Hermes' `suggest_after_turn` review looks at the
   conversation and, if a workflow repeated, proposes a skill (new or patched).
   With `skills.write_approval: true` it lands in the pending queue, never in the
   live catalogue.
2. **Memory nudges** — Hermes periodically proposes `MEMORY.md` / `USER.md`
   entries ("operator flat-by 21:00 UTC", "prefers 15m entries"). Same gate.
3. **Nightly curator** — a cron session with a narrow prompt: read the last N
   desk sessions, propose at most 2 changes, each with *mechanism* not narrative.
   Explicitly forbidden: any statement about an edge, a win rate, or "this
   pattern works" — those belong to Edge Stats, which can defend them with N and
   a confidence interval.
4. **You approve** — the Settings queue shows the diff (skill body / memory line),
   the session that motivated it, and Approve / Reject. Reject archives it.
5. **Eval gate** — approving a *skill* patch re-runs the desk eval set (12 fixed
   prompts: chart read, news gate, size a trade, refuse an unsafe order, and so
   on). If a golden regresses, the patch is auto-reverted and the queue entry
   says so. This is the only thing standing between "self-improving" and
   "self-degrading", and it is cheap because the eval set is fixed text.
6. **Journey** — the Settings panel shows what she learned, when, from which
   session, and what was reverted. Hermes archives rather than deletes, so the
   audit trail survives.

---

## 4. Brainstorm — the options I considered and why they lose

| Option | Verdict |
|---|---|
| **A. Hermes as Trish's runtime + our MCP bridge + gated learning** (recommended) | Fastest real capability: providers, MCP, memory, skills, curator, sessions — all existing and MIT. Costs one supervised process and a config surface. |
| **B. Hermes only as a nightly curator, chat stays on the direct loop** | Cheaper and safer, but Trish still can't *use* the skills she learns in the moment, and you get two brains with different tool access. Good fallback if A's process management proves annoying. |
| **C. Embed Hermes as a Python library inside `server/trish.py`** | Not possible: it is an application (CLI, gateway, terminal backends, 400 MB source), not an importable SDK. Anything pretending otherwise is a fork we'd maintain forever. |
| **D. Ship Hermes to the browser / run it in the dashboard tab** | No. It has shell, filesystem and Docker backends; it must never be a client-side dependency. |
| **E. Build the learning loop ourselves** (memory + skill writes + curator + evals) | Months, and we would get the boring parts wrong (progressive disclosure, session search, profile isolation). Borrowing is the whole point. |
| **F. Another agent framework** (OpenClaw, CrewAI, LangGraph…) | Same or worse on the specific thing you asked for — a loop that persists what it learned. It is also the engine this workspace already runs, vendored at `vendor/hermes-agent`. |
| **G. Keep the current "direct only" Trish** | Honest but static: every improvement is a code change by us, which is exactly what you asked to escape. |

Two variants worth naming, because they change the scope:

- **"Auto-evolve with no approval"** — the thing you asked for literally. I'd
  refuse it for skill and memory writes: an unreviewed patch can silently change
  how she sizes a trade or reads a chart, and the failure mode is money, not a
  bad paragraph. A middle ground exists: auto-approve **memory** entries that are
  restatements of facts you typed in chat, keep **skills** strictly gated. That is
  the version I'd ship.
- **"Let her learn trading rules from results"** — a learning loop that watches
  trade outcomes and rewrites strategy skills. Tempting, and wrong at this sample
  size: our own Backtest Studio shows a 50-trade strategy's edge is indistinguishable
  from noise. If Trish must learn from results, the only honest route is
  Edge Stats presets with N and CI, and that is a *query*, not a belief.

---

## 5. Settings surface (the part you asked for)

One new card in the existing `#/settings` page (no new route), below the provider
card: **Trish → Evolution**. The status pills and the Engine/Learning cards described
here are shipped; the sliders, curator and eval controls are the target surface — §7.1
lists what actually exists today.

**Status row (pills, shipped):** `engine` (hermes · revision), `gateway` (running ·
pid / stopped), `model`, `skills` (catalogue count), `MCP` (cairnline · 14 tools),
`pending` (queue depth), `toolsets` (on · deferred), `profile`.

**Learning card**
- toggles: *remember desk facts*, *propose skills after a turn*, *nightly curator*,
  *auto-approve fact-only memory* (default off), *auto-approve skills* (present but
  disabled with the reason: "not available — a skill can change how she sizes a trade").
- sliders/inputs: max turns per chat, daily token cap, curator hour, sessions to
  review per night.
- kill switch: **Stop learning** → flips `write_approval` on, pauses the curator
  cron and calls `hermes pause` on the profile. One click, immediate.

**Pending queue**
- one row per proposal: kind (skill new / skill patch / memory), title, the session
  it came from, a diff, Approve / Reject, and for skills the eval result after
  approval. Empty state: "Nothing waiting. She has not proposed anything since …".

**Memory**
- two editable text areas (`MEMORY.md`, `USER.md`), the last-write time, and
  "edited by: you / Trish (approved 12 Nov)". Saving writes through the profile dir.

**Skills**
- the 27-row catalogue with layer, last modified, "mine / Trish" tag, and a
  read-only viewer. `trish-desk-method` (L1) is marked **locked** — a patch to the
  method skill must be a code change by us, not a proposal.

**Journey**
- last 20 learned items: what, when, from which session, approved/archived, eval
  delta. This is the answer to "what did she actually teach herself".

**Eval**
- "Run desk eval" → 12 prompts against the current profile, pass/fail per prompt,
  diff against the last run; the same set runs automatically after a skill approval.

---

## 6. Guardrails — non-negotiable, in the first PR

1. **Loopback only.** `API_SERVER_HOST=127.0.0.1`, `API_SERVER_KEY` set (random,
   ≥32 chars), key stored in `runtime/hermes/.env` and in the app's config only as a
   reference — never rendered back to the browser. No CORS origins.
2. **No shell for the desk profile.** `agent.disabled_toolsets` must remove
   `terminal`, `code_execution`, `browser`, and `cua`-style MCP servers. Trish gets:
   `mcp-cairnline` (our data), `memory`, `skills`, and file **read** inside the
   project only. If a workflow seems to need a shell, that is a missing MCP tool,
   not a reason to hand her the terminal.
3. **No order tools, ever.** `risk_gate` stays in our MCP server and its limits
   (`RISK_LIMITS`) stay in our code. The agent cannot read or write them; a skill
   cannot change them. Orders remain a human click in a later phase, if ever.
4. **The method skill is locked.** `trish-desk-method` (L1) is only changed by a
   commit we make, because it is the one file that defines what she refuses.
5. **Skills may not encode market claims.** Enforced in three places: the curator
   prompt, a linter in our `build_skill_index.py` (reject numeric edge claims
   without a source), and the approval queue showing the diff to you.
6. **Memory is per-profile and single-operator.** This app is one desktop user.
   If Cairnline ever serves multiple accounts, one shared Hermes profile leaks
   memory between them — it must become one profile per user, or the loop stays off.
7. **Budget.** Max turns per chat, daily token cap, and a hard stop when the cap is
   hit (the UI says "Trish is out of budget for today" rather than silently
   spending). Measure the vendored gateway's RSS before adding more.
8. **Pinned version + contract test.** Hermes is installed from git and updates
   itself; the plan pins the vendored commit (`9dbaa77c`) in the app's health check and asserts the shapes we
   depend on (`/v1/chat/completions`, `/v1/skills`, `/v1/toolsets`) in a small CI
   script, so an upstream change fails loudly instead of quietly.

---

## 7. Phases (each one shippable on its own)

| Phase | Work | Done when | Est. |
|---|---|---|---|
| **P0 — engine on** | `hermes profile create cairnline`; `API_SERVER_ENABLED=true` + key on that profile (first check whether a new profile inherits the `default` profile's providers or needs its own — profiles may have separate `.env`s); Settings backend → hermes; health check in `/api/health` | A chat turn in the dashboard is answered by Hermes, `GET /v1/skills` answers with its key, and the provider card shows `gateway: running · profile: cairnline` | 0.5 d |
| **P1 — data bridge** | `server/trish_mcp.py` (stdio MCP over the existing handlers, 9 tools incl. `risk_gate` and an `edge_stats` query); register as `cairnline` in the profile config with an allowlist | A Hermes turn calls `get_indicators` and `risk_gate` and returns real numbers; `POST` with a blocked trade returns BLOCK | 1 d |
| **P2 — skills visible** | `skills.external_dirs: ["<app>/skills"]` in the profile; normalise the 22 trader skills' `${CLAUDE_SKILL_DIR}`; index rebuilt | `/v1/skills` lists 27+ and a chat turn loads `cairnline-risk-discipline` | 1 d |
| **P3 — settings** | The Evolution card (§5) + `/api/trish/evolution/*` endpoints (state, pending, approve/reject, memory read/write, skills list, eval run) | Every pill reflects a real check; approving a proposal changes the profile; memory edits persist | 2 d |
| **P4 — the loop** | `write_approval` on skills and memory, `suggest_after_turn`, nightly curator cron with the "no market claims" prompt, 12-prompt eval + auto-revert | A real session produces a pending proposal; approving it passes eval; a deliberately bad patch is auto-reverted | 2 d |
| **P5 — hardening** | Toolset lockdown, budget caps, kill switch, pinned-version contract test, README for the two-process setup | Contract test fails cleanly on a simulated upstream change; kill switch stops writes and pauses cron | 1 d |
| **P6 — fallback polish** | Direct backend keeps the same 8 tools + skill index; UI badge for degraded mode | Stop Hermes → chat still answers, badge says "no learning" | 0.5 d |

Roughly **8 working days**, P0–P2 being the ones that visibly change what Trish can
do. P3 is the "settings for easy access" you asked for; P4 is the actual
self-improvement.

### 7.1 Shipping state, 17 Nov 2026

| Phase | State | Evidence |
|---|---|---|
| P0 engine on | **done** | vendored checkout + `runtime/venv` + `runtime/hermes`; gateway on `127.0.0.1:8642`, 401 without the bearer, 200 with it; `POST /api/trish/engine {"action":"start\|stop\|restart"}` returns `gateway.up` from a live probe |
| P1 data bridge | **done** | 14 tools; `backtest` returns real metrics/equity and `propfirm_simulate` a pass probability, both driven over stdio like a client; a real turn ran `tool_search` → `tool_describe` → `tool_call` and returned EURUSD 1h indicators (bars 1571, RSI 53.13, ATR 0.001073) inside `<untrusted_tool_result source="mcp__cairnline__get_indicators">` |
| P2 skills visible | **done** | `hermes skills list`: 27 local skills loaded from `Project/skills` |
| P3 settings | **done** | `GET/POST /api/trish/{engine,memory,pending,skills,journey}` + two cards in `#/settings` (screenshots `checks/trish-engine.png`, `checks/trish-learning.png`); stop → port closed → start → `up:true`; learning toggles round-trip through `config.yaml` and a gateway restart; both gates proven by staging an unapproved write |
| P3 approval loop | **done** | staged memory write → `Approve` → `MEMORY.md` written by the engine; staged skill create → `Approve` → `runtime/hermes/skills/<name>/SKILL.md` created; `Reject` → archived under `pending/rejected/` and nothing on disk; a refused approval stays queued instead of vanishing |
| P4 the loop | **partly** | gates, `suggest_after_turn` and the queue are live; the **nightly curator cron and the 12-prompt eval with auto-revert are not built** |
| P5 hardening | **partly** | toolset lockdown, loopback+key, gated writes and a one-click stop/start are live; budget caps, the pinned-version contract test and the two-process README are not |
| P6 fallback | **partly** | the direct backend (`server/trish.py`, 8 tools, `RISK_LIMITS`) still exists and is selectable in the Provider card; the degraded-mode badge is not built |

What is **not verified**: a real-model turn. This machine has no cloud provider
key, so every end-to-end run above used `tools/fake_model.py`, a deterministic
OpenAI-compatible SSE double on `:8801` that is never imported by the app. The
engine, the bridge, the gates and the replay are real; the words Trish would say
with a real model are not.

**Dev provider override.** `tools/fake_model.py` is a scripted SSE double on
`127.0.0.1:8801`, with no model behind it. Three things keep it from being mistaken
for one: the script refuses to start unless `TRISH_DEV_FAKE_MODEL=1` is in its
environment; `POST /api/trish/engine` refuses a `base_url` on that port unless the
same variable is set in `runtime/hermes/.env`; and `GET /api/trish/engine` returns a
`provider` block (`fake_model`, `dev_override`, `warning`) that the Engine card shows
as a red `DEV` pill plus a warning line whenever a model resolves to that port. Delete
the line from `.env` and set a real provider and none of it can engage.

---

## 8. Decisions I need from you

1. **Separate profile (`cairnline`) or reuse `default`?** I recommend separate: her
   memory must not be your personal agent's memory, and your `cua`/`composio` MCP
   servers must not be reachable from the desk chat. Cost: one more supervised
   process (~250 MB).
2. **Approval policy.** My default: memory proposals that restate facts you typed
   are auto-approved; everything else (new skills, skill patches, inferred
   preferences) waits for you. Do you want *all* memory gated too?
3. **Model for Trish.** Hermes' profile carries its own model. Keep it on the
   provider you already pay for, or give the desk profile a cheaper model and let
   the curator use a small one?
4. **Budget.** Turns per chat (default 8) and a daily token cap (default: none →
   set one, e.g. 300k tokens/day). Do you want a hard stop or a warning?
5. **Does the dashboard ever need Hermes' own TUI/dashboard?** I'd say no — one
   surface (Trish in Cairnline) and Settings as the control room. Embedding a
   second chat UI would split her memory story in two.

---

## 9. What I will not pretend

- **"Self-improving" is not free.** Hermes' loop is good at procedure and memory;
  it has no notion of statistical significance. A skill it writes can be confidently
  wrong. The eval set and your approval are the mitigation, not a guarantee.
- **The gateway is a real agent with real reach.** Even locked down, it reads files
  in the project and calls MCP tools. If a prompt-injected market headline ever
  reached it, the blast radius is our own data and files — not your broker, because
  no order tool exists.
- **Cost scales with autonomy.** The curator runs nightly whether or not you look
  at the queue; a chat turn can loop. Without the cap in P5, this is the easiest way
  to burn a month of credits in a week.
- **Hermes is a moving target.** Commit `9dbaa77c` today, 73k commits upstream. The contract
  test and pinned version are the difference between an upgrade and an outage.
- **Multi-user is out of scope.** One profile, one operator. Serving this to
  accounts would need per-user profiles and a re-think of the memory model.
