/**
 * RegistryClient (T7) — the local side's thin wrapper over the Hub endpoint
 * registry API (contract §2 / §8.1).
 *
 * Every method maps 1:1 onto a Hub route:
 *   register()  POST   /api/remote/endpoints          [Hub token]
 *   list()      GET    /api/remote/endpoints          [Hub token]
 *   update()    PATCH  /api/remote/endpoints/:id      [Hub token | HMAC]
 *   remove()    DELETE /api/remote/endpoints/:id      [Hub token]
 *   verify()    POST   /api/remote/endpoints/:id/verify [Hub token]
 *
 * The HMAC rotation-signing algorithm has ONE implementation here
 * (`signRotationRequest`) — the Hub mirrors it byte-for-byte (contract §3.2).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  buildRotationCanonicalString,
  SIGNATURE_HEADERS,
  SIGNATURE_SCHEME,
  type CreateEndpointRequest,
  type CreateEndpointResponse,
  type DeleteEndpointResponse,
  type ListEndpointsResponse,
  type RemoteEndpointDTO,
  type RemoteErrorCode,
  type RemoteErrorResponse,
  type UpdateEndpointRequest,
  type UpdateEndpointResponse,
  type VerifyEndpointResponse,
} from './contract.js';
import { resolveHubToken } from './remote-secrets.js';

/** Default Hub origin when nothing overrides it. */
export const DEFAULT_HUB_URL = 'https://www.markus.global';
/** Registry collection path. */
export const ENDPOINTS_PATH = '/api/remote/endpoints';

/** Resolve the Hub base URL: explicit → `MARKUS_HUB_URL` → default (trailing `/` trimmed). */
export function resolveHubBaseUrl(explicit?: string): string {
  const raw = explicit?.trim() || process.env['MARKUS_HUB_URL']?.trim() || DEFAULT_HUB_URL;
  return raw.replace(/\/+$/, '');
}

/** `POST /api/remote/endpoints/:id/verify`-style child path. */
export function endpointPath(endpointId: string): string {
  return `${ENDPOINTS_PATH}/${encodeURIComponent(endpointId)}`;
}

/** Lowercase hex sha256 of a string. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

/**
 * Random nonce for a signed request. base64url ⇒ charset `[A-Za-z0-9_-]`,
 * 32 chars ⇒ inside the contract's 16–64 bound.
 */
export function generateNonce(): string {
  return randomBytes(24).toString('base64url');
}

export interface RotationSignatureParams {
  /** HTTP method (any case; canonical uppercases it). */
  method: string;
  /** Request path WITHOUT query string. */
  path: string;
  /** EXACT serialized request body that will be sent, or `undefined` when there is none. */
  body?: string;
  /** Unix SECONDS, decimal string. */
  timestamp: string;
  nonce: string;
}

/**
 * Build the three signed-request headers for a rotation PATCH. The body hash is
 * taken from the very string the caller will send, so signer and verifier see
 * identical bytes.
 */
export function signRotationRequest(
  secret: string,
  params: RotationSignatureParams,
): Record<string, string> {
  const bodyHash = params.body === undefined || params.body === '' ? '' : sha256Hex(params.body);
  const canonical = buildRotationCanonicalString({
    method: params.method,
    path: params.path,
    bodyHash,
    timestamp: params.timestamp,
    nonce: params.nonce,
  });
  const signature = `${SIGNATURE_SCHEME}=${createHmac('sha256', secret).update(canonical).digest('hex')}`;
  return {
    [SIGNATURE_HEADERS.timestamp]: params.timestamp,
    [SIGNATURE_HEADERS.nonce]: params.nonce,
    [SIGNATURE_HEADERS.signature]: signature,
  };
}

/**
 * Verify a rotation signature. Provided so the local side (and tests) can prove
 * the algorithm is exactly what the Hub will check (constant-time compare).
 */
export function verifyRotationSignature(
  secret: string,
  params: RotationSignatureParams,
  signatureHeader: string,
): boolean {
  const expected = signRotationRequest(secret, params)[SIGNATURE_HEADERS.signature]!;
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Error code surface: the frozen Hub codes plus two local transport failures. */
export type RegistryErrorCode = RemoteErrorCode | 'network_error';

/** Raised for any non-2xx Hub response or a transport failure. */
export class RemoteRegistryError extends Error {
  readonly code: RegistryErrorCode;
  readonly status: number | null;

  constructor(code: RegistryErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = 'RemoteRegistryError';
    this.code = code;
    this.status = status;
  }
}

export interface RegistryClientOptions {
  /** Hub origin; defaults via {@link resolveHubBaseUrl}. */
  hubUrl?: string;
  /** Explicit Hub token; defaults via {@link resolveHubToken}. */
  hubToken?: string;
  /** Injectable fetch (tests). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Injectable clock returning epoch MILLISECONDS (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable nonce generator (tests). Defaults to {@link generateNonce}. */
  nonce?: () => string;
}

interface RawRequestOptions {
  /** Pre-serialized request body (so signing and sending use identical bytes). */
  body?: string;
  extraHeaders?: Record<string, string>;
}

/** Thin, transparent client over the Hub registry API. */
export class RegistryClient {
  private readonly hubUrl: string;
  private readonly hubToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly nonce: () => string;

  constructor(opts: RegistryClientOptions = {}) {
    this.hubUrl = resolveHubBaseUrl(opts.hubUrl);
    this.hubToken = resolveHubToken(opts.hubToken);
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? (() => Date.now());
    this.nonce = opts.nonce ?? generateNonce;
  }

  /** `POST /api/remote/endpoints` — create/replace an endpoint. */
  async register(input: CreateEndpointRequest): Promise<CreateEndpointResponse> {
    return this.request<CreateEndpointResponse>('POST', ENDPOINTS_PATH, {
      body: JSON.stringify(input),
      extraHeaders: this.tokenHeader(),
    });
  }

  /** `GET /api/remote/endpoints` — list the caller's endpoints. */
  async list(): Promise<RemoteEndpointDTO[]> {
    const res = await this.request<ListEndpointsResponse>('GET', ENDPOINTS_PATH, {
      extraHeaders: this.tokenHeader(),
    });
    return res.endpoints ?? [];
  }

  /**
   * `PATCH /api/remote/endpoints/:id` — rotate URL / heartbeat / health / active.
   * Pass `opts.signWithSecret` to authenticate with the endpoint's rotation
   * secret (HMAC) instead of the Hub token.
   */
  async update(
    id: string,
    input: UpdateEndpointRequest,
    opts: { signWithSecret?: string } = {},
  ): Promise<UpdateEndpointResponse> {
    const path = endpointPath(id);
    const body = JSON.stringify(input);
    let extraHeaders: Record<string, string>;
    if (opts.signWithSecret) {
      const timestamp = Math.floor(this.now() / 1000).toString();
      extraHeaders = signRotationRequest(opts.signWithSecret, {
        method: 'PATCH',
        path,
        body,
        timestamp,
        nonce: this.nonce(),
      });
    } else {
      extraHeaders = this.tokenHeader();
    }
    return this.request<UpdateEndpointResponse>('PATCH', path, { body, extraHeaders });
  }

  /** `DELETE /api/remote/endpoints/:id` — unregister (idempotent). */
  async remove(id: string): Promise<void> {
    await this.request<DeleteEndpointResponse>('DELETE', endpointPath(id), {
      extraHeaders: this.tokenHeader(),
    });
  }

  /** `POST /api/remote/endpoints/:id/verify` — trigger ownership verification. */
  async verify(id: string): Promise<VerifyEndpointResponse> {
    return this.request<VerifyEndpointResponse>('POST', `${endpointPath(id)}/verify`, {
      extraHeaders: this.tokenHeader(),
    });
  }

  private tokenHeader(): Record<string, string> {
    return { Authorization: `Bearer ${this.hubToken}` };
  }

  /**
   * Follow exactly ONE same-site redirect hop, keeping the request's headers
   * (notably `Authorization`) intact.
   *
   * `markus.global` → `www.markus.global` is a same-site hop and is followed;
   * anything that leaves the Hub's registrable domain raises an actionable error
   * rather than silently leaking the token to a foreign host.
   */
  private async followSameSiteHop(url: string, res: Response, init: RequestInit): Promise<Response> {
    const location = res.headers.get('location');
    const target = location ? safeUrl(location, url) : null;
    if (!target || !sameSite(url, target.toString())) {
      throw new RemoteRegistryError(
        'network_error',
        `Hub redirected to ${location ?? '(no Location header)'}; refusing to forward the Hub token to a different site. Point the Hub URL at its canonical origin.`,
        res.status,
      );
    }
    const next = await this.fetchImpl(target.toString(), init);
    if (isRedirect(next.status)) {
      throw new RemoteRegistryError(
        'network_error',
        `Hub redirected more than once (limit 1 hop): ${next.headers.get('location') ?? target.toString()}`,
        next.status,
      );
    }
    return next;
  }

  private async request<T>(method: string, path: string, opts: RawRequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.extraHeaders ?? {}),
    };

    const url = `${this.hubUrl}${path}`;
    // `redirect: 'manual'`: never let fetch follow a hop for us. On a cross-origin
    // redirect the platform DROPS the `Authorization` header, which turns a valid
    // Hub token into a spurious 401 ("Missing or invalid Hub token"). The Hub's
    // canonical origin is a subdomain (`www.`); its bare apex 307s to it, so we
    // must follow THAT hop ourselves — preserving the credential — and refuse any
    // hop that would hand the token to a different site.
    const init: RequestInit = {
      method,
      headers,
      redirect: 'manual',
      ...(opts.body !== undefined ? { body: opts.body } : {}),
    };

    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
      if (isRedirect(res.status)) res = await this.followSameSiteHop(url, res, init);
    } catch (err) {
      if (err instanceof RemoteRegistryError) throw err;
      throw new RemoteRegistryError('network_error', `Hub request failed: ${(err as Error).message}`);
    }

    const text = await res.text();
    const parsed = parseJson(text);

    if (!res.ok) {
      const envelope = (parsed ?? {}) as Partial<RemoteErrorResponse>;
      const code = (typeof envelope.error === 'string' ? envelope.error : 'network_error') as RegistryErrorCode;
      const message = typeof envelope.message === 'string' ? envelope.message : `HTTP ${res.status}`;
      throw new RemoteRegistryError(code, message, res.status);
    }

    if (parsed === null) {
      throw new RemoteRegistryError('network_error', 'Malformed JSON response from Hub', res.status);
    }
    return parsed as T;
  }
}

function parseJson(text: string): unknown | null {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 3xx = a redirect (we handle it ourselves; see {@link RegistryClient.followSameSiteHop}). */
function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/** Parse a `Location` header against a base URL, or null when malformed. */
function safeUrl(location: string, base: string): URL | null {
  try {
    return new URL(location, base);
  } catch {
    return null;
  }
}

/**
 * Whether two URLs share a registrable domain (their last two DNS labels).
 * The practical "same site" test for a client that talks to exactly one Hub:
 * `markus.global` and `www.markus.global` match; `evil.example` does not.
 */
export function sameSite(a: string, b: string): boolean {
  const labels = (u: string): string[] => {
    try {
      return new URL(u).hostname.toLowerCase().split('.').filter(Boolean);
    } catch {
      return [];
    }
  };
  const la = labels(a);
  const lb = labels(b);
  if (la.length === 0 || lb.length === 0) return false;
  return la.slice(-2).join('.') === lb.slice(-2).join('.');
}
