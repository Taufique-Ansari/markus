/**
 * Notification-destination routing (design: docs/architecture/notification-delivery.md §3).
 *
 * "Where does a notification go?" is answered in exactly one place, by an
 * ordered walk that ends **loudly** — a resolved, sendable address, or an
 * explicit *undelivered* result. It never returns a silent `null` that a caller
 * can mistake for "nothing to do" (that is exactly how 40 approvals were dropped
 * on 2026-10-11/12 — see the design's §1).
 *
 *   1. `agent`    — the producing agent's own conversation binding (if any);
 *   2. `instance` — a destination the instance *declares* in its config, read
 *                   through the `notifyTarget` field annotation. This is the
 *                   reliable terminus: it depends on no binding at all, so a bot
 *                   the user configured in Settings is reachable even when no
 *                   agent has ever been DM'd;
 *   3. `instance` — the instance's `notifyAgentId` → that agent's conversation
 *                   (best-effort, needs the target agent to have a binding);
 *   4. `global`   — the org Secretary's conversation, else any global-scope
 *                   binding that carries a native id, else the legacy
 *                   per-platform notify channel;
 *   5. no terminus → an `undelivered` result the caller must surface, never a
 *      per-platform silent drop.
 *
 * The old failure (R1) was the promise "level 3 always exists": level 3 required
 * a real `channel_bindings` row for the Secretary, which a migrated install does
 * not have. Terminating the walk at a *declarable, binding-independent* address
 * (step 2) makes reachability a property of the structure, not a promise someone
 * has to remember.
 */
import type { OutboundOrigin } from './outbound.js';
import type { SendReceiveIdType } from '../adapter.js';

/** Which level of the walk produced the target. */
export type NotifyScope = 'agent' | 'instance' | 'global';

/**
 * How a native id is addressed on the wire — the platform's receive-id *type*
 * (fixes R4). Feishu's vocabulary is the reference: `chat_id` for a group/bot
 * chat, `open_id` for a user DM. A platform that has a single addressing scheme
 * leaves it unset and uses its own default.
 *
 * One definition, shared with the adapter send contract ({@link SendReceiveIdType})
 * — a resolved target's addressing and what an adapter accepts cannot drift.
 */
export type NotifyReceiveIdType = SendReceiveIdType;

/**
 * The semantic kind of a *declared* destination — the value of the generic
 * `notifyTarget` manifest-field annotation. Platform-neutral by design: `chat`
 * means a channel/group, `user` means a person. A platform declares which of its
 * config fields is which, so the resolver needs no platform branch (fixes R5).
 */
export type NotifyDestinationKind = 'chat' | 'user';

/**
 * Map a declared destination kind onto the concrete receive-id type sent on the
 * wire. `chat → chat_id`, `user → open_id` (the reference platform's vocabulary);
 * an adapter with a different user-addressing token translates it at the edge.
 */
export function receiveIdTypeForDestination(kind: NotifyDestinationKind): NotifyReceiveIdType {
  return kind === 'user' ? 'open_id' : 'chat_id';
}

/** A concrete, sendable notification destination. */
export interface NotifyTarget {
  /** Manifest id (`feishu`, `telegram`, …) — how the sink finds the adapter. */
  platform: string;
  /** Bot instance to send through; absent means the platform's implicit bot. */
  instanceId?: string;
  /** Native conversation id to post into. */
  nativeId: string;
  /**
   * Send-addressing type for {@link nativeId}. Absent means "use the adapter's
   * default" (Feishu: `chat_id`). Honoured by the adapter, so `open_id` DM
   * delivery is expressible rather than impossible (fixes R4).
   */
  receiveIdType?: NotifyReceiveIdType;
  /** Channel kind hint; notifications are outbound-only. */
  kind?: string;
}

/**
 * The binding source the resolver reads. Production backs this with
 * `channel_bindings` + `platform_instances`; tests back it with a fake.
 */
export interface NotifyTargetLookup {
  /** Step 1 — the producing agent's own addressable conversation. */
  agentTarget(orgId: string, agentId: string): NotifyTarget | undefined;
  /**
   * Step 2 — a destination the instance *declares* in its config (via the
   * `notifyTarget` annotation). Binding-independent: the reliable terminus.
   * `agentId` narrows to the instances the agent works in; when omitted the
   * org's declared instances are considered.
   */
  instanceDeclaredTarget(orgId: string, agentId?: string): NotifyTarget | undefined;
  /** Step 3 — the instance's `notifyAgentId` → that agent's conversation (best-effort). */
  instanceAgentTarget(orgId: string, agentId: string): NotifyTarget | undefined;
  /** Step 4 — org-level defaults (Secretary / global binding / legacy channel). */
  globalTarget(orgId: string): NotifyTarget | undefined;
}

/** A resolved destination plus the walk level that produced it. */
export interface ResolvedNotifyTarget {
  target: NotifyTarget;
  matchedScope: NotifyScope;
}

/** Why the walk produced no terminus. Distinguishable from a send failure. */
export type NotifyUndeliveredReason = 'no-notify-target';

/**
 * The resolver's **total** result. Either a resolved destination or an explicit
 * `undelivered` state — never `undefined`/`null`, so "no destination" cannot be
 * silently conflated with "nothing to do".
 */
export type NotifyResolution =
  | ({ status: 'resolved' } & ResolvedNotifyTarget)
  | { status: 'undelivered'; reason: NotifyUndeliveredReason };

/**
 * Walk `agent → instance(declared) → instance(agent) → global`, first hit wins.
 * When no level yields a target the result is `{ status: 'undelivered' }`, which
 * the caller must treat as a loud, visible state — not as "nothing happened".
 */
export function resolveNotifyTarget(
  orgId: string,
  origin: OutboundOrigin,
  lookup: NotifyTargetLookup,
): NotifyResolution {
  if (origin.agentId) {
    const agent = lookup.agentTarget(orgId, origin.agentId);
    if (agent) return { status: 'resolved', target: agent, matchedScope: 'agent' };

    // The reliable terminus: a destination the instance declares in its config,
    // reachable without any binding (fixes R1).
    const declared = lookup.instanceDeclaredTarget(orgId, origin.agentId);
    if (declared) return { status: 'resolved', target: declared, matchedScope: 'instance' };

    const viaAgent = lookup.instanceAgentTarget(orgId, origin.agentId);
    if (viaAgent) return { status: 'resolved', target: viaAgent, matchedScope: 'instance' };
  } else {
    // A message with no producing agent can still land on a declared destination
    // (an explicit org-wide address beats the generic global default).
    const declared = lookup.instanceDeclaredTarget(orgId);
    if (declared) return { status: 'resolved', target: declared, matchedScope: 'instance' };
  }

  const global = lookup.globalTarget(orgId);
  if (global) return { status: 'resolved', target: global, matchedScope: 'global' };

  return { status: 'undelivered', reason: 'no-notify-target' };
}
