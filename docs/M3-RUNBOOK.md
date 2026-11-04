# M3 runbook: settle the Polito login question

M3 is built as far as it can be without your data. What is **missing** is evidence only your machine can produce. This page says what to run, in which order, what to expect, and what to send back. Nothing here asks you to paste a password, token or MFA code anywhere except into the hidden prompt of a script on your own machine.

**The Polito API source is disabled by default** (`SOURCE_POLITO_API_ENABLED=false`) and stays harmless: your ICS feeds keep working with or without it. If you switch it on today it only says `E_POLITO_API_NOT_READY` and changes nothing.

## What you will do (about 20 minutes, ~15 requests in total)

Read `probe/README.md` once (rules, what each script sends). Then, from the repo folder (`pnpm install` done):

1. **Optional, recommended first:** email Polito ICT / the app maintainers (contact in the `students-app` repo's `publiccode.yml`) saying you want to read your own schedule with a personal self-hosted tool. Open decision 1 in `docs/PLAN.md`. Do this **before** `--enrol`.

2. Recon, no password:

   ```bash
   node probe/01-recon.mjs
   ```

3. Login probe, asks for username and password in a hidden prompt:

   ```bash
   node probe/02-login.mjs
   ```

   Read the "Verdict" it prints.
   - **"accepted"**: password-only login gives a working token for this account. Go on to step 4.
   - **"NOT enough"**: MFA (or something else) blocks. **Stop and send back `02-login.json` first.** Whether to try `--enrol` is a decision about your account: read the warning in `probe/README.md`, then decide. The Polito API source can stay switched off forever; the ICS source is the supported path (RESEARCH.md).
   - **shape check failed** (400/415/422): nothing real was sent. Send back `02-login.json`; the login body will be fixed.

4. Samples (only if step 3 said the token works, or after a successful `--enrol`):

   ```bash
   node probe/03-samples.mjs --shift-days 30
   node probe/04-check.mjs
   ```

5. Review the checklist at the end of `probe/README.md`, then send back **only**: `probe/out/01-recon.json`, `probe/out/02-login.json`, `probe/out/03-samples-summary.json` and `probe/out/sanitized/*.json`.

## Route B: web-portal SSO (decided with the owner after the app API login stalled)

The app API login (`POST /auth/login`) could not be called correctly (decision 016). The owner's HAR showed the web portal logs in with a plain SAML flow and a password, so `probe/05-idp-login.mjs` tests that route (decision 017). Run it on your machine:

```bash
git pull
node probe/05-idp-login.mjs --shift-days 30
```

Send back `probe/out/05-idp-login.json` and, after the checklist, `probe/out/sanitized/idp-student-data.json`. Change the Polito password first if you have not (it was in a HAR file).

## Needs owner data (nothing below can be finished without it)

| #   | Open item                                                                                                   | Settled by                                                  | Where the answer goes                                                         |
| --- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | Does `POST /auth/login` (basic) work with the guessed body (`type`, `username`, `password`, `preferences`)? | `02-login.json` shape check + login status                  | decision 016; `probe/lib/session.mjs` template                                |
| 2   | Is MFA demanded for this account; which path (`/auth/mfa/*`)?                                               | `02-login.json` dataCall + mfaStatus                        | decision 016                                                                  |
| 3   | Can an unattended server complete MFA (enrolled device key)?                                                | only `--enrol`, owner's choice                              | decision 016                                                                  |
| 4   | Token lifetime; is re-login needed; header scheme (`Bearer`?)                                               | `02-login.json` (`token.lifetimeSeconds`, data call status) | decision 016; `src/sources/polito/client.ts`                                  |
| 5   | How lists are wrapped (bare array or `{data: []}`)                                                          | `03-samples-summary.json` bodyShape                         | `listItems` in `schemas.ts`                                                   |
| 6   | Real field names for every GUESS in the table                                                               | `sanitized/*.json`                                          | `src/sources/polito/fields.ts` (one file), then replace the invented fixtures |
| 7   | Lecture fields (all UNVERIFIED), `places` / `location` shape, exam `status` enum values                     | `sanitized/lectures.json`, `exams.json`                     | `fields.ts`, `EXAM_BOOKED_STATUSES`                                           |
| 8   | Is there a join between Moodle course codes and Polito course ids?                                          | compare `sanitized/courses.json` with ICS `CATEGORIES`      | decision 013 (aliases)                                                        |
| 9   | A real login implementation (`PolitoAuth`), credentials storage in `DATA_DIR`                               | follows from 1 to 4                                         | new `src/sources/polito/auth.ts` + tests, then a live run                     |
| 10  | A live `sync --dry-run` with the Polito source                                                              | follows from 9                                              | recorded in the M3 closing commit                                             |

If item 2 or 3 turns out negative, the Polito API source is closed as "not feasible unattended", the skeleton stays disabled, and M3 is done on the evidence alone (PLAN: "live run only if auth works unattended").

## What the assistant will do with your files

1. Write the finding into `docs/decisions/016-polito-auth-finding.md`.
2. Correct `fields.ts` (and `schemas.ts` wrapping) from the sanitized samples, replace the invented fixtures with the real sanitized ones in `test/fixtures/polito/real/`, and rerun the mapper tests.
3. If login works unattended: implement `PolitoAuth`, credentials in `DATA_DIR` (0600), and do a `sync --dry-run` on your machine with you.

## If something goes wrong

- A script says `STOPPED` with 429: wait an hour or more before trying again; do not loop.
- Login answered 401: do not retry quickly (accounts can lock). Check the username (matricola) and password in the Polito web portal first.
- You typed the password wrong: the script does not retry; just run it again later.
- You think a file leaked something: delete `probe/out/` (it is git-ignored and local) and tell the assistant the field name, not the value.
