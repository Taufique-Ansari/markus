/**
 * Notification destinations — the **one** place the front-end answers "can this
 * bot deliver approvals and notifications?".
 *
 * Design: docs/architecture/notification-delivery.md §2 R7, §3 ("UI / guidance,
 * generic"), §4 T6.
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 *
 * "Where does a notification go?" is answered on the server by
 * `RepoNotifyTargetLookup` (packages/comms/src/gateway/notify-lookup.ts). Its
 * step 2 scans the platform manifest for fields annotated `notifyTarget`
 * (added in slice T4) and reads the *value* out of the instance config. That is
 * the reliable terminus: it needs no binding at all.
 *
 * The Settings UI has to show the **same fact** — "is a destination declared?"
 * — without inventing a second judgement. It used to invent one, in two ways
 * that both rotted:
 *
 *   • the panel that configured a destination was written for Feishu alone, so
 *     every other platform had no way to declare one (the UI asymmetry that
 *     mirrors root cause R5);
 *   • the "you have not configured a destination" warning tested a field
 *     *definition* (`!notifyChatId`, where `notifyChatId` was the manifest
 *     field object — always truthy), so the warning could never render. A
 *     status predicate that cannot be false is not a predicate.
 *
 * This module replaces both: everything is derived from the same manifest
 * annotation the resolver scans, as pure functions, with no platform id
 * mentioned anywhere. A new platform that annotates a destination gets the
 * panel, the guide step and the reachability verdict for free.
 */
import { isFieldEmpty, type PlatformField } from './platformIntegrations.ts';

/**
 * The manifest key namespace the notification surface lives in.
 *
 * Every notification field a platform declares is named `notify…` (`notifyChatId`,
 * `notifyOnApproval`, …). Destinations among them carry the explicit `notifyTarget`
 * annotation; the rest are *preferences* (which events to forward, at what
 * priority). Reading the namespace is what lets the panel be generic — a
 * platform id is never consulted.
 */
const NOTIFICATION_KEY = /^notify[A-Z]/;

/**
 * The master switch key. It matches {@link NOTIFICATION_KEY} but is rendered on
 * the panel heading (a single toggle), not as one of the preference chips — so
 * it is excluded from {@link notificationPreferenceFields} and read through
 * {@link notificationMasterField} instead. Keeping the key here (not inline)
 * means the manifest field and its two readers cannot drift.
 */
const NOTIFICATION_MASTER_KEY = 'notifyEnabled';

/** The notification master switch field, when the platform declares one. */
export function notificationMasterField(fields: PlatformField[]): PlatformField | undefined {
  return fields.find((field) => field.key === NOTIFICATION_MASTER_KEY);
}

/** True when a field is part of the platform's notification surface. */
export function isNotificationField(field: PlatformField): boolean {
  return field.notifyTarget === 'chat' || field.notifyTarget === 'user' || NOTIFICATION_KEY.test(field.key);
}

/**
 * The fields that *declare* where notifications go — the front-end mirror of
 * the resolver's step-2 scan. Order is manifest order, which is also the
 * resolver's tie-break (a `chat` destination declared before a `user` one wins).
 */
export function notificationDestinationFields(fields: PlatformField[]): PlatformField[] {
  return fields.filter((field) => field.notifyTarget === 'chat' || field.notifyTarget === 'user');
}

/**
 * The notification *knobs* — which events to forward and at what priority.
 *
 * A preference is any `notify…` field that is neither a destination nor a
 * secret. Nothing else in the manifest is named `notify*`, so this does not
 * need (and must not have) a per-platform list.
 */
export function notificationPreferenceFields(fields: PlatformField[]): PlatformField[] {
  return fields.filter(
    (field) =>
      !field.notifyTarget &&
      !field.secret &&
      field.key !== NOTIFICATION_MASTER_KEY &&
      NOTIFICATION_KEY.test(field.key),
  );
}

/** Every field the notification panel owns (destinations + preferences). */
export function notificationFields(fields: PlatformField[]): PlatformField[] {
  return fields.filter(isNotificationField);
}

/** The first destination that names a conversation (rather than a single user). */
export function chatDestinationField(fields: PlatformField[]): PlatformField | undefined {
  return notificationDestinationFields(fields).find((field) => field.notifyTarget === 'chat');
}

/**
 * Can this bot actually deliver, as far as the *declared* configuration goes?
 *
 *   • `unsupported`     — the platform declares no destination field at all, so
 *                         there is nothing here to configure (and nothing this
 *                         panel could say).
 *   • `not-configured`  — destinations exist but every one of them is blank:
 *                         approvals and notifications have no address and the
 *                         outbound dispatcher can only drop them.
 *   • `configured`      — at least one destination carries a value.
 *
 * This is the SINGLE predicate the UI is allowed to use for reachability. Every
 * entry point (the panel's status line, the setup guide, any future badge) must
 * call it rather than re-deriving the answer from the fields.
 */
export type NotificationReachability = 'configured' | 'not-configured' | 'unsupported';

export function notificationReachability(
  fields: PlatformField[],
  values: Record<string, unknown>,
): NotificationReachability {
  const destinations = notificationDestinationFields(fields);
  if (destinations.length === 0) return 'unsupported';
  return destinations.some((field) => !isFieldEmpty(field, values[field.key]))
    ? 'configured'
    : 'not-configured';
}
