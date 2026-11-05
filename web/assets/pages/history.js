import { api } from '../api.js';
import {
  banner,
  button,
  chip,
  confirmDialog,
  errorBanner,
  h,
  loading,
  toast,
  when,
} from '../dom.js';

const STATUS = {
  ok: ['ok', 'Done'],
  partial: ['warn', 'Done, with problems'],
  refused: ['warn', 'Refused'],
  failed: ['bad', 'Failed'],
  running: ['info', 'Running'],
};

function problemBlock(e) {
  return h(
    'dl',
    { class: 't-small' },
    h('dt', { text: 'What happened' }),
    h('dd', { text: e.what }),
    h('dt', { text: 'Why' }),
    h('dd', { text: e.why }),
    h('dt', { text: 'What to do' }),
    h('dd', { text: e.action }),
    h('dt', { text: 'Code' }),
    h('dd', {}, h('code', { text: e.code }), ' · ', h('code', { text: e.docs })),
  );
}

function runCard(r) {
  const [kind, word] = STATUS[r.status] ?? ['info', r.status];
  const card = h(
    'section',
    { class: 'card' },
    h(
      'div',
      { class: 'row spread' },
      h('h2', { class: 't-label', text: when(r.startedAt) }),
      chip(kind, word),
    ),
    h('p', {
      class: 'muted',
      text: `${r.created} added, ${r.patched} changed, ${r.deleted} removed, ${r.unchanged} unchanged${r.failed ? `, ${r.failed} could not be written` : ''}.`,
    }),
  );
  if (r.forced) card.append(chip('warn', 'Deletion limit confirmed by hand'));
  for (const f of r.failures)
    card.append(
      h(
        'p',
        { class: 'field-help' },
        `${f.count} event(s) failed with `,
        h('code', { text: f.code }),
        '.',
      ),
    );
  if (r.incompleteSources.length)
    card.append(
      h('p', {
        class: 'field-help',
        text: `Incomplete, nothing removed for: ${r.incompleteSources.join(', ')}.`,
      }),
    );
  if (r.error) card.append(problemBlock(r.error));
  return card;
}

/** Runs from the history, the scheduled loop's state, and the paused-login state with "I fixed the credentials". */
export async function renderHistory(rerender) {
  const page = h(
    'div',
    { class: 'page' },
    h(
      'header',
      {},
      h('p', {
        class: 'muted',
        text: 'What every sync did, newest first. Counts and error codes only, no event text.',
      }),
    ),
  );
  const body = h('div', { class: 'cards' }, loading('Loading…'));
  page.append(body);
  try {
    const v = await api('GET', '/api/history');
    const cards = [];
    if (v.loginPaused) {
      cards.push(
        h(
          'section',
          { class: 'card' },
          banner(
            'warn',
            'The university login is paused',
            `It was refused at ${when(v.loginPaused.since)}, and the same username and password are not tried again, so the account is not locked. Fix them under Sources (the pause ends by itself), or, if they were right and the refusal was a one-off, press the button after checking in a browser that the login works.`,
          ),
          h(
            'div',
            { class: 'card-actions' },
            button('I fixed the credentials', {
              variant: 'tonal',
              onclick: async () => {
                const yes = await confirmDialog({
                  title: 'Try the login again?',
                  text: 'The next sync or test will log in once more. If the university refuses it again, the pause comes back.',
                  confirm: 'Allow one more try',
                });
                if (!yes) return;
                try {
                  await api('POST', '/api/sources/polito/resume', {});
                  toast('The pause is over.');
                  rerender();
                } catch (err) {
                  cards[0].append(errorBanner(err));
                }
              },
            }),
          ),
        ),
      );
    }
    if (v.loop) {
      const l = v.loop;
      const loop = h(
        'section',
        { class: 'card', 'aria-labelledby': 'h-loop' },
        h('h2', { id: 'h-loop', text: 'Scheduled sync' }),
      );
      loop.append(
        h(
          'dl',
          { class: 'kv' },
          h('div', {}, h('dt', { text: 'Last run' }), h('dd', { text: when(l.lastRunAt) })),
          h('div', {}, h('dt', { text: 'Last success' }), h('dd', { text: when(l.lastOkAt) })),
          h(
            'div',
            {},
            h('dt', { text: 'Next run' }),
            h('dd', { text: l.stoppedAt ? 'stopped' : when(l.nextRunAt) }),
          ),
        ),
      );
      if (l.error) loop.append(problemBlock(l.error));
      cards.push(loop);
    }
    if (v.runs.length === 0) {
      cards.push(
        banner(
          'info',
          'No sync has written anything yet',
          'Runs appear here after the first sync (a preview is not a run).',
        ),
      );
    }
    for (const r of v.runs) cards.push(runCard(r));
    body.replaceChildren(...cards);
  } catch (err) {
    body.replaceChildren(errorBanner(err));
  }
  return page;
}
