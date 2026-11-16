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
  const fromStorage = (() => { try { return localStorage.getItem('pipnex_market_api'); } catch { return null; } })();
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

export const market = {
  get base() { return BASE; },
  setBase(url) {
    try { localStorage.setItem('pipnex_market_api', url); } catch { /* ignore */ }
  },
  status() { return { ...state, base: BASE }; },

  /* ---- provider configuration (LSE key lives server-side, never in the page) ---- */
  async config() {
    return get('/api/config', { timeout: 20000 });
  },
  async setLseKey(key) {
    const res = await fetch(`${BASE}/api/config/lse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  },
  async clearLseKey() {
    const res = await fetch(`${BASE}/api/config/lse`, { method: 'DELETE' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
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
  /* ---- Trish: provider config + one chat turn ---- */
  async trishConfig() {
    return get('/api/trish/config', { timeout: 15000 });
  },
  async setTrishConfig(patch) {
    const res = await fetch(`${BASE}/api/trish/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  },
  async clearTrish() {
    const res = await fetch(`${BASE}/api/trish/config`, { method: 'DELETE' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  },
  async trishChat(messages, context = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 190000);
    try {
      const res = await fetch(`${BASE}/api/trish/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, context }),
        signal: ctrl.signal,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      return body;
    } finally {
      clearTimeout(timer);
    }
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
