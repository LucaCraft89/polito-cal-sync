# 016 Polito API auth finding

**Status: PENDING. No evidence exists yet.** The build session cannot log in (no credentials, and recon needing them runs only on the owner's machine). Everything below is a question, not an answer. The owner runs the probe (`docs/M3-RUNBOOK.md`) and this file is then rewritten with "Finding: ..." lines.

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
