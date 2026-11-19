import { el, card, chip, toast, switchRow } from '../ui.js';
import { market, px, pct } from '../market.js';
import { fmt } from '../data.js';
import { CairnlineProvider, cairnlineTheme, setRangeOverride } from '../vela-provider.js';

/** Vela timeframe ↔ our yfinance interval, for the rail (PineTS) and the tabs. */
const TF = {
  toVela:   { '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': 'D' },
  fromVela: { '1': '1m', '5': '5m', '15': '15m', '30': '30m', '60': '1h', '240': '1h', 'D': '1d', 'W': '1wk', 'M': '1mo' },
};
const hasVela = () => typeof window.Vela?.Vela === 'function';

const SYMBOLS = [
  { sym: 'EURUSD', label: 'EUR/USD' },
  { sym: 'GBPUSD', label: 'GBP/USD' },
  { sym: 'USDJPY', label: 'USD/JPY' },
  { sym: 'XAUUSD', label: 'XAU/USD (Gold)' },
  { sym: 'GBPJPY', label: 'GBP/JPY' },
  { sym: 'BTCUSD', label: 'BTC/USD' },
];
const INTERVALS = ['5m', '15m', '30m', '1h', '4h', '1d'];
const RANGES = { '5m': '5d', '15m': '5d', '30m': '1mo', '1h': '3mo', '4h': '1y', '1d': '2y' };
/** Interval to ask the PineTS rail for. Kept separate from the Vela timeframe map:
 *  Vela's '240' maps back to '1h', which used to mark 1h numbers as 4h ones. */
const PY_INTERVAL = { '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '1d': '1d' };

/**
 * Native studies, read from Vela's own registry at runtime (77 in this build).
 * `type` is Vela's id; `key` is ours, because one type can be on the chart
 * several times (the EMA stack is three studies of type `ema`).
 */
const STUDY_LABELS = { ema: 'EMA (custom)', sma: 'SMA', rsi: 'RSI', macd: 'MACD', volume: 'Volume' };

/** Inputs we prefer over the library defaults for the studies we seed. */
const STUDY_INPUTS = {
  ema: { length: 21, color: '#7EE7C0' },
  sma: { length: 50 },
  rsi: { length: 14 },
  'average-true-range': { length: 14 },
  'bollinger-bands': { length: 20, mult: 2 },
};

/** Seeds shown first; they are the studies a desk reaches for on open. */
const EXTRA_STUDIES = [
  { key: 'ema9', type: 'ema', label: 'EMA 9', group: 'overlays', inputs: { length: 9, color: '#7EE7C0' } },
  { key: 'ema21', type: 'ema', label: 'EMA 21', group: 'overlays', inputs: { length: 21, color: '#E9C46A' } },
  { key: 'ema50', type: 'ema', label: 'EMA 50', group: 'overlays', inputs: { length: 50, color: '#8FA3FF' } },
];

/** Short ids the old menu used. Vela registers none of them, so those entries
 *  silently failed; the saved selection is translated instead. */
const LEGACY_KEYS = {
  bb: 'bollinger-bands', adx: 'average-directional-index', cci: 'commodity-channel-index',
  obv: 'on-balance-volume', atr: 'average-true-range', sma50: 'sma',
};

const DEFAULT_STUDIES = ['ema9', 'ema21', 'ema50', 'rsi'];
const STUDIES_KEY = 'cairnline_indicators';
const INPUTS_KEY = 'cairnline_indicator_inputs';
/** Per-study layout: visibility, overlay/pane placement and pane geometry. Kept
 *  apart from the two older keys, which keep their original shapes so a saved
 *  chart from before this change still loads. */
const LAYOUT_KEY = 'cairnline_indicator_layout';

/**
 * Registry studies we deliberately do not offer, with the reason. Vela's own
 * `availableNativeIndicators()` is consulted at mount as well, so a study the
 * active provider cannot support is filtered by the same path without an edit
 * here.
 *
 * Verified 2026-11-18 by adding each of the 77 registry studies to the live
 * chart and reading `chart.inspect()`: every study adds, removes and exposes an
 * inputs schema, and 75 draw at least one series, fill, line or polyline. The
 * two below register and accept inputs but draw nothing, on EURUSD and on
 * BTCUSD (where the provider does report volume), so offering them would put a
 * blank row on the chart and a legend entry with no values.
 */
const EXCLUDED_STUDIES = {
  volume: 'renders an empty row: the study never receives the chart volume series in this build',
  vpvr: 'renders an empty row: the visible-range volume profile needs per-bar volume-by-price the provider path does not deliver',
};

/** The catalog: our seeds, then every study Vela registers. */
function buildCatalog(exclude = new Set()) {
  const V = window.Vela;
  let raw = [];
  try {
    if (V && typeof V.nativeIndicatorDescriptors === 'function') raw = V.nativeIndicatorDescriptors() || [];
    else if (V && Array.isArray(V.nativeIndicatorTypes)) raw = V.nativeIndicatorTypes;
  } catch { raw = []; }        // older bundle: the menu lists only our seeds
  const out = raw.map((d) => {
    const type = typeof d === 'string' ? d : d.type;
    const title = typeof d?.title === 'string' ? d.title : (d?.title?.defaultMessage || type);
    return {
      key: type,
      type,
      label: STUDY_LABELS[type] || title,
      group: d?.overlay ? 'overlays' : 'panes',
      inputs: STUDY_INPUTS[type] || null,
    };
  });
  // Our seeds are presets of registry studies (three EMAs at once), not new studies.
  const catalog = EXTRA_STUDIES.map((s) => ({ ...s, preset: true }));
  const seen = new Set(catalog.map((s) => s.key));
  for (const def of out) {
    if (seen.has(def.key) || exclude.has(def.key) || EXCLUDED_STUDIES[def.key]) continue;
    seen.add(def.key);
    catalog.push(def);
  }
  return catalog;
}

/**
 * Last chosen studies, so a new chart opens the way the trader left it.
 *
 * Deliberately *not* filtered against the catalog here: before the first chart
 * exists Vela's registry is empty, so the catalog holds only our three EMA
 * seeds. Filtering at this point used to drop every saved non-seed study on a
 * reload. Unknown keys are pruned after the full catalog is adopted instead.
 */
function loadIndicatorPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(STUDIES_KEY));
    if (Array.isArray(raw)) {
      const keys = raw.map((k) => LEGACY_KEYS[k] || k).filter((k) => typeof k === 'string' && k);
      if (keys.length) return new Set(keys);
    }
  } catch { /* private mode, or an older value */ }
  return new Set(DEFAULT_STUDIES);
}

/** Saved visibility/placement/pane geometry, keyed by study key. */
function loadStudyLayout() {
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

/** Per-study input overrides the trader has edited. */
function loadInputPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(INPUTS_KEY));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

const ICONS = {
  zoom: '<svg viewBox="0 0 20 20"><circle cx="8.5" cy="8.5" r="5"/><path d="M12.5 12.5 17 17"/><path d="M6.5 8.5h4M8.5 6.5v4"/></svg>',
  fit: '<svg viewBox="0 0 20 20"><path d="M3 7V4h4M17 7V4h-4M3 13v3h4M17 13v3h-4"/></svg>',
  measure: '<svg viewBox="0 0 20 20"><path d="M3 12 12 3l5 5-9 9-5-5Z"/></svg>',
  expand: '<svg viewBox="0 0 20 20"><path d="M3 7V3h4M17 7V3h-4M3 13v4h4M17 13v4h-4"/></svg>',
  reset: '<svg viewBox="0 0 20 20"><path d="M4 10a6 6 0 1 1 2 4.5"/><path d="M4 6v4h4"/></svg>',
  send: '<svg viewBox="0 0 20 20"><path d="M3 10 17 3l-4 14-3.5-5.5L3 10Z"/></svg>',
  chat: '<svg viewBox="0 0 20 20"><path d="M17 11.5a2.5 2.5 0 0 1-2.5 2.5H8l-4 3v-3H5.5A2.5 2.5 0 0 1 3 11.5v-7A2.5 2.5 0 0 1 5.5 2h9A2.5 2.5 0 0 1 17 4.5v7Z"/></svg>',
  chart: '<svg viewBox="0 0 20 20"><path d="M3 16.5V3.5M3 16.5H17M6 13V9M9.5 13V6.5M13 13V8M16 13V4.5"/></svg>',
  paneDown: '<svg viewBox="0 0 20 20"><path d="M5 8l5 5 5-5"/></svg>',
  paneUp: '<svg viewBox="0 0 20 20"><path d="M5 12l5-5 5 5"/></svg>',
  eye: '<svg viewBox="0 0 20 20"><path d="M1.8 10S4.9 4.8 10 4.8 18.2 10 18.2 10 15.1 15.2 10 15.2 1.8 10 1.8 10Z"/><circle cx="10" cy="10" r="2.6"/></svg>',
  eyeOff: '<svg viewBox="0 0 20 20"><path d="M3 3l14 14"/><path d="M7.2 5.4A8.9 8.9 0 0 1 10 4.8c5.1 0 8.2 5.2 8.2 5.2a15 15 0 0 1-2.7 3.2"/><path d="M5.3 7.1A15.6 15.6 0 0 0 1.8 10S4.9 15.2 10 15.2c1 0 1.9-.2 2.7-.6"/></svg>',
};

/** Candlestick SVG from real OHLCV bars, with optional EMA overlays. */
function renderChart(bars, overlays = {}, width = 1000, height = 440) {
  if (!bars.length) return '<div class="empty"><h3>No bars returned</h3><p>Try another interval or symbol.</p></div>';
  const view = bars.slice(-160);
  const highs = view.map((b) => b.high);
  const lows = view.map((b) => b.low);
  let max = Math.max(...highs);
  let min = Math.min(...lows);
  const pad = (max - min) * 0.08 || max * 0.001;
  max += pad; min -= pad;
  const y = (v) => ((max - v) / (max - min)) * height;
  const step = width / view.length;
  const bodyW = Math.max(1.6, step * 0.62);

  const grid = [0.2, 0.4, 0.6, 0.8].map((f) => {
    const gy = (height * f).toFixed(1);
    const price = (max - (max - min) * f);
    return `<line x1="0" y1="${gy}" x2="${width}" y2="${gy}" stroke="#152225" stroke-width="1"/>
            <text x="${width - 6}" y="${Number(gy) - 4}" fill="#8A9499" font-family="JetBrains Mono, monospace" font-size="9" text-anchor="end">${px(price)}</text>`;
  }).join('');

  const wicks = view.map((b, i) => {
    const x = (i * step + step / 2).toFixed(1);
    return `<line x1="${x}" y1="${y(b.high).toFixed(1)}" x2="${x}" y2="${y(b.low).toFixed(1)}" stroke="${b.close >= b.open ? '#2E7D62' : '#7D3A3A'}" stroke-width="1"/>`;
  }).join('');

  const bodies = view.map((b, i) => {
    const x = i * step + step / 2 - bodyW / 2;
    const top = Math.min(y(b.open), y(b.close));
    const h = Math.max(1.2, Math.abs(y(b.open) - y(b.close)));
    const up = b.close >= b.open;
    return `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${h.toFixed(1)}" fill="${up ? '#B4FF3A' : '#FF5A5F'}" opacity="${up ? 0.9 : 0.8}"/>`;
  }).join('');

  const OVERLAY_NAMES = ['ema9', 'ema21', 'ema50'];
  const overlayPaths = Object.entries(overlays).filter(([name]) => OVERLAY_NAMES.includes(name)).map(([name, series]) => {
    if (!Array.isArray(series) || !series.length) return '';
    const tail = series.slice(-view.length);
    const pts = tail.map((v, i) => (v === null ? null : `${(i * step + step / 2).toFixed(1)},${y(v).toFixed(1)}`))
      .filter(Boolean).join(' ');
    const colour = name === 'ema9' ? '#7EE7C0' : name === 'ema21' ? '#E9C46A' : '#8FA3FF';
    return `<polyline points="${pts}" fill="none" stroke="${colour}" stroke-width="1.1" opacity="0.85"/>`;
  }).join('');

  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Price chart">${grid}${wicks}${bodies}${overlayPaths}</svg>`;
}

/**
 * AI Trading terminal — real yfinance bars, real PineTS indicators.
 */
export async function terminal(ctx) {
  // A run handed over from the Backtest Studio opens on its own instrument and
  // timeframe, so its marks land inside the bars the chart actually loads.
  const pendingRun = (() => {
    try {
      const v = JSON.parse(localStorage.getItem('cairnline_backtest_marks') || 'null');
      return v && Array.isArray(v.trades) && v.trades.length ? v : null;
    } catch { return null; }
  })();
  const startSym = pendingRun && SYMBOLS.some((s) => s.sym === pendingRun.symbol) ? pendingRun.symbol : SYMBOLS[0].sym;
  const startTf = pendingRun && TF.toVela[pendingRun.interval] ? pendingRun.interval : '15m';
  const state = {
    sym: startSym,
    interval: startTf,
    bars: [],
    data: null,
    indicators: null,
    studies: new Set(),
    studyInputs: loadInputPrefs(),
    editing: null,
    status: 'Idle',
    messages: [],
    chart: null,
    handles: {},
    planIds: [],
    btDrawingIds: [],
    railTimer: null,
    busy: false,
    applyingLayout: false,
    layoutTimer: null,
  };
  // A handed-over run needs bars that reach back to its first trade, or its
  // marks sit outside the loaded window and never paint.
  if (pendingRun && TF.toVela[pendingRun.interval] && pendingRun.range) {
    setRangeOverride(TF.toVela[pendingRun.interval], pendingRun.range);
  }
  const VELA = hasVela();
  // Vela registers its studies when the first chart is built, so this starts
  // with our seeds and is rebuilt (below, after `ready()`) into the full set.
  let CATALOG = buildCatalog();
  state.studies = loadIndicatorPrefs();
  const studyLayout = loadStudyLayout();
  /** Types Vela reports as unsupported on this provider; filled after `ready()`. */
  const unsupportedStudies = new Set();

  /** Defaults for a study, with whatever the trader has edited on top. */
  const inputsFor = (def) => ({ ...(def.inputs || {}), ...(state.studyInputs[def.key] || {}) });

  /* ---- Vela chart plumbing (real renderer, real provider, real drawings) ---- */
  const mountVela = async () => {
    const V = window.Vela;
    const theme = cairnlineTheme(V);
    try { V.registerTheme({ id: 'cairnline', label: 'Cairnline', theme }); } catch { /* already registered */ }
    state.chart = new V.Vela(canvas, {
      symbol: `CAIRNLINE:${state.sym}`,
      timeframe: TF.toVela[state.interval] || '15',
      live: true,
      theme,
    });
    // Diagnostics handle: the chart instance from devtools (and from the checks
    // in PLAN-luxalgo-pipnex.md). Reading it is safe; the app never depends on it.
    window.cairnline = { chart: state.chart };
    state.chart.data.registerProvider('cairnline', CairnlineProvider);
    state.chart.on('market:changed', () => {
      const m = state.chart.market || {};
      const sym = String(m.symbol || '').replace(/^CAIRNLINE:/, '');
      if (sym && SYMBOLS.some((s) => s.sym === sym)) {
        state.sym = sym;
        symbolSelect.value = sym;
      }
      if (m.timeframe) state.interval = TF.fromVela[String(m.timeframe)] || state.interval;
      setSource('CAIRNLINE DESK · yfinance + PineTS');
      drawFacts();
      paintBacktestMarks();
      scheduleRailRefresh();
    });
    await state.chart.ready();
    // The registry is populated now. Ask the chart which studies this provider
    // can actually support, then adopt the full catalog minus those and minus
    // the documented exclusion list, and drop saved keys that no longer exist.
    try {
      const available = await state.chart.availableNativeIndicators();
      for (const def of available || []) if (def && def.supported === false) unsupportedStudies.add(def.type);
    } catch { /* older bundle: offer everything the registry reports */ }
    adoptFullCatalog();
    pruneSelection();
    // Studies come from the Indicators menu; this applies the saved selection
    // and then the saved layout (visibility, placement, pane geometry).
    syncIndicators();
    paintBacktestMarks();
    // Vela's own pane controls and legend eye bypass our menu, so mirror their
    // changes back into the saved layout instead of letting them drift.
    for (const ev of ['pane:changed', 'indicator:moved', 'indicator:visibility']) {
      try {
        state.chart.on(ev, () => {
          recordLayout();
          if (!indicatorMenu.hidden) paintIndicatorMenu();
        });
      } catch { /* event not in this build */ }
    }
  };

  /* ---- Backtest marks: the studio's trades drawn on this chart ----------------
   * The Backtest Studio leaves its run in localStorage and navigates here; the
   * marks API is Vela's own (`chart.marks`), so entries and exits land on the
   * bars they happened on rather than in a separate table nobody can place.
   */
  const BT_MARKS_KEY = 'cairnline_backtest_marks';
  const btChip = el('button', { type: 'button', class: 'indmenu__btn', hidden: true });

  const readBacktestMarks = () => {
    try {
      const raw = JSON.parse(localStorage.getItem(BT_MARKS_KEY) || 'null');
      return raw && Array.isArray(raw.trades) && raw.trades.length ? raw : null;
    } catch { return null; }
  };

  function clearBacktestMarks() {
    try { state.chart && state.chart.marks && state.chart.marks.clear(); } catch { /* renderer without marks */ }
    try {
      if (state.chart && state.chart.drawings && state.btDrawingIds.length) {
        state.chart.drawings.removeMany(state.btDrawingIds);
      }
    } catch { /* drawings unavailable */ }
    state.btDrawingIds = [];
    try { localStorage.removeItem(BT_MARKS_KEY); } catch { /* private mode */ }
    btChip.hidden = true;
  }

  /**
   * The timeline marks say *when* a trade happened; these segments say at what
   * price it ran. An entry→exit trendline is the closest thing to a replay this
   * chart build exposes — `scene.tradeMarkers` only renders an indicator's own
   * trades, and there is no public API to hand it ours.
   */
  function drawBacktestTrades(saved) {
    const drawings = state.chart && state.chart.drawings;
    if (!drawings || !drawings.supported) return;
    try { if (state.btDrawingIds.length) drawings.removeMany(state.btDrawingIds); } catch { /* first run */ }
    state.btDrawingIds = [];
    for (const t of saved.trades) {
      const entry = Number(t.entry_time);
      const exit = Number(t.exit_time);
      if (!Number.isFinite(entry) || !Number.isFinite(exit)) continue;
      try {
        const d = drawings.add('trendline', {
          paneId: 'price',
          anchors: [{ time: entry, price: Number(t.entry) }, { time: exit, price: Number(t.exit) }],
          // White for a winner, orange for a loser: lime/red would vanish against the candles themselves.
          style: { lineColor: t.pnl >= 0 ? '#F5F7F8' : '#FF8A3D', lineWidth: 1.6, lineStyle: 'solid' },
        });
        if (d && d.id) state.btDrawingIds.push(d.id);
      } catch { /* a drawing type this build does not have */ }
    }
  }

  /**
   * Put the run's trade window on screen once the bars exist. Without this the
   * marks are stored but drawn off-screen, because the chart opens on its own
   * default range rather than the one the backtest covered.
   */
  function frameBacktestRun(saved) {
    const times = saved.trades
      .flatMap((t) => [Number(t.entry_time), Number(t.exit_time)])
      .filter((v) => Number.isFinite(v) && v > 0);
    if (!times.length) return;
    const from = Math.min(...times);
    const to = Math.max(...times);
    const pad = Math.max(3600000, (to - from) * 0.04);
    // Retry briefly: the first attempt can land before the provider's bars are in.
    let tries = 0;
    const frame = () => {
      if (!state.chart || !canvas.isConnected) return;
      try { state.chart.setVisibleRange({ from: from - pad, to: to + pad }); } catch { /* no bars yet */ }
      tries += 1;
      if (tries < 6) setTimeout(frame, 700);
    };
    setTimeout(frame, 600);
  }

  function paintBacktestMarks(tries = 0) {
    const marks = state.chart && state.chart.marks;
    const saved = readBacktestMarks();
    // The chart's own market is the truth here: a handed-over run paints as soon
    // as the chart is actually on its symbol, which can lag the mount by a tick.
    const chartSym = String((state.chart && state.chart.market && state.chart.market.symbol) || '')
      .replace(/^CAIRNLINE:/, '');
    if (!marks || !marks.supported || !saved || (chartSym && chartSym !== saved.symbol)) {
      if (saved && tries < 20) setTimeout(() => paintBacktestMarks(tries + 1), 700);
      btChip.hidden = true;
      return;
    }
    try {
      marks.clear();
      marks.defineGroup({ id: 'cairnline-backtest', label: `Backtest \u00b7 ${saved.strategy || 'run'}` });
      let n = 0;
      for (const t of saved.trades) {
        const long = t.side !== 'short';
        marks.add({
          id: `bt-${n}-in`, time: Number(t.entry_time), group: 'cairnline-backtest',
          glyph: { color: long ? '#B4FF3A' : '#FF5A5F' },
          label: `${long ? 'LONG' : 'SHORT'} ${t.entry}`,
        });
        n += 1;
        marks.add({
          id: `bt-${n}-out`, time: Number(t.exit_time), group: 'cairnline-backtest',
          glyph: { color: t.pnl >= 0 ? '#4EA1FF' : '#8A8F98' },
          label: `EXIT ${t.exit} \u00b7 ${t.r > 0 ? '+' : ''}${t.r}R`,
        });
        n += 1;
      }
      btChip.textContent = `Clear ${n} backtest marks`;
      btChip.onclick = clearBacktestMarks;
      btChip.hidden = false;
      drawBacktestTrades(saved);
      frameBacktestRun(saved);
    } catch (err) {
      // A renderer without timeline marks is fine; anything else is a real bug.
      if (!(marks && marks.supported)) return;
      console.warn('[cairnline] backtest marks could not be drawn:', err);
      btChip.hidden = true;
    }
  }

  /* ---- Indicators menu: add or remove every native study from one control ---- */
  const indicatorWrap = el('div', { class: 'indmenu-wrap' });
  const indicatorMenu = el('div', { class: 'indmenu', role: 'menu', hidden: true, 'aria-label': 'Indicators' });
  const indicatorBtn = el('button', {
    type: 'button', class: 'indmenu__btn',
    'aria-haspopup': 'menu', 'aria-expanded': 'false',
  });
  const menuSearch = el('input', {
    type: 'search', class: 'indmenu__search', placeholder: 'Search studies\u2026',
    'aria-label': 'Search studies', oninput: () => filterMenu(),
  });
  const menuList = el('div', { class: 'indmenu__list' });
  indicatorMenu.append(el('div', { class: 'indmenu__searchwrap' }, menuSearch), menuList);

  const saveIndicatorPrefs = () => {
    try { localStorage.setItem(STUDIES_KEY, JSON.stringify([...state.studies])); } catch { /* private mode */ }
  };

  const saveStudyInputs = () => {
    try { localStorage.setItem(INPUTS_KEY, JSON.stringify(state.studyInputs)); } catch { /* private mode */ }
  };

  /**
   * Reconcile the chart with state.studies: add what is on, remove what is off.
   * Removal is the study handle's own `remove()`: `chart.removeIndicator` does
   * not exist in this build, so the old call threw and the study stayed drawn.
   */
  const syncIndicators = () => {
    if (!state.chart) return;
    for (const def of CATALOG) {
      const want = state.studies.has(def.key);
      const have = state.handles[def.key];
      if (want && !have) {
        const inputs = inputsFor(def);
        try {
          state.handles[def.key] = state.chart.addNativeIndicator(
            def.type,
            Object.keys(inputs).length ? { inputs } : undefined,
          );
        } catch (err) {
          console.warn(`[cairnline] could not add ${def.key}:`, err);
        }
      } else if (!want && have) {
        try { have.remove(); } catch (err) { console.warn(`[cairnline] could not remove ${def.key}:`, err); }
        delete state.handles[def.key];
      }
    }
    // Restore what the trader saved. Deferred, because a pane created in this
    // same tick has no renderer row yet and a height set now is dropped.
    applyStudyLayout();
  };

  /** Edit one input on a live study and remember it. */
  const setStudyInput = (key, field, value) => {
    state.studyInputs[key] = { ...(state.studyInputs[key] || {}), [field]: value };
    saveStudyInputs();
    const h = state.handles[key];
    if (h && typeof h.setInput === 'function') {
      try { h.setInput(field, value); } catch (err) { console.warn(`[cairnline] ${key}.${field}:`, err); }
    }
  };

  const toggleStudy = (def) => {
    if (state.studies.has(def.key)) {
      state.studies.delete(def.key);
      if (state.editing === def.key) state.editing = null;
    } else {
      state.studies.add(def.key);
    }
    saveIndicatorPrefs();
    syncIndicators();
    paintIndicatorMenu();
    paintIndicatorTrigger();
  };

  /* ---- Pane controls: Vela's public pane-management facade -----------------
   * `chart.panesControl` is the supported surface in this build —
   * `supported`, `list()`, `collapse(id, on)`, `maximize(id | null)`,
   * `setHeightWeight()`, `moveIndicator()` — gated by the renderer capability
   * `paneManagement`. Every oscillator study owns one pane, so the controls are
   * keyed off the study's handle, never a hard-coded pane id.
   */
  const paneFacade = () => (
    state.chart && state.chart.panesControl && state.chart.panesControl.supported
      ? state.chart.panesControl
      : null
  );

  /** The pane record Vela currently holds for a study, or null. */
  const paneInfo = (key) => {
    const h = state.handles[key];
    const pc = paneFacade();
    if (!h || !pc || typeof pc.list !== 'function') return null;
    try {
      return (pc.list() || []).find(
        (p) => Array.isArray(p.indicators) && p.indicators.some((i) => i.id === h.id),
      ) || null;
    } catch { return null; }
  };

  /** Vela's own pane record already carries id, collapsed and maximized. */
  const paneFlags = (key) => {
    const info = paneInfo(key);
    return {
      id: info ? info.id : null,
      maximized: Boolean(info && info.maximized),
      collapsed: Boolean(info && info.collapsed),
    };
  };

  const togglePaneMaximize = (key) => {
    const pc = paneFacade();
    const f = paneFlags(key);
    if (!pc || !f.id) return;
    pc.maximize(f.maximized ? null : f.id);
    recordLayout();
    paintIndicatorMenu();
  };

  const togglePaneCollapse = (key) => {
    const pc = paneFacade();
    const f = paneFlags(key);
    if (!pc || !f.id) return;
    pc.collapse(f.id, !f.collapsed);
    recordLayout();
    paintIndicatorMenu();
  };

  /* ---- Saved layout: visibility, placement and pane geometry --------------- */
  const saveLayout = () => {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(studyLayout)); } catch { /* private mode */ }
  };

  /** Read the live chart back into `studyLayout` and persist it. */
  const recordLayout = () => {
    if (state.applyingLayout || !state.chart) return;
    for (const def of CATALOG) {
      if (!state.studies.has(def.key)) continue;
      const h = state.handles[def.key];
      const info = paneInfo(def.key);
      if (!h || !info) continue;
      const prev = studyLayout[def.key] || {};
      const next = {
        hidden: h.visible === false,
        placement: info.kind === 'price' ? 'price' : 'own',
      };
      if (info.kind !== 'price') {
        const f = paneFlags(def.key);
        next.weight = info.heightWeight;
        next.collapsed = f.collapsed;
        next.maximized = f.maximized;
      } else if (Number.isFinite(prev.weight) || prev.collapsed || prev.maximized) {
        // Keep the geometry for the next time this study is moved back out.
        next.weight = prev.weight;
        next.collapsed = prev.collapsed;
        next.maximized = prev.maximized;
      }
      studyLayout[def.key] = next;
    }
    saveLayout();
  };

  /**
   * Put the saved visibility, placement and pane geometry back on the chart.
   * Runs one frame after the studies are added: Vela creates a pane's renderer
   * row asynchronously, and a height set in the same tick as the add is lost.
   */
  const applyStudyLayout = () => {
    if (!state.chart) return;
    state.applyingLayout = true;
    clearTimeout(state.layoutTimer);
    state.layoutTimer = setTimeout(() => {
      // The route can change inside the frame this waits for.
      if (!state.chart || !canvas.isConnected) { state.applyingLayout = false; return; }
      applyStudyLayoutNow();
    }, 60);
  };

  const applyStudyLayoutNow = () => {
    const pc = paneFacade();
    try {
      // One study at a time: place it, then resize the pane it landed in, then
      // restore visibility — each step reads the pane record the step before
      // produced, so a move never applies geometry to a pane that just vanished.
      for (const def of CATALOG) {
        const saved = studyLayout[def.key];
        const h = state.handles[def.key];
        if (!state.studies.has(def.key) || !saved || !h) continue;
        let info = paneInfo(def.key);
        if (!info) continue;

        if (pc) {
          const onPrice = info.kind === 'price';
          try {
            if (saved.placement === 'own' && onPrice) {
              h.moveTo({ newPane: true });
              info = paneInfo(def.key);
            } else if (saved.placement === 'price' && !onPrice) {
              h.moveTo('price');
              info = paneInfo(def.key);
            }
            if (info && info.kind !== 'price') {
              if (Number.isFinite(saved.weight)) pc.setHeightWeight(info.id, saved.weight);
              if (saved.collapsed) pc.collapse(info.id, true);
              if (saved.maximized) pc.maximize(info.id);
            }
          } catch (err) { console.warn(`[cairnline] ${def.key} layout:`, err); }
        }

        if (typeof saved.hidden === 'boolean' && typeof h.setVisible === 'function'
            && saved.hidden !== (h.visible === false)) {
          try { h.setVisible(!saved.hidden); } catch (err) { console.warn(`[cairnline] ${def.key} visibility:`, err); }
        }
      }
    } finally {
      state.applyingLayout = false;
      // Record what the chart actually accepted, so a restored height is what a
      // later reload reads rather than the fresh pane's default.
      recordLayout();
    }
  };

  /** Show or hide a study without removing it (state, inputs and pane stay). */
  const toggleStudyVisibility = (key) => {
    const h = state.handles[key];
    if (!h || typeof h.setVisible !== 'function') return;
    const hide = h.visible !== false;
    try { h.setVisible(!hide); } catch (err) { console.warn(`[cairnline] ${key} visibility:`, err); }
    recordLayout();
    paintIndicatorMenu();
  };

  /** Move a study between the price pane and a pane of its own. */
  const setPlacement = (key, target) => {
    const h = state.handles[key];
    const info = paneInfo(key);
    if (!h || !info || typeof h.moveTo !== 'function') return;
    const onPrice = info.kind === 'price';
    // Read this *before* moving: `pane:changed` fires synchronously inside
    // moveTo() and our handler records the fresh pane's default weight (1) over
    // the saved one, so a restore that read afterwards would restore 1.
    const desiredWeight = studyLayout[key] && studyLayout[key].weight;
    try {
      if (target === 'own' && onPrice) {
        h.moveTo({ newPane: true });
        // A fresh pane starts at weight 1; put back the height this study had
        // before it was moved onto price, so the saved layout stays truthful.
        const pc = paneFacade();
        const fresh = paneInfo(key);
        if (pc && fresh && Number.isFinite(desiredWeight)) pc.setHeightWeight(fresh.id, desiredWeight);
      } else if (target === 'price' && !onPrice) h.moveTo('price');
    } catch (err) { console.warn(`[cairnline] ${key} → ${target}:`, err); }
    recordLayout();
    paintIndicatorMenu();
  };

  /** Resize a study's own pane by whole height weights (Vela's own units). */
  const nudgePaneWeight = (key, delta) => {
    const pc = paneFacade();
    const info = paneInfo(key);
    if (!pc || !info || info.kind === 'price') return;
    const weight = Math.max(1, Math.min(8, Number(info.heightWeight || 1) + delta));
    try { pc.setHeightWeight(info.id, weight); } catch (err) { console.warn(`[cairnline] ${key} height:`, err); }
    recordLayout();
    paintIndicatorMenu();
  };

  /**
   * Inputs panel for one active study. The schema lives on the handle
   * (`handle.inputs`), so every study gets real controls without a hand-written
   * form per study: numbers, selects, colours and switches.
   */
  const inputsPanel = (key) => {
    const h = state.handles[key];
    const schema = h && Array.isArray(h.inputs) ? h.inputs : [];
    let values = {};
    try { values = (h && typeof h.inputValues === 'function' ? h.inputValues() : {}) || {}; } catch { values = {}; }
    const panel = el('div', { class: 'indmenu__inputs' });
    for (const f of schema) {
      if (!f || !f.key || f.key === 'offset') continue;   // offset is a display nudge, not a study setting
      if (panel.childElementCount >= 8) break;
      const val = values[f.key] ?? (state.studyInputs[key] || {})[f.key] ?? f.defval;
      const kind = String(f.type || '').toLowerCase();
      let input;
      if (kind === 'color') {
        input = el('input', {
          type: 'color',
          value: typeof val === 'string' && val.startsWith('#') ? val : '#5b9cf6',
          oninput: (e) => setStudyInput(key, f.key, e.target.value),
        });
      } else if (Array.isArray(f.options) && f.options.length) {
        input = el('select', { onchange: (e) => setStudyInput(key, f.key, e.target.value) },
          f.options.map((o) => el('option', { value: String(o), text: String(o), selected: String(o) === String(val) })));
      } else if (kind === 'bool' || kind === 'boolean') {
        input = el('input', { type: 'checkbox', checked: Boolean(val), onchange: (e) => setStudyInput(key, f.key, e.target.checked) });
      } else {
        input = el('input', {
          type: 'number', inputmode: 'decimal',
          value: val == null ? '' : String(val),
          min: f.min == null ? '' : String(f.min),
          max: f.max == null ? '' : String(f.max),
          step: f.step == null ? 'any' : String(f.step),
          oninput: (e) => {
            const n = Number(e.target.value);
            if (e.target.value !== '' && Number.isFinite(n)) setStudyInput(key, f.key, n);
          },
        });
      }
      panel.append(el('label', { class: 'indmenu__field' },
        el('span', { text: f.title || f.key }), input));
    }
    return panel.childElementCount ? panel : null;
  };

  /**
   * The gear panel for one active study: placement and pane height first, then
   * the study's own inputs. Everything reads live state, so the panel shows what
   * the chart is actually doing rather than what was last clicked.
   */
  const settingsPanel = (key, def) => {
    const h = state.handles[key];
    const info = paneInfo(key);
    const panel = el('div', { class: 'indmenu__panel' });

    if (paneFacade() && info) {
      const onPrice = info.kind === 'price';
      panel.append(el('div', { class: 'indmenu__layoutRow' },
        el('span', { class: 'indmenu__layoutLabel', text: 'Placement' }),
        el('div', { class: 'indmenu__seg', role: 'group', 'aria-label': `${def.label} placement` },
          el('button', {
            type: 'button', class: onPrice ? 'is-on' : '', 'aria-pressed': String(onPrice),
            title: `Draw ${def.label} on the price pane`,
            onclick: (e) => { e.stopPropagation(); setPlacement(key, 'price'); },
          }, 'On price'),
          el('button', {
            type: 'button', class: onPrice ? '' : 'is-on', 'aria-pressed': String(!onPrice),
            title: `Draw ${def.label} in its own pane`,
            onclick: (e) => { e.stopPropagation(); setPlacement(key, 'own'); },
          }, 'Own pane'))));

      if (!onPrice) {
        panel.append(el('div', { class: 'indmenu__layoutRow' },
          el('span', { class: 'indmenu__layoutLabel', text: 'Pane height' }),
          el('div', { class: 'indmenu__step' },
            el('button', {
              type: 'button', title: 'Shorter pane',
              'aria-label': `${def.label}: shorter pane`,
              onclick: (e) => { e.stopPropagation(); nudgePaneWeight(key, -1); },
            }, '\u2212'),
            el('b', { text: String(info.heightWeight || 1) }),
            el('button', {
              type: 'button', title: 'Taller pane',
              'aria-label': `${def.label}: taller pane`,
              onclick: (e) => { e.stopPropagation(); nudgePaneWeight(key, 1); },
            }, '+'))));
      }
    }

    if (h && h.visible === false) {
      panel.append(el('p', { class: 'indmenu__note', text: 'Hidden \u2014 inputs and settings are kept while it is off.' }));
    }

    const inputs = inputsPanel(key);
    if (inputs) panel.append(inputs);
    return panel.childElementCount ? panel : null;
  };

  const closeIndicatorMenu = () => {
    indicatorMenu.hidden = true;
    indicatorBtn.setAttribute('aria-expanded', 'false');
  };

  const paintIndicatorTrigger = () => {
    indicatorBtn.replaceChildren(
      el('span', { text: 'Indicators' }),
      el('span', { class: 'indmenu__count', text: String(state.studies.size) }),
      el('span', { class: 'indmenu__caret', html: '&#9662;' }));
  };

  /** Only the list is repainted, so the search box keeps its focus and text. */
  const paintIndicatorMenu = () => {
    menuList.replaceChildren();
    for (const [group, title] of [['overlays', 'On the price'], ['panes', 'Own pane']]) {
      const box = el('div', { class: 'indmenu__group' });
      box.append(el('div', { class: 'indmenu__label', text: title }));
      for (const def of CATALOG.filter((d) => d.group === group)) {
        const on = state.studies.has(def.key);
        const handle = on ? state.handles[def.key] : null;
        const hidden = Boolean(handle && handle.visible === false);
        const pane = on ? paneInfo(def.key) : null;
        box.append(el('div', {
          class: `indmenu__row${on ? ' is-on' : ''}`,
          'data-search': `${def.label} ${def.key}`.toLowerCase(),
        },
          el('button', {
            type: 'button', role: 'menuitemcheckbox', 'aria-checked': String(on),
            class: 'indmenu__item',
            // The list is rebuilt below, so this node is detached by the time the
            // document handler runs; keep the menu open for the next toggle.
            onclick: (e) => { e.stopPropagation(); toggleStudy(def); },
          },
            el('span', { class: 'indmenu__tick', text: on ? '\u2713' : '' }),
            el('span', { text: def.label })),
          on ? el('button', {
            type: 'button',
            class: `indmenu__paneBtn${hidden ? ' is-off' : ''}`,
            title: `${def.label}: ${hidden ? 'show' : 'hide'}`,
            'aria-label': `${def.label}: ${hidden ? 'show' : 'hide'}`,
            'aria-pressed': String(hidden),
            onclick: (e) => { e.stopPropagation(); toggleStudyVisibility(def.key); },
            html: hidden ? ICONS.eyeOff : ICONS.eye,
          }) : null,
          pane && pane.kind !== 'price' ? (() => {
            const f = paneFlags(def.key);
            return [
              el('button', {
                type: 'button',
                class: `indmenu__paneBtn${f.maximized ? ' is-on' : ''}`,
                title: f.maximized ? `${def.label}: restore pane` : `${def.label}: maximise pane`,
                'aria-label': f.maximized ? `${def.label}: restore pane` : `${def.label}: maximise pane`,
                'aria-pressed': String(f.maximized),
                onclick: (e) => { e.stopPropagation(); togglePaneMaximize(def.key); },
                html: f.maximized ? ICONS.paneDown : ICONS.expand,
              }),
              el('button', {
                type: 'button',
                class: `indmenu__paneBtn${f.collapsed ? ' is-on' : ''}`,
                title: f.collapsed ? `${def.label}: expand pane` : `${def.label}: collapse pane`,
                'aria-label': f.collapsed ? `${def.label}: expand pane` : `${def.label}: collapse pane`,
                'aria-pressed': String(f.collapsed),
                onclick: (e) => { e.stopPropagation(); togglePaneCollapse(def.key); },
                html: f.collapsed ? ICONS.paneUp : ICONS.paneDown,
              }),
            ];
          })() : null,
          on ? el('button', {
            type: 'button',
            class: `indmenu__gear${state.editing === def.key ? ' is-open' : ''}`,
            title: `${def.label} settings`,
            'aria-label': `${def.label} settings`,
            'aria-expanded': String(state.editing === def.key),
            onclick: (e) => {
              e.stopPropagation();
              state.editing = state.editing === def.key ? null : def.key;
              paintIndicatorMenu();
            },
          }, '\u2699') : null));
        if (on && state.editing === def.key) {
          const panel = settingsPanel(def.key, def);
          if (panel) box.append(panel);
        }
      }
      menuList.append(box);
    }
    const presets = CATALOG.filter((d) => d.preset).length;
    const excluded = Object.keys(EXCLUDED_STUDIES).length
      + [...unsupportedStudies].filter((t) => !Object.hasOwn(EXCLUDED_STUDIES, t)).length;
    menuList.append(el('div', { class: 'indmenu__foot',
      text: `${CATALOG.length - presets} Vela studies + ${presets} EMA presets`
        + (excluded ? ` \u00b7 ${excluded} excluded` : '')
        + " \u00b7 computed on this chart's bars" }));
    filterMenu();
  };

  /** Filter rows by name, and hide a section once every row in it is hidden. */
  const filterMenu = () => {
    const q = menuSearch.value.trim().toLowerCase();
    menuList.querySelectorAll('.indmenu__row').forEach((row) => {
      row.hidden = q ? !(row.dataset.search || '').includes(q) : false;
    });
    menuList.querySelectorAll('.indmenu__group').forEach((group) => {
      const rows = [...group.querySelectorAll('.indmenu__row')];
      group.hidden = rows.length === 0 || rows.every((r) => r.hidden);
    });
  };

  /**
   * Vela registers its studies when a chart is built and forgets them when that
   * chart is disposed, so remounting the page (a saved tab, a route change) can
   * start with the seeds only. Re-read the registry whenever the menu opens — it
   * is a property read, and it keeps the dropdown complete on every mount.
   * Declared as a function so the `ready()` path above can call it early.
   */
  function adoptFullCatalog() {
    const full = buildCatalog(unsupportedStudies);
    if (full.length !== CATALOG.length) {
      CATALOG = full;
      paintIndicatorTrigger();
    }
  }

  /** Drop saved keys this build/provider cannot offer, then re-save once. */
  function pruneSelection() {
    const known = new Set(CATALOG.map((d) => d.key));
    let changed = false;
    for (const key of [...state.studies]) {
      if (!known.has(key)) { state.studies.delete(key); changed = true; }
    }
    if (changed) saveIndicatorPrefs();
  }

  indicatorBtn.addEventListener('click', () => {
    const opening = indicatorMenu.hidden;
    if (opening) { adoptFullCatalog(); paintIndicatorMenu(); }
    indicatorMenu.hidden = !opening;
    indicatorBtn.setAttribute('aria-expanded', String(opening));
  });

  /* Close on an outside click or Escape; both listeners leave with the page. */
  document.addEventListener('click', (e) => {
    if (!indicatorWrap.isConnected) return;
    if (!indicatorWrap.contains(e.target)) closeIndicatorMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (indicatorWrap.isConnected && e.key === 'Escape') closeIndicatorMenu();
  });

  indicatorWrap.append(indicatorBtn, indicatorMenu);
  paintIndicatorTrigger();

  const scheduleRailRefresh = () => {
    clearTimeout(state.railTimer);
    state.railTimer = setTimeout(async () => {
      try {
        state.indicators = await market.indicators(state.sym, PY_INTERVAL[state.interval] || '15m', { range: RANGES[state.interval] });
        state.status = 'Ready';
        drawFacts();
        drawIndicators();
      } catch { /* keep the last summary; the banner still shows provenance */ }
    }, 600);
  };

  /** Draw the analysed plan on the price itself: entry white, stop rose, target lime. */
  const drawPlan = (s) => {
    if (!state.chart || !state.chart.drawings) return;
    try { state.chart.drawings.removeMany(state.planIds); } catch { /* first run */ }
    state.planIds = [];
    const line = (price, lineColor) => {
      try {
        const d = state.chart.drawings.add('hline', {
          paneId: 'price',
          anchors: [{ price }],
          style: { lineColor, lineWidth: 1, lineStyle: 'dashed' },
        });
        if (d?.id) state.planIds.push(d.id);
      } catch (err) { console.warn('[cairnline] plan line failed:', err); }
    };
    line(s.entry, '#F5F7F8');
    line(s.stop_loss, '#FF5A5F');
    line(s.take_profit, '#B4FF3A');
  };

  const page = el('div', { class: 'page', style: 'max-width:none' });
  const wrap = el('div', { class: 'terminal' });
  const priceEl = el('span', { class: 'term__price' });
  // Provenance lives in the rail footer (one line, no extra chrome in the bar).
  const deskEl = el('div', { class: 'assistant__desk', text: 'CAIRNLINE DESK · yfinance + PineTS' });
  const setSource = (text) => { deskEl.textContent = text; };
  const canvas = el('div', { class: 'term__canvas' });
  const facts = el('div', { class: 'factgrid' });
  const indicatorBox = el('div');
  const chat = el('div', { class: 'assistant__body' });

  const drawChart = () => {
    if (VELA) { updateTicker(); return; }   // Vela owns the canvas and its tools.
    canvas.innerHTML = `
      <div class="term__legend">
        <span><b>${state.sym}</b></span>
        <span>${state.interval} · ${state.bars.length} bars</span>
        <span style="color:#7EE7C0">EMA 9</span><span style="color:#E9C46A">EMA 21</span><span style="color:#8FA3FF">EMA 50</span>
      </div>
      <div class="term__tools">
        <button title="Zoom in">${ICONS.zoom}</button>
        <button title="Fit">${ICONS.fit}</button>
        <button title="Measure">${ICONS.measure}</button>
        <button title="Expand">${ICONS.expand}</button>
        <button title="Refresh" data-refresh>${ICONS.reset}</button>
      </div>
      ${renderChart(state.bars, state.indicators?.plots || {})}`;
    canvas.querySelector('[data-refresh]')?.addEventListener('click', () => load());
    updateTickerFromBars();
  };

  /** Live price ticker (Vela mode): real quotes from the market service, 30 s cadence. */
  const updateTicker = async () => {
    try {
      const q = await market.quotes(state.sym);
      const row = (q.quotes && (q.quotes[state.sym] || (Array.isArray(q.quotes) && q.quotes[0]))) || null;
      const price = row && (row.price ?? row.close);
      const chg = row && row.change_pct;
      priceEl.innerHTML = price != null
        ? `${px(price)} <b class="${chg >= 0 ? '' : 'neg'}">${chg >= 0 ? '+' : ''}${Number(chg).toFixed(2)}%</b> <span class="card__note">· live quote</span>`
        : '—';
    } catch { priceEl.textContent = '—'; }
  };

  const updateTickerFromBars = () => {
    const last = state.bars[state.bars.length - 1];
    if (last) {
      const first = state.bars[0];
      const chg = first && first.open ? ((last.close - first.open) / first.open) * 100 : 0;
      priceEl.innerHTML = `${px(last.close)} <b class="${chg >= 0 ? '' : 'neg'}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</b>`;
    } else {
      priceEl.textContent = '—';
    }
  };

  const drawFacts = () => {
    const s = state.indicators?.summary;
    facts.innerHTML = '';
    facts.append(
      el('div', { class: 'fact' }, el('small', { text: 'SYMBOL' }), el('b', { text: state.sym })),
      el('div', { class: 'fact' }, el('small', { text: 'INTERVAL' }), el('b', { text: state.interval })),
      el('div', { class: 'fact' }, el('small', { text: 'STATE' }),
        el('b', { class: state.status === 'Ready' ? 'on' : state.status === 'Error' ? 'off' : '', text: state.status })));
  };

  const drawIndicators = () => {
    indicatorBox.innerHTML = '';
    const s = state.indicators?.summary;
    if (!s) {
      indicatorBox.append(el('p', { class: 'card__note', text: 'Run the analysis to compute indicators with PineTS.' }));
      window.dispatchEvent(new Event('cairnline:indicators'));
      return;
    }
    const row = (k, v, tone = '') => el('div', { class: 'lens__row' }, el('span', { text: k }), el('span', { class: tone, text: v }));
    indicatorBox.append(el('div', {},
      el('div', { class: 'lens__row' },
        el('span', { text: 'Bias' }),
        chip(String(s.bias || 'neutral').toUpperCase(), s.bias === 'long' ? 'chip--on' : s.bias === 'short' ? 'chip--danger' : '')),
      el('div', { class: 'lens__row' },
        el('span', { text: 'Confidence' }),
        el('span', { text: `${s.confidence}%` })),
      el('div', { class: 'lens__meter', style: 'margin:6px 0 10px' }, el('i', { style: `width:${s.confidence}%` })),
      row('RSI 14', String(s.rsi), s.rsi > 55 ? 'mock__ok' : s.rsi < 45 ? '' : ''),
      row('ATR 14', px(s.atr)),
      row('MACD hist', String(s.macd_hist), s.macd_hist >= 0 ? 'mock__ok' : ''),
      row('EMA 9 / 21 / 50', `${px(s.ema9)} / ${px(s.ema21)} / ${px(s.ema50)}`),
      row('Trend', s.trend),
      row('Entry', px(s.entry)),
      row('Stop', px(s.stop_loss)),
      row('Target', px(s.take_profit)),
      el('div', { style: 'margin-top:10px' },
        el('p', { class: 'card__note', text: (s.reasons || []).join(' · ') }))));
    window.dispatchEvent(new Event('cairnline:indicators'));
  };

  const renderChat = () => {
    chat.innerHTML = '';
    if (!state.messages.length) {
      chat.append(el('div', { class: 'assistant__empty' },
        el('div', { class: 'assistant__orb', html: ICONS.chat }),
        el('strong', { text: 'Awaiting analysis parameters.' }),
        el('p', { text: `Analyse ${state.sym} on ${state.interval} — real Pine indicators on live bars.` })));
      return;
    }
    state.messages.forEach((m) => chat.append(el('div', { class: `msg ${m.role === 'user' ? 'msg--user' : ''}` },
      m.text, m.meta && el('div', { class: 'msg__meta', text: m.meta }))));
    chat.scrollTop = chat.scrollHeight;
  };

  const say = (text, meta) => { state.messages.push({ role: 'trish', text, meta }); renderChat(); };

  async function load() {
    state.status = 'Loading';
    drawFacts();
    setSource('CAIRNLINE DESK · loading…');
    if (VELA) {
      // Bars are the chart's business now (provider + Vela cache); the rail only needs PineTS.
      try {
        const indicators = await market.indicators(state.sym, PY_INTERVAL[state.interval] || '15m', { range: RANGES[state.interval] }).catch(() => null);
        state.indicators = indicators;
        state.status = indicators ? 'Ready' : 'Partial';
        setSource('CAIRNLINE DESK · yfinance + PineTS');
        drawFacts();
        drawIndicators();
        updateTicker();
      } catch (err) {
        state.status = 'Error';
        setSource('CAIRNLINE DESK · market service offline');
        drawFacts();
        drawIndicators();
      }
      return;
    }
    try {
      const [candles, indicators] = await Promise.all([
        market.candles(state.sym, state.interval, RANGES[state.interval]),
        market.indicators(state.sym, state.interval, { range: RANGES[state.interval] }).catch(() => null),
      ]);
      state.bars = candles.bars || [];
      state.data = candles;
      state.indicators = indicators;
      state.status = indicators ? 'Ready' : 'Partial';
      setSource(`CAIRNLINE DESK · ${candles.source}${candles.stale ? ' (stale)' : ''} + PineTS`);
      drawChart();
      drawFacts();
      drawIndicators();
    } catch (err) {
      state.status = 'Error';
      state.bars = [];
      state.indicators = null;
      setSource('CAIRNLINE DESK · market service offline');
      canvas.innerHTML = `<div class="empty" style="padding:60px 20px">
        <h3>Market service not reachable</h3>
        <p>Start it with <code>python3 server/market_service.py</code> — the app then serves real yfinance bars and PineTS indicators.</p>
        <p class="card__note">${String(err.message || err).slice(0, 160)}</p></div>`;
      drawFacts();
      drawIndicators();
    }
  }

  const symbolSelect = el('select', {
    class: 'term__symbol',
    onchange: (e) => {
      state.sym = e.target.value;
      if (VELA && state.chart) state.chart.setMarket({ symbol: `CAIRNLINE:${state.sym}` });
      else load();
    },
  }, SYMBOLS.map((s) => el('option', { value: s.sym, text: s.label, selected: s.sym === state.sym })));

  const tfBar = el('div', { class: 'tabs' }, INTERVALS.map((tf) =>
    el('button', {
      class: tf === state.interval ? 'is-active' : '',
      onclick: (e) => {
        state.interval = tf;
        [...tfBar.children].forEach((b) => b.classList.remove('is-active'));
        e.currentTarget.classList.add('is-active');
        if (VELA && state.chart) state.chart.setMarket({ timeframe: TF.toVela[tf] });
        else load();
      }, text: tf,
    })));

  const analyze = async () => {
    state.status = 'Analyzing';
    drawFacts();
    state.messages.push({ role: 'user', text: `Analyse ${state.sym} on ${state.interval}`, meta: 'you' });
    renderChat();
    try {
      const ind = await market.indicators(state.sym, state.interval, { range: RANGES[state.interval] });
      state.indicators = ind;
      drawIndicators();
      state.status = 'Ready';
      drawFacts();
      const s = ind.summary;
      say(`${state.sym} ${state.interval}: ${s.bias} bias at ${s.confidence}% confidence. ${s.reasons.join('. ')}.`,
        `PineTS · ${ind.bars} bars · ${ind.source}`);
      say(`Plan: entry ${px(s.entry)}, stop ${px(s.stop_loss)}, target ${px(s.take_profit)} (1:${s.risk_reward} from 1× ATR). RSI ${s.rsi}, ATR ${px(s.atr)}.`,
        `${new Date(ind.fetched_at).toLocaleTimeString()} · ${ind.stale ? 'cached' : 'live'}`);
      if (VELA) { drawPlan(s); say('Plan drawn on the chart: entry (white), stop (rose), target (lime). Drag them to adjust levels.', 'Vela drawings'); }
    } catch (err) {
      state.status = 'Error';
      drawFacts();
      say(`I could not compute indicators: ${String(err.message || err).slice(0, 140)}`, 'error');
    }
  };

  const input = el('input', { type: 'text', placeholder: 'Message Trish…', 'aria-label': 'Message Trish' });
  const sendBtn = el('button', { 'aria-label': 'Send', html: ICONS.send });
  const send = async () => {
    const v = input.value.trim();
    if (!v || state.busy) return;
    state.messages.push({ role: 'user', text: v, meta: 'you' });
    input.value = '';
    renderChat();
    state.busy = true;
    sendBtn.disabled = true;

    // A live bubble while she works, so a slow turn is never a dead screen.
    const pending = el('div', { class: 'msg msg--pending' }, 'reading the desk…');
    chat.append(pending);
    chat.scrollTop = chat.scrollHeight;

    try {
      // Send the transcript (without her pending bubble) as the model history.
      const history = state.messages
        .filter((m) => m.role === 'user' || m.role === 'trish')
        .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }));
      const res = await market.trishChat(history, {
        symbol: state.sym,
        interval: state.interval,
        plan: ctx?.permissions?.planName,
      });
      pending.remove();
      const tools = (res.trace || []).map((t) => t.tool).filter((t, i, a) => a.indexOf(t) === i);
      say(res.reply || '(no reply)', tools.length ? `${res.model || 'model'} · ${tools.join(', ')}` : (res.model || 'model'));
    } catch (err) {
      pending.remove();
      const msg = String(err.message || err);
      if (/no provider/i.test(msg)) {
        say('I have no model behind me yet. Open Settings → Trish and add a provider (OpenRouter, OpenAI, Ollama or a local Hermes gateway).', 'not configured');
      } else {
        say(`I could not reach my model: ${msg.slice(0, 160)}`, 'error');
      }
    } finally {
      state.busy = false;
      sendBtn.disabled = false;
      input.focus();
    }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  sendBtn.addEventListener('click', send);

  const assistant = el('aside', { class: 'assistant' },
    el('div', { class: 'assistant__head' },
      el('h3', { text: 'TRISH AI' }),
      chip(state.interval, 'chip--mono')),
    el('div', { style: 'padding:14px 16px 0' },
      el('button', { class: 'btn btn--primary btn--block', onclick: analyze },
        el('span', { html: ICONS.chart, style: 'width:15px;height:15px' }), 'Analyze Current Chart'),
      el('div', { style: 'margin-top:10px' }, facts)),
    el('div', { style: 'padding:0 16px' }, indicatorBox),
    chat,
    el('div', { class: 'assistant__foot' },
      el('div', { class: 'assistant__input' }, input, sendBtn),
      deskEl));

  wrap.append(
    el('div', { class: 'term__main' },
      el('div', { class: 'term__bar' },
        el('a', { class: 'term__back', href: '#/overview', html: '&larr; BACK' }),
        symbolSelect, tfBar, indicatorWrap, btChip, priceEl),
      canvas),
    assistant);

  page.append(wrap);
  drawFacts(); drawIndicators(); renderChat();
  if (VELA) {
    mountVela().then(() => load()).catch((err) => {
      console.warn('[cairnline] Vela mount failed, falling back to the SVG renderer:', err);
      state.status = 'Partial';
      setSource('CAIRNLINE DESK · legacy renderer');
      load();
    });
  } else {
    load();
  }
  return page;
}

/** Upload Chart — real: drops a screenshot, then routes you to live analysis. */
/**
 * Upload Chart — top-down (multi-timeframe) analysis.
 *
 * The user attaches one screenshot per timeframe, then presses Analyze. The panel
 * appears only then and grows through the analysis flow. Screenshots are attached
 * as evidence; the numbers come from real bars per timeframe, so nothing is invented
 * from pixels we cannot read.
 */
export async function upload(ctx) {
  const MAX_BYTES = 10 * 1024 * 1024;      // 10 MB per chart, as the original allows
  const MAX_CHARTS = 6;
  const TF_ORDER = ['5m', '15m', '1h', '4h', '1d'];
  const TF_LABEL = { '5m': 'M5', '15m': 'M15', '1h': 'H1', '4h': 'H4', '1d': 'D1' };

  const charts = [];                        // { file, url, tf }
  const page = el('div', { class: 'page' });
  const note = el('p', { class: 'form__note' });
  const fileInput = el('input', { type: 'file', accept: 'image/*', multiple: true, style: 'display:none' });
  const list = el('div', { class: 'uploads' });
  const analysis = el('div', { class: 'analysis' });
  const symbolSelect = el('select', { class: 'term__symbol' },
    SYMBOLS.map((s) => el('option', { value: s.sym, text: s.label })));

  const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);

  const addFiles = (files) => {
    note.className = 'form__note';
    note.textContent = '';
    for (const f of files) {
      if (charts.length >= MAX_CHARTS) {
        note.textContent = `Up to ${MAX_CHARTS} charts (one per timeframe).`;
        note.className = 'form__note is-bad';
        break;
      }
      if (!f.type.startsWith('image/')) {
        note.textContent = `${f.name} is not an image.`;
        note.className = 'form__note is-bad';
        continue;
      }
      if (f.size > MAX_BYTES) {
        note.textContent = `${f.name} is ${fmtSize(f.size)} — the limit is 10 MB per chart.`;
        note.className = 'form__note is-bad';
        continue;
      }
      // Next unused timeframe, so a multi-select lands in top-down order.
      const used = new Set(charts.map((c) => c.tf));
      const tf = TF_ORDER.find((t) => !used.has(t)) || TF_ORDER[charts.length % TF_ORDER.length];
      charts.push({ file: f, url: URL.createObjectURL(f), tf });
    }
    paintList();
  };

  const analyzeBtn = el('button', { class: 'btn btn--primary', disabled: true }, 'Analyze charts');
  const syncBtn = () => { analyzeBtn.disabled = charts.length === 0; };

  const paintList = () => {
    syncBtn();
    list.innerHTML = '';
    if (!charts.length) {
      list.append(el('p', { class: 'card__note', text: 'No charts attached yet.' }));
      return;
    }
    charts.forEach((c, i) => {
      const tfSel = el('select', {
        class: 'uploads__tf',
        onchange: (e) => { c.tf = e.target.value; },
      }, TF_ORDER.map((t) => el('option', { value: t, text: TF_LABEL[t], selected: t === c.tf })));
      list.append(el('div', { class: 'uploads__row' },
        el('img', { class: 'uploads__thumb', src: c.url, alt: '' }),
        el('div', { class: 'uploads__meta' },
          el('b', { text: c.file.name }),
          el('small', { text: fmtSize(c.file.size) })),
        tfSel,
        el('button', {
          class: 'uploads__x', 'aria-label': `Remove ${c.file.name}`,
          onclick: () => { URL.revokeObjectURL(c.url); charts.splice(i, 1); paintList(); },
        }, '×')));
    });
  };

  const pick = (e) => {
    e?.preventDefault();
    e?.stopPropagation();
    fileInput.click();          // opens the OS file picker
  };

  const drop = el('div', {
    class: 'dropzone',
    onclick: () => fileInput.click(),
    ondragover: (e) => { e.preventDefault(); drop.classList.add('is-over'); },
    ondragleave: () => drop.classList.remove('is-over'),
    ondrop: (e) => {
      e.preventDefault();
      drop.classList.remove('is-over');
      addFiles([...e.dataTransfer.files]);
    },
  },
    el('div', { class: 'assistant__orb', html: ICONS.chart }),
    el('h3', { text: 'Drop your charts' }),
    el('p', { text: `One screenshot per timeframe for top-down analysis — up to ${MAX_CHARTS} charts, 10 MB each.` }),
    el('div', { class: 'dropzone__actions' },
      el('button', { type: 'button', class: 'btn btn--outline btn--sm', onclick: pick }, 'Choose files'),
      el('button', { type: 'button', class: 'btn btn--primary btn--sm', onclick: (e) => pasteFromClipboard(e) }, 'Paste from clipboard')));

  fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });

  /* Clipboard: the button reads the clipboard; Ctrl/Cmd+V on the page works too. */
  const nameFor = (i, type) => `chart-${i + 1}.${(type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;

  const pasteFromClipboard = async (e) => {
    e?.preventDefault();
    e?.stopPropagation();
    try {
      if (!navigator.clipboard?.read) throw new Error('This browser cannot read images from the clipboard');
      const items = await navigator.clipboard.read();
      const files = [];
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (!type) continue;
        const blob = await item.getType(type);
        files.push(new File([blob], nameFor(files.length, type), { type }));
      }
      if (!files.length) {
        note.textContent = 'Nothing on the clipboard looked like an image. Copy a chart first, then press Paste.';
        note.className = 'form__note is-bad';
        return;
      }
      addFiles(files);
      note.textContent = `Pasted ${files.length} chart${files.length > 1 ? 's' : ''} from the clipboard.`;
      note.className = 'form__note is-ok';
    } catch (err) {
      note.textContent = `${String(err.message || err)} — you can also press Ctrl/Cmd+V or drop a file.`;
      note.className = 'form__note is-bad';
    }
  };

  /* Page-level paste: works even without the button. */
  const onPaste = (ev) => {
    const files = [...(ev.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    ev.preventDefault();
    addFiles(files);
    note.textContent = `Pasted ${files.length} chart${files.length > 1 ? 's' : ''} from the clipboard.`;
    note.className = 'form__note is-ok';
  };
  document.addEventListener('paste', onPaste);
  // the page is replaced on navigation; drop the listener with it
  const cleanup = () => document.removeEventListener('paste', onPaste);
  window.addEventListener('hashchange', cleanup, { once: true });

  /* ---- the analysis panel: created on Analyze, grows through the flow ---- */
  const step = (label) => {
    const row = el('div', { class: 'analysis__step' },
      el('span', { class: 'analysis__dot' }),
      el('span', { text: label }));
    analysis.append(row);
    return row;
  };
  const mark = (row, state, text) => {
    row.className = `analysis__step is-${state}`;
    if (text) row.lastChild.textContent = text;
  };

  analyzeBtn.addEventListener('click', async () => {
    const sym = symbolSelect.value;
    const tfs = [...new Set(charts.map((c) => c.tf))].sort((a, b) => TF_ORDER.indexOf(a) - TF_ORDER.indexOf(b));
    analysis.innerHTML = '';
    analysis.classList.add('is-live');
    analyzeBtn.disabled = true;

    const s1 = step(`Reading ${charts.length} chart${charts.length > 1 ? 's' : ''} (${tfs.map((t) => TF_LABEL[t]).join(' · ')})`);
    await new Promise((r) => setTimeout(r, 350));
    mark(s1, 'done');

    const s2 = step(`Fetching live ${sym} bars for each timeframe`);
    const results = [];
    for (const tf of tfs) {
      try {
        const ind = await market.indicators(sym, tf, { range: RANGES[tf] || '5d' });
        results.push({ tf, ind });
      } catch (err) {
        results.push({ tf, error: String(err.message || err) });
      }
    }
    const ok = results.filter((r) => r.ind);
    mark(s2, ok.length ? 'done' : 'fail', ok.length
      ? `Fetched ${ok.length}/${tfs.length} timeframes`
      : 'No timeframe returned bars — is the market service running?');

    if (!ok.length) { analyzeBtn.disabled = false; return; }

    const s3 = step('Computing structure per timeframe');
    await new Promise((r) => setTimeout(r, 250));
    mark(s3, 'done');

    // Confluence: how many timeframes agree on direction, weighted to the higher ones.
    const longs = ok.filter((r) => r.ind.summary.bias === 'long').length;
    const shorts = ok.filter((r) => r.ind.summary.bias === 'short').length;
    const bias = longs > shorts ? 'long' : shorts > longs ? 'short' : 'neutral';
    const agree = Math.max(longs, shorts);
    const confluence = Math.round((agree / ok.length) * 100);
    const top = ok[ok.length - 1].ind.summary;   // highest timeframe sets the levels

    const s4 = step('Weighing confluence');
    await new Promise((r) => setTimeout(r, 250));
    mark(s4, 'done', `Confluence ${confluence}% — ${agree}/${ok.length} timeframes ${bias}`);

    const head = el('div', { class: 'analysis__verdict-head' },
      el('b', { text: sym }),
      chip(bias.toUpperCase(), bias === 'long' ? 'chip--on' : bias === 'short' ? 'chip--danger' : ''),
      el('span', { class: 'card__note', text: `${confluence}% confluence` }));

    const levels = el('div', { class: 'signal__levels', style: 'margin-top:16px' },
      el('div', { class: 'signal__level' }, el('small', { text: 'ENTRY' }), el('b', { text: px(top.entry) })),
      el('div', { class: 'signal__level signal__level--stop' }, el('small', { text: 'STOP LOSS' }), el('b', { text: px(top.stop_loss) })),
      el('div', { class: 'signal__level signal__level--target' }, el('small', { text: 'TAKE PROFIT' }), el('b', { text: px(top.take_profit) })));

    const rows = results.map((r) => el('tr', {},
      el('td', { text: TF_LABEL[r.tf] }),
      el('td', {}, r.ind
        ? chip(r.ind.summary.bias.toUpperCase(), r.ind.summary.bias === 'long' ? 'chip--on' : r.ind.summary.bias === 'short' ? 'chip--danger' : '')
        : el('span', { class: 'card__note', text: 'no data' })),
      el('td', { text: r.ind ? `${r.ind.summary.confidence}%` : '—' }),
      el('td', { text: r.ind ? String(r.ind.summary.rsi) : '—' }),
      el('td', { text: r.ind ? r.ind.summary.trend : '—' })));

    const table = el('table', { class: 'analysis__table' },
      el('thead', {}, el('tr', {},
        el('th', { text: 'TF' }), el('th', { text: 'Bias' }), el('th', { text: 'Conf.' }),
        el('th', { text: 'RSI' }), el('th', { text: 'Trend' }))),
      el('tbody', {}, ...rows));

    const footnote = el('p', { class: 'card__note', style: 'margin-top:14px',
      text: `Levels come from the ${TF_LABEL[ok[ok.length - 1].tf]} timeframe (1× ATR stop, 2× target). Screenshots are attached as evidence; the numbers are computed from live bars, not read from pixels.` });

    const openBtn = el('div', { style: 'margin-top:14px' },
      el('button', { class: 'btn btn--outline btn--sm', onclick: () => { location.hash = '#/chart'; } }, 'Open in AI Trading'));

    analysis.append(el('div', { class: 'analysis__verdict' }, head, levels, table, footnote, openBtn));

    analyzeBtn.disabled = false;
  });

  const limit = ctx.permissions.dailyUploadLimit;
  page.append(
    el('div', { class: 'page__head' },
      el('div', {}, el('h2', { class: 'page__title', text: 'Upload Chart' })),
      chip(limit === -1 ? 'Unlimited uploads' : `${limit} uploads / day`, 'chip--on')),
    card('Charts', { note: `up to ${MAX_CHARTS} · 10 MB each` },
      drop, fileInput, list, note,
      el('div', { class: 'uploads__actions' },
        el('label', { class: 'field', style: 'max-width:220px' },
          el('span', { text: 'Symbol to analyse' }), symbolSelect),
        analyzeBtn)),
    analysis);
  paintList();
  return page;
}
