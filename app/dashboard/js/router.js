import { el, card, chip, toast } from './ui.js';
import { api, fmt, permissionsFor, getMode, setMode, loadStoredSession, hasSession } from './data.js';

import { overview } from './pages/overview.js';
import { terminal, upload } from './pages/terminal.js';
import { bots, autoTrading, signals } from './pages/trading.js';
import { subscription, wallet, settings } from './pages/account.js';
import { lens, referral, tutorials, support } from './pages/content.js';
import { research } from './pages/research.js';
import { propFirm, edgeStats } from './pages/tools.js';
import { eaMarketplace } from './pages/marketplace.js';
import { syntheticChart } from './pages/synthetic.js';

const ROUTES = {
  overview: { title: 'PipNex Dashboard', render: overview },
  chart: { title: 'AI Trading', render: terminal },
  upload: { title: 'Upload Chart', render: upload },
  bots: { title: 'Manage Bots', render: bots },
  'auto-trading': { title: 'Auto Trading', render: autoTrading },
  signals: { title: 'Pulse Signals', render: signals },
  'ea-marketplace': { title: 'EA Marketplace', render: eaMarketplace },
  'synthetic-chart': { title: 'Synthetic Indices', render: syntheticChart },
  subscription: { title: 'Subscription', render: subscription },
  wallet: { title: 'Wallet', render: wallet },
  settings: { title: 'Settings', render: settings },
  lens: { title: 'Pipnex Trade Lens', render: lens },
  referral: { title: 'Refer & Earn', render: referral },
  tutorials: { title: 'How to Use', render: tutorials },
  research: { title: 'Market Research', render: research },
  'prop-firm': { title: 'Prop Firm Simulator', render: propFirm },
  'edge-stats': { title: 'Edge Stats', render: edgeStats },
  support: { title: 'Contact Support', render: support },
};

export const ctx = {
  profile: null,
  permissions: null,
};

/** Which sidebar entry is active for a given hash. */
export function routeFromHash() {
  const raw = (location.hash || '#/overview').replace(/^#\/?/, '');
  const name = raw.split('?')[0] || 'overview';
  return ROUTES[name] ? name : 'overview';
}

export async function renderRoute() {
  const name = routeFromHash();
  const route = ROUTES[name];
  const view = document.getElementById('view');

  document.getElementById('topTitle').textContent = route.title;
  document.querySelectorAll('.nav-item').forEach((a) => {
    a.classList.toggle('is-active', a.dataset.route === name);
  });

  view.replaceChildren(el('div', { class: 'empty' }, el('div', { class: 'skeleton', style: 'width:180px' }), el('div', { class: 'skeleton', style: 'width:100%;height:180px;margin-top:14px' })));

  try {
    const node = await route.render(ctx);
    view.replaceChildren(node);
  } catch (err) {
    view.replaceChildren(card('Something went wrong', {},
      el('p', { class: 'card__note', text: String(err && err.message ? err.message : err) }),
      el('div', { style: 'margin-top:14px' }, el('button', { class: 'btn btn--outline', onclick: () => renderRoute() }, 'Retry'))));
  }
  view.focus({ preventScroll: true });
}

export async function boot() {
  const stored = loadStoredSession();
  if (stored && hasSession()) setMode('live');

  ctx.profile = await api.profile.get();
  const plans = await api.plans.list();
  const sub = await api.subscription.get();
  ctx.permissions = permissionsFor(sub && sub.plan_key, plans);
  ctx.mode = getMode();

  const initials = (ctx.profile.display_name || 'PP').split(/\s+/).map((s) => s[0]).join('').slice(0, 2).toUpperCase();
  document.getElementById('sideAvatar').textContent = initials;
  document.getElementById('topAvatar').textContent = initials;
  document.getElementById('sideName').textContent = ctx.profile.display_name;
  document.getElementById('sideAccount').textContent = `${ctx.profile.account_id} · ${ctx.permissions.planName}`;
  document.getElementById('liveBadge').hidden = ctx.mode !== 'live';

  document.getElementById('bellDot').hidden = false;
  document.getElementById('bellBtn').addEventListener('click', () => {
    document.getElementById('bellDot').hidden = true;
    toast('No new notifications');
  });
  document.getElementById('themeBtn').addEventListener('click', () => toast('The operator surface is dark-only'));

  /* ---- sidebar: pins open, auto-hides on navigation, peeks on hover ----
     Desktop:  pinned  -> full grid column, labels visible
               docked  -> rail hidden, hover peeks it over the page, hamburger re-pins
     Mobile:   off-canvas drawer toggled by the hamburger */
  const side = document.getElementById('side');
  const PEEK_MS = 180;

  const isWide = () => window.innerWidth > 900;
  const setPinned = (pinned) => {
    document.body.classList.toggle('side-collapsed', !pinned);
    side.classList.toggle('is-collapsed', !pinned);
    if (pinned) document.body.classList.remove('side-peek');
  };
  const isDocked = () => document.body.classList.contains('side-collapsed');

  const collapse = () => {
    if (!isWide()) { side.classList.toggle('is-open'); return; }
    setPinned(isDocked());
  };
  document.getElementById('sideCollapse').addEventListener('click', collapse);
  document.getElementById('sideToggle').addEventListener('click', () => {
    if (!isWide()) { side.classList.toggle('is-open'); return; }
    setPinned(isDocked());
  });

  /* Navigation auto-hides the rail so the page gets the width back. */
  const autoDock = () => {
    if (isWide()) setPinned(false);
    side.classList.remove('is-open');
  };

  /* Hover on the left edge (or on the rail itself) reveals it; leaving hides it. */
  let peekTimer = null;
  const leftGuard = document.getElementById('sideEdge');
  const peek = (on) => {
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => {
      if (!isDocked()) return;
      document.body.classList.toggle('side-peek', on);
    }, on ? 0 : PEEK_MS);
  };
  leftGuard?.addEventListener('mouseenter', () => peek(true));
  side.addEventListener('mouseenter', () => peek(true));
  side.addEventListener('mouseleave', () => peek(false));
  leftGuard?.addEventListener('mouseleave', () => peek(false));

  /* Escape leaves the peek. */
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('side-peek')) {
      document.body.classList.remove('side-peek');
    }
  });

  window.addEventListener('resize', () => {
    if (!isWide()) { document.body.classList.remove('side-collapsed', 'side-peek'); side.classList.remove('is-collapsed'); }
  });

  /* Icon-rail mode hides the labels, so each item carries its name as a tooltip. */
  document.querySelectorAll('.nav-item').forEach((a) => {
    const label = a.querySelector('span')?.textContent?.trim();
    if (label) a.title = label;
  });

  /* Choosing a nav item docks the rail: the page keeps the width. */
  document.querySelector('.side__nav')?.addEventListener('click', (e) => {
    if (e.target.closest('.nav-item')) setTimeout(autoDock, 0);
  });

  window.addEventListener('hashchange', renderRoute);
  await renderRoute();
}
