/**
 * Secret persistence — the single writer/reader of everything that lives in the
 * canonical secret store (`~/.markus/.env`, see `env.ts`).
 *
 * `markus.json` keeps only the *name* of an env var (`apiKeyEnv`), never the
 * plaintext value. This mirrors the dsh `apiKeyEnv` indirection and OpenClaw's
 * SecretRef.
 *
 * Two families share this store:
 *   • LLM provider keys        — `providerEnvKey` / `persistProviderSecret`
 *   • everything else (remote-access hub token, per-endpoint rotation secret,
 *     …)                       — `persistNamedSecret` / `readNamedSecret` /
 *                               `clearNamedSecret`
 *
 * Both families funnel through `persistNamedSecret`, which is the ONLY thing in
 * the platform that calls `setEnvValue` for a secret — so there is exactly one
 * write path and secrets can never drift into `markus.json`.
 */
import { PROVIDERS } from '../models.js';
import { markusEnvPath } from './config-paths.js';
import { parseEnvFile, setEnvValue, unsetEnvValue } from './env.js';

/** Canonical env var name for a provider's API key (from PROVIDERS metadata). */
export function providerEnvKey(providerId: string): string {
  const meta = PROVIDERS.find((p) => p.id === providerId);
  return meta?.envKey ?? `${providerId.toUpperCase().replace(/-/g, '_')}_API_KEY`;
}

/**
 * Persist an arbitrary secret (provider key OR anything else) to the canonical
 * secret store and return the env var name it now lives under. Backed by
 * `setEnvValue`, so callers must store only the *env var name* elsewhere — the
 * plaintext never goes into `markus.json`.
 */
export function persistNamedSecret(envKey: string, value: string): string {
  setEnvValue(envKey, value);
  return envKey;
}

/**
 * Read a secret from the canonical store. Precedence matches `env.ts`
 * documented order: an already-set `process.env` value (shell / CI / a prior
 * `setEnvValue`) wins; otherwise the canonical `~/.markus/.env` file.
 */
export function readNamedSecret(envKey: string): string {
  const fromEnv = process.env[envKey];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();
  const fromFile = parseEnvFile(markusEnvPath())[envKey];
  return fromFile?.trim() ?? '';
}

/** Remove a secret from the canonical store (and `process.env`). */
export function clearNamedSecret(envKey: string): void {
  unsetEnvValue(envKey);
}

/**
 * Persist a provider API key to the canonical secret store and return the env
 * var name it now lives under. Callers must store `apiKeyEnv: <name>` and drop
 * any plaintext `apiKey` — secrets are never written to `markus.json`.
 */
export function persistProviderSecret(providerId: string, apiKey: string): string {
  return persistNamedSecret(providerEnvKey(providerId), apiKey);
}
