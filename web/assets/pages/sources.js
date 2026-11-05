import { api } from '../api.js';
import { button, confirmDialog, errorBanner, h, icon, loading, nextId, toast } from '../dom.js';
import { secretField, segmentedField, squadsField, switchField, textField } from '../forms.js';

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
  try {
    ({ settings } = await api('GET', '/api/settings'));
    // The squads on offer come from the last preview (they are only known from the portal's lessons).
    lastPreview = (await api('GET', '/api/preview').catch(() => ({}))).preview ?? null;
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
    h('div', { class: 'card-actions' }, button('Save', { type: 'submit' })),
  );
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
        ),
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
  const moodle = textField({
    label: 'Moodle address',
    view: s.moodleBaseUrl,
    value: s.moodleBaseUrl.value ?? '',
    type: 'url',
    inputmode: 'url',
    help: 'Feeds on this site are labelled [Moodle] in your calendar.',
  });
  const moodleCard = h(
    'form',
    { class: 'card', novalidate: true, 'aria-labelledby': 'h-moodle' },
    h('h2', { id: 'h-moodle', text: 'Moodle' }),
    moodle.el,
    errSlot(),
    h(
      'div',
      { class: 'card-actions' },
      button('Save', { type: 'submit', disabled: s.moodleBaseUrl.locked }),
    ),
  );
  moodleCard.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (moodle.read() === moodle.initial) return toast('Nothing to change');
    if (await save(moodleCard, { set: { moodleBaseUrl: moodle.read() } })) rerender();
  });

  body.replaceChildren(portalCard, feedCard, moodleCard);
  return page;
}
