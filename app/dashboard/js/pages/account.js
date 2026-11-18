import { api, fmt, setSession, clearSession, hasSession, sessionInfo } from '../data.js';
import { el, card, chip, table, switchRow, toast, field, notConnected } from '../ui.js';
import { market } from '../market.js';

/** Subscription — production /subscription. */
export async function subscription(ctx) {
  let plans = []; let sub = null; let history = [];
  try {
    [plans, sub, history] = await Promise.all([api.plans.list(), api.subscription.get(), api.subscription.history()]);
  } catch {
    return el('div', { class: 'page' },
      card('Subscription', { note: 'nothing to read' }, notConnected('Your plan, limits and billing history')));
  }
  const active = sub || { plan_key: null, status: 'none', current_period_start: null, current_period_end: null, cancel_at_period_end: false };
  const current = plans.find((p) => p.key === active.plan_key);

  const planCard = (p) => {
    const isCurrent = p.key === active.plan_key;
    const features = [
      `${p.mt5_limit === -1 ? 'Unlimited' : p.mt5_limit} MT5 account${p.mt5_limit === 1 ? '' : 's'}`,
      `${p.daily_upload_limit === -1 ? 'Unlimited' : p.daily_upload_limit} chart uploads / day`,
      p.voice_limit === -1 || p.voice_limit >= 999999 ? 'Unlimited voice requests' : `${p.voice_limit} voice requests / day`,
      p.auto_trading_allowed ? 'Auto trading & cloud bots' : 'AI analysis only',
      `${p.ea_download_level === 'user_brand' ? 'User-branded' : p.ea_download_level === 'site_brand' ? 'Site-branded' : 'No'} EA download`,
    ];
    return el('article', { class: `plan ${isCurrent ? 'is-current' : ''}` },
      el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:10px' },
        el('h3', { text: p.name }),
        isCurrent ? chip('Current plan', 'chip--on') : chip(`Priority ${p.priority_score}`, '')),
      el('div', { class: 'plan__price' }, `${fmt.money(p.price_cents)}`, el('small', { text: ' /month' })),
      el('ul', { class: 'plan__list' }, features.map((f) => el('li', { text: f }))),
      el('a', { class: `btn ${isCurrent ? 'btn--outline' : 'btn--primary'} btn--block`, href: isCurrent ? '#/subscription' : '#/choose-plan' },
        isCurrent ? 'Manage plan' : `Select ${p.name}`));
  };

  const page = el('div', { class: 'page' });
  page.append(
    el('div', { class: 'page__head' },
      el('div', {},
        el('h2', { class: 'page__title', text: 'Subscription Management' }),
        el('p', { class: 'page__sub', text: 'Upgrade, downgrade or export your billing history.' })),
      el('div', { style: 'display:flex;gap:8px' },
        el('button', { class: 'btn btn--outline btn--sm', onclick: () => toast('Invoice export queued (PDF)') }, 'Export PDF'),
        el('a', { class: 'btn btn--primary btn--sm', href: '#/choose-plan' }, 'Upgrade Plan'))),
    el('div', { class: 'grid grid--sidebar' },
      el('div', { class: 'grid grid--2' }, plans.map(planCard)),
      el('div', { class: 'grid' },
        card('Current plan', {},
          el('dl', { class: 'kv' },
            el('dt', { text: 'Plan' }), el('dd', { text: current ? current.name : 'No active plan' }),
            el('dt', { text: 'Status' }), el('dd', { text: active.status }),
            el('dt', { text: 'Period start' }), el('dd', { text: fmt.date(active.current_period_start) }),
            el('dt', { text: 'Renews' }), el('dd', { text: fmt.date(active.current_period_end) }),
            el('dt', { text: 'Auto-renew' }), el('dd', { text: active.cancel_at_period_end ? 'Off' : 'On' })),
          el('div', { style: 'margin-top:18px' },
            el('button', { class: 'btn btn--outline btn--block', onclick: () => toast('Plan change flow opens at checkout') }, 'Change Plan')),
          el('div', { style: 'margin-top:10px' },
            el('button', { class: 'btn btn--ghost btn--block', onclick: () => toast('Auto-renew updated') },
              active.cancel_at_period_end ? 'Resume auto-renew' : 'Cancel auto-renew'))),
        card('Subscription history', {},
          table([
            { label: 'Plan', render: (r) => (plans.find((p) => p.key === r.plan_key) || {}).name || r.plan_key },
            { label: 'Status', render: (r) => chip(r.status, r.status === 'active' ? 'chip--on' : '') },
            { label: 'Started', render: (r) => fmt.date(r.current_period_start) },
            { label: 'Ends', render: (r) => fmt.date(r.current_period_end) },
          ], history)))));
  return page;
}

/** Wallet — production /wallet. */
export async function wallet(ctx) {
  let raw = null; let txnsRaw = []; let withdrawalsRaw = [];
  try {
    [raw, txnsRaw, withdrawalsRaw] = await Promise.all([api.wallet.get(), api.wallet.transactions(), api.wallet.withdrawals()]);
  } catch {
    return el('div', { class: 'page' },
      card('Wallet', { note: 'nothing to read' }, notConnected('Your balance, transactions and withdrawals')));
  }
  const w = raw || { available_cents: 0, pending_cents: 0, withdrawable_cents: 0, total_spent_cents: 0, is_frozen: false, currency: 'USD' };
  const txns = txnsRaw || [];
  const withdrawals = withdrawalsRaw || [];
  const note = el('p', { class: 'form__note' });

  const page = el('div', { class: 'page' });
  const withdrawalsCard = withdrawals.length
    ? card('Withdrawals', {}, table([
        { label: 'Amount', num: true, render: (r) => fmt.money(r.amount_cents) },
        { label: 'Status', render: (r) => chip(r.status, r.status === 'paid' ? 'chip--on' : 'chip--warn') },
        { label: 'When', render: (r) => fmt.ago(r.created_at) },
      ], withdrawals))
    : null;

  page.append(
    el('div', { class: 'page__head' },
      el('div', {},
        el('h2', { class: 'page__title', text: 'Cairnline Wallet' }),
        el('p', { class: 'page__sub', text: raw && raw.local
          ? 'No wallet is connected before accounts exist: the desk trades a paper ledger, so every balance here is zero.'
          : 'AI credits, deposits and withdrawals.' })),
      chip(w.is_frozen ? 'Frozen' : 'Active', w.is_frozen ? 'chip--danger' : 'chip--on')),
    el('div', { class: 'grid grid--4' },
      el('div', { class: 'stat' }, el('small', { text: 'Available' }), el('b', { text: fmt.money(w.available_cents) }), el('span', { text: 'ready to spend' })),
      el('div', { class: 'stat' }, el('small', { text: 'Pending' }), el('b', { text: fmt.money(w.pending_cents) }), el('span', { text: 'processing' })),
      el('div', { class: 'stat' }, el('small', { text: 'Withdrawable' }), el('b', { text: fmt.money(w.withdrawable_cents) }), el('span', { text: 'min $75.00' })),
      el('div', { class: 'stat' }, el('small', { text: 'Total spent' }), el('b', { text: fmt.money(w.total_spent_cents) }), el('span', { text: 'lifetime' }))));

  page.append(el('div', { class: 'grid grid--sidebar' },
    card('Transactions', { note: `${txns.length} entries` },
      table([
        { label: 'Type', render: (r) => chip(r.kind, r.kind === 'deposit' ? 'chip--on' : '') },
        { label: 'Amount', num: true, render: (r) => `<span class="${r.amount_cents >= 0 ? 'pos' : 'neg'}">${r.amount_cents >= 0 ? '+' : ''}${fmt.money(r.amount_cents)}</span>` },
        { label: 'Status', render: (r) => chip(r.status, r.status === 'settled' ? 'chip--on' : 'chip--warn') },
        { label: 'When', render: (r) => fmt.ago(r.created_at) },
      ], txns, { emptyTitle: 'No transactions yet', emptyText: 'Deposits and AI credit purchases appear here.' })),
    card('Add money / Withdraw', {},
      el('p', { class: 'card__note', text: 'Movements are not wired in this build: deposits, withdrawals and transfers need the production Stripe flow, and this client is read-only. The balances above are whatever your wallet row holds.' }),
      el('div', { style: 'margin-top:18px;padding-top:14px;border-top:1px solid var(--line-soft)' },
        el('h3', { class: 'card__title', text: 'Frequently Asked Questions' }),
        el('dl', { class: 'kv', style: 'margin-top:12px' },
          el('dt', { text: 'Minimum withdrawal' }), el('dd', { text: '$75.00' }),
          el('dt', { text: 'Payout time' }), el('dd', { text: '2–5 business days' }),
          el('dt', { text: 'Currency' }), el('dd', { text: w.currency })))),
    withdrawalsCard));
  return page;
}

/** Settings — production /dashboard/settings. */
export async function settings(ctx) {
  const profile = await api.profile.get().catch(() => null);
  const note = el('p', { class: 'form__note' });
  const nameInput = el('input', { type: 'text', value: profile ? profile.display_name || '' : '', placeholder: 'Display name' });
  const emailInput = el('input', { type: 'email', value: profile ? profile.email || '' : '', placeholder: 'Email', readonly: true });

  /* ---- data source: the one read-only account connection ---- */
  const dsNote = el('p', { class: 'form__note' });
  const tokenInput = el('textarea', {
    rows: '3',
    placeholder: 'Paste the access token, or the whole sb-…-auth-token JSON',
    style: 'font-family:var(--mono);font-size:12px',
  });
  const liveState = el('div', { class: 'factgrid', style: 'margin-top:12px' });

  const paintLiveState = () => {
    liveState.innerHTML = '';
    const info = sessionInfo();
    const live = hasSession();
    liveState.append(
      el('div', { class: 'fact' }, el('small', { text: 'STATUS' }), el('b', { class: live ? 'on' : '', text: live ? 'CONNECTED' : 'LOCAL DESK' })),
      el('div', { class: 'fact' }, el('small', { text: 'ACCOUNT' }), el('b', { text: live ? (info && (info.email || 'signed in')) || 'signed in' : 'paper ledger' })),
      el('div', { class: 'fact' }, el('small', { text: 'USER ID' }), el('b', { text: live && info && info.userId ? info.userId.slice(0, 8) : '—' })));
  };
  paintLiveState();
  /* ---- Trish provider ---- */
  const TRISH_PRESETS = {
    openrouter: { url: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-3.5-sonnet' },
    openai: { url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    ollama: { url: 'http://127.0.0.1:11434/v1', model: 'llama3.1' },
    hermes: { url: 'http://127.0.0.1:8642/v1', model: 'hermes-agent' },
  };
  const TRISH_DOTS = '••••••••••••';
  const trishNote = el('p', { class: 'form__note' });
  const trishFacts = el('div', { class: 'factgrid', style: 'margin-top:12px' });
  const trishBackend = el('select', {},
    el('option', { value: 'direct', text: 'Direct (this app runs the tools)' }),
    el('option', { value: 'hermes', text: 'Hermes gateway (skills + memory)' }));
  const trishBase = el('input', { type: 'text', placeholder: 'https://openrouter.ai/api/v1' });
  const trishModel = el('input', { type: 'text', placeholder: 'anthropic/claude-3.5-sonnet' });
  const trishKey = el('input', { type: 'password', placeholder: 'sk-…', autocomplete: 'off', spellcheck: 'false' });
  trishKey.addEventListener('focus', () => { if (trishKey.value === TRISH_DOTS) trishKey.value = ''; });
  trishKey.addEventListener('blur', () => { if (!trishKey.value && trishKey.dataset.stored === '1') trishKey.value = TRISH_DOTS; });

  const paintTrish = (t) => {
    trishFacts.innerHTML = '';
    const on = Boolean(t && t.configured);
    trishKey.dataset.stored = t && t.has_key ? '1' : '0';
    if (t && t.has_key && !trishKey.value) trishKey.value = TRISH_DOTS;
    if (t && t.backend) trishBackend.value = t.backend;
    if (t && t.base_url) trishBase.value = t.base_url;
    if (t && t.model) trishModel.value = t.model;
    trishFacts.append(
      el('div', { class: 'fact' }, el('small', { text: 'STATE' }), el('b', { class: on ? 'on' : 'off', text: on ? 'READY' : 'NOT SET' })),
      el('div', { class: 'fact' }, el('small', { text: 'BACKEND' }), el('b', { text: t && t.backend ? t.backend : 'direct' })),
      el('div', { class: 'fact' }, el('small', { text: 'KEY' }), el('b', { class: t && t.has_key ? 'on' : 'off', text: t && t.has_key ? (t.key_hint || 'SET') : 'NONE' })));
  };
  market.trishConfig().then((c) => paintTrish(c.trish)).catch(() => paintTrish(null));

  const saveTrish = async () => {
    const payload = {
      backend: trishBackend.value,
      base_url: trishBase.value.trim(),
      model: trishModel.value.trim(),
    };
    if (trishKey.value && trishKey.value !== TRISH_DOTS) payload.api_key = trishKey.value.trim();
    if (!payload.base_url) {
      trishNote.textContent = 'Base URL is required.';
      trishNote.className = 'form__note is-bad';
      return;
    }
    try {
      const res = await market.setTrishConfig(payload);
      trishKey.value = TRISH_DOTS;
      paintTrish(res.trish);
      trishNote.textContent = 'Saved. Trish is ready in AI Trading.';
      trishNote.className = 'form__note is-ok';
      toast('Trish provider saved');
    } catch (err) {
      trishNote.textContent = `Not saved: ${String(err.message || err).slice(0, 160)}`;
      trishNote.className = 'form__note is-bad';
    }
  };

  const testTrish = async () => {
    trishNote.textContent = 'Asking Trish…';
    trishNote.className = 'form__note';
    try {
      const res = await market.trishChat([{ role: 'user', content: 'Reply with exactly: ready' }], {});
      trishNote.textContent = `Working — model replied: ${String(res.reply || '').slice(0, 80) || '(empty)'}`;
      trishNote.className = 'form__note is-ok';
    } catch (err) {
      trishNote.textContent = `Failed: ${String(err.message || err).slice(0, 200)}`;
      trishNote.className = 'form__note is-bad';
    }
  };

  const removeTrish = async () => {
    try {
      const res = await market.clearTrish();
      trishKey.value = '';
      paintTrish(res.trish);
      trishNote.textContent = 'Provider removed.';
      trishNote.className = 'form__note is-ok';
    } catch (err) {
      trishNote.textContent = String(err.message || err).slice(0, 160);
      trishNote.className = 'form__note is-bad';
    }
  };


  const marketStatus = el('div', { class: 'factgrid', style: 'margin-top:12px' });
  market.health().then((h) => {
    marketStatus.innerHTML = '';
    const p = h.providers || {};
    marketStatus.append(
      el('div', { class: 'fact' }, el('small', { text: 'YFINANCE' }), el('b', { class: p.yfinance ? 'on' : 'off', text: p.yfinance ? 'READY' : 'NO' })),
      el('div', { class: 'fact' }, el('small', { text: 'PINETS' }), el('b', { class: p.pinets ? 'on' : 'off', text: p.pinets ? 'READY' : 'NO' })),
      el('div', { class: 'fact' }, el('small', { text: 'LSE KEY' }),
        el('b', { class: p.lse ? 'on' : p.lse_configured ? '' : 'off',
          text: p.lse ? 'ACTIVE' : p.lse_configured ? 'INVALID' : 'NONE' })));
  }).catch(() => {
    marketStatus.append(el('div', { class: 'fact' }, el('small', { text: 'MARKET SERVICE' }),
      el('b', { class: 'off', text: 'OFFLINE' })));
  });

  /* ---- providers: LSE Data 3.0 primary, yfinance fallback ---- */
  const lseNote = el('p', { class: 'form__note' });
  const DOTS = '••••••••••••••••••••';
  const lseKeyInput = el('input', {
    type: 'password',
    placeholder: 'lse_live_…',
    autocomplete: 'off',
    spellcheck: 'false',
    style: 'font-family:var(--mono);font-size:12px',
  });
  // A stored key shows as filled dots; focusing clears them so a new key can be typed.
  lseKeyInput.addEventListener('focus', () => {
    if (lseKeyInput.value === DOTS) lseKeyInput.value = '';
  });
  lseKeyInput.addEventListener('blur', () => {
    if (!lseKeyInput.value && lseKeyInput.dataset.stored === '1') lseKeyInput.value = DOTS;
  });
  const lseFacts = el('div', { class: 'factgrid', style: 'margin-top:12px' });

  const paintLse = (st) => {
    lseFacts.innerHTML = '';
    const configured = Boolean(st && st.configured);
    lseKeyInput.dataset.stored = configured ? '1' : '0';
    if (configured && !lseKeyInput.value) lseKeyInput.value = DOTS;
    if (!configured && lseKeyInput.value === DOTS) lseKeyInput.value = '';
    const ok = Boolean(st && st.ok);
    lseFacts.append(
      el('div', { class: 'fact' }, el('small', { text: 'PRIMARY' }),
        el('b', { class: configured && ok ? 'on' : 'off', text: configured && ok ? 'LSE DATA' : 'YFINANCE' })),
      el('div', { class: 'fact' }, el('small', { text: 'LSE KEY' }),
        el('b', { class: configured ? 'on' : 'off', text: configured ? (st.key_hint || 'SET') : 'NONE' })),
      el('div', { class: 'fact' }, el('small', { text: 'PLAN' }),
        el('b', { text: st && st.plan ? String(st.plan).toUpperCase() : '—' })),
      el('div', { class: 'fact' }, el('small', { text: 'CALLS / MIN' }),
        el('b', { text: st && st.calls_per_minute ? String(st.calls_per_minute) : '—' })));
    if (st && st.weekly && st.weekly.allowance_bytes > 0) {
      const used = (st.weekly.used_bytes || 0) / 1e9;
      const cap = st.weekly.allowance_bytes / 1e9;
      lseFacts.append(el('div', { class: 'fact' }, el('small', { text: 'WEEKLY' }),
        el('b', { text: `${used.toFixed(2)} / ${cap.toFixed(1)} GB` })));
    }
    if (st && st.withheld) {
      lseNote.textContent = `Key withheld: ${st.withheld}`;
      lseNote.className = 'form__note is-bad';
    } else if (st && st.error) {
      lseNote.textContent = `Key rejected: ${st.error}`;
      lseNote.className = 'form__note is-bad';
    }
  };

  const refreshLse = () => market.config()
    .then((c) => paintLse(c.lse))
    .catch(() => paintLse(null));
  refreshLse();

  const saveLse = async () => {
    const key = lseKeyInput.value.trim();
    if (!key || key === DOTS) {
      lseNote.textContent = 'Paste a key first.';
      lseNote.className = 'form__note is-bad';
      return;
    }
    lseNote.textContent = 'Validating with LSE…';
    lseNote.className = 'form__note';
    try {
      const res = await market.setLseKey(key);
      lseKeyInput.value = DOTS;
      paintLse(res.lse);
      lseNote.textContent = `Saved. LSE Data is now the primary provider (plan: ${res.plan || 'unknown'}).`;
      lseNote.className = 'form__note is-ok';
      toast('LSE key saved — LSE Data is now primary');
    } catch (err) {
      lseNote.textContent = `Not saved: ${String(err.message || err).slice(0, 160)}`;
      lseNote.className = 'form__note is-bad';
    }
  };

  const removeLse = async () => {
    try {
      const res = await market.clearLseKey();
      lseKeyInput.value = '';
      paintLse(res.lse);
      lseNote.textContent = 'Key removed — yfinance is the provider again.';
      lseNote.className = 'form__note is-ok';
      toast('LSE key removed');
    } catch (err) {
      lseNote.textContent = `Could not remove: ${String(err.message || err).slice(0, 160)}`;
      lseNote.className = 'form__note is-bad';
    }
  };

  const marketCard = card('Market data providers', {},
    el('p', { class: 'card__note', text: 'Bars and quotes come from LSE Data 3.0 when a key is set, and fall back to yfinance automatically. Indicators are PineTS running real Pine Script; the public record is LuxAlgo market-trackers-data (CC0).' }),
    el('div', { style: 'margin-top:14px;display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end' },
      el('label', { class: 'field', style: 'flex:1;min-width:240px' },
        el('span', { text: 'LSE Data API key' }), lseKeyInput),
      el('button', { class: 'btn btn--primary btn--sm', onclick: saveLse }, 'Save key'),
      el('button', { class: 'btn btn--outline btn--sm', onclick: removeLse }, 'Remove')),
    el('p', { class: 'card__note', style: 'margin-top:8px', text: 'The key is validated against LSE, then stored server-side in server/config.json (mode 600) — it is never embedded in a page or returned by any request. Get one free at londonstrategicedge.com.' }),
    lseNote,
    lseFacts,
    el('div', { style: 'margin-top:14px' },
      el('button', { class: 'btn btn--outline btn--sm', onclick: () => market.health().then(() => toast('Market service reachable')).catch(() => toast('Market service offline — run python3 server/market_service.py')) }, 'Check service')),
    marketStatus,
    el('p', { class: 'form__note', style: 'margin-top:10px', text: `Endpoint: ${market.base}` }));

  const dataSource = card('Account connection', { note: 'read-only' },
    el('p', { class: 'card__note', text: 'Every row on these pages comes from your own account in the Cairnline Supabase project through PostgREST — reads only, never writes. There is no demo data: without a session the pages say what is missing.' }),
    el('div', { style: 'margin-top:16px' },
      field('Session token', tokenInput),
      el('div', { style: 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap' },
        el('button', { class: 'btn btn--primary btn--sm', onclick: () => {
          const session = setSession(tokenInput.value);
          if (!session) {
            dsNote.textContent = 'That token could not be read.';
            dsNote.className = 'form__note is-bad';
            return;
          }
          paintLiveState();
          dsNote.textContent = `Signed in as ${session.email || session.userId}. Loading your rows…`;
          dsNote.className = 'form__note is-ok';
          setTimeout(() => location.reload(), 700);
        } }, 'Connect'),
        el('button', { class: 'btn btn--outline btn--sm', onclick: () => {
          clearSession();
          tokenInput.value = '';
          paintLiveState();
          dsNote.textContent = 'Session cleared. Pages will show what they cannot read.';
          dsNote.className = 'form__note';
        } }, 'Disconnect')),
      liveState,
      dsNote));

  /* ---- signal delivery preferences (moved here from Pulse Signals) ---- */
  const prefs = await api.signals.preferences().catch(() => null);
  const deliveryCard = card('Signal delivery', {},
    prefs ? el('div', {},
      switchRow('In-app alerts', 'Show signals inside Cairnline', prefs.in_app, (v) => toast(`In-app alerts ${v ? 'on' : 'off'}`)),
      switchRow('Browser push', 'Push notifications in this browser', prefs.push, (v) => toast(`Browser push ${v ? 'on' : 'off'}`)),
      switchRow('Email', 'Send a copy to your email', prefs.email, (v) => toast(`Email delivery ${v ? 'on' : 'off'}`)),
      el('div', { style: 'margin-top:16px' },
        el('label', { class: 'field' }, el('span', { text: 'Symbols' }),
          el('input', { value: prefs.symbols.join(', '), onchange: () => toast('Symbol watchlist saved') }))))
      : notConnected('Signal delivery preferences'));

  /* ---- Trish engine: the project-owned Hermes runtime ---- */
  const evoFacts = el('div', { class: 'factgrid', style: 'margin-top:12px' });
  const evoWarn = el('p', { class: 'form__note is-bad', style: 'display:none' });
  const evoNote = el('p', { class: 'form__note' });
  const evoProvider = el('select', {}, ['custom', 'openai', 'anthropic', 'openrouter', 'llamacpp', 'ollama']
    .map((v) => el('option', { value: v, text: v })));
  const evoModel = el('input', { type: 'text', placeholder: 'hermes-agent / model id' });
  const evoBase = el('input', { type: 'text', placeholder: 'http://127.0.0.1:11434/v1' });
  const evoCtx = el('input', { type: 'number', placeholder: 'e.g. 200000', min: '1000' });
  const evoKey = el('input', { type: 'password', placeholder: 'provider key', autocomplete: 'off' });
  const learningBox = el('div', { style: 'margin-top:6px' });
  const pendingBox = el('div', { style: 'margin-top:6px' });
  const memoryBox = el('div', { style: 'margin-top:6px' });
  const journeyBox = el('div', { style: 'margin-top:6px' });
  const memEditors = {};

  const pill = (label, value, on) => el('div', { class: 'fact' },
    el('small', { text: label }),
    el('b', { class: on === undefined ? '' : (on ? 'on' : 'off'), text: String(value) }));

  const paintEvolution = (s) => {
    if (!s) {
      evoFacts.replaceChildren(pill('ENGINE', 'not installed', false));
      return;
    }
    const g = s.gateway || {};
    evoFacts.replaceChildren(
      pill('ENGINE', s.installed ? `hermes ${s.revision || ''}`.trim() : 'not installed', s.installed),
      pill('GATEWAY', g.up ? `running · pid ${g.pid}` : 'stopped', Boolean(g.up)),
      pill('PROVIDER', (s.provider && s.provider.fake_model) ? 'DEV fake :8801'
        : ((s.model && s.model.provider) || '—'), !(s.provider && s.provider.fake_model)),
      pill('MODEL', s.model && s.model.model ? `${s.model.model}` : 'not set', Boolean(s.model && s.model.model)),
      pill('SKILLS', `${s.skills.count} in catalogue`, s.skills.count > 0),
      pill('MCP', s.mcp && s.mcp.registered ? `${s.mcp.server} · ${s.mcp.tools} tools` : 'not wired', Boolean(s.mcp && s.mcp.registered)),
      pill('PENDING', String(s.pending), s.pending === 0),
      pill('TOOLSETS', `${s.toolsets_enabled} on · ${s.deferred_toolsets} deferred`, s.toolsets_enabled > 0),
      pill('PROFILE', s.profile, true));
    const pv = s.provider || {};
    if (pv.warning) {
      evoWarn.textContent = pv.warning;
      evoWarn.style.display = 'block';
    } else {
      evoWarn.textContent = '';
      evoWarn.style.display = 'none';
    }
    if (document.activeElement !== evoModel && s.model) evoModel.value = s.model.model || '';
    if (document.activeElement !== evoBase && s.model) evoBase.value = s.model.base_url || '';
    if (document.activeElement !== evoProvider && s.model && s.model.provider) evoProvider.value = s.model.provider;

    const toggles = [
      ['skills_write_approval', 'Skills: every write waits for you', 'A patch can change how she sizes a trade, so it never lands unread.'],
      ['memory_write_approval', 'Memory: every write waits for you', 'MEMORY.md and USER.md stay yours to approve.'],
      ['suggest_after_turn', 'Propose skills after a turn', 'The review pass runs behind the reply; it can only propose.'],
    ];
    learningBox.replaceChildren(...toggles.map(([key, label, hint]) => el('label', {
      class: 'switch',
      style: 'display:flex;align-items:flex-start;gap:10px;margin-bottom:12px;cursor:pointer',
    },
      el('input', {
        type: 'checkbox', checked: Boolean(s.learning && s.learning[key]),
        onchange: async (e) => {
          try {
            const payload = {};
            payload[key] = e.target.checked;
            const res = await market.trishEngineAction(payload);
            paintEvolution(res);
            evoNote.textContent = 'Learning setting saved. The engine restarted to apply it.';
            evoNote.className = 'form__note is-ok';
          } catch (err) {
            evoNote.textContent = `Not saved: ${String(err.message || err).slice(0, 160)}`;
            evoNote.className = 'form__note is-bad';
          }
        },
      }),
      el('span', {}, el('b', { text: label }), el('small', { class: 'card__note', style: 'display:block', text: hint })))));
  };

  const pendingRow = (item) => el('div', { style: 'border-top:1px solid var(--line);padding:10px 0' },
    el('div', { style: 'display:flex;gap:8px;align-items:center;justify-content:space-between' },
      el('div', {},
        el('b', { text: `${item.kind}: ${item.title}` }),
        el('small', { class: 'card__note', style: 'display:block', text: item.created || '' })),
      el('div', { style: 'display:flex;gap:8px' },
        el('button', { class: 'btn btn--primary btn--sm', onclick: () => decide(item, 'approve') }, 'Approve'),
        el('button', { class: 'btn btn--outline btn--sm', onclick: () => decide(item, 'reject') }, 'Reject'))),
    el('pre', { class: 'card__note',
      style: 'white-space:pre-wrap;max-height:140px;overflow:auto;margin:8px 0 0',
      text: (item.diff || '(no diff recorded)').slice(0, 1200) }));

  const decide = async (item, action) => {
    try {
      const res = await market.trishDecide(item.id, action);
      evoNote.textContent = action === 'approve'
        ? (res.ok ? 'Approved and applied inside the engine.' : `Engine refused: ${res.error || ''}`)
        : 'Rejected and archived.';
      evoNote.className = res.ok ? 'form__note is-ok' : 'form__note is-bad';
      await paintPending();
      paintEvolution(await market.trishEngine());
    } catch (err) {
      evoNote.textContent = String(err.message || err).slice(0, 160);
      evoNote.className = 'form__note is-bad';
    }
  };

  const paintPending = async () => {
    try {
      const { items } = await market.trishPending();
      if (!items || !items.length) {
        pendingBox.replaceChildren(el('p', { class: 'card__note',
          text: 'Nothing waiting. She has not proposed a skill or memory change since the last review.' }));
        return;
      }
      pendingBox.replaceChildren(...items.slice(0, 8).map(pendingRow));
    } catch {
      pendingBox.replaceChildren(el('p', { class: 'card__note', text: 'The market service did not answer.' }));
    }
  };

  const paintMemory = async () => {
    try {
      const { files } = await market.trishMemory();
      memoryBox.replaceChildren(...(files || []).map((f) => {
        memEditors[f.name] = memEditors[f.name] || el('textarea', {
          rows: '4',
          placeholder: f.name === 'USER.md' ? 'Operator preferences: flat-by time, risk %, preferred timeframe…' : 'Desk facts: symbol basket, plan tier, timezone…',
          style: 'width:100%;font-family:var(--mono);font-size:12px',
        });
        if (document.activeElement !== memEditors[f.name]) memEditors[f.name].value = f.text || '';
        return el('div', { style: 'margin-bottom:14px' },
          el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px' },
            el('b', { text: f.name }),
            el('small', { class: 'card__note', text: f.updated ? `updated ${f.updated}` : 'empty' })),
          memEditors[f.name],
          el('button', { class: 'btn btn--outline btn--sm', style: 'margin-top:6px', onclick: async () => {
            try {
              await market.trishSaveMemory(f.name, memEditors[f.name].value);
              evoNote.textContent = `${f.name} saved.`;
              evoNote.className = 'form__note is-ok';
              await paintMemory();
            } catch (err) { evoNote.textContent = String(err.message || err).slice(0, 160); evoNote.className = 'form__note is-bad'; }
          } }, 'Save ' + f.name));
      }));
    } catch {
      memoryBox.replaceChildren(el('p', { class: 'card__note', text: 'The market service did not answer.' }));
    }
  };

  const paintJourney = async () => {
    try {
      const { items } = await market.trishJourney();
      journeyBox.replaceChildren(items && items.length
        ? el('div', {}, ...items.slice(0, 10).map((it) => el('div', { style: 'border-top:1px solid var(--line);padding:8px 0' },
          el('b', { text: `${it.kind}: ${it.title || it.name || it.id || ''}` }),
          el('small', { class: 'card__note', style: 'display:block', text: `${it.decision || 'saved'} · ${it.at || ''}` }))))
        : el('p', { class: 'card__note', text: 'Nothing learned yet. Approvals and memory edits appear here with their date.' }));
    } catch {
      journeyBox.replaceChildren(el('p', { class: 'card__note', text: 'The market service did not answer.' }));
    }
  };

  const evoAction = async (action) => {
    evoNote.textContent = `${action}…`;
    evoNote.className = 'form__note';
    try {
      const res = await market.trishEngineAction({ action });
      paintEvolution(res);
      evoNote.textContent = res.error ? res.error : `Engine ${action}: ok.`;
      evoNote.className = res.error ? 'form__note is-bad' : 'form__note is-ok';
    } catch (err) {
      evoNote.textContent = `Engine ${action} failed: ${String(err.message || err).slice(0, 160)}`;
      evoNote.className = 'form__note is-bad';
    }
  };

  const saveEngine = async () => {
    evoNote.textContent = 'Saving and restarting the engine…';
    evoNote.className = 'form__note';
    try {
      const payload = { provider: evoProvider.value, model: evoModel.value.trim(), base_url: evoBase.value.trim() };
      if (evoCtx.value) payload.context_length = evoCtx.value;
      if (evoKey.value) payload.api_key = evoKey.value.trim();
      const res = await market.trishEngineAction(payload);
      evoKey.value = '';
      paintEvolution(res);
      evoNote.textContent = 'Engine provider saved. Model turns now run on it.';
      evoNote.className = 'form__note is-ok';
    } catch (err) {
      evoNote.textContent = `Not saved: ${String(err.message || err).slice(0, 160)}`;
      evoNote.className = 'form__note is-bad';
    }
  };

  const evolutionCard = card('Engine', { note: 'project-owned Hermes' },
    el('p', { class: 'card__note', text: 'Trish runs on a pinned checkout of Nous Research\'s Hermes Agent in vendor/hermes-agent, with its own venv and its own home (runtime/hermes) — not the Hermes installed for your personal agent. Its API is loopback-only and key-gated.' }),
    evoFacts,
    evoWarn,
    el('div', { style: 'margin-top:14px;display:flex;gap:10px;flex-wrap:wrap' },
      el('button', { class: 'btn btn--primary btn--sm', onclick: () => evoAction('start') }, 'Start engine'),
      el('button', { class: 'btn btn--outline btn--sm', onclick: () => evoAction('stop') }, 'Stop'),
      el('button', { class: 'btn btn--outline btn--sm', onclick: () => evoAction('restart') }, 'Restart')),
    el('div', { class: 'form form--2', style: 'margin-top:16px' },
      field('Provider', evoProvider),
      field('Model', evoModel),
      field('Base URL', evoBase),
      field('Context length', evoCtx),
      field('Provider key', evoKey)),
    el('div', { style: 'margin-top:12px;display:flex;gap:10px;flex-wrap:wrap' },
      el('button', { class: 'btn btn--primary btn--sm', onclick: saveEngine }, 'Save engine provider'),
      el('button', { class: 'btn btn--outline btn--sm', onclick: () => evoAction('restart') }, 'Apply and restart')),
    el('p', { class: 'card__note', style: 'margin-top:8px', text: 'The provider key is written to runtime/hermes/.env (mode 600) and never returned by any request. Leave it blank to keep the stored one.' }),
    evoNote);

  const learningCard = card('Learning & memory', { note: 'gated by you' },
    el('p', { class: 'card__note', text: 'Hermes writes skills and memory from what happens in a session. Both gates are on: a proposal lands in the queue below and nothing changes until you approve it. Skills that encode a market claim are rejected on sight — Edge Stats is the only source of statistical truth here.' }),
    learningBox,
    el('div', { style: 'margin-top:4px' },
      el('h4', { style: 'margin:14px 0 4px', text: 'Waiting for you' }), pendingBox),
    el('div', { style: 'margin-top:18px' },
      el('h4', { style: 'margin:0 0 8px', text: 'Memory' }), memoryBox),
    el('div', { style: 'margin-top:18px' },
      el('h4', { style: 'margin:0 0 8px', text: 'What she learned' }), journeyBox));

  market.trishEngine().then(paintEvolution).catch(() => paintEvolution(null));
  paintPending();
  paintMemory();
  paintJourney();

  const group = (title, ...cards) => el('section', { class: 'settings-group' },
    el('h2', { class: 'settings-group__title', text: title }),
    el('div', { class: 'grid grid--2' }, ...cards));

  const page = el('div', { class: 'page' });
  page.append(
    el('div', { class: 'page__head' },
      el('div', {},
        el('h2', { class: 'page__title', text: 'Settings' }))),

    group('Account',
      card('Profile', {},
        el('div', { class: 'form' },
          field('Display name', nameInput),
          field('Email', emailInput),
          field('Account ID', el('input', { type: 'text', value: profile ? profile.account_id || '' : '', placeholder: 'Not connected', readonly: true })),
          el('button', { class: 'btn btn--primary', style: 'justify-self:start', onclick: () => {
            note.textContent = 'Profile saved.';
            note.className = 'form__note is-ok';
          } }, 'Save changes'),
          note)),
      card('Broker connection', {},
        el('div', { class: 'empty', style: 'padding:22px 8px' },
          el('h3', { text: 'No MT5 accounts connected' }),
          el('p', { text: 'Connect a broker account to run analysis on your own chart and enable auto trading.' }),
          el('button', { class: 'btn btn--outline btn--sm', onclick: () => toast('MT5 connection flow opens in the next phase') }, 'Connect MT5')))),

    group('Data',
      dataSource,
      marketCard),

    group('Trish — assistant runtime',
      card('Provider', {},
        el('p', { class: 'card__note', text: 'Trish runs on any OpenAI-compatible endpoint: OpenRouter, OpenAI, Anthropic via proxy, Ollama, LM Studio or a local Hermes gateway. Nothing is sent anywhere until you save one.' }),
        el('div', { class: 'form form--2', style: 'margin-top:14px' },
          field('Backend', trishBackend),
          field('Model', trishModel),
          field('Base URL', trishBase),
          field('API key', trishKey)),
        trishNote,
        trishFacts,
        el('div', { style: 'margin-top:14px;display:flex;gap:10px;flex-wrap:wrap' },
          el('button', { class: 'btn btn--primary btn--sm', onclick: saveTrish }, 'Save provider'),
          el('button', { class: 'btn btn--outline btn--sm', onclick: testTrish }, 'Test'),
          el('button', { class: 'btn btn--outline btn--sm', onclick: removeTrish }, 'Remove')),
        el('p', { class: 'card__note', style: 'margin-top:10px', text: 'The key is stored server-side in server/config.json (mode 600) and never returned by any request.' })),
      card('What she can do', {},
        el('p', { class: 'card__note', text: 'Tools she can call, all backed by real Cairnline data:' }),
        el('div', { class: 'tools', style: 'margin-top:10px' },
          el('div', { class: 'tool' }, el('b', { text: 'get_quote' }), el('small', { text: 'Live price and session change' })),
          el('div', { class: 'tool' }, el('b', { text: 'get_indicators' }), el('small', { text: 'Pine EMA/RSI/ATR/MACD + bias' })),
          el('div', { class: 'tool' }, el('b', { text: 'get_signals' }), el('small', { text: 'Ranked basket' })),
          el('div', { class: 'tool' }, el('b', { text: 'get_cot' }), el('small', { text: 'CFTC positioning' })),
          el('div', { class: 'tool' }, el('b', { text: 'get_calendar' }), el('small', { text: 'Macro events' })),
          el('div', { class: 'tool' }, el('b', { text: 'position_size' }), el('small', { text: 'Size from equity and stop' })),
          el('div', { class: 'tool' }, el('b', { text: 'risk_gate' }), el('small', { text: 'PASS or BLOCK, final' })))),
      evolutionCard,
      learningCard),

    group('Signals & alerts',
      deliveryCard,
      card('Notifications', {},
        profile && profile.email_preferences
          ? el('div', {},
            switchRow('Promotions', 'Offers and partner campaigns', Boolean(profile.email_preferences.promotions), () => toast('Preference saved')),
            switchRow('Announcements', 'Product news', Boolean(profile.email_preferences.announcements), () => toast('Preference saved')),
            switchRow('System updates', 'Security and downtime notices', Boolean(profile.email_preferences.system_updates), () => toast('Preference saved')))
          : el('div', { class: 'empty' },
            el('h3', { text: 'No email preferences yet' }),
            el('p', { text: 'Email preferences are stored on an account row. The desk runs without one, so there is nothing here to set.' })))),

    group('Appearance',
      card('Interface', {},
        switchRow('Dark theme', 'Always on in the operator surface', true, (v) => toast(`Dark theme ${v ? 'on' : 'off'}`)),
        switchRow('Reduce motion', 'Respect the system preference', false, (v) => toast(`Reduced motion ${v ? 'on' : 'off'}`)),
        switchRow('Compact tables', 'Denser rows in data grids', false, (v) => toast(`Compact tables ${v ? 'on' : 'off'}`)))));
  return page;
}
