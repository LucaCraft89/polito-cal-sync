# 034 Moodle: what probe 07 shows about the export link

**Observed** (owner run, 2026-11-05, 17 requests, `probe/out/07-moodle-events.json`; counts only).

- `core_calendar_get_calendar_events` (30 days back to 180 ahead, the user's 5 courses plus user and site events): **31 events** (13 `reservation`/start, 13 `reservation`/reservation... by module: 26 `reservation`, 5 `quiz`; 14 in 2026-10, 17 in 2026-11, none later).
- Export link, three time-period variants, all `preset_what=all`: `recentupcoming` and `monthnow` both hold **17 events, 1 to 20 Nov 2026**; `custom` holds **18, 1 Nov 2026 to 1 Oct 2027**. Every export event but one is in the query result (17 of 17 in November; the one export-only event is beyond the 180-day window of the query).
- So the export **loses the past** (all 14 October events, 10 reservations and 4 quizzes, are in no variant: it starts at the first of the current month) and, in `recentupcoming`/`monthnow`, **everything after about 15 days ahead**. **`custom` is the longest and the one to use** (this corrects decision 031 and the first version of SETUP.md, which called custom a fixed window).
- **The month view is bigger than both:** `core_calendar_get_calendar_monthly_view` for the current month holds **52 event occurrences** against 17 from the event query and 17 in the export. The occurrences may include multi-day events repeated on every day, so the number of **distinct** events is not known yet; whether 35 events really exist that neither the export nor the legacy query returns is exactly what probe 08 measures (distinct ids, and for the ones only the month view has: module, event type, component, course, duration, visibility).
- Not an obstacle: the month view carries the full event object (`id, name, modulename, eventtype, component, timestart, timeduration, course{id, shortname}, url, ...`), so a source can be built on it if it proves to be the complete one. It would need one call per month shown (8 per run for a window of -2 to +5 months).

**What the owner can do now (no code):** export with **Custom range**, not the other choices.

**Decided.** The Moodle source is built after probe 08, on whichever call returns the complete set; probe 08 compares the three by id and prints counts only. Fail-closed rules as decision 019; token from the SSO client (decision 033). The export link stays the credential-free fallback.
