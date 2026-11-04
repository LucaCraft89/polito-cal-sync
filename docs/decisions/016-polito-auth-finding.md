# 016 Polito API auth finding

> **Superseded by decisions 017 and 018:** the app API login was never made to work; the portal SSO route works. This file stays as the record of what was tried.

**Status: PARTIAL. First real probe run by the owner, 2026-11-04** (`01-recon.json`, `02-login.json`, `03-samples-summary.json`). Login was never evaluated, so the MFA and token questions are still open.

**Findings (observed):**

- Server `Apache/2.4.6 (CentOS)`; `GET /api` answers 301 (HTML); `/health` and `/version` do not exist (404); `/lectures` without a token answers **401** with JSON `{error: string, code: integer}` and **no `WWW-Authenticate` header**. CORS allows the request headers `Content-Type, X-Username, Authorization, X-Test-Mode`. Errors have the form `{error, code}`.
- `POST /auth/login` with our guessed body (`type`, `username`, `password`, `preferences`) answers **HTTP 500** `{"error":"Missing required params (device_platform,device_version,device_model)","code":-6}`: a request-shape problem reported as a 500, before credentials are looked at. So the guessed body is wrong; where the three device fields go is unknown (probe 02 now tries body, `preferences`, query with fake credentials).

**Second and third runs (fixed probe, fake credentials only; the real password was never sent):** device fields at the top level of a JSON body, inside `preferences`, or in the query string: all `500 {"error":"Missing required params (device_platform,device_version,device_model)","code":-6}`. The same fields form-encoded: `400 {"error":"Cannot decode input JSON - Syntax error","code":-33}`. So the body is parsed as JSON, and the device fields are expected somewhere none of those placements reaches (another nesting or request headers; unknown). Eleven fake logins have been sent in total; further blind guessing stops here. Next step needs the real request structure from the spec (field names only), see M3-RUNBOOK.

**Probe bug found and fixed:** the shape check treated that 500 as "unclear" and still sent the owner's real password with the rejected body (harmless here, the server rejected the request before checking credentials, but against the promise). Now the real password is sent only with a shape that got 401/403 from fake credentials.

**Web-portal HAR (owner's own browser session, 2026-11-04; read for structure only, values never copied).** This is the **web portal** (`didattica.polito.it`, SAML single sign-on), not the `app.didattica.polito.it/api` login the probe is stuck on: no request to the app API is in it.

- Login is **SAML via `idp.polito.it`** (Shibboleth): GET the SSO redirect, the form page offers a password form (`j_username`, `j_password`, `csrf_token`, `_eventId_proceed`) **or** a passkey button (`_eventId_fudispasskeys`, `fudis_web_authn_assertion_input`); POST the password form; the answer is an auto-submitting page with `SAMLResponse` + `RelayState`, which is POSTed to `/Shibboleth.sso/SAML2/POST` and then 302 chains lead to a logged-in portal.
- **In this session the password POST was enough: no MFA step appeared between the password POST and the SAML response** (for a browser that may have been a trusted device; cookies were stripped from the HAR, so this cannot be told). The IdP was passed twice (once for `www.polito.it`, once for `didattica.polito.it`), each with its own password POST.
- After login the portal is cookie-session based with legacy endpoints: `GET /pls/portal30/sviluppo.studente.getStudentData` (JSON, one call with sections such as `orari`, `appelli`, `agenda`, `carico`, `career`, ...) and `POST .../sviluppo.studente.getOrariLezioneStudente` (`Content-Type: text/x-json`, body fields `from`, `to`; answer `{orari:{data:{stato, lezioni:[...]}}}`).
- Consequence: a **second possible route** exists (headless SAML login with the password, then the portal JSON). It is fragile (CSRF token, SAML forwarding, cookie jar, HTML-ish answers) and unattended MFA behaviour for a new "device" is unknown (RESEARCH: trusted device lasts 90 days). Not adopted; any use needs the owner's decision and a probe of its own.
- **The HAR held the owner's real username and password in clear text.** It was not stored in the repo; the owner should change the password and treat the file as a secret.

| Question (all UNVERIFIED)                                                   | Finding                                     |
| --------------------------------------------------------------------------- | ------------------------------------------- |
| Does `POST /auth/login` (basic) accept the body in `probe/lib/session.mjs`? | pending                                     |
| Which header carries the token (`Authorization: Bearer`?)                   | pending                                     |
| Is MFA demanded for the owner's account; via which `/auth/mfa/*` path?      | pending                                     |
| Token lifetime; refresh or full re-login?                                   | pending                                     |
| Can an unattended server complete MFA (enrolled device key)?                | pending (only by `--enrol`, owner's choice) |
| How does the app obtain `sso` `uid` / `key`?                                | not probed                                  |

**Decision rule, agreed in advance** so the outcome does not depend on how convenient it is:

1. Password login works and a data call succeeds -> implement `PolitoAuth` with credentials in `DATA_DIR` (0600), live `sync --dry-run` with the owner, keep the source opt-in.
2. MFA blocks and the owner does **not** want to enrol a device -> close the source as "not feasible unattended". The skeleton stays disabled. ICS (+ Moodle export in M4) remains the product.
3. MFA blocks, owner runs `--enrol`, and the challenge/validate cycle works -> same as 1, plus the device key in `DATA_DIR`, and a plain-language warning in the README that the server holds an MFA key for the account. If the cycle fails, the probe output says at which step; one more round at most.
4. Anything touching `sso` is out of scope until someone shows how `uid`/`key` are obtained.
