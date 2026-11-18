---
name: cairnline-signal-plan
description: "Use the Cairnline basket engine: rank all pairs at one timeframe, pick the best setup, and explain why the top one beat the rest. Use for 'best trade now', 'what should I trade', 'scan the pairs'."
version: 1.0.0
license: MIT
metadata:
  cairnline:
    pack: trish
    layer: L3
    provider_neutral: true
---

# The signal basket

`get_signals` ranks every pair in the basket at one interval. It is the desk's
first pass, not its conclusion.

## Workflow

1. `get_signals` at the operator's interval.
2. Take the top 2–3 by confidence, not just the top one: the highest-confidence
   row is sometimes the most extended.
3. Re-read the chosen symbol with `get_indicators` before proposing anything —
   the basket summary is coarser than the per-symbol read.
4. Gate it: `get_calendar` (news) then `risk_gate` (limits).

## Judgement, not ranking

- Prefer the pair whose reasons are structural (EMA stack) over the one whose only
  reason is an oscillator extreme.
- If the top three are the same direction and the same currency leg (EURUSD short,
  GBPUSD short, EURJPY short — all short EUR), that is one trade, not three. Say it.
- Confidence below 60% across the whole basket means the session is ranging; the
  honest answer is "no high-quality setup right now".

Never present a ranked list as a recommendation without the gate applied to at
least the one you are actually proposing.
