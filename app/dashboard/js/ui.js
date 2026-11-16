/** Tiny DOM + chart helpers for the operator surface. */

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(3)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const card = (title, opts = {}, ...body) =>
  el('section', { class: `card ${opts.class || ''}`.trim() },
    (title || opts.note) && el('div', { class: 'card__head' },
      el('h2', { class: 'card__title', text: title || '' }),
      opts.action || (opts.note && el('span', { class: 'card__note', text: opts.note }))),
    ...body);

export const metric = (k, v, opts = {}) =>
  el('div', { class: `metric ${opts.accent ? 'metric--accent' : ''} ${opts.muted ? 'metric--muted' : ''}`.trim() },
    el('div', { class: 'metric__k', text: k }),
    el('div', { class: `metric__v ${opts.small ? 'metric__v--sm' : ''}`.trim(), html: v }));

export const chip = (text, kind = '') => el('span', { class: `chip ${kind}`.trim(), text });

export function table(columns, rows, opts = {}) {
  const thead = el('thead', {}, el('tr', {}, columns.map((c) => el('th', { class: c.num ? 'num' : '', text: c.label }))));
  const tbody = el('tbody', {}, rows.length
    ? rows.map((r) => el('tr', {}, columns.map((c) => {
        const v = c.render ? c.render(r) : r[c.key];
        const td = el('td', { class: c.num ? 'num' : '' });
        if (v && v.nodeType) td.append(v);
        else td.innerHTML = v === null || v === undefined ? '—' : String(v);
        return td;
      })))
    : [el('tr', {}, el('td', { colspan: columns.length }, el('div', { class: 'empty' },
        el('h3', { text: opts.emptyTitle || 'Nothing here yet' }),
        el('p', { text: opts.emptyText || '' }))))]);
  return el('div', { class: 'table-wrap' }, el('table', { class: 'table' }, thead, tbody));
}

export const empty = (title, text, action) =>
  el('div', { class: 'empty' }, el('h3', { text: title }), el('p', { text }), action || null);

export function switchRow(title, sub, on, onChange) {
  const t = el('button', { class: `toggle ${on ? 'is-on' : ''}`.trim(), type: 'button', role: 'switch', 'aria-checked': String(on) });
  t.addEventListener('click', () => {
    const next = !t.classList.contains('is-on');
    t.classList.toggle('is-on', next);
    t.setAttribute('aria-checked', String(next));
    onChange && onChange(next);
  });
  return el('div', { class: 'switch-row' },
    el('div', { class: 'switch-row__t' }, el('strong', { text: title }), el('small', { text: sub })),
    t);
}

export const field = (label, input) => el('label', { class: 'field' }, el('span', { text: label }), input);

/* ------------------------------------------------------------- charts */

const rnd = (seed) => {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
};

/** Candlestick series, deterministic per symbol. */
export function candles(width = 900, height = 420, seed = 7, count = 64) {
  const r = rnd(seed);
  const base = 3350 + r() * 140;
  const vals = [];
  let p = base;
  for (let i = 0; i < count; i++) {
    const drift = (r() - 0.5) * 2.4 + Math.sin(i / 13) * 1.4;
    const o = p;
    const c = o + drift;
    const h = Math.max(o, c) + r() * 1.3;
    const l = Math.min(o, c) - r() * 1.3;
    vals.push({ o, c, h, l });
    p = c + (base - c) * 0.34;
  }
  const max = Math.max(...vals.map((v) => v.h));
  const min = Math.min(...vals.map((v) => v.l));
  const pad = (max - min) * 0.12 || 1;
  const top = max + pad;
  const bottom = min - pad;
  const y = (v) => ((top - v) / (top - bottom)) * height;
  const step = width / count;
  return vals.map((v, i) => ({
    x: i * step + step / 2,
    o: y(v.o), c: y(v.c), h: y(v.h), l: y(v.l),
  }));
}

export function candleChart({ seed = 7, width = 900, height = 420 } = {}) {
  const data = candles(width, height, seed);
  const grid = [0.25, 0.5, 0.75].map((f) => {
    const y = (height * f).toFixed(1);
    return `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="#1C2A2B" stroke-width="1"/>`;
  }).join('');
  const body = data.map((x) => {
    const y1 = Math.min(x.o, x.c);
    const h = Math.max(1.5, Math.abs(x.o - x.c));
    const up = x.c <= x.o;
    return `<rect x="${(x.x - 3).toFixed(1)}" y="${y1.toFixed(1)}" width="6" height="${h.toFixed(1)}" rx="1" fill="${up ? '#B4FF3A' : '#FF5A5F'}" opacity="${up ? 0.92 : 0.75}"/>`;
  }).join('');
  const wicks = data.map((x) =>
    `<line x1="${x.x.toFixed(1)}" y1="${Math.min(x.h, x.l).toFixed(1)}" x2="${x.x.toFixed(1)}" y2="${Math.max(x.h, x.l).toFixed(1)}" stroke="#3A5A55" stroke-width="1"/>`).join('');
  const path = data.map((x, i) => `${i ? 'L' : 'M'}${x.x.toFixed(1)},${x.c.toFixed(1)}`).join(' ');
  const area = `${path} L${width},${height} L0,${height} Z`;
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Price chart">
    <defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#B4FF3A" stop-opacity="0.14"/>
      <stop offset="100%" stop-color="#B4FF3A" stop-opacity="0"/></linearGradient></defs>
    ${grid}
    <path d="${area}" fill="url(#cg)"/>
    <path d="${path}" fill="none" stroke="#B4FF3A" stroke-width="1.1" opacity="0.5"/>
    ${wicks}
    ${body}
  </svg>`;
}

/** Sparkline for stat tiles. */
export function sparkline(values, { width = 120, height = 34, stroke = '#B4FF3A' } = {}) {
  if (!values.length) return '';
  const max = Math.max(...values), min = Math.min(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - ((v - min) / span) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${pts.join(' ')}" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linejoin="round"/>
  </svg>`;
}

/** Forex heat cells. */
export const heatRow = (pairs) =>
  el('div', { class: 'heat' }, pairs.map(([sym, pct]) =>
    el('div', { class: `heat__cell ${pct >= 0 ? 'up' : 'down'}` },
      el('b', { text: sym }),
      el('small', { text: `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%` }))));

export function toast(message, ms = 2600) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = message;
  t.classList.add('is-on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('is-on'), ms);
}
