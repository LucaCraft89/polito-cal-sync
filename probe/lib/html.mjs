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

/**
 * Visible text of elements that look like messages (class or role says error/alert/warning/invalid/danger),
 * plus the page title. Server-written text, at most 5 items of 200 characters, for diagnosing a refused form.
 */
export function visibleMessages(html) {
  const strip = (s) =>
    decode(s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
  const out = [];
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (title?.[1]) out.push(`title: ${strip(title[1]).slice(0, 200)}`);
  for (const m of html.matchAll(
    /<(div|p|span|li|label|section)\b([^>]*(?:class|role)\s*=\s*"[^"]*(?:error|alert|warning|danger|invalid|message)[^"]*"[^>]*)>([\s\S]*?)<\/\1>/gi,
  )) {
    const text = strip(m[3] ?? '');
    if (text && !out.includes(text.slice(0, 200))) out.push(text.slice(0, 200));
    if (out.length >= 6) break;
  }
  return out;
}
