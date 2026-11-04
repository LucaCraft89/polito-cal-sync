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

**What happened:** `sync` was asked to talk to Google, but Google is not connected yet.
**Why:** the Google connection (OAuth) and the sources are set up in M2/M5; they are not available yet.
**What to do:** to see the engine work without any account, run `pnpm sync --dry-run --fixture test/fixtures/m1`.

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
**What to do:** reconnect Google from the wizard. To avoid weekly expiry, publish the OAuth app as "In production" (see `docs/SETUP.md`).

## E_GOOGLE_PERMISSION_DENIED

**What happened:** Google refused the request.
**Why:** the connected account cannot edit the chosen calendar, or the Calendar API is not enabled in your Google Cloud project.
**What to do:** pick a calendar you own in the wizard, and enable the "Google Calendar API" for the project.

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
