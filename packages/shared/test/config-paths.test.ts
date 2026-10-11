import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  markusHome,
  markusPath,
  markusConfigPath,
  markusEnvPath,
  markusDbPath,
} from '../src/utils/config-paths.js';
import { loadEnvFile, setEnvValue, unsetEnvValue, __resetEnvFileLoadedForTests } from '../src/utils/env.js';
import { isSecretEnvKey } from '../src/utils/secrets.js';

const ENV = process.env;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'markus-home-'));
  process.env['MARKUS_HOME'] = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env['MARKUS_HOME'];
  __resetEnvFileLoadedForTests();
});

describe('config-paths — single source of truth', () => {
  it('defaults to ~/.markus and honours MARKUS_HOME', () => {
    expect(markusHome()).toBe(home);
    expect(markusConfigPath()).toBe(join(home, 'markus.json'));
    expect(markusEnvPath()).toBe(join(home, '.env'));
    expect(markusDbPath()).toBe(join(home, 'data.db'));
    expect(markusPath('logs')).toBe(join(home, 'logs'));
  });

  it('falls back to homedir/.markus when MARKUS_HOME is blank', () => {
    process.env['MARKUS_HOME'] = '   ';
    expect(markusHome().endsWith(join('.markus'))).toBe(true);
  });
});

describe('loadEnvFile — canonical first, legacy cwd second, never override', () => {
  const CANON = 'MARKUS_TEST_CANON';
  const LEGACY = 'MARKUS_TEST_LEGACY';
  const PRESET = 'MARKUS_TEST_PRESET';

  it('reads the canonical ~/.markus/.env', () => {
    writeFileSync(join(home, '.env'), `${CANON}=from-home\n`);
    loadEnvFile();
    expect(process.env[CANON]).toBe('from-home');
    delete process.env[CANON];
  });

  it('canonical wins over the legacy cwd file, which only fills gaps', () => {
    writeFileSync(join(home, '.env'), `${CANON}=canon\n${PRESET}=canon\n`);
    // legacy file at cwd
    const cwdEnv = join(process.cwd(), '.env');
    const had = existsSyncSafe(cwdEnv);
    const prev = had ? readSafe(cwdEnv) : undefined;
    writeFileSync(cwdEnv, `${CANON}=cwd\n${LEGACY}=cwd\n${PRESET}=cwd\n`);
    process.env[PRESET] = 'preset';
    try {
      loadEnvFile();
      expect(process.env[CANON]).toBe('canon');   // canonical wins
      expect(process.env[LEGACY]).toBe('cwd');    // legacy fills the gap
      expect(process.env[PRESET]).toBe('preset'); // existing env never overridden
    } finally {
      if (had && prev !== undefined) writeFileSync(cwdEnv, prev);
      else rmSync(cwdEnv, { force: true });
      delete process.env[CANON];
      delete process.env[LEGACY];
      delete process.env[PRESET];
    }
  });

  it('is idempotent', () => {
    writeFileSync(join(home, '.env'), `${CANON}=v1\n`);
    loadEnvFile();
    writeFileSync(join(home, '.env'), `${CANON}=v2\n`);
    loadEnvFile(); // no-op after the first call
    expect(process.env[CANON]).toBe('v1');
    delete process.env[CANON];
  });
});

describe('secret store — canonical .env, single writer', () => {
  it('isSecretEnvKey classifies credentials vs ordinary settings', () => {
    for (const k of ['JWT_SECRET', 'ADMIN_PASSWORD', 'OPENAI_API_KEY', 'FEISHU_APP_SECRET', 'MARKUS_HUB_TOKEN', 'DB_PASSWORD', 'GOOGLE_CREDENTIALS', 'SERPER_API_KEY']) {
      expect(isSecretEnvKey(k), k).toBe(true);
    }
    for (const k of ['AUTH_ENABLED', 'SERVER_PORT', 'OLLAMA_BASE_URL', 'MARKUS_SEARCH_ENABLED']) {
      expect(isSecretEnvKey(k), k).toBe(false);
    }
  });

  it('setEnvValue upserts into ~/.markus/.env; unsetEnvValue removes', () => {
    setEnvValue('K1', 'v1');
    setEnvValue('K2', 'v2');
    setEnvValue('K1', 'v1b'); // upsert, no duplicate line
    const body = readFileSync(join(home, '.env'), 'utf-8');
    expect(body.match(/^K1=/gm)).toHaveLength(1);
    expect(body).toContain('K1=v1b');
    expect(process.env['K1']).toBe('v1b');
    unsetEnvValue('K1');
    expect(readFileSync(join(home, '.env'), 'utf-8')).not.toMatch(/^K1=/m);
    expect(process.env['K1']).toBeUndefined();
    delete process.env['K2'];
  });

  it('loads secrets from the canonical file', () => {
    delete process.env['MARKUS_TEST_API_KEY'];
    writeFileSync(join(home, '.env'), 'MARKUS_TEST_API_KEY=canonical-ok\n');
    loadEnvFile();
    expect(process.env['MARKUS_TEST_API_KEY']).toBe('canonical-ok');
    delete process.env['MARKUS_TEST_API_KEY'];
  });

  it('never loads secrets from a low-trust cwd .env (but non-secrets fall back)', () => {
    const cwdEnv = join(process.cwd(), '.env');
    const prev = existsSync(cwdEnv) ? readFileSync(cwdEnv, 'utf-8') : undefined;
    writeFileSync(cwdEnv, 'MARKUS_TEST_API_KEY=leaked-from-repo\nMARKUS_TEST_PLAIN=ok\n');
    delete process.env['MARKUS_TEST_API_KEY'];
    try {
      loadEnvFile();
      expect(process.env['MARKUS_TEST_API_KEY']).toBeUndefined();
      expect(process.env['MARKUS_TEST_PLAIN']).toBe('ok');
    } finally {
      if (prev !== undefined) writeFileSync(cwdEnv, prev);
      else rmSync(cwdEnv, { force: true });
      delete process.env['MARKUS_TEST_PLAIN'];
      delete process.env['MARKUS_TEST_API_KEY'];
    }
  });
});

function existsSyncSafe(p: string): boolean {
  try { return existsSync(p); } catch { return false; }
}
function readSafe(p: string): string | undefined {
  try { return readFileSync(p, 'utf-8'); } catch { return undefined; }
}
