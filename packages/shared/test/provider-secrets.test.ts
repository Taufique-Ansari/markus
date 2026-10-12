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
});
