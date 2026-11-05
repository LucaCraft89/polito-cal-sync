# polito-cal-sync

Self-hosted service that syncs a Politecnico di Torino student's schedule, exams, bookings, deadlines and selected Moodle events into a dedicated Google Calendar.

> **Unofficial.** Not affiliated with or endorsed by Politecnico di Torino. Personal, self-hosted use only.

## Status: M5 (web UI, `doctor`) — built and tested against fakes, not yet run against a real Google account

A local web page configures everything and runs it: Google connect and calendar picker, calendar feeds and the Polito portal (each with a **Test** button), squads, **Preview** (a dry run that writes nothing), **Sync now** (with a fresh-preview rule, a one-tap confirmation, a typed confirmation beyond the deletion limit, the run lock and a 15-minute limit), Courses and History (with the paused-login state), a first-run setup checklist, and `doctor`. Start with [`docs/SETUP.md`](docs/SETUP.md). Design records: `docs/decisions/` (023 to 031); the UI spec is `docs/UI.md`.

**What is tested, and how.** `pnpm check` (typecheck, lint, format, secret scan, ~390 tests including real-browser tests with axe accessibility and layout checks at four phone-to-desktop sizes). Google is always replaced by an in-memory fake in tests: **nothing has been run against a real Google account**, not the sign-in, not a sync, not Sync now. The Polito portal login was run live read-only by the author on one account (decisions 018, 026, 028): no multi-factor step, every part understood. Moodle: a live source through Moodle's app service (decisions 033 to 036) is built and tested against an invented Moodle; its login and call shapes come from probe runs on one real account, and the program itself has not synced from the real Moodle yet. The Moodle calendar export link also still works as a feed.

What exists:

- **ICS source** (own parser): feed list, conditional GET, honest User-Agent, backoff, time zones, recurrences, cancelled events. A feed that fails makes the result incomplete, so nothing is deleted.
- **Google**: loopback sign-in with PKCE, a dedicated calendar (never the main one), a client that only creates, updates and deletes events carrying our marker (`extendedProperties.private.polito_cal_sync=1`).
- **Safety**: deletion limit (refuse a run that would remove more than 30% of our events), run lock, sqlite history, rate limits on everything that contacts the university or Google, secrets redacted from logs and never sent back to the browser.
- **`sync`**, **`serve`** (scheduled, graceful stop, heartbeat), **`doctor`**, `verify-google`, coded and explained errors (`docs/ERRORS.md`).
- **Web UI**: plain HTML and scripts (no framework, no third-party request), our own approximation of Material 3 design tokens, WCAG 2.2 AA target.

**Polito portal source (opt-in, off by default).** With the portal switched on and your username and password saved, the service logs in the way a browser does (university single sign-on), reads your lectures, exam calls (booked ones as exams), booking slots and academic-calendar dates, and writes them next to your feed events. **Read this first:** it uses your real university password (stored in a file only you can read, not encrypted); it is not an advertised API and can break when the portal changes; a login from a server can be answered with a multi-factor step, in which case the source stops (`E_POLITO_LOGIN_EXTRA_STEP`) and the feeds are unaffected; if the university refuses the password, further attempts are paused until you change it. It never deletes feed events and never makes an incomplete result look complete.

**Not built:** one calendar per course (decision 013), screenshots. Everything else in the plan exists.

What is simulated: `--fixture DIR` (developer only) uses an in-memory calendar instead of Google and says so in its output; the ICS parser it can use is the real one. Everything else in the program talks to the real services (it is the tests that use fakes).

## Try it without any account

Needs Node >= 22 and pnpm.

```
pnpm install
pnpm sync --dry-run --fixture test/fixtures/m2        # sanitized ICS: time zones, all-day, recurrence, cancelled
pnpm sync --dry-run --fixture test/fixtures/m1-wipe   # shows the safety threshold refusing
pnpm check                                            # typecheck + lint + format + tests + secret scan
```

## Run it for real

Follow [`docs/SETUP.md`](docs/SETUP.md): start it, open http://localhost:8787, and the Overview page lists the steps. The command-line route is still in [`docs/M2-RUNBOOK.md`](docs/M2-RUNBOOK.md) (`pnpm auth google`, `pnpm sync --dry-run`, `pnpm sync`).

Note: `pnpm doctor` is a pnpm built-in; our command is `pnpm run doctor`.

License: MIT.
