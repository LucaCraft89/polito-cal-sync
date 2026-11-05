import { api, setCsrf } from './api.js';
import { clear, errorBanner, h, icon, loading, toast } from './dom.js';
import { renderLogin, renderSetup } from './pages/auth.js';
import { renderOverview } from './pages/overview.js';
import { renderPreview } from './pages/preview.js';
import { renderSettings } from './pages/settings.js';
import { renderSources } from './pages/sources.js';

const shell = document.getElementById('shell');
const main = document.getElementById('main');
const nav = document.getElementById('nav');
const title = document.getElementById('page-title');

const ROUTES = [
  { path: 'overview', label: 'Overview', icon: 'home', render: () => renderOverview() },
  { path: 'preview', label: 'Preview', icon: 'preview', render: () => renderPreview() },
  { path: 'sources', label: 'Sources', icon: 'sources', render: () => renderSources(show) },
  {
    path: 'settings',
    label: 'Settings',
    icon: 'settings',
    render: () => renderSettings(show, start),
  },
];

let current = ROUTES[0];
let token = 0;

function buildNav() {
  clear(nav);
  nav.append(h('div', { class: 'brand-title', text: 'polito-cal-sync' }));
  for (const r of ROUTES) {
    nav.append(
      h(
        'a',
        { class: 'nav-item', href: `#/${r.path}`, 'data-route': r.path },
        h('span', { class: 'icon-pill' }, icon(r.icon)),
        h('span', { class: 'label', text: r.label }),
      ),
    );
  }
}

function mark() {
  for (const a of nav.querySelectorAll('.nav-item')) {
    if (a.dataset.route === current.path) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

/** Renders the current route into <main>. Stale answers (a slower, older render) are dropped. */
async function show() {
  const hash = location.hash.replace(/^#\//, '');
  current = ROUTES.find((r) => r.path === hash) ?? ROUTES[0];
  const mine = ++token;
  mark();
  title.textContent = current.label;
  document.title = `${current.label} · polito-cal-sync`;
  main.replaceChildren(loading('Loading…'));
  let page;
  try {
    page = await current.render();
  } catch (err) {
    page = errorBanner(err);
  }
  if (mine !== token) return;
  main.replaceChildren(page);
}

function authView(name, node, heading) {
  shell.dataset.view = 'auth';
  title.textContent = heading;
  document.title = `${heading} · polito-cal-sync`;
  main.replaceChildren(node);
  void name;
}

/** `focus`: move the keyboard focus to the page after a login (the form it was in is gone). */
async function start(focus = false) {
  main.replaceChildren(loading('Loading…'));
  let session;
  try {
    session = await api('GET', '/api/session');
  } catch (err) {
    shell.dataset.view = 'auth';
    main.replaceChildren(errorBanner(err));
    return;
  }
  if (session.setupRequired)
    return authView(
      'setup',
      renderSetup(() => start(true)),
      'Welcome',
    );
  if (!session.authenticated)
    return authView(
      'login',
      renderLogin(() => start(true)),
      'Log in',
    );
  setCsrf(session.csrfToken);
  shell.dataset.view = 'app';
  buildNav();
  await show();
  if (focus) main.focus({ preventScroll: true });
}

window.addEventListener('hashchange', () => {
  if (shell.dataset.view === 'app') void show().then(() => main.focus({ preventScroll: true }));
});

// A 401 on any call means the session ended (30 minutes idle, 12 hours total).
const origFetch = window.fetch.bind(window);
window.fetch = async (...a) => {
  const res = await origFetch(...a);
  if (
    res.status === 401 &&
    shell.dataset.view === 'app' &&
    String(a[0]).startsWith('/api/') &&
    !String(a[0]).includes('/login')
  ) {
    toast('You were logged out. Log in again.');
    setCsrf(null);
    void start();
  }
  return res;
};

void start();
