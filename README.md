# polito-cal-sync

Self-hosted service that syncs a Politecnico di Torino student's schedule, exams, bookings, deadlines and selected Moodle events into a dedicated Google Calendar.

> **Unofficial.** Not affiliated with or endorsed by Politecnico di Torino. Personal, self-hosted use only.

## Status: M0 + M1 (sync engine only)

There is **no real source and no Google login yet**, so it cannot sync your calendar today. See `docs/PLAN.md` for the milestones.

What exists and is tested:

- The `CanonicalEvent` model, mapper (stable Google ids, content hash) and differ.
- A Google Calendar client that only creates, updates and deletes events carrying our marker (`extendedProperties.private.polito_cal_sync=1`) and never touches anything else. Tested against an in-memory fake, **not yet against real Google**.
- sqlite sync history, deletion safety threshold (default: refuse a run that would delete more than 30% of our events; `--force` overrides), `sync --dry-run`.
- Coded, explained errors (`docs/ERRORS.md`), log redaction, secret scan in CI.

What is simulated: the only way to run `sync` today is the developer flag `--fixture`, which uses invented data and an in-memory calendar (it says so in its output). Without it, `sync` stops with `E_NOT_CONFIGURED`.

## Try the engine (no accounts needed)

Needs Node >= 22 and pnpm.

```
pnpm install
pnpm sync --dry-run --fixture test/fixtures/m1        # plan only
pnpm sync --dry-run --fixture test/fixtures/m1-wipe   # shows the safety threshold refusing
pnpm check                                            # typecheck + lint + format + tests + secret scan
```

Docker (the service does not do anything useful before M2; this checks the image):

```
docker compose build
docker compose run --rm polito-cal-sync healthcheck
```

Note: `pnpm doctor` is a pnpm built-in; our command is `pnpm run doctor` (not available until M5).

License: MIT.
