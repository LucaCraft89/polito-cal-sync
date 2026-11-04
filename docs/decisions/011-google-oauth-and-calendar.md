# 011 Google OAuth and the dedicated calendar

**Decided**

- **Installed-app loopback flow with PKCE and `state`**, listening on `127.0.0.1` (random port unless `--port`), 5 minute timeout, `access_type=offline` + `prompt=consent` so Google always returns a refresh token. A request with a wrong `state` is answered 400 and ignored.
- **Docker:** inside a container the host browser cannot reach the container's loopback. `auth google --bind 0.0.0.0 --port 8789` plus `docker compose run -p 127.0.0.1:8789:8789` publishes that port on the host's loopback only; the redirect address stays `http://127.0.0.1:8789/...`. Not exercised here (no Docker run, no Google).
- **Scope:** `https://www.googleapis.com/auth/calendar` (full). Needed to create the calendar and for `verify-google` to delete its throw-away one. Narrower `calendar.app.created` would limit damage but its behaviour with calendars made in the Google UI is unverified. The write guard stays in `OwnedCalendar` (marker + one calendar).
- **Login storage:** `DATA_DIR/google-token.json`, mode 0600, atomic write; refreshed access tokens are saved back. Contents never logged or printed (`E_GOOGLE_AUTH_EXPIRED` for a damaged file does not echo it). A refused refresh (`invalid_grant`) maps to `E_GOOGLE_AUTH_EXPIRED` through the existing error mapper.
- **Calendar:** `auth google` creates "Polito (polito-cal-sync)" or reuses an owned, non-primary calendar of exactly that name; `--calendar-name` picks another name (the runbook uses it for a test calendar), `--calendar-id` picks an existing one. The id is saved in `DATA_DIR/google-calendar.json`; `GOOGLE_CALENDAR_ID` overrides it.
- **Never the primary calendar:** `primary`, or an id whose calendar-list entry has `primary: true` (the email address), is refused with `E_GOOGLE_CALENDAR_IS_PRIMARY`, checked at every `sync`/`serve` run (one `calendarList.get`), as is a calendar we cannot write to.
- Client credentials come from `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`; missing = `E_GOOGLE_CLIENT_MISSING`.
- **Testing vs In production:** an external app left in "Testing" loses its refresh token after 7 days. The runbook says to publish it ("In production") before `auth google`; Google then shows an "unverified app" warning for the owner's own login, which is expected for a personal client.
