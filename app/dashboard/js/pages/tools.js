import { el, card, chip, toast } from '../ui.js';
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

/** P(outcome | conditions) over real bars, with sample size and Wilson CI. */
export async function edgeStats(ctx) {
  const page = el('div', { class: 'page' });
  const out = el('div', {}, el('div', { class: 'empty' }, el('h3', { text: 'Reading bars…' })));

  const symSel = el('select', {}, ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'GBPJPY', 'BTCUSD']
    .map((s) => el('option', { value: s, text: s })));
  const condSel = el('select', {},
    el('option', { value: 'gap', text: 'Gap fills the same day' }),
    el('option', { value: 'monday', text: 'Monday closes green' }),
    el('option', { value: 'outside', text: 'Outside day → next day up' }));
  const rangeSel = el('select', {},
    el('option', { value: '2y', text: '2 years' }),
    el('option', { value: '5y', text: '5 years' }),
    el('option', { value: '1y', text: '1 year' }));

  const run = async () => {
    out.replaceChildren(el('div', { class: 'empty' }, el('h3', { text: 'Reading bars…' })));
    let bars = [];
    try {
      const data = await market.candles(symSel.value, '1d', rangeSel.value);
      bars = data.bars || [];
    } catch (err) {
      out.replaceChildren(card('No data', {},
        el('div', { class: 'empty' },
          el('h3', { text: 'Market service unreachable' }),
          el('p', { text: 'Edge Stats needs real daily bars. Start the service and reload.' }))));
      return;
    }
    if (bars.length < 30) {
      out.replaceChildren(card('Not enough history', {},
        el('p', { class: 'card__note', text: `Only ${bars.length} daily bars came back.` })));
      return;
    }

    // Build the condition/outcome pairs from real OHLC.
    const samples = [];
    for (let i = 1; i < bars.length; i += 1) {
      const b = bars[i];
      const p = bars[i - 1];
      const d = new Date(b.openTime);
      const dow = d.getUTCDay();
      if (condSel.value === 'gap') {
        const gap = (b.open - p.close) / p.close;
        if (Math.abs(gap) < 0.0005) continue;         // meaningful gap only
        const filled = gap > 0 ? b.low <= p.close : b.high >= p.close;
        samples.push(filled ? 1 : 0);
      } else if (condSel.value === 'monday') {
        if (dow !== 1) continue;
        samples.push(b.close > b.open ? 1 : 0);
      } else {
        const outside = b.high > p.high && b.low < p.low;
        if (!outside || i + 1 >= bars.length) continue;
        samples.push(bars[i + 1].close > b.close ? 1 : 0);
      }
    }

    const n = samples.length;
    const hits = samples.reduce((a, b) => a + b, 0);
    const [lo, hi] = wilson(hits, n);
    const base = n ? hits / n : 0;

    const label = {
      gap: 'Gap fills the same day',
      monday: 'Monday closes green',
      outside: 'Outside day → next day up',
    }[condSel.value];

    out.replaceChildren(card(`${label} — ${symSel.value}`, { note: `${rangeSel.value} of daily bars` },
      n < 10
        ? el('div', { class: 'empty' },
            el('h3', { text: 'Sample too small' }),
            el('p', { text: `Only ${n} matching bars in this window — widen the range or pick another condition.` }))
        : el('div', {},
            el('div', { class: 'metrics' },
              el('div', { class: 'metric metric--accent' },
                el('div', { class: 'metric__k', text: 'Estimate' }),
                el('div', { class: 'metric__v', text: pctStr(base) })),
              el('div', { class: 'metric' },
                el('div', { class: 'metric__k', text: 'Sample size' }),
                el('div', { class: 'metric__v', text: String(n) })),
              el('div', { class: 'metric' },
                el('div', { class: 'metric__k', text: '95% CI' }),
                el('div', { class: 'metric__v metric__v--sm', text: `${pctStr(lo)} – ${pctStr(hi)}` })),
              el('div', { class: 'metric' },
                el('div', { class: 'metric__k', text: 'Hits' }),
                el('div', { class: 'metric__v', text: String(hits) }))),
            el('div', { class: 'bars', style: 'margin-top:18px' },
              el('div', { class: 'bars__row' },
                el('span', { class: 'bars__label', text: 'observed' }),
                el('div', { class: 'bars__track' }, el('i', { style: `width:${(base * 100).toFixed(1)}%` })),
                el('span', { class: 'bars__val', text: pctStr(base) }))),
            el('p', { class: 'card__note', style: 'margin-top:16px',
              text: `P(outcome | condition) = ${hits}/${n} on live ${symSel.value} daily bars. Wilson interval, not a normal approximation — it stays honest at small N. Same question shape as LuxAlgo's Edge Stats.` }))));
  };

  [symSel, condSel, rangeSel].forEach((s) => s.addEventListener('change', run));

  page.append(
    el('div', { class: 'page__head' },
      el('div', {},
        el('h2', { class: 'page__title', text: 'Edge Stats' }),
        el('p', { class: 'page__sub', text: 'Ask how often a setup actually worked, on real bars, with the sample size attached.' })),
      chip('MIT · LuxAlgo edge-stats', 'chip--on')),
    card('Question', {},
      el('div', { class: 'form form--3' },
        field('Symbol', symSel),
        field('Condition', condSel),
        field('History', rangeSel))),
    out);
  run();
  return page;
}
