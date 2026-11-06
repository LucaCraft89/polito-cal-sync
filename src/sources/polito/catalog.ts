import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivateFile } from '../../util/files.js';

export interface CatalogCourse {
  /** The portal's course id (the key of the squad setting). */
  courseId: string;
  name: string;
  /** Every squad label seen in this course's lessons, sorted. */
  labels: string[];
}

export interface MoodleCatalogCourse {
  /** Moodle's course id (the key of the exclusion setting). */
  courseId: string;
  name: string;
}

export interface Catalog {
  updatedAt: string;
  courses: CatalogCourse[];
  /** The Moodle courses of the last Moodle read (all of them, also the excluded ones). */
  moodle?: { updatedAt: string; courses: MoodleCatalogCourse[] };
}

/**
 * The courses the portal listed in the last read, kept in DATA_DIR (0600) so the Courses page and the squad
 * picker work after a restart without another university login. Names and squad labels only: no lessons,
 * rooms or other event text. A read that returned no courses never overwrites it.
 */
export class CourseCatalog {
  private readonly path: string;
  constructor(dataDir: string) {
    this.path = join(dataDir, 'courses.json');
  }

  read(): Catalog | undefined {
    try {
      const v = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<Catalog>;
      if (typeof v.updatedAt !== 'string' || !Array.isArray(v.courses)) return undefined;
      const courses = v.courses.flatMap((c): CatalogCourse[] =>
        c && typeof c.courseId === 'string' && typeof c.name === 'string' && Array.isArray(c.labels)
          ? [
              {
                courseId: c.courseId,
                name: c.name,
                labels: c.labels.filter((l): l is string => typeof l === 'string'),
              },
            ]
          : [],
      );
      const m = v.moodle;
      const moodleCourses =
        m && Array.isArray(m.courses) && typeof m.updatedAt === 'string'
          ? m.courses.flatMap((c): MoodleCatalogCourse[] =>
              c && typeof c.courseId === 'string' && typeof c.name === 'string'
                ? [{ courseId: c.courseId, name: c.name }]
                : [],
            )
          : undefined;
      return {
        updatedAt: v.updatedAt,
        courses,
        ...(m && moodleCourses
          ? { moodle: { updatedAt: m.updatedAt, courses: moodleCourses } }
          : {}),
      };
    } catch {
      return undefined;
    }
  }

  /** Remembers the Moodle courses (merged into the same file; an empty read never overwrites). */
  writeMoodle(names: ReadonlyMap<string, string>, at: Date): void {
    const courses: MoodleCatalogCourse[] = [];
    for (const [key, name] of names) {
      if (key.startsWith('moodle:')) courses.push({ courseId: key.slice('moodle:'.length), name });
    }
    if (courses.length === 0) return;
    courses.sort((a, b) => a.name.localeCompare(b.name));
    const before = this.read();
    writePrivateFile(
      this.path,
      JSON.stringify({
        updatedAt: before?.updatedAt ?? at.toISOString(),
        courses: before?.courses ?? [],
        moodle: { updatedAt: at.toISOString(), courses },
      }),
    );
  }

  write(
    names: ReadonlyMap<string, string>,
    squadsSeen: ReadonlyMap<string, readonly string[]>,
    at: Date,
  ): void {
    const courses: CatalogCourse[] = [];
    for (const [key, name] of names) {
      const courseId = key.startsWith('polito:') ? key.slice('polito:'.length) : undefined;
      if (!courseId) continue;
      courses.push({ courseId, name, labels: [...(squadsSeen.get(courseId) ?? [])] });
    }
    if (courses.length === 0) return;
    courses.sort((a, b) => a.name.localeCompare(b.name));
    const before = this.read();
    writePrivateFile(
      this.path,
      JSON.stringify({
        updatedAt: at.toISOString(),
        courses,
        ...(before?.moodle ? { moodle: before.moodle } : {}),
      }),
    );
  }
}
