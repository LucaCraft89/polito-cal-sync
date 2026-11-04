# 016 Polito API auth finding

**Status: PARTIAL. First real probe run by the owner, 2026-11-04** (`01-recon.json`, `02-login.json`, `03-samples-summary.json`). Login was never evaluated, so the MFA and token questions are still open.

**Findings (observed):**

- Server `Apache/2.4.6 (CentOS)`; `GET /api` answers 301 (HTML); `/health` and `/version` do not exist (404); `/lectures` without a token answers **401** with JSON `{error: string, code: integer}` and **no `WWW-Authenticate` header**. CORS allows the request headers `Content-Type, X-Username, Authorization, X-Test-Mode`. Errors have the form `{error, code}`.
- `POST /auth/login` with our guessed body (`type`, `username`, `password`, `preferences`) answers **HTTP 500** `{"error":"Missing required params (device_platform,device_version,device_model)","code":-6}`: a request-shape problem reported as a 500, before credentials are looked at. So the guessed body is wrong; where the three device fields go is unknown (probe 02 now tries body, `preferences`, query with fake credentials).

**Second run (fixed probe):** the three JSON-based placements of the device fields (top level, inside `preferences`, query string, with fake credentials) all got the same 500 `Missing required params`; the safeguard held and the real password was not sent. Hypothesis (unverified): this is a legacy server (Apache/CentOS, snake_case, `{error, code}`) that reads only form fields, so it never sees a JSON body. Probe 02 now also tries two form-encoded bodies (`form-flat`, `form-flat-with-type`).

**Probe bug found and fixed:** the shape check treated that 500 as "unclear" and still sent the owner's real password with the rejected body (harmless here, the server rejected the request before checking credentials, but against the promise). Now the real password is sent only with a shape that got 401/403 from fake credentials.

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
