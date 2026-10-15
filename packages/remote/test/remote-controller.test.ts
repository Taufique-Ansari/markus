import { describe, it, expect } from 'vitest';
import {
  buildCompatPayload,
  legacyStatusToV2,
  type RemoteStatusCompat,
} from '../src/remote-status.js';
import {
  createLegacyController,
  createTunnelController,
  type LegacySource,
  type TunnelSource,
} from '../src/remote-controller.js';
import { DEFAULT_VERIFY_PATH, type RemoteStatusV2 } from '../src/contract.js';
import type { RemoteAccessStatus } from '../src/agent.js';

// ── Pure builders ────────────────────────────────────────────────────────────

const V2: RemoteStatusV2 = {
  enabled: true,
  mode: 'cloudflare_quick',
  state: 'ready',
  entryUrl: 'https://me.remote.markus.global',
  publicUrl: 'https://abc-123.trycloudflare.com',
  health: 'up',
};

describe('buildCompatPayload — single `remote:status` payload', () => {
  it('derives legacy aliases from V2 for tunnels', () => {
    const p = buildCompatPayload(V2, { endpointId: 'ep_1' });
    // V2 fields survive untouched…
    expect(p).toMatchObject(V2);
    // …and every legacy field is present & consistent.
    expect(p.connected).toBe(true);
    expect(p.remoteUrl).toBe('https://abc-123.trycloudflare.com');
    expect(p.signalUrl).toBeNull();
    expect(p.instanceId).toBe('ep_1');
    expect(p.peerCount).toBe(0);
    expect(p.peers).toEqual([]);
  });

  it('maps connected from state (degraded → not connected)', () => {
    const p = buildCompatPayload({ ...V2, state: 'degraded', health: 'down' }, { endpointId: null });
    expect(p.connected).toBe(false);
    expect(p.instanceId).toBeNull();
  });

  it('passes the legacy payload through verbatim on the relay path', () => {
    const legacy: RemoteAccessStatus = {
      enabled: true,
      connected: true,
      state: 'connected',
      instanceId: 'inst-9',
      remoteUrl: 'https://relay.markus.global/r/inst-9',
      signalUrl: 'wss://signal.markus.global',
      peerCount: 2,
      peers: [{ peerId: 'p1', transport: 'p2p', connectedAt: 1, lastActiveAt: 2 }],
    };
    const p = buildCompatPayload(legacyStatusToV2(legacy), { legacy });
    expect(p.mode).toBe('relay_legacy');
    expect(p.connected).toBe(true);
    expect(p.remoteUrl).toBe('https://relay.markus.global/r/inst-9');
    expect(p.signalUrl).toBe('wss://signal.markus.global');
    expect(p.instanceId).toBe('inst-9');
    expect(p.peerCount).toBe(2);
    expect(p.peers).toHaveLength(1);
  });
});

describe('legacyStatusToV2 — state mapping', () => {
  const base = (state: RemoteAccessStatus['state'], connected = false): RemoteAccessStatus => ({
    enabled: true,
    connected,
    state,
    instanceId: 'i',
    remoteUrl: 'https://relay',
    signalUrl: 'wss://signal',
    peerCount: 0,
    peers: [],
  });

  it.each([
    ['idle', 'idle', false],
    ['registering', 'starting', false],
    ['connecting', 'starting', false],
    ['connected', 'ready', true],
    ['disconnected', 'degraded', false],
  ] as const)('maps %s → %s', (legacyState, v2State, connected) => {
    const v2 = legacyStatusToV2(base(legacyState, connected));
    expect(v2.state).toBe(v2State);
    expect(v2.mode).toBe('relay_legacy');
    expect(v2.publicUrl).toBe('https://relay');
    expect(v2.health).toBe(connected ? 'up' : 'down');
  });

  it('reports health unknown when the relay is disabled', () => {
    const v2 = legacyStatusToV2({ ...base('idle'), enabled: false });
    expect(v2.health).toBe('unknown');
  });
});

// ── Controller factories ─────────────────────────────────────────────────────

function makeTunnel() {
  const calls: string[] = [];
  let v2: RemoteStatusV2 = { ...V2 };
  let endpointId: string | null = 'ep_1';
  const listeners = new Set<(s: unknown) => void>();
  const source: TunnelSource = {
    toRemoteStatusV2: () => v2,
    getStatus: () => ({ endpointId }),
    start: async () => void calls.push('start'),
    stop: async () => void calls.push('stop'),
    restart: async () => void calls.push('restart'),
    rotate: async () => void calls.push('rotate'),
    onStatus: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getVerifyToken: () => 'vtok',
    getVerifyPath: () => '/api/remote/verify',
  };
  return {
    source,
    calls,
    setV2: (next: Partial<RemoteStatusV2>) => {
      v2 = { ...v2, ...next };
    },
    setEndpoint: (id: string | null) => {
      endpointId = id;
    },
    emit: () => listeners.forEach((l) => l(undefined)),
  };
}

describe('createTunnelController', () => {
  it('delegates lifecycle calls to the TunnelManager', async () => {
    const t = makeTunnel();
    const c = createTunnelController(t.source);
    await c.start();
    await c.stop();
    await c.restart();
    await c.rotate();
    expect(t.calls).toEqual(['start', 'stop', 'restart', 'rotate']);
  });

  it('builds a V2+legacy payload and exposes the raw V2', () => {
    const t = makeTunnel();
    const c = createTunnelController(t.source);
    const payload = c.getRemoteStatus();
    expect(payload.mode).toBe('cloudflare_quick');
    expect(payload.instanceId).toBe('ep_1');
    expect(payload.connected).toBe(true);
    expect(c.getRemoteStatusV2()).toEqual(t.source.toRemoteStatusV2());
  });

  it('re-reads fresh state on every onStatus callback', () => {
    const t = makeTunnel();
    const c = createTunnelController(t.source);
    const seen: RemoteStatusCompat[] = [];
    const off = c.onStatus((p) => seen.push(p));
    t.emit();
    t.setV2({ state: 'degraded', health: 'down' });
    t.setEndpoint('ep_2');
    t.emit();
    off();
    t.emit();
    expect(seen).toHaveLength(2);
    expect(seen[0]!.state).toBe('ready');
    expect(seen[1]!.state).toBe('degraded');
    expect(seen[1]!.instanceId).toBe('ep_2');
    expect(seen[1]!.connected).toBe(false);
  });

  it('surfaces verify token / path / endpoint id', () => {
    const t = makeTunnel();
    const c = createTunnelController(t.source);
    expect(c.getVerifyToken()).toBe('vtok');
    expect(c.getVerifyPath()).toBe('/api/remote/verify');
    expect(c.getActiveEndpointId()).toBe('ep_1');
  });
});

describe('createLegacyController', () => {
  function makeLegacy() {
    const calls: string[] = [];
    let status: RemoteAccessStatus = {
      enabled: true,
      connected: false,
      state: 'connecting',
      instanceId: 'inst-1',
      remoteUrl: 'https://relay/r/inst-1',
      signalUrl: 'wss://signal',
      peerCount: 0,
      peers: [],
    };
    const listeners = new Set<(s: RemoteAccessStatus) => void>();
    const source: LegacySource = {
      getStatus: () => status,
      start: async () => void calls.push('start'),
      stop: async () => void calls.push('stop'),
      onStatus: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    };
    return {
      source,
      calls,
      set: (next: Partial<RemoteAccessStatus>) => {
        status = { ...status, ...next };
      },
      emit: () => listeners.forEach((l) => l(status)),
    };
  }

  it('reports mode relay_legacy with the legacy fields preserved', () => {
    const l = makeLegacy();
    const c = createLegacyController(l.source);
    const p = c.getRemoteStatus();
    expect(p.mode).toBe('relay_legacy');
    expect(p.instanceId).toBe('inst-1');
    expect(p.signalUrl).toBe('wss://signal');
    expect(p.remoteUrl).toBe('https://relay/r/inst-1');
    expect(c.getActiveEndpointId()).toBeNull();
    expect(c.getVerifyToken()).toBeNull();
    expect(c.getVerifyPath()).toBe(DEFAULT_VERIFY_PATH);
  });

  it('restart/rotate rebuild the relay (stop then start)', async () => {
    const l = makeLegacy();
    const c = createLegacyController(l.source);
    await c.restart();
    await c.rotate();
    expect(l.calls).toEqual(['stop', 'start', 'stop', 'start']);
  });

  it('onStatus re-reads legacy state into a V2 payload', () => {
    const l = makeLegacy();
    const c = createLegacyController(l.source);
    const seen: RemoteStatusCompat[] = [];
    c.onStatus((p) => seen.push(p));
    l.set({ state: 'connected', connected: true });
    l.emit();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.state).toBe('ready');
    expect(seen[0]!.connected).toBe(true);
    expect(seen[0]!.health).toBe('up');
  });
});
