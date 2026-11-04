# 002 Ownership guard and Google id reuse

**Decided**

- `OwnedCalendar` is the only code that writes to Google. It lists with `privateExtendedProperty=polito_cal_sync=1` and re-checks the marker locally. patch/delete are refused with `E_NOT_OURS` for any id not seen carrying the marker in this instance's `listManaged()` (or created by it). Cheaper than a `get` before each write, and it fails closed.
- A deleted Google event leaves a "cancelled" tombstone that keeps blocking its id (insert returns 409). On 409 we `get` the id: tombstone or event with our marker -> restore it with a patch carrying our full content; a live event **without** our marker -> `E_ID_COLLISION`, event untouched, item skipped.
- Per-event failures do not stop a run; auth, permission, missing calendar, quota, outage and internal errors do (they would repeat on every call).

**UNVERIFIED against real Google:** that `events.patch` can restore a cancelled event, and that a tombstone from `events.get` carries no extended properties. The in-memory fake is written to that assumption. Verify in M2 with the real calendar; the fallback is `events.update` (full replace).
