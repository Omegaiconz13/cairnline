import { api, fmt } from '../data.js';
import { el, card, chip, table, switchRow, toast, empty, notConnected } from '../ui.js';
import { market, px } from '../market.js';

/** Manage Bots — production /manage-bots. */
export async function bots(ctx) {
  let bots = []; let trades = [];
  try {
    [bots, trades] = await Promise.all([api.bots.list(), api.bots.trades()]);
  } catch {
    return el('div', { class: 'page' },
      card('Manage Bots', { note: 'nothing to read' }, notConnected('Your cloud bots and their trades')));
  }
  const net = trades.reduce((s, t) => s + (t.pnl || 0), 0);

  const tabs = el('div', { class: 'tabs' },
    ['Stats', 'Trades', 'Logs'].map((t, i) => el('button', {
      class: i === 0 ? 'is-active' : '',
      onclick: (e) => {
        [...e.currentTarget.parentNode.children].forEach((b) => b.classList.remove('is-active'));
        e.currentTarget.classList.add('is-active');
        body.replaceChildren(i === 0 ? statsView() : i === 1 ? tradesView() : logsView());
      },
      text: t,
    })));

  const body = el('div');
  const statsView = () => el('div', {},
    el('div', { class: 'grid grid--4', style: 'margin-bottom:18px' },
      el('div', { class: 'stat' }, el('small', { text: 'Active bots' }), el('b', { text: String(bots.filter((b) => b.status === 'running').length) }), el('span', { text: 'running now' })),
      el('div', { class: 'stat' }, el('small', { text: 'Total bots' }), el('b', { text: String(bots.length) }), el('span', { text: 'all time' })),
      el('div', { class: 'stat' }, el('small', { text: 'Total trades' }), el('b', { text: String(trades.length) }), el('span', { text: 'executed' })),
      el('div', { class: 'stat' }, el('small', { text: 'Net P/L' }), el('b', { class: net >= 0 ? 'metric--accent' : 'neg', text: `${net >= 0 ? '+' : ''}$${net.toFixed(2)}` }), el('span', { text: 'across bots' }))),
    table([
      { label: 'Bot', key: 'name' },
      { label: 'Symbol', key: 'symbol' },
      { label: 'Status', render: (r) => chip(r.status, r.status === 'running' ? 'chip--on' : '') },
      { label: 'P/L', num: true, render: (r) => `<span class="${r.pnl >= 0 ? 'pos' : 'neg'}">${r.pnl >= 0 ? '+' : ''}$${Number(r.pnl).toFixed(2)}</span>` },
      { label: 'Since', render: (r) => fmt.ago(r.started_at || r.created_at) },
    ], bots, { emptyTitle: 'No bots yet', emptyText: 'Build a strategy in the AI Strategy Builder and deploy it to the cloud.' }));

  const tradesView = () => table([
    { label: 'Symbol', key: 'symbol' },
    { label: 'Side', render: (r) => chip(r.side.toUpperCase(), r.side === 'long' ? 'chip--on' : 'chip--danger') },
    { label: 'Qty', num: true, key: 'qty' },
    { label: 'Open', num: true, render: (r) => fmt.price(r.price) },
    { label: 'P/L', num: true, render: (r) => `<span class="${r.pnl >= 0 ? 'pos' : 'neg'}">${r.pnl >= 0 ? '+' : ''}$${Number(r.pnl).toFixed(2)}</span>` },
    { label: 'Closed', render: (r) => fmt.ago(r.closed_at || r.opened_at) },
  ], trades, { emptyTitle: 'No bot trades yet', emptyText: 'Trades executed by your bots appear here.' });

  const logsView = () => el('div', { class: 'empty' },
    el('h3', { text: 'No log entries' }),
    el('p', { text: 'Runtime logs from your bots stream here in real time.' }));

  body.replaceChildren(statsView());

  const page = el('div', { class: 'page' });
  page.append(
    el('div', { class: 'page__head' },
      el('div', {},
        el('h2', { class: 'page__title', text: 'Manage Bots' }),
        el('p', { class: 'page__sub', text: 'Rules-first hybrid execution engine · all MT5 brokers · all prop firms' })),
      el('div', { style: 'display:flex;gap:8px;align-items:center' }, tabs,
        el('button', { class: 'btn btn--primary btn--sm', onclick: () => toast('Strategy builder opens in the next build phase') }, 'New Bot'))),
    card('Bots', {}, body));
  return page;
}

/** Auto Trading — production /auto-trading (Platinum gate in production). */
export async function autoTrading(ctx) {
  const page = el('div', { class: 'page' });
  const locked = !ctx.permissions.autoTrading || ctx.permissions.planKey !== 'platinum';
  page.append(
    el('div', { class: 'page__head' },
      el('div', {},
        el('h2', { class: 'page__title', text: 'Auto Trading' }),
        el('p', { class: 'page__sub', text: 'AI-managed modes on your MT5 account' })),
      chip(locked ? 'Platinum feature' : 'Available on your plan', locked ? 'chip--warn' : 'chip--on')),
    locked
      ? card('Upgrade to unlock', {},
          el('p', { class: 'card__note', text: 'Auto Trading is exclusive to Platinum members. Upgrade to unlock locked AI-managed modes (Aggressive · Intraday · Swing) on your MT5 account.' }),
          el('div', { style: 'margin-top:16px' },
            el('a', { class: 'btn btn--primary', href: '#/choose-plan' }, 'Upgrade to Platinum')))
      : el('div', { class: 'grid grid--3' },
          ['Aggressive', 'Intraday', 'Swing'].map((mode) =>
            card(mode, { note: 'AI-managed' },
              el('p', { class: 'card__note', text: `Runs ${mode.toLowerCase()} automation against the connected MT5 account.` }),
              el('div', { style: 'margin-top:16px' }, switchRow('Enabled', 'Requires an MT5 connection', false, () => toast(`${mode} mode toggled`)))))));
  return page;
}

/** Pulse Signals — production /signals. */
export async function signals(ctx) {
  /* Signals are computed live from real bars by the cloud-bot engine, never stored rows. */
  const basket = await market.basketSignals('15m').catch((err) => ({ error: err }));

  const rows = (basket.signals || []).filter((s) => !s.error)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  const failed = (basket.signals || []).filter((s) => s.error).length;

  const page = el('div', { class: 'page' });
  page.append(
    el('div', { class: 'page__head' },
      el('div', {},
        el('h2', { class: 'page__title', text: 'Cairnline Pulse Signals' }))),
    el('div', { class: 'grid' },
      card('Live signals', {
        note: basket.error
          ? 'engine offline'
          : `${rows.length} pairs · ${basket.source || 'live'} · ${basket.fetched_at ? new Date(basket.fetched_at).toLocaleTimeString() : 'now'}`,
      },
        marketNote(basket, failed),
        table([
          { label: 'Symbol', key: 'symbol' },
          { label: 'Bias', render: (r) => chip(String(r.bias).toUpperCase(), r.bias === 'long' ? 'chip--on' : 'chip--danger') },
          { label: 'Entry', num: true, render: (r) => px(r.entry) },
          { label: 'SL', num: true, render: (r) => px(r.stop_loss) },
          { label: 'TP', num: true, render: (r) => px(r.take_profit) },
          { label: 'R:R', num: true, render: (r) => (r.risk_reward ? `1:${r.risk_reward}` : '—') },
          { label: 'RSI', num: true, render: (r) => (r.rsi == null ? '—' : Number(r.rsi).toFixed(1)) },
          { label: 'Conf.', num: true, render: (r) => `${r.confidence}%` },
        ], rows, {
          emptyTitle: basket.error ? 'Signal engine unreachable' : 'No signals right now',
          emptyText: basket.error
            ? 'Start it with `python3 server/market_service.py`, then reload. Nothing is guessed while it is down.'
            : 'Every pair in the basket came back flat or with too few bars.',
        }))));
  return page;
}

/** Honest banner: what ran, over how many pairs, and what failed. */
function marketNote(basket, failed) {
  if (basket.error) {
    return el('p', { class: 'note note--warn', text: `Market service unreachable: ${basket.error.message || basket.error}. No signal is invented here.` });
  }
  const parts = [];
  if (basket.source) parts.push(`source ${basket.source}`);
  if (basket.stale) parts.push('serving cached bars (provider failed)');
  if (basket.interval) parts.push(`interval ${basket.interval}`);
  if (failed) parts.push(`${failed} pair(s) skipped`);
  return el('p', { class: 'note', text: `${parts.join(' · ')}. Recomputed on request; not a stored history.` });
}
