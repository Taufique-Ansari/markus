import { describe, it, expect } from 'vitest';
import {
  findHttpsUrls,
  normalizeHttpsOrigin,
  firstHttpsOrigin,
  parseCloudflaredPublicUrl,
  parseTailscalePublicUrl,
  hostnameToOrigin,
} from '../src/url-parse.js';

/**
 * The URL parsers are the single point of failure for "did the tunnel come up".
 * These samples are the ACTUAL shapes the two binaries emit across versions —
 * banner boxes, INF-prefixed lines, JSON logs and `status` tables. If a future
 * release changes its output, one of these fails instead of a user staring at a
 * hung "starting…" screen.
 */
describe('URL parsing — cloudflared (quick tunnel)', () => {
  it('reads the URL out of the modern banner box (stderr)', () => {
    const line =
      '2024-05-01T12:00:00Z INF |  https://bright-moon-1234.trycloudflare.com                                        |';
    expect(parseCloudflaredPublicUrl(line)).toBe('https://bright-moon-1234.trycloudflare.com');
  });

  it('reads the older "Your quick Tunnel has been created" box', () => {
    const box = [
      '+-----------------------------------------------------------+',
      '|  Your quick Tunnel has been created! Visit it at:         |',
      '|  https://random-subdomain-t9x.trycloudflare.com           |',
      '+-----------------------------------------------------------+',
    ].join('\n');
    expect(parseCloudflaredPublicUrl(box)).toBe('https://random-subdomain-t9x.trycloudflare.com');
  });

  it('reads the URL out of JSON-format logs', () => {
    const line =
      '{"level":"info","time":"2024-05-01T12:00:00Z","message":"Your quick Tunnel has been created! Visit it at https://json-mode-9.trycloudflare.com"}';
    expect(parseCloudflaredPublicUrl(line)).toBe('https://json-mode-9.trycloudflare.com');
  });

  it('tolerates trailing punctuation and a trailing slash', () => {
    expect(parseCloudflaredPublicUrl('Visit https://clean-1.trycloudflare.com/.')).toBe(
      'https://clean-1.trycloudflare.com',
    );
    expect(parseCloudflaredPublicUrl('url is https://clean-2.trycloudflare.com, enjoy')).toBe(
      'https://clean-2.trycloudflare.com',
    );
  });

  it('ignores unrelated / non-trycloudflare URLs', () => {
    expect(parseCloudflaredPublicUrl('see https://developers.cloudflare.com/tunnel')).toBeNull();
    expect(parseCloudflaredPublicUrl('no url on this line')).toBeNull();
  });

  it('rejects a spoofed host that merely contains the string', () => {
    expect(parseCloudflaredPublicUrl('https://evil-trycloudflare.com.attacker.io')).toBeNull();
  });
});

describe('URL parsing — tailscale', () => {
  it('parses `tailscale funnel status` output', () => {
    const out = [
      '# Funnel on:',
      '#     - https://mac-mini.tail1a2b3.ts.net',
      '',
      'https://mac-mini.tail1a2b3.ts.net (Funnel on)',
      '|-- / proxy http://127.0.0.1:8056',
    ].join('\n');
    expect(parseTailscalePublicUrl(out)).toBe('https://mac-mini.tail1a2b3.ts.net');
  });

  it('parses `tailscale serve status` output (tailnet only)', () => {
    const out = [
      'https://workstation.tailabc.ts.net (tailnet only)',
      '|-- / proxy http://127.0.0.1:8056',
    ].join('\n');
    expect(parseTailscalePublicUrl(out)).toBe('https://workstation.tailabc.ts.net');
  });

  it('parses the plain single-line form', () => {
    expect(parseTailscalePublicUrl('https://host.tailnet-name.ts.net')).toBe(
      'https://host.tailnet-name.ts.net',
    );
  });

  it('returns null when the funnel is off', () => {
    expect(parseTailscalePublicUrl('No serve config\n')).toBeNull();
  });
});

describe('URL parsing — helpers', () => {
  it('findHttpsUrls collects every token, trimmed', () => {
    expect(findHttpsUrls('a https://x.ts.net b (https://y.trycloudflare.com)')).toEqual([
      'https://x.ts.net',
      'https://y.trycloudflare.com',
    ]);
  });

  it('normalizeHttpsOrigin keeps only the HTTPS origin', () => {
    expect(normalizeHttpsOrigin('https://a.b.com/path?q=1#frag')).toBe('https://a.b.com');
    expect(normalizeHttpsOrigin('http://a.b.com')).toBeNull();
    expect(normalizeHttpsOrigin('ftp://a.b.com')).toBeNull();
    expect(normalizeHttpsOrigin('not a url')).toBeNull();
    expect(normalizeHttpsOrigin('https://user:pass@a.b.com')).toBeNull();
  });

  it('firstHttpsOrigin honours the host filter', () => {
    const text = 'https://other.example https://real.trycloudflare.com';
    expect(firstHttpsOrigin(text, (h) => h.endsWith('.trycloudflare.com'))).toBe(
      'https://real.trycloudflare.com',
    );
    expect(firstHttpsOrigin(text)).toBe('https://other.example');
  });

  it('hostnameToOrigin normalises user input', () => {
    expect(hostnameToOrigin('markus.example.com')).toBe('https://markus.example.com');
    expect(hostnameToOrigin('https://markus.example.com/')).toBe('https://markus.example.com');
    expect(hostnameToOrigin('  markus.example.com  ')).toBe('https://markus.example.com');
    expect(hostnameToOrigin('')).toBeNull();
    expect(hostnameToOrigin(undefined)).toBeNull();
  });
});
