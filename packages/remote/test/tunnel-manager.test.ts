import { describe, it, expect } from 'vitest';
import {
  TunnelManager,
  type TunnelManagerConfig,
  type TunnelManagerDeps,
  type TunnelRegistry,
  type TimerHandle,
  type TimerPort,
} from '../src/tunnel-manager.js';
import type { SpawnFn, SpawnOptions, TunnelProcess } from '../src/process-group.js';

// ── Test doubles ─────────────────────────────────────────────────────────────
// The whole point of injecting spawn/probe/timer/registry is that the full
// lifecycle can be driven deterministically — no real binary, no wall clock.

interface FakeProc extends TunnelProcess {
  emit(line: string, stream?: 'stdout' | 'stderr'): void;
  exit(code?: number | null, signal?: NodeJS.Signals | null): void;
}

function makeSpawn() {
  const calls: Array<{ bin: string; args: string[]; opts: SpawnOptions }> = [];
  const procs: FakeProc[] = [];
  const spawn: SpawnFn = (bin, args, opts) => {
    const proc: FakeProc = {
      pid: 1000 + calls.length,
      exited: false,
      kill: () => {
        proc.exited = true;
      },
      emit: (line, stream = 'stdout') => opts.onLine?.(line, stream),
      exit: (code = 0, signal = null) => {
        if (proc.exited) return;
        proc.exited = true;
        opts.onExit?.(code, signal);
      },
    };
    calls.push({ bin, args, opts });
    procs.push(proc);
    return proc;
  };
  return { spawn, calls, procs, last: () => procs[procs.length - 1]! };
}

function makeTimer() {
  let seq = 0;
  const timeouts = new Map<number, { fn: () => void; ms: number }>();
  const intervals = new Map<number, { fn: () => void; ms: number }>();
  const api: TimerPort = {
    setTimeout: (fn, ms) => {
      timeouts.set(++seq, { fn, ms });
      return { id: seq };
    },
    clearTimeout: (h: TimerHandle) => void timeouts.delete(h.id as number),
    setInterval: (fn, ms) => {
      intervals.set(++seq, { fn, ms });
      return { id: seq };
    },
    clearInterval: (h: TimerHandle) => void intervals.delete(h.id as number),
  };
  return {
    api,
    pending: () => [...timeouts.values()].map((t) => t.ms),
    pendingCount: () => timeouts.size,
    fireFirst: () => {
      const id = [...timeouts.keys()][0];
      if (id === undefined) return;
      const t = timeouts.get(id)!;
      timeouts.delete(id);
      t.fn();
    },
    fireAll: () => {
      for (const id of [...timeouts.keys()]) {
        const t = timeouts.get(id);
        timeouts.delete(id);
        t?.fn();
      }
    },
    intervalCount: () => intervals.size,
  };
}

function makeRegistry() {
  const calls = {
    register: [] as Array<Record<string, unknown>>,
    update: [] as Array<{ id: string; input: Record<string, unknown> }>,
    remove: [] as string[],
    verify: [] as string[],
  };
  const registry: TunnelRegistry = {
    register: async (input) => {
      calls.register.push(input as unknown as Record<string, unknown>);
      return { endpointId: 'ep_1', verifyToken: 'vtok', verifyPath: '/api/remote/verify' };
    },
    verify: async (id) => {
      calls.verify.push(id);
      return { verified: true, secret: 'sekret', verifiedAt: '2026-10-14T00:00:00.000Z' };
    },
    update: async (id, input) => {
      calls.update.push({ id, input: input as unknown as Record<string, unknown> });
      return { endpoint: {} as never };
    },
    remove: async (id) => void calls.remove.push(id),
  };
  return { registry, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const URL_LINE = '2024-05-01T12:00:00Z INF |  https://abc-123.trycloudflare.com  |';

function build(config: Partial<TunnelManagerConfig>, deps: Partial<TunnelManagerDeps> = {}) {
  const spawn = makeSpawn();
  const timer = makeTimer();
  const reg = makeRegistry();
  const mgr = new TunnelManager(
    { kind: 'cloudflare_quick', apiPort: 8056, instanceName: 'My Markus', ...config },
    {
      spawn: spawn.spawn,
      detectBinary: async () => true,
      probePort: async () => true,
      timer: timer.api,
      registry: reg.registry,
      ...deps,
    },
  );
  return { mgr, spawn, timer, reg };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('TunnelManager — bring-up', () => {
  it('starts cloudflared against the loopback API port only, registers, verifies, persists secret', async () => {
    const persisted: Array<{ id: string; secret: string }> = [];
    const { mgr, spawn, reg } = build({}, { persistSecret: async (id, s) => void persisted.push({ id, secret: s }) });

    const p = mgr.start();
    await flush();

    expect(spawn.calls[0].bin).toBe('cloudflared');
    // The ONLY bind target is 127.0.0.1:{apiPort} — never 0.0.0.0, never the web-ui dev port.
    expect(spawn.calls[0].args).toContain('http://127.0.0.1:8056');

    spawn.last().emit(URL_LINE);
    const status = await p;

    expect(status.state).toBe('ready');
    expect(status.publicUrl).toBe('https://abc-123.trycloudflare.com');
    expect(reg.calls.register[0]).toMatchObject({
      kind: 'cloudflare_quick',
      publicUrl: 'https://abc-123.trycloudflare.com',
      instanceName: 'My Markus',
    });
    expect(reg.calls.verify).toContain('ep_1');
    expect(persisted).toEqual([{ id: 'ep_1', secret: 'sekret' }]);
    expect(mgr.getVerifyToken()).toBe('vtok');
    expect(mgr.toRemoteStatusV2().mode).toBe('cloudflare_quick');
    expect(mgr.toRemoteStatusV2().state).toBe('ready');
  });

  it('refuses to install a missing binary without consent, and exposes the install plan', async () => {
    const spawn = makeSpawn();
    const { registry } = makeRegistry();
    const mgr = new TunnelManager(
      { kind: 'cloudflare_quick' },
      { spawn: spawn.spawn, detectBinary: async () => false, timer: makeTimer().api, registry },
    );

    const status = await mgr.start();
    expect(status.state).toBe('error');
    expect(status.message).toMatch(/cloudflared/);
    expect(spawn.calls.length).toBe(0); // never even tried to spawn the tunnel

    const plan = mgr.installPlan();
    expect(plan.length).toBeGreaterThan(0);
    expect(plan[0]!.sensitive).toBe(true);
    expect(plan[0]!.run.length).toBeGreaterThan(0);
  });

  it('installs (with consent) and then starts', async () => {
    const spawn = makeSpawn();
    const { registry } = makeRegistry();
    let detects = 0;
    const mgr = new TunnelManager(
      { kind: 'cloudflare_quick', autoInstallConsent: true, platform: 'darwin' },
      {
        spawn: spawn.spawn,
        detectBinary: async () => ++detects > 1, // missing on 1st check, present after install
        probePort: async () => true,
        timer: makeTimer().api,
        registry,
      },
    );

    const p = mgr.start();
    await flush();
    expect(spawn.calls[0].bin).toBe('/bin/sh');
    expect(spawn.calls[0].args[0]).toBe('-c');

    spawn.last().exit(0); // install succeeds
    await flush();
    expect(spawn.calls[1].bin).toBe('cloudflared');

    spawn.last().emit(URL_LINE);
    const status = await p;
    expect(status.state).toBe('ready');
  });

  it('uses the configured hostname for a named tunnel (no log scraping)', async () => {
    const { mgr, spawn, reg } = build({ kind: 'cloudflare_named', hostname: 'markus.example.com' });

    const p = mgr.start();
    await flush();
    expect(spawn.calls[0].args).toContain('run');
    const status = await p;

    expect(status.publicUrl).toBe('https://markus.example.com');
    expect(reg.calls.register[0]).toMatchObject({ kind: 'cloudflare_named', publicUrl: 'https://markus.example.com' });
  });

  it('registers a user-supplied URL for the `custom` kind', async () => {
    const { mgr, reg } = build({ kind: 'custom', hostname: 'proxy.mycorp.net' });
    const status = await mgr.start();
    expect(status.state).toBe('ready');
    expect(status.publicUrl).toBe('https://proxy.mycorp.net');
    expect(reg.calls.register[0]).toMatchObject({ kind: 'custom' });
  });

  it('fails with an actionable message when the URL cannot be parsed in time', async () => {
    const { mgr, spawn, timer, reg } = build({ urlWaitTimeoutMs: 30_000 });
    const p = mgr.start();
    await flush();
    spawn.last().emit('2024-05-01T12:00:00Z INF Registering tunnel connections...');

    expect(timer.pendingCount()).toBe(1); // the URL-wait timeout
    timer.fireFirst();

    const status = await p;
    expect(status.state).toBe('degraded');
    expect(status.message).toMatch(/解析|手动/);
    expect(reg.calls.register.length).toBe(0); // never registered without a URL
  });
});

describe('TunnelManager — watchdog', () => {
  it('restarts with exponential backoff on process exit and rotates the URL on change', async () => {
    const { mgr, spawn, timer, reg } = build({ restartBackoffBaseMs: 2000, restartBackoffMaxMs: 60000 });

    const p = mgr.start();
    await flush();
    spawn.last().emit(URL_LINE);
    await p;
    expect(mgr.getStatus().state).toBe('ready');

    // First unexpected exit → degraded, backoff scheduled, restart counted.
    spawn.last().exit(1, null);
    expect(mgr.getStatus().state).toBe('degraded');
    expect(mgr.getStatus().restarts).toBe(1);
    expect(timer.pending()).toEqual([2000]);

    // Backoff fires → a brand-new process is spawned.
    timer.fireFirst();
    await flush();
    expect(spawn.calls.length).toBe(2);

    // Quick tunnels get a NEW url on restart → the Hub record is rotated.
    spawn.last().emit('INF |  https://new-host-x9.trycloudflare.com  |');
    await flush();
    expect(reg.calls.update).toEqual([
      { id: 'ep_1', input: { publicUrl: 'https://new-host-x9.trycloudflare.com' } },
    ]);
    expect(mgr.getStatus().state).toBe('ready');
    expect(mgr.getStatus().publicUrl).toBe('https://new-host-x9.trycloudflare.com');

    // Second exit → the delay doubles (exponential backoff, not a fixed retry).
    spawn.last().exit(1, null);
    expect(mgr.getStatus().restarts).toBe(2);
    expect(timer.pending()).toContain(4000);
  });

  it('does not rotate when the same URL is observed again', async () => {
    const { mgr, spawn, reg } = build();
    const p = mgr.start();
    await flush();
    spawn.last().emit(URL_LINE);
    await p;

    spawn.last().emit(URL_LINE); // same address, e.g. a periodic log line
    await flush();
    expect(reg.calls.update.length).toBe(0);
  });

  it('marks degraded when the local API port is unreachable and recovers', async () => {
    let up = true;
    const { mgr, spawn } = build({}, { probePort: async () => up });
    const p = mgr.start();
    await flush();
    spawn.last().emit(URL_LINE);
    await p;

    up = false;
    await mgr.watchdogTick();
    expect(mgr.getStatus().health).toBe('down');
    expect(mgr.getStatus().state).toBe('degraded');

    up = true;
    await mgr.watchdogTick();
    expect(mgr.getStatus().health).toBe('up');
    expect(mgr.getStatus().state).toBe('ready');
  });

  it('stops cleanly: kills the process, tears down the service, unregisters when configured', async () => {
    const { mgr, spawn, reg } = build({ kind: 'cloudflare_quick', unregisterOnStop: true });
    const p = mgr.start();
    await flush();
    spawn.last().emit(URL_LINE);
    await p;
    const tunnelProc = spawn.last();

    const status = await mgr.stop();
    expect(tunnelProc.exited).toBe(true);
    expect(status.state).toBe('idle');
    expect(status.publicUrl).toBeNull();
    expect(reg.calls.remove).toEqual(['ep_1']);
    expect(mgr.getVerifyToken()).toBeNull();
  });
});

describe('TunnelManager — tailscale (service management)', () => {
  it('applies a funnel via `funnel --bg`, reads the URL from `funnel status`, and tears down with `funnel off`', async () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const spawn: SpawnFn = (bin, args, opts) => {
      calls.push({ bin, args });
      const proc: TunnelProcess = { pid: 100 + calls.length, exited: false, kill: () => undefined };
      if (args[0] === 'funnel' && args[1] === 'status') {
        queueMicrotask(() => {
          opts.onLine?.('https://host.tailabc.ts.net (Funnel on)', 'stdout');
          opts.onLine?.('|-- / proxy http://127.0.0.1:8056', 'stdout');
          opts.onExit?.(0, null);
        });
      } else {
        queueMicrotask(() => opts.onExit?.(0, null));
      }
      return proc;
    };
    const { registry } = makeRegistry();
    const mgr = new TunnelManager(
      { kind: 'tailscale_funnel', apiPort: 8056 },
      { spawn, detectBinary: async () => true, probePort: async () => true, timer: makeTimer().api, registry },
    );

    const status = await mgr.start();
    expect(status.state).toBe('ready');
    expect(status.publicUrl).toBe('https://host.tailabc.ts.net');
    expect(calls.map((c) => c.args.join(' '))).toContain('funnel --bg 8056');
    expect(calls.map((c) => c.args.join(' '))).toContain('funnel status');

    await mgr.stop();
    expect(calls.map((c) => c.args.join(' '))).toContain('funnel off');
  });
});

// ── Registration reconciliation (2026-10-14 field regression) ────────────────
// Field symptom: after a restart the Settings panel showed
// `注册/校验失败：RemoteRegistryError: Ownership probe failed: malformed_response`
// and NEVER recovered, even though the tunnel itself was healthy (200 OK).
describe('TunnelManager — registration reconciliation', () => {
  /** Registry whose `verify` fails while `fail` is set (a transient Hub 530). */
  function makeFlakyRegistry() {
    const calls = { register: [] as string[], update: [] as string[], verify: 0 };
    let fail = true;
    const registry: TunnelRegistry = {
      register: async (input) => {
        calls.register.push(String((input as { publicUrl?: unknown }).publicUrl));
        return { endpointId: 'ep_t', verifyToken: 'vtok', verifyPath: '/api/remote/verify' };
      },
      verify: async () => {
        calls.verify += 1;
        if (fail) throw new Error('Ownership probe failed: malformed_response');
        return { verified: true, secret: 'sekret', verifiedAt: '2026-10-14T00:00:00.000Z' };
      },
      update: async (id, input) => {
        calls.update.push(`${id}:${String((input as { publicUrl?: unknown }).publicUrl)}`);
        return { endpoint: {} as never };
      },
      remove: async () => undefined,
    };
    return { registry, calls, heal: () => (fail = false) };
  }

  it('keeps the endpoint after a transient probe failure and self-heals on the next watchdog tick', async () => {
    const reg = makeFlakyRegistry();
    const { mgr, spawn } = build({}, { registry: reg.registry });

    const p = mgr.start();
    await flush();
    spawn.last().emit(URL_LINE);
    const status = await p;

    // Probe raced Cloudflare's edge → degraded, but the Hub record still exists.
    expect(status.state).toBe('degraded');
    expect(status.message).toMatch(/注册\/校验失败/);
    expect(status.endpointId).toBe('ep_t'); // NOT nulled — that was the bug
    const attemptsAtStart = reg.calls.verify;
    expect(attemptsAtStart).toBeGreaterThanOrEqual(1);

    // No URL change, no user action: the next tick retries and converges.
    reg.heal();
    await mgr.watchdogTick();
    await flush();
    await flush();
    expect(mgr.getStatus().state).toBe('ready');
    expect(reg.calls.verify).toBeGreaterThan(attemptsAtStart);
  });

  it('re-registers a tunnel that restarted with a NEW url after the first attempt failed', async () => {
    const reg = makeFlakyRegistry();
    const { mgr, spawn, timer } = build({ restartBackoffBaseMs: 2000 }, { registry: reg.registry });

    const p = mgr.start();
    await flush();
    spawn.last().emit(URL_LINE);
    await p;
    expect(mgr.getStatus().state).toBe('degraded');

    // Tunnel process dies → backoff fires → new process → brand-new random host.
    reg.heal();
    spawn.last().exit(1, null);
    timer.fireFirst();
    await flush();
    spawn.last().emit('INF |  https://brand-new-host.trycloudflare.com  |');
    await flush();

    expect(mgr.getStatus().publicUrl).toBe('https://brand-new-host.trycloudflare.com');
    expect(mgr.getStatus().state).toBe('ready');
    // The rotated address reached the Hub (update), not just local state.
    expect(reg.calls.update).toContain('ep_t:https://brand-new-host.trycloudflare.com');
  });

  it('does not touch the Hub again once a registration has converged', async () => {
    const { mgr, spawn, reg } = build();
    const p = mgr.start();
    await flush();
    spawn.last().emit(URL_LINE);
    await p;
    expect(mgr.getStatus().state).toBe('ready');

    await mgr.watchdogTick();
    await mgr.watchdogTick();
    expect(reg.calls.verify.length).toBe(1); // converged ⇒ no extra round-trips
    expect(reg.calls.register.length).toBe(1);
  });
});

// ── One live tunnel process (2026-10-14: PIDs 58538 + 58548) ─────────────────
// `restart()` sends SIGTERM and immediately starts a replacement, but cloudflared
// shuts down gracefully ~1s later — by which time `running` is true again, so the
// exit was misread as a crash and spawned a SECOND tunnel (two live public hosts).
describe('TunnelManager — at most one live tunnel process', () => {
  /** Models real cloudflared: SIGTERM is sent, but the process dies a moment later. */
  function makeLingeringSpawn() {
    interface P {
      pid: number;
      exited: boolean;
      killed: boolean;
      line: (l: string) => void;
      die: (code?: number) => void;
      kill: () => void;
    }
    const procs: P[] = [];
    const spawn: SpawnFn = (_bin, _args, opts) => {
      const p: P = {
        pid: 3000 + procs.length,
        exited: false,
        killed: false,
        line: (l) => opts.onLine?.(l, 'stdout'),
        die: (code = 0) => {
          if (p.exited) return;
          p.exited = true;
          opts.onExit?.(code, null);
        },
        kill: () => {
          p.killed = true; // signal delivered; the process is still alive
        },
      };
      procs.push(p);
      return p as unknown as TunnelProcess;
    };
    return { spawn, procs };
  }

  it('ignores the late exit of a superseded process instead of spawning a second tunnel', async () => {
    const { spawn, procs } = makeLingeringSpawn();
    const { registry } = makeRegistry();
    const timer = makeTimer();
    const mgr = new TunnelManager(
      { kind: 'cloudflare_quick', apiPort: 8056 },
      { spawn, detectBinary: async () => true, probePort: async () => true, timer: timer.api, registry },
    );

    const p = mgr.start();
    await flush();
    procs[0]!.line(URL_LINE);
    await p;
    expect(mgr.getStatus().state).toBe('ready');
    expect(procs.length).toBe(1);

    // Explicit restart: SIGTERM to #0, then a fresh process #1.
    const rp = mgr.restart();
    await flush();
    expect(procs[0]!.killed).toBe(true);
    expect(procs.length).toBe(2);
    procs[1]!.line(URL_LINE);
    await rp;
    expect(mgr.getStatus().state).toBe('ready');

    // #0 finally exits. It is no longer the current process — not a crash.
    procs[0]!.die(0);
    await flush();
    timer.fireAll(); // any scheduled backoff restart would fire here
    await flush();

    expect(procs.length).toBe(2); // the bug spawned a third here
    expect(mgr.getStatus().restarts).toBe(0);
    expect(mgr.getStatus().state).toBe('ready');
  });
});
