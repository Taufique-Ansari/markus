import { describe, it, expect } from 'vitest';
import {
  REMOTE_CONTRACT_VERSION,
  REMOTE_ENDPOINT_KINDS,
  REMOTE_ENDPOINT_HEALTH,
  REMOTE_MODES,
  REMOTE_STATES,
  ENTRY_STATUSES,
  REMOTE_ERROR_CODES,
  VERIFY_FAILURE_REASONS,
  SSRF_BLOCKED_CIDRS,
  SIGNATURE_HEADERS,
  SIGNATURE_SCHEME,
  SIGNATURE_MAX_SKEW_SECONDS,
  SIGNATURE_NONCE_MIN_LENGTH,
  buildRotationCanonicalString,
  DEFAULT_VERIFY_PATH,
  PUBLIC_URL_MAX_LENGTH,
  MAX_ENDPOINTS_PER_USER,
  VERIFY_FETCH_TIMEOUT_MS,
  VERIFY_MAX_REDIRECTS,
  VERIFY_RESPONSE_MAX_BYTES,
} from '../src/contract.js';

/**
 * The contract is a SINGLE SOURCE OF TRUTH. These assertions freeze the exact
 * values the downstream tasks (T2–T10) build against, so any accidental drift
 * (renaming an enum member, dropping a CIDR, changing the canonical string)
 * fails loudly instead of silently diverging from the doc.
 */
describe('remote-access contract (frozen)', () => {
  it('declares a contract version', () => {
    expect(REMOTE_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  describe('enumerations are frozen', () => {
    it('endpoint kinds are exactly the 5 frozen values', () => {
      expect(REMOTE_ENDPOINT_KINDS).toEqual([
        'cloudflare_quick',
        'cloudflare_named',
        'tailscale_funnel',
        'tailscale_serve',
        'custom',
      ]);
    });

    it('health values are exactly unknown|up|down', () => {
      expect(REMOTE_ENDPOINT_HEALTH).toEqual(['unknown', 'up', 'down']);
    });

    it('modes = endpoint kinds + relay_legacy (superset, no drift)', () => {
      expect(REMOTE_MODES).toEqual([...REMOTE_ENDPOINT_KINDS, 'relay_legacy']);
      for (const kind of REMOTE_ENDPOINT_KINDS) {
        expect(REMOTE_MODES).toContain(kind);
      }
    });

    it('states are exactly the 7 frozen values', () => {
      expect(REMOTE_STATES).toEqual([
        'idle',
        'installing',
        'starting',
        'verifying',
        'ready',
        'degraded',
        'error',
      ]);
    });

    it('entry statuses are exactly inactive|pending|down|ready', () => {
      expect(ENTRY_STATUSES).toEqual(['inactive', 'pending', 'down', 'ready']);
    });
  });

  describe('error + failure codes', () => {
    it('error codes are unique and non-empty', () => {
      expect(REMOTE_ERROR_CODES.length).toBeGreaterThan(0);
      expect(new Set(REMOTE_ERROR_CODES).size).toBe(REMOTE_ERROR_CODES.length);
    });

    it('verify failure reasons are unique and include the SSRF + mismatch cases', () => {
      expect(new Set(VERIFY_FAILURE_REASONS).size).toBe(VERIFY_FAILURE_REASONS.length);
      expect(VERIFY_FAILURE_REASONS).toContain('blocked_target');
      expect(VERIFY_FAILURE_REASONS).toContain('token_mismatch');
      expect(VERIFY_FAILURE_REASONS).toContain('non_https');
    });
  });

  describe('security constants (S3/S4/S5)', () => {
    it('SSRF denylist is the complete §3.4 set', () => {
      expect(SSRF_BLOCKED_CIDRS).toEqual([
        '0.0.0.0/8',
        '10.0.0.0/8',
        '127.0.0.0/8',
        '169.254.0.0/16',
        '172.16.0.0/12',
        '192.168.0.0/16',
        '100.64.0.0/10',
        '::1/128',
        'fc00::/7',
        '::ffff:0:0/96',
        '64:ff9b::/96',
      ]);
    });

    it('signature header names + scheme are frozen', () => {
      expect(SIGNATURE_HEADERS).toEqual({
        timestamp: 'x-markus-timestamp',
        nonce: 'x-markus-nonce',
        signature: 'x-markus-signature',
      });
      expect(SIGNATURE_SCHEME).toBe('v1');
      expect(SIGNATURE_MAX_SKEW_SECONDS).toBe(300);
      expect(SIGNATURE_NONCE_MIN_LENGTH).toBe(16);
    });

    it('URL + probe limits are frozen', () => {
      expect(PUBLIC_URL_MAX_LENGTH).toBe(512);
      expect(DEFAULT_VERIFY_PATH).toBe('/api/remote/verify');
      expect(VERIFY_FETCH_TIMEOUT_MS).toBe(5000);
      expect(VERIFY_MAX_REDIRECTS).toBe(3);
      expect(VERIFY_RESPONSE_MAX_BYTES).toBe(65536);
      expect(MAX_ENDPOINTS_PER_USER).toBeGreaterThan(0);
    });
  });

  describe('rotation canonical string (normative algorithm)', () => {
    const base = {
      method: 'patch',
      path: '/api/remote/endpoints/ep_1',
      bodyHash: 'abc123',
      timestamp: '1700000000',
      nonce: 'nonce0123456789ab',
    };

    it('is a 6-line LF-joined string with uppercased method', () => {
      expect(buildRotationCanonicalString(base)).toBe(
        ['v1', 'PATCH', '/api/remote/endpoints/ep_1', 'abc123', '1700000000', 'nonce0123456789ab'].join('\n'),
      );
    });

    it('is deterministic and separator-ambiguous-proof (no trailing newline)', () => {
      const a = buildRotationCanonicalString(base);
      const b = buildRotationCanonicalString({ ...base });
      expect(a).toBe(b);
      expect(a.endsWith('\n')).toBe(false);
      expect(a.split('\n')).toHaveLength(6);
    });

    it('changes if any signed field changes (no field is silently dropped)', () => {
      const variants = [
        { ...base, method: 'post' },
        { ...base, path: '/api/remote/endpoints/ep_2' },
        { ...base, bodyHash: 'def456' },
        { ...base, timestamp: '1700000001' },
        { ...base, nonce: 'nonce0123456789ac' },
      ];
      for (const v of variants) {
        expect(buildRotationCanonicalString(v)).not.toBe(buildRotationCanonicalString(base));
      }
    });
  });
});
