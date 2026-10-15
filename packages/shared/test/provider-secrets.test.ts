import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmpHome: string;

async function loadModule() {
  return import('../src/utils/provider-secrets.js');
}

describe('provider-secrets', () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'markus-provsec-'));
    vi.stubEnv('MARKUS_HOME', tmpHome);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('resolves the canonical env var name from PROVIDERS metadata', async () => {
    const { providerEnvKey } = await loadModule();
    expect(providerEnvKey('openai')).toBe('OPENAI_API_KEY');
    expect(providerEnvKey('anthropic')).toBe('ANTHROPIC_API_KEY');
  });

  it('falls back to <ID>_API_KEY for an unknown provider', async () => {
    const { providerEnvKey } = await loadModule();
    expect(providerEnvKey('my-custom')).toBe('MY_CUSTOM_API_KEY');
  });

  it('writes the secret to the canonical store (~/.markus/.env) and returns the name', async () => {
    const { persistProviderSecret } = await loadModule();
    const envKey = persistProviderSecret('openai', 'sk-secret-value');
    expect(envKey).toBe('OPENAI_API_KEY');

    const envFile = join(tmpHome, '.env');
    expect(existsSync(envFile)).toBe(true);
    expect(readFileSync(envFile, 'utf-8')).toContain('OPENAI_API_KEY=sk-secret-value');
    // ...and it is now live in process.env for the current run.
    expect(process.env['OPENAI_API_KEY']).toBe('sk-secret-value');
  });

  it('upserts (does not duplicate) an existing key', async () => {
    const { persistProviderSecret } = await loadModule();
    persistProviderSecret('openai', 'first');
    persistProviderSecret('openai', 'second');
    const raw = readFileSync(join(tmpHome, '.env'), 'utf-8');
    expect(raw.match(/OPENAI_API_KEY=/g)?.length).toBe(1);
    expect(raw).toContain('OPENAI_API_KEY=second');
  });

  // ── Generic (non-provider) secrets — remote-access hub token / rotate secret ──
  it('persistNamedSecret writes any secret to the canonical store and returns its name', async () => {
    const { persistNamedSecret } = await loadModule();
    const key = persistNamedSecret('MARKUS_HUB_TOKEN', 'hub-token-value');
    expect(key).toBe('MARKUS_HUB_TOKEN');
    expect(readFileSync(join(tmpHome, '.env'), 'utf-8')).toContain('MARKUS_HUB_TOKEN=hub-token-value');
    expect(process.env['MARKUS_HUB_TOKEN']).toBe('hub-token-value');
  });

  it('readNamedSecret reads the canonical store; clearNamedSecret removes it', async () => {
    const { persistNamedSecret, readNamedSecret, clearNamedSecret } = await loadModule();
    persistNamedSecret('MARKUS_REMOTE_SECRET_EP_1', 'sekret');
    expect(readNamedSecret('MARKUS_REMOTE_SECRET_EP_1')).toBe('sekret');
    clearNamedSecret('MARKUS_REMOTE_SECRET_EP_1');
    expect(readNamedSecret('MARKUS_REMOTE_SECRET_EP_1')).toBe('');
  });

  it('persistProviderSecret routes through the one write path (markus.json is never written)', async () => {
    const { persistProviderSecret } = await loadModule();
    persistProviderSecret('openai', 'sk-secret-value');
    // The only file touched is the canonical .env — no markus.json is created.
    expect(existsSync(join(tmpHome, 'markus.json'))).toBe(false);
  });
});
