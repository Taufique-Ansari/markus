import { describe, it, expect } from 'vitest';
import type { TunnelRegistry, TunnelManagerDeps } from '../src/tunnel-manager.js';
import { RegistryClient } from '../src/registry-client.js';
import { persistEndpointSecretForTunnel } from '../src/remote-secrets.js';

// ── Compile-time seam assertions (T6 ↔ T7) ────────────────────────────────────
// `RegistryClient` must satisfy the `TunnelRegistry` interface 1:1 so T8 can
// inject it; our persist adapter must satisfy `TunnelManagerDeps.persistSecret`.
// If either drifts, `tsc -b` fails HERE — that is the point.
const registry: TunnelRegistry = new RegistryClient({ hubUrl: 'https://hub.example', hubToken: 'x' });
const deps: Pick<TunnelManagerDeps, 'registry' | 'persistSecret'> = {
  registry,
  persistSecret: persistEndpointSecretForTunnel,
};

describe('T6 ↔ T7 seam', () => {
  it('RegistryClient is structurally a TunnelRegistry (all five methods)', () => {
    expect(typeof registry.register).toBe('function');
    expect(typeof registry.update).toBe('function');
    expect(typeof registry.remove).toBe('function');
    expect(typeof registry.verify).toBe('function');
  });

  it('persistEndpointSecretForTunnel matches TunnelManagerDeps.persistSecret', () => {
    const dep: NonNullable<TunnelManagerDeps['persistSecret']> = persistEndpointSecretForTunnel;
    expect(typeof dep).toBe('function');
  });

  it('the assembled TunnelManager deps object is type-valid', () => {
    expect(deps.registry).toBe(registry);
    expect(deps.persistSecret).toBe(persistEndpointSecretForTunnel);
  });
});
