import { loadConfig } from '../config/index.js';
import type { SettingsStore } from '../settings/store.js';
import { HeartbeatStore } from '../serve/heartbeat.js';
import { CourseCatalog } from '../sources/polito/catalog.js';
import { LoginLatch } from '../sources/polito/portal/latch.js';
import { StateStore, type RunRow } from '../sync/state.js';
import { errorDoc } from '../util/error-docs.js';
import type { ProblemView } from './preview.js';

/** A problem known only by its code (what a run row stores): the generic text of docs/ERRORS.md. */
export function problemFromCode(code: string): ProblemView {
  const doc = errorDoc(code);
  return {
    code,
    what: doc?.what ?? `The run ended with the code ${code}.`,
    why: doc?.why ?? 'See the description of the code in docs/ERRORS.md.',
    action: doc?.action ?? 'Open docs/ERRORS.md and look the code up.',
    docs: `docs/ERRORS.md#${code.toLowerCase()}`,
  };
}

export interface RunView {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: RunRow['status'];
  /** The deletion limit was overridden by a typed confirmation or --force. */
  forced: boolean;
  created: number;
  patched: number;
  deleted: number;
  unchanged: number;
  /** Single events that could not be written. */
  failed: number;
  error?: ProblemView;
  /** How many single events failed with which code. */
  failures: { code: string; count: number }[];
  /** Sources that were incomplete in this run (nothing was deleted for them). */
  incompleteSources: string[];
}

export interface HistoryView {
  runs: RunView[];
  /** The scheduled loop's last known state (the file `serve` keeps), when it ever ran in this data folder. */
  loop?: {
    lastRunAt?: string;
    lastOkAt?: string;
    lastStatus?: string;
    nextRunAt?: string;
    stoppedAt?: string;
    error?: ProblemView;
  };
  /** The university login was refused and is paused until the credentials change (decision 018). */
  loginPaused?: { since: string };
}

function runView(r: RunRow): RunView {
  const d = (r.details && typeof r.details === 'object' ? r.details : {}) as {
    failures?: unknown;
    incompleteSources?: unknown;
  };
  const byCode = new Map<string, number>();
  if (Array.isArray(d.failures)) {
    for (const f of d.failures) {
      const code = f && typeof f === 'object' ? (f as { code?: unknown }).code : undefined;
      if (typeof code === 'string') byCode.set(code, (byCode.get(code) ?? 0) + 1);
    }
  }
  return {
    id: r.id,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    status: r.status,
    forced: r.forced,
    created: r.created,
    patched: r.patched,
    deleted: r.deleted,
    unchanged: r.unchanged,
    failed: r.failed,
    ...(r.errorCode ? { error: problemFromCode(r.errorCode) } : {}),
    failures: [...byCode].map(([code, count]) => ({ code, count })),
    incompleteSources: Array.isArray(d.incompleteSources)
      ? d.incompleteSources.filter((s): s is string => typeof s === 'string')
      : [],
  };
}

/** Counts and codes only: no event text, no addresses. Reads the history without changing it. */
export function historyView(
  dataDir: string,
  env: NodeJS.ProcessEnv,
  settings: SettingsStore,
  limit = 30,
): HistoryView {
  const config = loadConfig({ ...env, DATA_DIR: dataDir }, settings.read());
  const hb = new HeartbeatStore(dataDir).read();
  const { username, password } = config.polito;
  const since =
    config.polito.enabled && username && password
      ? new LoginLatch(dataDir).pausedSince(username, password)
      : undefined;
  return {
    runs: StateStore.recent(StateStore.fileIn(dataDir), limit).map(runView),
    ...(hb
      ? {
          loop: {
            ...(hb.lastRunAt ? { lastRunAt: hb.lastRunAt } : {}),
            ...(hb.lastOkAt ? { lastOkAt: hb.lastOkAt } : {}),
            ...(hb.lastStatus ? { lastStatus: hb.lastStatus } : {}),
            ...(hb.nextRunAt ? { nextRunAt: hb.nextRunAt } : {}),
            ...(hb.stoppedAt ? { stoppedAt: hb.stoppedAt } : {}),
            ...(hb.lastErrorCode ? { error: problemFromCode(hb.lastErrorCode) } : {}),
          },
        }
      : {}),
    ...(since !== undefined ? { loginPaused: { since } } : {}),
  };
}

/** "I fixed the credentials": ends the pause for the CURRENT credentials. Returns whether there was one. */
export function resumeLogin(
  dataDir: string,
  env: NodeJS.ProcessEnv,
  settings: SettingsStore,
): boolean {
  const { username, password } = loadConfig({ ...env, DATA_DIR: dataDir }, settings.read()).polito;
  if (!username || !password) return false;
  const latch = new LoginLatch(dataDir);
  if (latch.pausedSince(username, password) === undefined) return false;
  latch.clear();
  return true;
}

export interface CourseView {
  courseId: string;
  name: string;
  /** Squads seen in this course's lessons. */
  labels: string[];
  /** The squads chosen (empty = all are kept). */
  chosen: string[];
}

export interface MoodleCourseView {
  courseId: string;
  name: string;
  /** The events of this course are left out of the sync. */
  excluded: boolean;
}

export interface CoursesView {
  /** The Moodle courses of the last Moodle read, with whether each is left out. */
  moodleCourses?: MoodleCourseView[];
  /** When the portal was last read for this list; absent if it never was. */
  updatedAt?: string;
  courses: CourseView[];
}

export function coursesView(
  dataDir: string,
  env: NodeJS.ProcessEnv,
  settings: SettingsStore,
): CoursesView {
  const config = loadConfig({ ...env, DATA_DIR: dataDir }, settings.read());
  const catalog = new CourseCatalog(dataDir).read();
  if (!catalog) return { courses: [] };
  const left = new Set(config.moodle.excludedCourses);
  return {
    updatedAt: catalog.updatedAt,
    ...(catalog.moodle
      ? {
          moodleCourses: catalog.moodle.courses.map((c) => ({
            courseId: c.courseId,
            name: c.name,
            excluded: left.has(c.courseId),
          })),
        }
      : {}),
    courses: catalog.courses.map((c) => ({
      courseId: c.courseId,
      name: c.name,
      labels: c.labels,
      chosen: [...(config.polito.squads[c.courseId] ?? [])],
    })),
  };
}
