/**
 * EA Marketplace — production /ea-marketplace, live rows only.
 *
 * The catalogue is whatever the signed-in account can read from the `eas` table;
 * there is no seeded list and no invented win rate. When the table is empty the
 * page says so. Downloads are read from `ea_downloads`, which is why nothing on
 * this page pretends to install: this client is read-only.
 */
import { api, fmt } from '../data.js';
import { el, card, chip, table, sparkline, notConnected } from '../ui.js';

const RANK = { basic: 1, pro: 2, ultimate: 3, platinum: 4 };
const tierName = (key) => (key ? key[0].toUpperCase() + key.slice(1) : 'Basic');
const n = (v) => (v === null || v === undefined ? '—' : Number(v));

export async function eaMarketplace(ctx) {
  let list = null; let downloads = [];
  try {
    [list, downloads] = await Promise.all([api.ea.list(), api.ea.downloads()]);
  } catch {
    return el('div', { class: 'page' },
      card('EA Marketplace', { note: 'nothing to read' }, notConnected('The EA catalogue and your downloads')));
  }

  const myRank = RANK[ctx.permissions.planKey] || 0;
  let category = 'All';
  let query = '';

  const grid = el('div', { class: 'grid grid--3' });
  const nothing = el('div', { class: 'empty', style: 'display:none' },
    el('h3', { text: 'No EAs match that filter' }),
    el('p', { text: 'Try another category, or clear the search box.' }));

  const matches = (ea) => {
    const q = query.trim().toLowerCase();
    const hay = [ea.name, ea.author, ea.symbol, ...(ea.tags || [])].filter(Boolean).join(' ').toLowerCase();
    const okQuery = !q || hay.includes(q);
    const okCat = category === 'All'
      || (category === 'Free' && !ea.price_cents)
      || (category === 'Gold' && String(ea.symbol || '').startsWith('XAU'))
      || (category === 'FX majors' && ea.symbol && !String(ea.symbol).startsWith('XAU'))
      || (category === 'Included' && myRank >= (RANK[ea.plan_required] || 1));
    return okQuery && okCat;
  };

  function renderCards() {
    grid.innerHTML = '';
    const rows = list.filter(matches);
    nothing.style.display = rows.length ? 'none' : 'grid';
    for (const ea of rows) {
      const locked = myRank < (RANK[ea.plan_required] || 1);
      const equity = Array.isArray(ea.equity) && ea.equity.length > 1 ? ea.equity : null;
      grid.append(el('article', { class: 'plan' },
        el('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:10px' },
          el('div', { style: 'min-width:0' },
            el('h3', { text: ea.name || 'Untitled EA' }),
            el('p', { class: 'card__note', style: 'margin-top:5px', text: `${ea.version ? `v${ea.version} · ` : ''}${ea.author || 'author not listed'}` })),
          chip(ea.price_cents ? fmt.money(ea.price_cents) : `On ${tierName(ea.plan_required)}`, locked ? 'chip--warn' : 'chip--mono')),
        el('p', { class: 'card__note', style: 'margin-top:12px;line-height:1.55', text: ea.description || 'No description published.' }),
        el('div', { style: 'display:flex;align-items:flex-end;justify-content:space-between;gap:14px;margin-top:16px' },
          el('div', { class: 'metrics', style: 'gap:10px 18px' },
            el('div', { class: 'metric' },
              el('div', { class: 'metric__k', text: 'Win rate' }),
              el('div', { class: 'metric__v metric__v--sm', text: ea.win_rate === null || ea.win_rate === undefined ? '—' : `${n(ea.win_rate).toFixed(1)}%` })),
            el('div', { class: 'metric' },
              el('div', { class: 'metric__k', text: 'Profit factor' }),
              el('div', { class: 'metric__v metric__v--sm', text: ea.profit_factor === null || ea.profit_factor === undefined ? '—' : n(ea.profit_factor).toFixed(2) })),
            el('div', { class: 'metric' },
              el('div', { class: 'metric__k', text: 'Max DD' }),
              el('div', { class: 'metric__v metric__v--sm', style: 'color:var(--danger)', text: ea.max_dd === null || ea.max_dd === undefined ? '—' : `${n(ea.max_dd).toFixed(1)}%` }))),
          equity
            ? el('div', { style: 'text-align:right' },
              el('div', { style: 'width:128px;height:36px;margin-left:auto;opacity:.9', html: sparkline(equity, { width: 128, height: 36 }) }),
              el('div', { class: 'metric__k', style: 'margin-top:6px', text: `${Number(ea.trades || 0).toLocaleString('en-US')} trades` }))
            : el('div', { class: 'metric__k', text: 'no equity curve published' })),
        el('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:16px;padding-top:14px;border-top:1px solid var(--line)' },
          el('span', { class: 'card__note', text: [ea.symbol, ea.timeframe, ea.rating ? `★ ${n(ea.rating).toFixed(1)} (${ea.reviews || 0})` : null].filter(Boolean).join(' · ') || 'specs not listed' }),
          ea.url
            ? el('a', { class: `btn btn--sm ${locked ? 'btn--outline' : 'btn--primary'}`, href: ea.url, target: '_blank', rel: 'noopener', text: locked ? `Upgrade to ${tierName(ea.plan_required)}` : 'Open' })
            : el('span', { class: 'card__note', text: locked ? `Needs ${tierName(ea.plan_required)}` : 'No download link published' }))));
    }
  }

  const downloadsCard = card('Your EAs', { note: 'from ea_downloads' },
    downloads.length
      ? table([
        { key: 'name', label: 'EA' },
        { key: 'version', label: 'Version', render: (r) => (r.version ? `v${r.version}` : '—') },
        { key: 'symbol', label: 'Symbol' },
        { key: 'downloaded_at', label: 'Installed', render: (r) => fmt.date(r.downloaded_at) },
        { key: 'status', label: 'Status', render: (r) => chip(r.status || '—', r.status === 'installed' ? 'chip--on' : 'chip--off') },
      ], downloads)
      : el('div', { class: 'empty', style: 'padding:22px 8px' },
        el('h3', { text: 'No EAs downloaded by this account' }),
        el('p', { text: 'Rows in ea_downloads would appear here. Nothing is invented for display.' })));

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

  renderCards();

  const page = el('div', { class: 'page' });
  page.append(
    el('div', { class: 'page__head' },
      el('div', {},
        el('h2', { class: 'page__title', text: 'EA Marketplace' }),
        el('p', { class: 'page__sub', text: 'Every EA row your account can read, gated by your plan.' })),
      el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center' },
        chip(list.length ? `${list.length} published` : 'none published', 'chip--mono'),
        search)),
    tabs,
    grid,
    nothing,
    list.length ? null : el('div', { class: 'empty', style: 'padding:26px 8px' },
      el('h3', { text: 'Nothing published to the eas table' }),
      el('p', { text: 'This catalogue is empty because the table is. Add rows in the real product and they appear here — no placeholder EAs are shown.' })),
    el('div', { class: 'grid grid--sidebar', style: 'margin-top:16px' }, downloadsCard));
  return page;
}
