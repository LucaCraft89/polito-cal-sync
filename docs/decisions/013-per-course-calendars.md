# 013 One Google calendar per course (design; implementation is the first task of M4/M5)

The owner wants a separate Google calendar per course (Moodle and Polito events together) so courses can be toggled on and off in Google Calendar, and shared Moodle courses hidden. M3 only prepares the data: `CanonicalEvent.course` (optional, **not in the content hash**, see below). Nothing else of this is implemented yet.

## What M3 did

- `CanonicalEvent.course?: string`, an **opaque key**. ICS: the first value of `CATEGORIES` (Moodle: `2026_16AHMWZ_8`, year_code_n, never parsed). Polito API: `polito:<course id>`. Two key spaces, because the two systems share no known id.
- Not in the hash: moving an event between courses is a routing change, not a content change. `course` is also not written to Google yet.

## Design

**Course key -> calendar.** `DATA_DIR/course-calendars.json` (mode 0600, atomic write): `{ "<course key>": { "calendarId": "...", "name": "<name we set>" } }`. This file is the truth about which calendars are ours. Calendars are created **lazily**, the first time a run has an event for that course, named `Polito - <name>`.

**Names.** Codes are unreadable, so an optional `DATA_DIR/course-names.json` supplies them: `{ "2026_16AHMWZ_8": { "name": "Analisi 1", "aliases": ["polito:12345"] } }`. `aliases` is how a Moodle key and a Polito key are declared to be the same course (the only way, since no join key is known). A course without a name entry gets the key as name (`Polito - 2026_16AHMWZ_8`); the owner can rename it in Google at will. A later change in `course-names.json` renames **our** calendar only if its current name still equals the one we set (a rename made in Google is respected).

**Never delete calendars**, not even empty ones, not even with `--force`. Removing a course = the owner deletes the calendar in Google.

**Guards.** One `OwnedCalendar` per calendar, so the marker check, the id-collision rule and "never primary / must be writable" (decision 011) apply to each. Per run, one `calendarList.list` verifies all of them (not one `get` per calendar).

**Events without a course** (ICS without `CATEGORIES`, a recurrence override that lacks it, items of unknown course) go to the default calendar from decision 011. An override should inherit the course of its master: implement with the routing (M3 left it, it currently routes such an instance to the default calendar).

**Switch.** `CALENDAR_PER_COURSE=false` (default) keeps today's behaviour exactly. `true` enables routing. Turning it off later does **not** strand events: the calendar set is always default + every calendar in `course-calendars.json`, and with the switch off every event is desired in the default calendar, so the normal move rule below brings them back.

**Moves.** The id of a Google event is derived from `source:sourceId` and is unique per calendar, so the same id works in two calendars. An event whose managed copy sits in calendar X but is desired in Y is a **move**: create in Y first, delete in X after all creates succeeded. Moves are shown as "moved" in the plan and **do not count toward the deletion threshold** (a switch-on would otherwise look like deleting 100%).

**Deletion threshold per calendar, two-phase run.** Phase 1 computes the plan of every calendar (a calendar that does not exist yet has an empty remote list) with the existing `diff`, using the threshold per calendar and its own base (decision 001). Phase 2 applies **only if no calendar's plan is refused**, unless `--force`; this is decision 001's "the whole run is refused" extended across calendars. A source that is incomplete deletes nothing in any calendar. Apply order: creates and patches everywhere, then move-deletes, then ordinary deletes. A crash midway leaves duplicates, never losses, and the next run converges.

**Calendar creation is rate-limited by Google** ("too many calendars created" errors exist). At most 5 calendars are created per run, one at a time with a pause. Events of a course whose calendar could not be created yet are left out of that run (nothing is written, nothing deleted) and reported; the next run continues.

**Dry run.** Creates no calendar and writes nothing. It needs only read access (`calendarList.list`) and prints `calendar "Polito - Analisi 1" would be created (12 events)` per missing calendar, and the moves.

**Status and doctor (M5).** Per calendar counts, courses with no name entry ("name them in course-names.json"), calendars in the map that no longer exist in Google (reported, never recreated silently: the owner may have deleted it on purpose).

## Costs and open points

- API calls grow with the number of courses (one list per calendar per run). Fine for the 5 to 15 courses of a student; the 60 minute interval stays.
- Colour per course: not decided (Google lets each calendar have its own colour in its UI, which is the natural place).
- The Polito course ids and the Moodle codes may turn out to be derivable from each other once the probe shows real data; then `aliases` could be filled automatically. Until then it is manual and optional.
