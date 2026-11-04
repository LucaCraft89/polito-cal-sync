/**
 * EVIDENCE TABLE for the Polito API source. Read this before trusting anything in this folder.
 *
 * Nothing here was seen in live traffic. The only evidence is the public API description
 * (`polito/api-spec`, read as documentation, never vendored), summarised in AGENTS.md and
 * docs/RESEARCH.md. Every name is tagged:
 *
 *   SPEC   named in that summary (still UNVERIFIED against the real server)
 *   GUESS  not in the summary; chosen by analogy so that the mapper can be written and tested.
 *          WRONG GUESSES FAIL CLOSED: the item is not mapped, the run is marked incomplete and
 *          nothing is deleted (see PolitoApiSource). They are corrected, in this one file, from the
 *          owner's sanitized probe samples (docs/M3-RUNBOOK.md).
 *
 * The fixtures in test/fixtures/polito/ are INVENTED from this table. They prove the mapping and
 * the fail-closed behaviour, not that the table is right.
 */
export const ENDPOINTS = {
  /** SPEC: GET /lectures?fromDate&toDate&courseIds[] - plain dates. Response fields: all GUESS. */
  lectures: '/lectures',
  /** SPEC: GET /exams - each entry is an exam "call"; there is no separate model. */
  exams: '/exams',
  /** SPEC: GET /bookings */
  bookings: '/bookings',
  /** SPEC: GET /deadlines?fromDate&toDate - plain dates. */
  deadlines: '/deadlines',
  /** SPEC: GET /v2/courses */
  courses: '/v2/courses',
  /** SPEC: GET /courses/{id}/assignments - only `uploadedAt`, no due date. */
  assignments: (courseId: string) => `/courses/${encodeURIComponent(courseId)}/assignments`,
} as const;

export const FIELDS = {
  lecture: {
    id: 'id', // GUESS
    title: 'title', // GUESS
    start: 'startsAt', // GUESS (by analogy with bookings, exams)
    end: 'endsAt', // GUESS
    course: 'courseId', // GUESS
    location: 'location', // GUESS
  },
  exam: {
    id: 'id', // GUESS
    title: 'courseName', // GUESS
    start: 'examStartsAt', // SPEC (UTC)
    end: 'examEndsAt', // SPEC (UTC)
    bookingOpens: 'bookingStartsAt', // SPEC (UTC)
    bookingCloses: 'bookingEndsAt', // SPEC (UTC)
    status: 'status', // SPEC name, enum values unknown
    course: 'courseId', // GUESS
    location: 'places', // SPEC name, shape unknown
  },
  booking: {
    id: 'id', // GUESS
    title: 'title', // GUESS
    start: 'startsAt', // SPEC (UTC)
    end: 'endsAt', // SPEC (UTC)
    location: 'location', // SPEC name: a place or a virtual place; shape unknown
  },
  deadline: {
    id: 'id', // GUESS (optional: a stable id is derived when absent)
    title: 'title', // GUESS
    date: 'date', // SPEC: a plain date; field name GUESS
    course: 'courseId', // GUESS
  },
  assignment: {
    id: 'id', // GUESS (optional: derived when absent)
    title: 'title', // GUESS
    uploadedAt: 'uploadedAt', // SPEC
  },
  course: {
    id: 'id', // GUESS
    name: 'name', // GUESS
  },
} as const;

/**
 * Exam status values that mean "the student booked this call" and so make it kind `exam` instead of
 * `exam_call`. EMPTY on purpose: the enum values are unknown until the probe shows them.
 */
export const EXAM_BOOKED_STATUSES: readonly string[] = [];
