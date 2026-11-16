/**
 * PipnexProvider — a Vela DataProvider over the local market service.
 *
 * Vela owns caching, chunked history backfill and live polling; this object only
 * answers "bars for ticker + timeframe". Contract notes (from Vela's provider rules):
 *   - `time` must be the bar OPEN time in epoch milliseconds (our service already
 *     emits `openTime` in epoch ms).
 *   - Return ascending, de-duplicated bars; the newest bar is the forming candle.
 *   - A timeframe the source can never serve must THROW DataUnavailableError, not
 *     return [] (an empty answer means "end of history").
 *
 * No `subscribe`: with live: true, Vela polls getBars for us — no WebSocket needed.
 */

const BASE = (() => `${location.protocol}//${location.hostname || '127.0.0.1'}:8788`)();

/** Vela timeframe → [yfinance interval, yahoo range]. */
const TF_MAP = {
  '1':   ['1m',  '5d'],
  '5':   ['5m',  '1mo'],
  '15':  ['15m', '1mo'],
  '30':  ['30m', '3mo'],
  '60':  ['1h',  '3mo'],
  'D':   ['1d',  '5y'],
  'W':   ['1wk', '10y'],
  'M':   ['1mo', 'max'],
};

const NO_VOLUME = new Set(['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCHF', 'EURJPY', 'GBPJPY', 'XAUUSD']);

/** Normalise Vela's timeframe strings (numbers are minutes; D/W/M canonical). */
function normTF(tf) {
  const aliases = { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '1d': 'D', '1w': 'W', '1M': 'M' };
  return aliases[String(tf)] ?? String(tf);
}

/** Aggregate n×1h bars into 4h bars (yahoo serves no native 4h interval). */
function aggregate(bars, factor) {
  const out = [];
  for (let i = 0; i < bars.length; i += factor) {
    const chunk = bars.slice(i, i + factor);
    if (!chunk.length) break;
    out.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map((b) => b.high)),
      low: Math.min(...chunk.map((b) => b.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, b) => s + (b.volume || 0), 0),
    });
  }
  return out;
}

function toOHLCV(rows) {
  return rows
    .map((b) => ({
      time: Number(b.openTime ?? b.time),
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
      volume: Number(b.volume || 0),
    }))
    .filter((b) => Number.isFinite(b.time) && Number.isFinite(b.close))
    .sort((a, b) => a.time - b.time)
    .filter((b, i, arr) => i === 0 || b.time !== arr[i - 1].time);
}

async function fetchBars(sym, yfInterval, range) {
  const url = `${BASE}/api/candles?symbol=${encodeURIComponent(sym)}&interval=${yfInterval}&range=${range}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`market service ${res.status}`);
  const body = await res.json();
  if (body.stale) console.warn(`[pipnex] candles for ${sym} served stale (${body.error || 'provider failed'})`);
  return body.bars || [];
}

export const PipnexProvider = {
  name: 'pipnex',

  async getBars(ticker, timeframe) {
    const tf = normTF(timeframe);
    const sym = ticker.includes(':') ? ticker.split(':')[1] : ticker;
    const yfSym = sym === 'XAUUSD' ? 'GC=F' : sym === 'BTCUSD' ? 'BTC-USD' : sym;

    // 4h: yahoo serves no native 4h interval — aggregate 4×1h in the provider (rule 7).
    if (tf === '240') return aggregate(toOHLCV(await fetchBars(yfSym, '1h', '1y')), 4);

    const mapped = TF_MAP[tf];
    if (!mapped) throw new window.Vela.DataUnavailableError({ reason: 'timeframe', finest: '60', default: '60' });
    return toOHLCV(await fetchBars(yfSym, mapped[0], mapped[1]));
  },

  /** Lets bare symbols resolve here and feeds any symbol-picker UI. */
  async listSymbols() {
    const rows = [
      ['EURUSD', 'Euro / US Dollar', 'forex'],
      ['GBPUSD', 'British Pound / US Dollar', 'forex'],
      ['USDJPY', 'US Dollar / Japanese Yen', 'forex'],
      ['AUDUSD', 'Australian Dollar / US Dollar', 'forex'],
      ['USDCHF', 'US Dollar / Swiss Franc', 'forex'],
      ['EURJPY', 'Euro / Japanese Yen', 'forex'],
      ['GBPJPY', 'British Pound / Japanese Yen', 'forex'],
      ['XAUUSD', 'Gold Spot (via COMEX GC=F)', 'commodity'],
      ['BTCUSD', 'Bitcoin / US Dollar', 'crypto'],
    ];
    return rows.map(([t, description, type]) => ({
      ticker: t,
      description,
      type,
      prefix: 'PIPNE',
    }));
  },

  async getSymbolInfo(ticker) {
    const t = ticker.includes(':') ? ticker.split(':')[1] : ticker;
    return {
      ticker: t,
      description: t === 'XAUUSD' ? 'Gold Spot' : t,
      timezone: 'Etc/UTC',
      session: t === 'BTCUSD' ? '24x7' : '24x5',
      currency: t.endsWith('USD') ? 'USD' : undefined,
      volume: !NO_VOLUME.has(t),
      timeframes: { finest: '1', default: '15' },
    };
  },
};

/** Vela theme matched to the Pipnex token language (deep black / Netflix red / lime data). */
export function pipnexTheme(VelaNS) {
  return VelaNS.createTheme({
    colors: {
      background: '#050505',
      text: '#F5F7F8',
      grid: '#191A1D',
      border: '#26272A',
      up: '#B4FF3A',
      down: '#FF5A5F',
    },
    accent: '#E50914',
    radius: 'md',
    font: 'Inter, system-ui, sans-serif',
  });
}
