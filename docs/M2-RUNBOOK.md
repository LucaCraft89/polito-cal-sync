# M2 runbook: prove it on your own accounts

M2 is built and unit-tested with fakes. Its "Done when" needs **your** Polito feed and **your** Google account, so you run these steps yourself. Nothing here asks you to paste a password or token anywhere except into your own `.env` file, and nothing should ever go into a chat, an issue or a commit.

**What you will prove**

1. Your real feed shows up in a _separate_ Google calendar.
2. A second run changes nothing.
3. An event removed from the feed is deleted from the calendar.
4. (One-off) what Google really does with a deleted event id (`verify-google`).

Commands below use `pnpm` on your machine (Node >= 22). Route B at the end repeats the setup with Docker for the always-on service. Do Route A first.

---

## 1. Create the Google OAuth client (about 10 minutes, once)

Menu names change now and then; the idea stays the same.

1. Open https://console.cloud.google.com/ and create a project, e.g. `polito-cal-sync`.
2. **APIs & Services -> Library**: search "Google Calendar API" -> **Enable**.
3. **Google Auth Platform** (or "APIs & Services -> OAuth consent screen"): choose **External**, set an app name (`polito-cal-sync`), your email as support and developer contact. No logo, no domain needed. Add nobody else.
4. **Data access / Scopes**: you do not need to add scopes by hand; the program asks for "See, edit, share, and permanently delete all the calendars you can access using Google Calendar" at sign-in. It needs this to create the dedicated calendar. It only ever writes events carrying its own marker, in that one calendar.
5. **Clients -> Create client** (or "Credentials -> Create credentials -> OAuth client ID"): application type **Desktop app**, any name. Copy the **client ID** and **client secret**. Treat the secret like a password.

### The "Testing" vs "In production" trap (read this)

A new external app has publishing status **Testing**. **In Testing, Google expires the login (refresh token) after 7 days**, and the sync stops with `E_GOOGLE_AUTH_EXPIRED` every week.

Fix it **before** you sign in:

- **Audience** (or consent screen) -> **Publish app** -> confirm. Status becomes **In production**.
- You do not need Google's verification for a personal client that only you use. The only effect is that, when you sign in, Google shows "Google hasn't verified this app": click **Advanced -> Go to polito-cal-sync (unsafe)**. That is your own app.
- A login obtained while the app was still in Testing keeps its 7-day limit. If you signed in earlier, publish and then run `pnpm auth google` again.
- If you stay in Testing anyway: add your own Google address under **Test users**, and expect to run `pnpm auth google` every week.

## 2. Configure `.env`

```bash
cd polito-cal-sync
pnpm install
cp .env.example .env
```

Open `.env` in an editor and fill in only these (no quotes, no spaces around `=`):

```
GOOGLE_CLIENT_ID=<the client id from step 1>
GOOGLE_CLIENT_SECRET=<the client secret from step 1>
SOURCE_POLITO_ICS_URLS=<your calendar feed URL>
DATA_DIR=./data
```

- **Where the ICS URL goes:** `SOURCE_POLITO_ICS_URLS`. Several courses: separate the URLs with commas, no spaces needed (`https://a/x.ics,https://b/y.ics`). The URL can contain a secret token, so it lives only in `.env` (git-ignored). The program never prints or logs it; messages say `feed #1 (host)`.
- Keep `SYNC_INTERVAL_MINUTES=60` (the minimum allowed is 15).
- `.env` must never be committed; `pnpm check` scans for that.

## 3. Connect Google and create the calendar

```bash
pnpm auth google
```

What it does: prints a Google address and waits (up to 5 minutes) on `127.0.0.1`. Open the address in your browser, sign in, tick the calendar permission, press Continue. The page then says "Done", and the terminal prints:

```
Signed in. The login was saved in the data folder (private file, never printed).
Created the dedicated calendar "Polito (polito-cal-sync)". Its id was saved in the data folder.
```

On a second run it says "Found and will reuse ...". It **never** uses your main calendar (`E_GOOGLE_CALENDAR_IS_PRIMARY` if you try). Check in Google Calendar that a new calendar "Polito (polito-cal-sync)" exists and is empty.

Files in `./data` (mode 0600, private): `google-token.json` (your login), `google-calendar.json` (the calendar id).

## 4. First run: dry run, then for real

```bash
pnpm sync --dry-run
```

Writes nothing (no calendar change, no history). Expected shape (your numbers and titles differ):

```
Calendar: <calendar id>
Mode: DRY RUN. Nothing is written to the calendar or to the history.

Sources
  ics      complete   57 events
    feed #1 (example.polito.it): ok, 57 event(s), 3 cancelled left out

Plan
  + create  2026-11-09 08:30–10:00   [lecture]  Analisi matematica I   ics:...
  ...
  = 0 unchanged

Safety: no existing events of ours to delete from.

Result: would create 57, update 0, delete 0, keep 0. Run without --dry-run to apply.
```

Look at the plan: do the times match what you see in the Polito app (time zone!), are cancelled lessons absent? If something is wrong, stop and tell the developer which feed line and which event (no need to send the URL).

Then:

```bash
pnpm sync
```

Expected last line: `Result (ok): created 57, updated 0, deleted 0, unchanged 0, failed 0.` Open Google Calendar: the events are in "Polito (polito-cal-sync)" and nothing changed in your other calendars. **That proves (1).**

## 5. Second run is a no-op

```bash
pnpm sync
```

Expected: `Result (ok): created 0, updated 0, deleted 0, unchanged 57, failed 0.` and in the plan `= 57 unchanged`. **That proves (2).** (The number of events is whatever the first run created.) If it says `updated N` instead of unchanged, tell the developer: that is a bug (the content hash is not stable).

## 6. A removed event is deleted

Your Polito feed is not yours to edit, so use a throw-away feed you control. This uses a **separate data folder and a separate test calendar** so your real calendar is not involved.

1. Create a folder and the feed file:

```bash
mkdir -p ~/ics-test && cd ~/ics-test
cat > test.ics <<'ICS'
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//polito-cal-sync runbook//EN
BEGIN:VEVENT
UID:rb-1@example.invalid
DTSTAMP:20261101T000000Z
DTSTART:20261201T090000Z
DTEND:20261201T100000Z
SUMMARY:Runbook test 1
END:VEVENT
BEGIN:VEVENT
UID:rb-2@example.invalid
DTSTAMP:20261101T000000Z
DTSTART:20261202T090000Z
DTEND:20261202T100000Z
SUMMARY:Runbook test 2
END:VEVENT
BEGIN:VEVENT
UID:rb-3@example.invalid
DTSTAMP:20261101T000000Z
DTSTART:20261203T090000Z
DTEND:20261203T100000Z
SUMMARY:Runbook test 3
END:VEVENT
BEGIN:VEVENT
UID:rb-4@example.invalid
DTSTAMP:20261101T000000Z
DTSTART:20261204T090000Z
DTEND:20261204T100000Z
SUMMARY:Runbook test 4
END:VEVENT
END:VCALENDAR
ICS
python3 -m http.server 8000 --bind 127.0.0.1
```

Leave that terminal open (it serves the file at `http://127.0.0.1:8000/test.ics`).

2. In a **second terminal**, in the project folder, use a separate data folder and calendar name (your `.env` values for Google are reused; the two variables below override `.env`):

```bash
export DATA_DIR=./data-test
export SOURCE_POLITO_ICS_URLS=http://127.0.0.1:8000/test.ics
pnpm auth google --calendar-name "Polito TEST (polito-cal-sync)"
pnpm sync
```

Expected: `Result (ok): created 4, updated 0, deleted 0, unchanged 0, failed 0.` and 4 events in the TEST calendar.

3. Delete the last event from the feed file (in the first terminal's folder, in another shell):

```bash
cd ~/ics-test
python3 - <<'PY'
t = open('test.ics').read()
i = t.index('BEGIN:VEVENT\nUID:rb-4')
j = t.index('END:VEVENT\n', i) + len('END:VEVENT\n')
open('test.ics', 'w').write(t[:i] + t[j:])
PY
```

4. Back in the project folder (with the two `export`s still active):

```bash
pnpm sync --dry-run     # shows "- delete ... Runbook test 4", safety 1 of 4 = 25%, limit 30% - ok
pnpm sync
```

Expected: `Result (ok): created 0, updated 0, deleted 1, unchanged 3, failed 0.` and "Runbook test 4" is gone from the TEST calendar. **That proves (3).** (Removing 2 of 4 would be 50%: the run would be refused with `E_DELETE_THRESHOLD` unless you add `--force`. That is the safety net working.)

5. Clean up: stop the web server (Ctrl+C), delete the "Polito TEST (polito-cal-sync)" calendar in Google Calendar (Settings -> that calendar -> Delete calendar), then `rm -rf ./data-test ~/ics-test` and `unset DATA_DIR SOURCE_POLITO_ICS_URLS`.

## 7. One-off: what does Google do with a deleted event id?

(Decision 010.) With your real `DATA_DIR`/`.env` again (new terminal, or after the `unset`):

```bash
pnpm verify-google
```

It creates a throw-away calendar named "polito-cal-sync verify (safe to delete)", creates an event, deletes it, creates it again with the same id, and tries to bring it back with `events.patch` (then `events.update`), then deletes the calendar. It does not touch your real calendar. Expected shape:

```
  1. created a throw-away calendar: ok
  2. inserted event A: ok
  3. deleted event A: ok
  4. get after delete: status "cancelled", extended properties gone
  5. inserting the same id again: HTTP 409 duplicate
  6. events.patch on the deleted id: accepted (status "confirmed")
  7. after patch the event is back with our content and marker: YES
  10. list filtered by our marker returns 1 event(s)
  11. deleted the throw-away calendar: ok
Findings (no secrets, safe to share): ...
What it means: Keep events.patch for restoring a deleted event (decision 002 holds).
```

That sample is what the _assumption_ predicts; your output is the real answer. Copy the "Findings" block and the "What it means" line into `docs/decisions/010-google-id-reuse-verification.md` as "Finding: ..." (it contains no secrets). If it says `events.update` is needed, nothing breaks: the program falls back automatically. If step 11 says it could not delete the calendar, delete "polito-cal-sync verify (safe to delete)" by hand.

---

## Route B: Docker (the always-on service)

After Route A worked (or instead of it, if you only want Docker). `.env` is the same as in step 2, except leave `DATA_DIR` alone (the image uses the `/data` volume).

```bash
docker compose build
```

Sign in from inside the container. The redirect must reach the container, so the port is published on your machine's loopback only:

```bash
docker compose run --rm -p 127.0.0.1:8789:8789 polito-cal-sync auth google --bind 0.0.0.0 --port 8789
```

Open the printed address in your browser on the same machine (it points at `127.0.0.1:8789`). Then:

```bash
docker compose run --rm polito-cal-sync sync --dry-run
docker compose run --rm polito-cal-sync sync
docker compose up -d
```

`up -d` starts `serve`: one sync right away, then one every `SYNC_INTERVAL_MINUTES`. Check:

```bash
docker compose ps                         # "healthy" after about a minute
docker compose logs --tail 20             # JSON lines: "sync run finished" with status ok
curl -s http://127.0.0.1:8787/status      # last run, counts, error code; no titles, no URLs
```

`docker compose stop` finishes a sync in progress (up to 30 s) before exiting. Note: Route B was written but could not be exercised in the build environment; if a step misbehaves, tell the developer which one.

---

## When something goes wrong

Every message has a code; the full explanation is in `docs/ERRORS.md`.

| You see                      | Most likely                                                                         | Do                                             |
| ---------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------- |
| `E_GOOGLE_CLIENT_MISSING`    | `GOOGLE_CLIENT_ID`/`SECRET` empty in `.env`                                         | step 2                                         |
| `E_GOOGLE_AUTH_FAILED`       | cancelled, timed out (5 min), wrong client secret, or no calendar permission ticked | run `pnpm auth google` again                   |
| `E_GOOGLE_AUTH_EXPIRED`      | app still in "Testing" (7 days) or access revoked                                   | publish the app (step 1), `pnpm auth google`   |
| `E_GOOGLE_PERMISSION_DENIED` | Calendar API not enabled in the project                                             | step 1.2                                       |
| `E_ICS_FEED_REJECTED`        | feed URL wrong or regenerated                                                       | copy it again into `.env`                      |
| `E_ICS_FEED_INVALID`         | URL returns a web page, not a `.ics`                                                | open it in a private window                    |
| `E_ICS_FEED_FETCH_FAILED`    | network or server down; nothing is deleted                                          | wait for the next run                          |
| `E_ICS_FEED_UNSUPPORTED`     | an event uses a feature not handled; the rest still syncs                           | report positions (no text)                     |
| `E_DELETE_THRESHOLD`         | the run would delete more than 30%                                                  | check the feed; `--force` only if you are sure |
| `E_SYNC_ALREADY_RUNNING`     | another sync (or `serve`) is working                                                | wait a minute                                  |

To start over: delete the "Polito (polito-cal-sync)" calendar in Google Calendar, `rm -rf ./data`, and run steps 3-5 again.
