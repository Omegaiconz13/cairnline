import { el, card, chip, toast, table } from '../ui.js';
import { market, px, pct } from '../market.js';

/* ------------------------------------------------------------------ shared */

const field = (label, input) => el('label', { class: 'field' }, el('span', { text: label }), input);

const num = (value, attrs = {}) => el('input', { type: 'number', value: String(value), ...attrs });

/** Wilson score interval — honest about small samples. */
function wilson(hits, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = hits / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

const pctStr = (v) => `${(v * 100).toFixed(1)}%`;

// Edge Stats prefers the shared table helper; the alias keeps the call sites short.
const tableEl = table;

/* --------------------------------------------------- prop firm simulator */

const FIRMS = {
  'topstep-50k': {
    name: 'Topstep 50K (2-step)',
    spec: {
      challengeId: 'topstep-50k', name: 'Topstep 50K', accountSize: 50000,
      steps: [{ profitTargetPct: 6 }, { profitTargetPct: 6 }],
      dailyLoss: { pct: 4 }, maxLoss: { pct: 6, mode: 'trailing-locks-at-initial' },
      fees: { price: 165, refundableOnPass: false },
      funded: { profitSplitPct: 90, payoutFrequency: 'monthly' },
    },
  },
  'ftmo-100k': {
    name: 'FTMO 100K (2-step)',
    spec: {
      challengeId: 'ftmo-100k', name: 'FTMO 100K', accountSize: 100000,
      steps: [{ profitTargetPct: 10 }, { profitTargetPct: 5 }],
      dailyLoss: { pct: 5 }, maxLoss: { pct: 10, mode: 'static-initial' },
      fees: { price: 540, refundableOnPass: true },
      funded: { profitSplitPct: 80, payoutFrequency: 'biweekly' },
    },
  },
  'apex-100k': {
    name: 'Apex 100K (trailing)',
    spec: {
      challengeId: 'apex-100k', name: 'Apex 100K', accountSize: 100000,
      steps: [{ profitTargetPct: 6 }],
      dailyLoss: { pct: 5 }, maxLoss: { pct: 6, mode: 'trailing-intraday-unrealized' },
      fees: { price: 147, refundableOnPass: false },
      funded: { profitSplitPct: 90, payoutFrequency: 'monthly' },
    },
  },
  'custom-100k': {
    name: 'Generic 100K (static)',
    spec: {
      challengeId: 'generic-100k', name: 'Generic 100K', accountSize: 100000,
      steps: [{ profitTargetPct: 8 }, { profitTargetPct: 5 }],
      dailyLoss: { pct: 5 }, maxLoss: { pct: 10, mode: 'static-initial' },
      fees: { price: 500, refundableOnPass: true },
      funded: { profitSplitPct: 80, payoutFrequency: 'biweekly' },
    },
  },
};

export async function propFirm(ctx) {
  const engine = window.PropFirmSim;
  const page = el('div', { class: 'page' });
  const out = el('div');

  if (!engine || typeof engine.simulate !== 'function') {
    page.append(
      el('div', { class: 'page__head' }, el('div', {},
        el('h2', { class: 'page__title', text: 'Prop Firm Simulator' }))),
      card('Engine unavailable', {},
        el('div', { class: 'empty' },
          el('h3', { text: 'Prop Firm Sim did not load' }),
          el('p', { text: 'The bundled Monte Carlo engine is missing from vendor/luxalgo. Reload the page.' }))));
    return page;
  }

  const firmSel = el('select', {}, Object.entries(FIRMS).map(([k, v]) => el('option', { value: k, text: v.name })));
  const winRate = num(45, { min: '1', max: '95', step: '1' });
  const avgWinR = num(1.4, { min: '0.1', step: '0.1' });
  const avgLossR = num(1, { min: '0.1', step: '0.1' });
  const tradesDay = num(4, { min: '1', max: '40', step: '1' });
  const riskPct = num(1, { min: '0.1', max: '10', step: '0.1' });
  const paths = num(10000, { min: '500', max: '50000', step: '500' });

  const run = () => {
    const spec = FIRMS[firmSel.value].spec;
    let r;
    try {
      r = engine.simulate(
        spec,
        {
          kind: 'parametric',
          winRate: Number(winRate.value) / 100,
          avgWinR: Number(avgWinR.value),
          avgLossR: Number(avgLossR.value),
          tradesPerDay: Number(tradesDay.value),
          tradesPerDayModel: 'poisson',
          risk: { mode: 'percent-of-initial', value: Number(riskPct.value) },
        },
        { seed: 42, paths: Math.min(50000, Math.max(500, Number(paths.value))) },
      );
    } catch (err) {
      out.replaceChildren(card('Simulation failed', {}, el('p', { class: 'card__note', text: String(err.message || err) })));
      return;
    }

    const ci = r.perAttempt.passProbabilityCi || {};
    const fb = r.perAttempt.failureBreakdown || {};
    const total = Object.values(fb).reduce((a, b) => a + (Number(b) || 0), 0) || 1;

    out.replaceChildren(
      card('Your odds', { note: `${r.meta?.paths ?? paths.value} paths · seed 42` },
        el('div', { class: 'metrics' },
          el('div', { class: 'metric metric--accent' },
            el('div', { class: 'metric__k', text: 'Pass probability' }),
            el('div', { class: 'metric__v', text: pctStr(r.perAttempt.passProbability) }),
            el('div', { class: 'card__note', text: ci.low != null ? `95% CI ${pctStr(ci.low)}–${pctStr(ci.high)}` : '' })),
          el('div', { class: 'metric' },
            el('div', { class: 'metric__k', text: 'Expected attempts' }),
            el('div', { class: 'metric__v', text: (r.journey?.attempts?.mean ?? 0).toFixed(2) })),
          el('div', { class: 'metric' },
            el('div', { class: 'metric__k', text: 'Fee at risk' }),
            el('div', { class: 'metric__v', text: `$${Math.round(spec.fees?.price ?? 0)}` })),
          el('div', { class: 'metric' },
            el('div', { class: 'metric__k', text: 'Chance of profit' }),
            el('div', { class: 'metric__v', text: pctStr(r.ev?.pPositive ?? 0) })),
          el('div', { class: 'metric' },
            el('div', { class: 'metric__k', text: 'Expected value' }),
            el('div', { class: `metric__v ${r.ev?.evTotal >= 0 ? 'metric--accent' : 'neg'}`, text: `$${Math.round(r.ev?.evTotal ?? 0)}` })),
          el('div', { class: 'metric' },
            el('div', { class: 'metric__k', text: 'Days to pass' }),
            el('div', { class: 'metric__v', text: Math.round(r.perAttempt.avgDaysWhenPassed ?? 0) })),
          el('div', { class: 'metric' },
            el('div', { class: 'metric__k', text: 'Funded, then paid' }),
            el('div', { class: 'metric__v', text: pctStr(r.journey?.fundedProbability ?? 0) }))),
        el('div', { style: 'margin-top:20px' },
          el('h3', { style: 'font-size:13px;margin-bottom:10px', text: 'What actually kills the challenge' }),
          el('div', { class: 'bars' },
            ...Object.entries(fb).filter(([, v]) => v > 0).map(([k, v]) => el('div', { class: 'bars__row' },
              el('span', { class: 'bars__label', text: k.replace(/([A-Z])/g, ' $1').toLowerCase() }),
              el('div', { class: 'bars__track' }, el('i', { style: `width:${((v / total) * 100).toFixed(1)}%` })),
              el('span', { class: 'bars__val', text: pctStr(v / total) }))))),
        el('p', { class: 'card__note', style: 'margin-top:16px',
          text: 'Deterministic Monte Carlo: the same inputs and seed always produce these numbers. Parametric model — win rate, R multiples and trade frequency are your assumptions, not a track record.' })));
  };

  [firmSel, winRate, avgWinR, avgLossR, tradesDay, riskPct, paths].forEach((i) =>
    i.addEventListener('input', run));
  firmSel.addEventListener('change', run);

  page.append(
    el('div', { class: 'page__head' },
      el('div', {},
        el('h2', { class: 'page__title', text: 'Prop Firm Simulator' }),
        el('p', { class: 'page__sub', text: 'Know your odds before you pay the fee. Rule-aware Monte Carlo over real challenge mechanics.' })),
      chip('MIT · LuxAlgo prop-firm-sim', 'chip--on')),
    card('Your trading profile', {},
      el('div', { class: 'form form--3' },
        field('Firm ruleset', firmSel),
        field('Win rate (%)', winRate),
        field('Average win (R)', avgWinR),
        field('Average loss (R)', avgLossR),
        field('Trades per day', tradesDay),
        field('Risk per trade (%)', riskPct),
        field('Paths', paths))),
    out);
  run();
  return page;
}

/* --------------------------------------------------------- edge stats */

const ES_SYMBOLS = [
  ['EURUSD', 'EUR/USD'], ['GBPUSD', 'GBP/USD'], ['USDJPY', 'USD/JPY'],
  ['XAUUSD', 'XAU/USD (gold)'], ['GBPJPY', 'GBP/JPY'], ['BTCUSD', 'BTC/USD'],
];
const ES_TIMEFRAMES = [['15m', '15m'], ['1h', '1h'], ['4h', '4h'], ['1d', 'daily']];
const ES_RANGES = [['3mo', '3 months'], ['6mo', '6 months'], ['1y', '1 year'], ['2y', '2 years'], ['5y', '5 years']];

/**
 * Edge Stats — one preset from LuxAlgo's edge-stats catalog (MIT, vendored in
 * server/presets/) answered by our own engine over our own bars.
 *
 * The page shows the point estimate next to its Wilson interval, the
 * unconditional baseline for the same outcome, the half-split, the per-year
 * counts and the per-session split. A rate without those is a guess.
 */
export async function edgeStats(ctx) {
  const page = el('div', { class: 'page' });
  const out = el('div');

  let catalog = null;
  try {
    catalog = await market.edgeStatsPresets();
  } catch {
    catalog = null;
  }
  if (!catalog || !catalog.presets || !catalog.presets.length) {
    page.append(
      el('div', { class: 'page__head' }, el('div', {}, el('h2', { class: 'page__title', text: 'Edge Stats' }))),
      card('Engine unavailable', {},
        el('div', { class: 'empty' },
          el('h3', { text: 'The market service is not answering' }),
          el('p', { text: 'Start it with python3 server/market_service.py — the Edge Stats engine runs inside it.' }))));
    return page;
  }

  const presets = catalog.presets;
  const byId = new Map(presets.map((p) => [p.id, p]));
  const categories = [...new Set(presets.map((p) => p.category))].sort();

  const presetSel = el('select', {}, categories.map((cat) =>
    el('optgroup', { label: cat }, presets.filter((p) => p.category === cat).map((p) =>
      el('option', { value: p.id, text: p.title, selected: p.id === 'green-rate' })))));
  const symSel = el('select', {}, ES_SYMBOLS.map(([v, t]) => el('option', { value: v, text: t, selected: v === 'XAUUSD' })));
  const tfSel = el('select', {}, ES_TIMEFRAMES.map(([v, t]) => el('option', { value: v, text: t, selected: v === '1h' })));
  const rangeSel = el('select', {}, ES_RANGES.map(([v, t]) => el('option', { value: v, text: t, selected: v === '1y' })));
  const paramsBox = el('div', { class: 'form form--3' });
  const summaryEl = el('p', { class: 'card__note' });
  const runBtn = el('button', { class: 'btn btn--primary' }, 'Run preset');
  let paramInputs = {};

  const paintParams = () => {
    const p = byId.get(presetSel.value);
    paramsBox.replaceChildren();
    paramInputs = {};
    summaryEl.textContent = p ? p.summary : '';
    for (const spec of p ? p.params : []) {
      let input;
      if (spec.type === 'enum' && spec.values) {
        // No default means "no filter": leave the choice empty rather than
        // silently picking the first option and narrowing the denominator.
        input = el('select', {},
          spec.default === undefined ? [el('option', { value: '', text: 'any (no filter)' })] : [],
          spec.values.map((v) => el('option', {
            value: String(v), text: String(v), selected: String(v) === String(spec.default ?? ''),
          })));
      } else {
        // A numeric parameter with no default is unbounded upstream: leaving it
        // empty keeps it out of the query instead of pinning it to an arbitrary 1.
        input = el('input', {
          type: 'number', step: 'any',
          value: spec.default === undefined || spec.default === null ? '' : String(spec.default),
          placeholder: 'any', min: '0',
        });
      }
      paramInputs[spec.name] = { input, spec };
      paramsBox.append(field(`${spec.name}${spec.type === 'duration' ? ' (minutes)' : ''}`, input));
    }
    if (!paramsBox.childElementCount) {
      paramsBox.append(el('p', { class: 'card__note', text: 'This preset takes no parameters.' }));
    }
  };

  const readParams = () => {
    const params = {};
    for (const [name, { input, spec }] of Object.entries(paramInputs)) {
      const raw = input.value;
      if (raw === '') continue;
      params[name] = spec.type === 'enum' || spec.type === 'string' ? raw : Number(raw);
    }
    return params;
  };

  const pctText = (v) => (v === null || v === undefined ? '—' : `${v}%`);
  const ciText = (b) => (b && b.ci_low !== null ? `${b.ci_low}–${b.ci_high}%` : '—');

  const paintResult = (r) => {
    const est = r.estimate;
    const base = r.baseline || {};
    const st = r.stability || {};
    const tone = est.rate === null ? '' : 'metric--accent';

    const children = [];

    children.push(card(r.preset.title, {
      note: `${r.symbol} · ${r.interval} · ${r.history} · ${r.sessions.count} sessions (${r.sessions.first} → ${r.sessions.last}) · ${r.source}${r.stale ? ' (stale)' : ''}`,
    },
      el('p', { class: 'card__note', text: r.preset.summary }),
      el('div', { class: 'metrics' },
        el('div', { class: `metric ${tone}` },
          el('div', { class: 'metric__k', text: 'Estimate' }),
          el('div', { class: 'metric__v', text: pctText(est.rate) }),
          el('div', { class: 'card__note', text: `95% CI ${ciText(est)}` })),
        el('div', { class: 'metric' },
          el('div', { class: 'metric__k', text: 'Observations' }),
          el('div', { class: 'metric__v', text: String(est.n) }),
          el('div', { class: 'card__note', text: `${est.hits} hits` })),
        el('div', { class: 'metric' },
          el('div', { class: 'metric__k', text: 'Baseline' }),
          el('div', { class: 'metric__v', text: pctText(base.rate) }),
          el('div', { class: 'card__note', text: `unconditional, n=${base.n || 0}` })),
        el('div', { class: 'metric' },
          el('div', { class: 'metric__k', text: 'Lift' }),
          el('div', { class: 'metric__v', text: r.lift_points === null ? '—' : `${r.lift_points > 0 ? '+' : ''}${r.lift_points} pts` })),
        el('div', { class: 'metric' },
          el('div', { class: 'metric__k', text: 'Stability' }),
          el('div', { class: 'metric__v metric__v--sm', text: st.score === null || st.score === undefined ? '—' : `${st.score} · ${st.label}` })),
        el('div', { class: 'metric' },
          el('div', { class: 'metric__k', text: 'CI width' }),
          el('div', { class: 'metric__v metric__v--sm', text: est.ci_width === null ? '—' : `${est.ci_width} pts` }))),
      el('div', { class: 'bars', style: 'margin-top:16px' },
        el('div', { class: 'bars__row' },
          el('span', { class: 'bars__label', text: 'conditional' }),
          el('div', { class: 'bars__track' }, el('i', { style: `width:${est.rate || 0}%` })),
          el('span', { class: 'bars__val', text: pctText(est.rate) })),
        el('div', { class: 'bars__row' },
          el('span', { class: 'bars__label', text: 'baseline' }),
          el('div', { class: 'bars__track' }, el('i', { style: `width:${base.rate || 0}%;opacity:.55` })),
          el('span', { class: 'bars__val', text: pctText(base.rate) }))),
      el('p', { class: 'card__note', style: 'margin-top:14px', text: r.verdict })));

    if (st.halves && st.halves.length === 2) {
      children.push(card('Stability', { note: 'the same estimate on each half of the sample, split by time' },
        el('div', { class: 'metrics' },
          st.halves.map((h, i) => el('div', { class: 'metric' },
            el('div', { class: 'metric__k', text: i === 0 ? 'First half' : 'Second half' }),
            el('div', { class: 'metric__v metric__v--sm', text: pctText(h.rate) }),
            el('div', { class: 'card__note', text: `n=${h.n} · CI ${ciText(h)}` }))))));
    }

    children.push(card('By session', { note: 'UTC windows, attributed to when the outcome happened' },
      r.by_session && r.by_session.length
        ? el('div', {},
            tableEl([
              { key: 'session', label: 'Session' },
              { key: 'utc', label: 'UTC', render: (row) => (r.session_windows.find((w) => w.key === row.key) || {}).utc || '—' },
              { key: 'rate', label: 'Rate', num: true, render: (row) => pctText(row.rate) },
              { key: 'ci', label: '95% CI', render: (row) => ciText(row) },
              { key: 'n', label: 'N', num: true },
            ], r.by_session),
            el('p', { class: 'card__note', style: 'margin-top:10px', text: r.session_note }))
        : el('p', { class: 'card__note', text: r.session_note })));

    if (r.groups && r.groups.length) {
      children.push(card(`Split by ${r.preset.groupBy}`, { note: 'each row its own denominator and interval' },
        tableEl([
          { key: 'group', label: r.preset.groupBy },
          { key: 'rate', label: 'Rate', num: true, render: (row) => pctText(row.rate) },
          { key: 'ci', label: '95% CI', render: (row) => ciText(row) },
          { key: 'n', label: 'N', num: true },
        ], r.groups)));
    }

    if (r.per_year && r.per_year.length) {
      children.push(card('By year', { note: 'drift in the sample itself' },
        tableEl([
          { key: 'year', label: 'Year' },
          { key: 'rate', label: 'Rate', num: true, render: (row) => pctText(row.rate) },
          { key: 'ci', label: '95% CI', render: (row) => ciText(row) },
          { key: 'n', label: 'N', num: true },
        ], r.per_year)));
    }

    if (r.distribution) {
      children.push(card('Distribution', { note: r.distribution.unit },
        el('div', { class: 'metrics' },
          ['p10', 'p50', 'p90'].map((k) => el('div', { class: 'metric' },
            el('div', { class: 'metric__k', text: k }),
            el('div', { class: 'metric__v metric__v--sm', text: String(r.distribution[k]) })))),
        el('p', { class: 'card__note', style: 'margin-top:10px', text: `over ${r.distribution.n} observations` })));
    }

    children.push(card('How this was computed', {},
      el('p', { class: 'card__note', text: `Outcome: ${r.outcome}${r.where ? ` · condition: ${r.where}` : ''}` }),
      el('p', { class: 'card__note', text: `Session: ${r.definitions.session}. ${r.definitions.gap_floor_note}.` }),
      el('p', { class: 'card__note', text: `Interval: ${r.definitions.ci}. Stability: ${r.definitions.stability}.` }),
      el('p', { class: 'card__note', text: `Bars: ${r.sessions.bars} (${r.sessions.bar_minutes} min each); open == close on ${r.sessions.flat_open_close_pct}% of sessions.` })));

    out.replaceChildren(...children);
  };

  const run = async () => {
    runBtn.disabled = true;
    out.replaceChildren(card('', {}, el('div', { class: 'empty' },
      el('h3', { text: 'Reading bars and evaluating the preset…' }),
      el('p', { class: 'card__note', text: 'Sessions are built from the bars, then the preset is applied.' }))));
    try {
      paintResult(await market.edgeStatsRun({
        presetId: presetSel.value,
        symbol: symSel.value,
        interval: tfSel.value,
        range: rangeSel.value,
        params: readParams(),
      }));
    } catch (err) {
      out.replaceChildren(card('Nothing computed', {},
        el('div', { class: 'empty' },
          el('h3', { text: 'The engine refused this run' }),
          el('p', { class: 'card__note', text: String(err.message || err).slice(0, 300) }))));
    } finally {
      runBtn.disabled = false;
    }
  };

  presetSel.addEventListener('change', paintParams);
  runBtn.addEventListener('click', run);
  paintParams();

  page.append(
    el('div', { class: 'page__head' },
      el('div', {},
        el('h2', { class: 'page__title', text: 'Edge Stats' }),
        el('p', { class: 'page__sub', text: `${presets.length} presets from LuxAlgo's edge-stats catalog (MIT), answered by our own engine over live bars — every result with its interval, its stability split and a per-session breakdown.` })),
      chip(`${presets.length} presets · real engine`, 'chip--on')),
    card('Preset', {},
      el('div', { class: 'form form--3' },
        field('Question', presetSel),
        field('Symbol', symSel),
        field('Timeframe', tfSel),
        field('History', rangeSel)),
      summaryEl,
      paramsBox,
      el('div', { class: 'bt__actions' }, runBtn)),
    out);

  out.append(el('div', { class: 'empty' },
    el('h3', { text: 'Pick a question and run it' }),
    el('p', { text: 'The presets are LuxAlgo\'s own definitions; the answers come from this machine\'s bars.' })));
  run();
  return page;
}
