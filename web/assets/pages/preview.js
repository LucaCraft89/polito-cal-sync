import { api } from '../api.js';
import { banner, button, chip, errorBanner, h, loading, when } from '../dom.js';

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

export function renderPreviewResult(p) {
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
    result,
  );
  const run = async () => {
    result.replaceChildren(
      loading('Reading your sources. The Polito portal can take about 20 seconds…'),
    );
    try {
      const r = await api('POST', '/api/preview', {});
      result.replaceChildren(renderPreviewResult(r.preview));
    } catch (err) {
      result.replaceChildren(errorBanner(err));
      // The previous result stays useful next to the explanation (a refused repeat, a failed attempt).
      try {
        const last = await api('GET', '/api/preview');
        if (last.preview) result.append(renderPreviewResult(last.preview));
      } catch {
        /* the banner above already says what is wrong */
      }
    }
  };
  // Show the last preview of this session, if the server still has it.
  try {
    const r = await api('GET', '/api/preview');
    if (r.preview) result.replaceChildren(renderPreviewResult(r.preview));
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
  return page;
}
