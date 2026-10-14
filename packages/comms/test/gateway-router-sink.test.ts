/**
 * Slice G4 + T2 — the router-backed sink.
 *
 * The sink's one responsibility: turn a resolved target + a rendered message into
 * one adapter call, carrying:
 *   • the **instance id** (G4 — a platform with several bots sends through the
 *     right one);
 *   • the renderer's **format** and the target's **receiveIdType** (T2 — the two
 *     facts the transport used to discard, so a card-capable platform took its
 *     card path and a user DM could be addressed instead of only a chat).
 */
import { describe, it, expect, vi } from 'vitest';
import { RouterOutboundSink } from '../src/gateway/router-sink.js';
import { MessageRouter } from '../src/router.js';
import { renderOutbound } from '../src/gateway/render.js';
import type { CommAdapter, SendOptions } from '../src/adapter.js';

const TARGET = { platform: 'telegram', instanceId: 'bi_sales', nativeId: '111', kind: 'notification' };
const RENDERED = renderOutbound({ title: 't', body: 'b', severity: 'info' }, { markdown: true });

const APPROVAL = renderOutbound(
  {
    title: '审批',
    body: '部署请求',
    severity: 'action_required',
    actions: [
      { id: 'approve', label: '批准', style: 'primary', ref: 'ref.approve' },
      { id: 'reject', label: '驳回', style: 'danger', ref: 'ref.reject' },
    ],
  },
  { cards: true },
);

describe('RouterOutboundSink', () => {
  it('sends a markdown message as text, carrying the format decision', async () => {
    const sendToChannel = vi.fn(async () => 'm_1');
    const sink = new RouterOutboundSink({
      router: { sendToChannel },
      capabilitiesOf: () => ({ markdown: true }),
    });

    const id = await sink.send(TARGET, RENDERED);
    expect(id).toBe('m_1');
    // The renderer's format choice must reach the adapter, not be discarded here.
    expect(sendToChannel).toHaveBeenCalledWith('telegram', '111', RENDERED.text, 'bi_sales', {
      format: 'markdown',
      markdown: true,
    });
  });

  it("carries format='card' and the structured card content (with signed refs) when a card was chosen", async () => {
    const sendToChannel = vi.fn(async () => 'm_card');
    const sink = new RouterOutboundSink({
      router: { sendToChannel },
      capabilitiesOf: () => ({ cards: true }),
    });

    await sink.send({ platform: 'feishu', instanceId: 'bi_feishu', nativeId: 'oc_1' }, APPROVAL);

    expect(sendToChannel).toHaveBeenCalledTimes(1);
    const [, , , , options] = sendToChannel.mock.calls[0] as [string, string, string, string, SendOptions];
    expect(options.format).toBe('card');
    // The renderer chose a card; the sink hands the adapter platform-neutral
    // content — the adapter owns the dialect (no card JSON in the gateway).
    expect(options.card).toEqual({
      title: '审批',
      body: '部署请求',
      actions: [
        { id: 'approve', label: '批准', style: 'primary', ref: 'ref.approve' },
        { id: 'reject', label: '驳回', style: 'danger', ref: 'ref.reject' },
      ],
    });
  });

  it('carries text format (no card content) when the platform can only do text', async () => {
    const sendToChannel = vi.fn(async () => 'm_t');
    const sink = new RouterOutboundSink({ router: { sendToChannel }, capabilitiesOf: () => ({}) });
    const TEXT = renderOutbound({ title: 't', body: 'b', severity: 'info' }, {});

    await sink.send(TARGET, TEXT);

    const [, , , , options] = sendToChannel.mock.calls[0] as [string, string, string, string, SendOptions];
    expect(options).toEqual({ format: 'text', markdown: false });
    expect(options.card).toBeUndefined();
  });

  it("passes the target's receiveIdType through so a user DM is addressable (R4)", async () => {
    const sendToChannel = vi.fn(async () => 'm_dm');
    const sink = new RouterOutboundSink({
      router: { sendToChannel },
      capabilitiesOf: () => ({ markdown: true }),
    });

    await sink.send(
      { platform: 'feishu', instanceId: 'bi_feishu', nativeId: 'ou_alice', receiveIdType: 'open_id' },
      RENDERED,
    );

    const [, , , , options] = sendToChannel.mock.calls[0] as [string, string, string, string, SendOptions];
    expect(options.receiveIdType).toBe('open_id');
  });

  it('reports the target capabilities', () => {
    const sink = new RouterOutboundSink({
      router: { sendToChannel: async () => undefined },
      capabilitiesOf: (platform, instanceId) => ({ cards: platform === 'slack' && instanceId === 'bi_ops' }),
    });
    expect(sink.capabilities({ platform: 'slack', instanceId: 'bi_ops', nativeId: 'C1' })).toEqual({ cards: true });
    expect(sink.capabilities({ platform: 'telegram', instanceId: 'bi_a', nativeId: '1' })).toEqual({ cards: false });
  });
});

describe('RouterOutboundSink → MessageRouter → real adapter (fake adapter acceptance)', () => {
  function fakeAdapter(platform: string): CommAdapter & { sends: Array<{ channelId: string; content: string; options?: SendOptions }> } {
    const sends: Array<{ channelId: string; content: string; options?: SendOptions }> = [];
    return {
      platform,
      sends,
      connect: async () => {},
      disconnect: async () => {},
      isConnected: () => true,
      onMessage: () => {},
      sendMessage: async (channelId, content, options) => {
        sends.push({ channelId, content, options });
        return 'native_1';
      },
      sendReply: async () => 'native_reply',
    };
  }

  it("reaches the adapter's card send path (not a text fallback) when format is 'card'", async () => {
    const router = new MessageRouter();
    const adapter = fakeAdapter('feishu');
    router.registerAdapter(adapter, 'bi_feishu');

    const sink = new RouterOutboundSink({
      router,
      capabilitiesOf: () => ({ cards: true, markdown: true }),
    });

    await sink.send({ platform: 'feishu', instanceId: 'bi_feishu', nativeId: 'oc_1', receiveIdType: 'chat_id' }, APPROVAL);

    expect(adapter.sends).toHaveLength(1);
    const sent = adapter.sends[0]!;
    expect(sent.channelId).toBe('oc_1');
    expect(sent.options?.format).toBe('card');
    expect(sent.options?.receiveIdType).toBe('chat_id');
    // The approval buttons reach the adapter as card content with intact refs.
    expect(sent.options?.card?.actions?.map((a) => a.ref)).toEqual(['ref.approve', 'ref.reject']);
  });

  it('reaches the adapter as text when the platform cannot render cards', async () => {
    const router = new MessageRouter();
    const adapter = fakeAdapter('telegram');
    router.registerAdapter(adapter, 'bi_sales');

    const sink = new RouterOutboundSink({ router, capabilitiesOf: () => ({ markdown: true }) });
    await sink.send({ platform: 'telegram', instanceId: 'bi_sales', nativeId: '111' }, RENDERED);

    expect(adapter.sends[0]!.options?.format).toBe('markdown');
    expect(adapter.sends[0]!.options?.card).toBeUndefined();
  });
});
