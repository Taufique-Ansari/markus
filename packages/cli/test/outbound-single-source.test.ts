/**
 * Slice T5 — the outbound notification path reads the DB, and *only* the DB.
 *
 * A notification/approval destination is resolved from
 * `platform_instances.config` (the fact Settings writes) plus `channel_bindings`.
 * The legacy `markus.json` `integrations.feishu.notifyChatId` reader is gone, and
 * `OutboundWiringOptions` can no longer even be handed such a value — so the
 * configured fact and the consumed fact are one fact (R2, design §3).
 *
 * Exercised through the real wiring (`setupOutboundDispatch`), not a hand-built
 * lookup, so the test covers the seam that used to be the defect: the assembly
 * that decided which source fed the walk.
 */
import { describe, it, expect } from 'vitest';
import type { PlatformField } from '@markus/comms';
import { setupOutboundDispatch } from '../src/commands/outbound.js';

/** A manifest-like declaration: `notifyChatId` is a chat destination (T4's job). */
const FEISHU_FIELDS: PlatformField[] = [
  { key: 'notifyChatId', label: 'Default chat ID', type: 'text', required: false, notifyTarget: 'chat' },
];

interface DbRow {
  id: string;
  platform: string;
  config?: Record<string, unknown> | null;
}

/** A DB-shaped `platform_instances` reader backed by a mutable map — "the DB". */
function dbInstances(rows: Record<string, DbRow>) {
  return {
    findById: (id: string): DbRow | undefined => rows[id],
    listByOrg: (): DbRow[] => Object.values(rows),
  };
}

function wiringFor(db: ReturnType<typeof dbInstances>, sent: string[]) {
  const wiring = setupOutboundDispatch({
    router: {
      async sendToChannel(_platform, channelId) {
        sent.push(channelId);
        return 'm_1';
      },
    },
    bindingRepo: { listByOrg: () => [] },
    instanceRepo: db,
    fieldDefs: () => FEISHU_FIELDS,
    actionSecret: 'test-secret',
  });
  if (!wiring) throw new Error('expected the outbound dispatcher to be wired');
  return wiring;
}

const approval = (agentId = 'agt_unbound') => ({
  title: '部署到生产？',
  body: '请批准',
  severity: 'action_required' as const,
  origin: { agentId },
});

describe('outbound dispatch reads the DB (T5, single source of truth)', () => {
  it('delivers to the destination declared in `platform_instances.config`', async () => {
    const db = dbInstances({
      bi_feishu: { id: 'bi_feishu', platform: 'feishu', config: { notifyChatId: 'oc_from_db' } },
    });
    const sent: string[] = [];
    const wiring = wiringFor(db, sent);

    const outcome = await wiring.dispatcher.dispatch(approval());

    expect(outcome.delivered).toBe(true);
    expect(outcome.target?.nativeId).toBe('oc_from_db');
    expect(outcome.target?.instanceId).toBe('bi_feishu');
    expect(sent).toEqual(['oc_from_db']);
    wiring.detach();
  });

  it('follows a change to the DB config — the DB is the source, not a snapshot', async () => {
    const db = dbInstances({
      bi_feishu: { id: 'bi_feishu', platform: 'feishu', config: { notifyChatId: 'oc_before' } },
    });
    const sent: string[] = [];
    const wiring = wiringFor(db, sent);

    await wiring.dispatcher.dispatch(approval('agt_x'));
    // Settings writes the DB; the very next dispatch must honour it.
    db.findById('bi_feishu')!.config = { notifyChatId: 'oc_after' };
    await wiring.dispatcher.dispatch(approval('agt_x'));

    expect(sent).toEqual(['oc_before', 'oc_after']);
    wiring.detach();
  });

  it('is honestly `undelivered` when the DB declares no destination — never a silent drop', async () => {
    const db = dbInstances({ bi_feishu: { id: 'bi_feishu', platform: 'feishu', config: {} } });
    const sent: string[] = [];
    const wiring = wiringFor(db, sent);

    const outcome = await wiring.dispatcher.dispatch(approval('agt_x'));

    expect(outcome.delivered).toBe(false);
    expect(outcome.reason).toBe('no-notify-target');
    expect(sent).toEqual([]);
    wiring.detach();
  });

  it('has no legacy `markus.json` reader on the outbound path (R2)', async () => {
    // The `legacyNotifyTarget` option is gone: a `markus.json`
    // `integrations.feishu.notifyChatId` value has no way to reach the
    // dispatcher. With an empty DB and no binding the walk is `undelivered` even
    // though a legacy file value would previously have "delivered".
    const wiring = wiringFor(dbInstances({}), []);
    const outcome = await wiring.dispatcher.dispatch(approval('agt_x'));

    expect(outcome.delivered).toBe(false);
    expect(outcome.reason).toBe('no-notify-target');
    wiring.detach();
  });
});
