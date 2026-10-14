import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../src/agent.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RoleTemplate } from '@markus/shared';

// Regression: end_turn signal must never carry over between turns.
//
// Bug (2026-10-13): `endTurnRequested` was set by the end_turn tool executor but
// only reset at the start of `handleMessage` (non-streaming). A streaming turn
// that ended via end_turn left the flag set, so the NEXT streaming turn's first
// tool_use response had its whole tool loop skipped (shouldContinueToolLoop
// returns false when endTurnRequested) and resolved with an empty reply —
// which the attention layer then dropped WITHOUT retry for human_chat items.
// Symptom: consecutive chat replies silently vanished / got truncated until the
// agent process was restarted (fresh instance ⇒ flag cleared).

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-endturn-leak-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const MOCK_ROLE: RoleTemplate = {
  id: 'test-role',
  name: 'Test Role',
  description: 'Test role for end_turn leak tests',
  category: 'engineering',
  systemPrompt: 'You are a test agent.',
  defaultSkills: [],
  heartbeatChecklist: '',
  defaultPolicies: [],
  builtIn: false,
};

type StreamResponse = {
  content: string;
  finishReason: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  usage: { inputTokens: number; outputTokens: number };
};

function makeStreamAgent(script: StreamResponse[]) {
  let call = 0;
  const chatStream = vi.fn(async (_req: unknown, onEvent?: (e: unknown) => void) => {
    const resp = script[Math.min(call, script.length - 1)];
    call++;
    onEvent?.({ type: 'text_delta', text: resp.content });
    return resp;
  });
  const router = {
    chat: vi.fn(),
    chatStream,
    getActiveModelContextWindow: () => 200000,
    getActiveModelName: () => 'test-model',
    getActiveModelMaxOutput: () => 8000,
    getModelContextWindow: () => 200000,
    getModelMaxOutput: () => 8000,
    getModelCost: () => undefined,
    isCompactionSupported: () => true,
    modelSupportsVision: () => false,
    listProviders: () => ['test'],
    getProvider: () => undefined,
    getDefaultProvider: () => 'test',
    defaultProviderName: 'test',
  } as unknown as import('../src/llm/router.js').LLMRouter;

  const agent = new Agent({
    config: {
      id: 'endturn-leak-agent',
      name: 'EndTurn Leak Agent',
      role: 'worker',
      llmConfig: { provider: 'anthropic', model: 'test-model', apiKey: 'test' },
      createdAt: new Date().toISOString(),
    },
    role: MOCK_ROLE,
    llmRouter: router,
    dataDir: tempDir,
  });
  return { agent, chatStream };
}

type PrivateAgent = Agent & {
  handleMessageStream: (
    userMessage: string,
    onEvent?: (e: unknown) => void,
    senderId?: string,
    senderInfo?: unknown,
    cancelToken?: unknown,
  ) => Promise<string>;
};

describe('end_turn signal must not leak across streaming turns', () => {
  it('runs the tool loop in the turn AFTER a turn that ended via end_turn', async () => {
    const { agent, chatStream } = makeStreamAgent([
      // Turn 1: model calls end_turn — turn ends, delivers nothing (documented).
      { content: '', finishReason: 'tool_use', toolCalls: [{ id: 't1', name: 'end_turn', arguments: { reason: 'done' } }], usage: { inputTokens: 10, outputTokens: 5 } },
      // Turn 2: model requests a real tool — the loop MUST run it.
      { content: '', finishReason: 'tool_use', toolCalls: [{ id: 't2', name: 'list_directory', arguments: { path: tempDir } }], usage: { inputTokens: 10, outputTokens: 5 } },
      // Turn 2 continues: final text reply.
      { content: 'work is done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } },
    ]);

    const a = agent as PrivateAgent;
    const onEvent = () => {};

    const reply1 = await a.handleMessageStream('turn one', onEvent);
    // end_turn turn delivers nothing by design. The flag still describes THIS
    // turn until the next turn starts (see ensureTurnCompleted doc) — the
    // behavioral contract under test is that the NEXT turn's loop runs.
    expect(reply1).toBe('');

    const reply2 = await a.handleMessageStream('turn two', onEvent);
    // Per-turn reset fired at handleMessageStream entry: flag must be cleared.
    expect((agent as unknown as { endTurnRequested: boolean }).endTurnRequested).toBe(false);
    // The tool loop must have continued: a third LLM call happened and the final
    // reply is the model's text, not the empty tool-call response content.
    expect(chatStream).toHaveBeenCalledTimes(3);
    expect(reply2).toBe('work is done');
  });
});
