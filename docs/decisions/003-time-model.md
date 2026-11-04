# 003 CanonicalEvent time model and hash

**Decided**

- Timed events: `start`/`end` ISO-8601 with `Z` or offset; stored normalised to UTC, so the same instant written with another offset hashes the same. `end` may be omitted for a point in time (e.g. a deadline at 23:59) and then equals `start`. `end < start` is invalid.
- All-day events: `YYYY-MM-DD`, `end` is the **last day, inclusive**, defaulting to `start`; converted to Google's exclusive end only when writing.
- The hash covers kind, title, start, end, allDay, location, url, description. It does not cover `source`/`sourceId` (identity, already in the Google id). Descriptions are cut at 8000 chars (Google's limit is 8192).
- Google id = base32hex lowercase of sha1(`source:sourceId`) = 32 chars of `0-9a-v`, checked against the RFC 4648 test vectors.
- Not decided on purpose: colour per kind (open decision 2 for the owner in PLAN.md). No `colorId` is written.
