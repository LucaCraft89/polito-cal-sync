// Tiny DOM helpers. Everything the user or a remote system wrote (titles, places, feed names, error details)
// goes in through text nodes / textContent ONLY. No markup-from-string API is used anywhere; a test
// (test/web-static.test.ts) fails if one appears.

const SVG = 'http://www.w3.org/2000/svg';

/** h('div', {class: 'card', onclick: fn, 'aria-label': 'x'}, 'text', childNode, ...) */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// Icons we draw ourselves (24x24, stroke). Each entry is a list of [element, attributes].
const ICONS = {
  home: [['path', { d: 'M4 11 12 4l8 7v9h-5v-6H9v6H4z' }]],
  preview: [
    ['path', { d: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z' }],
    ['circle', { cx: 12, cy: 12, r: 3 }],
  ],
  sources: [['path', { d: 'M4 6h16M4 12h16M4 18h10' }]],
  settings: [
    ['path', { d: 'M4 7h9M19 7h1M4 17h1M11 17h9' }],
    ['circle', { cx: 16, cy: 7, r: 2.5 }],
    ['circle', { cx: 8, cy: 17, r: 2.5 }],
  ],
  check: [['path', { d: 'M5 12.5l4.5 4.5L19 7' }]],
  warning: [['path', { d: 'M12 4 2.5 20h19zM12 10v4M12 17.2v.01' }]],
  info: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M12 11v5M12 7.8v.01' }],
  ],
  error: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M9 9l6 6M15 9l-6 6' }],
  ],
  lock: [
    ['rect', { x: 5, y: 11, width: 14, height: 9, rx: 2 }],
    ['path', { d: 'M8 11V8a4 4 0 0 1 8 0v3' }],
  ],
  logout: [['path', { d: 'M10 5H5v14h5M15 8l4 4-4 4M19 12H9' }]],
  play: [['path', { d: 'M7 5l12 7-12 7z' }]],
  link: [
    [
      'path',
      {
        d: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1',
      },
    ],
  ],
  add: [['path', { d: 'M12 5v14M5 12h14' }]],
  courses: [['path', { d: 'M4 5h12a3 3 0 0 1 3 3v11H7a3 3 0 0 1-3-3zM8 9h7M8 13h5' }]],
  history: [['path', { d: 'M4 12a8 8 0 1 0 2.5-5.8M4 4v5h5M12 8v5l3 2' }]],
  refresh: [['path', { d: 'M20 12a8 8 0 1 1-2.5-5.8M20 4v5h-5' }]],
};

export function icon(name) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const [tag, attrs] of ICONS[name] ?? []) {
    const part = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) part.setAttribute(k, String(v));
    svg.append(part);
  }
  return svg;
}

let uid = 0;
export const nextId = (prefix = 'f') => `${prefix}-${++uid}`;

/** A status chip: icon AND word, so colour is never the only signal. kind: ok | warn | bad | info */
export function chip(kind, word, iconName) {
  const names = { ok: 'check', warn: 'warning', bad: 'error', info: 'info' };
  return h('span', { class: `chip chip-${kind}` }, icon(iconName ?? names[kind] ?? 'info'), word);
}

export function button(
  label,
  { variant = 'filled', iconName, onclick, type = 'button', class: extra, ...rest } = {},
) {
  return h(
    'button',
    { class: `btn btn-${variant}${extra ? ` ${extra}` : ''}`, type, onclick, ...rest },
    iconName ? icon(iconName) : null,
    label,
  );
}

/** Three-line error form: what happened / why / what to do (+ code and docs reference). */
export function errorBanner(err) {
  const e = err?.detail ?? {
    code: 'E_UI_UNREACHABLE',
    what: 'The program did not answer.',
    why: 'It may have stopped, or the connection was lost.',
    action: 'Check that "serve" is still running, then reload this page.',
    docs: 'docs/ERRORS.md#e_ui_unreachable',
  };
  return h(
    'div',
    { class: 'banner banner-bad', role: 'alert' },
    icon('error'),
    h(
      'div',
      { class: 'grow' },
      h(
        'dl',
        {},
        h('dt', { text: 'What happened' }),
        h('dd', { text: e.what }),
        h('dt', { text: 'Why' }),
        h('dd', { text: e.why }),
        h('dt', { text: 'What to do' }),
        h('dd', { text: e.action }),
      ),
      h(
        'p',
        { class: 't-small' },
        'Code ',
        h('code', { text: e.code }),
        ' · see ',
        h('code', { text: e.docs }),
      ),
    ),
  );
}

export function banner(kind, title, text, ...actions) {
  const iconName = { ok: 'check', warn: 'warning', bad: 'error', info: 'info' }[kind] ?? 'info';
  return h(
    'div',
    {
      class: `banner${kind === 'info' ? '' : ` banner-${kind}`}`,
      role: kind === 'bad' ? 'alert' : 'status',
    },
    icon(iconName),
    h(
      'div',
      { class: 'grow' },
      h('strong', { text: title }),
      text ? h('span', { text }) : null,
      actions.length ? h('div', { class: 'row' }, ...actions) : null,
    ),
  );
}

export function loading(text = 'Working…') {
  return h(
    'div',
    { class: 'loading', role: 'status' },
    h('div', { class: 'loader', 'aria-hidden': 'true' }),
    h('span', { text }),
  );
}

// ---- snackbar ----
let snackTimer;
export function toast(message, { action, onAction } = {}) {
  const region = document.getElementById('snackbar');
  if (!region) return;
  clear(region);
  region.append(
    h(
      'div',
      { class: 'snackbar' },
      h('span', { text: message }),
      action ? button(action, { variant: 'text', onclick: onAction }) : null,
    ),
  );
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => clear(region), 6000);
}

// ---- dialog ----
/** Resolves true when confirmed. `extra` is an optional element inside the dialog (e.g. a typed confirmation). */
export function confirmDialog({
  title,
  text,
  confirm = 'Confirm',
  danger = false,
  extra,
  canConfirm,
}) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'dialog', 'aria-labelledby': 'dlg-title' });
    const ok = button(confirm, { variant: danger ? 'danger' : 'filled' });
    const cancel = button('Cancel', { variant: 'text' });
    const sync = () => {
      ok.disabled = canConfirm ? !canConfirm() : false;
    };
    ok.addEventListener('click', () => dlg.close('yes'));
    cancel.addEventListener('click', () => dlg.close('no'));
    dlg.addEventListener('close', () => {
      dlg.remove();
      resolve(dlg.returnValue === 'yes');
    });
    append(dlg, [
      h('h2', { id: 'dlg-title', text: title }),
      h('p', { text }),
      extra ?? null,
      h('div', { class: 'card-actions' }, cancel, ok),
    ]);
    if (extra) extra.addEventListener('input', sync);
    sync();
    document.body.append(dlg);
    dlg.showModal();
  });
}

/** Formats an ISO time for the person (their own locale and zone). */
export function when(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}
