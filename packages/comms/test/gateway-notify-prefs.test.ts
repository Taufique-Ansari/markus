/**
 * Notification-preference enforcement — the model + the one decision (R6).
 *
 * The dispatcher-level behaviour is covered in gateway-dispatcher.test.ts; this
 * file pins the pure decision function and the production read side
 * (`RepoNotifyPreferenceSource`), whose precedence must match Settings.
 */
import { describe, it, expect } from 'vitest';
import {
  suppressionReasonFor,
  parseNotifyPriority,
  normalizePriority,
  RepoNotifyPreferenceSource,
} from '../src/gateway/notify-prefs.js';
import type { NotifyTarget } from '../src/gateway/notify-route.js';
import type { InstanceRowLike, InstanceSource } from '../src/gateway/notify-lookup.js';
import type { OutboundPriority } from '../src/gateway/outbound.js';
import type { PlatformField } from '../src/platforms/registry.js';

const approval = { severity: 'action_required' as const };
const event = (priority?: OutboundPriority) => ({ severity: 'info' as const, priority });

describe('suppressionReasonFor — the one decision', () => {
  it('forwards everything when no preferences are known', () => {
    expect(suppressionReasonFor(approval, undefined)).toBeUndefined();
    expect(suppressionReasonFor(event('low'), undefined)).toBeUndefined();
  });

  it('lets the master switch suppress everything, overruling the category knobs', () => {
    // Off beats an "approvals on" knob and an "events on + priority" knob alike —
    // the master is checked first so it cannot be argued with.
    expect(
      suppressionReasonFor(approval, { notifyEnabled: false, notifyOnApproval: true }),
    ).toBe('notify-disabled');
    expect(
      suppressionReasonFor(event('urgent'), {
        notifyEnabled: false,
        notifyOnNotification: true,
        notifyPriority: ['urgent'],
      }),
    ).toBe('notify-disabled');
    // On — or absent — leaves the category knobs in charge, so an install that
    // never touched the switch forwards exactly as it did before it existed.
    expect(suppressionReasonFor(approval, { notifyEnabled: true })).toBeUndefined();
    expect(
      suppressionReasonFor(event('high'), { notifyEnabled: true, notifyOnNotification: true }),
    ).toBeUndefined();
    expect(suppressionReasonFor(event(undefined), undefined)).toBeUndefined();
  });

  it('gates approvals on notifyOnApproval (default on)', () => {
    expect(suppressionReasonFor(approval, {})).toBeUndefined();
    expect(suppressionReasonFor(approval, { notifyOnApproval: true })).toBeUndefined();
    expect(suppressionReasonFor(approval, { notifyOnApproval: false })).toBe('notify-off-approval');
  });

  it('gates events on notifyOnNotification (default off)', () => {
    expect(suppressionReasonFor(event('high'), {})).toBe('notify-off-notification');
    expect(suppressionReasonFor(event('high'), { notifyOnNotification: false })).toBe('notify-off-notification');
    expect(suppressionReasonFor(event('high'), { notifyOnNotification: true })).toBeUndefined();
  });

  it('narrows events by notifyPriority, accepting an array or the coerced comma string', () => {
    const asArray = { notifyOnNotification: true, notifyPriority: ['high', 'urgent'] };
    expect(suppressionReasonFor(event('urgent'), asArray)).toBeUndefined();
    expect(suppressionReasonFor(event('low'), asArray)).toBe('priority-filtered');

    const asCsv = { notifyOnNotification: true, notifyPriority: 'high,urgent,normal' };
    expect(suppressionReasonFor(event('normal'), asCsv)).toBeUndefined();
    expect(suppressionReasonFor(event('medium'), asCsv)).toBe('priority-filtered');
  });

  it('does not drop an event that carries no priority', () => {
    expect(suppressionReasonFor(event(undefined), { notifyOnNotification: true, notifyPriority: ['high'] })).toBeUndefined();
  });

  it('never applies the priority filter to approvals', () => {
    expect(
      suppressionReasonFor(
        { severity: 'action_required', priority: 'low' },
        { notifyOnApproval: true, notifyPriority: ['high', 'urgent'] },
      ),
    ).toBeUndefined();
  });
});

describe('normalizePriority / parseNotifyPriority', () => {
  it('maps critical→urgent and rejects unknown tokens', () => {
    expect(normalizePriority('URGENT')).toBe('urgent');
    expect(normalizePriority('critical')).toBe('urgent');
    expect(normalizePriority('bogus')).toBeUndefined();
    expect(normalizePriority(3)).toBeUndefined();
  });

  it('parses both persisted shapes', () => {
    expect([...parseNotifyPriority('urgent,bogus,high')].sort()).toEqual(['high', 'urgent']);
    expect([...parseNotifyPriority(['high', 'high'])].sort()).toEqual(['high']);
    expect(parseNotifyPriority(null).size).toBe(0);
  });
});

describe('RepoNotifyPreferenceSource — same instance config as the destination', () => {
  const target: NotifyTarget = { platform: 'feishu', instanceId: 'bi_1', nativeId: 'oc_1' };
  const feishuFields: PlatformField[] = [
    { key: 'notifyOnApproval', label: 'a', type: 'boolean', required: false, default: true },
    { key: 'notifyOnNotification', label: 'n', type: 'boolean', required: false, default: false },
    { key: 'notifyPriority', label: 'p', type: 'select', required: false, multiple: true, default: ['high', 'urgent'] },
  ];
  const repoOf = (rows: InstanceRowLike[]): InstanceSource => ({
    findById: (id) => rows.find((r) => r.id === id),
  });

  it('reads the instance config, falling back to manifest defaults for absent keys', () => {
    const src = new RepoNotifyPreferenceSource({
      instanceRepo: repoOf([{ id: 'bi_1', platform: 'feishu', config: { notifyOnApproval: false } }]),
      fieldDefs: () => feishuFields,
    });
    expect(src.preferencesFor(target)).toEqual({
      notifyOnApproval: false,
      notifyOnNotification: false, // manifest default
      notifyPriority: ['high', 'urgent'], // manifest default
    });
  });

  it('lets persisted values win, including the coerced comma string', () => {
    const src = new RepoNotifyPreferenceSource({
      instanceRepo: repoOf([
        {
          id: 'bi_1',
          platform: 'feishu',
          config: { notifyOnApproval: true, notifyOnNotification: true, notifyPriority: 'high,urgent,normal' },
        },
      ]),
      fieldDefs: () => feishuFields,
    });
    const prefs = src.preferencesFor(target);
    expect(prefs?.notifyPriority).toBe('high,urgent,normal');
    // …and the decision honors the coerced string end-to-end.
    expect(suppressionReasonFor({ severity: 'info', priority: 'normal' }, prefs)).toBeUndefined();
    expect(suppressionReasonFor({ severity: 'info', priority: 'low' }, prefs)).toBe('priority-filtered');
  });

  it('returns undefined when the instance is unknown — never a suppress on missing data', () => {
    const src = new RepoNotifyPreferenceSource({ instanceRepo: repoOf([]), fieldDefs: () => feishuFields });
    expect(src.preferencesFor(target)).toBeUndefined();
    expect(src.preferencesFor({ platform: 'feishu', nativeId: 'x' })).toBeUndefined();
  });

  it('reads the master switch from the same config, and it decides end-to-end', () => {
    const withMaster: PlatformField[] = [
      { key: 'notifyEnabled', label: 'e', type: 'boolean', required: false, default: true },
      ...feishuFields,
    ];
    const off = new RepoNotifyPreferenceSource({
      instanceRepo: repoOf([
        { id: 'bi_1', platform: 'feishu', config: { notifyEnabled: false, notifyOnApproval: true } },
      ]),
      fieldDefs: () => withMaster,
    });
    const offPrefs = off.preferencesFor(target)!;
    expect(offPrefs.notifyEnabled).toBe(false);
    expect(suppressionReasonFor({ severity: 'action_required' }, offPrefs)).toBe('notify-disabled');

    // Absent → the manifest default (true) → forwarding is untouched.
    const untouched = new RepoNotifyPreferenceSource({
      instanceRepo: repoOf([{ id: 'bi_1', platform: 'feishu', config: {} }]),
      fieldDefs: () => withMaster,
    });
    expect(untouched.preferencesFor(target)?.notifyEnabled).toBe(true);
  });
});
