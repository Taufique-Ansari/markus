import { describe, it, expect } from 'vitest';
import {
  buildCron,
  parseSimpleCron,
  draftFromScheduleConfig,
  draftToScheduleConfig,
  defaultScheduleDraft,
  intervalLabelKey,
  normalizeTime,
  parseTime,
  INTERVAL_OPTIONS,
} from '../src/lib/taskSchedule.ts';

describe('taskSchedule helpers', () => {
  it('builds cron for daily / weekdays / weekly', () => {
    expect(buildCron('daily', [], '09:00')).toBe('0 9 * * *');
    expect(buildCron('weekdays', [], '09:00')).toBe('0 9 * * 1-5');
    expect(buildCron('weekly', [5, 1], '18:30')).toBe('30 18 * * 1,5');
    // weekly with no days selected falls back to every day (never a broken cron)
    expect(buildCron('weekly', [], '09:00')).toBe('0 9 * * *');
    // raw-cron mode builds nothing
    expect(buildCron('cron', [], '09:00')).toBe('');
  });

  it('round-trips the cron shapes we generate', () => {
    expect(parseSimpleCron('0 9 * * *')).toEqual({ calendar: 'daily', weekdays: [1, 2, 3, 4, 5], time: '09:00' });
    expect(parseSimpleCron('0 9 * * 1-5')).toEqual({ calendar: 'weekdays', weekdays: [1, 2, 3, 4, 5], time: '09:00' });
    expect(parseSimpleCron('30 18 * * 1,5')).toEqual({ calendar: 'weekly', weekdays: [1, 5], time: '18:30' });
    // anything we can't confidently rebuild stays raw
    expect(parseSimpleCron('*/5 * * * *')).toBeNull();
    expect(parseSimpleCron('0 9 1 * *')).toBeNull();
  });

  it('normalises times and clamps out-of-range values', () => {
    expect(parseTime('9:05')).toEqual([9, 5]);
    expect(parseTime('')).toEqual([9, 0]);
    // inputs from <input type="time"> are always zero-padded
    expect(normalizeTime('9:05')).toBe('09:05');
  });

  it('maps interval shorthands to their i18n keys', () => {
    expect(intervalLabelKey('4h')).toBe('freq4h');
    expect(intervalLabelKey('1w')).toBe('freq1w');
    // unknown / empty falls back rather than emitting a dangling key
    expect(intervalLabelKey('nope')).toBe('freq4h');
    // every option maps to a distinct, defined key
    INTERVAL_OPTIONS.forEach(v => expect(typeof intervalLabelKey(v)).toBe('string'));
  });

  it('converts draft → payload for each mode', () => {
    const interval = { ...defaultScheduleDraft(), mode: 'interval' as const, every: '2h' };
    expect(draftToScheduleConfig(interval)).toEqual({ every: '2h' });

    const daily = { ...defaultScheduleDraft(), mode: 'calendar' as const, calendar: 'daily' as const, time: '09:00' };
    expect(draftToScheduleConfig(daily)).toEqual({ cron: '0 9 * * *', timezone: daily.timezone });

    const weekly = {
      ...defaultScheduleDraft(),
      mode: 'calendar' as const,
      calendar: 'weekly' as const,
      weekdays: [1, 3],
      time: '07:15',
      maxRuns: '10',
    };
    expect(draftToScheduleConfig(weekly)).toEqual({
      cron: '15 7 * * 1,3',
      timezone: weekly.timezone,
      maxRuns: 10,
    });

    const rawCron = { ...defaultScheduleDraft(), mode: 'calendar' as const, calendar: 'cron' as const, cron: '*/5 * * * *' };
    expect(draftToScheduleConfig(rawCron)).toEqual({ cron: '*/5 * * * *', timezone: rawCron.timezone });
  });

  it('hydrates the editor from a stored config', () => {
    const fromInterval = draftFromScheduleConfig({ every: '8h', maxRuns: 3 });
    expect(fromInterval.mode).toBe('interval');
    expect(fromInterval.every).toBe('8h');
    expect(fromInterval.maxRuns).toBe('3');

    const fromWeekdays = draftFromScheduleConfig({ cron: '0 9 * * 1-5', timezone: 'Asia/Shanghai' });
    expect(fromWeekdays.mode).toBe('calendar');
    expect(fromWeekdays.calendar).toBe('weekdays');
    expect(fromWeekdays.time).toBe('09:00');
    expect(fromWeekdays.timezone).toBe('Asia/Shanghai');

    const fromComplex = draftFromScheduleConfig({ cron: '*/5 * * * *' });
    expect(fromComplex.calendar).toBe('cron');
    expect(fromComplex.cron).toBe('*/5 * * * *');

    // no config → sensible default
    expect(draftFromScheduleConfig(undefined).mode).toBe('calendar');
  });

  it('omits maxRuns when blank or invalid', () => {
    const blank = draftToScheduleConfig({ ...defaultScheduleDraft(), maxRuns: '' });
    expect(blank.maxRuns).toBeUndefined();
    const zero = draftToScheduleConfig({ ...defaultScheduleDraft(), maxRuns: '0' });
    expect(zero.maxRuns).toBeUndefined();
  });
});
