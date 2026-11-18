/**
 * Options Flow — the live LSE options chain and tape, turned into exposure.
 *
 * What is real: every print, its premium, its Greeks, the chain, the underlying
 * price. What is derived: gamma exposure and max pain, weighted by contracts
 * that actually traded in the window because this feed carries no open
 * interest. What is unavailable is listed on the page rather than filled in —
 * the engine refuses to invent prints, and so does the page.
 */
import { el, card, chip, table as tableEl, field, empty } from '../ui.js';
import { market } from '../market.js';

const SYMBOLS = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'TSLA', 'IWM', 'META', 'AMZN'];
const WINDOWS = [['1d', 'Today'], ['7d', 'Last 7 days']];
const PREMIUMS = [['', 'any premium'], ['100000', '≥ $100k'], ['250000', '≥ $250k'], ['1000000', '≥ $1M']];

const money = (v) => {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  const n = Number(v);
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
};
const pct = (v) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v}%`);
const clock = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso).slice(11, 19) : d.toISOString().slice(11, 19);
};

/** A card whose body really collapses — the same idea as the chart's pane buttons. */
function section(title, note, ...body) {
  const bodyEl = el('div', { class: 'of__body' }, ...body);
  const btn = el('button', {
    class: 'of__toggle', type: 'button', 'aria-expanded': 'true', title: 'Collapse this section',
  }, 'Collapse');
  btn.addEventListener('click', () => {
    const collapsed = bodyEl.classList.toggle('is-collapsed');
    btn.textContent = collapsed ? 'Expand' : 'Collapse';
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.title = collapsed ? 'Expand this section' : 'Collapse this section';
  });
  return card(title, { action: el('div', { class: 'of__headActions' },
    note ? el('span', { class: 'card__note', text: note }) : null,
    btn) }, bodyEl);
}

export async function optionsFlow() {
  const page = el('div', { class: 'page' });
  const out = el('div');

  const symInput = el('input', { type: 'text', value: 'SPY', list: 'ofSymbols', spellcheck: 'false' });
  const datalist = el('datalist', { id: 'ofSymbols' }, SYMBOLS.map((s) => el('option', { value: s })));
  const windowSel = el('select', {}, WINDOWS.map(([v, t]) => el('option', { value: v, text: t, selected: v === '7d' })));
  const premiumSel = el('select', {}, PREMIUMS.map(([v, t]) => el('option', { value: v, text: t })));
  const loadBtn = el('button', { class: 'btn btn--primary' }, 'Load flow');

  const renderUnavailable = (p) => {
    out.replaceChildren(card('Options data unavailable', { note: p.source ? `source: ${p.source}` : undefined },
      el('div', { class: 'empty' },
        el('h3', { text: 'No options numbers were produced' }),
        el('p', { class: 'card__note', text: String(p.reason || 'the provider returned nothing').slice(0, 400) }),
        el('p', { class: 'card__note', text: `Checked ${p.generated_at || 'just now'}. This page renders no sample prints, no synthetic premium and no invented notional — when the feed is empty, it says so.` }))));
  };

  const gexBars = (gex, spot) => {
    if (!gex || !gex.available || !gex.by_strike.length) {
      return el('p', { class: 'card__note', text: (gex && gex.reason) || 'No exposure could be weighted.' });
    }
    const near = gex.by_strike.filter((r) => Math.abs(r.strike - spot) / spot <= 0.08);
    const pick = (near.length ? near : gex.by_strike)
      .slice()
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
      .slice(0, 16)
      .sort((a, b) => a.strike - b.strike);
    const maxAbs = Math.max(...pick.map((r) => Math.abs(r.net)), 1);
    return el('div', { class: 'bars' }, pick.map((r) => el('div', { class: 'bars__row' },
      el('span', { class: 'bars__label', text: String(r.strike) }),
      el('div', { class: 'bars__track' },
        el('i', { class: r.net >= 0 ? 'gex--pos' : 'gex--neg', style: `width:${Math.max(2, (Math.abs(r.net) / maxAbs) * 100).toFixed(1)}%` })),
      el('span', { class: 'bars__val', text: money(r.net) }))));
  };

  /**
   * The smile as one SVG: strike across, IV up, one line per expiry, spot marked.
   * Only strikes the chain published an IV for are drawn — no interpolation.
   */
  const smileChart = (smile, spot) => {
    if (!smile || !smile.available || !(smile.expiries || []).length) {
      return el('p', { class: 'card__note', text: (smile && smile.reason) || 'No implied-volatility points in this chain.' });
    }
    const colours = ['#B4FF3A', '#4EA1FF', '#E9C46A'];
    const series = smile.expiries;
    const strikes = series.flatMap((s) => s.points.map((q) => q.strike));
    const ivs = series.flatMap((s) => s.points.map((q) => q.iv));
    const minX = Math.min(...strikes);
    const maxX = Math.max(...strikes);
    // Deep wings can print 300% IV and flatten the 20–40% region that matters.
    // The axis spans the 5th–95th percentile and the clip is disclosed below.
    const sortedIvs = [...ivs].sort((a, b) => a - b);
    const q = (f) => sortedIvs[Math.min(sortedIvs.length - 1, Math.max(0, Math.floor(f * (sortedIvs.length - 1))))];
    const loQ = q(0.05);
    const hiQ = q(0.95);
    const minY = hiQ > loQ ? Math.max(0, loQ - 1) : Math.min(...ivs);
    const maxY = hiQ > loQ ? hiQ + 1 : Math.max(...ivs);
    const W = 640;
    const H = 250;
    const L = 44;
    const R = 16;
    const T = 12;
    const B = 28;
    const X = (v) => L + ((v - minX) / (maxX - minX || 1)) * (W - L - R);
    const Y = (v) => T + (1 - ((v - minY) / ((maxY - minY) || 1))) * (H - T - B);
    const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const y = T + f * (H - T - B);
      const v = maxY - f * (maxY - minY);
      return `<line x1="${L}" y1="${y.toFixed(1)}" x2="${W - R}" y2="${y.toFixed(1)}" stroke="#202124" stroke-width="1"/>`
        + `<text x="${L - 6}" y="${(y + 3).toFixed(1)}" fill="#8A9499" font-family="JetBrains Mono, monospace" font-size="9" text-anchor="end">${v.toFixed(1)}%</text>`;
    }).join('');
    const xTicks = [0, 0.5, 1].map((f) => {
      const v = minX + f * (maxX - minX);
      return `<text x="${X(v).toFixed(1)}" y="${H - 8}" fill="#8A9499" font-family="JetBrains Mono, monospace" font-size="9" text-anchor="middle">${v}</text>`;
    }).join('');
    const spotMark = Number.isFinite(spot) && spot >= minX && spot <= maxX
      ? `<line x1="${X(spot).toFixed(1)}" y1="${T}" x2="${X(spot).toFixed(1)}" y2="${H - B}" stroke="#F5F7F8" stroke-width="1" stroke-dasharray="3 3" opacity="0.7"/>`
        + `<text x="${(X(spot) + 4).toFixed(1)}" y="${T + 10}" fill="#F5F7F8" font-family="JetBrains Mono, monospace" font-size="9">spot ${spot}</text>`
      : '';
    const paths = series.map((s, i) => `<polyline points="${s.points.map((pt) => `${X(pt.strike).toFixed(1)},${Y(pt.iv).toFixed(1)}`).join(' ')}" fill="none" stroke="${colours[i % colours.length]}" stroke-width="1.6" stroke-linejoin="round"/>`).join('');
    return el('div', { class: 'of__chart' },
      el('div', { class: 'of__legend' }, series.map((s, i) => {
        const iv = s.nearest_iv_pct === null || s.nearest_iv_pct === undefined ? '—' : `${s.nearest_iv_pct}%`;
        return el('span', {},
          el('i', { style: `background:${colours[i % colours.length]}` }),
          `${s.expiry}${s.dte === null || s.dte === undefined ? '' : ` · ${s.dte}d`} · nearest IV ${iv}`);
      })),
      el('div', { html: `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Implied volatility by strike">${grid}${xTicks}${spotMark}${paths}</svg>` }),
      el('p', { class: 'card__note', text: 'The IV axis spans the 5th–95th percentile of the plotted points so the near-the-money smile stays readable; wings outside that range are clipped at the chart edge.' }));
  };

  const paint = (p) => {
    if (!p || p.available === false) {
      renderUnavailable(p || { reason: 'the market service returned an empty response' });
      return;
    }
    const gex = p.gex || {};
    const pain = p.max_pain || {};
    const whale = p.whale || {};
    const flow = p.flow || {};
    const levels = p.levels || {};
    const flip = levels.gamma_flip || {};
    const wallsOut = levels.walls || {};
    const smile = p.iv_smile || {};

    const header = el('div', { class: 'page__head' },
      el('div', {},
        el('h2', { class: 'page__title', text: 'Options Flow' }),
        el('p', { class: 'page__sub', text: `${p.underlying} · ${p.counts.contracts} listed contracts · ${p.counts.prints} prints in the ${p.window.label} window · source ${p.source} (${p.feed})` })),
      chip(`as of ${clock(p.as_of)}`, 'chip--on'));

    const metrics = el('div', { class: 'metrics' },
      el('div', { class: 'metric' },
        el('div', { class: 'metric__k', text: 'Underlying' }),
        el('div', { class: 'metric__v', text: String(p.underlying_price) }),
        el('div', { class: 'card__note', text: `${p.counts.expiries} expiries listed` })),
      el('div', { class: 'metric' },
        el('div', { class: 'metric__k', text: 'Gamma exposure' }),
        el('div', { class: 'metric__v metric__v--sm', text: gex.available ? money(gex.total_usd_per_pct) : '—' }),
        el('div', { class: 'card__note', text: gex.available ? `per 1% move · basis ${gex.basis}` : (gex.reason || 'unavailable') })),
      el('div', { class: 'metric metric--accent' },
        el('div', { class: 'metric__k', text: 'Max pain' }),
        el('div', { class: 'metric__v', text: pain.available ? String(pain.strike) : '—' }),
        el('div', { class: 'card__note', text: pain.available ? `${pct(pain.distance_pct)} from spot · basis ${pain.basis}` : (pain.reason || 'unavailable') })),
      el('div', { class: 'metric' },
        el('div', { class: 'metric__k', text: 'Whale score' }),
        el('div', { class: 'metric__v', text: whale.available ? String(whale.score) : '—' }),
        el('div', { class: 'card__note', text: whale.available ? `${whale.label} · ${flow.prints ? flow.prints.length : 0} prints shown` : (whale.reason || 'unavailable') })));

    const wallNote = (row) => (row
      ? `${pct(row.distance_pct)} from spot · ${money(row.exposure)} exposure`
      : 'no exposure on that side of spot');

    const levelsCard = section('Key levels', 'a repriced gamma flip, plus the heaviest strike on each side',
      el('div', { class: 'metrics' },
        el('div', { class: 'metric metric--accent' },
          el('div', { class: 'metric__k', text: 'Gamma flip' }),
          el('div', { class: 'metric__v', text: flip.available ? String(flip.price) : '—' }),
          el('div', { class: 'card__note', text: flip.available
            ? `${pct(flip.distance_pct)} from spot · ${flip.model.legs_with_iv}/${flip.model.legs} legs repriced`
            : (flip.reason || 'unavailable') })),
        el('div', { class: 'metric' },
          el('div', { class: 'metric__k', text: 'Call wall' }),
          el('div', { class: 'metric__v', text: wallsOut.call ? String(wallsOut.call.strike) : '—' }),
          el('div', { class: 'card__note', text: wallNote(wallsOut.call) })),
        el('div', { class: 'metric' },
          el('div', { class: 'metric__k', text: 'Put wall' }),
          el('div', { class: 'metric__v', text: wallsOut.put ? String(wallsOut.put.strike) : '—' }),
          el('div', { class: 'card__note', text: wallNote(wallsOut.put) })),
        el('div', { class: 'metric' },
          el('div', { class: 'metric__k', text: 'Flip crossings' }),
          el('div', { class: 'metric__v metric__v--sm', text: flip.available ? String((flip.crossings || []).length) : '—' }),
          el('div', { class: 'card__note', text: flip.available
            ? `within ±${flip.model.span_pct}% of spot · ${(flip.crossings || []).join(' / ')}`
            : 'search ±25% of spot' }))),
      el('p', { class: 'card__note', style: 'margin-top:10px', text: flip.available
        ? `${flip.basis}. The flip is re-derived at every candidate price; it is not the cumulative strike-sum crossing shown in the exposure section.`
        : 'The flip is unavailable for this chain, and no substitute number is shown.' }),
      el('p', { class: 'card__note', style: 'margin-top:8px', text: 'Walls and flip use the same traded-contract weights as the exposure curve. This is not an open-interest board.' }));

    const smileCard = section('IV smile', smile.available
      ? `${smile.expiries.length} nearest ${smile.expiries.length === 1 ? 'expiry' : 'expiries'} · out-of-the-money stitched`
      : 'not computable from this chain',
      smileChart(smile, p.underlying_price),
      el('p', { class: 'card__note', style: 'margin-top:10px', text: smile.basis || '' }));

    const flowCard = section('Flow', 'dollar premium of the tape, newest prints ranked by size',
      el('div', { class: 'metrics', style: 'margin-bottom:14px' },
        el('div', { class: 'metric' }, el('div', { class: 'metric__k', text: 'Total premium' }), el('div', { class: 'metric__v metric__v--sm', text: money(flow.total_premium) })),
        el('div', { class: 'metric' }, el('div', { class: 'metric__k', text: 'Call premium' }), el('div', { class: 'metric__v metric__v--sm', text: money(flow.call_premium) })),
        el('div', { class: 'metric' }, el('div', { class: 'metric__k', text: 'Put premium' }), el('div', { class: 'metric__v metric__v--sm', text: money(flow.put_premium) })),
        el('div', { class: 'metric' }, el('div', { class: 'metric__k', text: 'Put/call' }), el('div', { class: 'metric__v metric__v--sm', text: flow.put_call_ratio === null ? '—' : String(flow.put_call_ratio) }))),
      flow.available
        ? tableEl([
            { key: 'ts', label: 'UTC', render: (r) => clock(r.ts) },
            { key: 'ticker', label: 'Contract' },
            { key: 'type', label: 'Type', render: (r) => String(r.type || '').toUpperCase() },
            { key: 'strike', label: 'Strike', num: true },
            { key: 'dte', label: 'DTE', num: true },
            { key: 'size', label: 'Size', num: true },
            { key: 'premium', label: 'Premium', num: true, render: (r) => money(r.premium) },
            { key: 'iv', label: 'IV', num: true, render: (r) => (r.iv === null ? '—' : `${(r.iv * 100).toFixed(1)}%`) },
            { key: 'delta', label: 'Δ', num: true, render: (r) => (r.delta === null ? '—' : r.delta.toFixed(3)) },
            { key: 'kind', label: 'Kind' },
          ], flow.prints)
        : el('p', { class: 'card__note', text: flow.reason || 'The tape returned no prints for this window.' }),
      el('p', { class: 'card__note', style: 'margin-top:10px', text: `Window ${p.window.start} → ${p.window.end}. Prints are ranked by premium; the score below uses the whole returned window.` }));

    const gexCard = section('Gamma exposure by strike', gex.available ? `calls add, puts subtract · ${gex.unit}` : 'not computable from this feed',
      gexBars(gex, p.underlying_price),
      el('div', { class: 'metrics', style: 'margin-top:16px' },
        el('div', { class: 'metric' }, el('div', { class: 'metric__k', text: 'Total' }), el('div', { class: 'metric__v metric__v--sm', text: gex.available ? money(gex.total_usd_per_pct) : '—' })),
        el('div', { class: 'metric' }, el('div', { class: 'metric__k', text: 'Cumulative zero crossing' }), el('div', { class: 'metric__v metric__v--sm', text: gex.flip_strike === null || gex.flip_strike === undefined ? '—' : String(gex.flip_strike) })),
        el('div', { class: 'metric' }, el('div', { class: 'metric__k', text: 'Nearest strike' }), el('div', { class: 'metric__v metric__v--sm', text: gex.nearest_strike === null || gex.nearest_strike === undefined ? '—' : String(gex.nearest_strike) })),
        el('div', { class: 'metric' }, el('div', { class: 'metric__k', text: 'Strikes weighted' }), el('div', { class: 'metric__v metric__v--sm', text: String((gex.by_strike || []).length) }))),
      el('p', { class: 'card__note', style: 'margin-top:10px', text: 'Weight is contracts traded in the window (chain volume first, then the tape) because this feed carries no open interest. It is not the OI-based GEX a paid feed gives; the basis is stated above so the number cannot be mistaken for one.' }));

    const painCard = section('Max pain', pain.available ? `strike ${pain.strike} minimises holder payout · basis ${pain.basis}` : 'not computable from this feed',
      pain.available
        ? el('div', {},
            el('div', { class: 'metrics' },
              el('div', { class: 'metric metric--accent' }, el('div', { class: 'metric__k', text: 'Max pain strike' }), el('div', { class: 'metric__v', text: String(pain.strike) })),
              el('div', { class: 'metric' }, el('div', { class: 'metric__k', text: 'Distance from spot' }), el('div', { class: 'metric__v metric__v--sm', text: pct(pain.distance_pct) })),
              el('div', { class: 'metric' }, el('div', { class: 'metric__k', text: 'Payout at that strike' }), el('div', { class: 'metric__v metric__v--sm', text: money(pain.payout) })),
              el('div', { class: 'metric' }, el('div', { class: 'metric__k', text: 'Candidate strikes' }), el('div', { class: 'metric__v metric__v--sm', text: String(pain.candidates) }))),
            el('div', { style: 'margin-top:16px' }, tableEl([
              { key: 'strike', label: 'Strike', num: true },
              { key: 'payout', label: 'Holder payout', num: true, render: (r) => money(r.payout) },
            ], (pain.curve || []).slice().sort((a, b) => a.payout - b.payout).slice(0, 10))))
        : el('p', { class: 'card__note', text: pain.reason || 'No weights.' }),
      el('p', { class: 'card__note', style: 'margin-top:10px', text: 'Standard max pain uses open interest; this feed has none, so the curve uses the same traded contracts as the exposure curve. The ten cheapest strikes are listed so the minimum can be checked.' }));

    const whaleCard = section('Whale score', whale.available ? `${whale.score} · ${whale.label}` : 'no prints to score',
      whale.available
        ? el('div', {},
            el('div', { class: 'metrics' },
              el('div', { class: 'metric metric--accent' }, el('div', { class: 'metric__k', text: 'Score' }), el('div', { class: 'metric__v', text: String(whale.score) }), el('div', { class: 'card__note', text: whale.label })),
              el('div', { class: 'metric' }, el('div', { class: 'metric__k', text: 'Biggest print' }), el('div', { class: 'metric__v metric__v--sm', text: money(whale.top_print ? whale.top_print.premium : null) }), el('div', { class: 'card__note', text: whale.top_print ? `${whale.top_print.ticker} · ${whale.top_print.size} lots` : '—' }))),
            el('div', { style: 'margin-top:16px' }, tableEl([
              { key: 'key', label: 'Component' },
              { key: 'weight', label: 'Weight', num: true },
              { key: 'value', label: 'Value 0–1', num: true },
              { key: 'input', label: 'Input' },
              { key: 'meaning', label: 'What it measures' },
            ], whale.components || [])),
            el('p', { class: 'card__note', style: 'margin-top:10px', text: `${whale.classification}. Aggressor: ${whale.aggressor}` }))
        : el('p', { class: 'card__note', text: whale.reason || 'No prints in this window.' }));

    const honesty = section('What is real, what is derived, what is not available', 'the same list the API returns',
      el('div', { class: 'metrics', style: 'margin-bottom:14px' },
        el('div', { class: 'metric' }, el('div', { class: 'metric__k', text: 'Real' }), el('div', { class: 'metric__v metric__v--sm', text: 'chain, prints, Greeks, premium' })),
        el('div', { class: 'metric' }, el('div', { class: 'metric__k', text: 'Derived' }), el('div', { class: 'metric__v metric__v--sm', text: 'exposure, max pain, flip, walls, smile, score' })),
        el('div', { class: 'metric' }, el('div', { class: 'metric__k', text: 'Unavailable' }), el('div', { class: 'metric__v metric__v--sm', text: String((p.unavailable || []).length) }))),
      tableEl([
        { key: 'metric', label: 'Not available' },
        { key: 'reason', label: 'Why' },
      ], p.unavailable || [], { emptyTitle: 'Nothing missing', emptyText: 'Every metric on this page came from real fields in the feed.' }),
      el('p', { class: 'card__note', style: 'margin-top:12px', text: `Generated ${p.generated_at} · as of ${p.as_of} · engine ${p.engine}. ${p.definitions.gamma_exposure} ${p.definitions.max_pain}` }));

    out.replaceChildren(el('div', {}, header, card('Options flow', { note: `${p.source} · ${p.feed}` }, metrics), levelsCard, smileCard, flowCard, gexCard, painCard, whaleCard, honesty));
  };

  const run = async () => {
    loadBtn.disabled = true;
    out.replaceChildren(card('', {}, empty('Reading the chain and the tape…', 'The engine asks LSE for one chain page and the prints in the window.')));
    try {
      paint(await market.optionsFlow({
        underlying: (symInput.value || 'SPY').trim().toUpperCase(),
        window: windowSel.value,
        minPremium: premiumSel.value || null,
      }));
    } catch (err) {
      renderUnavailable({ reason: String(err.message || err).slice(0, 400), source: 'lse-data' });
    } finally {
      loadBtn.disabled = false;
    }
  };

  loadBtn.addEventListener('click', run);
  symInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });

  page.append(
    el('div', { class: 'page__head' },
      el('div', {},
        el('h2', { class: 'page__title', text: 'Options Flow' }),
        el('p', { class: 'page__sub', text: 'Live options prints, gamma exposure, max pain, a repriced gamma flip, walls and the IV smile from LSE Data 3.0 — every number computed on this machine from the feed, with the weight basis and the missing fields stated.' })),
      chip('LSE us_options', 'chip--on')),
    card('Query', {},
      el('div', { class: 'form form--3' },
        field('Underlying', symInput),
        field('Window', windowSel),
        field('Minimum print', premiumSel)),
      datalist,
      el('div', { class: 'bt__actions' }, loadBtn)),
    out);

  run();
  return page;
}
