/**
 * One inbound message must reach the agent **exactly once**, no matter how many
 * times the bot's transport reconnected.
 *
 * Regression for the "one Feishu message → two replies" defect.
 *
 * The router re-wires a bot on every (re)connect, and every adapter implements
 * `onMessage` as an **append** (`this.handlers.push(handler)`) so a platform can
 * fan out to several consumers. The two were never reconciled: reconnecting the
 * same adapter appended a *second* copy of the router's handler, and
 * `processMessageEvent` then iterated both — dispatching the same message twice,
 * so the agent answered twice. Reconnects are routine (a saved Settings change,
 * a connection test) and a Feishu long connection reconnects on its own, so the
 * duplicate was guaranteed to appear in normal use.
 *
 * The stub here mirrors the real adapter contract (append, not replace) — a
 * replace-style stub would hide the defect.
 */
import { MessageRouter } from '../src/router.js';
import type { CommAdapter, CommAdapterConfig } from '../src/adapter.js';
import type { Message } from '@markus/shared';

/** A stub whose `onMessage`/`onAction` **append**, exactly like the real adapters. */
function appendingAdapter(platform: string) {
  const handlers: Array<(message: Message) => Promise<void>> = [];
  const adapter = {
    platform,
    connect: vi.fn(async (_config: CommAdapterConfig) => {}),
    disconnect: vi.fn(async () => {}),
    sendMessage: vi.fn(async (_channelId: string, content: string) => `msg:${content}`),
    sendReply: vi.fn(async (_channelId: string, _replyToId: string, content: string) => `reply:${content}`),
    onMessage: vi.fn((h: (message: Message) => Promise<void>) => {
      handlers.push(h);
    }),
    isConnected: vi.fn(() => true),
    /** How many handlers are wired — the thing that used to grow without bound. */
    handlerCount: () => handlers.length,
    /** Every wired handler receives the delivery, as `processMessageEvent` does. */
    async deliver(message: Message) {
      for (const h of handlers) await h(message);
    },
  };
  return adapter as unknown as CommAdapter & typeof adapter;
}

function inbound(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    platform: 'feishu',
    direction: 'inbound',
    channelId: 'oc_1',
    senderId: 'ou_1',
    senderName: 'User',
    agentId: '',
    content: { type: 'text', text: 'hello' },
    timestamp: new Date().toISOString(),
    instanceId: 'bi_feishu_1',
    ...overrides,
  };
}

describe('MessageRouter — a reconnect must not duplicate inbound delivery', () => {
  it('routes one inbound message exactly once after a reconnect', async () => {
    const router = new MessageRouter();
    const adapter = appendingAdapter('feishu');
    router.registerAdapter(adapter, 'bi_feishu_1');
    router.bindPlatformAgent('agt_x', 'feishu');

    const seen: string[] = [];
    router.setAgentHandler(async (_target, message) => {
      seen.push(message.id);
      return 'pong';
    });

    await router.connectAll([{ platform: 'feishu', instanceId: 'bi_feishu_1' }]);
    // The routine reconnect: a Settings save, a connection test, or the SDK
    // re-establishing its long connection.
    await router.connectInstance('bi_feishu_1', { platform: 'feishu', instanceId: 'bi_feishu_1' });

    await adapter.deliver(inbound());

    expect(seen).toEqual(['m1']);
    expect(adapter.handlerCount()).toBe(1);
  });

  it('stays at one handler across many reconnects', async () => {
    const router = new MessageRouter();
    const adapter = appendingAdapter('feishu');
    router.registerAdapter(adapter, 'bi_feishu_1');
    router.bindPlatformAgent('agt_x', 'feishu');
    router.setAgentHandler(async () => 'pong');

    await router.connectAll([{ platform: 'feishu', instanceId: 'bi_feishu_1' }]);
    for (let i = 0; i < 5; i++) {
      await router.connectInstance('bi_feishu_1', { platform: 'feishu', instanceId: 'bi_feishu_1' });
    }

    expect(adapter.handlerCount()).toBe(1);
  });

  it('answers once per inbound message, not once per reconnect', async () => {
    const router = new MessageRouter();
    const adapter = appendingAdapter('feishu');
    router.registerAdapter(adapter, 'bi_feishu_1');
    router.bindPlatformAgent('agt_x', 'feishu');
    router.setAgentHandler(async () => 'pong');

    await router.connectAll([{ platform: 'feishu', instanceId: 'bi_feishu_1' }]);
    await router.connectInstance('bi_feishu_1', { platform: 'feishu', instanceId: 'bi_feishu_1' });

    await adapter.deliver(inbound());

    // Two replies in the group was the user-visible symptom: the router replied
    // through the adapter once per accumulated handler.
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    expect(adapter.sendReply).not.toHaveBeenCalled();
  });

  it('still wires two bots of one platform independently', async () => {
    const router = new MessageRouter();
    const first = appendingAdapter('feishu');
    const second = appendingAdapter('feishu');
    router.registerAdapter(first, 'bi_feishu_1');
    router.registerAdapter(second, 'bi_feishu_2');
    router.bindPlatformAgent('agt_x', 'feishu');
    router.setAgentHandler(async () => 'pong');

    await router.connectAll([
      { platform: 'feishu', instanceId: 'bi_feishu_1' },
      { platform: 'feishu', instanceId: 'bi_feishu_2' },
    ]);

    expect(first.handlerCount()).toBe(1);
    expect(second.handlerCount()).toBe(1);
  });
});
