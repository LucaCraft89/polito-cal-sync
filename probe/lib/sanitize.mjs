// Redact-and-save for the real samples. Default is DENY: a string survives only if it is a date,
// or an enum-looking word under a key whose name says it is an enum. Everything else becomes a
// consistent placeholder, so the same course/teacher/room gets the same placeholder everywhere.
// This is a safety net, not a guarantee: the owner reviews the result (probe/README.md checklist).

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ENUM_KEY =
  /(status|type|kind|state|category|mode|role|level|lang|locale|format|visibility|outcome|result)$/i;
const ENUM_VALUE = /^([a-z]+([A-Z][a-z0-9]*)*|[A-Z]+(_[A-Z]+)*|[a-z]+([-_][a-z]+)*)$/;
const ID_KEY = /(^id$|Id$|_id$|uid$|serial|matricola|username|code$|^key$|clientId)/i;
const PERSON_KEY =
  /(teacher|lecturer|professor|docent|surname|firstname|lastname|givenname|familyname|email|mail|phone|student|owner|author|person|holder)/i;
const GEO_KEY = /^(lat|lng|lon|latitude|longitude|coordinates|altitude)$/i;
const DAY_MS = 86_400_000;

export class Sanitizer {
  /**
   * @param {{ shiftDays?: number, secrets?: string[] }} [o]
   *   secrets: strings (username, token) that must not appear anywhere in the output.
   */
  constructor(o = {}) {
    this.shiftDays = o.shiftDays ?? 0;
    this.secrets = (o.secrets ?? []).filter((s) => s && s.length >= 3);
    /** @type {Map<string, string>} */
    this.labels = new Map();
    /** @type {Map<string, number>} */
    this.counters = new Map();
    /** Paths whose strings were replaced, counted by rule, for the review report. */
    this.stats = { redactedStrings: 0, keptEnums: 0, mappedIds: 0, shiftedDates: 0, geo: 0 };
  }

  label(prefix, original) {
    const key = `${prefix}\u0000${original}`;
    let l = this.labels.get(key);
    if (!l) {
      const n = (this.counters.get(prefix) ?? 0) + 1;
      this.counters.set(prefix, n);
      l = `${prefix}-${n}`;
      this.labels.set(key, l);
    }
    return l;
  }

  /** Moves the DATE part by whole days and keeps the rest of the string (time, zone or none) verbatim. */
  shift(s) {
    if (this.shiftDays === 0) return s;
    const t = Date.parse(`${s.slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(t)) return s;
    this.stats.shiftedDates++;
    return `${new Date(t + this.shiftDays * DAY_MS).toISOString().slice(0, 10)}${s.slice(10)}`;
  }

  /** @param {string} key @param {string} value */
  string(key, value) {
    if (ISO_DATETIME.test(value) || ISO_DATE.test(value)) return this.shift(value);
    if (ID_KEY.test(key)) {
      this.stats.mappedIds++;
      return this.label(`id`, value);
    }
    if (PERSON_KEY.test(key)) {
      this.stats.redactedStrings++;
      return this.label(`person`, value);
    }
    if (ENUM_KEY.test(key) && value.length <= 32 && ENUM_VALUE.test(value)) {
      this.stats.keptEnums++;
      return value;
    }
    this.stats.redactedStrings++;
    // One shared prefix: the same real text (a course name in a lecture title and in the course list)
    // gets the same placeholder in every file, whatever the key is called.
    return this.label('text', value);
  }

  /** @param {unknown} value @param {string} [key] key of the parent property */
  walk(value, key = '') {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return this.string(key, value);
    if (typeof value === 'number') {
      if (GEO_KEY.test(key)) {
        this.stats.geo++;
        return 0;
      }
      if (ID_KEY.test(key)) {
        this.stats.mappedIds++;
        return Number(this.label('n', String(value)).split('-')[1]) + 1000;
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((v) => this.walk(v, key));
    if (typeof value === 'object') {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        // Keys that are themselves data (ids, dates, long tokens) are mapped too.
        const safeKey = /^\d{3,}$|^[0-9a-f-]{24,}$/i.test(k) ? this.label('key', k) : k;
        out[safeKey] = this.walk(v, k);
      }
      return out;
    }
    return null;
  }

  /** Returns [sanitized, problems]. Problems are leftovers a human must look at. */
  run(value) {
    const sanitized = this.walk(value);
    return { sanitized, problems: leaks(JSON.stringify(sanitized), this.secrets) };
  }
}

const LEAK_PATTERNS = [
  ['email address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/],
  ['long hex/base64 string', /[A-Za-z0-9+/_-]{40,}/],
  ['http(s) URL', /https?:\/\/(?!example\.invalid)[^\s"]+/],
  ['Italian student id (s + 6 digits)', /\b[sdSD]\d{6}\b/],
];

/** Things that must not be in a file we are about to commit. */
export function leaks(text, secrets = []) {
  const found = [];
  for (const [name, re] of LEAK_PATTERNS) if (re.test(text)) found.push(name);
  for (const s of secrets)
    if (text.includes(s)) found.push('a value you typed or received (username/token)');
  return found;
}
