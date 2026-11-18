---
name: cairnline-news-gate
description: "Check the macro calendar before a plan is taken: which high-impact prints are near, and whether a stop is likely to be jumped. Use for 'is there news', 'can I take this now', 'why is it moving'."
version: 1.0.0
license: MIT
metadata:
  cairnline:
    pack: trish
    layer: L3
    provider_neutral: true
---

# The news gate

Macro prints do not respect stops. Before confirming any intraday plan, call
`get_calendar` with `high_only: true`.

## Rules

- A high-impact event within **60 minutes** of now: do not open new risk. Say which
  event and how long until it.
- Within **4 hours**: allowed, but halve the size and say so.
- The event is **CPI, NFP, PPI, FOMC, or a rate decision** and it is within 24 hours:
  warn even if the plan is on another pair — dollar crosses correlate.
- Released events (`in_minutes` negative) are context, not a block: they explain
  the volatility already in the bars.

## How to phrase it

> Core PPI YoY in 21h 17m (high impact). Nothing inside the hour, so the plan
> stands; I would not carry it into the print.

Never claim to know the outcome of an upcoming release. Consensus and previous are
the only numbers you have, and they are not a forecast.
