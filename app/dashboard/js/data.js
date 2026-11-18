/**
 * Data layer — two real sources, no demo rows, no generated values.
 *
 * With a session: every read goes to the signed-in account over PostgREST
 * (GET only, RLS enforced by Postgres).
 *
 * Without a session (local development): the desk runs against the local
 * market service on http://127.0.0.1:8788 and the public catalogue tables,
 * which are readable with the anon key alone. There is no local wallet, no
 * local subscription and no local EA catalogue, so those methods answer with
 * zeros and empty lists rather than invented rows — and `local: true` makes
 * that visible to the page.
 *
 * Column names, plan limits and table names mirror the production schema so a
 * page never learns where its data came from.
 */
import { liveApi, hasSession, setSession, loadStoredSession, clearSession, sessionInfo } from './supabase.js';

export { setSession, loadStoredSession, clearSession, sessionInfo, hasSession };

/* The desk identity shown before accounts exist. It is a label, not a user:
   `id` stays null so nothing can mistake it for an authenticated row. */
const LOCAL_PROFILE = Object.freeze({
  id: null,
  account_id: 'LOCAL-DESK',
  display_name: 'Local desk',
  email: null,
  referral_count: 0,
  local: true,
});

const noRows = async () => [];

const deskApi = {
  profile: { get: async () => LOCAL_PROFILE },

  /* Public catalogue: readable with the anon key, so it is read for real. */
  plans: liveApi.plans,
  tutorials: liveApi.tutorials,
  featureFlags: liveApi.featureFlags,

  /* Nothing is billed before accounts exist. */
  subscription: { get: async () => null, history: noRows },

  /* The desk account is the paper ledger; it holds no money. */
  wallet: {
    get: async () => ({
      available_cents: 0,
      pending_cents: 0,
      withdrawable_cents: 0,
      total_spent_cents: 0,
      is_frozen: false,
      currency: 'USD',
      local: true,
    }),
    transactions: noRows,
    withdrawals: noRows,
  },

  signals: {
    preferences: async () => ({ email: true, push: true, in_app: true, symbols: [], interval: 'M15' }),
    list: noRows,
  },

  analysis: { list: noRows },
  bots: { list: noRows, trades: noRows },
  trades: { list: noRows },
  strategies: { list: noRows },
  referrals: { list: noRows },
  ea: { list: noRows, downloads: noRows },
  mt5: { accounts: noRows, brokerSessions: noRows },
};

export const api = new Proxy({}, {
  get(_, group) {
    return hasSession() ? liveApi[group] : deskApi[group];
  },
});

/* ---------------------------------------------------------- permissions */

/** Mirrors the production RPC `get_user_permissions` / `can_user_perform_action`. */
export function permissionsFor(planKey, planList = []) {
  const plans = planList || [];
  const plan = plans.find((p) => p.key === planKey) || plans[0] || null;
  const key = plan ? plan.key : null;
  const unlimited = (n) => n === -1 || n >= 999999;
  return {
    planKey: key,
    planName: plan ? plan.name : 'No plan',
    active: Boolean(plan) && key !== 'basic',
    mt5Limit: plan ? plan.mt5_limit : 0,
    dailyUploadLimit: plan ? plan.daily_upload_limit : 0,
    voiceLimit: plan ? plan.voice_limit : 0,
    unlimitedVoice: plan ? unlimited(plan.voice_limit) : false,
    autoTrading: Boolean(plan && plan.auto_trading_allowed) && key === 'platinum',
    priorityScore: plan ? plan.priority_score : 0,
    tradeLens: key === 'platinum',
    manageBots: key === 'platinum',
    pulseSignals: Boolean(plan) && key !== 'basic',
    aiTrading: Boolean(plan) && key !== 'basic',
  };
}

export const fmt = {
  money(cents, currency = 'USD') {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2 }).format((cents || 0) / 100);
  },
  price(n) {
    if (n === null || n === undefined) return '—';
    const abs = Math.abs(n);
    const digits = abs >= 100 ? 2 : abs >= 10 ? 3 : 5;
    return Number(n).toFixed(digits);
  },
  date(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  },
  ago(iso) {
    const d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (d < 60) return 'just now';
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    return `${Math.floor(d / 86400)}d ago`;
  },
  limit(n) {
    return n === -1 ? 'Unlimited' : String(n);
  },
};
