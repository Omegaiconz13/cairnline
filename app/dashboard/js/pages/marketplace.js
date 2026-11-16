/**
 * EA Marketplace — production /ea-marketplace.
 *
 * Browse Expert Advisors published by Pipnex and verified third-party authors.
 * Downloads are plan-gated the same way production gates them: your plan rank has
 * to reach the EA's `plan_required`, and an installed EA is recorded in
 * `ea_downloads` so Manage Bots can pick it up.
 */
import { api, fmt } from '../data.js';
import { el, card, chip, table, sparkline, toast } from '../ui.js';

const RANK = { basic: 1, pro: 2, ultimate: 3, platinum: 4 };
const tierName = (key) => (key ? key[0].toUpperCase() + key.slice(1) : 'Basic');
const priceLabel = (ea) => (ea.price_cents ? fmt.money(ea.price_cents) : `On ${tierName(ea.plan_required)}`);

export async function eaMarketplace(ctx) {
  const [list, initial] = await Promise.all([api.ea.list(), api.ea.downloads()]);
  const myRank = RANK[ctx.permissions.planKey] || 1;
  const mine = new Set(initial.map((d) => d.ea_id));
  const downloads = [...initial];

  let category = 'All';
  let query = '';

  const grid = el('div', { class: 'grid grid--3' });
  const nothing = el('div', { class: 'empty', style: 'display:none' },
    el('h3', { text: 'No EAs match that filter' }),
    el('p', { text: 'Try another category, or clear the search box.' }));

  const install = (ea) => {
    if (myRank < RANK[ea.plan_required]) {
      toast(`${ea.name} needs the ${tierName(ea.plan_required)} plan`);
      location.hash = '#/subscription';
      return;
    }
    if (mine.has(ea.id)) { toast(`${ea.name} is already in your terminal`); return; }
    downloads.unshift({
      id: `dl_${ea.id}`,
      ea_id: ea.id,
      name: ea.name,
      version: ea.version,
      symbol: ea.symbol,
      plan_required: ea.plan_required,
      status: 'installed',
      downloaded_at: new Date().toISOString(),
    });
    mine.add(ea.id);
    renderDownloads();
    renderCards();
    toast(`${ea.name} v${ea.version} sent to Manage Bots`);
  };

  const matches = (ea) => {
    const q = query.trim().toLowerCase();
    const okQuery = !q || [ea.name, ea.author, ea.symbol, ...(ea.tags || [])].join(' ').toLowerCase().includes(q);
    const okCat = category === 'All'
      || (category === 'Free' && !ea.price_cents)
      || (category === 'Gold' && ea.symbol.startsWith('XAU'))
      || (category === 'FX majors' && !ea.symbol.startsWith('XAU'))
      || (category === 'Included' && myRank >= RANK[ea.plan_required]);
    return okQuery && okCat;
  };

  function renderCards() {
    grid.innerHTML = '';
    const rows = list.filter(matches);
    nothing.style.display = rows.length ? 'none' : 'grid';
    rows.forEach((ea) => {
      const locked = myRank < RANK[ea.plan_required];
      const owned = mine.has(ea.id);
      grid.append(el('article', { class: 'plan' },
        el('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:10px' },
          el('div', { style: 'min-width:0' },
            el('h3', { text: ea.name }),
            el('p', { class: 'card__note', style: 'margin-top:5px', text: `v${ea.version} · ${ea.author}` })),
          ea.badge ? chip(ea.badge, 'chip--on') : chip(priceLabel(ea), locked ? 'chip--warn' : 'chip--mono')),
        el('p', { class: 'card__note', style: 'margin-top:12px;line-height:1.55', text: ea.description }),
        el('div', { style: 'display:flex;align-items:flex-end;justify-content:space-between;gap:14px;margin-top:16px' },
          el('div', { class: 'metrics', style: 'gap:10px 18px' },
            el('div', { class: 'metric' },
              el('div', { class: 'metric__k', text: 'Win rate' }),
              el('div', { class: 'metric__v metric__v--sm', text: `${ea.win_rate.toFixed(1)}%` })),
            el('div', { class: 'metric' },
              el('div', { class: 'metric__k', text: 'Profit factor' }),
              el('div', { class: 'metric__v metric__v--sm', text: ea.profit_factor.toFixed(2) })),
            el('div', { class: 'metric' },
              el('div', { class: 'metric__k', text: 'Max DD' }),
              el('div', { class: 'metric__v metric__v--sm', style: 'color:var(--danger)', text: `${ea.max_dd.toFixed(1)}%` }))),
          el('div', { style: 'text-align:right' },
            el('div', {
              style: 'width:128px;height:36px;margin-left:auto;opacity:.9',
              html: sparkline(ea.equity, { width: 128, height: 36 }),
            }),
            el('div', { class: 'metric__k', style: 'margin-top:6px', text: `${ea.trades.toLocaleString('en-US')} trades` }))),
        el('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:16px;padding-top:14px;border-top:1px solid var(--line)' },
          el('span', { class: 'card__note', text: `${ea.symbol} · ${ea.timeframe} · ★ ${ea.rating.toFixed(1)} (${ea.reviews})` }),
          el('button', {
            class: `btn btn--sm ${locked ? 'btn--outline' : 'btn--primary'}`,
            onclick: () => install(ea),
            text: owned ? 'Installed' : locked ? `Upgrade to ${tierName(ea.plan_required)}` : 'Install',
          }))));
    });
  }

  const downloadsCard = card('Your EAs', { note: 'Downloads land in Manage Bots' });
  function renderDownloads() {
    const host = downloadsCard.querySelector('.table-wrap, .empty');
    const body = table([
      { key: 'name', label: 'EA' },
      { key: 'version', label: 'Version', render: (r) => `v${r.version}` },
      { key: 'symbol', label: 'Symbol' },
      { key: 'downloaded_at', label: 'Installed', render: (r) => fmt.date(r.downloaded_at) },
      { key: 'status', label: 'Status', render: (r) => chip(r.status, r.status === 'installed' ? 'chip--on' : 'chip--off') },
    ], downloads, { emptyTitle: 'No EAs installed yet', emptyText: 'Install one from the catalogue above and it appears here, ready for Manage Bots.' });
    if (host) host.replaceWith(body);
    else downloadsCard.append(body);
  }
  renderDownloads();

  const search = el('input', {
    type: 'search',
    placeholder: 'Search name, author, symbol',
    style: 'min-width:230px',
    oninput: (e) => { query = e.target.value; renderCards(); },
  });

  const cats = ['All', 'Gold', 'FX majors', 'Free', 'Included'];
  const tabs = el('div', { class: 'tabs' }, cats.map((c, i) => el('button', {
    class: i === 0 ? 'is-active' : '',
    onclick: (e) => {
      [...e.currentTarget.parentNode.children].forEach((b) => b.classList.remove('is-active'));
      e.currentTarget.classList.add('is-active');
      category = c;
      renderCards();
    },
  }, c)));

  const request = el('p', { class: 'form__note' });
  const publish = card('Publish your own EA', {},
    el('div', { class: 'form form--3' },
      el('label', { class: 'field' }, el('span', { text: 'EA name' }), el('input', { placeholder: 'Aurora Scalper X' })),
      el('label', { class: 'field' }, el('span', { text: 'Primary symbol' }), el('input', { placeholder: 'XAUUSD' })),
      el('label', { class: 'field' }, el('span', { text: 'Price (USD)' }), el('input', { placeholder: '89.00', inputmode: 'decimal' }))),
    el('div', { style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:14px' },
      el('button', { class: 'btn btn--primary', onclick: () => {
        request.textContent = myRank >= RANK.ultimate
          ? 'Submitted for review — we reply within two business days.'
          : 'Publishing with your own branding is an Ultimate and Platinum feature.';
        request.className = `form__note ${myRank >= RANK.ultimate ? 'is-ok' : 'is-bad'}`;
      } }, 'Submit for review'),
      el('span', { class: 'card__note', text: 'MT5 .ex4/.ex5, verified track record required.' })),
    request);

  renderCards();

  const page = el('div', { class: 'page' });
  page.append(
    el('div', { class: 'page__head' },
      el('div', {},
        el('h2', { class: 'page__title', text: 'EA Marketplace' }),
        el('p', { class: 'page__sub', text: 'Expert Advisors by Pipnex and verified authors, gated by your plan.' })),
      el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center' },
        chip(`${list.length} published`, 'chip--mono'),
        search)),
    tabs,
    grid,
    nothing,
    el('div', { class: 'grid grid--sidebar', style: 'margin-top:16px' }, downloadsCard, publish));
  return page;
}
