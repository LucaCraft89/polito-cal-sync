# 017 Route B: portal SSO login, probe first

**Context.** The app API login could not be called correctly after 11 fake attempts (016). The owner's HAR (web portal) shows a SAML login at `idp.polito.it` that accepted a password alone, then a cookie session with a one-call JSON (`getStudentData`: schedule, exam calls, agenda...). The owner agreed to switch to the IdP route and offered their credentials for testing.

**Decided**

- **Credentials stay on the owner's machine**, as before (the brief says so; the password already sat in a HAR once and is to be changed). The build session does not take or use them; `probe/05-idp-login.mjs` is owner-run.
- **Probe first, no source yet.** Nothing in `src/` changes until the probe shows (a) whether a headless login reaches the portal without an MFA step, (b) cookie/session lifetimes, (c) the real shape of `getStudentData`. The existing Polito API source stays as is (disabled); if route B works it becomes a second adapter behind the same `Source`/fail-closed rules, probably replacing the app API one.
- **Probe rules:** allow-listed hosts only (a redirect elsewhere stops it), password POSTed once and only to a form on an allowed host, 30 requests max, 1.5 s apart, 429 stops, any unknown form at the IdP stops it unanswered (that is the MFA evidence), no cookie values or password recorded, data sanitized in memory.
- **Known risks of route B:** scraping-style fragility (CSRF token, SAML forwarding, cookie jar, answers in a legacy format), a server may look like a new device and trigger MFA, an unattended session needs the password stored in `DATA_DIR` (0600), and it is not an advertised interface. The README must say so if it ships.
- **Not covered:** `getOrariLezioneStudente` (its request body was not kept), passkey login.
