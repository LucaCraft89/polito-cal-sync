# Error codes

Every error the service shows has a stable code, what happened, the likely reason, and what to do. This page explains each code in more detail. In the terminal, the wizard and `doctor` you see the same three lines; stack traces only go to the debug log (`LOG_LEVEL=debug`).

Nothing on this page ever asks you to paste a password or token anywhere.

## E_USAGE

**What happened:** the command line was not understood.
**Why:** a command or option is misspelled or missing.
**What to do:** run `pnpm sync --help` (or `node dist/main.js --help`) and compare.

## E_NOT_IMPLEMENTED

**What happened:** you ran a command that belongs to a later milestone.
**Why:** the project is built step by step (see `docs/PLAN.md`); `serve` arrives with M2, `doctor` with M5.
**What to do:** nothing is broken. Use the commands the message lists, or wait for the milestone.

## E_INTERNAL

**What happened:** something unexpected failed that is not covered by a specific code.
**Why:** most likely a bug.
**What to do:** run again with `LOG_LEVEL=debug`, then open an issue with the log (remove personal data first).

## E_CONFIG_INVALID

**What happened:** a setting in `.env` or in the container environment has a wrong format.
**Why:** a typo, or a value outside the allowed range. The message names the variable and the rule, never the value.
**What to do:** fix the listed variables, comparing with `.env.example`.

## E_DATA_DIR_NOT_WRITABLE

**What happened:** the folder for state, tokens and the database cannot be written.
**Why:** it does not exist, is not a folder, or belongs to another user. With Docker named volumes this does not happen; with a bind mount owned by root it does.
**What to do:** `chown` the folder to uid 1000 (the `node` user in the image), or set `DATA_DIR` to a folder you own.

## E_STATE_DB_OPEN_FAILED

**What happened:** the sqlite file with the sync history could not be opened.
**Why:** the file is corrupt, locked by another running instance, or the disk is full.
**What to do:** make sure only one instance runs. If the file is corrupt, move `state.db` out of the data folder: the next run rebuilds state from the calendar (events we created are recognised by their marker), nothing is lost.

## E_STATE_DB_SCHEMA_NEWER

**What happened:** the state database was written by a newer version of this program.
**Why:** you started an older version on a data folder used by a newer one.
**What to do:** upgrade to the newer version, or use a separate data folder.

## E_NOT_CONFIGURED

**What happened:** `sync` or `serve` needs something that is not set up yet: the Google login, the Google calendar, or at least one source (`SOURCE_POLITO_ICS_URLS`). The message says which.
**Why:** the first-time setup was not finished, or the data folder (`DATA_DIR`) is a different one from the one used during setup.
**What to do:** follow the steps in `docs/M2-RUNBOOK.md`: `auth google` connects Google and picks the calendar; `SOURCE_POLITO_ICS_URLS` goes in `.env`. To see the engine work without any account, run `pnpm sync --dry-run --fixture test/fixtures/m2`.

## E_FIXTURE_INVALID

**What happened:** a `--fixture` folder is missing a file or a file is not valid.
**Why:** fixtures are developer-only input for trying the sync engine without accounts.
**What to do:** compare with `test/fixtures/m1` (it has `sources.json` and `calendar.json`).

## E_EVENT_INVALID

**What happened:** a source produced an event that cannot be turned into a calendar event.
**Why:** missing title or date, an end before the start, or a date in an unexpected format.
**What to do:** nothing is written for that source until it is fixed. Report it with the `source` and `sourceId` shown in the message (not the event text, which may be personal).

## E_DUPLICATE_SOURCE_ID

**What happened:** one source returned two events with the same id.
**Why:** the source has no stable id for them, or the adapter built ids badly. Writing both would make them overwrite each other on every run.
**What to do:** report it. The run stops before writing anything.

## E_DELETE_THRESHOLD

**What happened:** the run was refused because it would remove too many events from your calendar.
**Why:** the sources report that many of the events we created earlier are gone. That usually means a source returned an empty or partial list (feed moved, login expired), not that your whole schedule vanished.
**What to do:** check the source with `doctor`. If the removal is really what you want, run `sync --force`. The limit is `DELETE_THRESHOLD` (default 0.3 = 30%).

## E_NOT_OURS

**What happened:** the program was about to change or delete an event that it did not create.
**Why:** the event has no `polito_cal_sync` marker. This is a safety stop: we only touch our own events.
**What to do:** nothing; the event was left alone. If you see this repeatedly, report it.

## E_ID_COLLISION

**What happened:** an event that is not ours already uses the id we wanted for a new event.
**Why:** extremely unlikely (ids are a hash), or someone created an event by hand with that id.
**What to do:** the foreign event was left alone and this item was skipped. Report it.

## E_GOOGLE_AUTH_EXPIRED

**What happened:** Google no longer accepts the saved login.
**Why:** the access was revoked, the password changed, or the Google Cloud app is in "Testing" mode (refresh tokens then expire after 7 days).
**What to do:** reconnect with `auth google` (see `docs/M2-RUNBOOK.md`). To avoid weekly expiry, set the OAuth app's publishing status to "In production" in the Google Cloud console (the runbook shows where); an app in "Testing" loses its login every 7 days. The same code appears if the saved login file is damaged.

## E_GOOGLE_PERMISSION_DENIED

**What happened:** Google refused the request.
**Why:** the connected account cannot edit the chosen calendar, or the Calendar API is not enabled in your Google Cloud project.
**What to do:** pick a calendar you own (`auth google --calendar-id ...`), and enable the "Google Calendar API" for the project.

## E_GOOGLE_CALENDAR_NOT_FOUND

**What happened:** the chosen calendar does not exist for this account.
**Why:** it was deleted, or `GOOGLE_CALENDAR_ID` is wrong.
**What to do:** choose or create the calendar again in the wizard.

## E_GOOGLE_QUOTA

**What happened:** Google asked us to slow down and still refused after several waits.
**Why:** too many requests in a short time (rate limit or daily quota).
**What to do:** nothing; the next scheduled run continues. Do not lower `SYNC_INTERVAL_MINUTES`.

## E_GOOGLE_UNAVAILABLE

**What happened:** Google had a server problem and still failed after several retries.
**Why:** a temporary outage, or no internet connection from the container.
**What to do:** nothing; the next run retries. Check the machine's network if it persists.

## E_GOOGLE_REQUEST_FAILED

**What happened:** Google rejected a request with an error we do not have a specific code for.
**Why:** unknown; the message includes Google's status and reason code.
**What to do:** run again with `LOG_LEVEL=debug` and open an issue.

## E_GOOGLE_CLIENT_MISSING

**What happened:** the Google OAuth client is not configured, so Google cannot be connected.
**Why:** `GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET` is empty.
**What to do:** create an OAuth client of type "Desktop app" in the Google Cloud console and put its id and secret in `.env` (steps in `docs/M2-RUNBOOK.md`). The secret stays on your machine; never paste it into an issue or a chat.

## E_GOOGLE_AUTH_FAILED

**What happened:** the Google sign-in did not finish, so nothing was saved.
**Why:** one of: you pressed "Cancel" or closed the browser tab; nothing came back within 5 minutes; the redirect did not reach this program (with Docker the port must be published, see the runbook); the sign-in answer did not match this attempt; Google refused the code (wrong client secret); Google did not grant calendar access or did not return a long-lived login (refresh token).
**What to do:** run `auth google` again and tick the calendar permission when asked. If Google returns no long-lived login, remove this app's access at https://myaccount.google.com/permissions and run it again.

## E_GOOGLE_CALENDAR_IS_PRIMARY

**What happened:** the chosen calendar is the main calendar of the Google account, so it was refused.
**Why:** this tool writes into a dedicated calendar so it can never mix with your real events. `primary`, or the id that equals your email address, is the main calendar.
**What to do:** run `auth google` without `--calendar-id` to create the dedicated calendar, or pass the id of a secondary calendar (Google Calendar, Settings, the calendar, "Integrate calendar"). Clear `GOOGLE_CALENDAR_ID` if you set it to your email.

## E_ICS_FEED_FETCH_FAILED

**What happened:** a calendar feed could not be downloaded this time.
**Why:** no network from the machine or container, the server timed out, or it answered with an error (429/5xx) after several waits. Also used when the server says "not modified" but the saved copy is gone.
**What to do:** nothing; the next run tries again. The sync still adds and updates events from the feeds that worked, and deletes nothing from this source while one feed is missing. The message names the feed by number and host only; the full URL (which may contain a secret) is never printed.

## E_ICS_FEED_REJECTED

**What happened:** the server refused the feed URL (HTTP 401, 403, 404 or 410).
**Why:** the URL is wrong, was regenerated so its secret token changed, or the feed was removed.
**What to do:** copy the feed URL again from the course page and update `SOURCE_POLITO_ICS_URLS` in `.env`. Nothing was deleted because of this.

## E_ICS_FEED_INVALID

**What happened:** the answer is not a readable calendar file, or it is far too large.
**Why:** the URL points to a web page (for example a login page) instead of a `.ics` feed, or the file is damaged.
**What to do:** open the URL in a private browser window: it should download a `.ics` file. If it shows a login page, copy the feed URL again. Nothing was deleted because of this.

## E_ICS_FEED_UNSUPPORTED

**What happened:** some events in a feed use a feature this program does not handle (for example a recurrence rule it does not support, a time zone it cannot resolve, an event without UID).
**Why:** calendar files allow many rarely used features; this program implements the ones students' feeds use and refuses to guess the rest.
**What to do:** nothing is lost: all other events are synced, and while this problem is in the feed nothing is deleted from the ICS source. Report it in an issue; the message lists event positions and reasons, never event text.

## E_SYNC_ALREADY_RUNNING

**What happened:** another sync is running on the same data folder, so this one did not start.
**Why:** the scheduled `serve` loop is syncing right now, or a manual `sync` is. Two at once could fight over the same calendar. A crashed run can leave its lock behind for up to 20 minutes.
**What to do:** wait a minute and try again. If it still says so 20 minutes after a crash, it clears itself.

## E_POLITO_API_NOT_READY

**What happened:** `SOURCE_POLITO_API_ENABLED=true` is set, but this version cannot log in to the Polito student API yet, so that source was skipped for this run.
**Why:** the login method for an unattended server (password only, or an enrolled MFA device) has not been confirmed. It is settled by the owner-run probe in `probe/` (see `docs/M3-RUNBOOK.md`); until then the Polito API source deliberately does nothing.
**What to do:** nothing is broken and nothing was deleted: the calendar feeds (ICS) are unaffected. Set `SOURCE_POLITO_API_ENABLED=false` to silence this message, or follow `docs/M3-RUNBOOK.md` to help settle the login question.

## E_POLITO_API_AUTH_REJECTED

**What happened:** the Polito server refused our login or our token (HTTP 401 or 403).
**Why:** wrong or expired credentials, a token that expired, or the account requires multi-factor authentication (MFA) that this server has not completed.
**What to do:** the source stops for this run and nothing is deleted. It does not retry the login (repeated failures can lock an account). Check the credentials, then see `docs/M3-RUNBOOK.md` about MFA. The ICS source is unaffected.

## E_POLITO_API_FETCH_FAILED

**What happened:** a request to the Polito API failed: no connection, a timeout, a server error, or "too many requests" (HTTP 429).
**Why:** Polito's service is down or busy, or this machine is offline.
**What to do:** wait; the next scheduled run tries again. After a 429 the source makes no more requests in that run. Events that could not be read are never deleted from your calendar.

## E_POLITO_API_UNEXPECTED_DATA

**What happened:** an answer from the Polito API did not have the shape this program expects, so those items were left out and the run is marked incomplete.
**Why:** Polito changed its API, or the program's description of a field was a guess that the real data does not match.
**What to do:** nothing is deleted while this lasts. Run the probe again (`docs/M3-RUNBOOK.md`) and open an issue with the sanitized summary (never raw data) so the description can be corrected. The message names the endpoint and the field, never the content.

## E_POLITO_LOGIN_EXTRA_STEP

**What happened:** the university login (`idp.polito.it`) asked for something beyond username and password, such as a code or a second factor, and this program cannot answer it.
**Why:** multi-factor authentication applies to this account, or this server counts as a new device.
**What to do:** nothing was answered or deleted; the ICS source keeps working. Your browser may have been a trusted device: that trust does not carry over to this program. Report it with `probe/05-idp-login.mjs` output (field names only).

## E_POLITO_LOGIN_BLOCKED

**What happened:** the Polito login is paused because these exact credentials were refused earlier.
**Why:** retrying a refused password every hour could get the account locked.
**What to do:** check the credentials in a browser, fix `POLITO_USERNAME` / `POLITO_PASSWORD` in `.env`. The pause ends by itself as soon as they change.
