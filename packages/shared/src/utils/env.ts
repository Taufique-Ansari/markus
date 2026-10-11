/**
 * Markus environment / secret file handling.
 *
 * Canonical location: `~/.markus/.env` (see `config-paths.ts`). This is what an
 * installed client uses — both the globally-installed CLI and the packaged
 * desktop app. Their working directory is not meaningful.
 *
 * Precedence (documented, deterministic):
 *   1. an already-set `process.env` value (shell / container / CI) — never overridden
 *   2. `~/.markus/.env`                       — trusted
 *   3. `<cwd>/.env`  (legacy / dev checkout)  — LOWER trust
 *
 * **Secrets are never taken from the low-trust cwd file.** Credential values
 * (`*_API_KEY`, `*_SECRET`, `JWT_SECRET`, …) are read only from the canonical
 * store; a workspace `.env` is honoured for non-secret keys only (dev
 * convenience), mirroring OpenClaw's rule for workspace `.env` files.
 *
 * Writing secrets always targets the canonical file (`setEnvValue`), so configs
 * self-migrate off the legacy location.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { markusEnvPath } from './config-paths.js';
import { isSecretEnvKey } from './secrets.js';

let loaded = false;

/** Parse a `.env` file into key/value pairs (comments + blanks ignored). */
export function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (key) out[key] = trimmed.slice(eqIdx + 1).trim();
  }
  return out;
}

function applyEnvFile(path: string, trusted: boolean): void {
  const values = parseEnvFile(path);
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] !== undefined) continue; // never override an existing value
    if (!trusted && isSecretEnvKey(key)) continue; // secrets never come from a low-trust file
    process.env[key] = value;
  }
}

/**
 * Populate `process.env` from Markus `.env` files (canonical trusted first,
 * legacy cwd second). Never overrides an existing value; never reads secrets
 * from the cwd file. No-op after the first successful call.
 */
export function loadEnvFile(): void {
  if (loaded) return;
  loaded = true;
  applyEnvFile(markusEnvPath(), true);
  applyEnvFile(resolve(process.cwd(), '.env'), false);
}

/**
 * Upsert a single key in the canonical `~/.markus/.env`, preserving every other
 * line (comments, order, unrelated keys). This is the ONLY writer of the secret
 * store — every secret must go through here so it lands in one place.
 */
export function setEnvValue(key: string, value: string): void {
  const path = markusEnvPath();
  mkdirSync(dirname(path), { recursive: true });
  const lines: string[] = existsSync(path) ? readFileSync(path, 'utf-8').split('\n') : [];
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    if (trimmed.slice(0, eqIdx).trim() === key) {
      lines[i] = `${key}=${value}`;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    lines.push(`${key}=${value}`);
  }
  writeFileSync(path, lines.join('\n'), 'utf-8');
  process.env[key] = value;
}

/** Remove a key from the canonical `~/.markus/.env` (and `process.env`). */
export function unsetEnvValue(key: string): void {
  const path = markusEnvPath();
  if (!existsSync(path)) return;
  const lines = readFileSync(path, 'utf-8').split('\n');
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return true;
    const eqIdx = trimmed.indexOf('=');
    return eqIdx === -1 || trimmed.slice(0, eqIdx).trim() !== key;
  });
  writeFileSync(path, kept.join('\n'), 'utf-8');
  delete process.env[key];
}

/** @internal — test seam to re-run loading with a different environment. */
export function __resetEnvFileLoadedForTests(): void {
  loaded = false;
}
