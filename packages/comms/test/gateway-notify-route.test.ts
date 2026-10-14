/**
 * The notification-destination walk (design §3).
 *
 * The failure mode we are defending against (R1): the walk used to promise a
 * terminus at "level 3" that does not exist on a migrated install, so every
 * message was dropped. The chain must therefore (a) hit a **declared**,
 * binding-independent destination early, and (b) when it truly finds nothing,
 * return an explicit `undelivered` result — never a silent `undefined`.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveNotifyTarget,
  type NotifyTarget,
  type NotifyTargetLookup,
} from '../src/gateway/notify-route.js';

const GLOBAL: NotifyTarget = { platform: 'feishu', instanceId: 'bi_secretary', nativeId: 'oc_owner' };

function lookupOf(overrides: Partial<NotifyTargetLookup> = {}): NotifyTargetLookup {
  return {
    agentTarget: () => undefined,
    instanceDeclaredTarget: () => undefined,
    instanceAgentTarget: () => undefined,
    globalTarget: () => GLOBAL,
    ...overrides,
  };
}

describe('resolveNotifyTarget — first hit wins', () => {
  it('prefers the agent-level target when the agent has its own sink', () => {
    const agent: NotifyTarget = { platform: 'telegram', instanceId: 'bi_sales', nativeId: '111' };
    const resolved = resolveNotifyTarget('default', { agentId: 'agt_sales' }, lookupOf({
      agentTarget: () => agent,
      instanceDeclaredTarget: () => ({ platform: 'slack', instanceId: 'bi_ops', nativeId: 'C1' }),
    }));
    expect(resolved).toEqual({ status: 'resolved', target: agent, matchedScope: 'agent' });
  });

  it('hits the instance-declared destination (step 2) before the notify-agent fallback', () => {
    const declared: NotifyTarget = {
      platform: 'feishu', instanceId: 'bi_feishu', nativeId: 'oc_declared', receiveIdType: 'chat_id',
    };
    const resolved = resolveNotifyTarget('default', { agentId: 'agt_ops' }, lookupOf({
      instanceDeclaredTarget: () => declared,
      instanceAgentTarget: () => ({ platform: 'feishu', instanceId: 'bi_feishu', nativeId: 'oc_agent' }),
    }));
    expect(resolved).toEqual({ status: 'resolved', target: declared, matchedScope: 'instance' });
  });

  it('falls to the notify-agent level (step 3) when no destination is declared', () => {
    const viaAgent: NotifyTarget = { platform: 'slack', instanceId: 'bi_ops', nativeId: 'C1' };
    const resolved = resolveNotifyTarget('default', { agentId: 'agt_ops' }, lookupOf({
      instanceAgentTarget: () => viaAgent,
    }));
    expect(resolved).toEqual({ status: 'resolved', target: viaAgent, matchedScope: 'instance' });
  });

  it('falls to the global default when neither agent nor instance has a sink', () => {
    const resolved = resolveNotifyTarget('default', { agentId: 'agt_unbound' }, lookupOf());
    expect(resolved).toEqual({ status: 'resolved', target: GLOBAL, matchedScope: 'global' });
  });

  it('still reaches the global default when the origin has no agent at all', () => {
    const resolved = resolveNotifyTarget('default', {}, lookupOf());
    expect(resolved).toEqual({ status: 'resolved', target: GLOBAL, matchedScope: 'global' });
  });

  it('lets a no-agent origin land on a declared destination before the global default', () => {
    const declared: NotifyTarget = { platform: 'feishu', instanceId: 'bi_feishu', nativeId: 'oc_d' };
    const resolved = resolveNotifyTarget('default', {}, lookupOf({
      instanceDeclaredTarget: () => declared,
    }));
    expect(resolved).toEqual({ status: 'resolved', target: declared, matchedScope: 'instance' });
  });

  it('returns an explicit undelivered result when the whole walk finds nothing', () => {
    const resolved = resolveNotifyTarget('default', { agentId: 'a' }, lookupOf({
      globalTarget: () => undefined,
    }));
    expect(resolved).toEqual({ status: 'undelivered', reason: 'no-notify-target' });
  });

  it('returns undelivered — not a silent undefined — on a fresh install with no bindings', () => {
    const resolved = resolveNotifyTarget('default', { agentId: 'agt_nobody' }, lookupOf({
      globalTarget: () => undefined,
    }));
    expect(resolved.status).toBe('undelivered');
  });

  it('does not consult the agent level when there is no agent', () => {
    let called = 0;
    resolveNotifyTarget('default', {}, lookupOf({ agentTarget: () => { called++; return undefined; } }));
    expect(called).toBe(0);
  });
});
