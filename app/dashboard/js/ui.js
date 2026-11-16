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

/**
 * The one honest thing to show when a page has no real source for its numbers.
 * This build ships no demo rows, so "no account" and "nothing published" are
 * real states a visitor can be in.
 */
export const notConnected = (what, action) => {
  const subject = what ? what.charAt(0).toLowerCase() + what.slice(1) : 'this page';
  return empty(
    'Not connected to an account',
    `No account is connected, so ${subject} cannot be read. Connect a session in Settings — this build renders no demo or simulated data.`,
    action || el('a', { class: 'btn btn--outline', href: '#/settings' }, 'Connect a session'),
  );
};

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

export function toast(message, ms = 2600) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = message;
  t.classList.add('is-on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('is-on'), ms);
}
