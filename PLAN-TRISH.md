# Trish AI — skills, providers, MCP, and the learning loop

Research date: 2026-11-12

Sources read in full:
`NousResearch/hermes-agent` (MIT, 404 MB source), `Jakeschincariol/trader-skill` (MIT),
`Jakeschincariol/day-trader-skill` (MIT).

---

## 0. Where Trish is today

Trish is **not an AI**. `app/dashboard/js/pages/terminal.js` builds canned sentences from
indicator values (`say(...)` with template strings); the "chat" input re-reads
`state.indicators.summary` and pattern-matches. There is no provider, no model, no tools,
no memory. Everything below is therefore net-new surface, not a refactor.

---

## 1. What the research answers

### Does Hermes allow different AI providers? — **Yes, 40 of them.**

| Layer | Evidence |
|---|---|
| Declarative profiles | `providers/base.py` → `ProviderProfile` dataclass; "declarative, do not own client construction" |
| Registry | `providers/__init__.py` → `register_provider()`, `get_provider_profile()`, `list_providers()`, lazy plugin discovery |
| 40 provider plugins | `plugins/model-providers/*` incl. `anthropic`, `openai-codex`, `gemini`, `openrouter`, `deepseek`, `ollama-cloud`, `lmstudio`, `bedrock`, `azure-foundry`, `nous`, `custom` |
| Switching | `hermes model` — no code change, no lock-in |
| Custom endpoints | `custom` profile + `api_mode` fallback; per-user overrides in `$HERMES_HOME/plugins/model-providers/` |

Profiles carry auth type, endpoints, quirks (`prepare_messages`, `build_extra_body`,
`OMIT_TEMPERATURE` sentinel for Kimi), model listing, hostname mapping. So "not only Claude"
is not a fork — it is the default design.

### Does it accept MCP servers? — **Yes, stdio and remote HTTP.**

`~/.hermes/config.yaml`:
```yaml
mcp_servers:
  filesystem:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"]
```
Automatic tool discovery at startup, MCP resources/prompts wrappers, **per-server tool
filtering** so only chosen tools reach the model. Implementation: `tools/mcp_tool_transport.py`,
`mcp_tool_scope.py`, `mcp_tool_schema.py`, `mcp_tool_sampling.py`, `tui_gateway/mcp_oauth_sessions.py`.
Coming from Claude Code, `mcpServers` maps 1:1 to `mcp_servers`.

### Does it accept skills? — **Yes, and it writes its own.**

- Standard: `SKILL.md` with YAML frontmatter (`name`, `description`, `version`, `author`,
  `license`, `platforms`, `metadata.hermes.tags`, `related_skills`) + optional
  `references/ templates/ scripts/ assets/`. Compatible with **agentskills.io**.
- Location: `~/.hermes/skills/` is source of truth; bundled catalog seeded from the repo;
  **`external_dirs`** lets it scan a shared `~/.agents/skills/` alongside — directly useful
  to us, since this machine already keeps skills there.
- Progressive disclosure: the description is what loads; the body loads on demand.
- Hub install (official / ClawHub / GitHub) with a security scan (`skills_guard.py`,
  `skills_ast_audit.py`, `skills_guard_credentials.py`).

### Self-evolving? — **Yes, four mechanisms, all inspectable.**

| Mechanism | Where |
|---|---|
| **Autonomous skill creation** — after a non-trivial workflow, the agent calls `skill_manage create` | `tools/skill_manager_tool.py` |
| **Skill self-improvement** — targeted `patch` during use; linter warns (`incident-log-shape`, `references-sprawl`, `oversized-body`) | `tools/skill_linter.py` |
| **Memory** — `MEMORY.md` (facts) + `USER.md` (profile), with periodic nudges and a write-approval gate | `agent/memory_manager.py`, `memory_provider.py` |
| **Journey / curator** — a graph of learned skills + memories; background review; consolidation; delete = *archive* with restore | `agent/learning_graph.py`, `learning_mutations.py`, `agent/curator.py` |

Plus FTS5 session search, Honcho dialectic user modeling, `skills.write_approval` to require
human review of every skill write (staged in `~/.hermes/pending/skills/`).

### The critical unlock

Hermes runs an **OpenAI-compatible HTTP API**:

```
API_SERVER_ENABLED=true
hermes gateway      →  http://127.0.0.1:8642/v1
POST /v1/chat/completions   {"model":"hermes-agent", ...}
```

Requests execute with the **full toolset — memory and skills included** — and streaming
returns inline tool-progress events. That single fact decides the architecture.

### The trader skills

Two MIT packs, 22 skills total, plain Python 3.8+ stdlib only, public data (Yahoo v8 chart,
SEC EDGAR, House Clerk):

**trader-skill** (swing/investor): `trader-copycat` (13F reverse-engineering),
`trader-pelosi` (congress PTR), `trader-news`, `trader-analyst` (XBRL earnings),
`trader-budget`, `trader-risk`, `trader-broker` (Alpaca paper), `trader-alerts`,
`trader-screener`, `trader-rebalance`, `trader-tax`.

**day-trader-skill** (intraday): the same core plus `trader-scanner`, `trader-entry`
(opening-range timer), `trader-exit` (stop/target from OR midpoint, ATR), and
**`trader-timemachine`** — 10,000 replays of the remaining session from the symbol's own
60 days of 5-minute bars, plus the same rule re-run on every past session.

Two portability facts that shape the work:

1. They are written for **Claude Code** and use `${CLAUDE_SKILL_DIR}` inside their
   `SKILL.md` command examples — the same trap I hit with `ui-ux-pro-max`'s
   `${CLAUDE_PLUGIN_ROOT}`. Under any other host that variable is empty and every
   `python3 "${CLAUDE_SKILL_DIR}/size.py"` silently becomes `python3 "/size.py"`.
2. Their safety model is **"nothing places an order without your yes"**, paper trading by
   default (`trader-risk` prints PASS/BLOCK and is final; `trader-broker` re-asks). We must
   preserve that gate exactly; it is the most valuable part of the packs.

---

## 2. Architecture

**One interface, two backends.** The dashboard talks to a single chat endpoint on our
market service; the service forwards to whichever backend is configured.

```
                    ┌──────────────────────────────────────────────┐
 Browser (Trish)    │  server/trish_service.py                      │
 ─── POST /api/trish/chat ──▶  ┌───────────────────────────────┐    │
     (OpenAI wire shape)      │ backend = hermes | direct      │    │
                              └───────┬───────────────┬───────┘    │
                                      │               │            │
              ┌───────────────────────▼──┐   ┌────────▼──────────┐ │
              │ Hermes  :8642/v1         │   │ Direct provider    │ │
              │ skill_manage, memory,    │   │ OpenRouter/OpenAI/ │ │
              │ MCP servers, curator     │   │ Ollama + our tools │ │
              └──────────────────────────┘   └───────────────────┘ │
                    └──────────────────────────────────────────────┘
```

- **Backend A — Hermes (default when present).** We reuse providers, MCP, skills and the
  learning loop unchanged. Our service is a thin, audited proxy.
- **Backend B — Direct (fallback).** Any OpenAI-compatible endpoint (`base_url` + `key` +
  `model`) with a small tool registry we own. Same `/api/trish/chat` contract, so the UI
  never knows which is running. This is what makes the answer to "does it only do Claude"
  a *no* even without Hermes.

Why not embed Hermes in the browser: it is a 404 MB Python application with a terminal,
Docker/SSH backends and a gateway. It belongs as a sibling process, never shipped to the
client. Why not skip Hermes: building providers + MCP + a learning loop ourselves is
months of work we would get wrong; borrowing it is the whole point.

---

## 3. Skill packaging (provider-agnostic)

The trader packs must run under Hermes **and** under the direct backend **and** under any
future host. So skills get a normalisation step:

### 3.1 Vendor and normalise

```
app/dashboard/skills/            # human-readable, versioned copy
  trader/day-trader/trader-entry/ SKILL.md  + entry.py
  trader/day-trader/trader-exit/  SKILL.md  + exit.py
  trader/day-trader/trader-timemachine/ SKILL.md + timemachine.py
  …
  trader/_shared/config.json      # sec_user_agent, budget caps
tools/port_skill.py              # the normaliser
```

`tools/port_skill.py` does, per skill, deterministically:
1. `s/${CLAUDE_SKILL_DIR}/{{SKILL_DIR}}/g` — a documented placeholder every host resolves.
2. `s/${CLAUDE_PLUGIN_ROOT}/{{SKILLS_ROOT}}/g` (same class of bug).
3. Rewrite `python3 "{{SKILL_DIR}}/x.py"` → `{{PY}} "{{SKILL_DIR}}/x.py"` so an
   interpreter is configurable.
4. Add `metadata.pipnex.host: any`, `provider_neutral: true`, and `requires: [python3]`.
5. Strip Claude-only frontmatter keys, keep everything else byte-identical.
6. Emit a `PROVENANCE.md` per skill: repo, commit SHA, license, diff summary.

Both packs are MIT — vendoring is fine with attribution. A CI check re-runs the porter and
fails on drift.

### 3.2 Path resolution in each host

| Host | How `{{SKILL_DIR}}` is resolved |
|---|---|
| Hermes | `skills.external_dirs: [~/.agents/skills, <app>/skills]`, plus a pre-tool hook that `export`s `SKILL_DIR` |
| Direct backend (our tools) | the tool wrapper substitutes before spawning `python3` |
| Claude Code | a generated `~/.claude/skills` symlink tree with the original variable restored |

Never ship a skill whose commands depend on a variable we cannot resolve — the porter
refuses and prints the offending line.

---

## 4. Trish's own skill set (what we train her on)

Three layers, added to `app/dashboard/skills/trish/`:

**L1 — Method (always loaded, small).** `trish-desk-method`: the house procedure —
*context → structure → level → risk → plan → verdict*, what each step needs, and what she
must refuse (no order without a yes, no invented levels, no plan without a stop).

**L2 — Domain skills (loaded on intent).** The vendored trader packs, namespaced so Trish
can call them by intent rather than by repo:
`entry-timing` → trader-entry, `exit-planning` → trader-exit, `odds` → trader-timemachine,
`position-sizing` → trader-budget, `risk-gate` → trader-risk, `news-scan` → trader-news,
`congress-flow` → trader-pelosi, `13f-copy` → trader-copycat, `earnings` → trader-analyst.

**L3 — Pipnex-specific (ours).** These encode what only this app knows:
`pipnex-chart-read` (Vela + the seeded EMA/RSI studies), `pipnex-signal-plan` (basket
engine → entry/SL/TP on the chart), `pipnex-news-gate` (NewsIQ high-impact events within N
hours), `pipnex-account-limits` (plan, uploads/day, MT5 state), `pipnex-research-cite`
(LuxAlgo CC0 record + LSE COT/calendar provenance rules).

Routing: a ~300-token `trish-index` lists every skill's description; the model picks by
description (progressive disclosure, same as Hermes). No skill is force-loaded.

---

## 5. MCP for Trish

Two directions:

**Consume MCP servers** — via Hermes `mcp_servers` (already supported) or, on the direct
backend, our own `mcp_client.py` speaking the same protocol. Per-server allowlists so a
market-data MCP cannot touch the filesystem. Candidate servers that fit the desk: a
broker/paper-trading server, a calendar server, the LuxAlgo ecosystems' own MCP
(`luxalgo-mcp-server`), and the REA/craft-anything servers already configured on this box.

**Expose Trish as MCP** — wrap our market service endpoints (`/api/quotes`, `/api/indicators`,
`/api/cot`, `/api/calendar`, `/api/basket/signals`) as MCP tools so any agent, including
Hermes subagents, can read real Pipnex data. One `trish_mcp.py`, ~150 lines, reusing the
existing handlers.

---

## 6. The learning loop, and its guardrails

Turn on in `~/.hermes/config.yaml`:

```yaml
skills:
  external_dirs: ["<app>/skills", "~/.agents/skills"]
  write_approval: true          # stage every skill write for review
  suggest_after_turn: true      # background review proposes skills
memory:
  write_approval: true
```

Then Trish learns from *our* desk: after three chart reads that all rejected a setup for
the same reason, the background review proposes a `pipnex-chart-read` patch. Two payoffs:

- **Skill ledger as audit trail.** `~/Pipnex/trish/journey` shows every learned skill and
  memory with provenance, and deletions archive rather than destroy.
- **Trading-specific truth.** A skill must never encode a market claim it cannot re-derive
  from live data. Our `trish-desk-method` states this as a hard rule and the suggestion pass
  is instructed to reject incident narration ("today gold dumped") in favour of mechanism
  ("a gap fill after a dividend date is not an edge").

Memory files get the same treatment: `MEMORY.md` holds durable desk facts (symbol basket, plan
tier, timezone, flat-by time); `USER.md` holds the operator's preferences. Both are visible
and editable in Settings.

---

## 7. Implementation phases

| Phase | Work | Deliverable | Est. |
|---|---|---|---|
| **0** | Trish provider card in Settings: backend (Hermes / direct), base URL, key, model, test button. `/api/trish/chat` proxy with the OpenAI wire shape; streaming SSE passthrough. | Trish answers with a real model | 1 day |
| **1** | `tools/port_skill.py` + vendor both trader packs + provenance. Verify `${CLAUDE_SKILL_DIR}` is gone everywhere. | 22 skills, host-neutral, in repo | 1 day |
| **2** | L1 + L3 skills authored (5 files). `trish-index` loader and description-based routing. | Trish follows the desk method | 1–2 days |
| **3** | Tool registry for the direct backend: candles, indicators, signals, COT, calendar, risk calc, chart drawings. Each maps to an existing endpoint — no new data code. | Trish can actually act | 2 days |
| **4** | Hermes backend: service detection, `skill_manage`/memory write-approval, journey view surfaced in Settings. MCP allowlist. | Self-improving Trish | 2 days |
| **5** | Guardrails: risk-gate skill wired so any proposed order returns BLOCK/PASS with a reason; approval card in chat; nothing auto-executes. Audit log per session. | Safe by construction | 1–2 days |
| **6** | Evals: a fixed set of desk prompts (chart read, news gate, size a trade, refuse an unsafe order) run against both backends; pass/fail diff in CI. | Regression safety for skill edits | 1 day |

**Phase 5 is not optional and not last-by-accident** — it ships *with* phase 3, before any
order-shaped tool exists. The packs' own rule ("no order without your yes") becomes our gate.

---

## 8. Decisions I need from you

1. **Backend preference.** Run Hermes as the runtime (fastest path to learning + MCP, one
   more process to keep alive), or start with the direct OpenAI-compatible path (fewer moving
   parts, no learning loop) and add Hermes in phase 4? I lean **direct first, Hermes second** —
   phases 0–3 give a working Trish without depending on a 404 MB service, and Hermes then
   upgrades her in place behind the same endpoint.
2. **Which model.** OpenRouter gives model choice with one key; OpenAI/Anthropic directly if
   you already have credit; Ollama if you want it local and free.
3. **Execution scope.** Paper only (Alpaca paper, as the packs default) or real broker later?
   I will build paper-only regardless, behind the risk gate.
4. **Who can approve.** Every order needs a click — yours only, or any signed-in account?

## 9. What I will not pretend

- The packs read **Yahoo/SEC/US** public data. Our desk trades FX, gold and BTC. Skills like
  `trader-entry`/`trader-exit` (opening-range on equities) do not port to 24×5 FX without
  reworking the session model; `trader-timemachine`'s algorithm does port (it is bar-ratio
  resampling, symbol-agnostic), and I would point it at our LSE bars instead of Yahoo.
- `trader-broker` targets **Alpaca's** `place_stock_order`. Ours would be a paper ledger
  until a broker is chosen.
- A learning loop will sometimes learn the wrong thing. That is why `write_approval: true`
  and the journey view are in the design, not bolted on later.
