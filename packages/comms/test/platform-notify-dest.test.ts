/**
 * T4 — generic notification destinations declared on every platform manifest.
 *
 * The design (docs/architecture/notification-delivery.md §3, "Generic destination
 * declaration") makes a notification destination a *declared* property of a
 * platform: a manifest field annotated `notifyTarget: 'chat' | 'user'`. The
 * resolver scans those annotated fields and needs no platform branch — so a new
 * platform becomes a notification destination by *declaring a field*, not by
 * adding an `if (platform === …)` somewhere (fixes R5, the cross-platform
 * asymmetry where only Feishu could declare a destination).
 *
 * This file pins three things:
 *   1. every outbound platform declares at least one valid destination;
 *   2. the **production** resolver resolves each platform's destination purely
 *      from its real manifest annotation (no injected field defs); and
 *   3. Feishu's pre-existing key (`notifyChatId`) keeps resolving — the
 *      key-migration guarantee: annotating the field must not orphan a
 *      destination a user configured before the annotation existed.
 *
 * A **group** is the only destination (Owner, 2026-10-14): approvals and
 * notifications are posted into a chat the bot was added to, never DM'd to one
 * person. The `user` kind survives only on WhatsApp, whose Cloud API exposes no
 * group concept — so the `user` cases below are asserted there and nowhere else.
 */
import { describe, it, expect } from 'vitest';
import { PLATFORM_MANIFESTS, getManifest } from '../src/platforms/registry.js';
import { RepoNotifyTargetLookup, type InstanceRowLike } from '../src/gateway/notify-lookup.js';
import { resolveNotifyTarget } from '../src/gateway/notify-route.js';

/** Every platform that can put a message on the wire is a notification target. */
const OUTBOUND_IDS = PLATFORM_MANIFESTS.filter((m) => m.capabilities.outbound).map((m) => m.id);

/**
 * A lookup whose *only* source of destination fields is the real registry — no
 * `fieldDefs` override. If a platform's manifest lacks the annotation, these
 * tests fail; that is the point.
 */
function lookupFor(platform: string, config: Record<string, unknown>, id = 'bi_1'): RepoNotifyTargetLookup {
  const instance: InstanceRowLike = { id, platform, config };
  return new RepoNotifyTargetLookup({
    bindingRepo: { listByOrg: () => [] },
    instanceRepo: { findById: () => instance, listByOrg: () => [instance] },
  });
}

describe('T4 — every outbound platform declares a notification destination', () => {
  it('has at least one field annotated with a valid notifyTarget kind', () => {
    expect(OUTBOUND_IDS.length).toBeGreaterThan(0);
    for (const id of OUTBOUND_IDS) {
      const declared = getManifest(id)!.fields.filter((f) => f.notifyTarget);
      expect(declared.length, `${id} declares no destination`).toBeGreaterThan(0);
      for (const f of declared) {
        expect(['chat', 'user'], `${id}.${f.key}`).toContain(f.notifyTarget);
      }
    }
  });

  it('declares exactly one destination per platform — a group, except WhatsApp', () => {
    // Group-only: a bot addresses a chat it was added to, never a person. The
    // one `user` destination left is WhatsApp (its API has no group to post to).
    const expected: Record<string, Array<[string, string]>> = {
      feishu: [['notifyChatId', 'chat']],
      telegram: [['notifyChatId', 'chat']],
      slack: [['notifyChannelId', 'chat']],
      discord: [['notifyChannelId', 'chat']],
      whatsapp: [['notifyWaId', 'user']],
    };
    for (const [id, pairs] of Object.entries(expected)) {
      const actual = getManifest(id)!.fields.filter((f) => f.notifyTarget).map((f) => [f.key, f.notifyTarget]);
      expect(actual, id).toEqual(pairs);
    }
  });

  it('offers no direct-message destination on any group-capable platform', () => {
    // The regression this pins: a DM destination (`notifyOpenId` / `notifyUserId`)
    // let a bot count as "configured" while addressing one person, so approvals
    // and notifications never reached a group.
    for (const id of OUTBOUND_IDS) {
      const kinds = getManifest(id)!.fields.filter((f) => f.notifyTarget).map((f) => f.notifyTarget);
      if (!kinds.includes('chat')) continue; // WhatsApp: groups impossible
      expect(kinds, `${id} still declares a user destination`).not.toContain('user');
    }
  });

  it('keeps every destination field optional — a destination must never gate "connected"', () => {
    // A required manifest field silently disables the platform (isManifestEnabled
    // = "every required field is ready"), so a destination can never be required.
    for (const m of PLATFORM_MANIFESTS) {
      for (const f of m.fields) {
        if (f.notifyTarget) expect(f.required, `${m.id}.${f.key}`).toBe(false);
      }
    }
  });
});

describe('T4 — every platform with a destination also declares the master switch', () => {
  it('declares `notifyEnabled` (boolean, default true, and not a destination)', () => {
    for (const id of OUTBOUND_IDS) {
      const fields = getManifest(id)!.fields;
      // A platform with nowhere to deliver has nothing to switch off.
      if (!fields.some((f) => f.notifyTarget)) continue;
      const master = fields.find((f) => f.key === 'notifyEnabled');
      expect(master, `${id} declares a destination but no master switch`).toBeDefined();
      expect(master!.type, id).toBe('boolean');
      // Default true: an install that never touched it keeps forwarding.
      expect(master!.default, id).toBe(true);
      // It is a preference, never an address — the resolver must not treat the
      // switch as a destination.
      expect(master!.notifyTarget, id).toBeUndefined();
    }
  });
});

describe('T4 — the resolver reads a destination purely from the real manifest', () => {
  it.each([
    ['feishu', 'notifyChatId', 'oc_team', 'chat_id'],
    ['telegram', 'notifyChatId', '-1001234567', 'chat_id'],
    ['slack', 'notifyChannelId', 'C0123456789', 'chat_id'],
    ['discord', 'notifyChannelId', '987654321', 'chat_id'],
    ['whatsapp', 'notifyWaId', '8613800000000', 'open_id'],
  ])('%s resolves %s with no binding at all (R1 + R5)', (platform, key, value, idType) => {
    const res = resolveNotifyTarget('default', { agentId: 'agt_nobody' }, lookupFor(platform, { [key]: value }));
    expect(res).toEqual({
      status: 'resolved',
      matchedScope: 'instance',
      target: { platform, instanceId: 'bi_1', nativeId: value, receiveIdType: idType, kind: 'notification' },
    });
  });

  it('resolves a `chat` destination as chat_id and the one `user` platform as open_id', () => {
    const chat = resolveNotifyTarget('default', { agentId: 'agt_x' }, lookupFor('slack', { notifyChannelId: 'C1' }));
    expect(chat).toMatchObject({ status: 'resolved', target: { nativeId: 'C1', receiveIdType: 'chat_id' } });

    // WhatsApp is the sole `user` destination — its API has no group to post to.
    const user = resolveNotifyTarget('default', { agentId: 'agt_x' }, lookupFor('whatsapp', { notifyWaId: '8613800000000' }));
    expect(user).toMatchObject({ status: 'resolved', target: { nativeId: '8613800000000', receiveIdType: 'open_id' } });
  });

  it('ignores a legacy direct-message key — group-only means group-only', () => {
    // `notifyUserId` is no longer a declared destination, so a config that still
    // carries it resolves to nothing rather than DMing a person.
    const res = resolveNotifyTarget('default', { agentId: 'agt_x' }, lookupFor('telegram', { notifyUserId: '4242' }));
    expect(res).toEqual({ status: 'undelivered', reason: 'no-notify-target' });
  });
});

describe('T4 — Feishu legacy keys keep resolving (key-migration guarantee)', () => {
  // The pre-existing Feishu destination keys — exactly what markus.json and the
  // migrated `platform_instances.config` carry. Annotating the fields must not
  // orphan a destination configured before the annotation existed.
  const legacy = (config: Record<string, unknown>) => lookupFor('feishu', config, 'bi_f');

  it('reads the pre-existing notifyChatId key through the manifest', () => {
    const res = resolveNotifyTarget('default', { agentId: 'agt_ops' }, legacy({ notifyChatId: 'oc_ops', notifyOpenId: 'ou_me' }));
    expect(res).toEqual({
      status: 'resolved',
      matchedScope: 'instance',
      target: { platform: 'feishu', instanceId: 'bi_f', nativeId: 'oc_ops', receiveIdType: 'chat_id', kind: 'notification' },
    });
  });

  it('no longer falls back to notifyOpenId — a lone DM key is not a destination', () => {
    const res = resolveNotifyTarget('default', { agentId: 'agt_ops' }, legacy({ notifyOpenId: 'ou_me' }));
    expect(res).toEqual({ status: 'undelivered', reason: 'no-notify-target' });
  });

  it('ignores blank legacy values — an unconfigured destination stays loud (undelivered)', () => {
    const res = resolveNotifyTarget('default', { agentId: 'agt_ops' }, legacy({ notifyChatId: '   ', notifyOpenId: '' }));
    expect(res).toEqual({ status: 'undelivered', reason: 'no-notify-target' });
  });

  it('trims a legacy value before using it as the native id', () => {
    const res = resolveNotifyTarget('default', { agentId: 'agt_ops' }, legacy({ notifyChatId: '  oc_padded  ' }));
    expect(res).toMatchObject({ status: 'resolved', target: { nativeId: 'oc_padded' } });
  });
});
