# Fixtures

Sanitized, invented data. Nothing here comes from a real student, calendar or Polito system.

- `m1/` — a calendar that already holds events we wrote earlier, plus two foreign events, and two source results (one complete `ics`, one incomplete `moodle`). Shows create, update, delete, unchanged, an incomplete source and foreign events being left alone.
- `m1-wipe/` — the same calendar, but the `ics` source comes back empty and "complete". Shows the deletion safety threshold refusing the run.

Try them (no accounts needed):

```
pnpm sync --dry-run --fixture test/fixtures/m1
pnpm sync --dry-run --fixture test/fixtures/m1-wipe
```

Real samples recorded from the Polito API belong here too, from M3 on, after the owner sanitized them.
