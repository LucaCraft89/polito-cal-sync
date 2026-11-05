# 021 Web UI: scope and requirements

**Context.** After M3 the settings the owner needs to change are `SOURCE_*`, `POLITO_*` (login, exam calls, squads), `MOODLE_BASE_URL` and soon course names and per-course calendars: too many hand-edited lines, some of them (squads) only discoverable from a dry-run printout. The owner asked for a web UI for all configuration, mobile responsive, secure, in Material 3 Expressive.

**Decided**

- The plan already had a "wizard (local web UI)" in M5; it is **widened to the full configuration and operation UI** specified in `docs/UI.md`, and `docs/PLAN.md` M5, a requirements summary and open decisions 4 and 5 are updated.
- **Requirements** (all testable, see UI.md section 7): mobile first with Material window size classes; WCAG 2.2 AA; local-only exposure, passphrase (scrypt) and sessions, CSRF plus Origin plus Host checks, strict CSP with no inline script and no third-party request, write-only secret fields, 0600 settings file, rate-limited and single-flight sync, preview by default.
- **Design: Material 3 Expressive implemented as our own tokens and components.** As far as known there is no official web implementation (`@material/web` is in maintenance mode); to be verified when M5 starts.
- **Settings model:** `DATA_DIR/settings.json` under environment variables (env wins, shown read-only). Secrets are protected by file mode, not encrypted at rest (a key beside them adds nothing); the README must say so.
- **Order inside M5:** settings store, API and security first, then design system, then pages. Recommended to pull the first step forward to the start of M4 (open decision 4).
- **Not decided:** the HTTP server choice (extend `node:http` or `fastify`), the seed colour, whether an installable PWA is wanted (not planned: local-only).
- **Nothing is built yet.** No code changed.
