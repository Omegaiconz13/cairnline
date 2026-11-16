/**
 * Data layer — Supabase-shaped API with a mock adapter.
 *
 * Every method mirrors the production schema (pipnex-ai.com, Supabase project
 * jwaplyyxkxfrhmbcycmc): column names, plan catalogue and plan limits come from
 * the live `plans` table, so swapping `mock` for a real `supabase-js` client is a
 * one-file change and the pages need no edits.
 */

const now = Date.now();
const days = (n) => new Date(now - n * 86400000).toISOString();

/* ------------------------------------------------------------------ mock */

const mock = {
  profile: {
    id: '8aa02895-8758-4628-bfe3-8ac80f03594c',
    display_name: 'Omega Iconz',
    first_name: 'Omega',
    last_name: 'Iconz',
    email: 'nandejeclinton@gmail.com',
    account_id: 'OME4770',
    plan_id: null,
    points: 0,
    country: 'Uganda',
    country_code: 'UG',
    is_on_trial: false,
    trial_started_at: days(263),
    active_session_id: '016d7756-1d28-4042-886b-a149f5dbea4b',
    last_active_at: new Date().toISOString(),
    email_preferences: { promotions: true, announcements: true, system_updates: true },
    created_at: days(263),
  },

  plans: [
    { key: 'basic', name: 'Basic', price_cents: 999, currency: 'USD', mt5_limit: 1, daily_upload_limit: 3, voice_limit: 0, ea_download_level: 'none', auto_trading_allowed: false, priority_score: 1, mobile_price_cents: 1499 },
    { key: 'pro', name: 'Pro', price_cents: 4999, currency: 'USD', mt5_limit: 3, daily_upload_limit: 12, voice_limit: 10, ea_download_level: 'site_brand', auto_trading_allowed: true, priority_score: 2, mobile_price_cents: 6999 },
    { key: 'ultimate', name: 'Ultimate', price_cents: 9999, currency: 'USD', mt5_limit: 5, daily_upload_limit: 24, voice_limit: 999999, ea_download_level: 'user_brand', auto_trading_allowed: true, priority_score: 10, mobile_price_cents: 14999 },
    { key: 'platinum', name: 'Platinum', price_cents: 29999, currency: 'USD', mt5_limit: -1, daily_upload_limit: -1, voice_limit: -1, ea_download_level: 'user_brand', auto_trading_allowed: true, priority_score: 100, mobile_price_cents: 39999 },
  ],

  subscription: {
    id: 'sub_demo_0001',
    plan_key: 'pro',
    status: 'active',
    current_period_start: days(11),
    current_period_end: days(19),
    cancel_at_period_end: false,
    provider: 'stripe',
  },

  wallets: {
    id: 'wal_demo_0001',
    user_id: '8aa02895-8758-4628-bfe3-8ac80f03594c',
    available_cents: 0,
    pending_cents: 0,
    reserved_cents: 0,
    withdrawable_cents: 0,
    total_deposited_cents: 0,
    total_withdrawn_cents: 0,
    total_spent_cents: 0,
    currency: 'USD',
    is_frozen: false,
  },

  usage_today: { analyses: 0, signals: 0, charts: 0, preferred_strategy: null, avg_confidence: null, auto_trading: false, copy_trading: 'Not Configured' },

  analysis_history: [
    { id: 'an_1', symbol: 'XAUUSD', interval: 'M15', bias: 'long', confidence: 87, entry: 3412.4, stop_loss: 3401.2, take_profit: 3448.9, created_at: days(1) },
    { id: 'an_2', symbol: 'EURUSD', interval: 'H1', bias: 'short', confidence: 74, entry: 1.0842, stop_loss: 1.0871, take_profit: 1.0784, created_at: days(2) },
    { id: 'an_3', symbol: 'GBPJPY', interval: 'M30', bias: 'long', confidence: 61, entry: 198.42, stop_loss: 197.85, take_profit: 199.7, created_at: days(4) },
    { id: 'an_4', symbol: 'USDJPY', interval: 'M5', bias: 'neutral', confidence: 48, entry: 151.22, stop_loss: 150.9, take_profit: 151.8, created_at: days(6) },
  ],

  cloud_bots: [],
  cloud_bot_trades: [],

  trades: [
    { id: 'tr_1', symbol: 'XAUUSD', side: 'long', qty: 0.5, price: 3408.1, pnl: 42.6, status: 'closed', opened_at: days(3), closed_at: days(3) },
    { id: 'tr_2', symbol: 'EURUSD', side: 'short', qty: 1.0, price: 1.0864, pnl: -12.3, status: 'closed', opened_at: days(9), closed_at: days(9) },
    { id: 'tr_3', symbol: 'GBPUSD', side: 'long', qty: 0.8, price: 1.2712, pnl: 0, status: 'open', opened_at: days(0), closed_at: null },
  ],

  strategies: [
    { id: 'st_1', name: 'SMC London Breakout', symbol: 'XAUUSD', status: 'draft', win_rate: null, created_at: days(5) },
    { id: 'st_2', name: 'Asia Range Reversal', symbol: 'EURUSD', status: 'backtesting', win_rate: 58.4, created_at: days(12) },
  ],

  pulse_signal_preferences: { email: true, push: true, in_app: true, symbols: ['XAUUSD', 'EURUSD'], interval: 'M15' },

  // Deliberately empty: signals are computed live from real bars by the
  // market service (see js/market.js basketSignals), never replayed as stored
  // demo rows. In live mode this reads strategy_signal_deliveries instead.
  signals: [],

  wallet_transactions: [
    { id: 'wt_1', kind: 'deposit', amount_cents: 5000, status: 'settled', created_at: days(14) },
    { id: 'wt_2', kind: 'spend', amount_cents: -1200, status: 'settled', created_at: days(10) },
    { id: 'wt_3', kind: 'deposit', amount_cents: 2500, status: 'settled', created_at: days(6) },
  ],

  withdrawal_requests: [],

  tutorials: [
    { id: 't1', title: 'PIPNEX AI - Official Platform Introduction | Getting Started', slug: 'official-introduction', youtube_id: '_JOyWOaFXgE', category: 'Getting Started', duration_label: '0.46s', sort_order: 1, is_published: true },
    { id: 't2', title: 'PIPNEX AI - How to Create Your Account | Sign Up', slug: 'create-account', youtube_id: 'AHuqLWjXePE', category: 'Getting Started', duration_label: '0.50s', sort_order: 2, is_published: true },
    { id: 't3', title: 'PIPNEX AI - How to Sign In | Access Your Account', slug: 'sign-in', youtube_id: 'fO_iEGZ2Bf0', category: 'Getting Started', duration_label: '0.37s', sort_order: 3, is_published: true },
    { id: 't4', title: 'PIPNEX AI - Signal of the Day | AI-Powered Trading Setups', slug: 'signal-of-the-day', youtube_id: 'wiBbXjG_QFc', category: 'Signal Of The Day', duration_label: '0.42s', sort_order: 4, is_published: true },
    { id: 't5', title: 'PIPNEX AI - AI Trading | AI-Powered Market Analysis & Execution', slug: 'ai-trading', youtube_id: 'rmE6hfg4mes', category: 'AI Trading', duration_label: '1.48s', sort_order: 13, is_published: true },
    { id: 't6', title: 'PIPNEX AI - Upload Chart | AI Pattern Recognition', slug: 'upload-chart', youtube_id: 'wFsW1nWL5Mk', category: 'Upload Chart', duration_label: '0.58s', sort_order: 6, is_published: true },
  ],

  referrals: [],

  feature_flags: [
    { feature_key: 'voice_ai_interaction', display_name: 'Voice-based AI Interaction', enabled: true },
    { feature_key: 'auto_trading', display_name: 'Auto Trading', enabled: true },
    { feature_key: 'trade_lens', display_name: 'Pipnex Trade Lens', enabled: true },
  ],

  mt5_accounts: [],
  custom_broker_sessions: [],
};

/* ------------------------------------------------------------------ api */

const delay = (ms = 140) => new Promise((r) => setTimeout(r, ms));
const clone = (v) => JSON.parse(JSON.stringify(v));

const mockApi = {
  profile: {
    async get() { await delay(); return clone(mock.profile); },
  },
  plans: {
    async list() { await delay(); return clone(mock.plans); },
    async get(key) { await delay(); return clone(mock.plans.find((p) => p.key === key) || null); },
  },
  subscription: {
    async get() { await delay(); return clone(mock.subscription); },
    async history() { await delay(); return clone([mock.subscription]); },
  },
  wallet: {
    async get() { await delay(); return clone(mock.wallets); },
    async transactions() { await delay(); return clone(mock.wallet_transactions); },
    async withdrawals() { await delay(); return clone(mock.withdrawal_requests); },
  },
  usage: {
    async today() { await delay(); return clone(mock.usage_today); },
  },
  analysis: {
    async list({ limit = 20 } = {}) { await delay(); return clone(mock.analysis_history.slice(0, limit)); },
  },
  bots: {
    async list() { await delay(); return clone(mock.cloud_bots); },
    async trades() { await delay(); return clone(mock.cloud_bot_trades); },
  },
  trades: {
    async list() { await delay(); return clone(mock.trades); },
  },
  strategies: {
    async list() { await delay(); return clone(mock.strategies); },
  },
  signals: {
    async list() { await delay(); return clone(mock.signals); },
    async preferences() { await delay(); return clone(mock.pulse_signal_preferences); },
  },
  tutorials: {
    async list() { await delay(); return clone(mock.tutorials); },
  },
  referrals: {
    async list() { await delay(); return clone(mock.referrals); },
  },
  featureFlags: {
    async list() { await delay(); return clone(mock.feature_flags); },
  },
  mt5: {
    async accounts() { await delay(); return clone(mock.mt5_accounts); },
    async brokerSessions() { await delay(); return clone(mock.custom_broker_sessions); },
  },
};

/* ------------------------------------------------------- mode switching */

/**
 * `api` delegates to the live Supabase adapter when a session is present and
 * the user switched to Live, otherwise to the mock. Every live call falls back
 * to mock data on error so one failing table never blanks a page.
 */
import { liveApi, hasSession, setSession, loadStoredSession, clearSession, sessionInfo } from './supabase.js';

const mode = { current: 'mock' };

export function getMode() { return mode.current; }
export function setMode(next) { mode.current = next === 'live' && hasSession() ? 'live' : 'mock'; }
export { setSession, loadStoredSession, clearSession, sessionInfo, hasSession };

const active = () => (mode.current === 'live' && hasSession() ? liveApi : mockApi);

export const api = new Proxy({}, {
  get(_, group) {
    return new Proxy({}, {
      get(_, method) {
        const source = active();
        const live = source[group] && source[group][method];
        const fallback = mockApi[group] && mockApi[group][method];
        if (mode.current === 'live' && hasSession() && typeof live === 'function') {
          return (...args) => live(...args).catch(() => (typeof fallback === 'function' ? fallback(...args) : undefined));
        }
        return typeof live === 'function' ? live.bind(source[group]) : live;
      },
    });
  },
});

/* ---------------------------------------------------------- permissions */

/** Mirrors the production RPC `get_user_permissions` / `can_user_perform_action`. */
export function permissionsFor(planKey, planList) {
  const plans = planList || mock.plans;
  const plan = plans.find((p) => p.key === planKey) || plans[0];
  const key = plan ? plan.key : 'basic';
  const unlimited = (n) => n === -1 || n >= 999999;
  return {
    planKey: key,
    planName: plan ? plan.name : 'No plan',
    active: key !== 'basic',
    mt5Limit: plan ? plan.mt5_limit : 1,
    dailyUploadLimit: plan ? plan.daily_upload_limit : 3,
    voiceLimit: plan ? plan.voice_limit : 0,
    unlimitedVoice: plan ? unlimited(plan.voice_limit) : false,
    autoTrading: Boolean(plan && plan.auto_trading_allowed) && key === 'platinum',
    priorityScore: plan ? plan.priority_score : 0,
    tradeLens: key === 'platinum',
    manageBots: key === 'platinum',
    pulseSignals: key !== 'basic',
    aiTrading: key !== 'basic',
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
