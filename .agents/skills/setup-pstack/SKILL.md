---
name: setup-pstack
description: "Check or change pstack's single delegate model: every role runs on the current chat model."
version: 0.1.0
author: poteto (Hermes adaptation, project-local edit)
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [engineering, workflow]
    related_skills: []
---

# Setup pstack (project-local, single model)

This project installs pstack as project skills under `.agents/skills/`. Nothing is written outside
the project: there is no `~/.cursor/rules`, no `~/.claude/rules`, and no `~/.agents/pstack-models.md`.

Model choice is recorded in **`.agents/pstack-models.md`** at the project root. The current setup is
**one model for everything**: every role is `inherit-parent`, so each `delegate_task` subagent runs on
the model the parent chat is already running. No role pins a separate slug, and no per-role panel
spreads across models.

## Steps

### 1. Read current state

```bash
cat .agents/pstack-models.md
hermes config get delegation
```

Two facts matter:

- `delegation.model` and `delegation.provider` must stay **empty** for `inherit-parent`. Empty means
  delegates inherit the parent chat model.
- `delegation.reasoning_effort` stays empty unless the user explicitly asks for a budget, in which
  case it takes one of `xhigh`, `high`, `medium`, `low`, and every delegate runs at that effort
  regardless of role.

### 2. Do not write outside the project

Never run `hermes config set`, `hermes plugin add`, or write to `~/.hermes`, `~/.claude`, `~/.cursor`,
or `~/.agents` as part of pstack setup. If the user wants a different model per role, say plainly that
this project is configured for a single model and that per-role pins live outside the project, then
let them choose.

### 3. Change something only if asked

- **Keep it single-model (default):** no action. Confirm all roles read `inherit-parent`.
- **Pin one different model for all delegates:** that is a global Hermes setting, not a project file.
  Tell the user the exact command (`hermes config set delegation.model <slug>`) and that it affects
  every project using that Hermes profile. Do not run it unprompted.
- **Set a reasoning budget:** same restriction; report the command instead of running it.

### 4. Verify

`hermes config get delegation` shows `model: ''`, `provider: ''`, and an empty `reasoning_effort` for
the default. If any of those are pinned, say so rather than assuming the project file wins.

### 5. Confirm

Tell the user that pstack skills load from `.agents/skills/`, that `.agents/pstack-models.md` records
the single-model choice, and that nothing was written outside the project.

### 6. Verification offers (optional)

Offer once, without pushing:

- A project-local verification skill, so agents can drive the app the way a user does:
  `load pstack:create-verification-skill`.
- A formal verification skill, so agents can prove a property holds in every case in scope:
  `load pstack:create-formal-verification-skill`.
