# 022 What is really left of M4 (Moodle), decided from evidence

**Context.** M4 on paper is "Moodle probe + source (export URL preferred)". The export URL already works as an ICS feed since M2, and decision 020 labels it (`kind: moodle`, `[Moodle] ` prefix). The owner's dry runs show the Moodle events arriving. So the probe-and-source part of M4 is **done by M2/M3**.

**Evidence checked this step**

- Live, read-only, one portal login (2026-11-05): the portal source is complete with 0 issues; 39 events with the owner's squads; all 23 events that carry a course key have a name in the course list (`carico`, 8 courses). So course names are available for free.
- Moodle itself **cannot be reached from the build sandbox**: the login client only talks to `didattica.polito.it` and `idp.polito.it`, and the Moodle export needs the owner's token. Nothing about what Moodle answers to a stale token, or how its deadlines are named, was observed.

**Decided: M4 is small and has three parts**

1. **Friendly errors for Moodle feeds.** A refused (`E_ICS_FEED_REJECTED`) or unreadable (`E_ICS_FEED_INVALID`) feed on the Moodle host now says how to export the link again (stock Moodle menu names, Italian label too) and keeps the "nothing was deleted" line. The text says "usually": **what Moodle really answers to a stale token is UNVERIFIED** (the status/body handling is the generic one that already covered 401/403/404/410 and HTML pages).
2. **Course names in `--details`.** `course Analisi (polito:111111)` instead of the bare key, from `PolitoPortalSource.courseNames`. This is what the squad setting and, later, the Courses page need.
3. **Not built, on purpose:**
   - **Telling Moodle deadlines ("... apre/chiude") from other events.** The only signal would be the Italian wording of the title, which is a language-dependent guess; AGENTS.md forbids guessing. Needs a sanitized sample of the owner's Moodle titles (kinds of suffixes and counts, no course names) first. If it is wanted, it becomes an opt-in setting, never a default.
   - **Per-course calendars (decision 013).** Real work (two-phase run, moves, per-calendar thresholds, calendar creation limits) and needs the Courses page to be usable. Moved to M5 step 4, after the UI exists.
   - A separate Moodle web-service source (`tool_mobile`): needs a password or token at runtime, and the export URL does the job without one.

**Consequence.** M4's "Done when" is met as: Moodle events appear with their own kind and a visible label (decision 020); failures give friendly errors (this decision). Colour per kind stays open (PLAN, open decision 2).
