# 010 Verifying decision 002 against real Google

Decision 002 assumed (UNVERIFIED) that `events.patch` restores a deleted event and that `events.get` of a tombstone has no extended properties. No Google account exists in the build session, so this is **still UNVERIFIED**, but now the program does not depend on the answer and the owner can settle it with one command.

**Decided**

- `OwnedCalendar` restores a deleted id like this: `patch`; if Google answers 404/410 or returns the event still `cancelled`, `events.update` (full replace). Both paths are unit-tested against the in-memory fake in its three possible behaviours (`restores`, `answers-410`, `stays-cancelled`).
- `EventsApi` gained `update`.
- `verify-google` creates a **throw-away calendar** ("polito-cal-sync verify (safe to delete)"), inserts an event with our marker, deletes it, reads the tombstone, inserts the same id again, patches (then updates) it, lists with the marker filter, and deletes the calendar. It never touches the real calendar and prints only HTTP statuses and yes/no findings. If cleanup fails it says which calendar to delete by hand.
- The tombstone assumption is only used in the 409 branch, where a tombstone **or** a live event with our marker is restored and a live event without the marker is `E_ID_COLLISION`. If the tombstone turns out to keep our properties nothing changes; if a live foreign event is ever mistaken for a tombstone the `status` check protects it.

**Open:** the owner runs `pnpm verify-google` once (docs/M2-RUNBOOK.md) and the result is added here as "Finding: ...". Until then treat the patch-vs-update question as unknown.
