# 009 ICS source: own parser, identity, window, failure semantics

**Decided**

- **Parser: written from RFC 5545 in `src/sources/ics/`, no library.** Clean room by construction (nothing copied, no dependency, no licence to declare), and the subset students' feeds need is small: line folding, parameters, VTIMEZONE, RRULE/RDATE/EXDATE, RECURRENCE-ID, STATUS. Tests use invented ICS text only.
- **Time:** TZID is resolved with the runtime's IANA data; for a name that is not IANA (e.g. "W. Europe Standard Time") the feed's own VTIMEZONE rules are used; anything else is reported, never guessed. Floating times use the configured `TZ`. Recurrences are expanded on calendar days and combined with the wall-clock time, so a 09:00 lecture stays 09:00 across DST. A time in the spring gap uses the offset before the change, an ambiguous one is the first occurrence (RFC 5545).
- **All-day:** ICS `DTEND` is exclusive; the canonical `end` is the last day (decision 003). No `DTEND` = one day.
- **Identity:** `sourceId` = `UID` for a plain event, `UID#<start of the occurrence in UTC>` for each recurrence instance. An override (`RECURRENCE-ID`) keeps the id of the instance it replaces, so moving a lecture is an update, not delete + create. The same id in two feeds is one event (first feed wins). Feed URLs are not part of the id, so changing a token does not recreate everything.
- **Cancelled** (`STATUS:CANCELLED`, a cancelled override, `EXDATE`) = left out of the result, which makes the differ delete it if we wrote it earlier. Counted and shown as "N cancelled left out".
- **Complete = true only if** every feed was downloaded (or 304 with a usable cache) and parsed AND every event in it was understood. A failed feed, a 304 without cache, a login page instead of a feed, an event without UID, an unsupported rule or unknown time zone: `complete: false`, so nothing is deleted; the events that were understood are still created/updated. Exit code 2.
- **Window:** recurrences and events are kept for 366 days back and ahead of "now" (constants in `IcsSource`). Consequence to know: an event older than that leaves the calendar by the normal deletion path. Not configurable yet; revisit if someone wants history.
- Not supported (reported as `E_ICS_FEED_UNSUPPORTED`): HOURLY/MINUTELY/SECONDLY, BYWEEKNO/BYYEARDAY/BYHOUR..., `RANGE=THISANDFUTURE`, `RDATE;VALUE=PERIOD`, more than 5000 instances of one rule.
- `kind` is always `lecture` for ICS events: the feed does not say what an event is, and guessing from the title is exactly the kind of invention AGENTS.md forbids.
- Cache: `DATA_DIR/ics-cache/<sha256(url)>.json` (mode 0600), holds ETag, Last-Modified and the body. File names never contain the URL. 10 MB response cap, 30 s timeout, 4 attempts with backoff honouring Retry-After, 1 s pause between feeds, one request at a time.
- Messages name a feed as `feed #2 (host)`. The full URL, which can embed a token, is in no error, log line or file name (a test enforces it).
