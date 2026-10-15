import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  HUB_TOKEN_ENV_KEY,
  ENTRY_HOST_SUFFIX,
  buildEntryUrl,
  hubUsernameFromToken,
  endpointSecretEnvKey,
  persistEndpointSecret,
  readEndpointSecret,
  clearEndpointSecret,
  persistHubToken,
  resolveHubToken,
  legacyHubTokenPath,
} from '../src/remote-secrets.js';

let home: string;
let prevHome: string | undefined;

function markusJsonPath(): string {
  return join(home, 'markus.json');
}
function envPath(): string {
  return join(home, '.env');
}

const SECRET_MARKER = 's3cr3t-should-never-be-in-markus-json';

beforeEach(() => {
  prevHome = process.env['MARKUS_HOME'];
  home = mkdtempSync(join(tmpdir(), 'markus-remote-secrets-'));
  process.env['MARKUS_HOME'] = home;
  // A realistic markus.json that must stay byte-identical after secret writes.
  writeFileSync(
    markusJsonPath(),
    JSON.stringify({ org: { id: 'default' }, remote: { enabled: true, instanceName: 'My Markus' } }, null, 2),
    'utf-8',
  );
  delete process.env[HUB_TOKEN_ENV_KEY];
});

afterEach(() => {
  delete process.env[HUB_TOKEN_ENV_KEY];
  clearEndpointSecret('ep_1');
  if (prevHome === undefined) delete process.env['MARKUS_HOME'];
  else process.env['MARKUS_HOME'] = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe('remote-secrets', () => {
  describe('endpoint rotation secret', () => {
    it('derives a deterministic, sanitized env key per endpoint', () => {
      expect(endpointSecretEnvKey('ep_01HABC')).toBe('MARKUS_REMOTE_SECRET_EP_01HABC');
      expect(endpointSecretEnvKey('ep/1-x')).toBe('MARKUS_REMOTE_SECRET_EP_1_X');
      expect(endpointSecretEnvKey('ep_01HABC')).toBe(endpointSecretEnvKey('ep_01HABC'));
    });

    it('persists to ~/.markus/.env and reads it back', () => {
      const key = persistEndpointSecret('ep_1', SECRET_MARKER);
      expect(key).toBe('MARKUS_REMOTE_SECRET_EP_1');
      expect(existsSync(envPath())).toBe(true);
      expect(readFileSync(envPath(), 'utf-8')).toContain(`${key}=${SECRET_MARKER}`);
      expect(readEndpointSecret('ep_1')).toBe(SECRET_MARKER);
    });

    it('NEVER writes the secret into markus.json', () => {
      const before = readFileSync(markusJsonPath(), 'utf-8');
      persistEndpointSecret('ep_1', SECRET_MARKER);
      const after = readFileSync(markusJsonPath(), 'utf-8');
      expect(after).toBe(before);
      expect(after).not.toContain(SECRET_MARKER);
    });

    it('clears the secret', () => {
      persistEndpointSecret('ep_1', SECRET_MARKER);
      clearEndpointSecret('ep_1');
      expect(readEndpointSecret('ep_1')).toBe('');
      expect(readFileSync(envPath(), 'utf-8')).not.toContain(`${SECRET_MARKER}`);
    });
  });

  describe('hub token', () => {
    it('persists the hub token under the canonical MARKUS_HUB_TOKEN and never touches markus.json', () => {
      const before = readFileSync(markusJsonPath(), 'utf-8');
      persistHubToken('hub-jwt-xyz');
      expect(readFileSync(envPath(), 'utf-8')).toContain('MARKUS_HUB_TOKEN=hub-jwt-xyz');
      expect(readFileSync(markusJsonPath(), 'utf-8')).toBe(before);
      expect(readFileSync(markusJsonPath(), 'utf-8')).not.toContain('hub-jwt-xyz');
    });

    it('resolves precedence: explicit > canonical store > legacy file > empty', () => {
      // empty everywhere
      expect(resolveHubToken()).toBe('');

      // legacy file only
      mkdirSync(join(home), { recursive: true });
      writeFileSync(legacyHubTokenPath(), 'legacy-token\n', 'utf-8');
      expect(resolveHubToken()).toBe('legacy-token');

      // canonical store beats the legacy file
      persistHubToken('store-token');
      expect(resolveHubToken()).toBe('store-token');

      // explicit beats everything
      expect(resolveHubToken('explicit-token')).toBe('explicit-token');
    });
  });

  it('keeps markus.json untouched across a full secret lifecycle', () => {
    const before = readFileSync(markusJsonPath(), 'utf-8');
    persistHubToken('hub-jwt-xyz');
    persistEndpointSecret('ep_1', SECRET_MARKER);
    readEndpointSecret('ep_1');
    resolveHubToken();
    clearEndpointSecret('ep_1');
    expect(readFileSync(markusJsonPath(), 'utf-8')).toBe(before);
  });
});

// ── Entry address (display only, 2026-10-14) ─────────────────────────────────
// The status payload reported `entryUrl: null` because nothing ever filled it,
// so the Settings panel could not show the user the address they need to share.
describe('entry address helpers', () => {
  /** Build a real 3-segment JWT shape (signature is not checked — display only). */
  function makeToken(payload: Record<string, unknown>): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`;
  }

  it('builds the shareable entry from a username', () => {
    expect(buildEntryUrl('jsyqrt')).toBe('https://jsyqrt.remote.markus.global');
    expect(buildEntryUrl('jsyqrt')).toContain(ENTRY_HOST_SUFFIX);
  });

  it('returns null for a missing username instead of a bogus host', () => {
    expect(buildEntryUrl(null)).toBeNull();
    expect(buildEntryUrl(undefined)).toBeNull();
    expect(buildEntryUrl('')).toBeNull();
  });

  it('reads the username claim from the Hub token', () => {
    expect(hubUsernameFromToken(makeToken({ userId: 'usr_1', username: 'jsyqrt' }))).toBe('jsyqrt');
  });

  it('degrades to null on a malformed, absent or claim-less token', () => {
    expect(hubUsernameFromToken(undefined)).toBeNull();
    expect(hubUsernameFromToken('')).toBeNull();
    expect(hubUsernameFromToken('not-a-jwt')).toBeNull();
    expect(hubUsernameFromToken('a.@@not-base64@@.c')).toBeNull();
    expect(hubUsernameFromToken(makeToken({ userId: 'usr_1' }))).toBeNull();
    expect(hubUsernameFromToken(makeToken({ username: 42 }))).toBeNull();
  });
});
