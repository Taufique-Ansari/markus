/**
 * The inbound half of the approval loop (messaging-gateway.md §6.5).
 *
 * Defect it guards: a Feishu approval-card tap "did nothing". The gateway signs
 * each card action into `ref` when `MARKUS_ACTION_SECRET` is set, and falls back
 * to the **bare approval id** in `ref` when it is not (the documented pre-G4
 * behaviour). `resolveCardActionValue` is the ONE reader of that contract: however
 * the gateway emitted the ref, a tap must resolve back to {approvalId, command}.
 *
 * Before this existed the two halves disagreed — the outbound emitted a bare id in
 * `ref`, but the inbound only looked at `value.approvalId` (a field the Feishu card
 * never carries) and dropped every tap with "did not resolve to an approval".
 */
import { describe, it, expect } from 'vitest';
import { signActionRef, resolveCardActionValue } from '../src/index.ts';

const SECRET = 'test-secret';

describe('resolveCardActionValue — the inbound card-action contract', () => {
  it('verifies a signed ref and returns its approval + command', () => {
    const ref = signActionRef({ approvalId: 'apr_1', action: 'ok' }, SECRET);
    expect(resolveCardActionValue({ ref, action: 'ok' }, SECRET)).toEqual({
      approvalId: 'apr_1',
      command: 'ok',
      unverified: false,
    });
  });

  it('accepts the BARE approval id the gateway emits when no secret is set', () => {
    // Outbound (no secret) puts the raw id in `ref`; the inbound must read it back.
    expect(resolveCardActionValue({ ref: 'apr_bare', action: 'approve' })).toEqual({
      approvalId: 'apr_bare',
      command: 'approve',
      unverified: true,
    });
  });

  it('reads the raw id from `token` too (platform-neutral ref field)', () => {
    expect(resolveCardActionValue({ token: 'apr_tok', action: 'reject' })).toEqual({
      approvalId: 'apr_tok',
      command: 'reject',
      unverified: true,
    });
  });

  it('fails closed on a forged/tampered ref when a secret is set', () => {
    const ref = signActionRef({ approvalId: 'apr_1', action: 'ok' }, 'other-secret');
    expect(resolveCardActionValue({ ref, action: 'ok' }, SECRET)).toEqual({
      unverified: false,
    });
  });

  it('still accepts a directly-posted approvalId (no ref)', () => {
    expect(resolveCardActionValue({ approvalId: 'apr_2', action: 'reject' })).toEqual({
      approvalId: 'apr_2',
      command: 'reject',
      unverified: false,
    });
  });

  it('resolves to nothing when neither a ref nor an approvalId is present', () => {
    expect(resolveCardActionValue({})).toEqual({ unverified: false });
    expect(resolveCardActionValue(undefined)).toEqual({ unverified: false });
  });
});
