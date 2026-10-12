/**
 * Central resolver for security-sensitive secrets.
 *
 * Each secret is resolved from the environment and validated against known
 * placeholder values; when no operator-supplied secret is present, a strong
 * random value is generated ONCE and persisted to `~/.markus/` (mode 0600).
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { markusHome } from './config-paths.js';

/** Directory for persisted secrets — same canonical home as all other config. */
function markusDir(): string {
  return markusHome();
}

/** Placeholder values treated as "unset" — never accepted as a real secret. */
export const DEV_JWT_SECRET = 'markus-dev-secret-change-in-prod';
export const DEV_ADMIN_PASSWORD = 'markus123';
export const DEV_GATEWAY_SECRET = 'markus-gateway-default-secret-change-me';

/**
 * Env vars that hold platform secrets. A secret is never read from a low-trust
 * source (a workspace `.env`) — see `utils/env.ts`. Keep this list to values the
 * platform itself owns; provider/search keys are matched by the pattern below.
 */
export const SECRET_ENV_KEYS: ReadonlySet<string> = new Set([
  'JWT_SECRET',
  'ADMIN_PASSWORD',
  'GATEWAY_SECRET',
  'DATABASE_URL',
]);

/**
 * True when an env var carries a credential (`*_API_KEY`, `*_SECRET`,
 * `*_TOKEN`, `*_PASSWORD`, or a platform secret). Used to decide whether a
 * value may be accepted from a low-trust dotenv file.
 */
export function isSecretEnvKey(key: string): boolean {
  if (SECRET_ENV_KEYS.has(key)) return true;
  return /(?:^|_)(?:API_KEYS?|SECRET|TOKENS?|PASSWORDS?|CREDENTIALS?)$/i.test(key);
}

function initialAdminPasswordFilePath(): string {
  return join(markusDir(), 'initial-admin-password');
}

function ensureMarkusDir(): void {
  const dir = markusDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function readSecretFile(fileName: string): string | null {
  const file = join(markusDir(), fileName);
  try {
    if (!existsSync(file)) return null;
    const value = readFileSync(file, 'utf-8').trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeSecretFile(fileName: string, value: string): void {
  const file = join(markusDir(), fileName);
  ensureMarkusDir();
  writeFileSync(file, value, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best-effort on platforms without POSIX modes (e.g. Windows) */
  }
}

/** Load a persisted secret, generating + persisting one on first use. */
function loadOrCreateSecret(fileName: string, bytes = 32): string {
  const existing = readSecretFile(fileName);
  if (existing) return existing;
  try {
    const generated = randomBytes(bytes).toString('hex');
    writeSecretFile(fileName, generated);
    return generated;
  } catch {
    // Filesystem not writable — never fall back to a known literal.
    return randomBytes(bytes).toString('hex');
  }
}

let cachedJwtFileSecret: string | null = null;

/**
 * Resolve the JWT signing secret (single source of truth for every package).
 *
 * Priority:
 *   1. `JWT_SECRET` env var, unless it is a placeholder value.
 *   2. A randomly generated secret persisted at `~/.markus/jwt-secret`.
 */
export function resolveJwtSecret(): string {
  const fromEnv = process.env['JWT_SECRET']?.trim();
  if (fromEnv && fromEnv !== DEV_JWT_SECRET) return fromEnv;
  if (!cachedJwtFileSecret) cachedJwtFileSecret = loadOrCreateSecret('jwt-secret');
  return cachedJwtFileSecret;
}

/** True when an explicit, non-default `JWT_SECRET` is configured. */
export function hasExplicitJwtSecret(): boolean {
  const fromEnv = process.env['JWT_SECRET']?.trim();
  return Boolean(fromEnv && fromEnv !== DEV_JWT_SECRET);
}

/**
 * Resolve the initial admin password for the placeholder owner created on a
 * fresh instance.
 *
 * Priority:
 *   1. `ADMIN_PASSWORD` env var, unless it is a placeholder value.
 *   2. A randomly generated password persisted at
 *      `~/.markus/initial-admin-password` (0600), printed once by the caller.
 */
export function resolveInitialAdminPassword(): { password: string; generated: boolean } {
  const fromEnv = process.env['ADMIN_PASSWORD']?.trim();
  if (fromEnv && fromEnv !== DEV_ADMIN_PASSWORD) return { password: fromEnv, generated: false };

  const existing = readSecretFile('initial-admin-password');
  if (existing) return { password: existing, generated: false };

  // Human-typable but high-entropy (~19 chars, base64url).
  const generated = randomBytes(14).toString('base64url');
  writeSecretFile('initial-admin-password', generated);
  return { password: generated, generated: true };
}

/** Path of the persisted initial-admin-password file (for messaging). */
export function initialAdminPasswordFile(): string {
  return initialAdminPasswordFilePath();
}

/** Remove the initial-admin-password file once the placeholder owner is claimed. */
export function clearInitialAdminPassword(): void {
  const file = initialAdminPasswordFilePath();
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {
    /* best-effort cleanup */
  }
}

/**
 * Resolve the External Agent Gateway signing secret.
 * Same rule: env var unless it is a placeholder value, else a persisted random.
 */
export function resolveGatewaySecret(): string {
  const fromEnv = process.env['GATEWAY_SECRET']?.trim();
  if (fromEnv && fromEnv !== DEV_GATEWAY_SECRET) return fromEnv;
  return loadOrCreateSecret('gateway-secret');
}