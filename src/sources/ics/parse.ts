/**
 * Minimal RFC 5545 content-line parser, written from the RFC text. It knows nothing about event
 * semantics: it unfolds lines, splits name / parameters / value, and builds the component tree.
 */

export interface IcsProp {
  /** Upper-cased property name. */
  name: string;
  /** Upper-cased parameter names; values without surrounding quotes. */
  params: Record<string, string[]>;
  /** Raw value, still escaped. */
  value: string;
}

export interface IcsComponent {
  name: string;
  props: IcsProp[];
  children: IcsComponent[];
}

/** The text is not a usable iCalendar file. Messages never contain feed content. */
export class IcsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IcsParseError';
  }
}

/** Joins folded lines (a line starting with a space or tab continues the previous one). */
export function unfold(text: string): string[] {
  const lines = text.replace(/^\u{FEFF}/u, '').split(/\r\n|\n|\r/);
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out.filter((l) => l.length > 0);
}

/** Splits `NAME;P=a,b;Q="x:y":value` at the first colon that is not inside quotes. */
export function parseContentLine(line: string): IcsProp {
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ':' && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) throw new IcsParseError('a content line has no ":" separator');
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);

  const parts: string[] = [];
  let current = '';
  inQuotes = false;
  for (const c of head) {
    if (c === '"') {
      inQuotes = !inQuotes;
      current += c;
    } else if (c === ';' && !inQuotes) {
      parts.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  parts.push(current);

  const name = (parts[0] ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(name)) throw new IcsParseError('a property has an invalid name');
  const params: Record<string, string[]> = {};
  for (const raw of parts.slice(1)) {
    const eq = raw.indexOf('=');
    if (eq <= 0) continue; // tolerate junk parameters
    const pname = raw.slice(0, eq).trim().toUpperCase();
    const values: string[] = [];
    let v = '';
    let q = false;
    for (const c of raw.slice(eq + 1)) {
      if (c === '"') q = !q;
      else if (c === ',' && !q) {
        values.push(v);
        v = '';
      } else v += c;
    }
    values.push(v);
    params[pname] = values;
  }
  return { name, params, value };
}

/** Parses a whole file and returns the top-level components (normally one VCALENDAR). */
export function parseIcs(text: string): IcsComponent[] {
  const roots: IcsComponent[] = [];
  const stack: IcsComponent[] = [];
  for (const line of unfold(text)) {
    const prop = parseContentLine(line);
    if (prop.name === 'BEGIN') {
      const comp: IcsComponent = { name: prop.value.trim().toUpperCase(), props: [], children: [] };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(comp);
      else roots.push(comp);
      stack.push(comp);
    } else if (prop.name === 'END') {
      const top = stack.pop();
      if (!top || top.name !== prop.value.trim().toUpperCase()) {
        throw new IcsParseError('a BEGIN/END pair does not match');
      }
    } else {
      const top = stack[stack.length - 1];
      if (!top) throw new IcsParseError('a property appears outside any component');
      top.props.push(prop);
    }
  }
  if (stack.length > 0) throw new IcsParseError('the file ends inside an unclosed component');
  if (!roots.some((r) => r.name === 'VCALENDAR')) {
    throw new IcsParseError('there is no VCALENDAR component');
  }
  return roots;
}

/** Unescapes a TEXT value (`\n`, `\,`, `\;`, `\\`). */
export function unescapeText(s: string): string {
  return s.replace(/\\([nN,;\\])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

export function firstProp(c: IcsComponent, name: string): IcsProp | undefined {
  return c.props.find((p) => p.name === name);
}

export function allProps(c: IcsComponent, name: string): IcsProp[] {
  return c.props.filter((p) => p.name === name);
}
