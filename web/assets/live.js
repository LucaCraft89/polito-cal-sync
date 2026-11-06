// Live updates: one EventSource to /api/events. The server only says WHICH topic changed ("sync", "service", ...);
// each page then reads the data it shows from the normal endpoints. Without EventSource, or when the stream is
// down, pages keep working (they refresh when opened, and the long actions poll while they run).

const handlers = new Map();
let source = null;

/** Runs `fn` (debounced) whenever one of the topics changes, for as long as `anchor` is on the page. */
export function onTopic(topics, anchor, fn) {
  let timer = null;
  const run = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (anchor.isConnected) fn();
    }, 250);
  };
  const entry = { anchor, run };
  for (const t of [topics].flat()) {
    if (!handlers.has(t)) handlers.set(t, new Set());
    handlers.get(t).add(entry);
  }
}

function dispatch(topic) {
  const set = handlers.get(topic);
  if (!set) return;
  for (const entry of [...set]) {
    if (!entry.anchor.isConnected) set.delete(entry);
    else entry.run();
  }
}

export function startLive() {
  if (source || typeof EventSource === 'undefined') return;
  source = new EventSource('/api/events');
  source.addEventListener('message', (ev) => {
    try {
      dispatch(JSON.parse(ev.data).topic);
    } catch {
      /* ignore a malformed message */
    }
  });
  // After a reconnect something may have changed while the stream was down: tell every page to look again.
  let opened = false;
  source.addEventListener('open', () => {
    if (opened) for (const t of handlers.keys()) dispatch(t);
    opened = true;
  });
  // The server ends the stream when the session ends; the next normal request shows the login.
  source.addEventListener('bye', () => stopLive());
}

export function stopLive() {
  source?.close();
  source = null;
}
