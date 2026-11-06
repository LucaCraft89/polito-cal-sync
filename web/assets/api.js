// The only place that talks to the server. The CSRF token lives in memory (never in storage or the URL).

let csrf = null;
export const setCsrf = (t) => {
  csrf = t ?? null;
};

export class ApiError extends Error {
  constructor(status, detail) {
    super(detail?.what ?? 'Request failed');
    this.status = status;
    this.detail = detail;
  }
}

/** `background: true` marks a refresh the page does by itself, which must not keep the session alive. */
export async function api(method, path, body, { background = false } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' && csrf ? { 'X-CSRF-Token': csrf } : {}),
        ...(background && method === 'GET' ? { 'X-Pcs-Background': '1' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError(0, undefined);
  }
  let json;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  if (!res.ok) throw new ApiError(res.status, json?.error);
  return json;
}
