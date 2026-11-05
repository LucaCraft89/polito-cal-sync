# Plan

Each milestone ends with `pnpm check` green and its Done-when true and runnable.

| M | Scope | Done when |
|---|---|---|
| M0 | pnpm + TS strict + eslint/prettier + vitest, secret scan, CI workflow, Dockerfile + compose skeleton, LICENSE (MIT), README stub | `pnpm check` green; `docker compose build` works |
| M1 | `CanonicalEvent`, mapper, differ, sqlite state, Google upsert/delete with ownership marker, dry-run, deletion safety threshold | unit tests against a fake Google client cover create/patch/delete/no-op/threshold; `sync --dry-run` prints a plan |
| M2 | ICS source (URL list, caching with ETag, timezone and all-day handling, recurrence expansion) + real Google OAuth + `serve` loop | owner's real ICS feed shows up in a separate Google calendar, second run is a no-op, a removed event is deleted |
| M3 | `probe/` scripts (owner runs them): Polito login/MFA behaviour, token lifetime, real samples of lectures/exams/bookings/deadlines -> sanitized fixtures; then Polito source if feasible | `docs/decisions/` records the auth finding; with fixtures, mapper tests pass; live run only if auth works unattended |
| M4 | Moodle probe + source (export URL preferred) | Moodle events appear with their own kind/colour; failures give friendly errors. **Done** (decisions 020, 022): the export URL is an ICS feed; the settings store and secured API of M5 step 1 were built here too (decision 023). |
| M5 | **Web UI** (full spec in `docs/UI.md`): settings store + secured API first, then a mobile-first, responsive, Material 3 Expressive UI for everything configurable: Google connect and calendar, sources with Test buttons, Polito login / exam calls / squads, preview, sync now, status and history; first-run wizard; `doctor`; ERRORS.md for every code | a new user goes from `docker compose up` to a synced calendar following only the UI, on a phone and on a laptop; responsive, accessibility and security tests in `UI.md` section 7 pass in CI |
| M6 | README (run steps, what is built, limits, unofficial disclaimer), SETUP.md with Google Cloud console steps, screenshots of the wizard | a fresh machine follows README without help |

## Web UI (M5): requirements in short
Everything configurable lives in the UI; `.env` stays valid and wins (shown read-only). Full text: `docs/UI.md`.
- **Mobile first and responsive:** Material window size classes (compact under 600 px, medium 600 to 839, expanded from 840), bottom navigation bar / rail / drawer, no horizontal scroll at 320 px, touch targets of at least 48 px, the main action reachable with the keyboard open, WCAG 2.2 AA. Tested with Playwright at 360, 390, 768 and 1280 px.
- **Security:** local only (`127.0.0.1`; Host allow-list), passphrase (scrypt) and server-side sessions, CSRF token plus Origin check, strict CSP and headers with no inline scripts and no third-party requests, untrusted text rendered as text, write-only secret fields (the Polito password and Google secret are never sent back), settings file mode 0600, rate-limited sync, preview by default and typed confirmation for anything beyond the deletion limit, audit log without secrets.
- **Design:** Material 3 Expressive (colour roles from a seed with light and dark, expressive shape scale, spring-like motion that respects `prefers-reduced-motion`, emphasised type, self-hosted fonts). There is no official web implementation, so tokens and components are our own.

## Wizard and setup UX principles
One command to start (`docker compose up -d`), then open `http://localhost:8787`. Each step shows what it needs, what it will do, and a "test" button with a plain result. Google OAuth uses the loopback flow with exact instructions for the redirect. Defaults are safe (separate calendar, dry-run first, nothing deleted on first run until confirmed). Every failure renders: what happened, why, what to do, link to the ERRORS.md entry.

## Open decisions for the owner
1. Email to Polito ICT sent? (recommended before enabling the credential path)
2. Calendar name and colour per kind.
3. Whether the Polito API source is worth enrolling a device for MFA (decided after M3). Superseded: the portal route works without MFA (decision 018); the app API is closed.
4. Bring the **settings store, secured API and auth** (first step of M5, `docs/UI.md` section 8) forward to the start of M4, so that Moodle, squads and course names do not become more `.env` lines? Recommended: yes. **Done** (decision 023; off by default, no pages).
5. UI server: extend the existing `node:http` status server, or add `fastify` as AGENTS.md lists it? **Decided: extend `node:http`** (decision 023); the owner can overrule.
