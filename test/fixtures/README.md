# Fixtures

Sanitized, invented data. Nothing here comes from a real student, calendar or Polito system.

- `m1/` — a calendar that already holds events we wrote earlier, plus two foreign events, and two source results (one complete `ics`, one incomplete `moodle`). Shows create, update, delete, unchanged, an incomplete source and foreign events being left alone.
- `m1-wipe/` — the same calendar, but the `ics` source comes back empty and "complete". Shows the deletion safety threshold refusing the run.

- `m2/` — `polito.ics`, an invented calendar feed that goes through the **real** ICS parser (two time-zone styles including a Windows-style VTIMEZONE, floating and UTC times, all-day events with exclusive `DTEND`, a weekly rule with `EXDATE`, a moved occurrence, a cancelled occurrence and a cancelled event), and `calendar.json`, an in-memory calendar holding what an earlier run wrote. The plan shows creates, one update (the moved lecture), two deletes (the two cancelled ones) and unchanged events. Dates are around Nov-Dec 2026; the window is ±366 days from today.

Try them (no accounts needed):

```
pnpm sync --dry-run --fixture test/fixtures/m1
pnpm sync --dry-run --fixture test/fixtures/m1-wipe
```

- `polito/` — **invented** Polito API answers derived from the spec summary (see its README). Real samples recorded by the owner's probe, once sanitized, go in `polito/real/`.
