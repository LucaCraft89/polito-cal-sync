import { api, setCsrf } from '../api.js';
import { button, errorBanner, h, icon, nextId } from '../dom.js';

function strengthLevel(p) {
  if (p.length < 12) return 0;
  const distinct = new Set(p).size;
  if (p.length >= 20 && distinct >= 10) return 3;
  if (p.length >= 16 && distinct >= 8) return 2;
  return 1;
}
const HINT = [
  'At least 12 characters. A few random words work well.',
  'Long enough. Longer is stronger.',
  'Good.',
  'Strong.',
];

function authCard({ title, intro, fields, submitLabel, onSubmit }) {
  const errorSlot = h('div', { 'aria-live': 'assertive' });
  const submit = button(submitLabel, { variant: 'filled', type: 'submit', class: 'btn-block' });
  const form = h(
    'form',
    { class: 'card card-outlined auth-card', novalidate: true },
    h('h2', { class: 't-headline', text: title }),
    h('p', { class: 'muted', text: intro }),
    ...fields,
    errorSlot,
    submit,
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    errorSlot.replaceChildren();
    submit.disabled = true;
    try {
      await onSubmit();
    } catch (err) {
      errorSlot.replaceChildren(errorBanner(err));
    } finally {
      submit.disabled = false;
    }
  });
  return form;
}

export function renderSetup(done) {
  const id1 = nextId('pw');
  const id2 = nextId('pw');
  const p1 = h('input', {
    id: id1,
    class: 'input',
    type: 'password',
    autocomplete: 'new-password',
    minlength: 12,
    'aria-describedby': `${id1}-h`,
  });
  const p2 = h('input', {
    id: id2,
    class: 'input',
    type: 'password',
    autocomplete: 'new-password',
  });
  const bar = h('div', { class: 'strength', 'data-level': '0' }, h('span'));
  const hint = h('span', { id: `${id1}-h`, class: 'field-help', text: HINT[0] });
  p1.addEventListener('input', () => {
    const l = strengthLevel(p1.value);
    bar.dataset.level = String(l);
    hint.textContent = HINT[l];
  });
  const mismatch = h(
    'p',
    { class: 'field-error', role: 'alert', hidden: true },
    icon('error'),
    'The two passphrases are not the same.',
  );
  return authCard({
    title: 'Choose a passphrase',
    intro:
      'This page can change what is written to your calendar and holds your university login, so it is locked with a passphrase. Choose one now; you type it each time you open this page. It stays on this machine.',
    fields: [
      h('div', { class: 'field' }, h('label', { for: id1, text: 'Passphrase' }), p1, bar, hint),
      h('div', { class: 'field' }, h('label', { for: id2, text: 'Type it again' }), p2, mismatch),
    ],
    submitLabel: 'Set passphrase',
    onSubmit: async () => {
      mismatch.hidden = p1.value === p2.value;
      if (!mismatch.hidden) return;
      const r = await api('POST', '/api/setup', { passphrase: p1.value });
      setCsrf(r.csrfToken);
      p1.value = p2.value = '';
      done();
    },
  });
}

export function renderLogin(done) {
  const id = nextId('pw');
  const p = h('input', { id, class: 'input', type: 'password', autocomplete: 'current-password' });
  return authCard({
    title: 'Log in',
    intro:
      'Type the passphrase you chose on first run. If you lost it, run "reset-ui-passphrase" on the machine.',
    fields: [h('div', { class: 'field' }, h('label', { for: id, text: 'Passphrase' }), p)],
    submitLabel: 'Log in',
    onSubmit: async () => {
      const r = await api('POST', '/api/login', { passphrase: p.value });
      setCsrf(r.csrfToken);
      p.value = '';
      done();
    },
  });
}
