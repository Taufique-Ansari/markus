/**
 * Provider API-key persistence — the single writer of LLM-provider secrets.
 *
 * A provider's key always lives in the canonical secret store
 * (`~/.markus/.env`, see `env.ts`); `markus.json` keeps only the *name* of the
 * env var (`apiKeyEnv`), never the plaintext value. This mirrors the dsh
 * `apiKeyEnv` indirection and OpenClaw's SecretRef.
 *
 * Both the CLI (`init` / `model` / `auth`) and the API server write keys, so the
 * store-name resolution + the write itself must have exactly ONE implementation
 * — otherwise those two callers drift apart.
 */
import { PROVIDERS } from '../models.js';
import { setEnvValue } from './env.js';

/** Canonical env var name for a provider's API key (from PROVIDERS metadata). */
export function providerEnvKey(providerId: string): string {
  const meta = PROVIDERS.find((p) => p.id === providerId);
  return meta?.envKey ?? `${providerId.toUpperCase().replace(/-/g, '_')}_API_KEY`;
}

/**
 * Persist a provider API key to the canonical secret store and return the env
 * var name it now lives under. Callers must store `apiKeyEnv: <name>` and drop
 * any plaintext `apiKey` — secrets are never written to `markus.json`.
 */
export function persistProviderSecret(providerId: string, apiKey: string): string {
  const envKey = providerEnvKey(providerId);
  setEnvValue(envKey, apiKey);
  return envKey;
}
