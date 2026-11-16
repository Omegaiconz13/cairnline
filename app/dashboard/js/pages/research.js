import { el, card, chip, table, toast } from '../ui.js';
import { market, px } from '../market.js';
import { fmt } from '../data.js';

const DATASETS = [
  { key: 'insider', label: 'Insider filings', note: 'SEC Form 4 · who bought and sold' },
  { key: 'short-volume', label: 'Short volume', note: 'FINRA daily short-sale volume' },
  { key: 'congress', label: 'Congress trades', note: 'Disclosures by members of Congress' },
  { key: 'fed', label: 'Fed communications', note: 'FOMC statements and speeches' },
];

/**
 * Market Research — real public-record data from LuxAlgo market-trackers-data (CC0).
 * Every row carries a provenance link to the primary-source document.
 */
export async function research(ctx) {
  const page = el('div', { class: 'page' });

  /* ---- COT: managed-money positioning (LSE Data 3.0, free plan) ---- */
  const cotBody = el('div', {}, el('div', { class: 'empty' }, el('h3', { text: 'Reading COT…' })));
  const cotSel = el('select', { class: 'uploads__tf' },
    [['GC', 'Gold'], ['SI', 'Silver'], ['CL', 'Crude'], ['6E', 'Euro FX'], ['6B', 'Pound'], ['6J', 'Yen'], ['BTC', 'Bitcoin']]
      .map(([v, t]) => el('option', { value: v, text: `${t} (${v})` })));
  const cotCard = card('COT positioning', { note: 'net non-commercial · weekly' },
    el('div', { style: 'display:flex;gap:10px;align-items:center;margin-bottom:14px' },
      cotSel, el('span', { class: 'card__note', text: 'Commitments of Traders' })),
    cotBody);

  const paintCot = async () => {
    cotBody.replaceChildren(el('div', { class: 'empty' }, el('h3', { text: 'Reading COT…' })));
    try {
      const d = await market.cot(cotSel.value);
      const l = d.latest || {};
      const pct = d.percentile_3y;
      const max = Math.max(...d.series.map(Math.abs), 1);
      cotBody.replaceChildren(
        el('div', { class: 'metrics' },
          el('div', { class: 'metric' },
            el('div', { class: 'metric__k', text: 'Net position' }),
            el('div', { class: `metric__v ${l.net >= 0 ? 'metric--accent' : 'neg'}`, text: `${l.net >= 0 ? '+' : ''}${Number(l.net).toLocaleString()}` })),
          el('div', { class: 'metric' },
            el('div', { class: 'metric__k', text: '3Y percentile' }),
            el('div', { class: 'metric__v', text: pct == null ? '—' : `${pct}%` })),
          el('div', { class: 'metric' },
            el('div', { class: 'metric__k', text: 'Long / short' }),
            el('div', { class: 'metric__v metric__v--sm', text: `${Number(l.long).toLocaleString()} / ${Number(l.short).toLocaleString()}` })),
          el('div', { class: 'metric' },
            el('div', { class: 'metric__k', text: 'As of' }),
            el('div', { class: 'metric__v metric__v--sm', text: l.date || '—' }))),
        // sparkline of the last year of net positioning
        el('div', { class: 'cot-spark', style: 'margin-top:16px' },
          ...d.series.map((v) => el('i', {
            class: v >= 0 ? 'up' : 'down',
            style: `height:${(Math.abs(v) / max * 100).toFixed(1)}%`,
            title: `${v >= 0 ? '+' : ''}${v.toLocaleString()}`,
          }))),
        el('p', { class: 'card__note', style: 'margin-top:12px',
          text: `${d.name || d.symbol} · ${d.weeks} weeks of history · percentile ranks the latest net against that window. Source lse-data, CFTC-derived.` }));
    } catch (err) {
      cotBody.replaceChildren(el('div', { class: 'empty' },
        el('h3', { text: 'COT unavailable' }),
        el('p', { text: 'Needs an LSE key in Settings → Data.' }),
        el('p', { class: 'card__note', text: String(err.message || err).slice(0, 120) })));
    }
  };
  cotSel.addEventListener('change', paintCot);
  paintCot();

  const head = el('div', { class: 'page__head' },
    el('div', {},
      el('h2', { class: 'page__title', text: 'Market Research' }),
      el('p', { class: 'page__sub', text: 'Public record, US markets · LuxAlgo market-trackers-data (CC0) · every row links to its source document.' })),
    el('div', { style: 'display:flex;gap:8px;align-items:center' },
      chip('CC0 data', 'chip--on'),
      el('button', { class: 'btn btn--outline btn--sm', onclick: () => toast('Refresh clears the 6-hour cache on the service side') }, 'Refresh')));

  const datasetBar = el('div', { class: 'tabs' });
  const body = el('div');
  const tickerInput = el('input', { placeholder: 'Filter by ticker (e.g. AAPL)', style: 'max-width:220px' });

  let active = 'insider';

  const rowBuilders = {
    insider: (rows) => table([
      { label: 'Ticker', render: (r) => chip(r.ticker || '—', 'chip--mono') },
      { label: 'Issuer', render: (r) => String(r.issuerName || '—').slice(0, 34) },
      { label: 'Insider', render: (r) => `${r.insider?.name || '—'}${r.insider?.title ? ` · ${String(r.insider.title).slice(0, 26)}` : ''}` },
      { label: 'Type', render: (r) => chip(`${r.code || '?'} ${r.acquiredDisposed === 'A' ? 'acquired' : 'disposed'}`, r.acquiredDisposed === 'A' ? 'chip--on' : 'chip--danger') },
      { label: 'Shares', num: true, render: (r) => Number(r.shares || 0).toLocaleString() },
      { label: 'Price', num: true, render: (r) => (r.pricePerShare ? px(r.pricePerShare) : '—') },
      { label: 'Value', num: true, render: (r) => (r.shares && r.pricePerShare ? `$${Math.round(r.shares * r.pricePerShare).toLocaleString()}` : '—') },
      { label: 'Filed', render: (r) => r.filedAt || '—' },
      { label: 'Source', render: (r) => (r.provenance?.sourceUrl ? el('a', { href: r.provenance.sourceUrl, target: '_blank', rel: 'noopener', class: 'chip chip--on', text: 'EDGAR' }) : '—') },
    ], rows, { emptyTitle: 'No filings for that filter', emptyText: 'Try another ticker or clear the filter.' }),

    'short-volume': (rows) => table([
      { label: 'Ticker', render: (r) => chip(r.ticker || '—', 'chip--mono') },
      { label: 'Date', render: (r) => r.date || '—' },
      { label: 'Market', render: (r) => r.market || '—' },
      { label: 'Short vol', num: true, render: (r) => Number(r.shortVolume || 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) },
      { label: 'Total vol', num: true, render: (r) => Number(r.totalVolume || 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) },
      { label: 'Ratio', num: true, render: (r) => `<span class="${r.shortRatio > 0.5 ? 'neg' : 'pos'}">${(Number(r.shortRatio || 0) * 100).toFixed(1)}%</span>` },
      { label: 'Source', render: (r) => (r.provenance?.sourceUrl ? el('a', { href: r.provenance.sourceUrl, target: '_blank', rel: 'noopener', class: 'chip', text: 'FINRA' }) : '—') },
    ], rows, { emptyTitle: 'No short-volume rows', emptyText: 'FINRA publishes this daily.' }),

    congress: (rows) => table([
      { label: 'Ticker', render: (r) => chip(r.ticker || '—', 'chip--mono') },
      { label: 'Member', render: (r) => r.memberName || r.filerName || '—' },
      { label: 'Type', render: (r) => chip(`${r.transactionType || r.type || '—'}`, '') },
      { label: 'Amount', render: (r) => r.amount || r.amountRange || '—' },
      { label: 'Traded', render: (r) => r.transactionDate || r.transactedAt || '—' },
      { label: 'Filed', render: (r) => r.filedAt || '—' },
      { label: 'Source', render: (r) => (r.provenance?.sourceUrl ? el('a', { href: r.provenance.sourceUrl, target: '_blank', rel: 'noopener', class: 'chip', text: 'source' }) : '—') },
    ], rows, { emptyTitle: 'No disclosures', emptyText: 'Congress publishes these with a delay.' }),

    fed: (rows) => table([
      { label: 'Date', render: (r) => r.publishedAt || r.date || '—' },
      { label: 'Kind', render: (r) => chip(r.kind || r.type || '—', '') },
      { label: 'Title', render: (r) => String(r.title || '—').slice(0, 70) },
      { label: 'Speaker', render: (r) => r.speaker || r.author || '—' },
      { label: 'Source', render: (r) => (r.provenance?.sourceUrl ? el('a', { href: r.provenance.sourceUrl, target: '_blank', rel: 'noopener', class: 'chip', text: 'federalreserve.gov' }) : '—') },
    ], rows, { emptyTitle: 'No communications', emptyText: 'FOMC releases appear here after publication.' }),
  };

  async function load() {
    body.replaceChildren(el('div', { class: 'card' },
      el('div', { class: 'skeleton', style: 'height:14px;width:180px' }),
      el('div', { class: 'skeleton', style: 'height:120px;margin-top:14px' })));
    try {
      const ticker = tickerInput.value.trim() || null;
      const data = await market.publicRecord(active, { ticker, limit: 40 });
      const builder = rowBuilders[active];
      body.replaceChildren(card(`${DATASETS.find((d) => d.key === active).label}`, {
        note: `${data.total} matching rows · ${data.source}`,
      }, builder(data.rows || []),
        el('p', { class: 'card__note', style: 'margin-top:12px',
          text: `Fetched ${new Date(data.fetched_at).toLocaleString()} · cached for 6 hours · ${data.total} rows matched before the limit.` })));
    } catch (err) {
      body.replaceChildren(card('Dataset unavailable', {},
        el('div', { class: 'empty' },
          el('h3', { text: 'Could not read the public record' }),
          el('p', { text: 'The market service fetches these dumps from GitHub and caches them locally.' }),
          el('p', { class: 'card__note', text: String(err.message || err).slice(0, 160) }))));
    }
  }

  DATASETS.forEach((d, i) => {
    datasetBar.append(el('button', {
      class: i === 0 ? 'is-active' : '',
      onclick: (e) => {
        active = d.key;
        [...datasetBar.children].forEach((b) => b.classList.remove('is-active'));
        e.currentTarget.classList.add('is-active');
        load();
      },
      text: d.label,
    }));
  });
  tickerInput.addEventListener('change', load);

  page.append(head, cotCard,
    el('div', { class: 'grid grid--4' },
      DATASETS.map((d) => el('div', { class: 'stat' },
        el('small', { text: d.label }),
        el('b', { style: 'font-size:15px', text: d.note }),
        el('span', { text: 'LuxAlgo · CC0' })))),
    card('', { class: 'card--flush' }, el('div', { style: 'padding:16px 20px;display:flex;gap:10px;align-items:center;flex-wrap:wrap' }, datasetBar, tickerInput)),
    body);

  load();
  return page;
}
