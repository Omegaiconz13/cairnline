/**
 * PineTS bridge (LuxAlgo, AGPL-3.0).
 *
 * stdin : { candles: [{openTime,open,high,low,close,volume}], preset: "core" }
 * stdout: { plots: {...}, summary: { bias, confidence, rsi, atr, ... } }
 *
 * The Pine below is ordinary v6 Pine Script: the same text would run on
 * TradingView. Values are real indicator output on real bars, not a simulation.
 */
import { PineTS } from 'pinets';

const PRESETS = {
  core: `
//@version=6
indicator("PipNex core", overlay=true)
emaFast = ta.ema(close, 9)
emaMid  = ta.ema(close, 21)
emaSlow = ta.ema(close, 50)
rsiVal  = ta.rsi(close, 14)
atrVal  = ta.atr(14)
[macdLine, signalLine, histLine] = ta.macd(close, 12, 26, 9)
basis   = ta.sma(close, 20)
dev     = 2 * ta.stdev(close, 20)
bbUpper = basis + dev
bbLower = basis - dev
plot(emaFast, "ema9")
plot(emaMid, "ema21")
plot(emaSlow, "ema50")
plot(rsiVal, "rsi")
plot(atrVal, "atr")
plot(histLine, "macdHist")
plot(bbUpper, "bbUpper")
plot(bbLower, "bbLower")
`,
  smc: `
//@version=6
indicator("PipNex structure", overlay=true)
swingHigh = ta.highest(high, 20)
swingLow  = ta.lowest(low, 20)
emaFast   = ta.ema(close, 9)
emaMid    = ta.ema(close, 21)
rsiVal    = ta.rsi(close, 14)
atrVal    = ta.atr(14)
plot(swingHigh, "swingHigh")
plot(swingLow, "swingLow")
plot(emaFast, "ema9")
plot(emaMid, "ema21")
plot(rsiVal, "rsi")
plot(atrVal, "atr")
`,
};

const last = (series) => {
  if (!series) return null;
  const arr = series.data ?? series;
  if (!Array.isArray(arr) || !arr.length) return null;
  const tail = arr[arr.length - 1];
  return typeof tail === 'number' ? tail : tail?.value ?? null;
};

const round = (v, d = 6) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(d)) : null);

function summarise(plots, candles) {
  const ema9 = last(plots.ema9);
  const ema21 = last(plots.ema21);
  const ema50 = last(plots.ema50);
  const rsi = last(plots.rsi);
  const atr = last(plots.atr);
  const macdHist = last(plots.macdHist);
  const bbUpper = last(plots.bbUpper);
  const bbLower = last(plots.bbLower);
  const swingHigh = last(plots.swingHigh);
  const swingLow = last(plots.swingLow);

  const price = candles.length ? candles[candles.length - 1].close : null;
  if (price === null) return { error: 'no price' };

  // Trend from the EMA stack, momentum from MACD histogram, filter from RSI.
  const stackUp = ema9 > ema21 && ema21 > ema50;
  const stackDown = ema9 < ema21 && ema21 < ema50;
  const aboveFast = price > ema9;

  let votes = 0;
  const reasons = [];
  if (stackUp) { votes += 2; reasons.push('EMA stack bullish (9 > 21 > 50)'); }
  if (stackDown) { votes += 2; reasons.push('EMA stack bearish (9 < 21 < 50)'); }
  if (macdHist > 0) { votes += 1; reasons.push('MACD histogram positive'); }
  if (macdHist < 0) { votes += 1; reasons.push('MACD histogram negative'); }
  if (rsi > 55) { votes += 1; reasons.push(`RSI ${round(rsi, 1)} — momentum up`); }
  if (rsi < 45) { votes += 1; reasons.push(`RSI ${round(rsi, 1)} — momentum down`); }
  if (bbUpper && price > bbUpper) { votes += 1; reasons.push('Price above upper Bollinger band'); }
  if (bbLower && price < bbLower) { votes += 1; reasons.push('Price below lower Bollinger band'); }

  const bias = stackUp ? 'long' : stackDown ? 'short' : aboveFast ? 'long' : 'neutral';
  const confidence = Math.min(95, 35 + votes * 10);

  // ATR-derived risk levels: 1x ATR stop, 2x ATR target (R:R 1:2).
  const atrSafe = atr && atr > 0 ? atr : price * 0.002;
  const entry = price;
  const stop = bias === 'short' ? entry + atrSafe : entry - atrSafe;
  const target = bias === 'short' ? entry - atrSafe * 2 : entry + atrSafe * 2;

  return {
    price: round(price),
    bias,
    confidence,
    reasons,
    entry: round(entry),
    stop_loss: round(stop),
    take_profit: round(target),
    risk_reward: 2,
    rsi: round(rsi, 2),
    atr: round(atrSafe),
    macd_hist: round(macdHist),
    ema9: round(ema9), ema21: round(ema21), ema50: round(ema50),
    bb_upper: round(bbUpper), bb_lower: round(bbLower),
    swing_high: round(swingHigh), swing_low: round(swingLow),
    trend: stackUp ? 'up' : stackDown ? 'down' : 'flat',
  };
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const { candles, preset = 'core' } = JSON.parse(raw || '{}');
  if (!Array.isArray(candles) || candles.length < 10) {
    console.error('need at least 10 candles');
    process.exit(2);
  }

  const script = PRESETS[preset] || PRESETS.core;
  const engine = new PineTS(candles);
  const result = await engine.run(script);

  const plots = {};
  for (const [name, series] of Object.entries(result.plots || {})) {
    if (name.startsWith('__')) continue;
    const arr = series?.data ?? series;
    if (Array.isArray(arr)) {
      plots[name] = arr.slice(-400).map((p) => (typeof p === 'number' ? p : p?.value ?? null));
    }
  }

  process.stdout.write(JSON.stringify({
    plots,
    summary: summarise(plots, candles),
    preset,
    engine: 'PineTS',
  }));
}

main().catch((err) => {
  console.error(String(err && err.message ? err.message : err));
  process.exit(1);
});
