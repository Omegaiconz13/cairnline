import { api, fmt } from '../data.js';
import { el, card, chip, table, toast } from '../ui.js';

/** Trade Lens — production /lens (Chrome extension product page). */
export async function lens(ctx) {
  const page = el('div', { class: 'page' });
  page.append(
    el('div', { class: 'page__head' },
      el('div', {},
        el('h2', { class: 'page__title', text: 'Pipnex Trade Lens' }),
        el('p', { class: 'page__sub', text: 'AI chart analysis inside TradingView.' })),
      chip(ctx.permissions.tradeLens ? 'Included in your plan' : 'Platinum feature', ctx.permissions.tradeLens ? 'chip--on' : 'chip--warn')),
    el('div', { class: 'grid grid--sidebar' },
      card('Bring the Pipnex brain to your chart', {},
        el('p', { class: 'card__note', text: 'A Chrome extension that reads your live TradingView chart and runs it through the Pipnex Market Brain — structure, order blocks, liquidity sweeps and a confidence-scored trade plan, right beside the chart you already trade.' }),
        el('div', { class: 'metrics', style: 'margin-top:20px' },
          el('div', { class: 'metric' }, el('div', { class: 'metric__k', text: 'Latency' }), el('div', { class: 'metric__v metric--accent' }, el('div', { class: 'metric__v metric__v--sm', text: '< 400 ms' }))),
          el('div', { class: 'metric' }, el('div', { class: 'metric__k', text: 'Timeframes' }), el('div', { class: 'metric__v metric__v--sm', text: 'M1 → W1' })),
          el('div', { class: 'metric' }, el('div', { class: 'metric__k', text: 'Pairs' }), el('div', { class: 'metric__v metric__v--sm', text: 'Forex · Metals' })))),
        el('div', { style: 'margin-top:20px;display:flex;gap:8px' },
          el('a', { class: 'btn btn--primary', href: 'https://chromewebstore.google.com/detail/pipnex-trade-lens/nepgnfpaipmeehkpcapbaglddhgppbhh' }, 'Install from Chrome Web Store'),
          el('button', { class: 'btn btn--outline', onclick: () => toast('Lens deep-link sent to your account email') }, 'Send me the link'))),
      card('How to install', {},
        el('ol', { style: 'padding-left:18px;color:var(--ice-dim);font-size:13px;line-height:2' },
          el('li', { text: 'Install the extension from the Chrome Web Store.' }),
          el('li', { text: 'Sign in with your Pipnex account.' }),
          el('li', { text: 'Open a TradingView chart — the Lens panel docks to the side.' }),
          el('li', { text: 'Ask for structure, liquidity or a full trade plan.' }))),
    card('Included with Platinum — no extra subscription.', { class: 'card--flush' }));
  return page;
}

/** Referral — production /referral. */
export async function referral(ctx) {
  const profile = await api.profile.get();
  const link = `https://pipnex-ai.com/?ref=${profile.account_id}`;
  const page = el('div', { class: 'page' });
  page.append(
    el('div', { class: 'page__head' },
      el('div', {},
        el('h2', { class: 'page__title', text: 'Earn Real Money By Sharing Pipnex' }),
        el('p', { class: 'page__sub', text: 'Share your link — earn when friends subscribe.' })),
      chip(`${profile.referral_count || 0} referrals`, 'chip--on')),
    el('div', { class: 'grid grid--sidebar' },
      card('Your referral link', {},
        el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
          el('input', { value: link, readonly: true, style: 'flex:1;min-width:240px;font-family:var(--mono);font-size:13px;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:12px 14px;color:var(--ice)' }),
          el('button', { class: 'btn btn--primary', onclick: async () => {
            try { await navigator.clipboard.writeText(link); toast('Link copied'); }
            catch { toast(link); }
          } }, 'Copy link')),
        el('div', { class: 'grid grid--3', style: 'margin-top:20px' },
          el('div', { class: 'stat' }, el('small', { text: 'Referrals' }), el('b', { text: String(profile.referral_count || 0) })),
          el('div', { class: 'stat' }, el('small', { text: 'Rewards' }), el('b', { text: fmt.money(0) })),
          el('div', { class: 'stat' }, el('small', { text: 'Withdrawable' }), el('b', { text: fmt.money(0) })))),
      card('How it works', {},
        el('ol', { style: 'padding-left:18px;color:var(--ice-dim);font-size:13px;line-height:2' },
          el('li', { text: 'Share your link with a friend.' }),
          el('li', { text: 'They sign up and subscribe to any paid plan.' }),
          el('li', { text: 'Your reward lands in your Pipnex wallet.' }),
          el('li', { text: 'Withdraw once you reach $75.00.' })))),
    card('Why join our referral program?', {},
      el('div', { class: 'grid grid--3' },
        el('div', {}, el('h3', { class: 'card__title', text: 'Earn cash per referral' }), el('p', { class: 'card__note', style: 'margin-top:6px', text: 'Paid on every subscription, tracked automatically.' })),
        el('div', {}, el('h3', { class: 'card__title', text: 'Easy withdrawals' }), el('p', { class: 'card__note', style: 'margin-top:6px', text: 'Straight to your preferred payment method.' })),
        el('div', {}, el('h3', { class: 'card__title', text: 'No limits' }), el('p', { class: 'card__note', style: 'margin-top:6px', text: 'Share as much as you like.' })))));
  return page;
}

/** Tutorials — production /tutorials (from the `tutorials` table). */
export async function tutorials(ctx) {
  const list = await api.tutorials.list();
  const cats = ['All', ...new Set(list.map((t) => t.category))];
  const grid = el('div', { class: 'grid grid--4' });
  const render = (filter) => {
    grid.innerHTML = '';
    list.filter((t) => filter === 'All' || t.category === filter).forEach((t) => {
      grid.append(el('a', { class: 'card', href: `https://www.youtube.com/watch?v=${t.youtube_id}`, target: '_blank', rel: 'noopener', style: 'display:block' },
        el('div', { style: 'aspect-ratio:16/10;border-radius:12px;border:1px solid var(--line);background:linear-gradient(160deg,#0E1518,#070C0E);display:grid;place-items:center' },
          el('div', { class: 'assistant__orb' }, el('span', { html: '<svg viewBox="0 0 20 20"><path d="M7 5.5v9l8-4.5-8-4.5Z"/></svg>' }))),
        el('div', { style: 'margin-top:14px' },
          el('span', { class: 'card__note', style: 'color:var(--aurora)', text: t.category.toUpperCase() }),
          el('h3', { style: 'font-size:14px;margin-top:6px;line-height:1.4', text: t.title }))));
    });
  };
  render('All');

  const page = el('div', { class: 'page' });
  page.append(
    el('div', { class: 'page__head' },
      el('div', {},
        el('h2', { class: 'page__title', text: 'Pipnex Video Tutorials' }),
        el('p', { class: 'page__sub', text: 'Short walkthroughs covering setup, MT5, chart analysis and running bots.' })),
      el('div', { class: 'tabs' }, cats.map((c, i) => el('button', {
        class: i === 0 ? 'is-active' : '',
        onclick: (e) => {
          [...e.currentTarget.parentNode.children].forEach((b) => b.classList.remove('is-active'));
          e.currentTarget.classList.add('is-active');
          render(c);
        },
        text: c,
      })))),
    grid);
  return page;
}

/** Support — production /support conversations. */
export async function support(ctx) {
  const note = el('p', { class: 'form__note' });
  const page = el('div', { class: 'page' });
  page.append(
    el('div', { class: 'page__head' },
      el('div', {},
        el('h2', { class: 'page__title', text: 'Contact Support' }),
        el('p', { class: 'page__sub', text: 'Your conversations with the Pipnex team.' })),
      chip('Mon–Fri 9:00–17:30 GMT', '')),
    el('div', { class: 'grid grid--sidebar' },
      card('New message', {},
        el('div', { class: 'form' },
          el('label', { class: 'field' }, el('span', { text: 'Subject' }), el('input', { placeholder: 'What is this about?' })),
          el('label', { class: 'field' }, el('span', { text: 'Message' }), el('textarea', { rows: '5', placeholder: "Tell us what's on your mind..." })),
          el('button', { class: 'btn btn--primary', style: 'justify-self:start', onclick: () => {
            note.textContent = 'Message sent — we reply within one business day.';
            note.className = 'form__note is-ok';
          } }, 'Send message'),
          note)),
      card('Other channels', {},
        el('dl', { class: 'kv' },
          el('dt', { text: 'Email' }), el('dd', { text: 'support@pipnex-ai.com' }),
          el('dt', { text: 'Phone' }), el('dd', { text: '+44 7462 221694' }),
          el('dt', { text: 'Address' }), el('dd', { text: "St Aldate's, Pembroke St, Oxford" }),
          el('dt', { text: 'Telegram' }), el('dd', { text: '@pipnex' })),
        el('div', { style: 'margin-top:16px' },
          el('button', { class: 'btn btn--outline btn--block', onclick: () => toast('Telegram link copied') }, 'Join Telegram')))));
  return page;
}
