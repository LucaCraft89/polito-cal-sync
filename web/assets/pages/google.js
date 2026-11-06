import { api } from '../api.js';
import { onTopic } from '../live.js';
import { banner, button, chip, errorBanner, h, icon, loading, nextId, toast } from '../dom.js';
import { switchField } from '../forms.js';

const POLL_MS = 2000;

/** Only web addresses are ever turned into a link (the address comes from the server, but never trust a scheme). */
function safeHref(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * The "Google account" card: connect (loopback sign-in started by the server), the account and calendar in
 * use, and the calendar picker. Calendar names come from Google and are shown as text only. The main
 * calendar is never offered (the server refuses it too).
 */
export function googleCard({ onChange } = {}) {
  const card = h(
    'section',
    { class: 'card', 'aria-labelledby': 'h-gacct' },
    h('h2', { id: 'h-gacct', text: 'Google account and calendar' }),
  );
  const content = h('div', { class: 'stack' }, loading('Loading…'));
  const errors = h('div', { 'data-error': true, 'aria-live': 'assertive' });
  card.append(content, errors);
  let timer;
  let splitView;

  const fail = (err) => errors.replaceChildren(errorBanner(err));
  const run = async (fn) => {
    errors.replaceChildren();
    try {
      return await fn();
    } catch (err) {
      fail(err);
      return undefined;
    }
  };

  async function refresh() {
    clearTimeout(timer);
    const st = await run(() => api('GET', '/api/google'));
    if (!st) {
      content.replaceChildren();
      return;
    }
    const settings = await api('GET', '/api/settings').catch(() => undefined);
    splitView = settings?.settings?.find((x) => x.key === 'calendars.splitMoodle');
    draw(st);
    if (st.connect.state === 'waiting') {
      timer = setTimeout(() => {
        if (card.isConnected) void refresh();
      }, POLL_MS);
    }
  }

  async function connect() {
    const r = await run(() => api('POST', '/api/google/connect', {}));
    if (r) await refresh();
  }
  async function cancel() {
    await run(() => api('POST', '/api/google/connect/cancel', {}));
    await refresh();
  }

  function account(st) {
    const rows = [
      h(
        'div',
        {},
        h('dt', { text: 'Account' }),
        h('dd', { text: st.account ?? 'signed in (address not known)' }),
      ),
      h(
        'div',
        {},
        h('dt', { text: 'Calendar' }),
        h('dd', {
          text: st.calendar ? (st.calendar.name ?? 'set by the environment') : 'none chosen yet',
        }),
      ),
    ];
    return h('dl', { class: 'kv' }, ...rows);
  }

  function waiting(st) {
    const href = safeHref(st.connect.authUrl);
    return h(
      'div',
      { class: 'stack' },
      banner(
        'info',
        'Waiting for you to sign in with Google',
        `Google will send your browser back to this computer (127.0.0.1, port ${st.connect.redirectPort}). It gives up after 5 minutes.`,
      ),
      h(
        'div',
        { class: 'row' },
        href
          ? h(
              'a',
              { class: 'btn btn-filled', href, target: '_blank', rel: 'noopener noreferrer' },
              icon('link'),
              'Open the Google sign-in',
            )
          : null,
        button('Cancel', { variant: 'outlined', onclick: cancel }),
      ),
      h('p', {
        class: 'field-help',
        text: 'If the program runs in Docker, the sign-in port must be published (docs/SETUP.md). Nothing is saved until you allow access.',
      }),
    );
  }

  function draw(st) {
    const parts = [];
    if (!st.clientConfigured) {
      parts.push(
        banner(
          'warn',
          'Google client missing',
          'Save the client id and secret in the card above first. They come from the Google Cloud console (docs/M2-RUNBOOK.md).',
        ),
      );
    }
    if (st.problem) parts.push(errorBanner({ detail: st.problem }));
    if (st.connect.state === 'failed' && st.connect.error) {
      parts.push(errorBanner({ detail: st.connect.error }));
    }
    if (st.connect.state === 'waiting') {
      parts.push(waiting(st));
    } else if (st.connected) {
      parts.push(
        h('div', { class: 'row' }, chip('ok', 'Connected')),
        account(st),
        h(
          'div',
          { class: 'row' },
          button('Reconnect', {
            variant: 'outlined',
            iconName: 'refresh',
            disabled: !st.clientConfigured,
            onclick: connect,
          }),
        ),
        calendarPart(st),
        splitPart(st),
      );
    } else {
      parts.push(
        h('div', { class: 'row' }, chip('warn', 'Not connected')),
        h('p', {
          class: 'muted',
          text: 'Connecting lets the program write events into one calendar of its own. It asks for access to your Google calendars but only ever changes events it created, in the calendar you choose below.',
        }),
        h(
          'div',
          { class: 'card-actions' },
          button('Connect Google', {
            iconName: 'link',
            disabled: !st.clientConfigured,
            onclick: connect,
          }),
        ),
      );
    }
    content.replaceChildren(...parts);
  }

  function calendarPart(st, slot = 'polito') {
    const moodle = slot === 'moodle';
    const current = moodle ? st.moodleCalendar : st.calendar;
    const locked = moodle ? st.moodleCalendarLocked : st.calendarLocked;
    const box = h('div', { class: 'stack' });
    const list = h('div', { class: 'stack' });
    const nameId = nextId('in');
    const name = h('input', {
      id: nameId,
      class: 'input',
      type: 'text',
      maxlength: '100',
      autocomplete: 'off',
      placeholder: moodle ? 'Moodle (polito-cal-sync)' : 'Polito (polito-cal-sync)',
    });
    const choose = async (body, okText) => {
      const r = await run(() => api('POST', '/api/google/calendar', { ...body, slot }));
      if (r) {
        toast(okText);
        draw(r);
        onChange?.(r);
      }
    };
    box.append(
      h(
        'h3',
        { class: 't-title' },
        moodle
          ? current
            ? 'Change the Moodle calendar'
            : 'Choose the Moodle calendar'
          : current
            ? 'Change the calendar'
            : 'Choose the dedicated calendar',
      ),
      h('p', {
        class: 'muted',
        text: moodle
          ? 'Moodle events are written to this calendar only, never your main one and never the Polito one. The program never deletes a calendar.'
          : 'Events are written to one calendar only, never your main one. The program never deletes a calendar.',
      }),
      h(
        'div',
        { class: 'field' },
        h('label', { for: nameId, text: 'Create a new calendar named' }),
        name,
        h('span', {
          class: 'field-help',
          text: 'Leave empty for the default name. A calendar with the same name that you own is reused.',
        }),
      ),
      h(
        'div',
        { class: 'row' },
        button(moodle ? 'Create the Moodle calendar' : 'Create the dedicated calendar', {
          variant: current ? 'tonal' : 'filled',
          iconName: 'add',
          disabled: locked,
          onclick: () =>
            choose(
              { create: name.value.trim() ? { name: name.value.trim() } : {} },
              'Calendar ready',
            ),
        }),
        button('Pick one of my calendars', {
          variant: 'outlined',
          disabled: locked,
          onclick: async () => {
            list.replaceChildren(loading('Asking Google…'));
            const r = await run(() =>
              api('GET', `/api/google/calendars${moodle ? '?slot=moodle' : ''}`),
            );
            if (!r) {
              list.replaceChildren();
              return;
            }
            list.replaceChildren(pickList(r, choose));
          },
        }),
      ),
      list,
    );
    if (locked) {
      box.append(
        h(
          'p',
          { class: 'field-help' },
          icon('lock'),
          ' Set by the environment variable ',
          h('code', { text: moodle ? 'GOOGLE_MOODLE_CALENDAR_ID' : 'GOOGLE_CALENDAR_ID' }),
          '. Change it there; it wins over this page.',
        ),
      );
    }
    return box;
  }

  /** Moodle events in a calendar of their own (the [Moodle] label stays in every title). */
  function splitPart(st) {
    const on = switchField({
      label: 'Keep Moodle events in their own calendar',
      help: 'Moodle events (deadlines, quizzes, reservations) go to a second calendar, so you can show or hide them on their own. The [Moodle] label stays in the title. Events already in the Polito calendar move over at the next sync: the new copy is created first and the old one deleted after, and moves do not count toward the deletion limit.',
      view: splitView,
      checked: st.splitMoodle,
    });
    const box = h(
      'div',
      { class: 'stack' },
      h('h3', { class: 't-title', text: 'Moodle calendar' }),
      on.el,
    );
    box.append(
      h(
        'div',
        { class: 'card-actions' },
        button('Save', {
          variant: 'tonal',
          onclick: async () => {
            if (on.read() === on.initial) return toast('Nothing to change');
            const ok = await run(() =>
              api('PUT', '/api/settings', { set: { 'calendars.splitMoodle': on.read() } }),
            );
            if (ok) {
              toast(
                on.read()
                  ? 'Moodle events will go to their own calendar'
                  : 'Moodle events will go back',
              );
              await refresh();
            }
          },
        }),
      ),
    );
    if (st.splitMoodle) {
      if (st.moodleCalendar) {
        box.append(
          h(
            'dl',
            { class: 'kv' },
            h(
              'div',
              {},
              h('dt', { text: 'Moodle calendar' }),
              h('dd', { text: st.moodleCalendar.name ?? 'set by the environment' }),
            ),
          ),
        );
      } else {
        box.append(
          banner(
            'warn',
            'Choose the Moodle calendar',
            'Moodle events are set to go to their own calendar, but none is chosen yet. Syncing waits until you create or pick it below.',
          ),
        );
      }
      box.append(calendarPart(st, 'moodle'));
    }
    return box;
  }

  function pickList(r, choose) {
    if (r.calendars.length === 0) {
      return banner(
        'info',
        'No other calendar found',
        'Create the dedicated calendar instead. Your main calendar and calendars you cannot edit are not offered.',
      );
    }
    const group = h('fieldset', { class: 'check-group' }, h('legend', { text: 'Your calendars' }));
    for (const c of r.calendars) {
      const input = h('input', { type: 'radio', name: `cal-${nextId('g')}`, value: c.id });
      input.checked = c.current;
      group.append(h('label', { class: 'check-row' }, input, h('span', { text: c.name })));
    }
    return h(
      'div',
      { class: 'stack' },
      group,
      h('p', {
        class: 'field-help',
        text: `Your main calendar and calendars you cannot edit are not offered${r.hidden ? ` (${r.hidden} hidden)` : ''}.`,
      }),
      button('Use the selected calendar', {
        onclick: () => {
          const id = group.querySelector('input:checked')?.value;
          if (id) void choose({ id }, 'Calendar chosen');
          else toast('Pick a calendar first');
        },
      }),
    );
  }

  void refresh();
  onTopic('google', card, () => {
    if (!card.contains(document.activeElement)) void refresh();
  });
  return card;
}
