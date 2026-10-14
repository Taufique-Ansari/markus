/**
 * RepoBindingLookup — the DB-backed single writer for inbound routing.
 *
 * ── The contract this file locks ────────────────────────────────────────────
 *
 * A bot's answering agent is read from the SAME field the Settings card writes:
 * `platform_instances.config.agentId`. There is no separate `scope='instance'`
 * binding row — nothing ever wrote one for a bot created or edited in Settings,
 * so the instance level never matched and every inbound message fell through to
 * the global Secretary ("all messages go to the Secretary"), on every platform.
 *
 * The tests below drive the pure resolver through the real lookup, so they fail
 * on the old behaviour (a stored instance binding) and pass only when the route
 * is derived from the bot's own row.
 */
import { describe, it, expect } from 'vitest';
import { RepoBindingLookup, DEFAULT_INSTANCE_LABEL } from '../src/gateway/repo-binding-lookup.js';
import { resolveInboundTarget } from '../src/gateway/inbound.js';

interface BindingRow {
  scope: string;
  instanceId: string | null;
  nativeId: string | null;
  kind: string | null;
  agentId: string;
}

interface InstanceRow {
  id: string;
  label: string;
  config?: Record<string, unknown> | null;
}

function makeLookup(opts: {
  bindings: BindingRow[];
  instances: InstanceRow[];
  secretary?: string;
}): RepoBindingLookup {
  return new RepoBindingLookup({
    bindingRepo: { listByOrg: () => opts.bindings },
    instanceRepo: { listByPlatform: () => opts.instances },
    ...(opts.secretary ? { orgDefaultAgent: () => opts.secretary } : {}),
  });
}

describe('RepoBindingLookup — the DB-backed single writer', () => {
  it('REGRESSION: answers as the bot’s own agent, not the Secretary', () => {
    // The reported shape: 大玉 bound to 刘英 in Settings; the only stored
    // binding is the org-wide Secretary fallback.
    const lookup = makeLookup({
      instances: [{ id: 'bi_dayu', label: '大玉', config: { agentId: 'agt_liuying' } }],
      bindings: [{ scope: 'global', instanceId: null, nativeId: null, kind: null, agentId: 'agt_secretary' }],
      secretary: 'agt_secretary',
    });

    const target = resolveInboundTarget(
      { orgId: 'o', platform: 'feishu', nativeId: 'oc_x', instanceId: 'bi_dayu' },
      lookup,
    );
    expect(target?.agentId).toBe('agt_liuying');
    expect(target?.matchedScope).toBe('instance');
  });

  it('derives the instance route from config.agentId with no binding rows at all', () => {
    const lookup = makeLookup({
      instances: [{ id: 'bi_dayu', label: '大玉', config: { agentId: 'agt_liuying' } }],
      bindings: [],
    });
    expect(lookup.bindings('o', 'feishu')).toEqual([
      { scope: 'instance', instanceId: 'bi_dayu', nativeId: null, kind: null, agentId: 'agt_liuying' },
    ]);
  });

  it('a bot with no agentId contributes no instance route (falls to the next level)', () => {
    const lookup = makeLookup({
      instances: [{ id: 'bi_new', label: 'New', config: {} }],
      bindings: [],
      secretary: 'agt_secretary',
    });
    const target = resolveInboundTarget(
      { orgId: 'o', platform: 'feishu', nativeId: 'oc_x', instanceId: 'bi_new' },
      lookup,
    );
    expect(target?.agentId).toBe('agt_secretary');
  });

  it('a stored scope=instance row never overrides the bot’s own config (one source)', () => {
    const lookup = makeLookup({
      instances: [{ id: 'bi_dayu', label: '大玉', config: { agentId: 'agt_liuying' } }],
      // A legacy row that disagrees: `config.agentId` is the source of truth.
      bindings: [
        { scope: 'instance', instanceId: 'bi_dayu', nativeId: null, kind: null, agentId: 'agt_stale' },
      ],
    });
    const target = resolveInboundTarget(
      { orgId: 'o', platform: 'feishu', nativeId: 'oc_x', instanceId: 'bi_dayu' },
      lookup,
    );
    expect(target?.agentId).toBe('agt_liuying');
  });

  it('realises the platform level as the platform default instance’s agent', () => {
    const lookup = makeLookup({
      instances: [
        { id: 'bi_default', label: DEFAULT_INSTANCE_LABEL, config: { agentId: 'secretary' } },
        { id: 'bi_sales', label: 'sales' }, // unbound → level 4 answers
      ],
      bindings: [{ scope: 'global', instanceId: null, nativeId: null, kind: null, agentId: 'secretary' }],
    });

    const target = resolveInboundTarget(
      { orgId: 'o', platform: 'feishu', nativeId: 'oc_x', instanceId: 'bi_sales' },
      lookup,
    );
    expect(target?.matchedScope).toBe('platform');
    expect(target?.agentId).toBe('secretary');
  });

  it('level 4 does not leak an agent from a non-default instance', () => {
    const lookup = makeLookup({
      instances: [
        { id: 'bi_dayu', label: '大玉', config: { agentId: 'agt_liuying' } },
        { id: 'bi_cto', label: 'CTO', config: { agentId: 'agt_cto' } },
      ],
      bindings: [],
      secretary: 'agt_secretary',
    });
    // No `default`-labelled instance ⇒ level 4 has no answer; the envelope has
    // no instanceId, so level 3 is skipped too.
    const target = resolveInboundTarget({ orgId: 'o', platform: 'feishu', nativeId: 'oc_x' }, lookup);
    expect(target?.agentId).toBe('agt_secretary');
  });

  it('does not leak a channel binding from an instance of another platform', () => {
    const lookup = makeLookup({
      instances: [{ id: 'bi_1', label: 'default' }],
      bindings: [
        { scope: 'channel', instanceId: 'bi_other_platform', nativeId: 'oc_x', kind: 'group', agentId: 'wrong' },
      ],
    });
    const target = resolveInboundTarget(
      { orgId: 'o', platform: 'feishu', nativeId: 'oc_x', instanceId: 'bi_1' },
      lookup,
    );
    expect(target).toBeUndefined();
  });

  it('keeps global bindings platform-agnostic', () => {
    const lookup = makeLookup({
      instances: [],
      bindings: [{ scope: 'global', instanceId: null, nativeId: null, kind: null, agentId: 'secretary' }],
    });
    const target = resolveInboundTarget({ orgId: 'o', platform: 'telegram', nativeId: '123' }, lookup);
    expect(target?.agentId).toBe('secretary');
    expect(target?.matchedScope).toBe('global');
  });

  it('routes a channel binding of the right instance (level 2 > level 3)', () => {
    const lookup = makeLookup({
      instances: [{ id: 'bi_1', label: 'default', config: { agentId: 'agent-instance' } }],
      bindings: [
        { scope: 'channel', instanceId: 'bi_1', nativeId: 'oc_sales', kind: 'group', agentId: 'agent-sales' },
      ],
    });
    const target = resolveInboundTarget(
      { orgId: 'o', platform: 'feishu', nativeId: 'oc_sales', instanceId: 'bi_1' },
      lookup,
    );
    expect(target?.agentId).toBe('agent-sales');
    expect(target?.matchedScope).toBe('channel');
    expect(target?.conversationKey).toBe('im:bi_1:group:oc_sales');
  });
});
