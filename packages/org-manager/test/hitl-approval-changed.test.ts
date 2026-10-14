import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HITLService } from '../src/hitl-service.js';
import type { ApprovalRequest } from '../src/hitl-service.js';

/**
 * The defect these guard: an approval decided from an *external* surface (a
 * Feishu card tap, or the expiry timer) changed authoritative state without
 * telling anyone. The in-app chat banner is derived from the pending-approval
 * list, so with no signal it lingered forever — the user saw a still-actionable
 * approval that had already been settled.
 *
 * The fix is structural: the *terminal transition itself* emits, so every writer
 * (HTTP API, in-process platform action, expiry) is covered by construction —
 * not just the one path someone remembered to wire.
 */
describe('HITLService.onApprovalChanged', () => {
  let service: HITLService;

  beforeEach(() => {
    service = new HITLService();
  });

  const request = (over: Partial<Parameters<HITLService['requestApproval']>[0]> = {}) =>
    service.requestApproval({
      agentId: 'agt_1',
      agentName: 'CTO',
      type: 'action',
      title: 'Deploy?',
      description: 'app v2 ready',
      ...over,
    });

  it('does NOT fire on creation — only on a terminal transition', () => {
    const seen: ApprovalRequest[] = [];
    service.onApprovalChanged((a) => seen.push(a));

    request();

    expect(seen).toHaveLength(0);
  });

  it('fires on respondToApproval with the terminal record', () => {
    const seen: ApprovalRequest[] = [];
    service.onApprovalChanged((a) => seen.push(a));
    const apr = request();

    service.respondToApproval(apr.id, true, 'ou_boss', undefined, 'approve');

    expect(seen).toHaveLength(1);
    expect(seen[0]!.id).toBe(apr.id);
    expect(seen[0]!.status).toBe('approved');
    expect(seen[0]!.respondedBy).toBe('ou_boss');
  });

  it('fires on cancelApproval', () => {
    const seen: ApprovalRequest[] = [];
    service.onApprovalChanged((a) => seen.push(a));
    const apr = request();

    service.cancelApproval(apr.id, 'system');

    expect(seen).toHaveLength(1);
    expect(seen[0]!.status).toBe('cancelled');
  });

  it('fires on expiry', () => {
    vi.useFakeTimers();
    try {
      const seen: ApprovalRequest[] = [];
      service.onApprovalChanged((a) => seen.push(a));
      void service.requestApprovalAndWait({
        agentId: 'agt_1',
        agentName: 'CTO',
        type: 'action',
        title: 'Deploy?',
        description: 'app v2 ready',
        expiresInMs: 1000,
      });

      vi.advanceTimersByTime(1001);

      expect(seen).toHaveLength(1);
      expect(seen[0]!.status).toBe('expired');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fire on a re-tap of an already-terminal approval (idempotent ignore)', () => {
    const seen: ApprovalRequest[] = [];
    service.onApprovalChanged((a) => seen.push(a));
    const apr = request();
    service.respondToApproval(apr.id, true, 'ou_boss');

    // Second decision on a non-pending approval is a no-op — and must not emit
    // a second time (else every re-tap would churn every client's refresh).
    service.respondToApproval(apr.id, false, 'ou_someone');

    expect(seen).toHaveLength(1);
  });

  it('unsubscribes cleanly', () => {
    const seen: ApprovalRequest[] = [];
    const off = service.onApprovalChanged((a) => seen.push(a));
    off();

    const apr = request();
    service.respondToApproval(apr.id, true, 'ou_boss');

    expect(seen).toHaveLength(0);
  });
});
