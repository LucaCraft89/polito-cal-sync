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

/** The setup steps in the order a new person does them (docs/UI.md section 5). */
function checklist(s, g, extra) {
  const polito = s['polito.enabled']?.value === true;
  const feeds = s.icsUrls?.set ? s.icsUrls.value.length : 0;
  const client = s['google.clientId']?.set && s['google.clientSecret']?.set;
  const items = [
    {
      ok: !!client,
      title: 'Google client saved',
      text: client
        ? 'The client id and secret are set.'
        : 'Create the Google client (docs/SETUP.md), then enter its id and secret under Settings.',
      to: '#/settings',
    },
    {
      ok: !!g?.connected,
      title: 'Google account connected',
      text: g?.connected
        ? `Signed in${g.account ? ` as ${g.account}` : ''}.`
        : 'Press Connect Google under Settings and allow calendar access.',
      to: '#/settings',
    },
    {
      ok: !!g?.calendar,
      title: 'Dedicated calendar chosen',
      text: g?.calendar
        ? `Events go to ${g.calendar.name ? `"${g.calendar.name}"` : 'the calendar set by the environment'}.`
        : 'Create or pick the calendar under Settings. It is never your main calendar.',
      to: '#/settings',
    },
    {
      ok: feeds > 0 || polito,
      title: 'A source is switched on',
      text:
        feeds > 0 || polito
          ? `${feeds} calendar feed(s)${polito ? ', Polito portal' : ''}`
          : 'Add a calendar feed or switch on the Polito portal under Sources, and press Test.',
      to: '#/sources',
    },
  ];
  if (polito) {
    const done = s['polito.username']?.set && s['polito.password']?.set;
    items.push({
      ok: !!done,
      title: 'Polito login saved',
      text: done
        ? 'Username and password are set. Press Test login on the Sources page to check them.'
        : 'The portal is on, but the username or password is missing.',
      to: '#/sources',
    });
  }
  items.push(
    {
      ok: extra.previewed,
      title: 'First preview',
      text: extra.previewed
        ? 'You have looked at what a sync would do.'
        : 'Press Preview now to see what would be written. Nothing is written yet.',
      to: '#/preview',
    },
    {
      ok: extra.synced,
      title: 'First sync',
      text: extra.synced
        ? 'The calendar has been written. The scheduled sync keeps it up to date.'
        : 'On the Preview page, read the result and press Sync now.',
      to: '#/preview',
    },
  );
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
    const [{ settings }, st, g, pv, hist] = await Promise.all([
      api('GET', '/api/settings'),
      status(),
      api('GET', '/api/google').catch(() => undefined),
      api('GET', '/api/preview').catch(() => undefined),
      api('GET', '/api/history?limit=1').catch(() => undefined),
    ]);
    const s = byKey(settings);
    const synced = (hist?.runs?.length ?? 0) > 0;
    const items = checklist(s, g, { previewed: !!pv?.preview || synced, synced });
    const next = items.find((it) => !it.ok);
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
    if (next) {
      setup.append(
        banner(
          'info',
          `Next: ${next.title.toLowerCase()}`,
          next.text,
          h('a', { class: 'btn btn-filled', href: next.to }, 'Go there'),
        ),
      );
    } else {
      setup.append(
        banner(
          'ok',
          'Everything is set up',
          'The calendar is kept up to date by the scheduled sync.',
        ),
      );
    }
    const list = h('ol', { class: 'list' });
    for (const [n, it] of items.entries()) {
      list.append(
        h(
          'li',
          { class: 'list-item' },
          it.ok ? chip('ok', 'Done') : chip('warn', 'To do'),
          h(
            'div',
            { class: 'grow' },
            h('span', { class: 't-label', text: `${n + 1}. ${it.title}` }),
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
