/**
 * Live adapter — the same API surface as the mock in `data.js`, implemented
 * against the production Supabase project over PostgREST.
 *
 * Reads only. Every call is a GET; nothing here writes, and row-level
 * security still applies to the signed-in user's own rows.
 *
 * A session is required for user-scoped tables. Paste the access token (or the
 * whole `sb-…-auth-token` storage JSON) in Settings → Data source.
 */
import { SUPABASE } from './config.js';

let session = null; // { accessToken, userId, email }

export function setSession(next) {
  if (!next) { session = null; return null; }
  let token = String(next).trim();
  let userId = null;
  let email = null;
  if (token.startsWith('{')) {
    try {
      const parsed = JSON.parse(token);
      token = parsed.access_token || parsed.accessToken || '';
      const claims = decodeClaims(token);
      userId = claims?.sub || parsed.user?.id || null;
      email = parsed.user?.email || claims?.email || null;
    } catch { token = ''; }
  }
  if (!token) return null;
  const claims = decodeClaims(token);
  session = { accessToken: token, userId: userId || claims?.sub || null, email: email || claims?.email || null };
  try { localStorage.setItem('pipnex_live_session', JSON.stringify(session)); } catch { /* private mode */ }
  return session;
}

export function loadStoredSession() {
  try {
    const raw = localStorage.getItem('pipnex_live_session');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    session = parsed.accessToken ? parsed : null;
    return session;
  } catch { return null; }
}

export function clearSession() {
  session = null;
  try { localStorage.removeItem('pipnex_live_session'); } catch { /* ignore */ }
}

export const hasSession = () => Boolean(session && session.accessToken);
export const sessionInfo = () => (session ? { userId: session.userId, email: session.email } : null);

function decodeClaims(token) {
  try {
    const part = token.split('.')[1];
    return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
  } catch { return null; }
}

/** PostgREST GET with the anon key + user bearer token. */
async function rest(table, query = '') {
  const url = `${SUPABASE.url}/rest/v1/${table}${query ? `?${query}` : ''}`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE.anonKey,
      Authorization: `Bearer ${session?.accessToken || SUPABASE.anonKey}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const err = new Error(`${table}: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const body = await res.json();
  return Array.isArray(body) ? body : [body];
}

const enc = encodeURIComponent;

/** Live API — identical method names to the mock adapter. */
export const liveApi = {
  profile: {
    async get() {
      const rows = await rest('profiles', `id=eq.${enc(session.userId)}&select=*`);
      return rows[0] || null;
    },
  },
  plans: {
    async list() {
      const rows = await rest('plans', 'select=*&order=priority_score.asc');
      return rows.map(normalisePlan);
    },
    async get(key) {
      const rows = await rest('plans', `key=eq.${enc(key)}&select=*`);
      return rows[0] ? normalisePlan(rows[0]) : null;
    },
  },
  subscription: {
    async get() {
      const rows = await rest('subscriptions', `user_id=eq.${enc(session.userId)}&select=*&order=created_at.desc&limit=1`);
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        plan_key: row.plan_id || row.plan_key || null,
        status: row.status,
        current_period_start: row.current_period_start || row.created_at,
        current_period_end: row.current_period_end || row.current_period_end_at,
        cancel_at_period_end: Boolean(row.cancel_at_period_end),
        provider: row.provider || 'stripe',
      };
    },
    async history() {
      const rows = await rest('subscriptions', `user_id=eq.${enc(session.userId)}&select=*&order=created_at.desc`);
      return rows;
    },
  },
  wallet: {
    async get() {
      const rows = await rest('wallets', `user_id=eq.${enc(session.userId)}&select=*&limit=1`);
      return rows[0] || null;
    },
    async transactions() {
      const rows = await rest('wallet_transactions', `user_id=eq.${enc(session.userId)}&select=*&order=created_at.desc&limit=25`);
      return rows;
    },
    async withdrawals() {
      const rows = await rest('withdrawal_requests', `user_id=eq.${enc(session.userId)}&select=*&order=created_at.desc&limit=25`);
      return rows;
    },
  },
  usage: {
    async today() {
      const since = new Date(Date.now() - 86400000).toISOString();
      let analyses = [];
      let signals = [];
      try {
        analyses = await rest('analysis_history', `user_id=eq.${enc(session.userId)}&created_at=gte.${enc(since)}&select=id`);
      } catch { analyses = []; }
      try {
        signals = await rest('strategy_signals', `user_id=eq.${enc(session.userId)}&created_at=gte.${enc(since)}&select=id`);
      } catch { signals = []; }
      return {
        analyses: analyses.length,
        signals: signals.length,
        charts: analyses.length,
        preferred_strategy: null,
        avg_confidence: null,
        auto_trading: false,
        copy_trading: 'Not Configured',
      };
    },
  },
  analysis: {
    async list({ limit = 20 } = {}) {
      const rows = await rest('analysis_history', `user_id=eq.${enc(session.userId)}&select=*&order=created_at.desc&limit=${limit}`);
      return rows;
    },
  },
  bots: {
    async list() {
      try {
        return await rest('cloud_bots', `user_id=eq.${enc(session.userId)}&select=*&order=created_at.desc`);
      } catch { return []; }
    },
    async trades() {
      try {
        return await rest('cloud_bot_trades', `user_id=eq.${enc(session.userId)}&select=*&order=created_at.desc&limit=50`);
      } catch { return []; }
    },
  },
  trades: {
    async list() {
      try {
        return await rest('trades', `user_id=eq.${enc(session.userId)}&select=*&order=opened_at.desc&limit=50`);
      } catch { return []; }
    },
  },
  strategies: {
    async list() {
      try {
        return await rest('strategies', `user_id=eq.${enc(session.userId)}&select=*&order=created_at.desc`);
      } catch { return []; }
    },
  },
  signals: {
    async list() {
      try {
        return await rest('strategy_signals', `user_id=eq.${enc(session.userId)}&select=*&order=created_at.desc&limit=25`);
      } catch { return []; }
    },
    async preferences() {
      try {
        const rows = await rest('pulse_signal_preferences', `user_id=eq.${enc(session.userId)}&select=*&limit=1`);
        return rows[0] || { email: true, push: true, in_app: true, symbols: [], interval: 'M15' };
      } catch {
        return { email: true, push: true, in_app: true, symbols: [], interval: 'M15' };
      }
    },
  },
  tutorials: {
    async list() {
      const rows = await rest('tutorials', 'select=*&is_published=eq.true&order=sort_order.asc');
      return rows;
    },
  },
  referrals: {
    async list() {
      try {
        return await rest('referrals', `referrer_id=eq.${enc(session.userId)}&select=*`);
      } catch { return []; }
    },
  },
  featureFlags: {
    async list() {
      try {
        return await rest('feature_flags', 'select=*');
      } catch { return []; }
    },
  },
  // No local catch here: data.js's proxy falls back to the mock rows when a
  // live call rejects, so a missing `eas` table degrades instead of blanking.
  ea: {
    async list() {
      return rest('eas', 'select=*&order=priority_score.desc');
    },
    async downloads() {
      return rest('ea_downloads', `user_id=eq.${enc(session.userId)}&select=*`);
    },
  },
  mt5: {
    async accounts() {
      try {
        return await rest('mt5_accounts', `user_id=eq.${enc(session.userId)}&select=*`);
      } catch { return []; }
    },
    async brokerSessions() {
      try {
        return await rest('custom_broker_sessions', `user_id=eq.${enc(session.userId)}&select=*`);
      } catch { return []; }
    },
  },
};

function normalisePlan(row) {
  return {
    ...row,
    price_cents: row.price_cents ?? 0,
    mt5_limit: row.mt5_limit ?? 1,
    daily_upload_limit: row.daily_upload_limit ?? 0,
    voice_limit: row.voice_limit ?? 0,
    ea_download_level: row.ea_download_level ?? 'none',
    auto_trading_allowed: Boolean(row.auto_trading_allowed),
    priority_score: row.priority_score ?? 0,
  };
}
