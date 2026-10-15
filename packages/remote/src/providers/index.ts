import type { RemoteEndpointKind } from '../contract.js';
import type { TunnelProvider } from './types.js';
import { cloudflareNamedProvider, cloudflareProvider } from './cloudflare.js';
import { tailscaleFunnelProvider, tailscaleServeProvider } from './tailscale.js';

/**
 * Provider registry — the ONE mapping from a persisted `kind` to the code that
 * knows how to run it. `custom` has no built-in provider: the user brings their
 * own reverse proxy and the manager only registers the address they supply.
 */
export const TUNNEL_PROVIDERS: Record<RemoteEndpointKind, TunnelProvider | null> = {
  cloudflare_quick: cloudflareProvider,
  cloudflare_named: cloudflareNamedProvider,
  tailscale_funnel: tailscaleFunnelProvider,
  tailscale_serve: tailscaleServeProvider,
  custom: null,
};

export function getProvider(kind: RemoteEndpointKind): TunnelProvider | null {
  return TUNNEL_PROVIDERS[kind] ?? null;
}

export { cloudflareNamedProvider, cloudflareProvider, tailscaleFunnelProvider, tailscaleServeProvider };
export * from './types.js';
