/**
 * Remote controller (T8) — the single interface the local API server drives.
 *
 * Two implementations exist during the grey-release:
 *   • tunnel  — wraps a `TunnelManager` (T6) + `RegistryClient` (T7)
 *   • legacy  — wraps the old WebRTC `RemoteAccessAgent` (`mode = 'relay_legacy'`)
 *
 * The API server never imports `@markus/remote`; it holds one of these small
 * objects and only calls the methods below. That keeps `@markus/org-manager`
 * free of a dependency on the remote package (no package cycle) while keeping
 * every status decision in ONE place.
 */
import { DEFAULT_VERIFY_PATH, type RemoteStatusV2 } from './contract.js';
import { buildCompatPayload, legacyStatusToV2, type RemoteStatusCompat } from './remote-status.js';
import type { RemoteAccessStatus } from './agent.js';

/**
 * The controller surface consumed by the API server and the CLI.
 * Deliberately opaque to callers: they broadcast `getRemoteStatus()` verbatim.
 */
export interface RemoteController {
  /** V2 + legacy-compat payload for `remote:status` and `GET /api/settings/remote`. */
  getRemoteStatus(): RemoteStatusCompat;
  /** Just the V2 projection (for callers that want the clean shape). */
  getRemoteStatusV2(): RemoteStatusV2;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Tear down + bring back up (new address for a quick tunnel). */
  restart(): Promise<void>;
  /** Refresh the Hub registration for the current address (no teardown when possible). */
  rotate(): Promise<void>;
  /**
   * Adopt an address for a tunnel started outside Markus (path A manual
   * re-entry / path B Agent-run tunnel): register it with the Hub without
   * spawning anything. See `TunnelManager.adopt`.
   */
  adopt(publicUrl: string): Promise<void>;
  /** Subscribe to state changes; the callback gets a freshly built payload. */
  onStatus(cb: (payload: RemoteStatusCompat) => void): () => void;
  /** Current pending verify token (local verify route read-through), or null. */
  getVerifyToken(): string | null;
  /** Local path the Hub probes for ownership verification. */
  getVerifyPath(): string;
  /** Endpoint id currently registered — the `config.remote.activeEndpointId` pointer. */
  getActiveEndpointId(): string | null;
}

/** Structural view of a `TunnelManager` (T6) — no runtime import, so tests can fake it. */
export interface TunnelSource {
  toRemoteStatusV2(): RemoteStatusV2;
  getStatus(): { endpointId: string | null };
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  restart(): Promise<unknown>;
  rotate(): Promise<unknown>;
  adopt(publicUrl: string): Promise<unknown>;
  onStatus(cb: (status: unknown) => void): () => void;
  getVerifyToken(): string | null;
  getVerifyPath(): string;
}

/** Structural view of the legacy `RemoteAccessAgent`. */
export interface LegacySource {
  getStatus(): RemoteAccessStatus;
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  onStatus(cb: (status: RemoteAccessStatus) => void): () => void;
}

/** Wrap a `TunnelManager` (or any structurally-equal tunnel supervisor). */
export function createTunnelController(source: TunnelSource): RemoteController {
  const snapshot = (): RemoteStatusCompat =>
    buildCompatPayload(source.toRemoteStatusV2(), { endpointId: source.getStatus().endpointId });

  return {
    getRemoteStatus: snapshot,
    getRemoteStatusV2: () => source.toRemoteStatusV2(),
    start: async () => {
      await source.start();
    },
    stop: async () => {
      await source.stop();
    },
    restart: async () => {
      await source.restart();
    },
    rotate: async () => {
      await source.rotate();
    },
    adopt: async (publicUrl: string) => {
      await source.adopt(publicUrl);
    },
    onStatus: (cb) => source.onStatus(() => cb(snapshot())),
    getVerifyToken: () => source.getVerifyToken(),
    getVerifyPath: () => source.getVerifyPath(),
    getActiveEndpointId: () => source.getStatus().endpointId,
  };
}

/** Wrap the legacy WebRTC `RemoteAccessAgent` (`mode = 'relay_legacy'`). */
export function createLegacyController(source: LegacySource): RemoteController {
  const snapshot = (): RemoteStatusCompat =>
    buildCompatPayload(legacyStatusToV2(source.getStatus()), { legacy: source.getStatus() });

  return {
    getRemoteStatus: snapshot,
    getRemoteStatusV2: () => legacyStatusToV2(source.getStatus()),
    start: async () => {
      await source.start();
    },
    stop: async () => {
      await source.stop();
    },
    // The relay has no separate "rotate" — a rebuild is the only way to refresh it.
    restart: async () => {
      await source.stop();
      await source.start();
    },
    rotate: async () => {
      await source.stop();
      await source.start();
    },
    // The legacy relay owns its own address; it cannot adopt an external one.
    adopt: async () => {
      throw new Error('legacy relay does not support adopting an external address');
    },
    onStatus: (cb) => source.onStatus(() => cb(snapshot())),
    getVerifyToken: () => null,
    getVerifyPath: () => DEFAULT_VERIFY_PATH,
    getActiveEndpointId: () => null,
  };
}
