// Just enough HTML reading for SSO forms: forms, their inputs, button names. Regex based on purpose
// (no dependency); good for the simple server-rendered pages of an IdP, not a general parser.

const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? '') : undefined;
};
const decode = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** @returns {{ action: string, method: string, inputs: { name: string, type: string, value: string }[] }[]} */
export function parseForms(html) {
  const forms = [];
  for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const inputs = [];
    for (const i of (m[2] ?? '').matchAll(/<(input|button)\b([^>]*)>/gi)) {
      const name = attr(i[2] ?? '', 'name');
      if (!name) continue;
      inputs.push({
        name: decode(name),
        type: (attr(i[2] ?? '', 'type') ?? (i[1] === 'button' ? 'submit' : 'text')).toLowerCase(),
        value: decode(attr(i[2] ?? '', 'value') ?? ''),
      });
    }
    forms.push({
      action: decode(attr(m[1] ?? '', 'action') ?? ''),
      method: (attr(m[1] ?? '', 'method') ?? 'get').toLowerCase(),
      inputs,
    });
  }
  return forms;
}
