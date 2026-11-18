/**
 * Paper Desk — a real order path with server-side rails, filled on paper.
 *
 * Nothing here reaches a broker: `server/paper_trader.py` checks every rail on
 * every submit, prices the fill from the live quote, and journals the order with
 * its checks. A rejection shows each rail and why it failed rather than a
 * generic error. Deployments take the strategy file Backtest Studio writes and
 * make one decision per cycle, from the newest closed bar.
 */
import { el, card, chip, table, empty, field } from '../ui.js';
import { market } from '../market.js';

const SYMBOLS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'XAUUSD', 'GBPJPY', 'USDCHF',
  'EURJPY', 'BTCUSD', 'ETHUSD', 'SPX', 'NAS100', 'US30'];

const money = (v) => (v === null || v === undefined || Number.isNaN(Number(v))
  ? '—' : `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const num = (v, d = 5) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(d));
const clock = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
};

export async function paperDesk() {
  const page = el('div', { class: 'page' });
  const out = el('div');
  const result = el('div');

  const symIn = el('input', { type: 'text', value: 'EURUSD', list: 'paperSymbols', spellcheck: 'false' });
  const sideSel = el('select', {}, [
    el('option', { value: 'long', text: 'Long' }),
    el('option', { value: 'short', text: 'Short' }),
  ]);
  const unitsIn = el('input', { type: 'number', step: 'any', min: '0', placeholder: 'blank = size from risk' });
  const riskIn = el('input', { type: 'number', step: '0.1', min: '0.1', max: '2', value: '1' });
  const stopIn = el('input', { type: 'number', step: 'any', placeholder: 'required' });
  const targetIn = el('input', { type: 'number', step: 'any', placeholder: 'required' });
  const reasonIn = el('input', { type: 'text', placeholder: 'why this trade' });
  const submitBtn = el('button', { class: 'btn btn--primary', type: 'button' }, 'Submit paper order');

  let state = null;

  const paint = (p) => {
    state = p;
    if (!p || p.error) {
      out.replaceChildren(card('Paper desk unavailable', {},
        empty('No account could be read', String((p && p.error) || 'the market service returned nothing'))));
      return;
    }
    const a = p.account;
    const kill = a.kill_switch || {};

    const head = el('div', { class: 'page__head' },
      el('div', {},
        el('h2', { class: 'page__title', text: 'Paper Desk' }),
        el('p', { class: 'page__sub', text: `Account ${money(a.equity)} equity · ${a.positions.length} open · fills priced from live quotes` })),
      chip(kill.engaged ? 'KILL SWITCH ENGAGED' : 'paper · no broker', kill.engaged ? 'chip--danger' : 'chip--on'));

    const killBtn = el('button', {
      class: `btn ${kill.engaged ? 'btn--primary' : 'btn--outline'} btn--sm`, type: 'button',
    }, kill.engaged ? 'Clear kill switch' : 'Engage kill switch');
    killBtn.addEventListener('click', async () => {
      killBtn.disabled = true;
      try {
        await market.paperKill(!kill.engaged, kill.engaged ? null : 'operator engaged the switch from the paper desk');
        await load();
      } catch (err) {
        result.replaceChildren(el('p', { class: 'note note--warn', text: String(err.message || err) }));
      } finally { killBtn.disabled = false; }
    });

    const metrics = el('div', { class: 'metrics' },
      el('div', { class: 'metric metric--accent' },
        el('div', { class: 'metric__k', text: 'Equity' }),
        el('div', { class: 'metric__v metric__v--sm', text: money(a.equity) }),
        el('div', { class: 'card__note', text: `balance ${money(a.balance)} · start ${money(a.starting_balance)}` })),
      el('div', { class: 'metric' },
        el('div', { class: 'metric__k', text: 'Open P&L' }),
        el('div', { class: `metric__v metric__v--sm ${a.open_pnl >= 0 ? 'metric--accent' : 'neg'}`, text: money(a.open_pnl) }),
        el('div', { class: 'card__note', text: p.mark_source ? `marks: ${p.mark_source}` : 'no marks — no open position' })),
      el('div', { class: 'metric' },
        el('div', { class: 'metric__k', text: 'Realised today' }),
        el('div', { class: `metric__v metric__v--sm ${a.realized_today >= 0 ? 'metric--accent' : 'neg'}`, text: money(a.realized_today) }),
        el('div', { class: 'card__note', text: `day ${a.day.date}` })),
      el('div', { class: 'metric' },
        el('div', { class: 'metric__k', text: 'Orders today' }),
        el('div', { class: 'metric__v', text: String(a.day.orders) }),
        el('div', { class: 'card__note', text: `cap ${p.rails.max_orders_per_day}` })),
      el('div', { class: 'metric' },
        el('div', { class: 'metric__k', text: 'Open positions' }),
        el('div', { class: 'metric__v', text: String(a.positions.length) }),
        el('div', { class: 'card__note', text: `cap ${p.rails.max_open_positions}` })));

    const positions = card('Open positions', { note: `${a.positions.length} of ${p.rails.max_open_positions}` },
      table([
        { key: 'symbol', label: 'Symbol' },
        { key: 'side', label: 'Side', render: (r) => chip(r.side.toUpperCase(), r.side === 'long' ? 'chip--on' : 'chip--danger') },
        { key: 'units', label: 'Units', num: true, render: (r) => num(r.units, 4) },
        { key: 'entry', label: 'Entry', num: true, render: (r) => num(r.entry) },
        { key: 'stop', label: 'Stop', num: true, render: (r) => num(r.stop) },
        { key: 'target', label: 'Target', num: true, render: (r) => num(r.target) },
        { key: 'mark', label: 'Mark', num: true, render: (r) => num((p.marks[r.symbol] || {}).price) },
        { key: 'opened_at', label: 'Opened', render: (r) => clock(r.opened_at) },
        { key: 'id', label: '', render: (r) => {
          const b = el('button', { class: 'btn btn--outline btn--sm', type: 'button' }, 'Close');
          b.addEventListener('click', async () => {
            b.disabled = true;
            try {
              const res = await market.paperClose(r.id, 'operator close');
              result.replaceChildren(el('p', { class: 'note', text: res.error
                ? String(res.error)
                : `Closed ${r.symbol} for ${money((res.closed || {}).pnl)} — fill ${num((res.closed || {}).exit)}.` }));
              await load();
            } catch (err) {
              result.replaceChildren(el('p', { class: 'note note--warn', text: String(err.message || err) }));
            } finally { b.disabled = false; }
          });
          return b;
        } },
      ], a.positions, { emptyTitle: 'Flat', emptyText: 'No paper position is open. Submit one above, or deploy a validated strategy.' }));

    const journal = card('Flight recorder', { note: `last ${Math.min(a.orders.length, 50)} of ${a.orders.length}` },
      table([
        { key: 'ts', label: 'When', render: (r) => clock(r.ts) },
        { key: 'type', label: 'Type' },
        { key: 'symbol', label: 'Symbol' },
        { key: 'side', label: 'Side' },
        { key: 'units', label: 'Units', num: true, render: (r) => num(r.units, 4) },
        { key: 'price', label: 'Quote', num: true, render: (r) => num(r.price) },
        { key: 'accepted', label: 'Result', render: (r) => chip(r.accepted ? 'ACCEPTED' : 'REJECTED', r.accepted ? 'chip--on' : 'chip--danger') },
        { key: 'rejections', label: 'Rejected because', render: (r) => (r.rejections && r.rejections.length ? r.rejections.join(' · ') : '—') },
      ], a.orders.slice().reverse(), { emptyTitle: 'No orders', emptyText: 'Every submitted order lands here with its checks — accepted or rejected.' }));

    const rails = card('Rails', { note: 'enforced server-side in server/paper_trader.py' },
      table([
        { key: 'key', label: 'Rail' },
        { key: 'value', label: 'Value' },
      ], [
        { key: 'symbol_allowlist', value: `${p.rails.symbol_allowlist.length} symbols` },
        { key: 'max_risk_pct_per_trade', value: `${p.rails.max_risk_pct_per_trade}% of equity` },
        { key: 'max_position_notional_pct', value: `${p.rails.max_position_notional_pct}% of equity` },
        { key: 'max_open_positions', value: String(p.rails.max_open_positions) },
        { key: 'max_daily_loss_pct', value: `${p.rails.max_daily_loss_pct}%` },
        { key: 'max_orders_per_day', value: String(p.rails.max_orders_per_day) },
        { key: 'min_reward_risk', value: `1:${p.rails.min_reward_risk}` },
        { key: 'duplicate_window_s', value: `${p.rails.duplicate_window_s}s` },
        { key: 'trading_hours_utc', value: `${p.rails.trading_hours_utc.start}:00–${p.rails.trading_hours_utc.end}:00 UTC` },
        { key: 'costs', value: `${p.rails.commission_bps} bps commission · ${p.rails.slippage_bps} bps slippage` },
      ]),
      el('p', { class: 'card__note', style: 'margin-top:10px', text: p.rails_note }));

    const deployments = card('Deployments', { note: `${a.deployments.length} registered` },
      pendingBox(),
      el('div', { style: 'margin-top:12px' },
        table([
          { key: 'label', label: 'Strategy' },
          { key: 'symbol', label: 'Market', render: (r) => `${r.symbol} ${r.interval} ${r.range}` },
          { key: 'basis', label: 'Validated', render: (r) => (r.basis && r.basis.label ? chip(r.basis.label, r.basis.holds_up ? 'chip--on' : 'chip--warn') : '—') },
          { key: 'last_cycle', label: 'Last cycle', render: (r) => clock(r.last_cycle) },
          { key: 'last_decision', label: 'Decision', render: (r) => (r.last_decision
            ? `${r.last_decision.action}${r.last_decision.reasons ? `: ${r.last_decision.reasons.join('; ')}` : ''}`
            : '—') },
          { key: 'id', label: '', render: (r) => {
            const b = el('button', { class: 'btn btn--outline btn--sm', type: 'button' }, 'Run one cycle');
            b.addEventListener('click', async () => {
              b.disabled = true;
              try {
                const res = await market.paperCycle(r.id);
                const one = (res.results || [])[0] || {};
                result.replaceChildren(el('p', { class: 'note', text: res.error
                  ? String(res.error)
                  : `${r.label}: ${one.action || 'no decision'}${one.reason ? ` — ${one.reason}` : ''}` }));
                await load();
              } catch (err) {
                result.replaceChildren(el('p', { class: 'note note--warn', text: String(err.message || err) }));
              } finally { b.disabled = false; }
            });
            return b;
          } },
        ], a.deployments, { emptyTitle: 'Nothing deployed', emptyText: 'Validate a strategy in Backtest Studio and send it here.' })));

    out.replaceChildren(head, card('Account', {}, metrics), result, positions, journal, rails, deployments);
  };

  /** A strategy handed over by Backtest Studio, kept in localStorage until deployed. */
  const pendingBox = () => {
    let cfg = null;
    try { cfg = JSON.parse(localStorage.getItem('cairnline_pending_deployment') || 'null'); } catch { cfg = null; }
    if (!cfg) return null;
    const b = el('button', { class: 'btn btn--primary btn--sm', type: 'button' }, 'Deploy this strategy');
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const res = await market.paperDeploy(cfg);
        localStorage.removeItem('cairnline_pending_deployment');
        result.replaceChildren(el('p', { class: 'note', text: `${res.deployment.label} registered on ${res.deployment.symbol} ${res.deployment.interval}. Nothing trades until you run a cycle.` }));
        await load();
      } catch (err) {
        result.replaceChildren(el('p', { class: 'note note--warn', text: String(err.message || err) }));
      } finally { b.disabled = false; }
    });
    return el('p', { class: 'note', style: 'margin:0' },
      `Pending from Backtest Studio: ${cfg.label || cfg.strategy} · ${(cfg.market || {}).symbol || '?'} ${(cfg.market || {}).interval || ''} · `,
      b);
  };

  const load = async () => {
    try {
      paint(await market.paper());
    } catch (err) {
      out.replaceChildren(card('Paper desk unavailable', {},
        empty('The market service did not answer', String(err.message || err))));
    }
  };

  submitBtn.addEventListener('click', async () => {
    submitBtn.disabled = true;
    result.replaceChildren(el('p', { class: 'card__note', text: 'Checking the rails against the live quote…' }));
    try {
      const payload = {
        symbol: (symIn.value || '').trim().toUpperCase(),
        side: sideSel.value,
        stop: stopIn.value === '' ? null : Number(stopIn.value),
        target: targetIn.value === '' ? null : Number(targetIn.value),
        reason: reasonIn.value || null,
      };
      if (unitsIn.value !== '') payload.units = Number(unitsIn.value);
      else payload.risk_pct = Number(riskIn.value) || 1;
      const res = await market.paperOrder(payload);
      const order = res.order || {};
      const checks = order.checks || [];
      result.replaceChildren(card(res.accepted ? 'Order accepted' : 'Order rejected',
        { note: `${(order.checks || []).filter((c) => c.pass).length}/${checks.length} rails passed` },
        el('p', { class: 'card__note', text: res.accepted
          ? `Filled ${order.units} ${order.symbol} at ${order.entry} (quote ${order.price}, source ${order.quote_source}). ${res.note || ''}`
          : (res.reasons || []).join(' · ') }),
        table([
          { key: 'label', label: 'Rail' },
          { key: 'detail', label: 'What was seen' },
          { key: 'pass', label: 'Result', render: (r) => chip(r.pass ? 'PASS' : 'BLOCK', r.pass ? 'chip--on' : 'chip--danger') },
        ], checks)));
      await load();
    } catch (err) {
      result.replaceChildren(el('p', { class: 'note note--warn', text: String(err.message || err) }));
    } finally { submitBtn.disabled = false; }
  });

  page.append(
    el('div', { class: 'page__head' },
      el('div', {},
        el('h2', { class: 'page__title', text: 'Paper Desk' }),
        el('p', { class: 'page__sub', text: 'Server-side risk rails, a kill switch and a flight recorder — fills are paper, prices are live.' })),
      chip('no broker connected', 'chip--warn')),
    card('Order ticket', {},
      el('div', { class: 'form form--3' },
        field('Symbol', symIn),
        field('Side', sideSel),
        field('Units (optional)', unitsIn),
        field('Risk % (when units blank)', riskIn),
        field('Stop', stopIn),
        field('Target', targetIn),
        field('Reason', reasonIn)),
      el('datalist', { id: 'paperSymbols' }, SYMBOLS.map((s) => el('option', { value: s }))),
      el('div', { class: 'bt__actions' }, submitBtn),
      el('p', { class: 'card__note', text: 'Every rail is checked before the fill; a rejection lists each one. The kill switch blocks new entries but never blocks a close. Stops are not watched between requests — there is no broker and no background loop, so a position exits when you close it or a cycle decides to.' })),
    out);

  await load();
  return page;
}
