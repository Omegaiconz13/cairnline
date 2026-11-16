/**
 * Data layer — live, read-only Supabase adapter only.
 *
 * There are no demo rows and no generated values anywhere in this layer: every
 * number on screen comes from the signed-in account over PostgREST (GET only,
 * RLS enforced by Postgres) or it is absent. When no session is connected the
 * `api` methods reject with `code: 'NO_ACCOUNT'` and the page shows what it is
 * missing instead of inventing it.
 *
 * Column names, plan limits and table names mirror the production schema so a
 * page never learns where its data came from.
 */
import { liveApi, hasSession, setSession, loadStoredSession, clearSession, sessionInfo } from './supabase.js';

export { setSession, loadStoredSession, clearSession, sessionInfo, hasSession };

export const NO_ACCOUNT = 'NO_ACCOUNT';

/** True when a call failed for lack of a session rather than a real error. */
export const isNoAccount = (err) => Boolean(err && err.code === NO_ACCOUNT);

export const api = new Proxy({}, {
  get(_, group) {
    return new Proxy({}, {
      get(_, method) {
        const fn = liveApi[group] && liveApi[group][method];
        if (typeof fn !== 'function') return undefined;
        return (...args) => {
          if (!hasSession()) {
            const err = new Error('No account connected');
            err.code = NO_ACCOUNT;
            return Promise.reject(err);
          }
          return fn.apply(liveApi[group], args);
        };
      },
    });
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
