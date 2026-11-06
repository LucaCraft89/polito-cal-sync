import { api } from '../api.js';
import {
  banner,
  button,
  confirmDialog,
  errorBanner,
  h,
  icon,
  loading,
  nextId,
  toast,
} from '../dom.js';
import {
  moodleCoursesField,
  secretField,
  segmentedField,
  squadsField,
  switchField,
  textField,
} from '../forms.js';
import { onTopic } from '../live.js';

const byKey = (list) => Object.fromEntries(list.map((s) => [s.key, s]));

/** Sends a change, shows the result. Returns the new settings or undefined on failure. */
export async function save(card, change, okText = 'Saved') {
  const slot = card.querySelector('[data-error]');
  slot.replaceChildren();
  try {
    const r = await api('PUT', '/api/settings', change);
    toast(r.changed.length ? okText : 'Nothing to change');
    return r.settings;
  } catch (err) {
    slot.replaceChildren(errorBanner(err));
    slot.scrollIntoView?.({ block: 'nearest' });
    return undefined;
  }
}

const SECTION_WORDS = {
  carico: ['course', 'courses'],
  orari: ['lesson', 'lessons'],
  appelli: ['exam call', 'exam calls'],
  agenda: ['agenda item', 'agenda items'],
};
const plural = (n, [one, many]) => `${n} ${n === 1 ? one : many}`;

/** Runs one "Test" call and shows its result (counts and the three-line problem, never names or addresses). */
async function runTest(button, slot, path, body, show) {
  button.disabled = true;
  slot.replaceChildren(loading('Testing…'));
  try {
    slot.replaceChildren(show(await api('POST', path, body)));
  } catch (err) {
    slot.replaceChildren(errorBanner(err));
  } finally {
    button.disabled = false;
  }
}

function feedResult(r) {
  const nodes = [];
  if (r.ok) {
    nodes.push(
      banner(
        'ok',
        'This feed works',
        `${plural(r.events, ['event', 'events'])} in the window of a year back and a year ahead${r.cancelled ? `, ${r.cancelled} cancelled left out` : ''}. Nothing was saved or written.`,
      ),
    );
  } else if (r.problem) {
    nodes.push(errorBanner({ detail: r.problem }));
    if (r.events > 0)
      nodes.push(
        h('p', {
          class: 'field-help',
          text: `${plural(r.events, ['event', 'events'])} could still be read.`,
        }),
      );
  }
  return h('div', { class: 'stack-sm' }, ...nodes);
}

function moodleResult(r) {
  const nodes = [];
  if (r.ok) {
    nodes.push(
      banner(
        'ok',
        'Moodle works',
        `${plural(r.events, ['event', 'events'])} in ${plural(r.courses, ['course', 'courses'])}, from a year back to a year ahead. Nothing was saved or written to your calendar.`,
      ),
    );
  } else if (r.problem) {
    nodes.push(errorBanner({ detail: r.problem }));
  }
  return h('div', { class: 'stack-sm' }, ...nodes);
}

function loginResult(r) {
  const nodes = [];
  const counts = r.sections
    .filter((x) => SECTION_WORDS[x.section])
    .map((x) => plural(x.items, SECTION_WORDS[x.section]))
    .join(', ');
  if (r.ok) {
    nodes.push(
      banner(
        'ok',
        'The login works',
        `The portal answered with ${counts}. Nothing was saved or written.`,
      ),
    );
  } else if (r.problem) {
    nodes.push(errorBanner({ detail: r.problem }));
    if (counts)
      nodes.push(h('p', { class: 'field-help', text: `Read before the problem: ${counts}.` }));
  }
  return h('div', { class: 'stack-sm' }, ...nodes);
}

export async function renderSources(rerender) {
  const page = h(
    'div',
    { class: 'page' },
    h(
      'header',
      {},
      h('p', {
        class: 'muted',
        text: 'Where your schedule comes from. Nothing is written to Google from this page.',
      }),
    ),
  );
  const body = h('div', { class: 'cards' }, loading('Loading…'));
  page.append(body);
  let settings;
  let lastPreview;
  let moodleCourses;
  try {
    ({ settings } = await api('GET', '/api/settings'));
    // The squads on offer come from the last preview (they are only known from the portal's lessons).
    const courseList = await api('GET', '/api/courses').catch(() => ({ courses: [] }));
    moodleCourses = courseList.moodleCourses ?? [];
    lastPreview = { squads: courseList.courses.filter((c) => c.labels.length > 0) };
  } catch (err) {
    body.replaceChildren(errorBanner(err));
    return page;
  }
  const s = byKey(settings);
  const errSlot = () => h('div', { 'data-error': true, 'aria-live': 'assertive' });

  // ---- Polito portal ----
  const enabled = switchField({
    label: 'Polito portal',
    help: 'Lectures, exam calls and deadlines from your student portal.',
    view: s['polito.enabled'],
    checked: s['polito.enabled'].value === true,
  });
  const username = textField({
    label: 'Student ID (username)',
    view: s['polito.username'],
    value: s['polito.username'].value ?? '',
    autocomplete: 'off',
    help: 'For example s123456.',
  });
  const password = secretField({
    label: 'Password',
    view: s['polito.password'],
    help: 'Saved in a file only you can read on this machine, never shown again. The password is only ever sent to the university login pages.',
    onClear: async () => {
      if (await save(portalCard, { clear: ['polito.password'] }, 'Password cleared')) rerender();
    },
  });
  const calls = segmentedField({
    label: 'Exam calls',
    name: 'examCalls',
    value: s['polito.examCalls'].value ?? 'booked',
    view: s['polito.examCalls'],
    options: [
      ['booked', 'Only the ones I booked'],
      ['all', 'All open calls'],
    ],
  });
  const squads = squadsField({
    view: s['polito.squads'],
    current: s['polito.squads'].value ?? {},
    choices: lastPreview?.squads ?? [],
  });
  const portalCard = h(
    'form',
    { class: 'card', novalidate: true, 'aria-labelledby': 'h-portal' },
    h('h2', { id: 'h-portal', text: 'Polito portal' }),
    enabled.el,
    username.el,
    password.el,
    calls.el,
    squads.el,
    errSlot(),
    h('div', { class: 'stack-sm', 'aria-live': 'polite', 'data-test-result': 'login' }),
    h(
      'div',
      { class: 'card-actions' },
      button('Test login', { variant: 'outlined', iconName: 'play', id: 'test-login' }),
      button('Save', { type: 'submit' }),
    ),
  );
  portalCard.querySelector('#test-login').addEventListener('click', (ev) => {
    const slot = portalCard.querySelector('[data-test-result]');
    if (password.read() || username.read() !== username.initial) {
      slot.replaceChildren(
        banner(
          'warn',
          'Save first',
          'The test uses the saved login, not what is typed. Press Save, then Test login.',
        ),
      );
      return;
    }
    void runTest(ev.currentTarget, slot, '/api/sources/polito/test', {}, loginResult);
  });
  portalCard.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const set = {};
    const clearKeys = [];
    if (enabled.read() !== enabled.initial) set['polito.enabled'] = enabled.read();
    if (username.read() !== username.initial) {
      if (username.read()) set['polito.username'] = username.read();
      else clearKeys.push('polito.username');
    }
    if (password.read()) set['polito.password'] = password.read();
    if (calls.read() !== calls.initial) set['polito.examCalls'] = calls.read();
    if (squads.changed()) {
      const next = squads.read();
      if (Object.keys(next).length) set['polito.squads'] = next;
      else clearKeys.push('polito.squads');
    }
    if (await save(portalCard, { set, clear: clearKeys })) rerender();
  });

  // ---- ICS feeds ----
  const feeds = s.icsUrls;
  const list = h('ul', { class: 'list', 'aria-label': 'Calendar feeds' });
  for (const f of feeds.value ?? []) {
    list.append(
      h(
        'li',
        { class: 'list-item' },
        h(
          'div',
          { class: 'grow' },
          h('span', { class: 't-label', text: `Feed ${f.index}` }),
          h('span', { class: 'muted t-small', text: f.host }),
          h('div', {
            class: 'stack-sm',
            'aria-live': 'polite',
            'data-test-result': `feed-${f.index}`,
          }),
        ),
        button('Test', {
          variant: 'tonal',
          'aria-label': `Test feed ${f.index} (${f.host})`,
          onclick: (ev) =>
            void runTest(
              ev.currentTarget,
              list.querySelector(`[data-test-result="feed-${f.index}"]`),
              '/api/sources/feeds/test',
              { index: f.index - 1 },
              feedResult,
            ),
        }),
        button('Remove', {
          variant: 'text',
          disabled: feeds.locked,
          'aria-label': `Remove feed ${f.index} (${f.host})`,
          onclick: async () => {
            const yes = await confirmDialog({
              title: `Remove feed ${f.index}?`,
              text: `Events that only this feed provided will be removed from your calendar at the next sync (within the safety limit).`,
              confirm: 'Remove',
              danger: true,
            });
            if (
              yes &&
              (await save(feedCard, { icsFeeds: { remove: [f.index - 1] } }, 'Feed removed'))
            )
              rerender();
          },
        }),
      ),
    );
  }
  const addId = nextId('feed');
  const addInput = h('input', {
    id: addId,
    class: 'input',
    type: 'url',
    autocomplete: 'off',
    spellcheck: 'false',
    inputmode: 'url',
    disabled: feeds.locked,
    'aria-describedby': `${addId}-h`,
  });
  const feedCard = h(
    'form',
    { class: 'card', novalidate: true, 'aria-labelledby': 'h-feeds' },
    h('h2', { id: 'h-feeds', text: 'Calendar feeds' }),
    feeds.set ? list : h('p', { class: 'muted', text: 'No feed yet.' }),
    h(
      'div',
      { class: 'field' },
      h('label', { for: addId, text: 'Add a feed link' }),
      addInput,
      h('span', {
        id: `${addId}-h`,
        class: 'field-help',
        text: 'The link contains a secret token, so it is never shown again, only its host. Moodle: Calendar → Export calendar → copy the link.',
      }),
      feeds.locked
        ? h(
            'span',
            { class: 'field-help' },
            icon('lock'),
            ' Set by SOURCE_POLITO_ICS_URLS; change it there.',
          )
        : null,
    ),
    errSlot(),
    h(
      'div',
      { class: 'card-actions' },
      button('Add feed', { type: 'submit', disabled: feeds.locked }),
    ),
  );
  feedCard.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!addInput.value.trim()) return;
    if (await save(feedCard, { icsFeeds: { add: [addInput.value.trim()] } }, 'Feed added'))
      rerender();
  });

  // ---- Moodle ----
  const moodleOn = switchField({
    label: 'Live Moodle events',
    help: 'Reads your Moodle calendar (deadlines, quizzes, reservations) every sync, with the university login saved in the Polito portal card. It includes past events and the course of each one. If you also added a Moodle calendar feed above, remove that feed: the same events would appear twice.',
    view: s['moodle.enabled'],
    checked: s['moodle.enabled']?.value === true,
  });
  const excludedNow = Array.isArray(s['moodle.excludedCourses']?.value)
    ? s['moodle.excludedCourses'].value
    : [];
  const moodleCourseBox = h('div', { 'data-moodle-courses': true });
  let courseField = moodleCoursesField({
    view: s['moodle.excludedCourses'],
    excluded: excludedNow,
    courses: moodleCourses ?? [],
  });
  moodleCourseBox.append(courseField.el);
  const moodle = textField({
    label: 'Moodle address',
    view: s.moodleBaseUrl,
    value: s.moodleBaseUrl.value ?? '',
    type: 'url',
    inputmode: 'url',
    help: 'Events from feeds on this site are labelled [Moodle] in your calendar.',
  });
  const moodleCard = h(
    'form',
    { class: 'card', novalidate: true, 'aria-labelledby': 'h-moodle' },
    h('h2', { id: 'h-moodle', text: 'Moodle' }),
    moodleOn.el,
    moodleCourseBox,
    moodle.el,
    errSlot(),
    h('div', { class: 'stack-sm', 'aria-live': 'polite', 'data-test-result': 'moodle' }),
    h(
      'div',
      { class: 'card-actions' },
      button('Test Moodle', { variant: 'outlined', iconName: 'play', id: 'test-moodle' }),
      button('Save', {
        type: 'submit',
        disabled: s.moodleBaseUrl.locked && s['moodle.enabled'].locked,
      }),
    ),
  );
  moodleCard.querySelector('#test-moodle').addEventListener('click', (ev) => {
    const slot = moodleCard.querySelector('[data-test-result]');
    void runTest(ev.currentTarget, slot, '/api/sources/moodle/test', {}, moodleResult);
  });
  moodleCard.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const set = {};
    if (moodleOn.read() !== moodleOn.initial) set['moodle.enabled'] = moodleOn.read();
    if (moodle.read() !== moodle.initial) set.moodleBaseUrl = moodle.read();
    const clearKeys = [];
    if (courseField.changed()) {
      const left = courseField.read();
      if (left.length > 0) set['moodle.excludedCourses'] = left;
      else clearKeys.push('moodle.excludedCourses');
    }
    if (Object.keys(set).length === 0 && clearKeys.length === 0) return toast('Nothing to change');
    if (await save(moodleCard, { set, clear: clearKeys })) rerender();
  });

  // The list of Moodle courses appears after the first read (a Moodle test, a preview or a sync); show it without a reload.
  onTopic(['preview', 'sync'], page, async () => {
    try {
      const fresh = await api('GET', '/api/courses', undefined, { background: true });
      const next = moodleCoursesField({
        view: s['moodle.excludedCourses'],
        excluded: excludedNow,
        courses: fresh.moodleCourses ?? [],
      });
      if (next.ids !== courseField.ids && !courseField.changed()) {
        courseField = next;
        moodleCourseBox.replaceChildren(next.el);
      }
    } catch {
      /* the next normal load shows what is wrong */
    }
  });
  body.replaceChildren(portalCard, feedCard, moodleCard);
  return page;
}
