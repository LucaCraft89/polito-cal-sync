# Web UI: specification

One local web page for everything that is today a line in `.env`, a command, or a decision file: connect Google, add sources, set the Polito login, exam calls and squads, preview what a sync would do, run it, and see what happened. It replaces hand-editing `.env` for settings, and it is the setup wizard of M5.

Status: **steps 1 to 4 of section 8 are built** (decisions 023 to 030): settings store, secured JSON API, auth; design tokens, components, app shell; first-run passphrase, login, Overview, Sources (with Test buttons), Settings (with Google connect and the calendar picker), Preview, **Sync now** (all guards of section 4), Courses, History (with the paused-login state). Tested against fakes only: **nothing was run against real Google, and Sync now never wrote to a real calendar.** `doctor` and an ordered setup checklist with a "next step" (the first-run wizard, decision 032) are built. The Sources page also has the live Moodle switch with a Test button (decision 036). The page updates itself through server-sent events and a **Service** page controls the scheduled sync (decisions 037, 038). Moodle courses can be left out and Moodle events kept in a second calendar (decision 040). **Not built yet:** per-course calendars (013), screenshots. Decision records: `021`, `023` to `030`.

## 1. What it covers

| Area               | What the user can do                                                                                                                                                                           | Replaces                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| First run          | Set the UI passphrase, then a guided wizard: Google, calendar, sources, preview, schedule                                                                                                      | the M2/M3 runbooks                                  |
| Google             | Enter the OAuth client, connect (loopback flow), pick or create the dedicated calendar, see which account and calendar are in use                                                              | `GOOGLE_*`, `auth google`                           |
| Sources            | ICS feed list with a **Test** button per feed; Moodle host label; Polito portal switch, username, password, **booked-only / all** exam calls                                                   | `SOURCE_*`, `POLITO_*`, `MOODLE_BASE_URL`           |
| Squads and courses | A list of the courses and squads seen in the last preview; pick your squad per course; name courses; (later) one Google calendar per course (decision 013)                                     | `POLITO_SQUADS`, `course-names.json`                |
| Preview            | The dry-run plan: counts, filter by source and kind, per event the course, place and note, the safety line (deletions vs limit), what is incomplete and why                                    | `sync --dry-run --details`                          |
| Run                | **Preview now**, **Sync now** (needs a fresh preview and a confirmation), interval and deletion limit; `--force` only through a typed confirmation                                             | `sync`, `SYNC_INTERVAL_MINUTES`, `DELETE_THRESHOLD` |
| Status             | Health (heartbeat), last runs with counts, errors as **what happened / why / what to do** with the docs link, the paused-login state (decision 018) and a way to say "I fixed the credentials" | `serve` logs, `/status`, `doctor`                   |
| Settings overview  | Every setting with its source: set in the UI, or **overridden by an environment variable** (shown read-only)                                                                                   | reading `.env`                                      |

Out of scope: several users, exposing it on the internet, a native app, push notifications, editing events by hand, anything that writes outside the dedicated calendar.

## 2. Design: Material 3 Expressive, honestly

Target: the **Material 3 Expressive** look (Google, 2025): bold but readable colour from a seed with tonal roles, a wider and more playful shape language, spring-like motion, emphasised type, and the expressive components (button groups, a clear primary action, loading and progress indicators with character).

Facts that shape the work (verify at the start of M5; they may have changed):

- There is, as far as known, **no official web implementation of Expressive**; Google's `@material/web` is in maintenance mode. So the plan is **our own CSS design tokens and a small set of components**, not a component library. We do not claim pixel fidelity; we follow the guidance.
- No CDN: fonts are self-hosted (a variable sans such as Roboto Flex, open licence) so the page works offline and leaks nothing to third parties.

Rules:

1. **Tokens first** (`:root` custom properties): colour roles (`primary`, `on-primary`, `primary-container`, `secondary-*`, `tertiary-*`, `surface`, `surface-container-*`, `outline`, `error-*`), generated once from a seed colour by the Material Color Utilities algorithm and written down as CSS (light and dark; **follows `prefers-color-scheme`, with a manual override**). Shape scale (including a few large rounded and asymmetric expressive shapes), elevation/tonal surface levels, type scale **with emphasised variants**, motion tokens.
2. **Motion:** spring-like easing (CSS `linear()` curves or Web Animations), short durations for state changes, a little overshoot on selection and confirmation. **`prefers-reduced-motion` turns it into plain fades or nothing**; no information is carried by motion alone.
3. **Components we build** (vanilla, accessible): top app bar, navigation bar / rail / drawer, filled/tonal/outlined/text buttons and a button group, FAB (one per page, for the main action), text fields with supporting text and error state, switch, segmented control, chips (filter, status), cards, list items, dialogs, snackbar, progress/loading indicator, banner for incomplete or paused states.
4. **Colour carries meaning, never alone:** statuses (ok, incomplete, paused, refused) have an icon and a word as well as a colour. Event kinds get a colour **and** a label (open decision 2 in the plan).
5. Plain words. One clear primary action per screen. Every failure uses the three-line error form (what, why, what to do) plus the `docs/ERRORS.md` link. No jargon (say "squad", not "enumeration").

## 3. Mobile first and responsive

The owner will use it on a phone as often as on a laptop.

- **Window size classes** (Material): compact `< 600 px`, medium `600 to 839 px`, expanded `>= 840 px`. Navigation is a **bottom navigation bar** on compact, a **rail** on medium, a **drawer or rail** on expanded. One column of cards on compact, two on medium, a list and detail pane on expanded where it helps (Preview).
- `meta viewport`, safe-area insets (`env(safe-area-inset-*)`), `dvh` units so the on-screen keyboard and browser bars do not cover the focused field or the main button; the primary action stays reachable (sticky bottom bar on compact).
- **No horizontal scroll at 320 px.** Tables become lists of cards on compact; long place and note texts wrap or clamp with a "more" control.
- **Touch targets at least 48 px**, spacing at least 8 px between neighbours, no hover-only information, no drag-only actions.
- Forms use the right input types and `autocomplete` values (`autocomplete="off"` for the Polito password so a browser does not save it for the wrong site; `new-password` for the UI passphrase), `inputmode`, and clear labels (never placeholder-only).
- Works at 200% zoom and with large system fonts; relative units.
- **Accessibility target: WCAG 2.2 AA**: contrast (also for the generated palette, tested), visible focus, full keyboard operation, landmarks and headings, labelled controls, live regions for results (`aria-live`), error text linked to its field.
- **Performance:** a small static bundle with no framework runtime required for reading pages; first meaningful paint under one second on a mid phone over the home network. Progressive enhancement: pages are server-rendered HTML; scripts add Test buttons, live updates and animations.

## 4. Security

The UI can change what is written to a calendar and holds a university password. Treat it as an admin console even though it is local.

**Exposure**

- Binds to `127.0.0.1` by default; in Docker it is published on the host's `127.0.0.1` only (decision 012). Remote use is the owner's own VPN or reverse proxy with TLS; we do not build remote access. If a non-loopback bind is configured, the UI refuses to start without HTTPS in front (`X-Forwarded-Proto: https` trusted only from a configured proxy) and says why.
- **Host header allow-list** (DNS rebinding), rejecting anything else with 421 (as the status page already does).

**Access control**

- First run sets a **passphrase** (at least 12 characters, strength hint, no composition rules). Stored as a **scrypt** hash (Node's built-in `crypto`, no dependency) with a per-install salt, in `DATA_DIR` (0600). Until it is set, only the first-run page is served and only from loopback.
- Session cookie: random 256-bit id, `HttpOnly`, `SameSite=Strict`, `Secure` when served over HTTPS, server-side session store (in memory or sqlite), idle timeout 30 minutes, absolute 12 hours, logout button, all sessions dropped on passphrase change.
- **Login throttling:** per source address and global, exponential back-off and a temporary lockout; failures are logged without the attempted value.
- No "remember me", no password reset by email. Recovery is a CLI command on the machine (`reset-ui-passphrase`) that needs filesystem access to `DATA_DIR`.

**Request safety**

- Every state-changing request is `POST/PUT/DELETE` with a **CSRF token** (per session) **and** an `Origin`/`Sec-Fetch-Site` check; GET never changes anything.
- Strict headers: `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`, plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `Permissions-Policy` empty, `Cache-Control: no-store` on every authenticated page and API answer. **No inline scripts or styles, no `eval`, no third-party requests.**
- **Untrusted text** (event titles, places, notes, error details from the portal or a feed) is rendered with `textContent` or escaped templates, never as HTML.
- Every input is validated on the server with the same `zod` schemas as the configuration; request bodies are size-limited; JSON only; CORS is not enabled.
- A **sync is rate-limited** in the UI as in `serve` (not more often than the configured minimum, 15 minutes), so the page cannot be used to hammer Polito or Google. Preview and Sync are single-flight (the run lock of decision 012).

**Secrets**

- **Write-only fields:** the Polito password, the Google client secret and the passphrase are never sent back to the browser. The page shows "set" and offers **Replace** and **Clear**. They never appear in a URL, a log line, an error, a history row or an HTML attribute (a test checks every response and the logs for the configured secret values).
- Stored in `DATA_DIR/settings.json` (and the existing token files), mode 0600, written atomically. **Environment variables win** over the file and are shown as read-only "set by environment". Honest limit: they are not encrypted at rest (a key stored next to them would add nothing); disk encryption and file permissions are the protection. The README says so.
- The Polito credentials are only ever sent to the allow-listed university hosts (decision 019); the UI's "Test login" uses the same client and the same lockout latch, so it **cannot** repeat a refused login.

**Dangerous actions**

- Default is preview. **Sync now** shows what will change and needs one tap to confirm. Anything that deletes more than the limit needs `--force` semantics through a **typed confirmation**. Deleting calendars is never offered (decision 013).
- Changes to settings are written to an **audit log** (what changed, when; never values of secrets).

## 5. Pages and flow

First run (wizard, resumable): 1 passphrase, 2 Google client, 3 connect and calendar, 4 sources (each with **Test**), 5 preview, 6 schedule and finish. Afterwards the app has five destinations: **Overview** (health, last run, next run, the main action), **Preview**, **Sources**, **Courses** (squads, names, later per-course calendars), **History and logs**. Settings overview is under Sources; passphrase and theme under a profile menu.

The squad picker is fed by the last preview (it knows the course ids and squads seen), so a student chooses "Chimica: squad A" from a list instead of writing `309885=A`.

## 6. Architecture

- Server: the existing `node:http` status server is extended (decision 012) **or** `fastify` as AGENTS.md lists it; decided at the start of M5 and recorded. Pages are rendered on the server from templates; a small JSON API under `/api/` serves the interactive parts. All logic stays in the existing modules (config, sources, engine); the UI is a thin layer that calls `runConfiguredSync`, the Google helpers and the settings store.
- **Settings store** (`DATA_DIR/settings.json`, schema versioned, `zod`) layered **under** environment variables; `loadConfig` reads both. This store, the API and the security layer (sections 4) are one deliverable and come before any page.
- Static assets (CSS, scripts, fonts) are served from the package with content hashes; no build step beyond TypeScript, and no bundler unless it earns its place.
- Tests use the same fakes as the sync tests (fake Google, fake portal), never real accounts.

## 7. Acceptance (what "done" means for M5)

1. **A new user** goes from `docker compose up -d` to a first preview, **using only the UI**, on a phone and on a laptop.
2. **Responsive:** automated browser tests (Playwright, in CI) at 360x800, 390x844, 768x1024 and 1280x800 check: no horizontal scroll, every control reachable and at least 48 px on compact, the primary action visible with the keyboard open, navigation changes by size class. Screenshots of the wizard for the README (M6).
3. **Accessibility:** an automated axe scan with no serious or critical findings on every page; keyboard-only walkthrough of the wizard; contrast tests of the generated palette (light and dark); reduced-motion test.
4. **Security tests:** CSRF missing/invalid is refused; wrong `Origin` and wrong `Host` are refused; every response carries the headers in section 4; no response, log line, history row or error contains any configured secret value; sessions expire; login throttling kicks in; a stored XSS string as an event title renders as text; the settings file is mode 0600; env overrides are read-only.
5. **No regression:** `pnpm check` green; the CLI keeps working with the same settings (the UI and `.env` can be mixed).
6. Every UI error uses the three-line form with a working `docs/ERRORS.md` link, tested for all codes the UI can show.

## 8. Order of work inside M5

1. Settings store + API + auth/session/CSRF/headers + security tests (no pages yet).
2. Design tokens, the component set, the app shell with navigation by size class, accessibility and responsive tests.
3. Wizard pages (Google, sources with Test), then Preview and Run, then Status and History.
4. Courses page (squads, names; per-course calendars if decision 013 is built by then).
5. Screenshots and the README section (M6).

A recommendation for the owner (open decision 4 in the plan): build step 1 **at the start of M4** so that Moodle, squads and course names do not pile up as more `.env` lines first.
