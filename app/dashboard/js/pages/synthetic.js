/**
 * Synthetic Indices — production /synthetic-chart.
 *
 * The real product opens a chart on Deriv-style synthetic indices (volatility,
 * step and range-break series) for practice. There is no broker feed behind this
 * rebuild, so the series are generated from the instrument's own seed and the
 * page says so on its face: simulated series, illustrative specs, real arithmetic
 * in the position-size panel. Nothing here pretends to be a market quote.
 */
import { el, card, chip, table, toast } from '../ui.js';
import { fmt } from '../data.js';

/* ------------------------------------------------------------ instruments */

/** Illustrative contract specs. `tick` drives both the walk and the maths. */
const INDICES = [
  { id: 'v10', name: 'Volatility 10', symbol: 'V10', base: 6400.5, vol: 10, tick: 0.001, minLot: 0.5, spread: 0.9, seed: 1011, rangeDay: '9–14%' },
  { id: 'v25', name: 'Volatility 25', symbol: 'V25', base: 2150.8, vol: 25, tick: 0.01, minLot: 0.5, spread: 1.4, seed: 2025, rangeDay: '22–31%' },
  { id: 'v50', name: 'Volatility 50', symbol: 'V50', base: 240.15, vol: 50, tick: 0.01, minLot: 0.5, spread: 2.1, seed: 3050, rangeDay: '45–58%' },
  { id: 'v75', name: 'Volatility 75', symbol: 'V75', base: 98420.0, vol: 75, tick: 0.01, minLot: 0.001, spread: 3.2, seed: 4075, rangeDay: '68–84%' },
  { id: 'v100', name: 'Volatility 100', symbol: 'V100', base: 1820.4, vol: 100, tick: 0.01, minLot: 0.001, spread: 4.6, seed: 5100, rangeDay: '92–118%' },
  { id: 'step', name: 'Step Index', symbol: 'STEP', base: 9142.6, vol: 30, tick: 0.1, minLot: 0.5, spread: 1.1, seed: 6030, rangeDay: 'n/a · fixed steps' },
  { id: 'range', name: 'Range Break 100', symbol: 'RANGE', base: 1205.3, vol: 40, tick: 0.01, minLot: 0.5, spread: 1.8, seed: 7040, rangeDay: '38–52%' },
];

const TIMEFRAMES = ['M1', 'M5', 'M15', 'H1', 'H4'];

/* --------------------------------------------------------------- drawing */

/** Mulberry32 — deterministic per instrument, so a reload shows the same walk. */
function rnd(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A walk sized by the instrument's annualised volatility and timeframe. */
function series(index, tf, count = 96) {
  const r = rnd(index.seed + tf.length * 7);
  const stepScale = { M1: 0.35, M5: 0.7, M15: 1, H1: 1.8, H4: 3.1 }[tf] || 1;
  const unit = (index.base * (index.vol / 100) * 0.0009) * stepScale;
  const out = [];
  let p = index.base;
  for (let i = 0; i < count; i += 1) {
    const drift = (r() - 0.5) * 2 * unit + Math.sin(i / 11) * unit * 0.55;
    const o = p;
    const c = o + drift;
    out.push({ o, c, h: Math.max(o, c) + r() * unit * 0.8, l: Math.min(o, c) - r() * unit * 0.8 });
    p = c;
  }
  return out;
}

function chartSvg(index, tf, width = 720, height = 396) {
  const bars = series(index, tf);
  const axis = width < 560 ? 96 : 64; // right gutter for the price scale
  const foot = 20;      // bottom gutter for time labels
  const plotW = Math.max(120, width - axis);
  const plotH = height - foot;
  const highs = bars.map((b) => b.h);
  const lows = bars.map((b) => b.l);
  let top = Math.max(...highs);
  let bottom = Math.min(...lows);
  const pad = (top - bottom) * 0.1 || 1;
  top += pad;
  bottom -= pad;
  const inset = 10;     // keeps the top price label inside the viewBox
  const y = (v) => inset + ((top - v) / (top - bottom)) * (plotH - inset);
  const step = plotW / bars.length;
  const digits = index.base >= 1000 ? 1 : 2;
  // The chart is drawn in viewBox units and scaled to fit, so a narrow column
  // needs larger units for the labels to stay legible.
  const fs = width < 560 ? 19 : 10;

  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const yy = Math.max(inset, (inset + (plotH - inset) * f)).toFixed(1);
    const val = (top - (top - bottom) * f).toFixed(digits);
    return `<line x1="0" y1="${yy}" x2="${plotW}" y2="${yy}" stroke="#26272A" stroke-width="1" stroke-dasharray="${f === 1 ? '0' : '2 5'}"/>`
      + `<text x="${plotW + 10}" y="${Number(yy) + fs * 0.35}" fill="#8A9499" font-size="${fs}" font-family="JetBrains Mono, ui-monospace, monospace">${val}</text>`;
  }).join('');

  const bodies = bars.map((b, i) => {
    const x = i * step + step / 2;
    const y1 = Math.min(y(b.o), y(b.c));
    const h = Math.max(1.2, Math.abs(y(b.o) - y(b.c)));
    const up = b.c >= b.o;
    return `<line x1="${x.toFixed(1)}" y1="${y(b.h).toFixed(1)}" x2="${x.toFixed(1)}" y2="${y(b.l).toFixed(1)}" stroke="#26272A"/>`
      + `<rect x="${(x - Math.max(1.4, step * 0.28)).toFixed(1)}" y="${y1.toFixed(1)}" width="${Math.max(2.8, step * 0.56).toFixed(1)}" height="${h.toFixed(1)}" fill="${up ? '#B4FF3A' : '#FF5A5F'}" opacity="${up ? 0.85 : 0.7}"/>`;
  }).join('');

  // Time axis: the walk is one bar per timeframe step, ending now.
  const minutes = { M1: 1, M5: 5, M15: 15, H1: 60, H4: 240 }[tf] || 15;
  const end = Date.now();
  const clock = (i) => {
    const d = new Date(end - (bars.length - 1 - i) * minutes * 60000);
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  };
  const timeTicks = width < 560 ? [0, 1] : [0, 0.25, 0.5, 0.75, 1];
  const timeFs = width < 560 ? fs * 0.8 : fs;
  const timeAxis = timeTicks.map((f) => {
    const i = Math.round(f * (bars.length - 1));
    const x = (i * step + step / 2).toFixed(1);
    const anchor = f === 0 ? 'start' : f === 1 ? 'end' : 'middle';
    return `<text x="${x}" y="${plotH + timeFs * 1.5}" fill="#8A9499" font-size="${timeFs}" text-anchor="${anchor}" font-family="JetBrains Mono, ui-monospace, monospace">${clock(i)}</text>`;
  }).join('');

  const last = bars[bars.length - 1].c;
  const lastY = y(last);

  return `<svg viewBox="0 0 ${width} ${height}" role="img" style="display:block;width:100%;max-width:100%;height:auto" `
    + `aria-label="${index.name} ${tf} simulated candlestick chart, last ${last.toFixed(digits)}">`
    + grid + bodies + timeAxis
    + `<line x1="0" y1="${lastY.toFixed(1)}" x2="${plotW}" y2="${lastY.toFixed(1)}" stroke="#B4FF3A" stroke-width="1" opacity="0.45"/>`
    + `<rect x="${plotW + 2}" y="${(lastY - fs * 0.8).toFixed(1)}" width="${(axis - 4).toFixed(0)}" height="${(fs * 1.6).toFixed(0)}" rx="3" fill="#B4FF3A"/>`
    + `<text x="${plotW + 7}" y="${(lastY + fs * 0.36).toFixed(1)}" fill="#050505" font-size="${fs}" font-weight="700" font-family="JetBrains Mono, ui-monospace, monospace">${last.toFixed(digits)}</text>`
    + '</svg>';
}

/* ----------------------------------------------------------------- page */

export async function syntheticChart(ctx) {
  const state = { index: INDICES[0], tf: 'M15' };

  const chartHost = el('div', { style: 'margin-top:14px' });
  const stats = el('div', { class: 'metrics', style: 'margin-top:16px' });
  const specBody = el('dl', { class: 'kv' });
  const caption = el('p', { class: 'card__note', style: 'margin-top:10px' });

  const draw = () => {
    const { index, tf } = state;
    const bars = series(index, tf);
    const last = bars[bars.length - 1].c;
    const open = bars[0].o;
    const digits = index.base >= 1000 ? 1 : 2;
    const change = ((last - open) / open) * 100;
    const hi = Math.max(...bars.map((b) => b.h));
    const lo = Math.min(...bars.map((b) => b.l));

    chartHost.innerHTML = chartSvg(index, tf, Math.max(320, Math.round(chartHost.clientWidth || 720)));

    stats.innerHTML = '';
    [
      ['Last', last.toFixed(digits), true],
      ['Change', `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`, change >= 0],
      ['Period high', hi.toFixed(digits), false],
      ['Period low', lo.toFixed(digits), false],
    ].forEach(([k, v, accent]) => {
      stats.append(el('div', { class: 'metric' },
        el('div', { class: 'metric__k', text: k }),
        el('div', {
          class: 'metric__v metric__v--sm',
          style: accent ? 'color:var(--lime)' : '',
          text: v,
        })));
    });

    specBody.innerHTML = '';
    [
      ['Instrument', `${index.name} (${index.symbol})`],
      ['Annualised volatility', `${index.vol}%`],
      ['Tick size', String(index.tick)],
      ['Typical spread', `${index.spread} pts`],
      ['Min lot', String(index.minLot)],
      ['Daily range', index.rangeDay],
      ['Session', '24/7, no market close'],
      ['Tradeable here', 'No — simulation only'],
    ].forEach(([k, v]) => specBody.append(el('dt', { text: k }), el('dd', { text: v })));

    caption.textContent = `Simulated ${tf} series, ${bars.length} bars, seed ${index.seed} — generated in the page, not a broker feed. Reloading shows the same walk.`;
    sizing.update();
  };

  const indexTabs = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Synthetic index', style: 'flex-wrap:wrap;max-width:100%' },
    INDICES.map((i) => el('button', {
      class: i.id === state.index.id ? 'is-active' : '',
      role: 'tab',
      'aria-selected': String(i.id === state.index.id),
      onclick: (e) => {
        state.index = i;
        [...e.currentTarget.parentNode.children].forEach((b) => {
          b.classList.remove('is-active');
          b.setAttribute('aria-selected', 'false');
        });
        e.currentTarget.classList.add('is-active');
        e.currentTarget.setAttribute('aria-selected', 'true');
        draw();
      },
    }, i.symbol)));

  const tfTabs = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Timeframe', style: 'flex-wrap:wrap;max-width:100%' },
    TIMEFRAMES.map((t) => el('button', {
      class: t === state.tf ? 'is-active' : '',
      role: 'tab',
      'aria-selected': String(t === state.tf),
      onclick: (e) => {
        state.tf = t;
        [...e.currentTarget.parentNode.children].forEach((b) => {
          b.classList.remove('is-active');
          b.setAttribute('aria-selected', 'false');
        });
        e.currentTarget.classList.add('is-active');
        e.currentTarget.setAttribute('aria-selected', 'true');
        draw();
      },
    }, t)));

  /* ---- practice position size: real arithmetic over the spec above ---- */

  const sizing = {
    update() {
      const account = Number(accountInput.value) || 0;
      const riskPct = Number(riskInput.value) || 0;
      const stopPts = Number(stopInput.value) || 0;
      const riskAmount = account * (riskPct / 100);
      const { index } = state;
      const perLot = stopPts * index.tick;
      const lots = perLot > 0 ? riskAmount / perLot : 0;
      const rounded = lots >= 1 ? lots.toFixed(2) : lots.toFixed(3);
      const belowMin = lots > 0 && lots < index.minLot;
      out.textContent = perLot > 0
        ? `${rounded} lots on ${index.symbol} · ${fmt.money(Math.round(riskAmount * 100))} at risk (${stopPts} pts × tick ${index.tick})`
        : 'Enter a stop distance in points to size the position.';
      out.className = `form__note ${belowMin ? 'is-bad' : lots > 0 ? 'is-ok' : ''}`;
      if (belowMin) out.textContent += ` — below the ${index.minLot} lot minimum, so this stop is too tight for that risk.`;
    },
  };

  const accountInput = el('input', { type: 'number', value: '10000', min: '0', step: '100', inputmode: 'decimal', oninput: () => sizing.update() });
  const riskInput = el('input', { type: 'number', value: '1', min: '0', max: '100', step: '0.1', inputmode: 'decimal', oninput: () => sizing.update() });
  const stopInput = el('input', { type: 'number', value: '250', min: '0', step: '10', inputmode: 'decimal', oninput: () => sizing.update() });
  const out = el('p', { class: 'form__note' });

  draw();

  // First draw happens before the router mounts the page, so the column width is
  // not known yet; redraw once on the next frame with the real width.
  requestAnimationFrame(() => { if (chartHost.isConnected) draw(); });

  // The chart is drawn in real pixels, so re-draw when its column resizes.
  let resizeTimer = null;
  const onResize = () => {
    if (!chartHost.isConnected) { window.removeEventListener('resize', onResize); return; }
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(draw, 150);
  };
  window.addEventListener('resize', onResize);

  const page = el('div', { class: 'page' });
  page.append(
    el('div', { class: 'page__head' },
      el('div', {},
        el('h2', { class: 'page__title', text: 'Synthetic Indices' }),
        el('p', { class: 'page__sub', text: 'Volatility, step and range-break series to practice on when the forex market is closed.' })),
      chip('Simulated series', 'chip--warn')),
    el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:14px' },
      indexTabs, tfTabs),
    el('div', { class: 'grid grid--sidebar', style: 'margin-top:16px' },
      card('Chart', { note: 'simulation' },
        chartHost,
        stats,
        caption),
      el('div', {},
        card('Instrument', { note: 'simulation only' }, specBody,
          el('div', { style: 'height:1px;background:var(--line);margin:18px 0' }),
          el('p', { class: 'card__title', style: 'font-size:14px;margin-bottom:10px', text: 'Practice position size' }),
          el('div', { class: 'form form--3' },
            el('label', { class: 'field' }, el('span', { text: 'Account (USD)' }), accountInput),
            el('label', { class: 'field' }, el('span', { text: 'Risk %' }), riskInput),
            el('label', { class: 'field' }, el('span', { text: 'Stop (points)' }), stopInput)),
          out,
          el('button', {
            class: 'btn btn--outline btn--block',
            style: 'margin-top:14px',
            onclick: () => toast('Synthetic indices are simulation-only in this rebuild'),
          }, 'Open in practice terminal')))),
    el('div', { style: 'margin-top:16px' },
      card('Index comparison', { note: 'illustrative specs' },
        table([
          { key: 'symbol', label: 'Symbol', render: (r) => el('b', { text: r.symbol }) },
          { key: 'name', label: 'Series' },
          { key: 'vol', label: 'Volatility', num: true, render: (r) => `${r.vol}%` },
          { key: 'tick', label: 'Tick', num: true },
          { key: 'spread', label: 'Spread (pts)', num: true },
          { key: 'minLot', label: 'Min lot', num: true },
          { key: 'rangeDay', label: 'Daily range', num: true },
        ], INDICES))));
  return page;
}
