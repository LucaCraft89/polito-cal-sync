export interface FormInput {
  name: string;
  type: string;
  value: string;
}
export interface HtmlForm {
  action: string;
  method: string;
  inputs: FormInput[];
}

const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? '') : undefined;
};

const decode = (s: string): string =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** Forms of a server-rendered page (an identity provider's login pages). Not a general HTML parser. */
export function parseForms(html: string): HtmlForm[] {
  const forms: HtmlForm[] = [];
  for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const inputs: FormInput[] = [];
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
