/**
 * Public-URL extraction for tunnel providers (T6).
 *
 * ── Why this is a separate, PURE module ──────────────────────────────────────
 *
 * Both `cloudflared` and `tailscale` change their human-readable output between
 * releases (banner boxes, `INF` prefixed lines, JSON logs, `status` tables). If
 * we matched a whole line or a specific banner we would silently stop detecting
 * the URL on the next upgrade and the user would see a hanging "starting…".
 *
 * So we do the opposite: scan for ANY `https://` token and keep the first one
 * whose HOST belongs to the provider's known domain. An unrecognised shape
 * yields `null` — the manager then falls back to manual entry instead of
 * throwing. Keeping this pure (no `node:*`, no I/O) is what makes it cheap to
 * test against real output samples.
 */

/** Matches a bare `https://…` token; delimiters that never appear inside a URL abort it. */
const URL_TOKEN_RE = /https:\/\/[^\s"'`<>()\[\]{}]+/gi;

/** Punctuation that commonly trails a URL in prose/CSV/banner lines. */
const TRAILING_PUNCT_RE = /[.,;:!?)\]}"']+$/;

/** Collect every `https://…` token in `text`, trimmed of trailing punctuation. */
export function findHttpsUrls(text: string): string[] {
  const out: string[] = [];
  // Fresh regex per call — a module-level /g regex would keep `lastIndex` state.
  const re = new RegExp(URL_TOKEN_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const cleaned = m[0].replace(TRAILING_PUNCT_RE, '');
    if (cleaned.length > 'https://'.length) out.push(cleaned);
  }
  return out;
}

/**
 * Normalise a URL to its HTTPS origin (`https://host[:port]`), dropping any
 * path/query/credentials. Returns `null` for non-HTTPS or unparseable input —
 * a tunnel address is only ever HTTPS, so anything else is noise.
 */
export function normalizeHttpsOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    if (u.username || u.password) return null; // userinfo is never part of a tunnel origin
    return `https://${u.host}`;
  } catch {
    return null;
  }
}

/**
 * First HTTPS origin in `text` whose lowercased hostname passes `accept`.
 * With no `accept`, returns the first HTTPS origin found.
 */
export function firstHttpsOrigin(text: string, accept?: (host: string) => boolean): string | null {
  for (const candidate of findHttpsUrls(text)) {
    const origin = normalizeHttpsOrigin(candidate);
    if (!origin) continue;
    if (accept) {
      let host: string;
      try {
        host = new URL(origin).hostname.toLowerCase();
      } catch {
        continue;
      }
      if (!accept(host)) continue;
    }
    return origin;
  }
  return null;
}

/** Is `host` the apex domain `root` or a subdomain of it? */
function isUnder(host: string, root: string): boolean {
  return host === root || host.endsWith(`.${root}`);
}

/** `cloudflared` quick tunnel → `https://<sub>.trycloudflare.com`. */
export function parseCloudflaredPublicUrl(text: string): string | null {
  return firstHttpsOrigin(text, (h) => isUnder(h, 'trycloudflare.com'));
}

/** `tailscale funnel` / `tailscale serve` → `https://<host>.ts.net`. */
export function parseTailscalePublicUrl(text: string): string | null {
  return firstHttpsOrigin(text, (h) => isUnder(h, 'ts.net'));
}

/**
 * Turn a configured hostname (named Cloudflare tunnel / custom domain) into a
 * normalised HTTPS origin. Tolerates the user pasting a scheme or trailing `/`.
 */
export function hostnameToOrigin(hostname: string | undefined | null): string | null {
  if (!hostname) return null;
  const bare = hostname.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!bare) return null;
  return normalizeHttpsOrigin(`https://${bare}`);
}
