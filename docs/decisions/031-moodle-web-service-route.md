# 031 Moodle: a daily-updating route exists on paper; probe 06 tests it

**Context.** The owner reports that the Moodle export link behaves like a one-time export and misses events that exist. Decision 022 left Moodle at "export URL = ICS feed" and said Moodle could not be reached from the build sandbox.

**Observed (2026-11-05, unauthenticated, read-only, 3 requests plus 1 more to the same public call, no credentials sent).** Correction to 022: **moodle.polito.it is reachable from the sandbox**.

- `/login/index.php` redirects to `/auth/shibboleth/`: login is the university SSO, the only identity provider listed is "Login Unificato".
- `/login/token.php?service=moodle_mobile_app` answers a JSON `missingparam (username)`: the web-service endpoint is alive.
- The public `tool_mobile_get_public_config` says `enablewebservices = 1`, `enablemobilewebservice = 1`, `typeoflogin = 3` (the app logs in through an embedded browser/SSO), `launchurl = /admin/tool/mobile/launch.php`, the login form is shown, QR type 2.

**What that means (reasoned from Moodle, UNVERIFIED on this site).**

- A password-based `/login/token.php` will not work for SSO accounts; the app's route is `launch.php` -> SSO -> a redirect `moodlemobile://token=base64(siteid:::token[:::privatetoken])`. Our portal login client already does the IdP part (decision 018), so a headless token fetch is plausible, as is the same "new device, no MFA" behaviour, but neither is verified for Moodle.
- With a token the web service gives what the export lacks: `core_calendar_get_action_events_by_timesort` (deadlines and other action events with module and type), `core_enrol_get_users_courses`, `mod_assign_get_assignments` (due dates), and `core_calendar_get_calendar_export_token`. Whether the mobile service allows each function on this site, the answer shapes, and the token's lifetime are **not known**.
- The export link itself should be a live feed; a "one-time export" look is typical of the **Custom range** time period (fixed dates), and missing events of a narrow "Events to export" choice. Worth checking before building anything: use "Recent and next 60 days" and "All".

**Decided**

- No source code yet (nothing to build on without real shapes: AGENTS.md "no guessing"). Added `probe/06-moodle-token.mjs`, owner-run, same safety rules as probe 05: hidden prompt, password sent once and only to a form on `idp.polito.it`, at most 40 requests 1.5 s apart, only `moodle.polito.it` and `idp.polito.it`, stops on 429 or any extra step, token in memory only, output = shapes, counts, function names, event types and module names.
- After the owner's run: if it works, build a `moodle` source on the web service (token fetched by the same SSO client, stored like the Polito login, fail-closed like decision 019) and keep the export feed as the credential-free fallback. If SSO token launch is refused, fall back to a manual token from Moodle's Preferences > Security keys, or to fixing the export settings.
- Live Moodle tests with the owner's credentials were **not** run from here: the rules for the authorised credentials cover only `didattica.polito.it` and `idp.polito.it`.
