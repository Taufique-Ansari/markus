/**
 * Local verify-server (T7) — exposes `GET /api/remote/verify` (contract §2.7 / §8.2).
 *
 * The Hub probes this route THROUGH the tunnel to prove the caller really owns
 * the endpoint (challenge-response, §4). It is a tiny token echo:
 *
 *   200 { "token": "<verifyToken>" }        // Content-Type: application/json; charset=utf-8
 *
 * Source of truth: the getter supplied by the caller — contract §8.2 says the
 * `TunnelManager` owns the token and this route MUST read through it, never keep
 * a second cache. The getter is therefore invoked on every request.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DEFAULT_VERIFY_PATH, type LocalVerifyResponse } from './contract.js';

/** The local path the Hub probes; mirrors the contract constant. */
export const LOCAL_VERIFY_PATH = DEFAULT_VERIFY_PATH;

/**
 * Read-through accessor for the currently pending verify token. Returning
 * `null`/`undefined` makes the route answer with an empty token (contract
 * §2.7) — which the Hub will treat as a token mismatch, i.e. "not verified yet".
 */
export type VerifyTokenSource = () => string | null | undefined;

/** Pure body builder for §2.7. A missing token serialises as `{ token: '' }`. */
export function buildLocalVerifyResponse(token: string | null | undefined): LocalVerifyResponse {
  return { token: token ?? '' };
}

/**
 * Raw `node:http` handler for the verify route, matching the local API server's
 * `createServer` style. Returns `true` when it handled the request and `false`
 * when the path did not match (so the caller can keep routing).
 */
export function handleLocalVerifyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  getToken: VerifyTokenSource,
): boolean {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname !== LOCAL_VERIFY_PATH) return false;

  if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
    res.writeHead(405, {
      'Content-Type': 'application/json; charset=utf-8',
      Allow: 'GET',
    });
    res.end(JSON.stringify({ error: 'method_not_allowed', message: 'Only GET is allowed on the verify endpoint.' }));
    return true;
  }

  // Read the token THROUGH the source on every request — no second cache.
  const body = buildLocalVerifyResponse(getToken());
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    // The probe must always see the live value; forbid any intermediary caching.
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
  return true;
}

/**
 * Bind {@link handleLocalVerifyRequest} to a token source, returning a handler
 * that takes just `(req, res)` — convenient for `createServer` wiring in T8.
 */
export function createLocalVerifyHandler(
  getToken: VerifyTokenSource,
): (req: IncomingMessage, res: ServerResponse) => boolean {
  return (req, res) => handleLocalVerifyRequest(req, res, getToken);
}
