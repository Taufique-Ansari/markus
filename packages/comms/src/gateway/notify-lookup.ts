/**
 * Production notify-target lookup (design: docs/architecture/notification-delivery.md §3).
 *
 * Answers the *outbound* question, "where does this message go?", from two tables
 * that already exist: `channel_bindings` (which conversation an agent already
 * lives in) and `platform_instances` (which bots exist and what they declare).
 *
 * ── The levels, precisely ────────────────────────────────────────────────────
 * 1. **agent**    — the agent's own addressable conversation binding.
 * 2. **instance** — a destination the instance *declares* in its config, read
 *                   through the generic `notifyTarget` field annotation. This is
 *                   the reliable terminus: it needs **no binding at all**, so a
 *                   bot the user configured in Settings delivers even when no
 *                   agent has ever been DM'd (fixes R1 / R5).
 * 3. **instance** — the instance's `notifyAgentId` → that agent's conversation
 *                   (best-effort; needs the target agent to have a binding).
 * 4. **global**   — the Secretary's conversation, else any global-scope binding
 *                   with a native id.
 *
 * Every level reads the **DB** (`channel_bindings` / `platform_instances`) — the
 * single source Settings writes. There is deliberately no legacy `markus.json`
 * reader on this path (design §3 "Single source of truth"): the configured fact
 * and the consumed fact are the same fact.
 *
 * Structural types on purpose: comms does not import `@markus/storage`, so a
 * storage row is assignable without a cast and tests use plain objects.
 */
import {
  receiveIdTypeForDestination,
  type NotifyTarget,
  type NotifyTargetLookup,
} from './notify-route.js';
import { getManifest, type PlatformField } from '../platforms/registry.js';

/** Structural view of a `channel_bindings` row. */
export interface BindingRowLike {
  id: string;
  orgId: string;
  scope: string;
  instanceId: string | null;
  nativeId: string | null;
  kind: string | null;
  agentId: string;
}

/** Structural view of a `platform_instances` row (only what the lookup needs). */
export interface InstanceRowLike {
  id: string;
  platform: string;
  /** The instance's config blob — carries declared destinations + `notifyAgentId`. */
  config?: Record<string, unknown> | null;
}

/** The instance reader the lookup needs — `findById` plus an optional org scan. */
export interface InstanceSource {
  findById(id: string): InstanceRowLike | undefined;
  /**
   * Every instance of the org. Optional: present in production (`platform_instances`),
   * and what lets a *declared* destination be found without any binding. Absent
   * ⇒ step 2 falls back to the instances named by the agent's own bindings.
   */
  listByOrg?(orgId: string): InstanceRowLike[];
}

export interface RepoNotifyTargetLookupDeps {
  bindingRepo: { listByOrg(orgId: string): BindingRowLike[] };
  /** Resolves a binding's instance id to its platform. Absent ⇒ no target is resolvable. */
  instanceRepo?: InstanceSource;
  /** Who is the org's Secretary — the owner of the global (level-3) default. */
  orgSecretaryId?: (orgId: string) => string | undefined;
  /**
   * Manifest field definitions for a platform — the `notifyTarget` annotation
   * source. Defaults to the platform registry; injectable so the declaration
   * scan is testable without a real manifest.
   */
  fieldDefs?: (platform: string) => PlatformField[];
}

/** The explicit notification-target marker on a binding. */
const NOTIFICATION_KIND = 'notification';

export class RepoNotifyTargetLookup implements NotifyTargetLookup {
  constructor(private readonly deps: RepoNotifyTargetLookupDeps) {}

  /** Step 1 — an agent's own addressable conversation. */
  agentTarget(orgId: string, agentId: string): NotifyTarget | undefined {
    return this.ownTarget(this.deps.bindingRepo.listByOrg(orgId), agentId);
  }

  /**
   * Step 2 — a destination the instance declares. Considers, most specific
   * first: (a) a `notifyTarget`-annotated config field on the instances the
   * agent works in, (b) the same on any instance of the org (binding-independent
   * — the reliable terminus), (c) an explicit `kind = 'notification'` binding
   * sink on those instances.
   */
  instanceDeclaredTarget(orgId: string, agentId?: string): NotifyTarget | undefined {
    const candidates = this.candidateInstances(orgId, agentId);

    // (a)/(b) — a declared config destination, independent of any binding.
    for (const instance of candidates) {
      const declared = this.declaredTargetOf(instance);
      if (declared) return declared;
    }

    // (c) — a routing-level sink declared on one of those instances.
    const rows = this.deps.bindingRepo.listByOrg(orgId);
    const ids = new Set(candidates.map((i) => i.id));
    const sink = rows.find(
      (r) =>
        r.kind === NOTIFICATION_KIND &&
        r.nativeId !== null &&
        r.instanceId !== null &&
        ids.has(r.instanceId),
    );
    return sink ? this.toTarget(sink) : undefined;
  }

  /**
   * Step 3 — the instance's *notification-target agent* — "Approvals and
   * notifications about this bot are delivered here" (Settings' own words):
   * deliver to that agent's own addressable conversation. Empty ⇒ nothing is
   * declared, and the walk falls through to the global level.
   */
  instanceAgentTarget(orgId: string, agentId: string): NotifyTarget | undefined {
    const rows = this.deps.bindingRepo.listByOrg(orgId);
    // Which instances does this agent work in? Any binding mentioning it names one.
    const instanceIds = new Set(
      rows.filter((r) => r.agentId === agentId && r.instanceId).map((r) => r.instanceId as string),
    );
    if (instanceIds.size === 0) return undefined;

    for (const instanceId of instanceIds) {
      const notifyAgentId = this.declaredNotifyAgent(instanceId);
      if (!notifyAgentId) continue;
      const target = this.ownTarget(rows, notifyAgentId);
      if (target) return target;
    }
    return undefined;
  }

  /**
   * Step 4 — the org-wide default. The Secretary's own conversation first, then
   * any global-scope binding that carries a native id (the org's *declared* global
   * sink). Both come from the DB; there is no legacy `markus.json` fallback.
   */
  globalTarget(orgId: string): NotifyTarget | undefined {
    const rows = this.deps.bindingRepo.listByOrg(orgId);
    const secretaryId = this.deps.orgSecretaryId?.(orgId);
    if (secretaryId) {
      const own = this.ownTarget(rows, secretaryId);
      if (own) return own;
    }
    const globalSink = rows.find(
      (r) => r.scope === 'global' && r.nativeId !== null && r.instanceId !== null,
    );
    if (globalSink) return this.toTarget(globalSink);
    return undefined;
  }

  /**
   * Instances relevant to this message, most specific first: those the agent
   * works in (from its own bindings), then every declared instance of the org.
   */
  private candidateInstances(orgId: string, agentId?: string): InstanceRowLike[] {
    const ordered: InstanceRowLike[] = [];
    const seen = new Set<string>();
    const push = (id: string | null | undefined): void => {
      if (!id || seen.has(id)) return;
      const instance = this.deps.instanceRepo?.findById(id);
      if (!instance) return;
      seen.add(id);
      ordered.push(instance);
    };

    if (agentId) {
      for (const row of this.deps.bindingRepo.listByOrg(orgId)) {
        if (row.agentId === agentId && row.instanceId) push(row.instanceId);
      }
    }
    for (const instance of this.deps.instanceRepo?.listByOrg?.(orgId) ?? []) push(instance.id);
    return ordered;
  }

  /**
   * Read the destination an instance config *declares*, via the manifest fields
   * carrying the `notifyTarget` annotation. Manifest order is the tie-break on
   * the (rare) platforms that declare more than one destination.
   *
   * Only a `chat` destination is meaningful today: a notification goes to a group
   * the bot was added to. The one surviving `user` destination is WhatsApp, whose
   * Cloud API exposes no group concept at all — expressible there, impossible
   * elsewhere.
   */
  private declaredTargetOf(instance: InstanceRowLike): NotifyTarget | undefined {
    for (const field of this.fieldDefs(instance.platform)) {
      if (!field.notifyTarget) continue;
      const raw = instance.config?.[field.key];
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (!value) continue;
      return {
        platform: instance.platform,
        instanceId: instance.id,
        nativeId: value,
        receiveIdType: receiveIdTypeForDestination(field.notifyTarget),
        kind: NOTIFICATION_KIND,
      };
    }
    return undefined;
  }

  private fieldDefs(platform: string): PlatformField[] {
    return this.deps.fieldDefs?.(platform) ?? getManifest(platform)?.fields ?? [];
  }

  /**
   * The notification-target agent an instance declares, if any. This is the
   * reader that closes the G4×G5 seam: G5 writes the key, and until now nothing
   * read it, so the control persisted without ever taking effect.
   */
  private declaredNotifyAgent(instanceId: string): string | undefined {
    const value = this.deps.instanceRepo?.findById(instanceId)?.config?.['notifyAgentId'];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  /** An agent's own addressable conversation: explicit notification binding first, else any. */
  private ownTarget(rows: BindingRowLike[], agentId: string): NotifyTarget | undefined {
    const mine = rows.filter((r) => r.agentId === agentId && r.instanceId !== null && r.nativeId !== null);
    if (mine.length === 0) return undefined;
    const preferred = mine.find((r) => r.kind === NOTIFICATION_KIND) ?? mine[0];
    return this.toTarget(preferred);
  }

  private toTarget(row: BindingRowLike): NotifyTarget | undefined {
    if (!row.instanceId || !row.nativeId) return undefined;
    const instance = this.deps.instanceRepo?.findById(row.instanceId);
    if (!instance) return undefined;
    return {
      platform: instance.platform,
      instanceId: instance.id,
      nativeId: row.nativeId,
      kind: NOTIFICATION_KIND,
    };
  }
}
