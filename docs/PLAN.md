# Plan

Each milestone ends with `pnpm check` green and its Done-when true and runnable.

| M | Scope | Done when |
|---|---|---|
| M0 | pnpm + TS strict + eslint/prettier + vitest, secret scan, CI workflow, Dockerfile + compose skeleton, LICENSE (MIT), README stub | `pnpm check` green; `docker compose build` works |
| M1 | `CanonicalEvent`, mapper, differ, sqlite state, Google upsert/delete with ownership marker, dry-run, deletion safety threshold | unit tests against a fake Google client cover create/patch/delete/no-op/threshold; `sync --dry-run` prints a plan |
| M2 | ICS source (URL list, caching with ETag, timezone and all-day handling, recurrence expansion) + real Google OAuth + `serve` loop | owner's real ICS feed shows up in a separate Google calendar, second run is a no-op, a removed event is deleted |
| M3 | `probe/` scripts (owner runs them): Polito login/MFA behaviour, token lifetime, real samples of lectures/exams/bookings/deadlines -> sanitized fixtures; then Polito source if feasible | `docs/decisions/` records the auth finding; with fixtures, mapper tests pass; live run only if auth works unattended |
| M4 | Moodle probe + source (export URL preferred) | Moodle events appear with their own kind/colour; failures give friendly errors |
| M5 | Wizard (local web UI): Google connect, pick/create calendar, enable sources, test, status; `doctor`; ERRORS.md for every code | a new user goes from `docker compose up` to a synced calendar following only the wizard |
| M6 | README (run steps, what is built, limits, unofficial disclaimer), SETUP.md with Google Cloud console steps, screenshots of the wizard | a fresh machine follows README without help |

## Wizard and setup UX principles
One command to start (`docker compose up -d`), then open `http://localhost:8787`. Each step shows what it needs, what it will do, and a "test" button with a plain result. Google OAuth uses the loopback flow with exact instructions for the redirect. Defaults are safe (separate calendar, dry-run first, nothing deleted on first run until confirmed). Every failure renders: what happened, why, what to do, link to the ERRORS.md entry.

## Open decisions for the owner
1. Email to Polito ICT sent? (recommended before enabling the credential path)
2. Calendar name and colour per kind.
3. Whether the Polito API source is worth enrolling a device for MFA (decided after M3).
