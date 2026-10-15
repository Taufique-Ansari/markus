/**
 * Remote status payloads (T8) — the shape of the `remote:status` WebSocket event.
 *
 * The frozen contract (§5) defines `RemoteStatusV2`. During the grey-release the
 * legacy `RemoteAccessStatus` fields must ALSO stay on the wire, because old UI
 * builds still read them. Instead of emitting two different shapes we broadcast
 * ONE superset payload: the V2 fields PLUS the legacy fields as aliases. New
 * code reads V2; old code keeps working; when the legacy relay is deleted (P2)
 * only the compat block here disappears.
 *
 * Everything in this file is pure (no I/O, no spawn) so it is cheap to test.
 */
import type { RemoteAccessStatus, RemotePeerInfo } from './agent.js';
import type { RemoteState, RemoteStatusV2 } from './contract.js';

/**
 * `remote:status` payload = V2 fields + legacy relay fields.
 * `instanceId` doubles as the legacy alias for the tunnel endpoint id, so an old
 * UI that renders a "connection id" still has something meaningful to show.
 */
export interface RemoteStatusCompat extends RemoteStatusV2 {
  /** legacy: relay peer connection state (`=== state === 'ready'` for tunnels) */
  connected: boolean;
  /** legacy: the public address (`=== publicUrl` for tunnels) */
  remoteUrl: string | null;
  /** legacy: WebRTC signalling URL (always null for tunnels) */
  signalUrl: string | null;
  /** legacy: relay instance id (for tunnels: the endpoint id) */
  instanceId: string | null;
  /** legacy: relay peer count (always 0 for tunnels) */
  peerCount: number;
  /** legacy: relay peers (always empty for tunnels) */
  peers: RemotePeerInfo[];
}

/** Legacy relay state → V2 state. One mapping, one place. */
const LEGACY_STATE_TO_V2: Record<RemoteAccessStatus['state'], RemoteState> = {
  idle: 'idle',
  registering: 'starting',
  connecting: 'starting',
  connected: 'ready',
  disconnected: 'degraded',
};

/** Project a legacy `RemoteAccessStatus` into the V2 shape (`mode = 'relay_legacy'`). */
export function legacyStatusToV2(status: RemoteAccessStatus): RemoteStatusV2 {
  return {
    enabled: status.enabled,
    mode: 'relay_legacy',
    state: LEGACY_STATE_TO_V2[status.state] ?? 'idle',
    entryUrl: null,
    publicUrl: status.remoteUrl,
    health: status.connected ? 'up' : status.enabled ? 'down' : 'unknown',
  };
}

/**
 * Build the single `remote:status` payload: V2 fields + legacy aliases.
 *
 * Pass `legacy` for the relay path (its own fields already exist); omit it for
 * tunnels and the aliases are derived from V2 (`connected` ⇔ `state === 'ready'`,
 * `remoteUrl` ⇔ `publicUrl`, `instanceId` ⇔ `endpointId`).
 */
export function buildCompatPayload(
  v2: RemoteStatusV2,
  opts: { endpointId?: string | null; legacy?: RemoteAccessStatus | null } = {},
): RemoteStatusCompat {
  const legacy = opts.legacy;
  if (legacy) {
    return {
      ...v2,
      connected: legacy.connected,
      remoteUrl: legacy.remoteUrl,
      signalUrl: legacy.signalUrl,
      instanceId: legacy.instanceId,
      peerCount: legacy.peerCount,
      peers: legacy.peers,
    };
  }
  return {
    ...v2,
    connected: v2.state === 'ready',
    remoteUrl: v2.publicUrl,
    signalUrl: null,
    instanceId: opts.endpointId ?? null,
    peerCount: 0,
    peers: [],
  };
}
