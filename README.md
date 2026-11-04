# polito-cal-sync

Self-hosted service that syncs a Politecnico di Torino student's schedule, exams, bookings, deadlines and selected Moodle events into a dedicated Google Calendar.

> **Unofficial.** Not affiliated with or endorsed by Politecnico di Torino. Personal, self-hosted use only.

## Status: M3 (ICS source, Google login, serve loop; Polito portal source, opt-in)

It can sync an ICS calendar feed into a **dedicated Google calendar**. M2 is built and unit-tested, but **has not yet run against a real Google account or a real Polito feed** (nobody with credentials has run it yet). The steps that prove it are in [`docs/M2-RUNBOOK.md`](docs/M2-RUNBOOK.md). The Moodle source, the setup wizard and `doctor` do not exist yet (see `docs/PLAN.md`). A Moodle calendar export URL already works as an ICS feed.

What exists and is tested:

- **ICS source** (`src/sources/ics/`, own parser): feed URL list, conditional GET (ETag/Last-Modified), honest User-Agent, backoff on 429/5xx, time zones, floating/UTC/all-day, recurrences with exceptions and overrides, cancelled events. A feed that fails makes the result incomplete, so nothing is deleted.
- **Google login** (`auth google`, loopback flow), a dedicated calendar (never the main one), and a client that only creates, updates and deletes events carrying our marker (`extendedProperties.private.polito_cal_sync=1`).
- **`sync`** (`--dry-run` shows the plan), a deletion safety threshold (refuse a run that would delete more than 30% of our events), sqlite history, **`serve`** (scheduled, no overlapping runs, graceful stop, heartbeat, local status page), `verify-google`.
- Coded, explained errors (`docs/ERRORS.md`), log redaction (feed URLs can hold a secret token and are never logged), secret scan in CI.

**Polito portal source (M3, opt-in, off by default).** With `SOURCE_POLITO_PORTAL_ENABLED=true` plus `POLITO_USERNAME` and `POLITO_PASSWORD` in `.env`, the service logs in to the student portal the way a browser does (university single sign-on), reads your lectures, exam calls (booked ones as exams), booking slots and academic-calendar dates from one JSON document, and writes them next to your ICS events. **Read this first:** it uses your real university password, stored in `.env` on your machine; it is not an advertised API and can break when the portal changes; a login from a server can be answered with a multi-factor step, in which case the source stops (`E_POLITO_LOGIN_EXTRA_STEP`) and the ICS source is unaffected; if the university refuses the password, further attempts are paused until you change it (so an hourly retry never locks your account). It never deletes ICS events and never makes an incomplete result look complete. It has been proven on one account's real login (decision 018); its mapper was written from that account's sanitized sample, so other accounts may show differences. Steps: [`docs/M3-RUNBOOK.md`](docs/M3-RUNBOOK.md).

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
