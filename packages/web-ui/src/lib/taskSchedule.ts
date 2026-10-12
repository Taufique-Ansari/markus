/**
 * Single source of truth for the task-schedule editor.
 *
 * The UI must never force a human to type a cron expression just to say
 * "every weekday at 9am". This module converts between the friendly
 * `ScheduleDraft` that the UI edits and the backend `ScheduleConfig` payload,
 * and it is the ONLY place that builds cron strings — so the create-task
 * dialog and the task-detail editor can never drift apart.
 */

export type ScheduleMode = 'interval' | 'calendar';
export type CalendarRepeat = 'daily' | 'weekdays' | 'weekly' | 'cron';

export interface ScheduleDraft {
  /** Which top-level trigger the user picked. */
  mode: ScheduleMode;
  /** Interval shorthand, e.g. "4h" (used when mode === 'interval'). */
  every: string;
  /** Calendar repetition (used when mode === 'calendar'). */
  calendar: CalendarRepeat;
  /** Weekdays, 0 = Sunday … 6 = Saturday (used when calendar === 'weekly'). */
  weekdays: number[];
  /** "HH:MM" 24h local time (used when calendar !== 'cron'). */
  time: string;
  /** Raw cron expression (used when calendar === 'cron'). */
  cron: string;
  /** Max runs as a free-text field; '' means unlimited. */
  maxRuns: string;
  /** IANA timezone the schedule is anchored to. */
  timezone: string;
}

export interface ScheduleConfigPayload {
  every?: string;
  cron?: string;
  maxRuns?: number;
  timezone?: string;
}

export const INTERVAL_OPTIONS = ['30m', '1h', '2h', '4h', '8h', '12h', '1d', '1w'] as const;

const INTERVAL_LABEL_KEYS: Record<string, string> = {
  '30m': 'freq30m',
  '1h': 'freq1h',
  '2h': 'freq2h',
  '4h': 'freq4h',
  '8h': 'freq8h',
  '12h': 'freq12h',
  '1d': 'freq1d',
  '1w': 'freq1w',
};

/** i18n key (under the `work:task.` namespace) for an interval shorthand. */
export function intervalLabelKey(every: string): string {
  return INTERVAL_LABEL_KEYS[every] ?? 'freq4h';
}

/** Best-effort IANA timezone for the current user. */
export function resolveLocalTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function defaultScheduleDraft(): ScheduleDraft {
  return {
    // Calendar (按时间表) is the friendlier default: "every weekday at 9am" is far
    // more common than a bare interval, and it foregrounds the time picker.
    mode: 'calendar',
    every: '4h',
    calendar: 'daily',
    weekdays: [1, 2, 3, 4, 5],
    time: '09:00',
    cron: '',
    maxRuns: '',
    timezone: resolveLocalTimezone(),
  };
}

/** Parse "HH:MM" into [hours, minutes], clamped to valid ranges. */
export function parseTime(time: string): [number, number] {
  const match = /^(\d{1,2}):(\d{2})$/.exec((time ?? '').trim());
  if (!match) return [9, 0];
  const h = Math.min(23, Math.max(0, parseInt(match[1]!, 10)));
  const m = Math.min(59, Math.max(0, parseInt(match[2]!, 10)));
  return [h, m];
}

/** Normalise "H:M" → "HH:MM". */
export function normalizeTime(time: string): string {
  const [h, m] = parseTime(time);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Build a cron expression from the friendly calendar fields.
 * Returns '' when the user chose the raw-cron mode (nothing to build).
 */
export function buildCron(calendar: CalendarRepeat, weekdays: number[], time: string): string {
  if (calendar === 'cron') return '';
  const [h, m] = parseTime(time);
  const dayField =
    calendar === 'daily'
      ? '*'
      : calendar === 'weekdays'
        ? '1-5'
        : weekdays.length > 0
          ? [...weekdays].sort((a, b) => a - b).join(',')
          : '*';
  return `${m} ${h} * * ${dayField}`;
}

/**
 * Reverse-parse the common cron shapes we generate, so re-opening the editor
 * shows the friendly fields the user originally chose instead of a raw string.
 * Returns null for anything we can't confidently round-trip.
 */
export function parseSimpleCron(
  cron: string,
): { calendar: CalendarRepeat; weekdays: number[]; time: string } | null {
  const match = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\S+)$/.exec((cron ?? '').trim());
  if (!match) return null;
  const minute = parseInt(match[1]!, 10);
  const hour = parseInt(match[2]!, 10);
  if (minute > 59 || hour > 23) return null;
  const day = match[3]!;
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  if (day === '*') return { calendar: 'daily', weekdays: [1, 2, 3, 4, 5], time };
  if (day === '1-5') return { calendar: 'weekdays', weekdays: [1, 2, 3, 4, 5], time };
  if (/^\d(,\d)*$/.test(day)) {
    const days = day
      .split(',')
      .map(d => parseInt(d, 10))
      .filter(d => d >= 0 && d <= 6);
    if (days.length > 0) return { calendar: 'weekly', weekdays: days, time };
  }
  return null;
}

/** Hydrate the editor from a stored schedule config. */
export function draftFromScheduleConfig(config?: {
  every?: string;
  cron?: string;
  maxRuns?: number;
  timezone?: string;
}): ScheduleDraft {
  const draft = defaultScheduleDraft();
  if (!config) return draft;
  if (config.timezone) draft.timezone = config.timezone;
  draft.maxRuns = config.maxRuns && config.maxRuns > 0 ? String(config.maxRuns) : '';
  if (config.cron) {
    const parsed = parseSimpleCron(config.cron);
    draft.mode = 'calendar';
    if (parsed) {
      draft.calendar = parsed.calendar;
      draft.weekdays = parsed.weekdays;
      draft.time = parsed.time;
    } else {
      draft.calendar = 'cron';
      draft.cron = config.cron;
    }
  } else if (config.every) {
    draft.mode = 'interval';
    draft.every = config.every;
  }
  return draft;
}

/** Convert the editor state into the backend payload (one of every|cron). */
export function draftToScheduleConfig(draft: ScheduleDraft): ScheduleConfigPayload {
  const config: ScheduleConfigPayload = {};
  if (draft.mode === 'interval') {
    config.every = draft.every || '4h';
  } else {
    config.cron =
      draft.calendar === 'cron' ? draft.cron.trim() : buildCron(draft.calendar, draft.weekdays, draft.time);
    // A cron expression's meaning depends on the timezone it is anchored to —
    // for BOTH the friendly builder and a raw expression — so always send it.
    if (draft.timezone) config.timezone = draft.timezone;
  }
  const maxRuns = parseInt(draft.maxRuns, 10);
  if (draft.maxRuns.trim() !== '' && Number.isFinite(maxRuns) && maxRuns > 0) {
    config.maxRuns = maxRuns;
  }
  return config;
}
