import { api, setCsrf } from '../api.js';
import { button, errorBanner, h, icon, loading, nextId, toast, when } from '../dom.js';
import { secretField, segmentedField, textField } from '../forms.js';
import { save } from './sources.js';

const byKey = (list) => Object.fromEntries(list.map((s) => [s.key, s]));

export function currentTheme() {
  try {
    const t = localStorage.getItem('pcs-theme');
    return t === 'light' || t === 'dark' ? t : 'auto';
  } catch {
    return 'auto';
  }
}
export function applyTheme(t) {
  try {
    if (t === 'auto') localStorage.removeItem('pcs-theme');
    else localStorage.setItem('pcs-theme', t);
  } catch {
    /* private mode: the choice just does not persist */
  }
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

export async function renderSettings(rerender, onLoggedOut) {
  const page = h(
    'div',
    { class: 'page' },
    h(
      'header',
      {},
      h('p', {
        class: 'muted',
        text: 'How often it syncs, your Google client, and access to this page.',
      }),
    ),
  );
  const body = h('div', { class: 'cards' }, loading('Loading…'));
  page.append(body);
  let settings, audit;
  try {
    [{ settings }, { entries: audit }] = await Promise.all([
      api('GET', '/api/settings'),
      api('GET', '/api/audit?limit=15'),
    ]);
  } catch (err) {
    body.replaceChildren(errorBanner(err));
    return page;
  }
  const s = byKey(settings);
  const slot = () => h('div', { 'data-error': true, 'aria-live': 'assertive' });

  // General
  const tz = textField({
    label: 'Time zone',
    view: s.tz,
    value: s.tz.value ?? '',
    help: 'For example Europe/Rome. Times without a zone from the portal are read in this zone.',
  });
  const interval = textField({
    label: 'Sync every (minutes)',
    view: s.syncIntervalMinutes,
    value: String(s.syncIntervalMinutes.value ?? ''),
    type: 'number',
    inputmode: 'numeric',
    help: 'Between 15 and 1440. Takes effect after the program restarts.',
  });
  const limit = textField({
    label: 'Deletion limit (%)',
    view: s.deleteThreshold,
    value:
      s.deleteThreshold.value === undefined
        ? ''
        : String(Math.round(Number(s.deleteThreshold.value) * 100)),
    type: 'number',
    inputmode: 'numeric',
    help: 'A sync that would remove more than this share of your events is refused. 30 is a good value.',
  });
  const general = h(
    'form',
    { class: 'card', novalidate: true, 'aria-labelledby': 'h-gen' },
    h('h2', { id: 'h-gen', text: 'General' }),
    tz.el,
    interval.el,
    limit.el,
    slot(),
    h('div', { class: 'card-actions' }, button('Save', { type: 'submit' })),
  );
  general.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const set = {};
    if (tz.read() !== tz.initial) set.tz = tz.read();
    if (interval.read() !== interval.initial) set.syncIntervalMinutes = Number(interval.read());
    if (limit.read() !== limit.initial) set.deleteThreshold = Number(limit.read()) / 100;
    if (await save(general, { set })) rerender();
  });

  // Google
  const cid = textField({
    label: 'Google client id',
    view: s['google.clientId'],
    value: s['google.clientId'].value ?? '',
  });
  const csecret = secretField({
    label: 'Google client secret',
    view: s['google.clientSecret'],
    onClear: async () => {
      if (await save(google, { clear: ['google.clientSecret'] }, 'Secret cleared')) rerender();
    },
  });
  const google = h(
    'form',
    { class: 'card', novalidate: true, 'aria-labelledby': 'h-g' },
    h('h2', { id: 'h-g', text: 'Google' }),
    h('p', {
      class: 'muted',
      text: 'The client you created in the Google Cloud console. Connecting your account is still done with the "auth google" command (docs/M2-RUNBOOK.md); a button for it comes later.',
    }),
    cid.el,
    csecret.el,
    slot(),
    h('div', { class: 'card-actions' }, button('Save', { type: 'submit' })),
  );
  google.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const set = {};
    if (cid.read() !== cid.initial && cid.read()) set['google.clientId'] = cid.read();
    if (csecret.read()) set['google.clientSecret'] = csecret.read();
    if (await save(google, { set })) rerender();
  });

  // Appearance
  const theme = segmentedField({
    label: 'Theme',
    name: 'theme',
    value: currentTheme(),
    options: [
      ['auto', 'Automatic'],
      ['light', 'Light'],
      ['dark', 'Dark'],
    ],
  });
  theme.el.addEventListener('change', () => applyTheme(theme.read()));
  const look = h(
    'section',
    { class: 'card', 'aria-labelledby': 'h-look' },
    h('h2', { id: 'h-look', text: 'Appearance' }),
    theme.el,
  );

  // Security
  const cur = h('input', {
    id: nextId('p'),
    class: 'input',
    type: 'password',
    autocomplete: 'current-password',
  });
  const nxt = h('input', {
    id: nextId('p'),
    class: 'input',
    type: 'password',
    autocomplete: 'new-password',
  });
  const security = h(
    'form',
    { class: 'card', novalidate: true, 'aria-labelledby': 'h-sec' },
    h('h2', { id: 'h-sec', text: 'Passphrase' }),
    h('div', { class: 'field' }, h('label', { for: cur.id, text: 'Current passphrase' }), cur),
    h(
      'div',
      { class: 'field' },
      h('label', { for: nxt.id, text: 'New passphrase' }),
      nxt,
      h('span', {
        class: 'field-help',
        text: 'At least 12 characters. Changing it logs out every session.',
      }),
    ),
    slot(),
    h(
      'div',
      { class: 'card-actions' },
      button('Change passphrase', { type: 'submit', variant: 'tonal' }),
    ),
  );
  security.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const sl = security.querySelector('[data-error]');
    sl.replaceChildren();
    try {
      const r = await api('POST', '/api/passphrase', { current: cur.value, next: nxt.value });
      setCsrf(r.csrfToken);
      cur.value = nxt.value = '';
      toast('Passphrase changed. Other sessions were logged out.');
    } catch (err) {
      sl.replaceChildren(errorBanner(err));
    }
  });
  const session = h(
    'section',
    { class: 'card', 'aria-labelledby': 'h-ses' },
    h('h2', { id: 'h-ses', text: 'This session' }),
    h(
      'div',
      { class: 'card-actions' },
      button('Log out', {
        variant: 'outlined',
        iconName: 'logout',
        onclick: async () => {
          try {
            await api('POST', '/api/logout');
          } finally {
            setCsrf(null);
            onLoggedOut();
          }
        },
      }),
    ),
  );

  // Recent changes
  const hist = h('ul', { class: 'list' });
  const words = {
    'settings.update': 'Settings changed',
    'ui.setup': 'Passphrase set',
    'ui.login': 'Logged in',
    'ui.login.failed': 'Wrong passphrase',
    'ui.logout': 'Logged out',
    'ui.passphrase.changed': 'Passphrase changed',
    'ui.passphrase.refused': 'Passphrase change refused',
  };
  for (const e of [...audit].reverse()) {
    const keys = [
      ...(Array.isArray(e.set) ? e.set : []),
      ...(Array.isArray(e.cleared) ? e.cleared.map((k) => `${k} (cleared)`) : []),
    ];
    hist.append(
      h(
        'li',
        { class: 'list-item' },
        h(
          'div',
          { class: 'grow' },
          h('span', { class: 't-label', text: words[e.action] ?? e.action }),
          h('span', {
            class: 'muted t-small',
            text: [when(e.at), keys.join(', ')].filter(Boolean).join(' · '),
          }),
        ),
      ),
    );
  }
  const recent = h(
    'section',
    { class: 'card', 'aria-labelledby': 'h-aud' },
    h('h2', { id: 'h-aud', text: 'Recent changes' }),
    audit.length ? hist : h('p', { class: 'muted', text: 'Nothing yet.' }),
    h('p', { class: 'field-help' }, icon('lock'), ' Values of secrets are never recorded.'),
  );

  body.replaceChildren(general, google, look, security, session, recent);
  return page;
}
