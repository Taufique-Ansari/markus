/**
 * The outbound dispatcher (messaging-gateway.md §7, slice G4).
 *
 * One place turns *events* (a HITL notification, an EventBus task event) into a
 * *delivery*: resolve the target (`agent → instance → global`), render to what the
 * platform can show, send. Before this, each platform wire had its own notifier —
 * which is exactly why an approval could only reach Feishu.
 *
 * The dispatcher is deliberately transport-free: it depends on the
 * {@link NotifyTargetLookup} and {@link OutboundSink} ports, so the whole chain is
 * testable without a platform, a database or a timer. Production wires the ports
 * to `channel_bindings` and the adapter router.
 */
import { createLogger } from '@markus/shared';
import {
  severityOfNotification,
  signActionRef,
  type OutboundMessage,
  type OutboundOrigin,
} from './outbound.js';
import { resolveNotifyTarget, type NotifyResolution, type NotifyScope, type NotifyTarget, type NotifyTargetLookup } from './notify-route.js';
import {
  normalizePriority,
  suppressionReasonFor,
  type NotifyPreferenceSource,
  type NotifySuppressionReason,
} from './notify-prefs.js';
import { renderOutbound, type OutboundFormat, type RenderCapabilities, type RenderedOutbound } from './render.js';

const log = createLogger('outbound-dispatcher');

/** The transport port. Production: the adapter router. Tests: a recorder. */
export interface OutboundSink {
  /** What the target's platform/instance can render. */
  capabilities(target: NotifyTarget): RenderCapabilities;
  /** Deliver a rendered message; returns a native message id, or `undefined` on failure. */
  send(target: NotifyTarget, rendered: RenderedOutbound): Promise<string | undefined>;
}

/**
 * The source port the outbound dispatcher consumes — the **channel-level** view
 * of HITL notifications (structurally `HITLService.onChannelNotification`).
 *
 * One logical notification (`HITLService.notify`) must produce exactly one
 * channel message, regardless of how many humans it fans out to. The dispatcher
 * therefore subscribes to `onChannelNotification`, **not** to the per-person
 * `onNotification` stream (which fires once per recipient by design). Subscribing
 * to the per-person stream is exactly what sent one notification into the same
 * group N times (req_d25dc9b9); the port no longer even offers that option.
 */
export interface NotificationSource {
  onChannelNotification(handler: (notification: NotificationLike) => void): () => void;
}

/** Minimal structural view of a HITL {@link Notification}. */
export interface NotificationLike {
  id?: string;
  type?: string;
  title: string;
  body: string;
  priority?: string;
  targetUserId?: string;
  metadata?: Record<string, unknown>;
}

/** The source port for EventBus task events — structurally `EventBus.on`. */
export interface EventBusLike {
  on(event: string, fn: (payload: unknown) => void): () => void;
}

export interface DispatchOutcome {
  delivered: boolean;
  /** Which routing level produced the target. */
  scope?: NotifyScope;
  target?: NotifyTarget;
  format?: OutboundFormat;
  /** Native message id from the sink (proof of delivery). */
  messageId?: string;
  /** True when an `info` message was buffered for the digest instead of sent. */
  digested?: boolean;
  /**
   * True when the walk found **no destination at all** — a distinct state from a
   * send failure (`sink-failed`). The message is not lost silently: the caller
   * (and, via wiring, Settings) can see reachability is dead.
   */
  undelivered?: boolean;
  /**
   * True when the instance's notification preferences suppressed this message —
   * an **intentional** drop (`notifyOnApproval` / `notifyOnNotification` /
   * `notifyPriority`), distinct from `undelivered` (no destination at all) and
   * from a send failure. Toggling a switch is observable here and in one log line.
   */
  suppressed?: boolean;
  /** Why delivery did not happen (`no-notify-target`, `sink-failed`, `notify-off-approval`, …). */
  reason?: string;
}

export interface OutboundDispatcherOptions {
  lookup: NotifyTargetLookup;
  sink: OutboundSink;
  /**
   * The **one** enforcement point's read side: the notification preferences
   * (`notifyOnApproval` / `notifyOnNotification` / `notifyPriority`) of the
   * instance a message resolved to. Absent ⇒ no preference filtering (every
   * message is delivered), so the dispatcher stays usable without Settings.
   */
  preferences?: NotifyPreferenceSource;
  /** Org whose targets are resolved. Defaults to `default`. */
  orgId?: string;
  /** Buffer `info` messages and flush them as one summary (default: send immediately). */
  digestInfo?: boolean;
  /** Default title for the digest summary. */
  digestTitle?: (count: number) => string;
  /**
   * Secret used to sign approval action refs. When set, an approval notification's
   * action refs are opaque signed tokens; when absent the raw approval id is used.
   */
  actionSecret?: string;
  /**
   * Resolve an origin agent's display name from its id, so a delivered
   * notification says *which agent* it came from. Absent ⇒ no attribution line is
   * added: the message goes out unchanged rather than with a raw id standing in
   * for a name.
   */
  agentName?: (agentId: string) => string | undefined;
}

/** EventBus task events the dispatcher forwards by default, with their severity. */
const TASK_EVENT_MAP: Record<string, OutboundMessage['severity']> = {
  'task:completed': 'info',
  'task:review': 'info',
  'task:failed': 'action_required',
};

export class OutboundDispatcher {
  private readonly lookup: NotifyTargetLookup;
  private readonly sink: OutboundSink;
  private readonly preferences?: NotifyPreferenceSource;
  private readonly orgId: string;
  private readonly digestInfo: boolean;
  private readonly digestTitle: (count: number) => string;
  private readonly actionSecret?: string;
  private readonly agentName?: (agentId: string) => string | undefined;
  private infoBuffer: OutboundMessage[] = [];

  constructor(opts: OutboundDispatcherOptions) {
    this.lookup = opts.lookup;
    this.sink = opts.sink;
    this.preferences = opts.preferences;
    this.orgId = opts.orgId ?? 'default';
    this.digestInfo = opts.digestInfo ?? false;
    this.digestTitle = opts.digestTitle ?? ((n) => `📬 通知汇总（${n} 条）`);
    this.actionSecret = opts.actionSecret;
    this.agentName = opts.agentName;
  }

  /**
   * Deliver one message. `action_required` is pushed immediately; `info` is
   * digested when configured. Never throws — a delivery failure is reported in the
   * outcome so a caller can see it rather than lose it in a rejected promise.
   */
  async dispatch(msg: OutboundMessage): Promise<DispatchOutcome> {
    const resolution = this.resolve(msg.origin ?? {});
    if (resolution.status === 'undelivered') return this.reportUndelivered(msg, resolution.reason);

    // ── The one enforcement point for the notification preferences (design §3, R6) ──
    // consulted immediately before any delivery, reading the *same* instance the
    // destination came from. An `info` message that never passes here is not even
    // buffered for the digest.
    const suppression = suppressionReasonFor(msg, this.preferences?.preferencesFor(resolution.target));
    if (suppression) return this.reportSuppressed(msg, resolution.matchedScope, resolution.target, suppression);

    if (msg.severity === 'info' && this.digestInfo) {
      this.infoBuffer.push(msg);
      return { delivered: false, digested: true, scope: resolution.matchedScope };
    }

    // An urgent message must not jump the queue: flush whatever is buffered first
    // so the receiver reads the background items before the urgent one.
    if (msg.severity === 'action_required' && this.infoBuffer.length > 0) {
      await this.flushDigest();
    }

    return this.deliver(resolution.matchedScope, resolution.target, msg);
  }

  /** Send the buffered `info` messages as one summary. No-op when nothing is buffered. */
  async flushDigest(): Promise<DispatchOutcome | undefined> {
    if (this.infoBuffer.length === 0) return undefined;
    const items = this.infoBuffer;
    this.infoBuffer = [];

    const summary: OutboundMessage = {
      title: this.digestTitle(items.length),
      body: items.map((m) => `• ${m.title}`).join('\n'),
      severity: 'info',
      origin: items.find((m) => m.origin)?.origin,
    };
    // Delivered directly, never re-entering the digest branch — otherwise the
    // summary would be buffered as another info item and never sent.
    return this.deliverResolved(summary);
  }

  /**
   * Resolve the target and deliver — the digest path's core. It deliberately does
   * **not** re-apply the preference filter: the digest aggregates `info` items that
   * already passed the one enforcement point in {@link dispatch}.
   */
  private async deliverResolved(msg: OutboundMessage): Promise<DispatchOutcome> {
    const resolution = this.resolve(msg.origin ?? {});
    if (resolution.status === 'undelivered') return this.reportUndelivered(msg, resolution.reason);
    return this.deliver(resolution.matchedScope, resolution.target, msg);
  }

  /**
   * Record the **intentional** drop — a notification-preference switch turned this
   * message off (R6). Observable: one outcome and one log line, so flipping a
   * control has a visible effect instead of changing nothing. Logged at `info`
   * (this is not an error, unlike a missing destination).
   */
  private reportSuppressed(
    msg: OutboundMessage,
    scope: NotifyScope,
    target: NotifyTarget,
    reason: NotifySuppressionReason,
  ): DispatchOutcome {
    log.info('Outbound message suppressed by notification preference', {
      title: msg.title,
      severity: msg.severity,
      priority: msg.priority,
      platform: target.platform,
      instanceId: target.instanceId,
      reason,
    });
    return { delivered: false, suppressed: true, scope, target, reason };
  }

  /**
   * Read-only resolution — "is this origin deliverable, and where?". Exposed so
   * Settings can show a reachability state from the *same* walk, without sending.
   */
  resolve(origin: OutboundOrigin): NotifyResolution {
    return resolveNotifyTarget(this.orgId, origin, this.lookup);
  }

  /**
   * Record the one thing a delivery must never do silently: no destination.
   * Exactly one log line and one outcome per message (never per platform — the
   * walk resolves a single terminus), so the state is loud and countable.
   */
  private reportUndelivered(msg: OutboundMessage, reason: string): DispatchOutcome {
    log.error('Outbound message has no notify target at any level — undelivered', {
      title: msg.title,
      severity: msg.severity,
      origin: msg.origin,
      reason,
    });
    return { delivered: false, undelivered: true, reason };
  }

  /** How many `info` messages are waiting in the digest. */
  pendingDigestCount(): number {
    return this.infoBuffer.length;
  }

  /**
   * Subscribe to the **channel-level** notification source. Returns an unsubscribe
   * fn. One subscription ⇒ one message per logical notification; delivery is
   * fire-and-forget, so the emitter is never blocked (or broken) by a slow
   * platform call.
   */
  attachNotifications(source: NotificationSource): () => void {
    return source.onChannelNotification((n) => {
      void this.dispatch(notificationToOutbound(n, this.actionSecret)).catch((err) => {
        log.error('Failed to dispatch notification', { error: String(err) });
      });
    });
  }

  /**
   * Subscribe to EventBus task events (`task:*` by default). Returns an
   * unsubscribe fn covering every subscription it made.
   */
  attachEventBus(bus: EventBusLike, events: string[] = Object.keys(TASK_EVENT_MAP)): () => void {
    const unsubs = events.map((event) =>
      bus.on(event, (payload) => {
        const msg = taskEventToOutbound(event, payload, TASK_EVENT_MAP[event] ?? 'info');
        void this.dispatch(msg).catch((err) => {
          log.error('Failed to dispatch task event', { event, error: String(err) });
        });
      }),
    );
    return () => {
      for (const unsub of unsubs) {
        try { unsub(); } catch { /* ignore */ }
      }
    };
  }

  /**
   * Prefix the message with who sent it, when the origin agent's name is known.
   *
   * This is envelope, not payload: `origin.agentId` already travels for routing,
   * and this surfaces the human-readable name so a notification landing in a
   * shared group says *which agent* it came from instead of arriving anonymously.
   * Applied at the single delivery point, so the card, markdown and plain-text
   * renderings all carry it. Idempotent (never prefixed twice) and skipped
   * entirely when the name is unknown — a message is never held back for it.
   */
  private attribute(msg: OutboundMessage): OutboundMessage {
    const agentId = msg.origin?.agentId;
    if (!agentId) return msg;
    const name = this.agentName?.(agentId);
    if (!name) return msg;
    const marker = `**来自**：${name}`;
    if (msg.body.startsWith(marker)) return msg;
    return { ...msg, origin: { ...msg.origin, agentName: name }, body: `${marker}\n\n${msg.body}` };
  }

  private async deliver(
    scope: NotifyScope,
    target: NotifyTarget,
    msg: OutboundMessage,
  ): Promise<DispatchOutcome> {
    const caps = this.sink.capabilities(target);
    const rendered = renderOutbound(this.attribute(msg), caps);
    try {
      const messageId = await this.sink.send(target, rendered);
      const delivered = messageId !== undefined && messageId !== null;
      if (!delivered) {
        log.warn('Outbound sink returned no message id — treating as undelivered', {
          platform: target.platform,
          instanceId: target.instanceId,
          title: msg.title,
        });
      }
      return { delivered, scope, target, format: rendered.format, messageId, reason: delivered ? undefined : 'sink-failed' };
    } catch (err) {
      log.error('Outbound send failed', {
        platform: target.platform,
        instanceId: target.instanceId,
        error: String(err),
      });
      return { delivered: false, scope, target, format: rendered.format, reason: String(err) };
    }
  }
}

/**
 * Convert a HITL notification into the outbound shape. When the notification
 * carries an `approvalId` and a secret is available, each action's `ref` is a
 * **signed** token — the internal approval id never leaves in the clear. Without
 * a secret the raw id is used (legacy behaviour, flagged as a configuration gap).
 */
export function notificationToOutbound(n: NotificationLike, actionSecret?: string): OutboundMessage {
  const metadata = (n.metadata ?? {}) as Record<string, unknown>;
  const origin: OutboundOrigin = {};
  if (typeof metadata['agentId'] === 'string') origin.agentId = metadata['agentId'] as string;
  if (typeof metadata['taskId'] === 'string') origin.taskId = metadata['taskId'] as string;

  const msg: OutboundMessage = {
    title: n.title,
    body: n.body,
    severity: severityOfNotification({ type: n.type, priority: n.priority }),
    priority: normalizePriority(n.priority),
    origin: Object.keys(origin).length > 0 ? origin : undefined,
  };

  const approvalId = typeof metadata['approvalId'] === 'string' ? (metadata['approvalId'] as string) : undefined;
  if (approvalId) {
    const refFor = (action: string, explicit?: unknown): string => {
      if (typeof explicit === 'string') return explicit;
      if (!actionSecret) return approvalId;
      return signActionRef({ approvalId, action }, actionSecret);
    };
    const options = Array.isArray(metadata['options']) ? (metadata['options'] as unknown[]) : undefined;
    msg.actions =
      options && options.length > 0
        ? options.map((o) => {
            const opt = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
            const id = typeof opt['id'] === 'string' ? (opt['id'] as string) : 'option';
            return {
              id,
              label: typeof opt['label'] === 'string' ? (opt['label'] as string) : id,
              ref: refFor(id),
            };
          })
        : [
            { id: 'approve', label: '批准', style: 'primary' as const, ref: refFor('approve') },
            { id: 'reject', label: '驳回', style: 'danger' as const, ref: refFor('reject') },
          ];
  }
  return msg;
}

/** Build an outbound message from an EventBus task event payload. */
export function taskEventToOutbound(
  event: string,
  payload: unknown,
  severity: OutboundMessage['severity'],
): OutboundMessage {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const title = typeof p['title'] === 'string' ? (p['title'] as string) : event;
  const body =
    typeof p['summary'] === 'string'
      ? (p['summary'] as string)
      : typeof p['body'] === 'string'
        ? (p['body'] as string)
        : title;
  const origin: OutboundOrigin = {};
  if (typeof p['agentId'] === 'string') origin.agentId = p['agentId'] as string;
  if (typeof p['taskId'] === 'string') origin.taskId = p['taskId'] as string;
  return {
    title,
    body,
    severity,
    priority: normalizePriority(p['priority']),
    origin: Object.keys(origin).length > 0 ? origin : undefined,
  };
}
