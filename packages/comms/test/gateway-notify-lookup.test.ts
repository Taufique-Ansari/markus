/**
 * The production notify-target lookup, backed by `channel_bindings` +
 * `platform_instances`.
 *
 * The decisive new property (R1): step 2 — an instance's **declared**
 * destination — resolves with *no binding at all*, so a bot the user configured
 * in Settings is reachable even when no agent has ever been DM'd. The rest of the
 * walk (agent → notify-agent → global) keeps its previous semantics.
 */
import { describe, it, expect } from 'vitest';
import { RepoNotifyTargetLookup, type BindingRowLike, type InstanceRowLike } from '../src/gateway/notify-lookup.js';
import { resolveNotifyTarget } from '../src/gateway/notify-route.js';
import type { PlatformField } from '../src/platforms/registry.js';

function binding(over: Partial<BindingRowLike>): BindingRowLike {
  return {
    id: 'cb_x',
    orgId: 'default',
    scope: 'channel',
    instanceId: 'bi_a',
    nativeId: 'chat_1',
    kind: 'notification',
    agentId: 'agt_x',
    ...over,
  };
}

const INSTANCES: Record<string, InstanceRowLike> = {
  bi_a: { id: 'bi_a', platform: 'telegram' },
  bi_b: { id: 'bi_b', platform: 'slack' },
  bi_sec: { id: 'bi_sec', platform: 'feishu' },
};

/** A stand-in manifest: a chat destination first, then a user destination. */
const DECLARED_FIELDS: PlatformField[] = [
  { key: 'notifyChatId', label: 'Default chat ID', type: 'text', required: false, notifyTarget: 'chat' },
  { key: 'notifyOpenId', label: 'Default open ID', type: 'text', required: false, notifyTarget: 'user' },
];

function lookupOf(rows: BindingRowLike[], secretaryId?: string) {
  return new RepoNotifyTargetLookup({
    bindingRepo: { listByOrg: () => rows },
    instanceRepo: { findById: (id) => INSTANCES[id] },
    orgSecretaryId: () => secretaryId,
  });
}

describe('RepoNotifyTargetLookup', () => {
  it('resolves an agent-level notification sink', () => {
    const lookup = lookupOf([
      binding({ id: 'cb1', scope: 'channel', instanceId: 'bi_a', nativeId: 'chat_1', agentId: 'agt_x' }),
    ]);
    expect(lookup.agentTarget('default', 'agt_x')).toEqual({
      platform: 'telegram',
      instanceId: 'bi_a',
      nativeId: 'chat_1',
      kind: 'notification',
    });
  });

  it('resolves an instance-level `notification` binding sink (step 2, branch c)', () => {
    const lookup = lookupOf([
      binding({ id: 'cb_route', scope: 'instance', instanceId: 'bi_b', nativeId: null, kind: null, agentId: 'agt_ops' }),
      binding({ id: 'cb_notify', scope: 'instance', instanceId: 'bi_b', nativeId: 'C_NOTIFY', agentId: 'agt_bot' }),
    ]);
    expect(lookup.instanceDeclaredTarget('default', 'agt_ops')).toEqual({
      platform: 'slack',
      instanceId: 'bi_b',
      nativeId: 'C_NOTIFY',
      kind: 'notification',
    });
  });

  it('reads a destination declared in instance config — with NO binding at all (R1)', () => {
    const instance: InstanceRowLike = { id: 'bi_f', platform: 'feishu', config: { notifyChatId: 'oc_ops' } };
    const lookup = new RepoNotifyTargetLookup({
      bindingRepo: { listByOrg: () => [] },
      instanceRepo: { findById: () => instance, listByOrg: () => [instance] },
      fieldDefs: () => DECLARED_FIELDS,
    });
    expect(lookup.instanceDeclaredTarget('default', 'agt_unbound')).toEqual({
      platform: 'feishu',
      instanceId: 'bi_f',
      nativeId: 'oc_ops',
      receiveIdType: 'chat_id',
      kind: 'notification',
    });
  });

  it('maps a `user`-kind declaration onto the wire receive-id type (open_id)', () => {
    const instance: InstanceRowLike = { id: 'bi_f', platform: 'feishu', config: { notifyOpenId: 'ou_person' } };
    const lookup = new RepoNotifyTargetLookup({
      bindingRepo: { listByOrg: () => [] },
      instanceRepo: { findById: () => instance, listByOrg: () => [instance] },
      fieldDefs: () => DECLARED_FIELDS,
    });
    expect(lookup.instanceDeclaredTarget('default')?.receiveIdType).toBe('open_id');
  });

  it('prefers the chat declaration over the user declaration (manifest order)', () => {
    const instance: InstanceRowLike = {
      id: 'bi_f', platform: 'feishu', config: { notifyChatId: 'oc_chat', notifyOpenId: 'ou_person' },
    };
    const lookup = new RepoNotifyTargetLookup({
      bindingRepo: { listByOrg: () => [] },
      instanceRepo: { findById: () => instance, listByOrg: () => [instance] },
      fieldDefs: () => DECLARED_FIELDS,
    });
    expect(lookup.instanceDeclaredTarget('default')?.nativeId).toBe('oc_chat');
  });

  it('ignores a blank declared value and treats the destination as undeclared', () => {
    const instance: InstanceRowLike = { id: 'bi_f', platform: 'feishu', config: { notifyChatId: '   ' } };
    const lookup = new RepoNotifyTargetLookup({
      bindingRepo: { listByOrg: () => [] },
      instanceRepo: { findById: () => instance, listByOrg: () => [instance] },
      fieldDefs: () => DECLARED_FIELDS,
    });
    expect(lookup.instanceDeclaredTarget('default')).toBeUndefined();
  });

  it('prefers the agent’s own instance declared destination over an unrelated one', () => {
    const mine: InstanceRowLike = { id: 'bi_mine', platform: 'telegram', config: { notifyChatId: 'mine' } };
    const other: InstanceRowLike = { id: 'bi_other', platform: 'slack', config: { notifyChatId: 'other' } };
    const lookup = new RepoNotifyTargetLookup({
      bindingRepo: {
        listByOrg: () => [binding({ id: 'cb_route', scope: 'instance', instanceId: 'bi_mine', nativeId: null, kind: null, agentId: 'agt_ops' })],
      },
      instanceRepo: {
        findById: (id) => (id === 'bi_mine' ? mine : id === 'bi_other' ? other : undefined),
        listByOrg: () => [other, mine],
      },
      fieldDefs: () => DECLARED_FIELDS,
    });
    expect(lookup.instanceDeclaredTarget('default', 'agt_ops')?.nativeId).toBe('mine');
  });

  it('falls back to the Secretary notification sink at the global level', () => {
    const lookup = lookupOf([
      binding({ id: 'cb_sec_route', scope: 'instance', instanceId: 'bi_sec', nativeId: null, kind: null, agentId: 'agt_secretary' }),
      binding({ id: 'cb_sec_notify', scope: 'instance', instanceId: 'bi_sec', nativeId: 'oc_owner', agentId: 'agt_secretary' }),
    ], 'agt_secretary');
    expect(lookup.globalTarget('default')).toEqual({
      platform: 'feishu',
      instanceId: 'bi_sec',
      nativeId: 'oc_owner',
      kind: 'notification',
    });
  });

  it('uses a global-scope binding with a native id when the Secretary has no sink', () => {
    const lookup = lookupOf([
      binding({ id: 'cb_g', scope: 'global', instanceId: 'bi_sec', nativeId: 'oc_global', agentId: 'agt_x' }),
    ]);
    expect(lookup.globalTarget('default')?.nativeId).toBe('oc_global');
  });

  it('does NOT read a legacy `markus.json` channel — globalTarget is DB-only (R2)', () => {
    // Before T5 the walk ended on a `fallback` fed from `markus.json`
    // `integrations.feishu.notifyChatId`. That reader is gone (single source of
    // truth): with no DB destination the walk is honestly `undefined`, never a
    // stale file value.
    const lookup = new RepoNotifyTargetLookup({
      bindingRepo: { listByOrg: () => [] },
      instanceRepo: { findById: (id) => INSTANCES[id] },
      orgSecretaryId: () => 'agt_secretary',
    });
    expect(lookup.globalTarget('default')).toBeUndefined();
  });

  it('treats the agent’s own channel as the target when no notification binding exists', () => {
    // The G1 migration seeds routing bindings with kind = NULL; requiring the
    // marker here would leave migrated installs unable to notify anyone.
    const lookup = lookupOf([
      binding({ id: 'cb_route', scope: 'channel', instanceId: 'bi_a', nativeId: 'chat_1', kind: null, agentId: 'agt_x' }),
    ]);
    expect(lookup.agentTarget('default', 'agt_x')?.nativeId).toBe('chat_1');
  });

  it('prefers an explicit notification binding over the agent’s other channels', () => {
    const lookup = lookupOf([
      binding({ id: 'cb_group', scope: 'channel', instanceId: 'bi_a', nativeId: 'group_1', kind: 'group', agentId: 'agt_x' }),
      binding({ id: 'cb_dm', scope: 'channel', instanceId: 'bi_a', nativeId: 'dm_1', kind: 'direct', agentId: 'agt_x' }),
      binding({ id: 'cb_notify', scope: 'channel', instanceId: 'bi_b', nativeId: 'C_NOTIFY', agentId: 'agt_x' }),
    ]);
    expect(lookup.agentTarget('default', 'agt_x')?.nativeId).toBe('C_NOTIFY');
  });

  it('resolves the global level from the Secretary’s own channel (migrated install)', () => {
    const lookup = lookupOf([
      binding({ id: 'cb_sec', scope: 'channel', instanceId: 'bi_sec', nativeId: 'oc_owner', kind: null, agentId: 'agt_secretary' }),
    ], 'agt_secretary');
    expect(lookup.globalTarget('default')?.nativeId).toBe('oc_owner');
  });

  it('returns undefined for an unknown agent', () => {
    const lookup = lookupOf([binding({ agentId: 'agt_other' })]);
    expect(lookup.agentTarget('default', 'agt_x')).toBeUndefined();
    expect(lookup.instanceAgentTarget('default', 'agt_x')).toBeUndefined();
  });

  it('returns undefined when there is no global target', () => {
    expect(lookupOf([]).globalTarget('default')).toBeUndefined();
  });

  it('resolves the instance’s notification-target agent (G5 UI `config.notifyAgentId`, step 3)', () => {
    // Closes the G4×G5 seam: the "Notification target" the operator picks is an
    // agent; its own conversation is the level-3 sink.
    const lookup = new RepoNotifyTargetLookup({
      bindingRepo: {
        listByOrg: () => [
          binding({ id: 'cb_route', scope: 'instance', instanceId: 'bi_a', nativeId: null, kind: null, agentId: 'agt_ops' }),
          binding({ id: 'cb_sec', scope: 'channel', instanceId: 'bi_a', nativeId: 'chat_sec', agentId: 'agt_secretary' }),
        ],
      },
      instanceRepo: { findById: (id) => id === 'bi_a' ? { id: 'bi_a', platform: 'telegram', config: { notifyAgentId: 'agt_secretary' } } : INSTANCES[id] },
    });
    expect(lookup.instanceAgentTarget('default', 'agt_ops')).toEqual({
      platform: 'telegram',
      instanceId: 'bi_a',
      nativeId: 'chat_sec',
      kind: 'notification',
    });
  });

  it('ignores a blank notification target and falls through ("leave empty to use the org secretary")', () => {
    const lookup = new RepoNotifyTargetLookup({
      bindingRepo: {
        listByOrg: () => [
          binding({ id: 'cb_route', scope: 'instance', instanceId: 'bi_a', nativeId: null, kind: null, agentId: 'agt_ops' }),
        ],
      },
      instanceRepo: { findById: (id) => id === 'bi_a' ? { id: 'bi_a', platform: 'telegram', config: { notifyAgentId: '   ' } } : INSTANCES[id] },
    });
    expect(lookup.instanceAgentTarget('default', 'agt_ops')).toBeUndefined();
  });

  it('lets an explicit `notification` binding sink (step 2) win over the notify-agent (step 3)', () => {
    const lookup = new RepoNotifyTargetLookup({
      bindingRepo: {
        listByOrg: () => [
          binding({ id: 'cb_route', scope: 'instance', instanceId: 'bi_a', nativeId: null, kind: null, agentId: 'agt_ops' }),
          binding({ id: 'cb_sink', scope: 'instance', instanceId: 'bi_a', nativeId: 'C_SINK', agentId: 'agt_bot' }),
          binding({ id: 'cb_sec', scope: 'channel', instanceId: 'bi_a', nativeId: 'chat_sec', agentId: 'agt_secretary' }),
        ],
      },
      instanceRepo: { findById: (id) => id === 'bi_a' ? { id: 'bi_a', platform: 'telegram', config: { notifyAgentId: 'agt_secretary' } } : INSTANCES[id] },
    });
    expect(lookup.instanceDeclaredTarget('default', 'agt_ops')?.nativeId).toBe('C_SINK');
    expect(lookup.instanceAgentTarget('default', 'agt_ops')?.nativeId).toBe('chat_sec');
  });
});

describe('the walk over the real lookup (R1 end-to-end)', () => {
  const declared = (config: Record<string, unknown>): InstanceRowLike => ({ id: 'bi_f', platform: 'feishu', config });

  it('a fresh install with no bindings and no destination is `undelivered`', () => {
    const lookup = lookupOf([]);
    expect(resolveNotifyTarget('default', { agentId: 'agt_nobody' }, lookup)).toEqual({
      status: 'undelivered',
      reason: 'no-notify-target',
    });
  });

  it('a declared destination is reached at step 2 and carries receiveIdType', () => {
    const instance = declared({ notifyChatId: 'oc_ops' });
    const lookup = new RepoNotifyTargetLookup({
      bindingRepo: { listByOrg: () => [] },
      instanceRepo: { findById: () => instance, listByOrg: () => [instance] },
      fieldDefs: () => DECLARED_FIELDS,
    });
    expect(resolveNotifyTarget('default', { agentId: 'agt_nobody' }, lookup)).toEqual({
      status: 'resolved',
      matchedScope: 'instance',
      target: {
        platform: 'feishu',
        instanceId: 'bi_f',
        nativeId: 'oc_ops',
        receiveIdType: 'chat_id',
        kind: 'notification',
      },
    });
  });
});
