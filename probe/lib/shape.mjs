// Redacted "shape" of a JSON value: key names, types and lengths, never the values.
// Used for everything the probe records about a response that came from a real login.

const KEEP_NUMBER_KEY = /(expir|ttl|lifetime|exp$|iat$|nbf$|seconds|maxage)/i;

/**
 * @param {unknown} value
 * @param {number} depth
 * @returns {unknown}
 */
export function shapeOf(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (depth > 6) return `array(${value.length})`;
    const sample = value.length > 0 ? shapeOf(value[0], depth + 1) : 'empty';
    return { $array: value.length, $item: sample };
  }
  switch (typeof value) {
    case 'string':
      return `string(len=${value.length})`;
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number';
    case 'boolean':
      return 'boolean';
    case 'object': {
      if (depth > 6) return 'object';
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const [k, v] of Object.entries(/** @type {object} */ (value))) {
        out[k] =
          typeof v === 'number' && KEEP_NUMBER_KEY.test(k) ? `number(${v})` : shapeOf(v, depth + 1);
      }
      return out;
    }
    default:
      return typeof value;
  }
}

/** Parses JSON text if possible; otherwise describes the text without quoting it. */
export function shapeOfBody(text, contentType) {
  if (text === '') return 'empty body';
  try {
    return shapeOf(JSON.parse(text));
  } catch {
    return `not JSON (content-type ${contentType ?? 'unknown'}, ${text.length} characters)`;
  }
}
