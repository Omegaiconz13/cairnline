#!/usr/bin/env node
/**
 * Prop-firm Monte Carlo bridge for MCP.
 *
 * Runs the dashboard's vendored, MIT-licensed engine
 * (app/dashboard/vendor/luxalgo/prop-firm-sim.global.js) headless, so Trish and
 * the browser use one implementation and one set of firm rules. The firm specs
 * are read out of the dashboard's own FIRMS table rather than copied, so there
 * is no second place to update when rules change.
 *
 * Protocol: one JSON object on stdin, one JSON object on stdout.
 *   {"mode":"list"}
 *   {"mode":"simulate","challenge_id":"ftmo-100k","stats":{...},"options":{...}}
 *   {"mode":"simulate","spec":{...},"stats":{...},"options":{...}}
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(here, '..', 'app', 'dashboard', 'vendor', 'luxalgo', 'prop-firm-sim.global.js');
const TOOLS = path.join(here, '..', 'app', 'dashboard', 'js', 'pages', 'tools.js');

function fail(message) {
  process.stdout.write(JSON.stringify({ error: message }));
  process.exit(0);
}

vm.runInThisContext(readFileSync(BUNDLE, 'utf8'));
const engine = globalThis.PropFirmSim;
if (!engine || typeof engine.simulate !== 'function') fail('prop-firm-sim bundle did not define simulate()');

/** The dashboard's FIRMS object literal, evaluated in isolation. */
function firms() {
  const src = readFileSync(TOOLS, 'utf8');
  const at = src.indexOf('const FIRMS = ');
  if (at < 0) throw new Error('FIRMS table not found in tools.js');
  const open = src.indexOf('{', at);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) throw new Error('unterminated FIRMS literal');
  return new Function('return ' + src.slice(open, end))(); // eslint-disable-line no-new-func
}

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;

let req = {};
try {
  req = JSON.parse(raw || '{}');
} catch (err) {
  fail(`bad request json: ${err.message}`);
}

const table = firms();
const mode = req.mode || 'simulate';

if (mode === 'list') {
  process.stdout.write(JSON.stringify({
    count: Object.keys(table).length,
    firms: Object.entries(table).map(([id, f]) => ({
      id,
      name: f.name,
      account_size: f.spec?.accountSize,
      steps: (f.spec?.steps || []).map((s) => s.profitTargetPct),
      daily_loss_pct: f.spec?.dailyLoss?.pct,
      max_loss_pct: f.spec?.maxLoss?.pct,
      max_loss_mode: f.spec?.maxLoss?.mode,
      fee_usd: f.spec?.fees?.price,
      fee_refundable: Boolean(f.spec?.fees?.refundableOnPass),
      profit_split_pct: f.spec?.funded?.profitSplitPct,
    })),
  }));
  process.exit(0);
}

const spec = req.spec || table[req.challenge_id]?.spec || table['ftmo-100k'].spec;
const stats = req.stats || {};
const options = { seed: 42, paths: 4000, ...(req.options || {}) };

let result;
try {
  result = engine.simulate(spec, {
    kind: 'parametric',
    winRate: stats.winRate,
    avgWinR: stats.avgWinR ?? 1.5,
    avgLossR: stats.avgLossR ?? 1,
    tradesPerDay: stats.tradesPerDay ?? 4,
    tradesPerDayModel: 'poisson',
    risk: { mode: 'percent-of-initial', value: stats.riskPct ?? 1 },
  }, options);
} catch (err) {
  fail(`simulation failed: ${err.message}`);
}

const fb = result.perAttempt?.failureBreakdown || {};
const killers = Object.entries(fb)
  .filter(([, v]) => Number(v) > 0)
  .sort((a, b) => Number(b[1]) - Number(a[1]))
  .map(([rule, share]) => ({ rule, share }));

process.stdout.write(JSON.stringify({
  challenge: {
    id: spec.challengeId,
    name: spec.name,
    account_size: spec.accountSize,
    steps: (spec.steps || []).map((s) => s.profitTargetPct),
    daily_loss_pct: spec.dailyLoss?.pct,
    max_loss_pct: spec.maxLoss?.pct,
    max_loss_mode: spec.maxLoss?.mode,
    fee_usd: spec.fees?.price,
  },
  stats: {
    win_rate: stats.winRate,
    avg_win_r: stats.avgWinR ?? 1.5,
    avg_loss_r: stats.avgLossR ?? 1,
    trades_per_day: stats.tradesPerDay ?? 4,
    risk_pct: stats.riskPct ?? 1,
  },
  paths: result.meta?.paths ?? options.paths,
  seed: options.seed,
  pass_probability: result.perAttempt?.passProbability,
  pass_ci: result.perAttempt?.passProbabilityCi,
  avg_days_when_passed: result.perAttempt?.avgDaysWhenPassed,
  expected_attempts: result.journey?.attempts?.mean,
  funded_probability: result.journey?.fundedProbability,
  ev_usd: result.ev?.evTotal,
  p_profit: result.ev?.pPositive,
  failure_breakdown: killers.slice(0, 6),
}));
