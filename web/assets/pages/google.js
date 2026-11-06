import { api } from '../api.js';
import { onTopic } from '../live.js';
import { banner, button, chip, errorBanner, h, icon, loading, nextId, toast } from '../dom.js';

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

  function calendarPart(st) {
    const box = h('div', { class: 'stack' });
    const list = h('div', { class: 'stack' });
    const nameId = nextId('in');
    const name = h('input', {
      id: nameId,
      class: 'input',
      type: 'text',
      maxlength: '100',
      autocomplete: 'off',
      placeholder: 'Polito (polito-cal-sync)',
    });
    const choose = async (body, okText) => {
      const r = await run(() => api('POST', '/api/google/calendar', body));
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
        st.calendar ? 'Change the calendar' : 'Choose the dedicated calendar',
      ),
      h('p', {
        class: 'muted',
        text: 'Events are written to one calendar only, never your main one. The program never deletes a calendar.',
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
        button('Create the dedicated calendar', {
          variant: st.calendar ? 'tonal' : 'filled',
          iconName: 'add',
          disabled: st.calendarLocked,
          onclick: () =>
            choose(
              { create: name.value.trim() ? { name: name.value.trim() } : {} },
              'Calendar ready',
            ),
        }),
        button('Pick one of my calendars', {
          variant: 'outlined',
          disabled: st.calendarLocked,
          onclick: async () => {
            list.replaceChildren(loading('Asking Google…'));
            const r = await run(() => api('GET', '/api/google/calendars'));
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
    if (st.calendarLocked) {
      box.append(
        h(
          'p',
          { class: 'field-help' },
          icon('lock'),
          ' Set by the environment variable ',
          h('code', { text: 'GOOGLE_CALENDAR_ID' }),
          '. Change it there; it wins over this page.',
        ),
      );
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
      const input = h('input', { type: 'radio', name: 'cal', value: c.id });
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
