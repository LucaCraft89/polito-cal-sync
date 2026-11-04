# AGENTS.md — read first, every session

**polito-cal-sync**: a self-hosted Docker service that copies a Politecnico di Torino student's schedule, exams, exam calls, bookings, deadlines and assignments, plus selected Moodle events, into a **dedicated Google Calendar** (never the user's main one). Single user, single machine. Unofficial: not affiliated with or endorsed by Politecnico di Torino.

## Ground rules
- **Clean room.** Write everything from scratch. Do not copy or adapt code from `polito/students-app`, `polito/rn-apps` (EUPL-1.2), `open-polito/*` (AGPL-3.0), `polito_api_flutter` (EUPL-1.2) or any other third-party client. `polito/api-spec` has **no license**: read it as documentation, never vendor its files or commit clients generated from it. Do not use the owner's older Nextcloud/Classeviva sync projects as a model. Our license is MIT.
- **Never touch what we didn't create.** Every event we write carries `extendedProperties.private.polito_cal_sync=1` plus `source` and `sourceId`. We only update or delete events with that marker, in the one calendar the user picked.
- **Secrets** (Polito credentials, tokens, Google OAuth tokens, Moodle tokens) live only in the `DATA_DIR` volume (file mode 0600) or `.env`. Never commit them, never log them, never print them in errors. Test fixtures are sanitized.
- **Low traffic.** Personal use only: default sync every 60 min, backoff on 429/5xx, no parallel hammering, identify with an honest `User-Agent` (`polito-cal-sync/<version> (personal, self-hosted)`).
- **No guessing.** Anything marked UNVERIFIED below must be confirmed by the probe (`probe/`) against the real service before code depends on it. Do not invent response shapes; record real (sanitized) samples in `test/fixtures/`.
- **No mocked "features".** Mocks are for tests only. If something is not implemented, say so in the README.
- Scope: deliver what the step asks. Cut scope before cutting quality. Ask the human only for real decisions (credentials, Google console steps, anything affecting their Polito account).

## Stack
Node >= 22, TypeScript strict, ESM, pnpm. `zod` (config and API validation), `googleapis` (Calendar), `better-sqlite3` (sync state), `fastify` (wizard and status page, local only), `pino` (logs), `vitest` (tests), `eslint` + `prettier`. Docker: multi-stage, non-root, one volume `/data`, healthcheck.

## Structure
```
AGENTS.md CLAUDE.md README.md LICENSE .env.example docker-compose.yml Dockerfile
docs/        RESEARCH.md (facts and sources), PLAN.md (milestones), SETUP.md (user guide), ERRORS.md (every error code), decisions/
probe/       throwaway recon scripts the USER runs on their own machine; output to probe/out (git-ignored)
src/
  config/    env + data-dir config, zod-validated, friendly validation errors
  util/      http client (timeouts, retry, backoff, UA), logger with redaction, errors
  sources/
    types.ts       CanonicalEvent + Source interface
    ics/           per-course / feed ICS reader (no credentials)
    polito/        clean-room client for app.didattica.polito.it/api: auth, lectures, exams, bookings, deadlines, assignments
    moodle/        Moodle adapter (iCal export or web-service token, decided by probe)
  sync/      mapper (source item -> CanonicalEvent), differ, applier, state (sqlite), scheduler
  google/    OAuth (installed-app/loopback or device flow), calendar list/create, event upsert/delete
  wizard/    first-run local web UI: Google connect, pick/create calendar, connect sources, test sync, status
  main.ts    wires config -> sources -> sync -> google; CLI: `serve`, `sync --dry-run`, `doctor`
test/ fixtures/   scripts/   docker/
```

## Core model
`CanonicalEvent { source, sourceId, kind(lecture|exam|exam_call|booking|deadline|assignment|moodle), title, start, end|allDay, location?, url?, description?, hash }`.
Google event ID = base32hex(sha1(`source:sourceId`)) so upserts are idempotent. The differ compares `hash`; the applier does create / patch / delete. Items that disappear from a source are removed from the calendar only if (a) the source fetch fully succeeded and (b) the deletion count is under a safety threshold (default: refuse if > 30% of managed events would go; require `--force`). `sync --dry-run` prints the plan and writes nothing. Each run is recorded in sqlite and shown on the status page.

## Errors (verbosity is a feature)
Every user-facing error has: stable code (`E_GOOGLE_AUTH_EXPIRED`), **what happened**, **likely why**, **what to do**, and a docs anchor in `docs/ERRORS.md`. Never a bare stack trace in the wizard or in `doctor`; stack traces go to debug logs only. `doctor` checks: data dir writable, Google token valid, calendar reachable, each enabled source reachable and authenticated, clock/TZ sane, last sync result.

## Known facts (sources and confidence in docs/RESEARCH.md)
- Official API spec: `github.com/polito/api-spec` (TypeSpec, no license). Server: `https://app.didattica.polito.it/api` (UNVERIFIED against live traffic).
- Endpoints seen in the spec: `POST /auth/login` (`basic`: username+password, or `sso`: uid+key; body also needs `preferences`; returns `Identity{username,type,clientId,token}`), `GET /lectures?fromDate&toDate&courseIds[]` (Lecture fields UNVERIFIED), `GET /exams` (`bookingStartsAt|EndsAt`, `examStartsAt|EndsAt` UTC, status enum, `places`), `GET /courses/{id}/assignments` (only `uploadedAt`, no due date), `GET /deadlines?fromDate&toDate` (plain `date`), `GET /bookings` (`startsAt`, `endsAt`, location place|virtualPlace), `GET /v2/courses`. No agenda endpoint: the agenda is built from these.
- Exam "calls" are entries of `GET /exams`; there is no separate model.
- **MFA:** Polito says that if a student has registered any MFA factor (the owner uses a passkey), MFA is required to access the student app. The spec has `/auth/mfa/{enrol,validate,challenge,status}` (enrol with a public key, sign challenges). Whether an unattended server can authenticate is the main technical risk. Do not assume password-only login works. Design the auth layer so the Polito API source can be disabled and the ICS source alone is useful.
- Maintainers point to per-course ICS feeds as the supported way to get schedules; this needs no password and no MFA. **ICS-first is the default design.**
- Moodle: `https://moodle.polito.it` is a standard Moodle behind Polito SSO. Whether calendar export (`/calendar/export.php` iCal URL with per-user auth token) or mobile web services (`tool_mobile`) are enabled is UNVERIFIED. The calendar export URL is the preferred, credential-free-at-runtime path.

## Milestones (see docs/PLAN.md for done-when)
M0 repo basics, lint, CI, Dockerfile skeleton · M1 canonical model, sync engine, Google upsert (tested with fake Google) · M2 ICS source end to end (real calendar written) · M3 `probe/` scripts then Polito API source if feasible · M4 Moodle source · M5 setup wizard, `doctor`, friendly errors · M6 README, SETUP.md, ERRORS.md, publish.
The human runs anything needing their real credentials; give them exact commands and explain what each will do. Never ask them to paste a password or token into chat.

## Commands
`pnpm install` · `pnpm check` (typecheck + lint + test + secret scan) · `pnpm dev` · `pnpm sync --dry-run` · `pnpm doctor` · `docker compose up -d`

## Git
Small commits with clear messages. Branch `main` stays runnable. Do not force-push. Open a PR only when asked.
