import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import { CalendarChoice } from '../google/calendars.js';
import { loadConfig } from '../config/index.js';
import type { SettingsStore } from '../settings/store.js';
import type { CanonicalEvent } from '../sources/types.js';
import { runConfiguredSync, type RunOutput, type RuntimeDeps } from '../sync/run.js';
import { UserError } from '../util/errors.js';
import { redactSecrets } from '../util/secret-patterns.js';

/** A preview contacts Polito and Google: at most one per this long, like the `serve` interval minimum. */
export const PREVIEW_MIN_INTERVAL_MS = 15 * 60_000;

export interface EventView {
  title: string;
  kind: string;
  start: string;
  end?: string;
  allDay: boolean;
  location?: string;
  /** Course name when known, else nothing (the opaque key is not shown). */
  course?: string;
}

export interface ProblemView {
  source?: string;
  code: string;
  what: string;
  why: string;
  action: string;
  docs: string;
}

export interface SquadChoice {
  courseId: string;
  /** Course name when the portal gave one. */
  name?: string;
  /** Every squad seen in this course's lessons. */
  labels: string[];
  /** The squads currently chosen (empty = all are kept). */
  chosen: string[];
}

export interface PreviewView {
  generatedAt: string;
  /** True when every source came back complete (nothing is held back from deletion). */
  complete: boolean;
  counts: { creates: number; patches: number; deletes: number; unchanged: number };
  safety: {
    deletes: number;
    managedInScope: number;
    ratio: number;
    threshold: number;
    exceeded: boolean;
  };
  incompleteSources: string[];
  notes: string[];
  problems: ProblemView[];
  /** Courses that have squads, for the picker on the Sources page. */
  squads: SquadChoice[];
  creates: EventView[];
  patches: EventView[];
  deletes: EventView[];
}

const clean = (s: string): string => redactSecrets(s);

export function problem(e: UserError, source?: string): ProblemView {
  return {
    ...(source ? { source } : {}),
    code: e.code,
    what: clean(e.what),
    why: clean(e.why),
    action: clean(e.action),
    docs: e.docsAnchor,
  };
}

/** Feed and source problems of a run, in the three-line form (no addresses, no event text). */
export function problemsOf(out: RunOutput): ProblemView[] {
  return [
    ...out.feeds.flatMap((f) => (f.error ? [problem(f.error, f.label)] : [])),
    ...out.sourceErrors.map((s) => problem(s.error, s.source)),
  ];
}

/**
 * Identifies what a preview was made from: every saved setting that changes what a sync does (not the
 * interval) and the chosen calendar. Only a hash is kept. A changed stamp makes the preview stale.
 */
export function settingsStamp(dataDir: string, settings: SettingsStore): string {
  const relevant = Object.entries(settings.read()).filter(([k]) => k !== 'syncIntervalMinutes');
  return createHash('sha256')
    .update(JSON.stringify([relevant, new CalendarChoice(dataDir).read() ?? null]))
    .digest('hex');
}

/** Plain, JSON-safe view of a dry run. Event text is untrusted; the browser shows it as text only. */
export function toPreview(
  out: RunOutput,
  at: Date,
  chosenSquads: Readonly<Record<string, readonly string[]>> = {},
): PreviewView {
  const { plan } = out.report;
  const view = (e: CanonicalEvent): EventView => {
    const name = e.course ? out.courseNames.get(e.course) : undefined;
    return {
      title: e.title,
      kind: e.kind,
      start: e.start,
      ...(e.end && e.end !== e.start ? { end: e.end } : {}),
      allDay: e.allDay,
      ...(e.location ? { location: e.location } : {}),
      ...(name ? { course: name } : {}),
    };
  };
  const problems = problemsOf(out);
  return {
    generatedAt: at.toISOString(),
    complete: plan.incompleteSources.length === 0,
    counts: {
      creates: plan.creates.length,
      patches: plan.patches.length,
      deletes: plan.deletes.length,
      unchanged: plan.unchanged,
    },
    safety: {
      deletes: plan.safety.deletes,
      managedInScope: plan.safety.managedInScope,
      ratio: plan.safety.ratio,
      threshold: plan.safety.threshold,
      exceeded: plan.safety.exceeded,
    },
    incompleteSources: plan.incompleteSources,
    notes: [
      ...out.sourceNotes.map(clean),
      ...(out.moves && out.moves.toMoodle + out.moves.toPolito > 0
        ? [
            `${out.moves.toMoodle} event(s) will move to the Moodle calendar and ${out.moves.toPolito} back to the Polito calendar: the new copy is created first, the old one is deleted after, and moves do not count toward the deletion limit.`,
          ]
        : []),
    ],
    problems,
    squads: [...out.squadsSeen].map(([courseId, labels]) => {
      const name = out.courseNames.get(`polito:${courseId}`);
      return {
        courseId,
        ...(name ? { name } : {}),
        labels: [...labels],
        chosen: [...(chosenSquads[courseId] ?? [])],
      };
    }),
    creates: plan.creates.map((c) => view(c.event)),
    patches: plan.patches.map((c) => view(c.event)),
    deletes: plan.deletes.map((d) => ({
      title: d.remote.summary ?? 'Untitled event',
      kind: d.remote.kind ?? 'lecture',
      start: d.remote.start ?? '',
      allDay: false,
    })),
  };
}

export interface PreviewOptions {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  settings: SettingsStore;
  logger: Logger;
  /** Test hooks (fake Google, fake portal, clock). */
  deps?: RuntimeDeps;
  now: () => number;
  minIntervalMs?: number;
  /** Called when the preview or its state changed (the live updates). */
  onChange?: () => void;
}

/**
 * Preview = a dry run: it reads the sources and the calendar and writes NOTHING (no event, no history row,
 * no lock). Rules of docs/UI.md section 4: single flight in this process, and not more often than the
 * minimum interval, counted from the START of the last attempt (a failed attempt costs traffic too).
 * Only the last result is kept, in memory.
 */
export class PreviewService {
  private running = false;
  private lastStartedAt: number | undefined;
  private last: PreviewView | undefined;
  private lastStamp: string | undefined;

  constructor(private readonly o: PreviewOptions) {}

  get latest(): { preview: PreviewView | null; nextAllowedAt: string | null } {
    return { preview: this.last ?? null, nextAllowedAt: this.nextAllowed() };
  }

  /** The last preview with the stamp of the settings it was made from (for Sync now). */
  get current(): { view: PreviewView; stamp: string } | undefined {
    return this.last && this.lastStamp !== undefined
      ? { view: this.last, stamp: this.lastStamp }
      : undefined;
  }

  /** After a real sync the preview no longer describes the calendar: a new one is needed. */
  invalidate(): void {
    this.last = undefined;
    this.lastStamp = undefined;
    this.o.onChange?.();
  }

  private nextAllowed(): string | null {
    if (this.lastStartedAt === undefined) return null;
    const at = this.lastStartedAt + (this.o.minIntervalMs ?? PREVIEW_MIN_INTERVAL_MS);
    return at > this.o.now() ? new Date(at).toISOString() : null;
  }

  async run(): Promise<{ preview: PreviewView; nextAllowedAt: string | null }> {
    if (this.running) {
      throw new UserError({
        code: 'E_UI_PREVIEW_BUSY',
        what: 'A preview is already running.',
        why: 'Only one preview runs at a time, so the university and Google are not asked twice at once.',
        action: 'Wait for it to finish; the result appears on this page.',
      });
    }
    const wait = this.nextAllowed();
    if (wait !== null) {
      const minutes = Math.max(1, Math.ceil((Date.parse(wait) - this.o.now()) / 60_000));
      throw new UserError({
        code: 'E_UI_PREVIEW_RATE_LIMITED',
        what: `The last preview was less than ${Math.round((this.o.minIntervalMs ?? PREVIEW_MIN_INTERVAL_MS) / 60_000)} minutes ago, so no new one was started.`,
        why: 'A preview logs in to the university and reads your calendar. Limiting how often protects your account and your Google quota.',
        action: `Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}. The last result is still shown on this page.`,
      });
    }
    this.running = true;
    this.lastStartedAt = this.o.now();
    // Taken BEFORE the run: a setting saved while it runs makes this preview stale, never fresh.
    const stamp = settingsStamp(this.o.dataDir, this.o.settings);
    try {
      const config = loadConfig(
        { ...this.o.env, DATA_DIR: this.o.dataDir },
        this.o.settings.read(),
      );
      const out = await runConfiguredSync(
        { config, logger: this.o.logger, ...(this.o.deps ? { deps: this.o.deps } : {}) },
        { dryRun: true, force: false },
      );
      this.last = toPreview(out, new Date(this.o.now()), config.polito.squads);
      this.lastStamp = stamp;
      this.o.logger.info(
        {
          creates: this.last.counts.creates,
          patches: this.last.counts.patches,
          deletes: this.last.counts.deletes,
        },
        'ui preview done',
      );
      return { preview: this.last, nextAllowedAt: this.nextAllowed() };
    } finally {
      this.running = false;
      this.o.onChange?.();
    }
  }
}
