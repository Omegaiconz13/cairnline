import { el, card, chip, table } from '../ui.js';
import { market, px, pct } from '../market.js';

/**
 * Backtest Studio.
 *
 * The engine is server/backtest.py: a signal is decided on a closed bar and
 * filled at the next open, slippage and commission are charged on both sides,
 * and the stop is assumed to hit before the target when a bar spans both. This
 * page only states the inputs and reports what came back — it invents nothing.
 */

const SYMBOLS = [
  { sym: 'EURUSD', label: 'EUR/USD' },
  { sym: 'GBPUSD', label: 'GBP/USD' },
  { sym: 'USDJPY', label: 'USD/JPY' },
  { sym: 'XAUUSD', label: 'XAU/USD (Gold)' },
  { sym: 'GBPJPY', label: 'GBP/JPY' },
  { sym: 'BTCUSD', label: 'BTC/USD' },
];
const TIMEFRAMES = ['15m', '30m', '1h', '4h', '1d'];
const RANGES = ['1mo', '3mo', '6mo', '1y', '2y', '5y'];

const field = (label, input) => el('label', { class: 'field' }, el('span', { text: label }), input);
const numInput = (value, attrs = {}) => el('input', { type: 'number', step: 'any', value: String(value), ...attrs });

const when = (ms) => {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${d.toLocaleDateString(undefined, { month: 'short', day: '2-digit' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
};

/** Equity curve as a filled sparkline; the axis is the trade-by-trade book, not time. */
function curveSvg(points, width = 900, height = 150) {
  const vals = points.map((p) => p.v);
  if (vals.length < 2) return el('div', { class: 'empty' }, el('p', { class: 'card__note', text: 'No equity curve yet.' }));
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || max * 0.001 || 1;
  const x = (i) => (i / (vals.length - 1)) * width;
  const y = (v) => height - ((v - min) / span) * (height - 18) - 9;
  const line = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const up = vals[vals.length - 1] >= vals[0];
  const colour = up ? '#B4FF3A' : '#FF5A5F';
  const first = vals[0];
  const baseY = y(first).toFixed(1);
  return el('div', { class: 'bt__curve', html: `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img"
         aria-label="Equity curve from ${first} to ${vals[vals.length - 1]}">
      <line x1="0" y1="${baseY}" x2="${width}" y2="${baseY}" stroke="#1d2a2e" stroke-width="1" stroke-dasharray="4 4"/>
      <polygon points="0,${height} ${line} ${width},${height}" fill="${colour}" opacity="0.10"/>
      <polyline points="${line}" fill="none" stroke="${colour}" stroke-width="1.6"/>
    </svg>` });
}

export async function backtest(ctx) {
  const page = el('div', { class: 'page' });
  const out = el('div');

  /* ---- strategy metadata comes from the server, so params cannot drift ---- */
  let strategies = [];
  try {
    const meta = await market.backtestStrategies();
    strategies = meta.strategies || [];
  } catch {
    strategies = [];
  }
  if (!strategies.length) {
    page.append(
      el('div', { class: 'page__head' },
        el('div', {}, el('h2', { class: 'page__title', text: 'Backtest Studio' }))),
      card('Engine unavailable', {},
        el('div', { class: 'empty' },
          el('h3', { text: 'The market service is not answering' }),
          el('p', { text: 'Start it with python3 server/market_service.py — the backtest engine runs inside it.' }))));
    return page;
  }

  const symbolSel = el('select', {}, SYMBOLS.map((s) => el('option', { value: s.sym, text: s.label })));
  const tfSel = el('select', {}, TIMEFRAMES.map((t) => el('option', { value: t, text: t, selected: t === '1h' })));
  const rangeSel = el('select', {}, RANGES.map((r) => el('option', { value: r, text: r, selected: r === '1y' })));
  const strategySel = el('select', {}, strategies.map((s, i) =>
    el('option', { value: s.id, text: s.label, selected: i === 0 })));
  const commissionIn = numInput(2, { min: '0', max: '100', step: '0.5' });
  const slippageIn = numInput(1, { min: '0', max: '100', step: '0.5' });
  const balanceIn = numInput(10000, { min: '100', step: '100' });
  const riskIn = numInput(1, { min: '0.1', max: '20', step: '0.1' });

  /** The strategy's own parameter inputs, rebuilt when the strategy changes. */
  const paramBox = el('div', { class: 'form form--3' });
  let paramInputs = {};

  const paintsParams = () => {
    const def = strategies.find((s) => s.id === strategySel.value) || strategies[0];
    paramBox.replaceChildren();
    paramInputs = {};
    for (const spec of [...def.params, ...def.shared]) {
      const inp = numInput(spec.default, { min: String(spec.min), max: String(spec.max), step: String(spec.step) });
      paramInputs[spec.key] = inp;
      paramBox.append(field(spec.label, inp));
    }
  };

  const readForm = () => {
    const params = {};
    for (const [k, inp] of Object.entries(paramInputs)) {
      const v = Number(inp.value);
      if (Number.isFinite(v)) params[k] = v;
    }
    return {
      symbol: symbolSel.value,
      interval: tfSel.value,
      range: rangeSel.value,
      strategy: strategySel.value,
      params,
      commission_bps: Number(commissionIn.value) || 0,
      slippage_bps: Number(slippageIn.value) || 0,
      balance: Number(balanceIn.value) || 10000,
      risk_pct: Number(riskIn.value) || 1,
    };
  };

  /* ---- Strategy file: the run as one portable JSON document -----------------
   * A strategy here is a declared rule family plus its parameters, the market
   * window and the costs. Writing it down as a file is what makes a run
   * reproducible and shareable; loading one fills the same form the UI uses, so
   * the engine sees exactly the same request either way.
   */
  const STRATEGY_FORMAT = 'cairnline-strategy/1';
  const fileIn = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
  const loadBtn = el('button', { class: 'btn btn--outline', type: 'button' }, 'Load strategy file');
  const saveBtn = el('button', { class: 'btn btn--outline', type: 'button' }, 'Save strategy file');
  const fileNote = el('p', { class: 'card__note' });

  const runBtn = el('button', { class: 'btn btn--primary' }, 'Run backtest');
  const optBtn = el('button', { class: 'btn btn--outline' }, 'Optimise');
  const validateBtn = el('button', { class: 'btn btn--outline' }, 'Validate');
  const deployBtn = el('button', { class: 'btn btn--outline', disabled: true }, 'Deploy to paper desk');
  let lastValidation = null;
  const chartBtn = el('button', { class: 'btn btn--outline', disabled: true }, 'Show trades on chart');
  let lastRun = null;

  const busy = (node, text) => {
    out.replaceChildren(card('', {}, el('div', { class: 'empty' },
      el('h3', { text }), el('p', { class: 'card__note', text: 'Reading bars and running the engine…' }))));
    node.disabled = true;
  };

  const showError = (err) => {
    out.replaceChildren(card('Backtest failed', {},
      el('div', { class: 'empty' },
        el('h3', { text: 'Nothing was computed' }),
        el('p', { class: 'card__note', text: String(err.message || err).slice(0, 200) }))));
  };

  const paintRun = (r) => {
    lastRun = r;
    chartBtn.disabled = false;
    const m = r.metrics;
    const mc = r.monte_carlo;
    const tone = (v) => (v > 0 ? 'metric--accent' : 'neg');

    out.replaceChildren(
      card('Result', { note: `${r.strategy_label} · ${r.bars} bars · ${r.source}${r.stale ? ' (stale)' : ''}` },
        el('div', { class: 'metrics' },
          el('div', { class: `metric ${tone(m.net_pct)}` },
            el('div', { class: 'metric__k', text: 'Net P&L' }),
            el('div', { class: 'metric__v metric__v--sm', text: `$${m.net_pnl.toFixed(2)}` }),
            el('div', { class: 'card__note', text: pct(m.net_pct) })),
          el('div', { class: 'metric' },
            el('div', { class: 'metric__k', text: 'Trades' }),
            el('div', { class: 'metric__v', text: String(m.trades) })),
          el('div', { class: 'metric' },
            el('div', { class: 'metric__k', text: 'Win rate' }),
            el('div', { class: 'metric__v', text: m.win_rate == null ? '—' : `${m.win_rate}%` })),
          el('div', { class: 'metric' },
            el('div', { class: 'metric__k', text: 'Profit factor' }),
            el('div', { class: 'metric__v', text: m.profit_factor == null ? '—' : String(m.profit_factor) })),
          el('div', { class: 'metric' },
            el('div', { class: 'metric__k', text: 'Expectancy' }),
            el('div', { class: 'metric__v', text: m.expectancy_r == null ? '—' : `${m.expectancy_r}R` })),
          el('div', { class: 'metric' },
            el('div', { class: 'metric__k', text: 'Max drawdown' }),
            el('div', { class: 'metric__v', text: `${m.max_drawdown_pct}%` })),
          el('div', { class: 'metric' },
            el('div', { class: 'metric__k', text: 'Exposure' }),
            el('div', { class: 'metric__v', text: `${m.exposure_pct}%` })),
          el('div', { class: 'metric' },
            el('div', { class: 'metric__k', text: 'Final equity' }),
            el('div', { class: 'metric__v metric__v--sm', text: `$${m.final_equity.toFixed(2)}` }))),
        curveSvg(r.curve || []),
        el('p', { class: 'card__note', style: 'margin-top:12px', text: r.sample_note })),

      mc ? card('Monte Carlo', { note: `${mc.paths} paths · bootstrap of ${mc.trades_per_path} trades` },
        el('div', { class: 'metrics' },
          el('div', { class: 'metric' },
            el('div', { class: 'metric__k', text: 'Return p5' }),
            el('div', { class: 'metric__v metric__v--sm', text: pct(mc.final_return.p5) })),
          el('div', { class: 'metric metric--accent' },
            el('div', { class: 'metric__k', text: 'Return p50' }),
            el('div', { class: 'metric__v metric__v--sm', text: pct(mc.final_return.p50) })),
          el('div', { class: 'metric' },
            el('div', { class: 'metric__k', text: 'Return p95' }),
            el('div', { class: 'metric__v metric__v--sm', text: pct(mc.final_return.p95) })),
          el('div', { class: 'metric' },
            el('div', { class: 'metric__k', text: 'Drawdown p95' }),
            el('div', { class: 'metric__v metric__v--sm', text: `${mc.max_drawdown_pct.p95}%` })),
          el('div', { class: 'metric' },
            el('div', { class: 'metric__k', text: 'Chance of a loss' }),
            el('div', { class: 'metric__v metric__v--sm', text: `${mc.loss_probability_pct}%` }))),
        el('p', { class: 'card__note', style: 'margin-top:12px', text: mc.note })) : null,

      card('Trades', { note: `last ${Math.min(r.trades.length, 200)} of ${m.trades}` },
        table([
          { key: 'entry_time', label: 'Entry', render: (t) => when(t.entry_time) },
          { key: 'exit_time', label: 'Exit', render: (t) => when(t.exit_time) },
          { key: 'side', label: 'Side', render: (t) => chip(t.side.toUpperCase(), t.side === 'long' ? 'chip--on' : 'chip--danger') },
          { key: 'entry', label: 'In', num: true, render: (t) => px(t.entry) },
          { key: 'exit', label: 'Out', num: true, render: (t) => px(t.exit) },
          { key: 'r', label: 'R', num: true, render: (t) => (t.r > 0 ? `+${t.r}` : String(t.r)) },
          { key: 'pnl', label: 'P&L', num: true, render: (t) => `<span class="${t.pnl >= 0 ? 'mock__ok' : 'neg'}">${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}</span>` },
          { key: 'bars', label: 'Bars', num: true },
          { key: 'reason', label: 'Exit' },
        ], r.trades, { emptyTitle: 'No trades', emptyText: 'The strategy never produced an entry in this window.' })));
  };

  const paintOptimize = (r) => {
    out.replaceChildren(
      card('Parameter sweep', { note: `${r.combos} combinations · ranked on the full period` },
        table([
          { key: 'params', label: 'Params', render: (row) => Object.entries(row.params).map(([k, v]) => `${k} ${v}`).join(' · ') },
          { key: 'trades', label: 'Trades', num: true },
          { key: 'net_pct', label: 'Net %', num: true, render: (row) => `<span class="${row.net_pct >= 0 ? 'mock__ok' : 'neg'}">${row.net_pct}%</span>` },
          { key: 'win_rate', label: 'Win %', num: true, render: (row) => (row.win_rate == null ? '—' : row.win_rate) },
          { key: 'profit_factor', label: 'PF', num: true, render: (row) => (row.profit_factor == null ? '—' : row.profit_factor) },
          { key: 'max_drawdown_pct', label: 'DD %', num: true },
          { key: 'first_half_pct', label: '1st half', num: true },
          { key: 'second_half_pct', label: '2nd half', num: true },
          { key: 'stable', label: 'Stable', render: (row) => chip(row.stable ? 'BOTH HALVES +' : 'ONE HALF ONLY', row.stable ? 'chip--on' : 'chip--warn') },
        ], r.rows, { emptyTitle: 'No combinations', emptyText: 'Nothing was simulated.' }),
        el('p', { class: 'card__note', style: 'margin-top:12px', text: r.note }),
        el('p', { class: 'card__note', text: 'A sweep finds settings that fit this history. The half-split is there so a fit that only works once is visible, and it is still not an out-of-sample test of a new idea.' })));
  };

  const paintValidate = (r) => {
    lastValidation = r;
    deployBtn.disabled = false;
    const v = r.verdict;
    out.replaceChildren(
      card('Validation', { note: `${r.strategy_label} · ${r.bars} bars · grid of ${r.surface.tested} settings` },
        el('div', { class: 'metrics' },
          el('div', { class: `metric ${v.holds_up ? 'metric--accent' : 'neg'}` },
            el('div', { class: 'metric__k', text: 'Verdict' }),
            el('div', { class: 'metric__v metric__v--sm', text: v.label }),
            el('div', { class: 'card__note', text: `${r.checks.filter((c) => c.pass).length}/${r.checks.length} checks pass` })),
          el('div', { class: 'metric' },
            el('div', { class: 'metric__k', text: 'Out-of-sample' }),
            el('div', { class: 'metric__v metric__v--sm', text: pct(r.walk_forward.aggregate_oos_pct) }),
            el('div', { class: 'card__note', text: `${r.walk_forward.folds_held}/${r.walk_forward.folds_evaluated} folds positive` })),
          el('div', { class: 'metric' },
            el('div', { class: 'metric__k', text: 'Leader' }),
            el('div', { class: 'metric__v metric__v--sm', text: Object.entries(r.leader.params).map(([k, val]) => `${k} ${val}`).join(' · ') || '—' }),
            el('div', { class: 'card__note', text: `${r.leader.net_pct}% on the full period` })),
          el('div', { class: 'metric' },
            el('div', { class: 'metric__k', text: 'Safe risk' }),
            el('div', { class: 'metric__v metric__v--sm', text: r.optimal_risk && r.optimal_risk.recommended_risk_pct != null ? `${r.optimal_risk.recommended_risk_pct}%` : 'none' }),
            el('div', { class: 'card__note', text: r.optimal_risk ? `p95 drawdown cap ${r.optimal_risk.cap_dd_pct}%` : '—' }))),
        el('p', { class: 'note', style: 'margin-top:14px', text: v.sentence }),
        table([
          { key: 'label', label: 'Check' },
          { key: 'detail', label: 'What was measured' },
          { key: 'pass', label: 'Result', render: (row) => chip(row.pass ? 'PASS' : 'FAIL', row.pass ? 'chip--on' : 'chip--danger') },
        ], r.checks),
        el('p', { class: 'card__note', style: 'margin-top:12px', text: r.note })),

      card('Walk-forward folds', { note: `expanding in-sample · ${r.walk_forward.embargo_bars}-bar embargo` },
        table([
          { key: 'fold', label: 'Fold', num: true },
          { key: 'is_bars', label: 'IS bars', num: true },
          { key: 'oos_bars', label: 'OOS bars', num: true },
          { key: 'is_params', label: 'Chosen on IS', render: (row) => (row.is_params ? Object.entries(row.is_params).map(([k, val]) => `${k} ${val}`).join(' · ') : '—') },
          { key: 'is_net_pct', label: 'IS %', num: true },
          { key: 'oos_net_pct', label: 'OOS %', num: true, render: (row) => (row.oos_net_pct == null ? '—' : `<span class="${row.oos_net_pct >= 0 ? 'mock__ok' : 'neg'}">${row.oos_net_pct}%</span>`) },
          { key: 'oos_trades', label: 'OOS trades', num: true },
          { key: 'oos_profit_factor', label: 'PF', num: true },
          { key: 'held_up', label: 'Held', render: (row) => (row.evaluated ? chip(row.held_up ? 'HELD' : 'FAILED', row.held_up ? 'chip--on' : 'chip--warn') : String(row.skipped || '—')) },
        ], r.walk_forward.rows, { emptyTitle: 'No folds', emptyText: 'Not enough history for an out-of-sample window.' }),
        el('p', { class: 'card__note', style: 'margin-top:12px', text: r.walk_forward.method })),

      card('Parameter surface', { note: `${Math.round(r.surface.positive_share * 100)}% of tested settings are positive` },
        table([
          { key: 'params', label: 'Params', render: (row) => Object.entries(row.params).map(([k, val]) => `${k} ${val}`).join(' · ') || 'defaults' },
          { key: 'trades', label: 'Trades', num: true },
          { key: 'net_pct', label: 'Net %', num: true, render: (row) => `<span class="${row.net_pct >= 0 ? 'mock__ok' : 'neg'}">${row.net_pct}%</span>` },
        ], r.surface.rows, { emptyTitle: 'Nothing simulated', emptyText: 'The grid came back empty.' }),
        el('p', { class: 'card__note', style: 'margin-top:12px', text: `Median ${r.surface.median_net_pct}% · best ${r.surface.best_net_pct}%. A single good cell surrounded by losers is a spike, not an edge.` })),

      r.optimal_risk ? card('Risk sizing', { note: r.optimal_risk.note },
        table([
          { key: 'risk_pct', label: 'Risk per trade', num: true, render: (row) => `${row.risk_pct}%` },
          { key: 'p95_drawdown_pct', label: 'p95 drawdown', num: true, render: (row) => `${row.p95_drawdown_pct}%` },
          { key: 'p50_return_pct', label: 'Median return', num: true, render: (row) => `${row.p50_return_pct}%` },
          { key: 'loss_probability_pct', label: 'Chance of a loss', num: true, render: (row) => `${row.loss_probability_pct}%` },
        ], r.optimal_risk.rows)) : null);
  };

  runBtn.addEventListener('click', async () => {
    busy(runBtn, 'Running');
    try {
      paintRun(await market.backtest({ ...readForm(), mode: 'run' }));
    } catch (err) { showError(err); } finally { runBtn.disabled = false; }
  });

  optBtn.addEventListener('click', async () => {
    const form = readForm();
    const def = strategies.find((s) => s.id === form.strategy) || strategies[0];
    const spec = def.params[0];
    if (!spec) { showError(new Error('this strategy has no tunable parameter')); return; }
    const base = Number(form.params[spec.key] ?? spec.default);
    const step = Number(spec.step) || 1;
    const spread = Math.max(step, Math.round(base * 0.6));
    const values = [];
    for (let v = Math.max(spec.min, base - spread); v <= Math.min(spec.max, base + spread); v += step * Math.max(1, Math.round(spread / (step * 4)))) {
      values.push(v);
    }
    if (!values.length) values.push(base);
    busy(optBtn, 'Sweeping parameters');
    try {
      paintOptimize(await market.backtest({ ...form, mode: 'optimize', grid: { [spec.key]: values.slice(0, 8) } }));
    } catch (err) { showError(err); } finally { optBtn.disabled = false; }
  });

  validateBtn.addEventListener('click', async () => {
    busy(validateBtn, 'Validating');
    try {
      paintValidate(await market.backtest({ ...readForm(), mode: 'validate' }));
    } catch (err) { showError(err); } finally { validateBtn.disabled = false; }
  });

  /* A validated strategy is the only thing that can be deployed: the handover
     carries the verdict, so the paper desk can show what it was validated on. */
  deployBtn.addEventListener('click', () => {
    const cfg = asStrategyFile();
    if (lastValidation) {
      cfg.validation = {
        label: lastValidation.verdict.label,
        holds_up: lastValidation.verdict.holds_up,
        sentence: lastValidation.verdict.sentence,
        checks: lastValidation.checks.map((c) => ({ key: c.key, pass: c.pass, detail: c.detail })),
      };
    }
    try { localStorage.setItem('cairnline_pending_deployment', JSON.stringify(cfg)); } catch { /* private mode */ }
    location.hash = '#/paper';
  });

  /* Hand the run to the chart page: it draws Vela marks on the bars the trades
     actually happened on, and remembers them until another run replaces them. */
  chartBtn.addEventListener('click', () => {
    if (!lastRun) return;
    try {
      localStorage.setItem('cairnline_backtest_marks', JSON.stringify({
        symbol: lastRun.symbol,
        interval: lastRun.interval,
        range: lastRun.range,
        strategy: lastRun.strategy,
        net_pct: lastRun.metrics.net_pct,
        trades: lastRun.trades,
      }));
    } catch { /* private mode: nothing to draw */ }
    location.hash = '#/chart';
  });

  /* Read the current form as the file's shape, minus anything volatile. */
  const asStrategyFile = () => {
    const form = readForm();
    const def = strategies.find((s) => s.id === form.strategy) || strategies[0];
    return {
      format: STRATEGY_FORMAT,
      strategy: form.strategy,
      label: def.label,
      market: { symbol: form.symbol, interval: form.interval, range: form.range },
      costs: { commission_bps: form.commission_bps, slippage_bps: form.slippage_bps },
      balance: form.balance,
      risk_pct: form.risk_pct,
      params: form.params,
    };
  };

  const applyStrategyFile = (cfg) => {
    if (!cfg || typeof cfg !== 'object') throw new Error('the file is not a JSON object');
    const id = cfg.strategy || cfg.id;
    const def = strategies.find((s) => s.id === id);
    if (!def) throw new Error(`unknown strategy "${id}" — this engine has ${strategies.map((s) => s.id).join(', ')}`);
    strategySel.value = def.id;
    paintsParams();
    const m = cfg.market || {};
    const pick = (sel, value) => {
      if (!value) return;
      if ([...sel.options].some((o) => o.value === String(value))) sel.value = String(value);
    };
    pick(symbolSel, m.symbol);
    pick(tfSel, m.interval);
    pick(rangeSel, m.range);
    const c = cfg.costs || {};
    if (Number.isFinite(Number(c.commission_bps))) commissionIn.value = String(Number(c.commission_bps));
    if (Number.isFinite(Number(c.slippage_bps))) slippageIn.value = String(Number(c.slippage_bps));
    if (Number.isFinite(Number(cfg.balance))) balanceIn.value = String(Number(cfg.balance));
    if (Number.isFinite(Number(cfg.risk_pct))) riskIn.value = String(Number(cfg.risk_pct));
    for (const [k, v] of Object.entries(cfg.params || {})) {
      if (paramInputs[k] && Number.isFinite(Number(v))) paramInputs[k].value = String(Number(v));
    }
    fileNote.textContent = `Loaded ${cfg.label || def.label} · ${def.id} · ${symbolSel.value} ${tfSel.value} ${rangeSel.value}`;
  };

  saveBtn.addEventListener('click', () => {
    const cfg = asStrategyFile();
    try {
      const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: `cairnline-strategy-${cfg.strategy}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      fileNote.textContent = `Saved ${cfg.label} as cairnline-strategy-${cfg.strategy}.json`;
    } catch (err) {
      fileNote.textContent = `Could not save: ${String(err.message || err).slice(0, 120)}`;
    }
  });

  loadBtn.addEventListener('click', () => fileIn.click());
  fileIn.addEventListener('change', async () => {
    const file = fileIn.files && fileIn.files[0];
    if (!file) return;
    try {
      applyStrategyFile(JSON.parse(await file.text()));
    } catch (err) {
      fileNote.textContent = `Could not load ${file.name}: ${String(err.message || err).slice(0, 160)}`;
    } finally {
      fileIn.value = '';
    }
  });

  strategySel.addEventListener('change', paintsParams);
  paintsParams();

  page.append(
    el('div', { class: 'page__head' },
      el('div', {},
        el('h2', { class: 'page__title', text: 'Backtest Studio' }),
        el('p', { class: 'page__sub', text: 'Signal on a closed bar, fill at the next open, costs on both sides, ATR stop and R target.' })),
      chip('local engine · no account needed', 'chip--on')),
    card('Setup', {},
      el('div', { class: 'form form--3' },
        field('Symbol', symbolSel),
        field('Timeframe', tfSel),
        field('History', rangeSel),
        field('Strategy', strategySel),
        field('Commission (bps)', commissionIn),
        field('Slippage (bps)', slippageIn),
        field('Starting balance', balanceIn),
        field('Risk per trade (%)', riskIn)),
      el('div', { class: 'indmenu__label', style: 'padding-left:0', text: 'Strategy parameters' }),
      paramBox,
      el('div', { class: 'bt__actions' }, runBtn, optBtn, validateBtn, chartBtn, deployBtn, loadBtn, saveBtn, fileIn),
      fileNote),
    out);

  out.append(el('div', { class: 'empty' },
    el('h3', { text: 'Nothing simulated yet' }),
    el('p', { text: 'Press Run backtest. Every figure comes from the trades the engine actually took.' })));

  return page;
}
