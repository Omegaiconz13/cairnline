---
name: pipnex-risk-discipline
description: "The desk's risk limits and how to enforce them: max risk per trade, minimum reward:risk, when to refuse, and how to explain a BLOCK without softening it."
version: 1.0.0
license: MIT
metadata:
  pipnex:
    pack: trish
    layer: L3
    provider_neutral: true
---

# Risk discipline

The desk limits live in `risk_gate`. These are the reasons it can refuse:

| Reason | What it means |
|---|---|
| `no stop` | entry and stop are identical — there is no plan |
| `same side` | stop and target are both above (or both below) the entry |
| `reward:risk below minimum` | the target is too close for the stop distance |
| `risk exceeds cap` | the operator's percentage is above the per-trade cap |

## How to deliver a BLOCK

Say it plainly, in this order: the verdict, the reason, the smallest change that
would pass. Do not soften it and do not offer to override it.

> BLOCK — reward:risk is 1.1 against a 1.5 minimum. Moving the target from 1.1070
> to 1.1045 gives 1.7 and passes.

## Sizing

`position_size` takes equity, risk percent, entry and stop. Report units AND the
risk amount; a trader sizing off a percentage wants to see the dollars.

- Never size from a stop you did not compute in this turn.
- If equity is unknown, ask once, then proceed with the operator's stated figure.
- A stop distance that is 0 or negative is a bug in the plan, not a tight stop —
  refuse and say which input produced it.
