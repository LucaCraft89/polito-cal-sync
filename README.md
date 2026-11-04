# polito-cal-sync

Self-hosted service that syncs a Politecnico di Torino student's schedule, exams, bookings, deadlines and selected Moodle events into a dedicated Google Calendar.

> **Unofficial.** Not affiliated with or endorsed by Politecnico di Torino. Personal, self-hosted use only.

## Status: M3 (ICS source, Google login, serve loop; Polito API source prepared but disabled)

It can sync an ICS calendar feed into a **dedicated Google calendar**. M2 is built and unit-tested, but **has not yet run against a real Google account or a real Polito feed** (nobody with credentials has run it yet). The steps that prove it are in [`docs/M2-RUNBOOK.md`](docs/M2-RUNBOOK.md). The Moodle source, the setup wizard and `doctor` do not exist yet (see `docs/PLAN.md`). A Moodle calendar export URL already works as an ICS feed.

What exists and is tested:

- **ICS source** (`src/sources/ics/`, own parser): feed URL list, conditional GET (ETag/Last-Modified), honest User-Agent, backoff on 429/5xx, time zones, floating/UTC/all-day, recurrences with exceptions and overrides, cancelled events. A feed that fails makes the result incomplete, so nothing is deleted.
- **Google login** (`auth google`, loopback flow), a dedicated calendar (never the main one), and a client that only creates, updates and deletes events carrying our marker (`extendedProperties.private.polito_cal_sync=1`).
- **`sync`** (`--dry-run` shows the plan), a deletion safety threshold (refuse a run that would delete more than 30% of our events), sqlite history, **`serve`** (scheduled, no overlapping runs, graceful stop, heartbeat, local status page), `verify-google`.
- Coded, explained errors (`docs/ERRORS.md`), log redaction (feed URLs can hold a secret token and are never logged), secret scan in CI.

**Polito API source (M3, not usable yet).** It is written against an API description and tested on **invented** data, is **off by default** (`SOURCE_POLITO_API_ENABLED=false`) and, when switched on, says `E_POLITO_API_NOT_READY` and does nothing, because whether an unattended server can log in (the account may require MFA) is still unknown. The owner-run scripts in [`probe/`](probe/README.md) settle that; see [`docs/M3-RUNBOOK.md`](docs/M3-RUNBOOK.md). Whatever it does, it never deletes ICS events and never makes an incomplete result look complete.

What is simulated: `--fixture DIR` (developer only) uses an in-memory calendar instead of Google and says so in its output; the ICS parser it can use is the real one. Everything else talks to the real services.

## Try it without any account

Needs Node >= 22 and pnpm.

```
pnpm install
pnpm sync --dry-run --fixture test/fixtures/m2        # sanitized ICS: time zones, all-day, recurrence, cancelled
pnpm sync --dry-run --fixture test/fixtures/m1-wipe   # shows the safety threshold refusing
pnpm check                                            # typecheck + lint + format + tests + secret scan
```

## Run it for real

Follow [`docs/M2-RUNBOOK.md`](docs/M2-RUNBOOK.md): create a Google OAuth client, put your feed URL in `.env`, `pnpm auth google`, `pnpm sync --dry-run`, `pnpm sync`, then `docker compose up -d`.

Note: `pnpm doctor` is a pnpm built-in; our command is `pnpm run doctor` (not available until M5).

License: MIT.
