import { api } from '../api.js';
import { onTopic } from '../live.js';
import {
  banner,
  button,
  chip,
  confirmDialog,
  errorBanner,
  h,
  loading,
  nextId,
  when,
} from '../dom.js';

const KINDS = {
  lecture: 'Lecture',
  exam: 'Exam (booked)',
  exam_call: 'Exam call',
  booking: 'Booking',
  deadline: 'Deadline',
  assignment: 'Assignment',
  moodle: 'Moodle',
};

function eventRow(ev) {
  return h(
    'li',
    { class: 'list-item' },
    h(
      'div',
      { class: 'grow' },
      // Event text comes from the portal or a feed: text nodes only.
      h('span', { class: 't-label', text: ev.title }),
      h('span', {
        class: 'muted t-small',
        text: [when(ev.start), ev.location, ev.course].filter(Boolean).join(' · '),
      }),
    ),
    h('span', { class: 'chip chip-info', text: KINDS[ev.kind] ?? ev.kind }),
  );
}

function section(title, rows, empty) {
  const list = h('ul', { class: 'list', 'aria-label': title });
  for (const r of rows.slice(0, 200)) list.append(eventRow(r));
  return h(
    'section',
    { class: 'card', 'aria-label': title },
    h('h2', { text: `${title} (${rows.length})` }),
    rows.length ? list : h('p', { class: 'muted', text: empty }),
    rows.length > 200
      ? h('p', { class: 'field-help', text: `Showing the first 200 of ${rows.length}.` })
      : null,
  );
}

const POLL_MS = 1500;
const phrase = (deletes) => `remove ${deletes}`;
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The outcome of a real sync, in words and numbers (never event titles). */
export function syncResult(run) {
  const r = run.result;
  const out = h('div', { class: 'stack' });
  const numbers = `${count(r.created, 'event', 'events')} added, ${r.patched} changed, ${r.deleted} removed${r.failed ? `, ${r.failed} could not be written` : ''}.`;
  if (r.status === 'ok') out.append(banner('ok', 'The sync is done', numbers));
  else if (r.status === 'partial')
    out.append(banner('warn', 'The sync is done, with problems', numbers));
  else if (r.status === 'refused')
    out.append(banner('warn', 'The sync was refused', 'Nothing was changed.'));
  else out.append(banner('bad', 'The sync did not finish', numbers));
  if (r.error) out.append(errorBanner({ detail: r.error }));
  for (const e of r.problems) out.append(banner('warn', e.what, `${e.why} ${e.action}`));
  out.append(
    h('p', {
      class: 'field-help',
      text: `Finished ${when(run.finishedAt)}. The preview is outdated now: press "Preview now" to see the calendar as it is.`,
    }),
  );
  return out;
}

/** Waits for the background sync to end, then shows its result in `slot`. */
async function followSync(slot) {
  slot.replaceChildren(loading('Syncing your calendar. This can take a minute…'));
  for (;;) {
    let st;
    try {
      st = await api('GET', '/api/sync');
    } catch (err) {
      slot.replaceChildren(errorBanner(err));
      return;
    }
    if (st.run.state === 'done') {
      slot.replaceChildren(syncResult(st.run));
      return;
    }
    if (st.run.state === 'idle') {
      slot.replaceChildren();
      return;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (!slot.isConnected) return; // the person left the page; the sync goes on and its result stays on the server
  }
}

/** "Sync now": a second step after the preview, with one tap to confirm (and a typed phrase beyond the limit). */
function syncCard(p, slot, onDone) {
  const total = p.counts.creates + p.counts.patches + p.counts.deletes;
  const card = h(
    'section',
    { class: 'card', 'aria-labelledby': 'h-sync' },
    h('h2', { id: 'h-sync', text: 'Write this to your calendar' }),
  );
  if (total === 0) {
    card.append(
      h('p', {
        class: 'muted',
        text: 'Nothing to change: your calendar already matches your sources.',
      }),
    );
    return card;
  }
  card.append(
    h('p', {
      class: 'muted',
      text: `${count(p.counts.creates, 'event', 'events')} to add, ${p.counts.patches} to change, ${p.counts.deletes} to remove. Only events this program created are ever changed or removed.`,
    }),
  );
  if (!p.complete) {
    card.append(
      banner(
        'warn',
        'Some source is incomplete',
        'Nothing is removed for an incomplete source; the rest is written.',
      ),
    );
  }
  const errors = h('div', { 'aria-live': 'assertive' });
  const go = button('Sync now', {
    iconName: 'play',
    onclick: async () => {
      errors.replaceChildren();
      let typed;
      let extra;
      if (p.safety.exceeded) {
        const id = nextId('typed');
        typed = h('input', {
          id,
          class: 'input',
          type: 'text',
          autocomplete: 'off',
          spellcheck: 'false',
        });
        extra = h(
          'div',
          { class: 'field' },
          h('label', { for: id, text: `Type "${phrase(p.safety.deletes)}" to confirm` }),
          typed,
        );
      }
      const yes = await confirmDialog({
        title: p.safety.exceeded
          ? 'Remove this many events?'
          : 'Write these changes to your calendar?',
        text: p.safety.exceeded
          ? `This removes ${p.safety.deletes} of ${p.safety.managedInScope} events, more than your limit of ${Math.round(p.safety.threshold * 100)}%. That usually means a source came back empty or partial.`
          : `${count(p.counts.creates, 'event', 'events')} added, ${p.counts.patches} changed, ${p.counts.deletes} removed in your dedicated Google calendar.`,
        confirm: p.safety.exceeded ? 'Remove and sync' : 'Sync now',
        danger: p.safety.exceeded,
        ...(extra
          ? {
              extra,
              canConfirm: () => typed.value.trim().toLowerCase() === phrase(p.safety.deletes),
            }
          : {}),
      });
      if (!yes) return;
      go.disabled = true;
      try {
        await api('POST', '/api/sync', {
          previewAt: p.generatedAt,
          confirm: true,
          ...(typed ? { typed: typed.value } : {}),
        });
        onDone?.();
        await followSync(slot);
      } catch (err) {
        errors.replaceChildren(errorBanner(err));
      } finally {
        go.disabled = false;
      }
    },
  });
  card.append(errors, h('div', { class: 'card-actions' }, go));
  return card;
}

export function renderPreviewResult(p, syncSlot, onSyncStarted) {
  const out = h('div', { class: 'stack' });
  out.append(
    h(
      'div',
      { class: 'row' },
      p.safety.exceeded ? chip('bad', 'Would be refused') : chip('ok', 'Within the safety limit'),
      p.complete ? chip('ok', 'All sources complete') : chip('warn', 'Some source is incomplete'),
      h('span', { class: 'muted t-small', text: `Fetched ${when(p.generatedAt)}` }),
    ),
  );
  if (p.safety.exceeded) {
    out.append(
      banner(
        'bad',
        `This would remove ${p.safety.deletes} of ${p.safety.managedInScope} events, more than the limit of ${Math.round(p.safety.threshold * 100)}%.`,
        'A real sync would stop and change nothing until you confirm it explicitly.',
      ),
    );
  }
  if (syncSlot) out.append(syncCard(p, syncSlot, onSyncStarted));
  for (const note of p.notes) out.append(banner('info', note));
  for (const e of p.problems) out.append(banner('warn', e.what, `${e.why} ${e.action}`));
  out.append(
    h(
      'dl',
      { class: 'kv card' },
      h('div', {}, h('dt', { text: 'Would add' }), h('dd', { text: String(p.counts.creates) })),
      h('div', {}, h('dt', { text: 'Would change' }), h('dd', { text: String(p.counts.patches) })),
      h('div', {}, h('dt', { text: 'Would remove' }), h('dd', { text: String(p.counts.deletes) })),
      h(
        'div',
        {},
        h('dt', { text: 'Already up to date' }),
        h('dd', { text: String(p.counts.unchanged) }),
      ),
    ),
    h(
      'div',
      { class: 'cards' },
      section('To add', p.creates, 'Nothing new.'),
      section('To change', p.patches, 'Nothing changes.'),
      section('To remove', p.deletes, 'Nothing is removed.'),
    ),
  );
  return out;
}

export async function renderPreview() {
  const result = h('div', { 'aria-live': 'polite' });
  const syncSlot = h('div', { 'aria-live': 'polite', 'data-sync-result': true });
  const view = (p) => renderPreviewResult(p, syncSlot, () => result.replaceChildren());
  const show = (p) => result.replaceChildren(view(p));
  const page = h(
    'div',
    { class: 'page' },
    h(
      'header',
      {},
      h('p', {
        class: 'muted',
        text: 'What a sync would do right now. A preview never writes anything to your calendar.',
      }),
    ),
    syncSlot,
    result,
  );
  let busy = false; // a preview started from this page is running
  let following = false;
  const follow = () => {
    if (following) return;
    following = true;
    void followSync(syncSlot).finally(() => (following = false));
  };
  const run = async () => {
    busy = true;
    syncSlot.replaceChildren();
    try {
      result.replaceChildren(
        loading('Reading your sources. The Polito portal can take about 20 seconds…'),
      );
      try {
        const r = await api('POST', '/api/preview', {});
        show(r.preview);
      } catch (err) {
        result.replaceChildren(errorBanner(err));
        // The previous result stays useful next to the explanation (a refused repeat, a failed attempt).
        try {
          const last = await api('GET', '/api/preview');
          if (last.preview) result.append(view(last.preview));
        } catch {
          /* the banner above already says what is wrong */
        }
      }
    } finally {
      busy = false;
    }
  };

  // Show the last preview of this session, if the server still has it.
  try {
    const r = await api('GET', '/api/preview');
    if (r.preview) show(r.preview);
    else
      result.replaceChildren(
        banner(
          'info',
          'No preview yet',
          'Press "Preview now" to read your sources and see what would change.',
        ),
      );
  } catch (err) {
    result.replaceChildren(errorBanner(err));
  }
  page.append(button('Preview now', { class: 'fab', iconName: 'play', onclick: run }));
  // Live: a preview made elsewhere (another tab), a sync, or a scheduled run that made the preview outdated.
  onTopic('preview', page, async () => {
    if (busy) return;
    try {
      const r = await api('GET', '/api/preview', undefined, { background: true });
      if (r.preview) show(r.preview);
      else
        result.replaceChildren(
          banner(
            'info',
            'No current preview',
            'The calendar changed, or no preview was made yet. Press "Preview now" to read your sources again.',
          ),
        );
    } catch {
      /* the next normal request shows what is wrong */
    }
  });
  onTopic('sync', page, async () => {
    try {
      const st = await api('GET', '/api/sync', undefined, { background: true });
      if (st.run.state === 'running') follow();
      else if (st.run.state === 'done') syncSlot.replaceChildren(syncResult(st.run));
    } catch {
      /* ignore */
    }
  });
  // A sync started from this page may be running or just finished: say so (does not delay the page).
  void api('GET', '/api/sync')
    .then((st) => {
      if (st.run.state === 'running') follow();
      else if (st.run.state === 'done') syncSlot.replaceChildren(syncResult(st.run));
    })
    .catch(() => {
      /* the preview area shows connection problems */
    });
  return page;
}
