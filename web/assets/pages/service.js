import { api } from '../api.js';
import { onTopic } from '../live.js';
import { switchField, textField } from '../forms.js';
import { save } from './sources.js';
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

const byKey = (list) => Object.fromEntries(list.map((x) => [x.key, x]));
const hoursText = (minutes) => {
  const h = minutes / 60;
  return String(Number.isInteger(h) ? h : Math.round(h * 100) / 100);
};

function statusCard(sv) {
  const card = h(
    'section',
    { class: 'card', 'aria-labelledby': 'h-svc' },
    h('h2', { id: 'h-svc', text: 'Automatic sync' }),
  );
  if (!sv.available) {
    card.append(
      banner(
        'info',
        'Not connected to the scheduler',
        'The automatic sync runs inside the service ("serve", or the Docker container). This page was opened without it.',
      ),
    );
    return card;
  }
  const state = sv.running
    ? chip('info', 'Syncing now')
    : !sv.autoSync
      ? chip('warn', 'Paused')
      : sv.healthy
        ? chip('ok', 'On, waiting for the next run')
        : chip('bad', 'Needs attention');
  card.append(
    h('div', { class: 'row' }, state),
    h(
      'dl',
      { class: 'kv' },
      h('div', {}, h('dt', { text: 'Last run' }), h('dd', { text: when(sv.lastRunAt) })),
      h('div', {}, h('dt', { text: 'Last success' }), h('dd', { text: when(sv.lastOkAt) })),
      h(
        'div',
        {},
        h('dt', { text: 'Next run' }),
        h('dd', { text: sv.autoSync ? when(sv.nextRunAt) : 'paused' }),
      ),
      sv.lastCounts
        ? h(
            'div',
            {},
            h('dt', { text: 'Last run changed' }),
            h('dd', {
              text: `${sv.lastCounts.created} added, ${sv.lastCounts.patched} changed, ${sv.lastCounts.deleted} removed`,
            }),
          )
        : null,
    ),
  );
  if (!sv.healthy && sv.reason) card.append(banner('warn', 'The scheduler is behind', sv.reason));
  if (sv.error) {
    card.append(
      h('p', { class: 'field-help', text: 'The last run ended with a problem:' }),
      problemBlock(sv.error),
    );
  }
  return card;
}

function scheduleCard(sv, s, onSaved) {
  const on = switchField({
    label: 'Keep my calendar up to date automatically',
    help: 'The service syncs by itself on the schedule below, also when this page is closed. Switch it off to pause it; nothing is lost.',
    view: s.syncAuto,
    checked: s.syncAuto?.value !== false,
  });
  const every = textField({
    label: 'Sync every (hours)',
    view: s.syncIntervalMinutes,
    value: hoursText(Number(s.syncIntervalMinutes?.value ?? 60)),
    type: 'number',
    inputmode: 'decimal',
    help: 'For example 1, 2, 6, 12 or 24. The shortest is 0.25 (15 minutes). The next run is planned again as soon as you save.',
  });
  every.input.setAttribute('step', '0.25');
  every.input.setAttribute('min', '0.25');
  every.input.setAttribute('max', '24');
  const limit = Math.round((sv.deleteThreshold ?? 0.3) * 100);
  const card = h(
    'form',
    { class: 'card', novalidate: true, 'aria-labelledby': 'h-sched' },
    h('h2', { id: 'h-sched', text: 'Schedule' }),
    on.el,
    every.el,
    h('p', {
      class: 'field-help',
      text: `A scheduled sync only writes inside your dedicated calendar and never removes more than ${limit}% of your events. If a source suddenly loses more, it stops and waits for you: look at Preview, then use Sync now (it asks you to type a confirmation).`,
    }),
    h('div', { 'data-error': true, 'aria-live': 'assertive' }),
    h('div', { class: 'card-actions' }, button('Save', { type: 'submit' })),
  );
  card.dataset.initial = JSON.stringify([on.initial, every.initial]);
  card.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const set = {};
    if (on.read() !== on.initial) set.syncAuto = on.read();
    if (every.read() !== every.initial) {
      const minutes = Math.round(Number(every.read()) * 60);
      set.syncIntervalMinutes = Number.isFinite(minutes) ? minutes : every.read();
    }
    if (Object.keys(set).length === 0) return toast('Nothing to change');
    if (await save(card, { set })) onSaved();
  });
  return card;
}

/** The automatic sync (status and schedule) and the history of every run; it updates itself while open. */
export async function renderService(rerender) {
  const page = h(
    'div',
    { class: 'page' },
    h(
      'header',
      {},
      h('p', {
        class: 'muted',
        text: 'Keeps your calendar up to date on its own, and shows what every sync did.',
      }),
    ),
  );
  const statusSlot = h('div', { class: 'cards' }, loading('Loading…'));
  const scheduleSlot = h('div', { class: 'cards' });
  const runsSlot = h('div', { class: 'cards' });
  page.append(statusSlot, scheduleSlot, runsSlot);

  /** First load shows errors; a refresh pushed by the server leaves the form alone while it is being edited. */
  async function load(background) {
    let sv, settings, v;
    try {
      [sv, { settings }, v] = await Promise.all([
        api('GET', '/api/service', undefined, { background }),
        api('GET', '/api/settings', undefined, { background }),
        api('GET', '/api/history', undefined, { background }),
      ]);
    } catch (err) {
      if (!background) statusSlot.replaceChildren(errorBanner(err));
      return;
    }
    statusSlot.replaceChildren(statusCard(sv));
    const editing = scheduleSlot.contains(document.activeElement) && scheduleSlot.firstChild;
    if (!editing)
      scheduleSlot.replaceChildren(scheduleCard(sv, byKey(settings), () => load(false)));
    runsSlot.replaceChildren(...historyCards(v, rerender));
  }
  await load(false);
  onTopic(['service', 'sync', 'settings'], page, () => load(true));
  return page;
}

function historyCards(v, rerender) {
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
                toast(err?.detail?.what ?? 'It did not work.');
              }
            },
          }),
        ),
      ),
    );
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
  return cards;
}
