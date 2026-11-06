# 017 Route B: portal SSO login, probe first

**Context.** The app API login could not be called correctly after 11 fake attempts (016). The owner's HAR (web portal) shows a SAML login at `idp.polito.it` that accepted a password alone, then a cookie session with a one-call JSON (`getStudentData`: schedule, exam calls, agenda...). The owner agreed to switch to the IdP route and offered their credentials for testing.

**Decided**

- **Credentials stay on the owner's machine**, as before (the brief says so; the password already sat in a HAR once and is to be changed). The build session does not take or use them; `probe/05-idp-login.mjs` is owner-run.
- **Probe first, no source yet.** Nothing in `src/` changes until the probe shows (a) whether a headless login reaches the portal without an MFA step, (b) cookie/session lifetimes, (c) the real shape of `getStudentData`. The existing Polito API source stays as is (disabled); if route B works it becomes a second adapter behind the same `Source`/fail-closed rules, probably replacing the app API one.
- **Probe rules:** allow-listed hosts only (a redirect elsewhere stops it), password POSTed once and only to a form on an allowed host, 30 requests max, 1.5 s apart, 429 stops, any unknown form at the IdP stops it unanswered (that is the MFA evidence), no cookie values or password recorded, data sanitized in memory.
- **Known risks of route B:** scraping-style fragility (CSRF token, SAML forwarding, cookie jar, answers in a legacy format), a server may look like a new device and trigger MFA, an unattended session needs the password stored in `DATA_DIR` (0600), and it is not an advertised interface. The README must say so if it ships.
- **Not covered:** `getOrariLezioneStudente` (its request body was not kept), passkey login.

## First owner run (2026-11-04)

Chain: portal `/login` (301) -> `/secure/login` (302) -> IdP SSO redirect (302) -> IdP login form (200) -> **password POST answered 302 back to the IdP, and the login form was shown again**. In the owner's browser HAR the same POST answered 200 with the `SAMLResponse` form. Nothing was asked beyond the login form, no MFA page appeared, and cookies were all session cookies (no lifetimes stated).

Most likely cause (a probe bug, not a rejection): the form's `_eventId_proceed` is a hidden field that the page script sets to a one-character value (HAR: length 1) and the probe sent it empty; `donotcache` is a checkbox that an unchecked browser does not send. **Fixed**: `_eventId_proceed` is sent as `1` when empty, checkboxes are left out, and the probe now records the redirect target (host, path, query names) and error-ish keywords of a redisplayed form so a rejection can be told from a missing field. Unverified until the next run. One more password POST will happen on that run.

## Second owner run (2026-11-04, after the `_eventId_proceed=1` fix)

Same result: the password POST answered 302 back to the IdP execution URL and the login form was shown again; the page contains the words "errat" and "invalid" (could be a real rejection message or ordinary markup such as an `is-invalid` CSS class: **not distinguishable from the recorded data**). No MFA or other extra step, no extra form. So the proceed-field theory is not confirmed. Other open causes: the credentials were not accepted as typed (typo, paste, wrong username format), the account has a rule the page explains, or a required field/cookie is still missing from our POST.

**Stopped on purpose:** two refused attempts are enough; no third password POST until the IdP's own message is readable. Probe 05 now (a) shows only the **lengths** of the username and password and asks for confirmation before sending, to catch typing/paste problems, and (b) records the visible text of the redisplayed page (title and alert-like elements, scrubbed of what was typed). Next step is the owner's: check by hand in a browser that the same credentials log in, then rerun.
