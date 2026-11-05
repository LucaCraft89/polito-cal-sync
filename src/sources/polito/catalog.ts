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

export interface Catalog {
  updatedAt: string;
  courses: CatalogCourse[];
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
      return { updatedAt: v.updatedAt, courses };
    } catch {
      return undefined;
    }
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
    writePrivateFile(this.path, JSON.stringify({ updatedAt: at.toISOString(), courses }));
  }
}
