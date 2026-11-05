import { api } from '../api.js';
import { banner, chip, errorBanner, h, icon, loading, when } from '../dom.js';

async function status() {
  try {
    const res = await fetch('/status', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

const byKey = (list) => Object.fromEntries(list.map((s) => [s.key, s]));

function checklist(s) {
  const polito = s['polito.enabled']?.value === true;
  const feeds = s.icsUrls?.set ? s.icsUrls.value.length : 0;
  const items = [];
  items.push({
    ok: feeds > 0 || polito,
    title: 'A source is switched on',
    text:
      feeds > 0 || polito
        ? `${feeds} calendar feed(s)${polito ? ', Polito portal' : ''}`
        : 'Add a calendar feed or switch on the Polito portal.',
    to: '#/sources',
  });
  if (polito) {
    const done = s['polito.username']?.set && s['polito.password']?.set;
    items.push({
      ok: !!done,
      title: 'Polito login saved',
      text: done
        ? 'Username and password are set.'
        : 'The portal is on, but the username or password is missing.',
      to: '#/sources',
    });
  }
  const google = s['google.clientId']?.set && s['google.clientSecret']?.set;
  items.push({
    ok: !!google,
    title: 'Google client saved',
    text: google
      ? 'Connecting your Google account is still done with the "auth google" command (see docs/M2-RUNBOOK.md).'
      : 'Enter the Google client id and secret under Settings.',
    to: '#/settings',
  });
  return items;
}

export async function renderOverview() {
  const page = h(
    'div',
    { class: 'page' },
    h('header', {}, h('p', { class: 'muted', text: 'What is set up and how the last sync went.' })),
  );
  const body = h('div', { class: 'cards' }, loading('Loading…'));
  page.append(body);
  try {
    const [{ settings }, st] = await Promise.all([api('GET', '/api/settings'), status()]);
    const s = byKey(settings);
    const items = checklist(s);
    const cards = [];

    const run = h(
      'section',
      { class: 'card', 'aria-labelledby': 'h-run' },
      h('h2', { id: 'h-run', text: 'Last sync' }),
    );
    if (!st || st.lastRunAt === undefined) {
      run.append(
        banner(
          'info',
          'No sync has run yet',
          'The first run happens when "serve" starts. Use Preview to see what it would do.',
        ),
      );
    } else {
      const ok = st.lastStatus === 'ok' || st.lastStatus === 'partial';
      run.append(
        h(
          'div',
          { class: 'row' },
          st.healthy ? chip('ok', 'Healthy') : chip('bad', 'Needs attention'),
          ok ? chip('ok', st.lastStatus) : chip('warn', st.lastStatus ?? 'unknown'),
        ),
        h(
          'dl',
          { class: 'kv' },
          h('div', {}, h('dt', { text: 'Last run' }), h('dd', { text: when(st.lastRunAt) })),
          h('div', {}, h('dt', { text: 'Next run' }), h('dd', { text: when(st.nextRunAt) })),
          st.lastCounts
            ? h(
                'div',
                {},
                h('dt', { text: 'Created / changed / removed' }),
                h('dd', {
                  text: `${st.lastCounts.created} / ${st.lastCounts.patched} / ${st.lastCounts.deleted}`,
                }),
              )
            : null,
          st.lastErrorCode
            ? h(
                'div',
                {},
                h('dt', { text: 'Last problem' }),
                h('dd', {}, h('code', { text: st.lastErrorCode })),
              )
            : null,
        ),
        st.healthy ? null : banner('warn', 'The sync loop needs attention', st.reason ?? ''),
      );
    }
    cards.push(run);

    const setup = h(
      'section',
      { class: 'card', 'aria-labelledby': 'h-setup' },
      h('h2', { id: 'h-setup', text: 'Setup' }),
    );
    const list = h('ul', { class: 'list' });
    for (const it of items) {
      list.append(
        h(
          'li',
          { class: 'list-item' },
          it.ok ? chip('ok', 'Done') : chip('warn', 'To do'),
          h(
            'div',
            { class: 'grow' },
            h('span', { class: 't-label', text: it.title }),
            h('span', { class: 'muted t-small', text: it.text }),
          ),
          h('a', { class: 'btn btn-text', href: it.to }, 'Open'),
        ),
      );
    }
    setup.append(list);
    cards.push(setup);

    body.replaceChildren(...cards);
    page.append(
      h('a', { class: 'btn btn-filled fab', href: '#/preview' }, icon('preview'), 'Preview a sync'),
    );
  } catch (err) {
    body.replaceChildren(errorBanner(err));
  }
  return page;
}
