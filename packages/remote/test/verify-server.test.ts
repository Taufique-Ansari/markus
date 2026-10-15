import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  LOCAL_VERIFY_PATH,
  buildLocalVerifyResponse,
  handleLocalVerifyRequest,
  createLocalVerifyHandler,
} from '../src/verify-server.js';
import { DEFAULT_VERIFY_PATH } from '../src/contract.js';

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  writeHead: (code: number, headers?: Record<string, string>) => FakeRes;
  end: (chunk?: string) => void;
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      res.statusCode = code;
      Object.assign(res.headers, headers ?? {});
      return res;
    },
    end(chunk) {
      if (chunk !== undefined) res.body = chunk;
    },
  };
  return res;
}

function makeReq(url: string, method = 'GET'): IncomingMessage {
  return { url, method, headers: { host: 'abc.trycloudflare.com' } } as unknown as IncomingMessage;
}

describe('verify-server (local /api/remote/verify)', () => {
  it('mirrors the contract default path', () => {
    expect(LOCAL_VERIFY_PATH).toBe(DEFAULT_VERIFY_PATH);
    expect(LOCAL_VERIFY_PATH).toBe('/api/remote/verify');
  });

  describe('buildLocalVerifyResponse', () => {
    it('echoes a present token', () => {
      expect(buildLocalVerifyResponse('tok-1')).toEqual({ token: 'tok-1' });
    });

    it('serialises a missing token as an empty string (§2.7)', () => {
      expect(buildLocalVerifyResponse(null)).toEqual({ token: '' });
      expect(buildLocalVerifyResponse(undefined)).toEqual({ token: '' });
    });
  });

  describe('handleLocalVerifyRequest', () => {
    it('answers 200 JSON with the token echoed through the getter', () => {
      const res = makeRes();
      const handled = handleLocalVerifyRequest(makeReq(LOCAL_VERIFY_PATH), res as unknown as ServerResponse, () => 'tok-abc');

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8');
      expect(res.headers['Cache-Control']).toBe('no-store');
      expect(JSON.parse(res.body)).toEqual({ token: 'tok-abc' });
    });

    it('does NOT cache — the getter is consulted on every request (single source of truth)', () => {
      const getToken = vi.fn()
        .mockReturnValueOnce('first')
        .mockReturnValueOnce('second');

      const r1 = makeRes();
      handleLocalVerifyRequest(makeReq(LOCAL_VERIFY_PATH), r1 as unknown as ServerResponse, getToken);
      const r2 = makeRes();
      handleLocalVerifyRequest(makeReq(LOCAL_VERIFY_PATH), r2 as unknown as ServerResponse, getToken);

      expect(getToken).toHaveBeenCalledTimes(2);
      expect(JSON.parse(r1.body)).toEqual({ token: 'first' });
      expect(JSON.parse(r2.body)).toEqual({ token: 'second' });
    });

    it('returns an empty token when nothing is pending, still 200 (self-test friendly)', () => {
      const res = makeRes();
      handleLocalVerifyRequest(makeReq(LOCAL_VERIFY_PATH), res as unknown as ServerResponse, () => null);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ token: '' });
    });

    it('declines (returns false) for a non-matching path and writes nothing', () => {
      const res = makeRes();
      const handled = handleLocalVerifyRequest(makeReq('/api/other'), res as unknown as ServerResponse, () => 'tok');
      expect(handled).toBe(false);
      expect(res.statusCode).toBe(0);
      expect(res.body).toBe('');
    });

    it('rejects non-GET with 405 and the frozen error envelope', () => {
      const res = makeRes();
      const handled = handleLocalVerifyRequest(makeReq(LOCAL_VERIFY_PATH, 'POST'), res as unknown as ServerResponse, () => 'tok');
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(405);
      expect(res.headers['Allow']).toBe('GET');
      expect(JSON.parse(res.body).error).toBe('method_not_allowed');
    });
  });

  it('createLocalVerifyHandler binds the token source', () => {
    const handler = createLocalVerifyHandler(() => 'bound-token');
    const res = makeRes();
    expect(handler(makeReq(LOCAL_VERIFY_PATH), res as unknown as ServerResponse)).toBe(true);
    expect(JSON.parse(res.body)).toEqual({ token: 'bound-token' });
  });
});
