/**
 * Drift guard: `config.remote.mode` (shared) MUST equal the frozen
 * `REMOTE_ENDPOINT_KINDS` (remote contract).
 *
 * WHY this test exists: `@markus/shared` sits BELOW `@markus/remote` in the
 * dependency graph, so it physically cannot import the contract constant — it
 * declares `REMOTE_TUNNEL_MODES` locally. That is two representations of one
 * fact, so we pin them together here: change either list and this goes red.
 */
import { describe, expect, it } from 'vitest';
import { REMOTE_TUNNEL_MODES } from '@markus/shared';
import { REMOTE_ENDPOINT_KINDS, REMOTE_MODES } from '../src/contract.js';

describe('config.remote mode ⇄ contract endpoint kinds (drift guard)', () => {
  it('REMOTE_TUNNEL_MODES is byte-identical to REMOTE_ENDPOINT_KINDS', () => {
    expect([...REMOTE_TUNNEL_MODES]).toEqual([...REMOTE_ENDPOINT_KINDS]);
  });

  it('every config mode is a valid contract mode (no rogue value)', () => {
    for (const mode of REMOTE_TUNNEL_MODES) {
      expect(REMOTE_MODES).toContain(mode);
    }
  });

  it('relay_legacy is NOT a selectable config mode (it is a fallback, not a channel)', () => {
    expect(REMOTE_MODES).toContain('relay_legacy');
    expect([...REMOTE_TUNNEL_MODES]).not.toContain('relay_legacy');
  });
});
