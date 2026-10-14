import { createServer, request as httpRequestRaw } from 'node:http';
import { SlackAdapter } from '../src/slack/adapter.js';

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(err => (err ? reject(err) : resolve(port)));
    });
  });
}

async function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequestRaw(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: body
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers }
          : headers,
      },
      res => {
        let text = '';
        res.on('data', chunk => {
          text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function makeMockSlackClient() {
  return {
    sendTextMessage: vi.fn().mockResolvedValue('1234.5678'),
    sendBlocksMessage: vi.fn().mockResolvedValue('1234.5679'),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    verifySignature: vi.fn().mockReturnValue(true),
  };
}

describe('SlackAdapter', () => {
  let adapter: SlackAdapter;

  beforeEach(() => {
    adapter = new SlackAdapter();
    const mockClient = makeMockSlackClient();
    (adapter as Record<string, unknown>)['client'] = mockClient;
    (adapter as Record<string, unknown>)['config'] = {
      platform: 'slack',
      botToken: 'xoxb-test',
      signingSecret: 'secret',
    };
    (adapter as Record<string, unknown>)['connected'] = true;
  });

  it('has platform slack', () => {
    expect(adapter.platform).toBe('slack');
  });

  it('sendMessage delegates to client with thread option', async () => {
    const id = await adapter.sendMessage('C123', 'Hello', { threadId: '1111.2222' });
    expect(id).toBe('1234.5678');
    const client = (adapter as Record<string, unknown>)['client'] as ReturnType<typeof makeMockSlackClient>;
    expect(client.sendTextMessage).toHaveBeenCalledWith('C123', 'Hello', { thread_ts: '1111.2222' });
  });

  it('sendMessage renders markdown as Slack mrkdwn when markdown is enabled', async () => {
    await adapter.sendMessage('C123', '**bold** and [x](https://y.z)', { markdown: true });
    const client = (adapter as Record<string, unknown>)['client'] as ReturnType<typeof makeMockSlackClient>;
    expect(client.sendTextMessage).toHaveBeenCalledWith('C123', '*bold* and <https://y.z|x>', {});
  });

  it('sendMessage sends verbatim without the markdown flag', async () => {
    await adapter.sendMessage('C123', '**bold**');
    const client = (adapter as Record<string, unknown>)['client'] as ReturnType<typeof makeMockSlackClient>;
    expect(client.sendTextMessage).toHaveBeenCalledWith('C123', '**bold**', {});
  });

  it('sendReply sets thread_ts', async () => {
    const id = await adapter.sendReply('C123', '1111.2222', 'Reply');
    expect(id).toBe('1234.5678');
    const client = (adapter as Record<string, unknown>)['client'] as ReturnType<typeof makeMockSlackClient>;
    expect(client.sendTextMessage).toHaveBeenCalledWith('C123', 'Reply', {
      thread_ts: '1111.2222',
      reply_broadcast: false,
    });
  });

  it('sendMessage throws when not connected', async () => {
    (adapter as Record<string, unknown>)['client'] = undefined;
    await expect(adapter.sendMessage('C123', 'hi')).rejects.toThrow('Slack adapter not connected');
  });

  it('sendBlocks delegates to client', async () => {
    const blocks = [{ type: 'section', text: { type: 'plain_text', text: 'Hi' } }];
    const id = await adapter.sendBlocks('C123', blocks, 'fallback');
    expect(id).toBe('1234.5679');
  });

  it("sendMessage builds a Block Kit card (header + body + buttons) when format is 'card'", async () => {
    const client = (adapter as Record<string, unknown>)['client'] as ReturnType<typeof makeMockSlackClient>;
    const id = await adapter.sendMessage('C123', 'plain projection', {
      format: 'card',
      markdown: true,
      card: {
        title: '审批请求',
        body: '请批准部署',
        actions: [
          { id: 'approve', label: '批准', style: 'primary', ref: 'signed.ref.1' },
          { id: 'reject', label: '驳回', style: 'danger', ref: 'signed.ref.2' },
        ],
      },
    });

    expect(id).toBe('1234.5679');
    // The card took the blocks path — not a text fallback.
    expect(client.sendTextMessage).not.toHaveBeenCalled();
    const [channel, blocks] = client.sendBlocksMessage.mock.calls[0] as [string, Array<Record<string, unknown>>, string];
    expect(channel).toBe('C123');
    expect(blocks[0]).toMatchObject({ type: 'header', text: { text: '审批请求' } });
    const actionRow = blocks.find((b) => b['type'] === 'actions') as { elements: Array<Record<string, unknown>> };
    // Buttons carry the signed ref as their value; the approval id is not present.
    expect(actionRow.elements.map((e) => e['value'])).toEqual(['signed.ref.1', 'signed.ref.2']);
    expect(JSON.stringify(blocks)).not.toContain('apr_');
  });

  it('sendMessage stays on the text path when format is not card', async () => {
    const client = (adapter as Record<string, unknown>)['client'] as ReturnType<typeof makeMockSlackClient>;
    await adapter.sendMessage('C123', 'Hello', { format: 'markdown', markdown: true });
    expect(client.sendBlocksMessage).not.toHaveBeenCalled();
    expect(client.sendTextMessage).toHaveBeenCalled();
  });

  it('routes a Block Kit button tap to the action port with the signed ref intact', async () => {
    const received: unknown[] = [];
    adapter.onAction(async (action) => {
      received.push(action);
    });

    await (adapter as unknown as { processInteractive(p: Record<string, unknown>): Promise<void> }).processInteractive({
      type: 'block_actions',
      user: { id: 'U_ALICE' },
      actions: [{ action_id: 'approve', value: 'signed.ref.9' }],
    });

    expect(received).toHaveLength(1);
    const action = received[0] as { platform: string; actorId?: string; payload: { value: { ref: string; action?: string } } };
    expect(action.platform).toBe('slack');
    expect(action.actorId).toBe('U_ALICE');
    expect(action.payload.value).toEqual({ ref: 'signed.ref.9', action: 'approve' });
  });

  it('ignores a non-block_actions interactive payload', async () => {
    const received: unknown[] = [];
    adapter.onAction(async (a) => received.push(a));
    await (adapter as unknown as { processInteractive(p: Record<string, unknown>): Promise<void> }).processInteractive({
      type: 'view_submission',
    });
    expect(received).toHaveLength(0);
  });

  it('updateMessage delegates to client', async () => {
    await adapter.updateMessage('C123', '1234.5678', 'updated');
    const client = (adapter as Record<string, unknown>)['client'] as ReturnType<typeof makeMockSlackClient>;
    expect(client.updateMessage).toHaveBeenCalledWith('C123', '1234.5678', 'updated', undefined);
  });

  it('deleteMessage delegates to client', async () => {
    await adapter.deleteMessage('C123', '1234.5678');
    const client = (adapter as Record<string, unknown>)['client'] as ReturnType<typeof makeMockSlackClient>;
    expect(client.deleteMessage).toHaveBeenCalledWith('C123', '1234.5678');
  });

  it('connect authenticates via auth.test', async () => {
    const fresh = new SlackAdapter();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ json: async () => ({ ok: true, team: 'T1' }) }),
    );
    await fresh.connect({
      platform: 'slack',
      botToken: 'xoxb-test',
      signingSecret: 'secret',
    });
    expect(fresh.isConnected()).toBe(true);
    vi.unstubAllGlobals();
  });

  it('connect throws on auth failure', async () => {
    const fresh = new SlackAdapter();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ json: async () => ({ ok: false, error: 'invalid_auth' }) }),
    );
    await expect(
      fresh.connect({ platform: 'slack', botToken: 'bad', signingSecret: 'secret' }),
    ).rejects.toThrow('Slack API error: invalid_auth');
    vi.unstubAllGlobals();
  });

  it('isConnected reflects connection state', () => {
    expect(adapter.isConnected()).toBe(true);
    (adapter as Record<string, unknown>)['connected'] = false;
    expect(adapter.isConnected()).toBe(false);
  });

  it('disconnect clears connection state', async () => {
    await adapter.disconnect();
    expect(adapter.isConnected()).toBe(false);
  });

  it('sendMessage propagates client errors', async () => {
    const client = (adapter as Record<string, unknown>)['client'] as ReturnType<typeof makeMockSlackClient>;
    client.sendTextMessage = vi.fn().mockRejectedValue(new Error('rate limited'));
    await expect(adapter.sendMessage('C123', 'hi')).rejects.toThrow('rate limited');
  });

  it('sendReply throws when not connected', async () => {
    (adapter as Record<string, unknown>)['client'] = undefined;
    await expect(adapter.sendReply('C123', '1111.2222', 'Reply')).rejects.toThrow(
      'Slack adapter not connected',
    );
  });

  it('connect warns when no webhookPort configured', async () => {
    const fresh = new SlackAdapter();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ json: async () => ({ ok: true, team: 'T1' }) }),
    );
    await fresh.connect({
      platform: 'slack',
      botToken: 'xoxb-test',
      signingSecret: 'secret',
    });
    expect(fresh.isConnected()).toBe(true);
    vi.unstubAllGlobals();
  });

  it('connect requires an appToken for Socket Mode (no webhookPort needed)', async () => {
    const fresh = new SlackAdapter();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ json: async () => ({ ok: true }) }),
    );
    // Socket Mode no longer needs a webhookPort — it needs the app-level token.
    await expect(
      fresh.connect({
        platform: 'slack',
        botToken: 'xoxb-test',
        signingSecret: 'secret',
        socketMode: true,
      }),
    ).rejects.toThrow('Slack Socket Mode requires an appToken');
    vi.unstubAllGlobals();
  });

  describe('webhook server', () => {
    let port: number;

    beforeEach(async () => {
      port = await getFreePort();
    });

    it('GET returns active endpoint message', async () => {
      const fresh = new SlackAdapter();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ json: async () => ({ ok: true, team: 'T1' }) }),
      );
      await fresh.connect({
        platform: 'slack',
        botToken: 'xoxb-test',
        signingSecret: 'secret',
        webhookPort: port,
      });

      const res = await httpRequest(port, 'GET', '/webhook/slack');
      expect(res.status).toBe(200);
      expect(res.text).toContain('active');
      await fresh.disconnect();
      vi.unstubAllGlobals();
    });

    it('POST url_verification returns challenge', async () => {
      const fresh = new SlackAdapter();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ json: async () => ({ ok: true, team: 'T1' }) }),
      );
      await fresh.connect({
        platform: 'slack',
        botToken: 'xoxb-test',
        signingSecret: '',
        webhookPort: port,
      });

      const body = JSON.stringify({ type: 'url_verification', challenge: 'challenge-token' });
      const res = await httpRequest(port, 'POST', '/webhook/slack', body);
      expect(res.status).toBe(200);
      expect(res.text).toBe('challenge-token');
      await fresh.disconnect();
      vi.unstubAllGlobals();
    });

    it('POST event_callback delivers message to handler', async () => {
      const fresh = new SlackAdapter();
      const handler = vi.fn().mockResolvedValue(undefined);
      fresh.onMessage(handler);

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ json: async () => ({ ok: true, team: 'T1' }) }),
      );
      await fresh.connect({
        platform: 'slack',
        botToken: 'xoxb-test',
        signingSecret: '',
        webhookPort: port,
      });

      const body = JSON.stringify({
        type: 'event_callback',
        event: {
          type: 'message',
          channel: 'C123',
          user: 'U456',
          text: 'Hello <@BOT123> world',
          ts: '1111.2222',
        },
      });
      const res = await httpRequest(port, 'POST', '/webhook/slack', body);
      expect(res.status).toBe(200);
      await new Promise(r => setTimeout(r, 50));
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].content.text).toBe('Hello  world');
      await fresh.disconnect();
      vi.unstubAllGlobals();
    });

    it('POST rejects bad signature when signingSecret configured', async () => {
      const fresh = new SlackAdapter();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ json: async () => ({ ok: true, team: 'T1' }) }),
      );
      await fresh.connect({
        platform: 'slack',
        botToken: 'xoxb-test',
        signingSecret: 'my-secret',
        webhookPort: port,
      });

      const body = JSON.stringify({ type: 'url_verification', challenge: 'x' });
      const res = await httpRequest(port, 'POST', '/webhook/slack', body, {
        'x-slack-signature': 'v0=invalid',
        'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
      });
      expect(res.status).toBe(403);
      await fresh.disconnect();
      vi.unstubAllGlobals();
    });

    it('POST returns 404 for unknown path', async () => {
      const fresh = new SlackAdapter();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ json: async () => ({ ok: true, team: 'T1' }) }),
      );
      await fresh.connect({
        platform: 'slack',
        botToken: 'xoxb-test',
        signingSecret: 'secret',
        webhookPort: port,
      });

      const res = await httpRequest(port, 'GET', '/unknown');
      expect(res.status).toBe(404);
      await fresh.disconnect();
      vi.unstubAllGlobals();
    });

    it('sendBlocks throws when not connected', async () => {
      (adapter as Record<string, unknown>)['client'] = undefined;
      await expect(adapter.sendBlocks('C123', [], 'fallback')).rejects.toThrow(
        'Slack adapter not connected',
      );
    });

    it('updateMessage throws when not connected', async () => {
      (adapter as Record<string, unknown>)['client'] = undefined;
      await expect(adapter.updateMessage('C123', '1234.5678', 'text')).rejects.toThrow(
        'Slack adapter not connected',
      );
    });
  });
});
