# M3 runbook: use the Polito portal source on your machine

M3's question was whether an unattended server can read the Polito schedule. The owner's probe run says yes for the **web portal** (decision 018): the university single sign-on accepted the password with no extra step, and one JSON document holds lectures, exam calls and more. The source is built (decision 019) and unit-tested on **invented** data. **Not yet run against the real portal inside the sync.** These steps do that on your machine. Nothing here asks you to paste a password anywhere except your own `.env`.

## Before you start

- Change your Polito password if you have not since the HAR file with it was shared.
- Know the risks (README, "Polito portal source"): your real password lives in `.env`; this is not an official API; a login from a server can get an MFA step later; a refused login pauses the source until you change the password.
- Optional but recommended (PLAN, open decision 1): tell Polito ICT you use a personal tool that reads your own schedule.

## Steps

1. `git pull`, then `pnpm install`.
2. Put these in `.env` (no quotes):

   ```
   SOURCE_POLITO_PORTAL_ENABLED=true
   POLITO_USERNAME=<your university username>
   POLITO_PASSWORD=<your password>
   ```

   Keep your ICS URL in `SOURCE_POLITO_ICS_URLS` as before. `.env` is git-ignored; the secret scan fails if it is ever staged.

3. **Dry run first** (writes nothing to Google; it logs in once, 13 requests, ~25 s):

   ```bash
   pnpm sync --dry-run
   ```

   Expect a `polito  complete  N events` line next to `ics`. If it says INCOMPLETE, the error block under it names the code (see `docs/ERRORS.md`): `E_POLITO_API_AUTH_REJECTED` (wrong password; the source then pauses until you change it), `E_POLITO_LOGIN_EXTRA_STEP` (MFA now asked: tell the assistant), `E_POLITO_API_UNEXPECTED_DATA` (the shape differs: tell the assistant the section and field names it prints, never values).

4. **Check by eye** that a few lectures and exam calls in the plan match what the portal shows (times especially: zone-less exam times are read as Europe/Rome; if exams come out one or two hours off, tell the assistant, that is the open assumption).
5. When satisfied, `pnpm sync` for real (this is the first time portal events reach your Google calendar), then `pnpm sync` again: the second run must change nothing.

## What to send back

Only: the `polito ...` lines of the dry run, any error code block, and whether the times matched. No raw portal data, no `.env`.

## Status after the first live dry run

Works: login without MFA, 70 events read with no issues, plan of 86 creates and 0 deletes (decision 019). Left: compare a few times with the portal by eye, then a real `pnpm sync` and a second one that must change nothing.

## Still open

- Reusing the 90-day identity-provider session between runs (fewer password logins; adds a long-lived file in `DATA_DIR`). Decision 018.
- Raw date formats were never seen unaltered (probe sanitizer bug, fixed). Re-running `node probe/05-idp-login.mjs` would show them, at the cost of another login.
- One account only. The `probe/` scripts for the app API (steps 1 to 3) are kept for the record; the app API login was never made to work (decision 016).
