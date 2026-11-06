import { api } from '../api.js';
import { onTopic } from '../live.js';
import { banner, chip, errorBanner, h, loading, when } from '../dom.js';

/** The courses from the last read of the portal, with the squads seen and the ones chosen. Names are text only. */
export async function renderCourses() {
  const page = h(
    'div',
    { class: 'page' },
    h(
      'header',
      {},
      h('p', { class: 'muted', text: 'Your courses, as the Polito portal lists them.' }),
    ),
  );
  const body = h('div', { class: 'cards' }, loading('Loading…'));
  page.append(body);

  async function load(background) {
    try {
      const r = await api('GET', '/api/courses', undefined, { background });
      if (r.courses.length === 0) {
        body.replaceChildren(
          banner(
            'info',
            'No courses yet',
            'They appear after the first read of the portal. Switch the Polito portal on under Sources, then run a preview.',
            h('a', { class: 'btn btn-tonal', href: '#/preview' }, 'Open Preview'),
          ),
        );
        return;
      }
      const cards = r.courses.map((c) => {
        const squads = h('div', { class: 'row' });
        if (c.labels.length === 0) squads.append(chip('info', 'No squads'));
        for (const label of c.labels) {
          squads.append(
            c.chosen.includes(label)
              ? chip('ok', `Squad ${label} (yours)`)
              : chip('info', `Squad ${label}`),
          );
        }
        return h(
          'section',
          { class: 'card' },
          h('h2', { text: c.name }),
          h('p', { class: 'muted t-small', text: `Course ${c.courseId}` }),
          squads,
          c.labels.length > 0 && c.chosen.length === 0
            ? h('p', {
                class: 'field-help',
                text: 'No squad chosen: lessons of every squad are kept.',
              })
            : null,
        );
      });
      body.replaceChildren(
        ...cards,
        h(
          'p',
          { class: 'field-help' },
          `Read from the portal ${when(r.updatedAt)}. Choose your squads under `,
          h('a', { href: '#/sources', text: 'Sources' }),
          '.',
        ),
      );
    } catch (err) {
      if (!background) body.replaceChildren(errorBanner(err));
    }
  }

  await load(false);
  // A preview or a sync reads the portal and refreshes the saved course list; a settings save changes the chosen squads.
  onTopic(['preview', 'sync', 'settings'], page, () => load(true));
  return page;
}
