/**
 * Tunnel provider contract (T6).
 *
 * A *provider* is the per-mechanism knowledge the TunnelManager needs and
 * nothing else: which binary, how to start it, how to read the public URL out
 * of its output, how to tear it down, and the consent-gated install plan.
 * All decisions about lifecycle/backoff/rotation live in the manager, so
 * adding a new mechanism (e.g. ngrok) means adding one provider file — not
 * branching inside the orchestrator.
 */

import type { AgentTunnelTaskCommand, RemoteEndpointKind } from '../contract.js';

/**
 * How a provider is supervised:
 *   • `process` — we own a long-lived child; the URL is parsed from its logs and
 *                 a crash is restarted directly.
 *   • `service` — the command configures a daemon (tailscaled) and returns; the
 *                 URL comes from a separate `status` query and "restart" means
 *                 re-applying the config.
 */
export type TunnelManagement = 'process' | 'service';

/** Everything a provider needs to build its commands. */
export interface TunnelProviderContext {
  /** Loopback host the tunnel points at — always 127.0.0.1, never 0.0.0.0. */
  bindHost: string;
  /** Local API port (default 8056). The web-ui dev port is never exposed. */
  apiPort: number;
  /** Own domain for a named Cloudflare tunnel / custom reverse proxy. */
  hostname?: string;
  /** Named cloudflared tunnel name. */
  tunnelName?: string;
  /** Path to the cloudflared config file (named tunnels). */
  configFile?: string;
}

export interface TunnelCommand {
  bin: string;
  args: string[];
}

export interface TunnelProvider {
  readonly kind: RemoteEndpointKind;
  readonly management: TunnelManagement;
  /** Primary binary — used for detect + install. */
  readonly binary: string;
  /**
   * true → the public URL is a fact of configuration (named tunnel / own
   * domain), not something to scrape from output.
   */
  readonly urlFromConfig: boolean;
  /** Start (process) / apply (service) command. */
  startCommand(ctx: TunnelProviderContext): TunnelCommand;
  /** Parse one live log line → normalised public URL, or null. PURE. */
  parseUrl(line: string): string | null;
  /** Resolve the URL straight from the context (named tunnels). PURE. */
  urlFromContext?(ctx: TunnelProviderContext): string | null;
  /** Service providers: one-shot command printing the current URL. */
  statusCommand?(ctx: TunnelProviderContext): TunnelCommand | null;
  /** Service providers: parse `statusCommand` stdout → URL, or null. PURE. */
  parseStatus?(stdout: string): string | null;
  /** Service providers: tear the config back down on stop. */
  stopCommand?(ctx: TunnelProviderContext): TunnelCommand | null;
  /** Consent-gated install plan for the "hand it to an Agent" path (T10). */
  installCommands(platform: NodeJS.Platform): AgentTunnelTaskCommand[];
}

/** Shared install-command helper so every provider expresses steps identically. */
export function installCommand(
  run: string,
  purpose: string,
  opts: { idempotent?: boolean } = {},
): AgentTunnelTaskCommand {
  return { shell: 'sh', run, purpose, sensitive: true, idempotent: opts.idempotent ?? true };
}
