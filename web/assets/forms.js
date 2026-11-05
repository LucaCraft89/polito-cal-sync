// Form controls built on dom.js. Locked settings (set by an environment variable) are read-only.
import { button, chip, confirmDialog, h, icon, nextId } from './dom.js';

const lockedNote = (view) =>
  view?.locked
    ? h(
        'p',
        { class: 'field-help' },
        icon('lock'),
        ` Set by the environment variable `,
        h('code', { text: view.env ?? 'an environment variable' }),
        `. Change it there; it wins over this page.`,
      )
    : null;

/** Plain text / number input. `read()` returns the typed text. */
export function textField({
  label,
  view,
  value,
  help,
  type = 'text',
  inputmode,
  autocomplete = 'off',
}) {
  const id = nextId('in');
  const helpId = `${id}-help`;
  const input = h('input', {
    id,
    class: 'input',
    type,
    value: value ?? '',
    inputmode,
    autocomplete,
    spellcheck: 'false',
    'aria-describedby': helpId,
    disabled: view?.locked,
  });
  const helper = h(
    'div',
    { id: helpId, class: 'stack-sm' },
    help ? h('span', { class: 'field-help', text: help }) : null,
    lockedNote(view),
  );
  const el = h('div', { class: 'field' }, h('label', { for: id, text: label }), input, helper);
  return { el, input, read: () => input.value.trim(), initial: value ?? '' };
}

export function switchField({ label, help, view, checked }) {
  const id = nextId('sw');
  const helpId = `${id}-help`;
  const input = h('input', {
    id,
    type: 'checkbox',
    role: 'switch',
    'aria-describedby': helpId,
    disabled: view?.locked,
  });
  input.checked = !!checked;
  const el = h(
    'div',
    { class: 'stack-sm' },
    h(
      'label',
      { class: 'switch-row', for: id },
      h(
        'span',
        { class: 'switch-text' },
        h('span', { class: 't-title', text: label }),
        help ? h('span', { class: 'muted t-small', text: help }) : null,
      ),
      h(
        'span',
        { class: 'switch' },
        input,
        h('span', { class: 'track' }),
        h('span', { class: 'thumb' }),
      ),
    ),
    h('div', { id: helpId }, lockedNote(view)),
  );
  return { el, input, read: () => input.checked, initial: !!checked };
}

export function segmentedField({ label, name, options, value, view }) {
  const group = h('fieldset', { class: 'segmented', disabled: view?.locked });
  group.append(h('legend', { text: label }));
  for (const [val, text] of options) {
    const input = h('input', { type: 'radio', name, value: val });
    input.checked = val === value;
    group.append(h('label', { class: 'seg' }, input, h('span', { text })));
  }
  const el = h('div', { class: 'stack-sm' }, group, lockedNote(view));
  return {
    el,
    read: () => group.querySelector('input:checked')?.value,
    initial: value,
  };
}

/**
 * A write-only secret: the page never knows the value. Shows "Set" or "Not set", with Replace and Clear.
 * `onClear` is called after the person confirms.
 */
export function secretField({ label, view, help, onClear }) {
  const id = nextId('sec');
  const input = h('input', {
    id,
    class: 'input',
    type: 'password',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-describedby': `${id}-help`,
  });
  const entry = h(
    'div',
    { class: 'field', hidden: true },
    h('label', { for: id, text: `New ${label.toLowerCase()}` }),
    input,
  );
  const status = view?.set ? chip('ok', 'Set') : chip('info', 'Not set', 'info');
  const replace = button(view?.set ? 'Replace' : 'Set', {
    variant: 'tonal',
    disabled: view?.locked,
    onclick: () => {
      entry.hidden = false;
      input.focus();
    },
  });
  const clearBtn = button('Clear', {
    variant: 'text',
    disabled: view?.locked || !view?.set,
    onclick: async () => {
      const yes = await confirmDialog({
        title: `Clear the ${label.toLowerCase()}?`,
        text: 'It will be removed from this machine. You can set it again later.',
        confirm: 'Clear',
        danger: true,
      });
      if (yes) await onClear?.();
    },
  });
  const el = h(
    'div',
    { class: 'stack-sm' },
    h('span', { class: 'field-label', text: label }),
    h('div', { class: 'row' }, status, replace, clearBtn),
    entry,
    h(
      'div',
      { id: `${id}-help` },
      help ? h('span', { class: 'field-help', text: help }) : null,
      lockedNote(view),
    ),
  );
  return { el, input, read: () => (entry.hidden ? '' : input.value) };
}
