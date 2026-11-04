# 019 The portal source: mapping, time, failure rules

**Decided** (from the owner's sanitized `getStudentData` sample, decision 018)

- **Source id `polito`**, switch `SOURCE_POLITO_PORTAL_ENABLED` (replaces the never-usable `SOURCE_POLITO_API_ENABLED`), credentials `POLITO_USERNAME` / `POLITO_PASSWORD` in `.env`. Enabled without them: `E_NOT_CONFIGURED`, nothing is sent.
- **Mapping.** `orari.data.lezioni[]` -> `lecture` (title = course name, location = `place.name`, description = the lesson description if not empty). `appelli.data[]` -> `exam_call`, or `exam` when `status == "booked"` (the only value seen; the booked call also had a positive `idBooking`); location = `classrooms`; description = type, notes, and the booking window ("Booking opens/closes: <UTC>"). No separate "booking closes" events (35 calls would double the noise). `agenda.data[]`: an item with its own time range and place (`d_ini_turno_ts`) -> `booking`; a dated marker -> all-day event by `type`: `TASSE` -> `deadline`, `LEZIONI` -> `lecture`, `ESAMI` -> `exam_call`, anything else -> `deadline` (judgement: only these three types were seen). Not mapped on purpose: `virtualClassroom`/`recentVirtualClassroom` (online lesson links and recordings), `materialeRecente`, `career`, `anagrafica` and the app/bookmark lists.
- **Time.** Times with an offset or `Z` are used as is. **Times without a zone (exam calls) are read as wall-clock time in the configured `TZ`** (UNVERIFIED but consistent with the sample: the converted times are 08:30, 14:30 and similar). Spring gap and autumn overlap follow decision 009 (`src/util/zone.ts`).
- **Ids.** `lecture:<id>`, `exam:<id>`, `agenda:<id>`; the same id twice in one run is an issue (incomplete), not a silent overwrite. Course key: `polito:<course id>`; exam calls only carry a course shortcode, so it is looked up in the course list (`carico`) first. The course list also gives `polito:<id>` -> name, kept in memory for decision 013's `course-names`.
- **Fail closed** (as decision 015): `complete: true` only if the login worked, `success == true`, the sections `carico`, `orari`, `appelli`, `agenda` exist as lists, and every item in them was understood. A missing section, an unreadable time, an agenda item of an unknown shape or a duplicate id: that part is reported with `E_POLITO_API_UNEXPECTED_DATA` (positions and field names only), the rest is still written, nothing is deleted for this source. A failed login, an MFA step, a refused login, an outage: nothing is written for this source and nothing deleted. The source never throws, so it cannot stop the ICS source.
- **Lockout protection** as in 018: `E_POLITO_API_AUTH_REJECTED` writes the latch; no new login until `POLITO_USERNAME`/`POLITO_PASSWORD` change.
- **Traffic per sync:** one login (13 requests, 1.5 s apart) plus one data request. At the default 60 minutes that is about 14 requests an hour. Reusing the 90-day IdP cookie would cut it to the data request; deliberately not done yet.
- **Not covered:** seeing the raw formats (the probe's sanitizer used to rewrite dates to `...Z`, hiding the offset-or-not difference; fixed), so the zone-less reading is an inference; other accounts (different degree programmes, working students) may have other sections or types.

## First live dry run (owner, 2026-11-04, `pnpm sync --dry-run`)

Result: `polito complete 70 events` (sections: `carico` 8 items, `orari` 23 -> 23 events, `appelli` 35 -> 35, `agenda` 12 -> 12), **0 issues**, 86 creates in total with the 16 ICS events, 0 deletes. The login took about 20 s and had no MFA step. The booked exam call came out as kind `exam`, the others as `exam_call`; agenda markers came out as deadlines (tuition instalments, plan deadline), lesson/exam period markers, and one booking slot.

Observations to judge, not yet decided:

- **Exam calls are noisy:** 35 `exam_call` events for 8 courses (one course has about 8 calls). Candidate: a switch that keeps only booked exams (and maybe the next call per course). Not built.
- **Same-slot duplicates:** a few lectures of one course appear twice in the same slot with different ids (probably parallel groups or turns). They are what the portal returns; not filtered.
- **Time zone assumption:** zone-less exam times were read as Europe/Rome and display as 08:30, 11:00, 14:00 starts, which is plausible. Still to be confirmed by the owner against the portal.
- Moodle events keep kind `lecture` (decision 009), so the calendar mixes both.
