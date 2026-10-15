/**
 * Remote-access credential stores (T7).
 *
 * The Hub token and the per-endpoint rotation `secret` are SECRETS. Per the
 * frozen contract (§3.3 / §8.1) they live in the canonical secret store
 * (`~/.markus/.env`, via `provider-secrets`) and are **never** written to
 * `markus.json`.
 *
 * This module is the ONLY place the local side reads/writes those two secrets,
 * so there is a single fact about where they live.
 */
import { existsSync, readFileSync } from 'node:fs';
import { markusPath, persistNamedSecret, readNamedSecret, clearNamedSecret } from '@markus/shared';

/**
 * Env var carrying the Hub session token. The same canonical name the rest of
 * the platform already honours (`markus-provider.ts`), so login writes and
 * remote-access reads agree on one variable.
 */
export const HUB_TOKEN_ENV_KEY = 'MARKUS_HUB_TOKEN';

/**
 * Legacy on-disk hub-token location (`~/.markus/hub-token`). Kept read-only for
 * compatibility with clients that still drop the token there; new writes go to
 * the canonical secret store.
 */
export function legacyHubTokenPath(): string {
  return markusPath('hub-token');
}

/**
 * Canonical env var name for an endpoint's rotation secret, derived from its id
 * (e.g. `ep_01H…` → `MARKUS_REMOTE_SECRET_EP_01H…`). Deterministic so a restart
 * can find a previously issued secret without any extra bookkeeping.
 */
export function endpointSecretEnvKey(endpointId: string): string {
  const sanitized = endpointId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return `MARKUS_REMOTE_SECRET_${sanitized}`;
}

/** Persist an endpoint's rotation secret to the canonical store (never markus.json). */
export function persistEndpointSecret(endpointId: string, secret: string): string {
  return persistNamedSecret(endpointSecretEnvKey(endpointId), secret);
}

/** Read an endpoint's rotation secret ('' when never issued). */
export function readEndpointSecret(endpointId: string): string {
  return readNamedSecret(endpointSecretEnvKey(endpointId));
}

/** Drop an endpoint's rotation secret (e.g. after DELETE). */
export function clearEndpointSecret(endpointId: string): void {
  clearNamedSecret(endpointSecretEnvKey(endpointId));
}

/**
 * Adapter matching `TunnelManagerDeps.persistSecret` (T6): persist an endpoint's
 * rotation secret to the canonical store and resolve with nothing, so T8 can
 * pass it straight into `new TunnelManager({ persistSecret: persistEndpointSecretForTunnel })`.
 * Persistence is synchronous today; the async signature is the T6 seam contract.
 */
export async function persistEndpointSecretForTunnel(endpointId: string, secret: string): Promise<void> {
  persistEndpointSecret(endpointId, secret);
}

/**
 * Resolve the Hub token, in precedence order:
 *   1. an explicit value (caller-supplied config)
 *   2. the canonical secret store (`MARKUS_HUB_TOKEN` — process.env or `~/.markus/.env`)
 *   3. the legacy `~/.markus/hub-token` file
 *   4. `''`
 */
export function resolveHubToken(explicit?: string): string {
  const direct = explicit?.trim();
  if (direct) return direct;

  const fromStore = readNamedSecret(HUB_TOKEN_ENV_KEY);
  if (fromStore) return fromStore;

  try {
    const legacy = legacyHubTokenPath();
    if (existsSync(legacy)) return readFileSync(legacy, 'utf-8').trim();
  } catch {
    /* unreadable → treat as absent */
  }
  return '';
}

/** Persist the Hub token to the canonical secret store (never markus.json). */
export function persistHubToken(token: string): string {
  return persistNamedSecret(HUB_TOKEN_ENV_KEY, token);
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry address (display only)
// ─────────────────────────────────────────────────────────────────────────────

/** Hostname suffix of the Hub's per-user entry domain (`{user}.<suffix>`). */
export const ENTRY_HOST_SUFFIX = 'remote.markus.global';

/** `https://{username}.remote.markus.global` — the stable, shareable entry. */
export function buildEntryUrl(username: string | null | undefined): string | null {
  if (!username) return null;
  return `https://${username}.${ENTRY_HOST_SUFFIX}`;
}

/**
 * Read the `username` claim out of a Hub session JWT.
 *
 * DISPLAY ONLY — this is never an authorization decision (the Hub re-verifies
 * every request). It exists so the local status payload can carry the user's
 * shareable entry address instead of `null`, which left the Settings panel
 * unable to show a link the user needs. A malformed/absent token yields `null`
 * ("unknown"), never a guess.
 */
export function hubUsernameFromToken(token?: string): string | null {
  const raw = token?.trim();
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1]!, 'base64url').toString('utf-8');
    const payload = JSON.parse(json) as { username?: unknown };
    const username = payload?.username;
    return typeof username === 'string' && username.length > 0 ? username : null;
  } catch {
    return null;
  }
}
