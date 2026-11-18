---
name: cairnline-chart-read
description: "Read a Cairnline chart: the seeded EMA 9/21/50 + RSI studies, how to interpret the bias summary, and how the confidence number is produced. Use for 'what is X doing', 'read this chart', 'is it bullish'."
version: 1.0.0
license: MIT
metadata:
  cairnline:
    pack: trish
    layer: L3
    provider_neutral: true
---

# Reading a Cairnline chart

The terminal seeds three EMAs and an RSI on the price pane. The bias summary is
computed from their agreement, not from a single indicator.

## What the summary fields mean

| Field | Meaning |
|---|---|
| `bias` | long / short / neutral from the EMA stack + MACD sign + RSI side |
| `confidence` | share of those signals that agree, 45–85% in practice |
| `reasons` | the exact signals that agreed — quote these, do not paraphrase |
| `entry` / `stop_loss` / `take_profit` | 1× ATR stop, 2× ATR target from the last close |
| `risk_reward` | target distance ÷ stop distance |

## How to read it out loud

State bias, then the one or two reasons with the largest weight, then the level
that would invalidate it. Example shape:

> EURUSD 15m reads short at 75%: EMA 9 < 21 < 50 and MACD histogram negative.
> A close back above the 21 EMA (~1.1093) would void it.

## Traps

- Low RSI alone is not a long. Below 30 with a bearish stack is momentum, not
  mean reversion, unless price is also at a structure low.
- `confidence` above 80% usually means few bars or a runaway move; check `bars`.
- A flat 24×5 pair at the Asian session open has thin ATR — size off ATR, not off
  the confidence number.
