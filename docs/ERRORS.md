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

## E_POLITO_API_AUTH_REJECTED

**What happened:** the Polito server refused our login or our token (HTTP 401 or 403).
**Why:** wrong or expired credentials, a token that expired, or the account requires multi-factor authentication (MFA) that this server has not completed.
**What to do:** the source stops for this run and nothing is deleted. It does not retry the login (repeated failures can lock an account). Check the credentials, then see `docs/M3-RUNBOOK.md` about MFA. The ICS source is unaffected.

## E_POLITO_API_FETCH_FAILED

**What happened:** a request to the Polito portal failed: no connection, a timeout, a server error, or "too many requests" (HTTP 429).
**Why:** Polito's service is down or busy, or this machine is offline.
**What to do:** wait; the next scheduled run tries again. After a 429 the source makes no more requests in that run. Events that could not be read are never deleted from your calendar.

## E_POLITO_API_UNEXPECTED_DATA

**What happened:** an answer from the Polito portal did not have the shape this program expects, so those items were left out and the run is marked incomplete.
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

## E_SETTINGS_FILE_INVALID

**What happened:** the file with the settings saved by the web UI (`DATA_DIR/settings.json`) could not be used.
**Why:** it was edited by hand, damaged, has a setting with the wrong shape, or was written by a newer version of this program.
**What to do:** fix the file or move it away (keep a copy first), then start again. Settings in `.env` are not affected. The message names the problem (a setting key or "not valid JSON"), never a value.

## E_SETTING_INVALID

**What happened:** a setting was not saved because its value breaks a rule.
**Why:** the web UI applies exactly the same rules as `.env` (for example the sync interval is 15 to 1440 minutes, the exam calls setting is `booked` or `all`).
**What to do:** correct the listed settings and save again. Nothing was changed; a change is saved completely or not at all. The message names the setting and the rule, never the value.

## E_SETTING_LOCKED

**What happened:** a setting was not changed because an environment variable controls it.
**Why:** a value in `.env` or in the container environment always wins over the UI, so a change here would have no effect.
**What to do:** change it where it is set (the message names the variable), or remove that variable to manage the setting in the UI.

## E_UI_HOST_REFUSED

**What happened:** the web UI refused the request because of the address it was reached through.
**Why:** the `Host` header is not `localhost`, `127.0.0.1` or `[::1]` (or a name you added to `UI_ALLOWED_HOSTS`). This protects against web pages that try to reach the UI through your browser (DNS rebinding). The first-run passphrase step is further limited to the localhost names, because whoever opens the page first chooses the passphrase.
**What to do:** open the UI as `http://localhost:<port>` on the machine that runs the service. Behind your own reverse proxy, list its name in `UI_ALLOWED_HOSTS` (and set `UI_HTTPS=true` if the proxy terminates TLS).

## E_UI_REQUEST_REFUSED

**What happened:** the web UI refused a request before acting on it.
**Why:** one of: the CSRF token is missing or wrong; the request does not come from the UI page itself (`Origin` or `Sec-Fetch-Site` mismatch); the body is not a JSON object, is larger than 256 KB or has unexpected fields; the method is not allowed at that address. Changes are accepted only from the UI itself so that other web pages cannot send them.
**What to do:** use the UI in the browser and reload the page if it was open for a long time. When testing with `curl`, send the `Origin` header of the page, the `X-CSRF-Token` header from `GET /api/session`, and `Content-Type: application/json`.

## E_UI_AUTH_REQUIRED

**What happened:** the request needs a login and there is none.
**Why:** you are not logged in, or the session ended (30 minutes without use, 12 hours in total, a passphrase change or a restart of the service).
**What to do:** log in with the UI passphrase.

## E_UI_LOGIN_FAILED

**What happened:** the passphrase was not correct.
**Why:** it does not match the one chosen on first run (or, when changing it, the current one).
**What to do:** type it again. After a few wrong tries you must wait (E_UI_LOGIN_THROTTLED). If it is lost, run `reset-ui-passphrase` on the machine (`docker compose run --rm polito-cal-sync reset-ui-passphrase` in Docker): that needs access to the data folder and keeps all settings.

## E_UI_LOGIN_THROTTLED

**What happened:** too many wrong passphrases were typed, so logins are paused for a while.
**Why:** repeated failures are slowed down on purpose: after two free typos the wait doubles each time, up to 15 minutes, and many failures from anywhere pause every login. While paused even the right passphrase is refused.
**What to do:** wait the number of seconds named in the message (also in the `Retry-After` header), then type the passphrase carefully.

## E_UI_SETUP_STATE

**What happened:** the first-run step and the current state do not fit together.
**Why:** either a passphrase is already set (the first-run step works only once), or none is set yet and a login was attempted.
**What to do:** if one is set, log in. If none is set, open the UI on the machine that runs the service and choose a passphrase. To start over, run `reset-ui-passphrase`.

## E_UI_PASSPHRASE_WEAK

**What happened:** the new passphrase was not accepted.
**Why:** it has fewer than 12 characters, more than 256, or fewer than 5 different characters. There are no other rules.
**What to do:** use a longer one; several unrelated words work well and are easy to remember.

## E_UI_NOT_FOUND

**What happened:** there is nothing at the address that was requested.
**Why:** the path is not part of the web UI API.
**What to do:** check the address against `docs/UI.md`.

## E_UI_PREVIEW_BUSY

**What happened:** a preview was requested while another one is still running.
**Why:** only one preview runs at a time, so the university and Google are not asked twice at once.
**What to do:** wait for the running preview to finish; its result appears on the Preview page.

## E_UI_PREVIEW_RATE_LIMITED

**What happened:** a preview was requested less than 15 minutes after the last one, so no new one was started.
**Why:** a preview logs in to the university portal and reads your calendar; limiting how often protects your account and your Google quota. The limit counts from the start of the last attempt, also when it failed.
**What to do:** try again after the time the message gives. The last result stays visible on the Preview page.

## E_UI_UNREACHABLE

**What happened:** the page could not reach the program (the browser got no answer).
**Why:** `serve` may have stopped or restarted, or the connection was lost.
**What to do:** check that `serve` (or the container) is running, then reload the page.
