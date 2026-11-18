/**
 * Market data client.
 *
 * Talks to the local data service (server/market_service.py), which owns the
 * real providers: yfinance bars/quotes, optional lse-data, LuxAlgo market-trackers
 * CC0 dumps, and PineTS (AGPL-3.0) for indicator math.
 *
 * Every response says where it came from, when, and whether it is stale, so the
 * UI can label real data honestly instead of pretending.
 */

const BASE = (() => {
  const fromQuery = new URLSearchParams(location.search).get('market');
  if (fromQuery) return fromQuery.replace(/\/$/, '');
  const fromStorage = (() => { try { return localStorage.getItem('cairnline_market_api'); } catch { return null; } })();
  if (fromStorage) return fromStorage;
  // Same host as the app, port 8788 by default.
  return `${location.protocol}//${location.hostname || '127.0.0.1'}:8788`;
})();

const state = { online: false, checked: false, lastError: null };

async function get(path, { timeout = 45000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${BASE}${path}`, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${path} → ${res.status} ${body.slice(0, 120)}`);
    }
    state.online = true;
    state.lastError = null;
    return await res.json();
  } catch (err) {
    state.online = false;
    state.lastError = String(err && err.message ? err.message : err);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One write path for every non-GET call: same abort timer, same error shape.
 * A request with no timeout can leave a button pending forever on a stalled
 * service, so `timeout` is not optional here.
 *
 * `okStatus` lets a route that answers "I honestly have no data" with 503
 * (options flow) hand its body to the page instead of throwing.
 */
async function send(path, { method = 'POST', payload = undefined, timeout = 45000, okStatus = (status) => status >= 200 && status < 300 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const init = { method, signal: ctrl.signal, headers: { Accept: 'application/json' } };
    if (method === 'POST') {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(payload ?? {});
    }
    const res = await fetch(`${BASE}${path}`, init);
    const body = await res.json().catch(() => ({}));
    if (!okStatus(res.status, body)) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function post(path, payload, timeout = 45000) {
  return send(path, { method: 'POST', payload, timeout });
}

export const market = {
  get base() { return BASE; },
  setBase(url) {
    try { localStorage.setItem('cairnline_market_api', url); } catch { /* ignore */ }
  },
  status() { return { ...state, base: BASE }; },

  /* ---- provider configuration (LSE key lives server-side, never in the page) ---- */
  async config() {
    return get('/api/config', { timeout: 20000 });
  },
  async setLseKey(key) {
    return send('/api/config/lse', { payload: { key }, timeout: 15000 });
  },
  async clearLseKey() {
    return send('/api/config/lse', { method: 'DELETE', timeout: 15000 });
  },

  async health() {
    state.checked = true;
    return get('/api/health', { timeout: 8000 });
  },
  async quotes(symbols) {
    const q = symbols && symbols.length ? `?symbols=${encodeURIComponent(symbols.join(','))}` : '';
    return get(`/api/quotes${q}`);
  },
  async candles(symbol, interval = '15m', range = '5d') {
    return get(`/api/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}&range=${range}`);
  },
  async indicators(symbol, interval = '15m', { range = '5d', preset = 'core' } = {}) {
    return get(`/api/indicators?symbol=${encodeURIComponent(symbol)}&interval=${interval}&range=${range}&preset=${preset}`);
  },
  async basketSignals(interval = '15m') {
    return get(`/api/basket/signals?interval=${interval}`, { timeout: 90000 });
  },
  /* ---- Edge Stats: the engine lives in server/edge_stats.py ---- */
  async edgeStatsPresets() {
    return get('/api/edge-stats/presets', { timeout: 20000 });
  },
  async edgeStatsRun(payload) {
    return send('/api/edge-stats/run', { payload, timeout: 120000 });
  },

  /* ---- Options Flow: chain + tape from LSE, metrics in server/options_flow.py ---- */
  async optionsFlow({ underlying = 'SPY', window = '7d', limit = 1000, minPremium = null, maxDte = null } = {}) {
    const q = new URLSearchParams({ underlying, window, limit: String(limit) });
    if (minPremium) q.set('min_premium', String(minPremium));
    if (maxDte) q.set('max_dte', String(maxDte));
    // A 503 here is the engine's honest "no feed" answer, not a transport error:
    // hand it to the page so it can render the reason instead of inventing data.
    return send(`/api/options-flow?${q}`, {
      method: 'GET',
      timeout: 60000,
      okStatus: (status, body) => (status >= 200 && status < 300) || Boolean(body.reason),
    });
  },

  /* ---- Backtest Studio: the engine lives in server/backtest.py ---- */
  async backtestStrategies() {
    return get('/api/backtest/strategies', { timeout: 15000 });
  },
  async backtest(payload) {
    return send('/api/backtest', { payload, timeout: 120000 });   // an optimizer sweep takes longer
  },
  /* ---- Paper desk: server/paper_trader.py owns the rails and the ledger ---- */
  async paper() {
    return get('/api/paper', { timeout: 25000 });
  },
  async paperOrder(payload) {
    return post('/api/paper/order', payload, 30000);
  },
  async paperClose(id, reason = null) {
    return post('/api/paper/close', { id, reason }, 30000);
  },
  async paperKill(engaged, reason = null) {
    return post('/api/paper/kill', { engaged, reason }, 15000);
  },
  async paperRails(rails) {
    return post('/api/paper/rails', { rails }, 15000);
  },
  async paperDeploy(strategyFile) {
    return post('/api/paper/deploy', strategyFile, 20000);
  },
  async paperCycle(id = null) {
    return post('/api/paper/cycle', { id }, 120000);
  },

  /* ---- Trish: provider config + one chat turn ---- */
  async trishConfig() {
    return get('/api/trish/config', { timeout: 15000 });
  },
  async setTrishConfig(patch) {
    return send('/api/trish/config', { payload: patch, timeout: 15000 });
  },
  async clearTrish() {
    return send('/api/trish/config', { method: 'DELETE', timeout: 15000 });
  },
  async trishChat(messages, context = {}) {
    return send('/api/trish/chat', { payload: { messages, context }, timeout: 190000 });
  },
  /* ---- Trish engine (project-owned Hermes runtime) ---- */
  async trishEngine() {
    return get('/api/trish/engine', { timeout: 25000 });
  },
  async trishEngineAction(patch) {
    return send('/api/trish/engine', { payload: patch, timeout: 30000 });   // start/stop waits on the runtime
  },
  async trishPending() {
    return get('/api/trish/pending', { timeout: 15000 });
  },
  async trishDecide(id, action) {
    return send('/api/trish/pending', { payload: { id, action }, timeout: 20000 });
  },
  async trishMemory() {
    return get('/api/trish/memory', { timeout: 15000 });
  },
  async trishSaveMemory(name, text) {
    return send('/api/trish/memory', { payload: { name, text }, timeout: 20000 });
  },
  async trishSkills() {
    return get('/api/trish/skills', { timeout: 15000 });
  },
  async trishJourney() {
    return get('/api/trish/journey', { timeout: 15000 });
  },
  async cot(symbol = 'GC') {
    return get(`/api/cot?symbol=${encodeURIComponent(symbol)}`, { timeout: 60000 });
  },
  async calendar(region = 'US', days = 7) {
    return get(`/api/calendar?region=${encodeURIComponent(region)}&days=${days}`, { timeout: 60000 });
  },
  async publicRecord(dataset = 'insider', { ticker = null, limit = 25 } = {}) {
    const t = ticker ? `&ticker=${encodeURIComponent(ticker)}` : '';
    return get(`/api/public-record?dataset=${dataset}${t}&limit=${limit}`, { timeout: 60000 });
  },
};

/** Round a price to a sensible number of decimals for the instrument. */
export function px(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const a = Math.abs(v);
  const d = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 10 ? 3 : 5;
  return Number(v).toFixed(d);
}

export const pct = (v) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`);
