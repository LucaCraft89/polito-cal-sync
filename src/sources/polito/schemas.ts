import { z } from 'zod';
import { isValidDateOnly, isValidDateTime } from '../types.js';
import { FIELDS } from './fields.js';

/**
 * zod descriptions of the answers, built from the evidence table in fields.ts (all UNVERIFIED).
 * Objects are loose: unknown extra fields are ignored. A MISSING or malformed required field makes
 * the item fail, and a failed item makes the run incomplete (nothing is deleted).
 * Required = identity, title, times. Decorations (location, course) never make an item fail.
 */

const idValue = z
  .union([z.string().min(1), z.number().int().nonnegative()])
  .transform((v) => String(v));
const text = z.string().trim().min(1);
const utcDateTime = z
  .string()
  .refine(isValidDateTime, 'must be an ISO-8601 date-time with Z or offset');
const plainDate = z.string().refine(isValidDateOnly, 'must be a YYYY-MM-DD date');

/** Builds an object schema from a field-name map, so a corrected name changes one line. */
function pick<T extends z.ZodType>(name: string, schema: T): { name: string; schema: T } {
  return { name, schema };
}

function shape(entries: Record<string, { name: string; schema: z.ZodType }>) {
  return z.looseObject(Object.fromEntries(Object.values(entries).map((e) => [e.name, e.schema])));
}

const F = FIELDS;

export const lectureSchema = shape({
  id: pick(F.lecture.id, idValue),
  title: pick(F.lecture.title, text),
  start: pick(F.lecture.start, utcDateTime),
  end: pick(F.lecture.end, utcDateTime.optional()),
  course: pick(F.lecture.course, idValue.nullish()),
  location: pick(F.lecture.location, z.unknown()),
});

export const examSchema = shape({
  id: pick(F.exam.id, idValue),
  title: pick(F.exam.title, text),
  start: pick(F.exam.start, utcDateTime),
  end: pick(F.exam.end, utcDateTime.nullish()),
  bookingCloses: pick(F.exam.bookingCloses, utcDateTime.nullish()),
  bookingOpens: pick(F.exam.bookingOpens, utcDateTime.nullish()),
  status: pick(F.exam.status, z.string().nullish()),
  course: pick(F.exam.course, idValue.nullish()),
  location: pick(F.exam.location, z.unknown()),
});

export const bookingSchema = shape({
  id: pick(F.booking.id, idValue),
  title: pick(F.booking.title, text),
  start: pick(F.booking.start, utcDateTime),
  end: pick(F.booking.end, utcDateTime.nullish()),
  location: pick(F.booking.location, z.unknown()),
});

export const deadlineSchema = shape({
  id: pick(F.deadline.id, idValue.nullish()),
  title: pick(F.deadline.title, text),
  date: pick(F.deadline.date, plainDate),
  course: pick(F.deadline.course, idValue.nullish()),
});

export const assignmentSchema = shape({
  id: pick(F.assignment.id, idValue.nullish()),
  title: pick(F.assignment.title, text),
  uploadedAt: pick(F.assignment.uploadedAt, utcDateTime),
});

export const courseSchema = shape({
  id: pick(F.course.id, idValue),
  name: pick(F.course.name, text.nullish()),
});

/**
 * A list answer. Either a bare array or `{ data: [...] }` (GUESS: wrapping is unknown). Any other
 * shape is rejected as a whole, which makes the endpoint fail closed.
 */
export function listItems(body: unknown): unknown[] | undefined {
  if (Array.isArray(body)) return body as unknown[];
  if (body && typeof body === 'object') {
    const data = (body as Record<string, unknown>)['data'];
    if (Array.isArray(data)) return data as unknown[];
  }
  return undefined;
}

export type Lecture = z.infer<typeof lectureSchema>;
export type Exam = z.infer<typeof examSchema>;
export type Booking = z.infer<typeof bookingSchema>;
export type Deadline = z.infer<typeof deadlineSchema>;
export type Assignment = z.infer<typeof assignmentSchema>;
export type Course = z.infer<typeof courseSchema>;
