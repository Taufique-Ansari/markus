import { describe, it, expect, vi } from 'vitest';
import {
  RegistryClient,
  RemoteRegistryError,
  signRotationRequest,
  verifyRotationSignature,
  sha256Hex,
  generateNonce,
  resolveHubBaseUrl,
  endpointPath,
  sameSite,
} from '../src/registry-client.js';
import { SIGNATURE_HEADERS, buildRotationCanonicalString } from '../src/contract.js';

type Call = { url: string; init: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Fake fetch capturing calls and delegating to a handler. */
function makeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return handler(String(url), (init ?? {}) as RequestInit);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

function headersOf(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>;
}

describe('RegistryClient', () => {
  describe('register (POST /api/remote/endpoints)', () => {
    it('sends the request body with a Bearer Hub token and returns the response', async () => {
      const { fetch, calls } = makeFetch(() => jsonResponse(
        { endpointId: 'ep_1', verifyToken: 'tok-abc', verifyPath: '/api/remote/verify' },
        201,
      ));
      const client = new RegistryClient({ hubUrl: 'https://hub.example', hubToken: 'HT', fetch });

      const res = await client.register({ kind: 'cloudflare_quick', publicUrl: 'https://x.trycloudflare.com' });

      expect(res).toEqual({ endpointId: 'ep_1', verifyToken: 'tok-abc', verifyPath: '/api/remote/verify' });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe('https://hub.example/api/remote/endpoints');
      expect(calls[0]!.init.method).toBe('POST');
      const h = headersOf(calls[0]!.init);
      expect(h['Authorization']).toBe('Bearer HT');
      expect(h['Content-Type']).toBe('application/json');
      expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
        kind: 'cloudflare_quick',
        publicUrl: 'https://x.trycloudflare.com',
      });
    });
  });

  describe('list (GET /api/remote/endpoints)', () => {
    it('unwraps the endpoints array', async () => {
      const dto = {
        id: 'ep_1', kind: 'cloudflare_named', instanceName: 'My Markus',
        publicUrl: 'https://m.example.com', verifyPath: '/api/remote/verify',
        verified: true, verifiedAt: '2026-10-14T00:00:00Z', isActive: true,
        lastSeenAt: null, health: 'up', createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z',
      };
      const { fetch, calls } = makeFetch(() => jsonResponse({ endpoints: [dto] }));
      const client = new RegistryClient({ hubUrl: 'https://hub.example', hubToken: 'HT', fetch });

      const list = await client.list();

      expect(list).toEqual([dto]);
      expect(calls[0]!.init.method).toBe('GET');
      expect(headersOf(calls[0]!.init)['Authorization']).toBe('Bearer HT');
    });

    it('tolerates a missing endpoints field', async () => {
      const { fetch } = makeFetch(() => jsonResponse({}));
      const client = new RegistryClient({ hubUrl: 'https://hub.example', hubToken: 'HT', fetch });
      expect(await client.list()).toEqual([]);
    });
  });

  describe('update (PATCH /api/remote/endpoints/:id)', () => {
    it('uses the Hub token by default and sends no signature headers', async () => {
      const { fetch, calls } = makeFetch(() => jsonResponse({ endpoint: { id: 'ep_1' } }));
      const client = new RegistryClient({ hubUrl: 'https://hub.example', hubToken: 'HT', fetch });

      await client.update('ep_1', { publicUrl: 'https://new.trycloudflare.com' });

      const init = calls[0]!.init;
      expect(init.method).toBe('PATCH');
      expect(calls[0]!.url).toBe('https://hub.example/api/remote/endpoints/ep_1');
      const h = headersOf(init);
      expect(h['Authorization']).toBe('Bearer HT');
      expect(h[SIGNATURE_HEADERS.signature]).toBeUndefined();
      expect(h[SIGNATURE_HEADERS.timestamp]).toBeUndefined();
    });

    it('signs the rotation with the endpoint secret (HMAC) and no Bearer token', async () => {
      const callsSeen: Call[] = [];
      const { fetch, calls } = makeFetch((url, init) => {
        callsSeen.push({ url, init });
        return jsonResponse({ endpoint: { id: 'ep_1' } });
      });
      // no hub token supplied → must still work via HMAC
      const client = new RegistryClient({ hubUrl: 'https://hub.example', hubToken: '', fetch, now: () => 1_700_000_000_000 });

      await client.update('ep_1', { lastSeenAt: '2026-10-14T00:00:00Z', health: 'up' }, { signWithSecret: 'sekret' });

      expect(calls).toHaveLength(1);
      const init = calls[0]!.init;
      expect(init.method).toBe('PATCH');
      const h = headersOf(init);
      expect(h['Authorization']).toBeUndefined();

      const rawBody = init.body as string;
      const timestamp = h[SIGNATURE_HEADERS.timestamp]!;
      const nonce = h[SIGNATURE_HEADERS.nonce]!;
      const signature = h[SIGNATURE_HEADERS.signature]!;

      // Header shape matches the frozen contract.
      expect(timestamp).toBe('1700000000');
      expect(signature.startsWith('v1=')).toBe(true);
      expect(nonce.length).toBeGreaterThanOrEqual(16);
      expect(nonce.length).toBeLessThanOrEqual(64);

      // The signature is exactly HMAC-SHA256(secret, canonical) over the sent body.
      const params = { method: 'PATCH', path: '/api/remote/endpoints/ep_1', body: rawBody, timestamp, nonce };
      expect(verifyRotationSignature('sekret', params, signature)).toBe(true);
      expect(verifyRotationSignature('wrong-secret', params, signature)).toBe(false);

      // And the canonical is the LF-joined 6-line form with the sha256 body hash.
      const canonical = buildRotationCanonicalString({
        method: 'PATCH',
        path: '/api/remote/endpoints/ep_1',
        bodyHash: sha256Hex(rawBody),
        timestamp,
        nonce,
      });
      expect(canonical.split('\n')).toHaveLength(6);
    });

    it('changes the signature if the body changes (no signed field is silently dropped)', async () => {
      const sigs: string[] = [];
      const { fetch } = makeFetch((_url, init) => {
        sigs.push(headersOf(init)[SIGNATURE_HEADERS.signature]!);
        return jsonResponse({ endpoint: { id: 'ep_1' } });
      });
      const client = new RegistryClient({ hubUrl: 'https://hub.example', fetch, now: () => 1_700_000_000_000, nonce: () => 'nonce0123456789ab' });

      await client.update('ep_1', { health: 'up' }, { signWithSecret: 'sekret' });
      await client.update('ep_1', { health: 'down' }, { signWithSecret: 'sekret' });

      expect(sigs[0]).not.toBe(sigs[1]);
    });
  });

  describe('remove (DELETE) + verify (POST :id/verify)', () => {
    it('delete targets the endpoint path', async () => {
      const { fetch, calls } = makeFetch(() => jsonResponse({ ok: true }));
      const client = new RegistryClient({ hubUrl: 'https://hub.example', hubToken: 'HT', fetch });
      await client.remove('ep_2');
      expect(calls[0]!.init.method).toBe('DELETE');
      expect(calls[0]!.url).toBe('https://hub.example/api/remote/endpoints/ep_2');
    });

    it('verify posts to the /verify child path', async () => {
      const { fetch, calls } = makeFetch(() => jsonResponse({ verified: true, secret: 's', verifiedAt: '2026-10-14T00:00:00Z' }));
      const client = new RegistryClient({ hubUrl: 'https://hub.example', hubToken: 'HT', fetch });
      const res = await client.verify('ep_2');
      expect(res.verified).toBe(true);
      expect(calls[0]!.init.method).toBe('POST');
      expect(calls[0]!.url).toBe('https://hub.example/api/remote/endpoints/ep_2/verify');
    });
  });

  describe('error handling', () => {
    it('maps a Hub error envelope to a typed error', async () => {
      const { fetch } = makeFetch(() => jsonResponse({ error: 'invalid_public_url', message: 'must be https' }, 400));
      const client = new RegistryClient({ hubUrl: 'https://hub.example', hubToken: 'HT', fetch });
      await expect(client.register({ kind: 'custom', publicUrl: 'http://x' })).rejects.toMatchObject({
        name: 'RemoteRegistryError',
        code: 'invalid_public_url',
        status: 400,
      });
    });

    it('surfaces rate limiting', async () => {
      const { fetch } = makeFetch(() => jsonResponse({ error: 'rate_limited', message: 'slow down' }, 429));
      const client = new RegistryClient({ hubUrl: 'https://hub.example', hubToken: 'HT', fetch });
      const err = await client.list().catch((e) => e as RemoteRegistryError);
      expect(err).toBeInstanceOf(RemoteRegistryError);
      expect(err.code).toBe('rate_limited');
      expect(err.status).toBe(429);
    });

    it('wraps transport failures as network_error', async () => {
      const fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
      const client = new RegistryClient({ hubUrl: 'https://hub.example', hubToken: 'HT', fetch });
      await expect(client.list()).rejects.toMatchObject({ code: 'network_error' });
    });
  });

  describe('helpers', () => {
    it('resolveHubBaseUrl trims a trailing slash and defaults', () => {
      expect(resolveHubBaseUrl('https://hub.example///')).toBe('https://hub.example');
      expect(resolveHubBaseUrl()).toContain('markus.global');
    });

    it('generateNonce respects the contract charset/length bounds', () => {
      for (let i = 0; i < 20; i++) {
        const n = generateNonce();
        expect(n).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(n.length).toBeGreaterThanOrEqual(16);
        expect(n.length).toBeLessThanOrEqual(64);
      }
    });

    it('signRotationRequest with no body uses an empty body hash', () => {
      const h = signRotationRequest('sekret', { method: 'PATCH', path: '/p', timestamp: '1', nonce: 'n' });
      const params = { method: 'PATCH', path: '/p', body: undefined, timestamp: '1', nonce: 'n' };
      expect(verifyRotationSignature('sekret', params, h[SIGNATURE_HEADERS.signature]!)).toBe(true);
    });

    it('endpointPath url-encodes the id', () => {
      expect(endpointPath('ep/1')).toBe('/api/remote/endpoints/ep%2F1');
    });
  });

  // ── Regression: apex → canonical origin must NOT lose the Hub token ──────────
  // Real failure (2026-10-14): `hubUrl: https://markus.global` 307-redirects to
  // `www.markus.global`; a fetch-followed cross-origin hop drops `Authorization`
  // → Hub answers 401 "Missing or invalid Hub token" → registration never lands.
  describe('same-site redirect handling', () => {
    const redirect = (location: string) =>
      new Response(null, { status: 307, headers: { location } });

    it('follows ONE same-site hop and PRESERVES the Authorization header', async () => {
      const seen: Array<{ url: string; auth?: string }> = [];
      const { fetch } = makeFetch((url, init) => {
        seen.push({ url, auth: headersOf(init)['Authorization'] });
        return url === 'https://markus.global/api/remote/endpoints'
          ? redirect('https://www.markus.global/api/remote/endpoints')
          : jsonResponse({ endpoints: [] });
      });
      const client = new RegistryClient({ hubUrl: 'https://markus.global', hubToken: 'HT', fetch });

      await client.list();

      expect(seen.map((s) => s.url)).toEqual([
        'https://markus.global/api/remote/endpoints',
        'https://www.markus.global/api/remote/endpoints',
      ]);
      expect(seen[0]!.auth).toBe('Bearer HT');
      expect(seen[1]!.auth).toBe('Bearer HT'); // the whole point: not stripped
    });

    it('asks fetch NOT to follow redirects itself (redirect: manual)', async () => {
      const { fetch, calls } = makeFetch(() => jsonResponse({ endpoints: [] }));
      const client = new RegistryClient({ hubUrl: 'https://www.markus.global', hubToken: 'HT', fetch });
      await client.list();
      expect(calls[0]!.init.redirect).toBe('manual');
    });

    it('REFUSES a redirect that leaves the Hub site (never leaks the token)', async () => {
      const { fetch, calls } = makeFetch(() => redirect('https://evil.example/api/remote/endpoints'));
      const client = new RegistryClient({ hubUrl: 'https://markus.global', hubToken: 'HT', fetch });

      await expect(client.list()).rejects.toBeInstanceOf(RemoteRegistryError);
      expect(calls).toHaveLength(1); // no second request to the foreign host
    });

    it('refuses more than one redirect hop', async () => {
      const { fetch } = makeFetch((url) => redirect(`${url}-again`));
      const client = new RegistryClient({ hubUrl: 'https://www.markus.global', hubToken: 'HT', fetch });
      await expect(client.list()).rejects.toBeInstanceOf(RemoteRegistryError);
    });

    it('sameSite matches only within one registrable domain', () => {
      expect(sameSite('https://markus.global/a', 'https://www.markus.global/b')).toBe(true);
      expect(sameSite('https://www.markus.global/a', 'https://markus.global/b')).toBe(true);
      expect(sameSite('https://markus.global/a', 'https://evil.example/b')).toBe(false);
      expect(sameSite('https://a.markus.global.evil.com/x', 'https://markus.global/y')).toBe(false);
      expect(sameSite('not-a-url', 'https://markus.global')).toBe(false);
    });
  });
});
