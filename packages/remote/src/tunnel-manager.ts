/**
 * TunnelManager — the local tunnel orchestrator (T6).
 *
 * This replaces the ~890-line WebRTC relay network implementation in
 * `agent.ts` with a small supervisor over an external tunnel binary. The data
 * plane no longer flows through our servers: the user's own Cloudflare /
 * Tailscale tunnel carries traffic, and we only (a) start/stop it, (b) read its
 * public URL, (c) register + verify that URL with the Hub (T7 supplies the
 * client), and (d) keep it alive.
 *
 * Lifecycle (contract §5 / design §5):
 *   Detect → Ensure installed (explicit consent) → Start → parse public URL
 *   → Register → Verify → Watchdog (backoff restart · URL-change rotation ·
 *   port health) → Status → Stop/Disable.
 *
 * Everything that talks to the outside world (spawn, port probe, timer,
 * registry) is injected, so the whole lifecycle is unit-testable without a
 * real tunnel binary.
 */

import net from 'node:net';
import { createLogger } from '@markus/shared';
import {
  DEFAULT_VERIFY_PATH,
  type AgentTunnelTaskCommand,
  type CreateEndpointRequest,
  type CreateEndpointResponse,
  type RemoteEndpointHealth,
  type RemoteEndpointKind,
  type RemoteState,
  type RemoteStatusV2,
  type UpdateEndpointRequest,
  type UpdateEndpointResponse,
  type VerifyEndpointResponse,
} from './contract.js';
import { getProvider, type TunnelProvider, type TunnelProviderContext } from './providers/index.js';
import { spawnDetached, type SpawnFn, type TunnelProcess } from './process-group.js';
import { hostnameToOrigin, normalizeHttpsOrigin } from './url-parse.js';

const log = createLogger('remote:tunnel');

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The seam to T7 (`RegistryClient`). T6 never implements HTTP itself; it calls
 * these five methods, which mirror the frozen Hub API 1:1.
 */
export interface TunnelRegistry {
  register(input: CreateEndpointRequest): Promise<CreateEndpointResponse>;
  update(
    id: string,
    input: UpdateEndpointRequest,
    opts?: { signWithSecret?: string },
  ): Promise<UpdateEndpointResponse>;
  remove(id: string): Promise<void>;
  verify(id: string): Promise<VerifyEndpointResponse>;
}

export interface TunnelManagerConfig {
  kind: RemoteEndpointKind;
  /** Local API port the tunnel points at. Default 8056. */
  apiPort?: number;
  /** Loopback host. Default 127.0.0.1 — never widened to 0.0.0.0. */
  bindHost?: string;
  instanceName?: string;
  /** Own domain for `cloudflare_named` / `custom`. */
  hostname?: string;
  /** Direct public URL for `custom` (when no hostname is configured). */
  publicUrl?: string;
  tunnelName?: string;
  configFile?: string;
  /** Public entry shown in status (`https://{user}.remote.markus.global`). */
  entryUrl?: string;
  platform?: NodeJS.Platform;
  /** Explicit user consent to auto-install a missing binary. Falsy → refuse + expose plan. */
  autoInstallConsent?: boolean;
  /** Unregister the Hub endpoint on stop (default false → keep it for fast re-entry). */
  unregisterOnStop?: boolean;
  probeIntervalMs?: number;
  restartBackoffBaseMs?: number;
  restartBackoffMaxMs?: number;
  urlWaitTimeoutMs?: number;
}

export interface TimerHandle {
  readonly id: unknown;
}

export interface TimerPort {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(h: TimerHandle): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(h: TimerHandle): void;
}

export interface TunnelManagerDeps {
  registry?: TunnelRegistry;
  spawn?: SpawnFn;
  detectBinary?: (bin: string) => Promise<boolean>;
  probePort?: (host: string, port: number) => Promise<boolean>;
  /** Called once when a `secret` is issued at verify time (T7 persists it). */
  persistSecret?: (endpointId: string, secret: string) => Promise<void>;
  timer?: TimerPort;
}

/** Local status projection. `TunnelManager.toRemoteStatusV2()` adapts it to the WS payload. */
export interface TunnelStatus {
  enabled: boolean;
  kind: RemoteEndpointKind;
  state: RemoteState;
  health: RemoteEndpointHealth;
  publicUrl: string | null;
  entryUrl: string | null;
  endpointId: string | null;
  restarts: number;
  message?: string;
}

interface ResolvedConfig {
  kind: RemoteEndpointKind;
  apiPort: number;
  bindHost: string;
  instanceName?: string;
  hostname?: string;
  publicUrl?: string;
  tunnelName?: string;
  configFile?: string;
  entryUrl?: string;
  platform: NodeJS.Platform;
  autoInstallConsent: boolean;
  unregisterOnStop: boolean;
  probeIntervalMs: number;
  restartBackoffBaseMs: number;
  restartBackoffMaxMs: number;
  urlWaitTimeoutMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default (production) dependencies
// ─────────────────────────────────────────────────────────────────────────────

const realTimer: TimerPort = {
  setTimeout: (fn, ms) => ({ id: setTimeout(fn, ms) }),
  clearTimeout: (h) => clearTimeout(h.id as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => ({ id: setInterval(fn, ms) }),
  clearInterval: (h) => clearInterval(h.id as ReturnType<typeof setInterval>),
};

function defaultDetectBinary(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    try {
      spawnDetached(process.platform === 'win32' ? 'where' : 'which', [bin], {
        onExit: (code) => finish(code === 0),
      });
    } catch {
      finish(false);
    }
    setTimeout(() => finish(false), 5_000).unref?.();
  });
}

function defaultProbePort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (v: boolean) => {
      try {
        socket.destroy();
      } catch {
        /* already closed */
      }
      resolve(v);
    };
    socket.setTimeout(2_000);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// TunnelManager
// ─────────────────────────────────────────────────────────────────────────────

export class TunnelManager {
  private readonly cfg: ResolvedConfig;
  private readonly provider: TunnelProvider | null;
  private readonly registry?: TunnelRegistry;
  private readonly spawn: SpawnFn;
  private readonly detectBinary: (bin: string) => Promise<boolean>;
  private readonly probePort: (host: string, port: number) => Promise<boolean>;
  private readonly persistSecret?: (endpointId: string, secret: string) => Promise<void>;
  private readonly timer: TimerPort;

  private running = false;
  private stopped = false;
  private state: RemoteState = 'idle';
  private health: RemoteEndpointHealth = 'unknown';
  private message?: string;
  private publicUrl: string | null = null;
  private registeredUrl: string | null = null;
  private endpointId: string | null = null;
  private verifyToken: string | null = null;
  private verifyPath: string = DEFAULT_VERIFY_PATH;
  private secret: string | null = null;
  private restarts = 0;

  /** Reconciler bookkeeping — single-flight sync + one trailing re-run. */
  private syncInFlight: Promise<void> | null = null;
  private syncQueued = false;
  /** True while the Hub registration is known NOT to match `publicUrl`. */
  private registrationStale = false;

  private proc: TunnelProcess | null = null;
  private watchdog: TimerHandle | null = null;
  private restartTimer: TimerHandle | null = null;
  private urlTimer: TimerHandle | null = null;
  private urlWaiter: ((url: string | null) => void) | null = null;

  private readonly listeners = new Set<(s: TunnelStatus) => void>();

  constructor(config: TunnelManagerConfig, deps: TunnelManagerDeps = {}) {
    this.cfg = {
      kind: config.kind,
      apiPort: config.apiPort ?? 8056,
      bindHost: config.bindHost ?? '127.0.0.1',
      instanceName: config.instanceName,
      hostname: config.hostname,
      publicUrl: config.publicUrl,
      tunnelName: config.tunnelName,
      configFile: config.configFile,
      entryUrl: config.entryUrl,
      platform: config.platform ?? process.platform,
      autoInstallConsent: config.autoInstallConsent ?? false,
      unregisterOnStop: config.unregisterOnStop ?? false,
      probeIntervalMs: config.probeIntervalMs ?? 30_000,
      restartBackoffBaseMs: config.restartBackoffBaseMs ?? 2_000,
      restartBackoffMaxMs: config.restartBackoffMaxMs ?? 60_000,
      urlWaitTimeoutMs: config.urlWaitTimeoutMs ?? 30_000,
    };
    this.provider = getProvider(this.cfg.kind);
    this.registry = deps.registry;
    this.spawn = deps.spawn ?? spawnDetached;
    this.detectBinary = deps.detectBinary ?? defaultDetectBinary;
    this.probePort = deps.probePort ?? defaultProbePort;
    this.persistSecret = deps.persistSecret;
    this.timer = deps.timer ?? realTimer;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Check whether the provider binary is on PATH. `custom` is always "installed". */
  async detect(): Promise<{ installed: boolean; binary: string }> {
    if (!this.provider) return { installed: true, binary: 'custom' };
    const binary = this.provider.binary;
    return { installed: await this.detectBinary(binary), binary };
  }

  /** Consent-gated install plan (also consumed by the Agent-assisted path, T10). */
  installPlan(): AgentTunnelTaskCommand[] {
    return this.provider?.installCommands(this.cfg.platform) ?? [];
  }

  async start(): Promise<TunnelStatus> {
    if (this.running) return this.getStatus();
    this.running = true;
    this.stopped = false;
    this.restarts = 0;
    this.message = undefined;

    const det = await this.detect();
    if (!det.installed && !(await this.ensureInstalled(det.binary))) {
      return this.getStatus();
    }

    try {
      const url = await this.bringUp();
      if (!url) return this.getStatus();
    } catch (err) {
      this.fail(`启动隧道失败：${String(err)}`, 'error');
      return this.getStatus();
    }

    await this.requestSync();
    this.startWatchdog();
    return this.getStatus();
  }

  async stop(): Promise<TunnelStatus> {
    this.stopped = true;
    this.running = false;
    this.stopWatchdog();
    if (this.restartTimer) {
      this.timer.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.urlTimer) {
      this.timer.clearTimeout(this.urlTimer);
      this.urlTimer = null;
    }
    this.urlWaiter = null;
    this.registrationStale = false;

    if (this.proc) {
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
    const stopCmd = this.provider?.stopCommand?.(this.ctx());
    if (this.provider?.management === 'service' && stopCmd) {
      await this.runCommand(stopCmd);
    }
    if (this.cfg.unregisterOnStop && this.endpointId && this.registry) {
      try {
        await this.registry.remove(this.endpointId);
      } catch (err) {
        log.warn('endpoint unregister on stop failed', { error: String(err) });
      }
    }

    this.endpointId = null;
    this.verifyToken = null;
    this.secret = null;
    this.registeredUrl = null;
    this.publicUrl = null;
    this.health = 'unknown';
    this.setState('idle');
    return this.getStatus();
  }

  getStatus(): TunnelStatus {
    return {
      enabled: this.running,
      kind: this.cfg.kind,
      state: this.state,
      health: this.health,
      publicUrl: this.publicUrl,
      entryUrl: this.cfg.entryUrl ?? null,
      endpointId: this.endpointId,
      restarts: this.restarts,
      ...(this.message ? { message: this.message } : {}),
    };
  }

  /** Adapt to the frozen WS payload (T8 broadcasts this). */
  toRemoteStatusV2(): RemoteStatusV2 {
    return {
      enabled: this.running,
      mode: this.cfg.kind,
      state: this.state,
      entryUrl: this.cfg.entryUrl ?? null,
      publicUrl: this.publicUrl,
      health: this.health,
      ...(this.message ? { message: this.message } : {}),
    };
  }

  onStatus(listener: (status: TunnelStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Single source of truth for the verify-server (T7 §8.2) — never cached twice. */
  getVerifyToken(): string | null {
    return this.verifyToken;
  }

  getVerifyPath(): string {
    return this.verifyPath;
  }

  /** In-memory only; T7 persists it to ~/.markus/.env (never markus.json). */
  getSecret(): string | null {
    return this.secret;
  }

  /**
   * Tear the tunnel down and bring it back up (T8 "restart" control route).
   *
   * For `process` tunnels (quick cloudflared) the address changes on every
   * bring-up; the new URL is registered with the Hub (a create/replace, per the
   * contract — so the previous active endpoint is superseded, not orphaned).
   * `stop()` clears the local binding, so `start()` performs a fresh
   * registration rather than a rotation.
   */
  async restart(): Promise<TunnelStatus> {
    await this.stop();
    return this.start();
  }

  /**
   * Refresh the Hub registration for the tunnel's address (T8 "rotate" route).
   *
   * `process`/`custom` have no cheaper refresh than a full re-bring-up, so they
   * delegate to {@link restart}. `service` tunnels keep their address, so we
   * re-read it from the daemon status and re-sync the Hub record WITHOUT a
   * teardown.
   */
  async rotate(): Promise<TunnelStatus> {
    if (!this.provider || this.provider.management === 'process') return this.restart();
    const url = await this.pollServiceUrl();
    // skipRotation: the reconciler below performs exactly one Hub PATCH.
    if (url) this.observeUrl(url, { skipRotation: true });
    await this.requestSync();
    return this.getStatus();
  }

  /**
   * Adopt an address for a tunnel the USER — or an Agent acting for them
   * (path B) — already started outside Markus.
   *
   * We spawn nothing: validate the `https:` address, mark the supervisor as
   * running, and register/refresh it with the Hub so the entry gate can reach
   * it. This is the "调本地 API 注册" step of the Path-B flow, and the recovery
   * path for a manual re-entry after a failed verify.
   */
  async adopt(publicUrl: string): Promise<TunnelStatus> {
    const url = normalizeHttpsOrigin(publicUrl);
    if (!url) {
      this.fail('需要以 https:// 开头的公网地址。', 'error');
      return this.getStatus();
    }
    this.running = true;
    this.stopped = false;
    this.restarts = 0;
    // observeUrl sets the address + health and emits exactly one event, and —
    // with skipRotation — leaves the single Hub sync to the reconciler below.
    this.observeUrl(url, { skipRotation: true });
    this.setState('starting');
    await this.requestSync();
    this.startWatchdog();
    return this.getStatus();
  }

  // ── Bring-up ──────────────────────────────────────────────────────────────

  /** Start (or, for `service`, apply) the tunnel and return its public URL, or null. */
  private async bringUp(): Promise<string | null> {
    // `custom`: no binary to run — just adopt the address the user configured.
    if (!this.provider) {
      const url = hostnameToOrigin(this.cfg.hostname) ?? normalizeHttpsOrigin(this.cfg.publicUrl ?? '');
      if (!url) {
        this.fail('自定义模式需要提供公网地址（hostname 或 publicUrl）。', 'error');
        return null;
      }
      this.observeUrl(url);
      return url;
    }

    this.setState('starting');

    if (this.provider.management === 'service') {
      const code = await this.runCommand(this.provider.startCommand(this.ctx()));
      if (code !== 0) {
        this.fail(`${this.provider.binary} 配置失败（退出码 ${code}）。`, 'error');
        return null;
      }
      const url = await this.pollServiceUrl();
      if (!url) {
        this.fail(`未能从 ${this.provider.binary} status 解析公网地址。`, 'degraded');
        return null;
      }
      this.observeUrl(url);
      return url;
    }

    // `process`: own a long-lived child and read the URL from its logs…
    this.spawnTunnel();
    if (this.provider.urlFromConfig) {
      const url = this.provider.urlFromContext?.(this.ctx()) ?? null;
      if (url) this.observeUrl(url);
    }
    const url = await this.waitForUrl();
    if (!url) {
      this.fail(
        `已启动 ${this.provider.binary} 但未能解析公网地址；可在向导中手动填写地址后重试。`,
        'degraded',
      );
      return null;
    }
    return url;
  }

  /** Detect + (only with explicit consent) install. */
  private async ensureInstalled(binary: string): Promise<boolean> {
    if (!this.provider) return true;
    if (!this.cfg.autoInstallConsent) {
      this.fail(
        `未检测到 ${binary}。请先安装，或在向导中授权自动安装（安装步骤见 installPlan()）。`,
        'error',
      );
      return false;
    }
    this.setState('installing', `正在安装 ${binary}…`);
    for (const cmd of this.provider.installCommands(this.cfg.platform)) {
      if (cmd.shell !== 'sh') continue; // Windows steps are executed by the Agent path (T10)
      const code = await this.runCommand({ bin: '/bin/sh', args: ['-c', cmd.run] });
      if (code !== 0) {
        this.fail(`安装命令失败（退出码 ${code}）：${cmd.run}`, 'error');
        return false;
      }
    }
    if (!(await this.detectBinary(binary))) {
      this.fail(`安装后仍未检测到 ${binary}，请检查 PATH。`, 'error');
      return false;
    }
    return true;
  }

  private spawnTunnel(): void {
    // Single writer for the "at most one live tunnel process" invariant. A tunnel
    // that is still running must be torn down before a new one starts, otherwise
    // an explicit restart racing the exit-backoff timer leaves TWO cloudflared
    // processes bound to one instance: two live public hostnames (2026-10-14).
    if (this.proc) {
      if (!this.proc.exited) this.proc.kill('SIGTERM');
      this.proc = null;
    }

    const cmd = this.provider!.startCommand(this.ctx());
    // Capture the handle so `onExit` can tell whether THIS process is still the
    // current one — the exit callback fires asynchronously, long after a
    // deliberate restart has already installed its replacement.
    const proc = this.spawn(cmd.bin, cmd.args, {
      onLine: (line) => {
        const url = this.provider!.parseUrl(line);
        if (url) this.observeUrl(url);
      },
      onExit: (code, signal) => this.onTunnelExit(proc, code, signal),
    });
    this.proc = proc;
  }

  // ── URL observation + registration ────────────────────────────────────────

  /**
   * A new public URL was seen (from logs, from `status`, or from config).
   * Sets it, wakes any waiter, and — if an endpoint is already registered —
   * rotates the Hub record (quick tunnels change address on every restart).
   */
  private observeUrl(url: string, opts: { skipRotation?: boolean } = {}): void {
    if (url === this.publicUrl) return;
    this.publicUrl = url;
    this.health = 'up';
    this.message = undefined;
    this.emit();
    this.resolveUrlWaiter(url);
    // A changed address must be (re)converged with the Hub. `start()`/`adopt()`
    // call the reconciler explicitly; a tunnel RESTART lands here — and must
    // still register even when an earlier transient verify failure left no
    // `endpointId` (2026-10-14: it did not, so a healthy tunnel sat in
    // `degraded` forever, pointing the entry gate at a dead host).
    if (!opts.skipRotation) void this.requestSync();
  }

  private waitForUrl(): Promise<string | null> {
    if (this.publicUrl) return Promise.resolve(this.publicUrl);
    return new Promise((resolve) => {
      this.urlWaiter = resolve;
      this.urlTimer = this.timer.setTimeout(() => {
        this.urlTimer = null;
        this.urlWaiter = null;
        resolve(null);
      }, this.cfg.urlWaitTimeoutMs);
    });
  }

  private resolveUrlWaiter(url: string): void {
    if (!this.urlWaiter) return;
    const waiter = this.urlWaiter;
    this.urlWaiter = null;
    if (this.urlTimer) {
      this.timer.clearTimeout(this.urlTimer);
      this.urlTimer = null;
    }
    waiter(url);
  }

  /**
   * Reconcile the Hub registration with the CURRENT `publicUrl` — the ONE
   * enforcement point for the invariant "if we are enabled and have a public
   * address, the Hub record must match it".
   *
   * Order: register (no endpoint yet) → update (address changed) → verify.
   *
   * A transient failure (Cloudflare's edge needs a few seconds before it routes
   * a brand-new quick-tunnel host, so the ownership probe can legitimately get
   * a 530) KEEPS `endpointId` and marks the registration stale, so the watchdog
   * retries. Nulling the endpoint here is exactly what turned a probe race into
   * a permanent `degraded` with no recovery path (2026-10-14).
   */
  private async syncRegistration(): Promise<void> {
    if (!this.registry || !this.publicUrl) return;

    const target = this.publicUrl;
    const rotated = this.endpointId !== null && target !== this.registeredUrl;
    if (this.endpointId !== null && target === this.registeredUrl && this.state === 'ready') {
      this.registrationStale = false;
      return; // already converged — no Hub round-trip, no state churn
    }

    this.setState('verifying');
    try {
      if (this.endpointId === null) {
        const res = await this.registry.register({
          kind: this.cfg.kind,
          publicUrl: target,
          ...(this.cfg.instanceName ? { instanceName: this.cfg.instanceName } : {}),
        });
        this.endpointId = res.endpointId;
        this.verifyToken = res.verifyToken;
        this.verifyPath = res.verifyPath || DEFAULT_VERIFY_PATH;
      } else if (rotated) {
        await this.registry.update(this.endpointId, { publicUrl: target });
      }

      const verified = await this.registry.verify(this.endpointId);
      if (verified.secret) {
        this.secret = verified.secret;
        if (this.persistSecret) {
          try {
            await this.persistSecret(this.endpointId, verified.secret);
          } catch (err) {
            log.warn('persistSecret failed', { error: String(err) });
          }
        }
      }
      this.registeredUrl = target;
      this.registrationStale = false;
      this.setState('ready', rotated ? `公网地址已更新：${target}` : undefined);
    } catch (err) {
      // Keep `endpointId`: the Hub record exists and the next reconcile can still
      // verify/rotate it (self-heal).
      this.registrationStale = true;
      this.setState('degraded', `注册/校验失败：${String(err)}`);
    }
  }

  /**
   * Single-flight wrapper around {@link syncRegistration}. Concurrent triggers
   * share one Hub round-trip; an address observed while a sync is in flight
   * queues exactly one follow-up pass (so the LAST address always wins).
   */
  private requestSync(): Promise<void> {
    if (this.syncInFlight) {
      this.syncQueued = true;
      return this.syncInFlight;
    }
    const run = this.syncRegistration()
      .catch(() => undefined)
      .then((): Promise<void> | undefined => {
        this.syncInFlight = null;
        if (this.syncQueued) {
          this.syncQueued = false;
          return this.requestSync();
        }
        return undefined;
      });
    this.syncInFlight = run;
    return run;
  }

  // ── Watchdog ──────────────────────────────────────────────────────────────

  private onTunnelExit(proc: TunnelProcess, code: number | null, signal: NodeJS.Signals | null): void {
    // A superseded process is not news. `restart()` sends SIGTERM and immediately
    // starts a replacement; cloudflared shuts down gracefully ~1s later, so
    // without this identity check the OLD process's exit was read as a crash and
    // triggered a SECOND, spurious tunnel (observed: PIDs 58538 + 58548).
    if (this.proc !== proc) return;
    this.proc = null;
    if (this.stopped || !this.running) return;
    log.warn('tunnel process exited', { code, signal });
    this.health = 'down';
    this.scheduleRestart(`隧道进程退出（code=${code ?? '-'} signal=${signal ?? '-'}）`);
  }

  private scheduleRestart(reason: string): void {
    const attempt = this.restarts;
    const delay = Math.min(
      this.cfg.restartBackoffBaseMs * 2 ** attempt,
      this.cfg.restartBackoffMaxMs,
    );
    this.restarts += 1;
    this.setState('degraded', `${reason}，${delay}ms 后重启（第 ${this.restarts} 次）`);
    this.restartTimer = this.timer.setTimeout(() => {
      this.restartTimer = null;
      if (this.stopped || !this.running) return;
      try {
        if (this.provider && this.provider.management === 'service') {
          void this.reapplyService();
        } else if (this.provider) {
          this.setState('starting');
          this.spawnTunnel();
        }
      } catch (err) {
        this.fail(`重启失败：${String(err)}`, 'error');
      }
    }, delay);
  }

  private async reapplyService(): Promise<void> {
    if (!this.provider) return;
    const code = await this.runCommand(this.provider.startCommand(this.ctx()));
    if (code === 0) {
      const url = await this.pollServiceUrl();
      if (url) this.observeUrl(url);
    }
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdog = this.timer.setInterval(() => void this.watchdogTick(), this.cfg.probeIntervalMs);
  }

  private stopWatchdog(): void {
    if (this.watchdog) {
      this.timer.clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  /** One watchdog pass: local port health + (for services) URL reconciliation. */
  async watchdogTick(): Promise<void> {
    if (this.stopped || !this.running) return;

    const portUp = await this.probePort(this.cfg.bindHost, this.cfg.apiPort);
    if (portUp) {
      if (this.health === 'down') {
        this.health = 'up';
        if (this.state === 'degraded') this.setState('ready');
      }
    } else {
      this.health = 'down';
      this.setState('degraded', `本地 API 端口 ${this.cfg.apiPort} 无响应`);
    }

    if (this.provider?.management === 'service') {
      const url = await this.pollServiceUrl();
      if (url) {
        this.observeUrl(url);
      } else if (this.publicUrl) {
        // Funnel/serve config went away — re-apply with backoff.
        this.scheduleRestart('服务隧道已失效');
      }
    }

    // Self-heal: a registration that never converged (transient probe race on a
    // fresh quick-tunnel host, Hub hiccup, tunnel that came up a second late) is
    // retried on every tick instead of being stuck in `degraded` forever.
    if (this.registrationStale && this.publicUrl && this.registry) {
      void this.requestSync();
    }
    this.emit();
  }

  // ── Command helpers ───────────────────────────────────────────────────────

  private ctx(): TunnelProviderContext {
    return {
      bindHost: this.cfg.bindHost,
      apiPort: this.cfg.apiPort,
      ...(this.cfg.hostname ? { hostname: this.cfg.hostname } : {}),
      ...(this.cfg.tunnelName ? { tunnelName: this.cfg.tunnelName } : {}),
      ...(this.cfg.configFile ? { configFile: this.cfg.configFile } : {}),
    };
  }

  /** Run a one-shot command, resolving with its exit code. */
  private runCommand(cmd: { bin: string; args: string[] }): Promise<number> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (code: number) => {
        if (done) return;
        done = true;
        resolve(code);
      };
      try {
        this.spawn(cmd.bin, cmd.args, { onExit: (code) => finish(code ?? 1) });
      } catch {
        finish(1);
      }
    });
  }

  /** Run the provider's status command and return its stdout. */
  private async runCapture(cmd: { bin: string; args: string[] }): Promise<{ code: number; stdout: string }> {
    return new Promise((resolve) => {
      let stdout = '';
      let done = false;
      const finish = (code: number) => {
        if (done) return;
        done = true;
        resolve({ code, stdout });
      };
      try {
        this.spawn(cmd.bin, cmd.args, {
          onLine: (line, stream) => {
            if (stream === 'stdout') stdout += `${line}\n`;
          },
          onExit: (code) => finish(code ?? 1),
        });
      } catch {
        finish(1);
      }
    });
  }

  private async pollServiceUrl(): Promise<string | null> {
    if (!this.provider?.statusCommand || !this.provider.parseStatus) return null;
    const cmd = this.provider.statusCommand(this.ctx());
    if (!cmd) return null;
    const { code, stdout } = await this.runCapture(cmd);
    if (code !== 0) return null;
    return this.provider.parseStatus(stdout);
  }

  // ── Status plumbing ───────────────────────────────────────────────────────

  private setState(state: RemoteState, message?: string): void {
    this.state = state;
    this.message = message;
    this.emit();
  }

  private fail(message: string, state: RemoteState): void {
    this.state = state;
    this.message = message;
    log.error('tunnel manager error', { state, message });
    this.emit();
  }

  private emit(): void {
    const status = this.getStatus();
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch {
        /* a listener must never break the lifecycle */
      }
    }
  }
}
