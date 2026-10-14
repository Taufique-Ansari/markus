/**
 * Notification-preference enforcement — the model and the one decision
 * (design: docs/architecture/notification-delivery.md §2 R6, §3 "One enforcement point").
 *
 * `notifyOnApproval` / `notifyOnNotification` / `notifyPriority` were rendered and
 * persisted but **enforced nowhere** — toggling them changed nothing (R6). They now
 * have exactly one enforcement point, the dispatcher, consulted immediately before
 * delivery.
 *
 * The preferences are read from the **same** instance config the destination was
 * resolved from (`platform_instances.config`), so the destination and the switch
 * share a single source (this is also how R2 stays fixed on the preference side).
 *
 * This module is deliberately transport-free and total: a pure decision function
 * (`suppressionReasonFor`) plus the read side (`RepoNotifyPreferenceSource`). The
 * dispatcher owns *calling* it.
 */
import { OUTBOUND_PRIORITIES, type OutboundMessage, type OutboundPriority } from './outbound.js';
import type { NotifyTarget } from './notify-route.js';
import type { InstanceSource } from './notify-lookup.js';
import { getManifest, type PlatformField } from '../platforms/registry.js';

/** The three preference fields an instance declares for outbound forwarding. */
export interface NotifyPreferences {
  /**
   * The master switch. `false` suppresses *everything* for this instance —
   * approvals and events alike — regardless of the per-category knobs. Absent
   * or `true` leaves the category knobs in charge.
   */
  notifyEnabled?: boolean;
  notifyOnApproval?: boolean;
  notifyOnNotification?: boolean;
  /**
   * A set of allowed levels. Persisted either as a `string[]` (fresh write) or as
   * the comma-joined string `coerceFieldValue` produces for a `select multiple`
   * (`'high,urgent,normal'`) — both shapes are accepted.
   */
  notifyPriority?: string | string[] | null;
}

/** Why a preference suppressed a message — intentional, never conflated with a failure. */
export type NotifySuppressionReason =
  | 'notify-disabled'
  | 'notify-off-approval'
  | 'notify-off-notification'
  | 'priority-filtered';

const PRIORITY_SET: ReadonlySet<string> = new Set(OUTBOUND_PRIORITIES);

/**
 * Coerce one raw priority token to a known level. Unknown tokens map to
 * `undefined` (not a level), so a typo cannot silently satisfy a filter. The
 * task vocabulary's `critical` folds onto `urgent`.
 */
export function normalizePriority(raw: unknown): OutboundPriority | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'critical') return 'urgent';
  return PRIORITY_SET.has(value) ? (value as OutboundPriority) : undefined;
}

/**
 * Parse `notifyPriority` in either persisted shape into the set of allowed
 * levels. Empty/absent ⇒ an empty set ⇒ no priority narrowing.
 */
export function parseNotifyPriority(raw: NotifyPreferences['notifyPriority']): Set<OutboundPriority> {
  const out = new Set<OutboundPriority>();
  if (raw === undefined || raw === null) return out;
  const parts = Array.isArray(raw) ? raw : String(raw).split(',');
  for (const part of parts) {
    const level = normalizePriority(part);
    if (level) out.add(level);
  }
  return out;
}

/**
 * The single enforcement decision: may this message be delivered under `prefs`?
 * Returns `undefined` to forward, otherwise the reason it is suppressed.
 *
 * The category follows the severity routing already in place:
 *   • `action_required` (approvals, task failures) — gated by `notifyOnApproval`
 *     (default on: an approval is the reason the channel exists).
 *   • `info` (agent & task events) — gated by `notifyOnNotification` (default off:
 *     events are opt-in), then narrowed by `notifyPriority`.
 *
 * `notifyPriority` narrows **events only** (Settings: "Only forward events at
 * these priorities"); a message that carries no explicit priority passes it, so an
 * unclassifiable event is never dropped by accident.
 */
export function suppressionReasonFor(
  msg: Pick<OutboundMessage, 'severity' | 'priority'>,
  prefs: NotifyPreferences | undefined,
): NotifySuppressionReason | undefined {
  if (!prefs) return undefined;

  // The master switch is checked first and wins: off means off, whatever the
  // category knobs happen to say. One fact, one decision point.
  if (prefs.notifyEnabled === false) return 'notify-disabled';

  if (msg.severity === 'action_required') {
    return prefs.notifyOnApproval === false ? 'notify-off-approval' : undefined;
  }

  if (prefs.notifyOnNotification !== true) return 'notify-off-notification';

  const allowed = parseNotifyPriority(prefs.notifyPriority);
  if (allowed.size === 0) return undefined;
  const priority = normalizePriority(msg.priority);
  return priority && !allowed.has(priority) ? 'priority-filtered' : undefined;
}

/** The read side: preferences for a resolved target, from that target's own instance row. */
export interface NotifyPreferenceSource {
  preferencesFor(target: NotifyTarget): NotifyPreferences | undefined;
}

export interface RepoNotifyPreferenceSourceDeps {
  /** The same `platform_instances` reader the target lookup uses — one config source. */
  instanceRepo?: InstanceSource;
  /** Manifest fields, for the preference defaults. Defaults to the platform registry. */
  fieldDefs?: (platform: string) => PlatformField[];
}

/**
 * Production preference reader. Reads `platform_instances.config` for the target's
 * instance and overlays the manifest defaults for absent keys — the same
 * precedence Settings shows (`readPlatformValues`), so a toggle that reads "on" in
 * the UI is the toggle the dispatcher actually enforces. No legacy file layer:
 * the DB row is the single source (fixes R2).
 */
export class RepoNotifyPreferenceSource implements NotifyPreferenceSource {
  constructor(private readonly deps: RepoNotifyPreferenceSourceDeps) {}

  preferencesFor(target: NotifyTarget): NotifyPreferences | undefined {
    if (!target.instanceId) return undefined;
    const instance = this.deps.instanceRepo?.findById(target.instanceId);
    if (!instance) return undefined;

    const config = (instance.config ?? {}) as Record<string, unknown>;
    const fields = this.deps.fieldDefs?.(instance.platform) ?? getManifest(instance.platform)?.fields ?? [];
    const defaults = new Map<string, unknown>(fields.map((f) => [f.key, f.default]));
    const value = (key: string): unknown => {
      const stored = config[key];
      return stored === undefined || stored === null ? defaults.get(key) : stored;
    };

    return {
      notifyEnabled: asBoolean(value('notifyEnabled')),
      notifyOnApproval: asBoolean(value('notifyOnApproval')),
      notifyOnNotification: asBoolean(value('notifyOnNotification')),
      notifyPriority: asPriorityInput(value('notifyPriority')),
    };
  }
}

/** Persisted booleans may arrive as the real thing or as a coerced string. */
function asBoolean(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const value = raw.trim().toLowerCase();
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return undefined;
}

function asPriorityInput(raw: unknown): string | string[] | undefined {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
  return undefined;
}
