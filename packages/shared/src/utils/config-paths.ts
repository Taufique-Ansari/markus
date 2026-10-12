/**
 * Canonical filesystem locations for Markus configuration & state.
 *
 * SINGLE SOURCE OF TRUTH for every configuration path the platform reads or
 * writes. The CLI, the packaged desktop app and the backend all resolve
 * configuration through this module, so they can never drift apart.
 *
 * Layout — identical for every client (dev, CLI-installed, packaged desktop):
 *
 *   ~/.markus/                     ← MARKUS_HOME (override via env `MARKUS_HOME`)
 *     ├─ markus.json               ← bootstrap + static ops config (config.ts)
 *     ├─ .env                      ← secrets & machine/CI overrides (loadEnvFile)
 *     ├─ data.db                   ← SQLite: runtime / UI-mutable state
 *     ├─ jwt-secret                ← 0600, resolved by secrets.ts
 *     ├─ gateway-secret            ← 0600
 *     ├─ initial-admin-password    ← 0600
 *     └─ logs/  agents/  teams/  skills/  …
 *
 * NOTHING is written inside the application bundle / install directory: an
 * installer upgrade replaces that directory wholesale, so durable user config
 * must live in the user's home. The bundled directory only ever ships
 * read-only templates.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

const MARKUS_HOME_ENV = 'MARKUS_HOME';

/**
 * Root data directory. Overridable via `MARKUS_HOME` (tests, portable /
 * service installs, and anything that needs a non-default home).
 */
export function markusHome(): string {
  const override = process.env[MARKUS_HOME_ENV]?.trim();
  return override && override.length > 0 ? override : join(homedir(), '.markus');
}

/** Join (without creating) a path under the Markus home directory. */
export function markusPath(...segments: string[]): string {
  return join(markusHome(), ...segments);
}

/** `~/.markus/markus.json` — the config file (bootstrap + static ops config). */
export function markusConfigPath(): string {
  return markusPath('markus.json');
}

/** `~/.markus/.env` — canonical secrets/env file (see `loadEnvFile`). */
export function markusEnvPath(): string {
  return markusPath('.env');
}

/** `~/.markus/data.db` — the SQLite database (default location). */
export function markusDbPath(): string {
  return markusPath('data.db');
}