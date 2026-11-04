# probe/ - recon scripts you run on YOUR machine

These scripts answer the questions the project cannot guess (see `docs/RESEARCH.md`, "UNVERIFIED"): what the Polito student API demands at login, whether MFA blocks an unattended server, how long a token lives, and what the real answers look like. **You run them; the assistant never sees your password, token or raw data.**

Plain Node >= 22, no extra dependencies. Everything is written to `probe/out/` (git-ignored, files mode 0600).

## Ground rules the scripts follow

- **One request at a time**, 1.5 s apart, honest `User-Agent` (`polito-cal-sync/<version> (personal, self-hosted)`).
- Each script **prints exactly which requests it will send before sending anything** and asks you to confirm.
- **Stops at once on HTTP 429.** The authenticated scripts also stop on 401/403. A login is **never retried**.
- Your username and password are typed into a **hidden prompt**. Never an argument, never an environment variable, never written to disk, never printed. Without a terminal the scripts refuse to run.
- **Raw answers are never saved.** Step 2 records only status codes, key names, string lengths and the token lifetime. Step 3 redacts in memory and saves only the sanitized copy.

## The order

### 1. Unauthenticated recon (no password)

```bash
node probe/01-recon.mjs
```

Sends 4 GET requests with no credentials: the API root, `/health`, `/version` (guesses; a 404 is a fine answer) and `/lectures` (to see how the server says "log in"). Writes `probe/out/01-recon.json`. Safe to send back.

### 2. Login probe (asks for your password, locally)

```bash
node probe/02-login.mjs
```

Sends at most 7 requests (about 4 more with `--enrol`):

1. `POST /auth/login` with a **fake** username and password, up to 3 times with different request shapes. The first real answer showed the server needs `device_platform`, `device_version`, `device_model`, and it is unknown where they go (JSON body, inside `preferences`, or query string), so each place is tried in turn. The device values are your OS name, the Node version and `polito-cal-sync`. **Your real password is sent only with a shape the server answered with 401/403.** If none is accepted the script stops and your password is never sent.
2. `POST /auth/login` with **your** credentials, once.
3. `GET /deadlines` for today only: is the token you got enough to read data?
4. `GET /auth/mfa/status`: what does the server say about MFA for this token?

It prints a plain verdict ("a password-only token was accepted" or "was NOT enough"), and what an unattended server would need. Writes `probe/out/02-login.json`: status codes, headers like `www-authenticate`, key names, string lengths, the token's algorithm and lifetime if it is a JWT, short server error messages (scrubbed of anything you typed). **No values.** Safe to send back after you read it.

Options: `--body-template FILE` (a JSON login body with the strings `"$username"` and `"$password"`, if the default body is wrong), `--base-url URL`.

#### `--enrol`: only if step 2 says MFA blocks, and only if you decide so

```bash
node probe/02-login.mjs --enrol
```

**This changes your Polito account.** It registers a new MFA "device" (an ECDSA key made on your computer) so a server could pass MFA unattended. The script prints the full warning and asks you twice. In short: your account gets one more factor; if you had none, MFA becomes required in the student app too; the private key lands in `probe/out/mfa-device.json` and anyone with that file can pass MFA as you; we do not yet know where in the Polito portal you can remove the device; the request field names are UNVERIFIED so it may fail and need a second round (nothing is retried automatically). Consider emailing Polito ICT first (open decision 1 in `docs/PLAN.md`). **Never send `mfa-device.json` to anyone.**

### 3. Samples (asks for your password again)

```bash
node probe/03-samples.mjs --shift-days 30
```

Needs step 2 to have found an accepted login shape (it saves its name in `probe/out/login-variant.json`). Logs in once and reads each endpoint once (about 8 requests): lectures, exams, bookings, deadlines, courses (all small windows or lists) and the assignments of up to 2 courses (`--assignment-courses N`, max 3). Redacts in memory and writes `probe/out/sanitized/*.json` plus `probe/out/03-samples-summary.json` (shapes and counts).

What the redaction does: **default deny**. Names, titles, descriptions, teachers, rooms, emails, links and every unknown string become placeholders (`text-3`, `person-1`, `id-7`), the same real text always getting the same placeholder across files; ids are renumbered; coordinates become 0; dates are kept, or moved by `--shift-days N` (all by the same N); a string survives only if its key name says it is an enum (`status`, `type`, ...) and it looks like one. If any automatic check finds something (an email, a JWT, a long random string, a student number, anything you typed) the files go to `probe/out/needs-review/` instead and the script says so.

### 4. Review checklist (no requests)

```bash
node probe/04-check.mjs
```

Re-scans the sanitized files, lists the distinct values left so you can eyeball them, and prints the checklist below. It changes nothing.

## Before you send anything back (checklist)

- [ ] Open every file in `probe/out/sanitized/`. Do you recognise a real course name, teacher, room, email, matricola, link? If yes: do **not** send it; tell the assistant which field name (not the value) still leaks.
- [ ] No file contains a token, a password, or a long random-looking string.
- [ ] You are sending **only** `01-recon.json`, `02-login.json`, `03-samples-summary.json` and `sanitized/*.json`. Never anything else from `probe/out/`, never raw terminal output you did not read.
- [ ] `probe/out/mfa-device.json` (only exists after `--enrol`) is **not** among them.

## What to send back, and where

Paste the contents of the files above (they are small) into the chat, or copy the sanitized JSON into `test/fixtures/polito/real/` and commit it yourself after the checklist. See `docs/M3-RUNBOOK.md` for what the assistant does with them.

## Not covered

- Moodle recon (M4).
- `sso` login (`uid` + `key`): how the app gets them is UNVERIFIED and the probe does not try it.
