import { api, fmt } from '../data.js';
import { el, card, metric, chip, toast } from '../ui.js';
import { market, px } from '../market.js';

/** TradingView's free ticker-tape widget: a moving ribbon, click-through to the chart. */
const TV_SYMBOLS = [
  { proName: 'FX:EURUSD', title: 'EUR/USD' },
  { proName: 'FX:GBPUSD', title: 'GBP/USD' },
  { proName: 'FX:USDJPY', title: 'USD/JPY' },
  { proName: 'FX:AUDUSD', title: 'AUD/USD' },
  { proName: 'FX:USDCHF', title: 'USD/CHF' },
  { proName: 'FX:EURJPY', title: 'EUR/JPY' },
  { proName: 'FX:GBPJPY', title: 'GBP/JPY' },
  { proName: 'OANDA:XAUUSD', title: 'Gold' },
  { proName: 'BITSTAMP:BTCUSD', title: 'BTC/USD' },
  { proName: 'TVC:USOIL', title: 'WTI' },
  { proName: 'TVC:DXY', title: 'DXY' },
  { proName: 'TVC:US10Y', title: 'US 10Y' },
];

function tickerTape() {
  const host = el('div', { class: 'tv-tape', 'aria-label': 'Live market ribbon' });
  const inner = el('div', { class: 'tradingview-widget-container' });
  const widget = el('div', { class: 'tradingview-widget-container__widget' });
  inner.append(widget);
  host.append(inner);

  // The embed script must be a real element: innerHTML never executes scripts.
  const script = document.createElement('script');
  script.type = 'text/javascript';
  script.async = true;
  script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-ticker-tape.js';
  script.textContent = JSON.stringify({
    symbols: TV_SYMBOLS,
    showSymbolLogo: true,
    isTransparent: false,   // transparent reveals the iframe's white body
    displayMode: 'adaptive',
    colorTheme: 'dark',
    locale: 'en',
  });
  inner.append(script);
  return host;
}

/** Overview — the operator's landing surface: ribbon, snapshot, today's signal. */
export async function overview(ctx) {
  const [profile, usage, wallet] = await Promise.all([
    api.profile.get(), api.usage.today(), api.wallet.get(),
  ]);
  const walletCents = (wallet && wallet.available_cents) || 0;

  const page = el('div', { class: 'page' });

  /* ---- welcome + account facts, one band ---- */
  page.append(el('section', { class: 'banner' },
    el('div', {},
      el('h2', { text: 'Welcome to PipNex' }),
      el('p', { text: 'Your all-in-one AI trading intelligence platform.' }))));

  /* ---- snapshot ---- */
  page.append(card('Quick Performance Snapshot', { note: 'Today' },
    el('div', { class: 'metrics' },
      metric('AI Analyses Today', String(usage.analyses)),
      metric('Signals Generated', String(usage.signals)),
      metric('Charts Analyzed', String(usage.charts)),
      metric('Preferred Strategy', usage.preferred_strategy || 'Not Selected', { small: true }),
      metric('AI Confidence (Avg)', usage.avg_confidence === null ? '—' : `${usage.avg_confidence}%`),
      metric('Auto-Trading', usage.auto_trading ? 'ON' : 'OFF', { small: true }),
      metric('Copy Trading', usage.copy_trading, { small: true })),
    el('div', { class: 'snapshot__cta' },
      el('button', { class: 'btn btn--primary', onclick: () => { location.hash = '#/chart'; } }, 'Start AI Trading'))));


  /* ---- Signal of the Day: entry, exit, confidence. Nothing else. ---- */
  const signalCard = card('Signal of the Day', { note: 'computing…' },
    el('div', { class: 'empty' },
      el('h3', { text: 'Reading live bars…' }),
      el('div', { class: 'skeleton', style: 'width:70%;margin-top:10px' }),
      el('div', { class: 'skeleton', style: 'width:52%;margin-top:8px' })));

  page.append(signalCard);

  /* ---- the ribbon sits under the signal, above the calendar ---- */
  page.append(tickerTape());

  market.basketSignals('15m').then((data) => {
    const top = data.top;
    const pairs = data.signals.filter((s) => !s.error).length;
    signalCard.replaceChildren(
      el('div', { class: 'card__head' },
        el('h2', { class: 'card__title', text: 'Signal of the Day' }),
        el('span', { class: 'card__note', text: `${pairs} pairs · ${new Date(data.fetched_at).toLocaleTimeString()}` })),
      top
        ? el('div', { class: 'signal' },
            el('div', { class: 'signal__id' },
              el('b', { class: 'signal__sym', text: top.symbol }),
              chip(String(top.bias).toUpperCase(), top.bias === 'long' ? 'chip--on' : 'chip--danger')),
            el('div', { class: 'signal__levels' },
              el('div', { class: 'signal__level' },
                el('small', { text: 'ENTRY' }), el('b', { text: px(top.entry) })),
              el('div', { class: 'signal__level signal__level--stop' },
                el('small', { text: 'STOP LOSS' }), el('b', { text: px(top.stop_loss) })),
              el('div', { class: 'signal__level signal__level--target' },
                el('small', { text: 'TAKE PROFIT' }), el('b', { text: px(top.take_profit) }))),
            el('div', { class: 'signal__conf' },
              el('small', { text: 'CONFIDENCE' }),
              el('b', { text: `${top.confidence}%` }),
              el('div', { class: 'progress', style: 'margin-top:8px' },
                el('i', { style: `width:${top.confidence}%` }))),
            el('button', { class: 'btn btn--outline btn--sm', onclick: () => { location.hash = '#/chart'; } }, 'Open in AI Trading'))
        : el('div', { class: 'empty' }, el('h3', { text: 'No signal produced' }), el('p', { text: 'The indicator engine returned no ranked pair.' })));
  }).catch((err) => {
    signalCard.replaceChildren(
      el('div', { class: 'card__head' }, el('h2', { class: 'card__title', text: 'Signal of the Day' }),
        chip('offline', 'chip--warn')),
      el('div', { class: 'empty' },
        el('h3', { text: 'Market service not running' }),
        el('p', { text: 'Start it with python3 server/market_service.py to compute signals from real bars.' }),
        el('p', { class: 'card__note', text: String(err.message || err).slice(0, 140) })));
  });

  /* ---- NewsIQ: real macro events from LSE Data's economic calendar ---- */
  const newsBody = el('div', { class: 'news' },
    el('div', { class: 'empty' }, el('h3', { text: 'Loading calendar…' }),
      el('div', { class: 'skeleton', style: 'width:60%;margin-top:10px' })));
  const newsCard = card('NewsIQ — Upcoming Macro Events', { note: 'NFP & CPI releases affecting XAUUSD and USD pairs' },
    el('div', { class: 'tabs', style: 'margin-bottom:14px' },
      el('button', { class: 'is-active', 'data-impact': 'all', text: 'All' }),
      el('button', { 'data-impact': 'high', text: 'High impact' })),
    newsBody);

  const renderNews = (events, filter) => {
    const shown = filter === 'all' ? events : events.filter((e) => e.impact === 'high');
    newsBody.replaceChildren();
    if (!shown.length) {
      newsBody.append(el('div', { class: 'empty' },
        el('h3', { text: filter === 'high' ? 'No high-impact events this week' : 'No upcoming events' }),
        el('p', { text: 'The calendar is read from LSE Data 3.0; nothing is invented when it is empty.' })));
      return;
    }
    // group same-time clusters the way the real product does
    const rows = shown.slice(0, 8).map((e) => {
      const mins = e.in_minutes;
      const when = new Date(e.at);
      const countdown = mins <= 0 ? 'released'
        : mins < 60 ? `${mins}m`
        : mins < 1440 ? `${Math.floor(mins / 60)}h ${mins % 60}m`
        : `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`;
      return el('div', { class: 'news__row' },
        el('span', { class: `news__impact news__impact--${e.impact}`, title: `${e.impact} impact` }),
        el('div', { class: 'news__main' },
          el('div', { class: 'news__top' },
            el('b', { text: e.event }),
            el('span', { class: 'card__note', text: `${e.region} · ${when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} UTC` })),
          el('div', { class: 'card__note', text:
            `Consensus: ${e.consensus ?? '—'} · Previous: ${e.previous ?? '—'}` + (e.actual != null ? ` · Actual: ${e.actual}` : '') })),
        el('span', { class: `news__count news__count--${mins <= 120 ? 'soon' : ''}`, text: countdown }),
        el('button', {
          class: 'btn btn--outline btn--sm',
          onclick: () => { location.hash = '#/upload'; },
        }, 'AI Analyze'));
    });
    // The soonest high-impact print gets promoted, the way the real desk flags "Next Up".
    const nextUp = shown.find((e) => e.impact === 'high' && e.in_minutes >= 0 && e.in_minutes < 2880);
    if (nextUp) {
      const when = new Date(nextUp.at);
      const mins = nextUp.in_minutes;
      const countdown = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${Math.floor(mins / 1440)}d`;
      newsBody.append(el('div', { class: 'news__next' },
        el('span', { class: 'card__note', text: 'NEXT UP' }),
        el('div', { class: 'news__top' },
          el('b', { text: nextUp.event }),
          el('span', { class: 'card__note', text: `${nextUp.region} · ${when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} UTC` })),
        el('span', { class: 'news__count news__count--soon', text: countdown })));
    }
    newsBody.append(el('div', { class: 'news__list' }, ...rows),
      el('p', { class: 'card__note', style: 'margin-top:12px',
        text: `${shown.length} event${shown.length === 1 ? '' : 's'} · impact derived from the event type, not supplied by the source.` }));
  };

  market.calendar('US', 7).then((data) => {
    const events = data.events || [];
    let filter = 'all';
    renderNews(events, filter);
    newsCard.querySelectorAll('.tabs button').forEach((btn) => {
      btn.addEventListener('click', () => {
        newsCard.querySelectorAll('.tabs button').forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        filter = btn.dataset.impact;
        renderNews(events, filter);
      });
    });
    const high = events.filter((e) => e.impact === 'high').length;
    const note = newsCard.querySelector('.card__note');
    if (note) note.textContent = `${high ? `${high} high-impact · ` : ''}NFP & CPI releases affecting XAUUSD and USD pairs`;
  }).catch((err) => {
    newsBody.replaceChildren(el('div', { class: 'empty' },
      el('h3', { text: 'Calendar unavailable' }),
      el('p', { text: 'NewsIQ reads LSE Data 3.0. Add a key in Settings → Data, or start the market service.' }),
      el('p', { class: 'card__note', text: String(err.message || err).slice(0, 120) })));
  });

  page.append(newsCard);

  /* ---- referral program ---- */
  const limit = ctx.permissions.dailyUploadLimit;
  const refLink = `https://pipnex-ai.com/auth?ref=${profile.account_id}`;
  page.append(card('Referral Program', { note: 'earn when your referrals subscribe' },
    el('div', { class: 'grid grid--2', style: 'align-items:start' },
      el('div', {},
        el('dl', { class: 'kv' },
          el('dt', { text: 'Your account ID' }), el('dd', { text: profile.account_id }),
          el('dt', { text: 'Referral link' }),
          el('dd', {}, el('code', { style: 'font-size:11px', text: refLink })))),
      el('div', { class: 'refstats' },
        el('div', { class: 'metric' }, el('div', { class: 'metric__k', text: 'Balance' }), el('div', { class: 'metric__v metric__v--sm', text: fmt.money(walletCents) })),
        el('div', { class: 'metric' }, el('div', { class: 'metric__k', text: 'Withdraw min' }), el('div', { class: 'metric__v metric__v--sm', text: '$75.00' })))),
    el('p', { class: 'card__note', style: 'margin-top:14px', text: 'Commission: $5 Pro · $10 Ultimate · $36 Platinum, paid when a referral subscribes.' })));

  /* ---- tools + account status ---- */
  page.append(
    card('Your Tools & Shortcuts', { note: 'open a tool in its own page' },
      el('div', { class: 'tools' },
        el('a', { class: 'tool', href: '#/prop-firm' },
          el('b', { text: 'Prop Firm Simulator' }),
          el('small', { text: 'Monte Carlo of challenge rules — pass odds, expected cost, EV' })),
        el('a', { class: 'tool', href: '#/edge-stats' },
          el('b', { text: 'Edge Stats' }),
          el('small', { text: 'P(outcome | condition) on real bars, with sample size' })),
        el('a', { class: 'tool', href: '#/chart' },
          el('b', { text: 'Position Size Calculator' }),
          el('small', { text: 'Size a trade from the live ATR stop' })),
        el('a', { class: 'tool', href: '#/upload' },
          el('b', { text: 'Top-down Analysis' }),
          el('small', { text: 'Multi-timeframe read across attached charts' })),
        el('a', {
          class: 'tool tool--ext', href: 'https://github.com/LuxAlgo', target: '_blank', rel: 'noopener',
        },
          el('b', { text: 'LuxAlgo open-source tools ↗' }),
          el('small', { text: 'Trade Journal · Options Flow · Broker SDK · Trade Relay (MIT)' })))));


  return page;
}
