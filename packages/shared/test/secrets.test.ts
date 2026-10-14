import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The home dir is resolved dynamically from MARKUS_HOME, so tests can point it
// at a temp dir before each call.
let tmpHome: string;

async function loadModule() {
  return import('../src/utils/secrets.js');
}

describe('secrets resolver', () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'markus-secrets-'));
    vi.stubEnv('MARKUS_HOME', tmpHome);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns a non-default JWT_SECRET from env when set', async () => {
    vi.stubEnv('JWT_SECRET', 'my-real-prod-secret');
    const { resolveJwtSecret, DEV_JWT_SECRET } = await loadModule();
    expect(resolveJwtSecret()).toBe('my-real-prod-secret');
    expect(resolveJwtSecret()).not.toBe(DEV_JWT_SECRET);
  });

  it('ignores the dev placeholder JWT_SECRET and generates a persisted random one', async () => {
    vi.stubEnv('JWT_SECRET', 'markus-dev-secret-change-in-prod');
    const { resolveJwtSecret, DEV_JWT_SECRET } = await loadModule();
    const a = resolveJwtSecret();
    expect(a).not.toBe(DEV_JWT_SECRET);
    expect(a.length).toBeGreaterThanOrEqual(32);
    // Persisted file exists with 0600 perms.
    const file = join(tmpHome, 'jwt-secret');
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('is stable across calls and across module reloads (persisted)', async () => {
    const { resolveJwtSecret } = await loadModule();
    const first = resolveJwtSecret();
    const second = resolveJwtSecret();
    expect(second).toBe(first);

    vi.resetModules();
    const reloaded = await loadModule();
    expect(reloaded.resolveJwtSecret()).toBe(first);
  });

  it('generates a random initial admin password (not markus123) and persists it', async () => {
    const { resolveInitialAdminPassword, DEV_ADMIN_PASSWORD, initialAdminPasswordFile } =
      await loadModule();
    const { password, generated } = resolveInitialAdminPassword();
    expect(generated).toBe(true);
    expect(password).not.toBe(DEV_ADMIN_PASSWORD);
    expect(password.length).toBeGreaterThanOrEqual(16);
    expect(existsSync(initialAdminPasswordFile())).toBe(true);
  });

  it('honors an explicit ADMIN_PASSWORD that is not the dev default', async () => {
    vi.stubEnv('ADMIN_PASSWORD', 'a-strong-operator-password');
    const { resolveInitialAdminPassword } = await loadModule();
    expect(resolveInitialAdminPassword()).toEqual({
      password: 'a-strong-operator-password',
      generated: false,
    });
  });

  it('clearInitialAdminPassword removes the persisted bootstrap password', async () => {
    const { resolveInitialAdminPassword, clearInitialAdminPassword, initialAdminPasswordFile } =
      await loadModule();
    resolveInitialAdminPassword();
    expect(existsSync(initialAdminPasswordFile())).toBe(true);
    clearInitialAdminPassword();
    expect(existsSync(initialAdminPasswordFile())).toBe(false);
  });

  it('resolves a gateway secret that is not the shipped default', async () => {
    const { resolveGatewaySecret, DEV_GATEWAY_SECRET } = await loadModule();
    expect(resolveGatewaySecret()).not.toBe(DEV_GATEWAY_SECRET);
  });

  // ── Approval action-ref secret (auto-derived, never operator-configured) ──

  it('auto-generates + persists an action secret when MARKUS_ACTION_SECRET is unset', async () => {
    const { resolveActionSecret } = await loadModule();
    const a = resolveActionSecret();
    expect(a.length).toBeGreaterThanOrEqual(32);
    const file = join(tmpHome, 'action-secret');
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('keeps the action secret stable across calls and module reloads', async () => {
    const { resolveActionSecret } = await loadModule();
    const first = resolveActionSecret();
    expect(resolveActionSecret()).toBe(first);

    vi.resetModules();
    const reloaded = await loadModule();
    expect(reloaded.resolveActionSecret()).toBe(first);
  });

  it('honours an explicit MARKUS_ACTION_SECRET and does not touch the file store', async () => {
    vi.stubEnv('MARKUS_ACTION_SECRET', 'operator-supplied-action-secret');
    const { resolveActionSecret } = await loadModule();
    expect(resolveActionSecret()).toBe('operator-supplied-action-secret');
    expect(existsSync(join(tmpHome, 'action-secret'))).toBe(false);
  });

  it('treats MARKUS_ACTION_SECRET as a platform secret (never read from a low-trust .env)', async () => {
    const { isSecretEnvKey } = await loadModule();
    expect(isSecretEnvKey('MARKUS_ACTION_SECRET')).toBe(true);
  });
});