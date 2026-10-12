import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { SSEHandler } from '../src/sse-handler.js';

class MockResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = '';
  ended = false;
  destroyed = false;

  get writableEnded() { return this.ended; }

  writeHead(code: number, headers: Record<string, string>) {
    this.statusCode = code;
    this.headers = headers;
  }
  write(chunk: string) { this.body += chunk; return true; }
  end(chunk?: string) { if (chunk) this.body += chunk; this.ended = true; }
  setHeader() { return this; }
  destroy() { this.destroyed = true; }
}

function createAgent(overrides: Record<string, unknown> = {}) {
  return {
    sendMessageStream: vi.fn(async (_text, onEvent) => {
      onEvent({ type: 'text_delta', content: 'Hello' });
      onEvent({ type: 'thinking_delta', content: 'thinking...' });
      onEvent({ type: 'tool_call_start', tool: 'read_file', arguments: { path: '/a' } });
      onEvent({ type: 'tool_call_end', tool: 'read_file', result: 'ok' });
      onEvent({ type: 'progress', processedTokens: 3, totalTokens: 10 });
      return 'Hello world';
    }),
    getState: vi.fn(() => ({ tokensUsedToday: 12, status: 'idle' })),
    cancelActiveStream: vi.fn(),
    config: { name: 'Agent A' },
    ...overrides,
  };
}

describe('SSEHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('streams assistant reply and persists messages', async () => {
    const onComplete = vi.fn();
    const persistUser = vi.fn(async () => 'sess-1');
    const persistAssistant = vi.fn(async () => {});
    const wsBroadcaster = { broadcastChat: vi.fn(), broadcastAgentUpdate: vi.fn() };

    const handler = new SSEHandler({
      agentId: 'agent-1',
      agent: createAgent() as never,
      userText: 'Hi there',
      senderId: 'user-1',
      senderInfo: { name: 'User', role: 'owner' },
      persistUserMessage: persistUser,
      persistAssistantMessage: persistAssistant,
      wsBroadcaster,
      onComplete,
      executionStreamRepo: { append: vi.fn() },
    });

    const res = new MockResponse() as unknown as ServerResponse;
    await handler.handle(res);
    await vi.advanceTimersByTimeAsync(150);

    expect(onComplete).toHaveBeenCalled();
    expect(persistUser).toHaveBeenCalled();
    expect(persistAssistant).toHaveBeenCalled();
    expect(res.body).toContain('Hello');
  });

  it('handles stream errors via onError callback', async () => {
    const agent = createAgent({
      sendMessageStream: vi.fn(async () => { throw new Error('stream failed'); }),
    });
    const onError = vi.fn(async () => {});
    const handler = new SSEHandler({
      agentId: 'agent-1',
      agent: agent as never,
      userText: 'Hi',
      onError,
    });

    const res = new MockResponse() as unknown as ServerResponse;
    await handler.handle(res);
    expect(onError).toHaveBeenCalled();
  });

  it('does not re-mark isStreaming after stream error + SSE close', async () => {
    const agent = createAgent({
      sendMessageStream: vi.fn(async () => {
        throw new Error('MARKUS_UPSTREAM_ERROR: HTTP 402');
      }),
    });
    const persistAssistant = vi.fn(async () => {});
    const persistUser = vi.fn(async () => 'sess-err');
    const handler = new SSEHandler({
      agentId: 'agent-1',
      agent: agent as never,
      userText: 'draw a selfie',
      persistUserMessage: persistUser,
      persistAssistantMessage: persistAssistant,
      onError: vi.fn(async () => {}),
    });

    const res = new MockResponse() as unknown as ServerResponse;
    await handler.handle(res);
    // handleError schedules sseBuffer.close() after 100ms — that used to race
    // and rewrite metadata with isStreaming:true.
    await vi.advanceTimersByTimeAsync(200);

    expect(persistAssistant).toHaveBeenCalled();
    const lastMeta = persistAssistant.mock.calls.at(-1)?.[4] as { isStreaming?: boolean; isError?: boolean };
    expect(lastMeta?.isStreaming).toBe(false);
    expect(lastMeta?.isError).toBe(true);
    const streamingWrites = persistAssistant.mock.calls.filter(
      (c) => (c[4] as { isStreaming?: boolean })?.isStreaming === true,
    );
    expect(streamingWrites).toHaveLength(0);
  });

  it('rejects concurrent handle calls', async () => {
    const agent = createAgent({
      sendMessageStream: vi.fn(() => new Promise(() => {})),
    });
    const handler = new SSEHandler({
      agentId: 'agent-1',
      agent: agent as never,
      userText: 'Hi',
    });
    const res = new MockResponse() as unknown as ServerResponse;
    void handler.handle(res);
    await Promise.resolve();
    await expect(handler.handle(res)).rejects.toThrow('already processing');
  });

  it('handles resume stream with existing session', async () => {
    const handler = new SSEHandler({
      agentId: 'agent-1',
      agent: createAgent() as never,
      userText: '',
      sessionId: 'sess-existing',
      isResume: true,
      persistAssistantMessage: vi.fn(async () => {}),
    });
    const res = new MockResponse() as unknown as ServerResponse;
    await handler.handle(res);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('progress-aware disconnect grace: keeps a busy detached agent alive, stops a silent one', async () => {
    // The agent keeps working after the client leaves. The old fixed 45-min deadline
    // killed it regardless; the new rule only force-stops after SILENCE for the window.
    let capturedToken: { cancelled: boolean; userStopped?: boolean } | undefined;
    let progressAt = Date.now();
    const agent = createAgent({
      sendMessageStream: vi.fn(async (_text, onEvent, _senderId, _info, token) => {
        capturedToken = token as { cancelled: boolean; userStopped?: boolean };
        onEvent({ type: 'text_delta', content: 'working' });
        return new Promise<string>(() => { /* never settles */ });
      }),
      getState: vi.fn(() => ({
        tokensUsedToday: 0,
        status: 'working',
        lastProgressAt: new Date(progressAt).toISOString(),
      })),
    });
    const handler = new SSEHandler({ agentId: 'a', agent: agent as never, userText: 'go' });
    const res = new MockResponse();
    void handler.handle(res as unknown as ServerResponse);
    await vi.advanceTimersByTimeAsync(0);

    // Client detaches.
    res.emit('close');
    expect(capturedToken).toBeDefined();
    expect(capturedToken?.userStopped).toBeFalsy();

    // 30 min of silence → within the 45-min window → still alive.
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(capturedToken?.userStopped).toBeFalsy();

    // A fresh progress event resets the clock; another 30 min pass → 60 min total
    // elapsed (well beyond the window) but never killed while progressing.
    progressAt = Date.now();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(capturedToken?.userStopped).toBeFalsy();

    // Now go silent for the window → force-stop.
    await vi.advanceTimersByTimeAsync(46 * 60_000);
    expect(capturedToken?.userStopped).toBe(true);
    expect(capturedToken?.cancelled).toBe(true);
  });
});
