import { describe, it, expect } from 'vitest';
import {
  TunnelManager,
  type TunnelManagerConfig,
  type TunnelManagerDeps,
  type TimerHandle,
  type TimerPort,
  type TunnelRegistry,
} from '../src/tunnel-manager.js';
import type { SpawnFn, SpawnOptions, TunnelProcess } from '../src/process-group.js';

interface FakeProc extends TunnelProcess {
  emit(line: string, stream?: 'stdout' | 'stderr'): void;
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
    };
    calls.push({ bin, args, opts });
    procs.push(proc);
    return proc;
  };
  return { spawn, calls, procs, last: () => procs[procs.length - 1]! };
}

function makeTimer() {
  let seq = 0;
  const api: TimerPort = {
    setTimeout: () => ({ id: ++seq }),
    clearTimeout: (h: TimerHandle) => void h,
    setInterval: () => ({ id: ++seq }),
    clearInterval: (h: TimerHandle) => void h,
  };
  return { api };
}

function makeRegistry() {
  const calls = {
    register: [] as Array<Record<string, unknown>>,
    update: [] as Array<{ id: string; input: Record<string, unknown> }>,
    verify: [] as string[],
  };
  let n = 0;
  const registry: TunnelRegistry = {
    register: async (input) => {
      calls.register.push(input as unknown as Record<string, unknown>);
      n += 1;
      return { endpointId: `ep_${n}`, verifyToken: `vtok_${n}`, verifyPath: '/api/remote/verify' };
    },
    verify: async (id) => {
      calls.verify.push(id);
      return { verified: true, secret: 'sekret', verifiedAt: '2026-10-14T00:00:00.000Z' };
    },
    update: async (id, input) => {
      calls.update.push({ id, input: input as unknown as Record<string, unknown> });
      return { endpoint: {} as never };
    },
    remove: async () => undefined,
  };
  return { registry, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const url = (host: string) => `2024-05-01T12:00:00Z INF |  https://${host}  |`;

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

/** Bring a quick tunnel up to `ready` and return the manager. */
async function upReady(host = 'abc-123.trycloudflare.com') {
  const ctx = build({});
  const p = ctx.mgr.start();
  await flush();
  ctx.spawn.last().emit(url(host));
  await p;
  return ctx;
}

describe('TunnelManager — restart()', () => {
  it('tears down and re-brings-up a quick tunnel, re-registering a fresh endpoint', async () => {
    const ctx = await upReady();
    expect(ctx.mgr.getStatus().state).toBe('ready');
    expect(ctx.mgr.getStatus().endpointId).toBe('ep_1');
    expect(ctx.spawn.calls.length).toBe(1);

    const p = ctx.mgr.restart();
    await flush();
    // A NEW child was spawned (the old one was killed) and a NEW URL appeared.
    expect(ctx.spawn.calls.length).toBe(2);
    ctx.spawn.last().emit(url('def-456.trycloudflare.com'));
    const status = await p;

    expect(status.state).toBe('ready');
    expect(status.publicUrl).toBe('https://def-456.trycloudflare.com');
    // First bring-up + post-restart registration = 2 registers (create/replace).
    expect(ctx.reg.calls.register.length).toBe(2);
    expect(status.endpointId).toBe('ep_2');
  });

  it('restart of a stopping manager leaves it idle, not running', async () => {
    const ctx = await upReady();
    await ctx.mgr.stop();
    expect(ctx.mgr.getStatus().enabled).toBe(false);
    expect(ctx.mgr.getStatus().state).toBe('idle');
  });
});

describe('TunnelManager — rotate()', () => {
  it('quick tunnel: rotate delegates to a full restart (only way to get a new address)', async () => {
    const ctx = await upReady();
    const p = ctx.mgr.rotate();
    await flush();
    expect(ctx.spawn.calls.length).toBe(2); // it restarted
    ctx.spawn.last().emit(url('ghi-789.trycloudflare.com'));
    const status = await p;
    expect(status.publicUrl).toBe('https://ghi-789.trycloudflare.com');
  });

  it('service tunnel: rotate re-reads daemon status and PATCHes the Hub, no restart', async () => {
    // tailscale_funnel is `service`-managed: startCommand + statusCommand are plain commands.
    const spawn = makeSpawn();
    const reg = makeRegistry();
    const mgr = new TunnelManager(
      { kind: 'tailscale_funnel', apiPort: 8056, instanceName: 'My Markus' },
      {
        spawn: spawn.spawn,
        detectBinary: async () => true,
        probePort: async () => true,
        timer: makeTimer().api,
        registry: reg.registry,
      },
    );
    const call = (i: number) => spawn.calls[i]!;

    // Bring it up: `funnel --bg` exits 0, then `funnel status` prints the URL.
    const p = mgr.start();
    await flush();
    call(0).opts.onExit?.(0, null);
    await flush();
    call(1).opts.onLine?.('https://host.tailnet.ts.net', 'stdout');
    call(1).opts.onExit?.(0, null);
    await p;
    expect(mgr.getStatus().state).toBe('ready');
    expect(mgr.getStatus().endpointId).toBe('ep_1');
    expect(mgr.getStatus().publicUrl).toBe('https://host.tailnet.ts.net');
    expect(reg.calls.register.length).toBe(1);
    expect(spawn.calls.length).toBe(2); // startCommand + statusCommand

    const r = mgr.rotate();
    await flush();
    // rotate only re-ran the status query — no teardown, no extra start.
    expect(spawn.calls.length).toBe(3);
    call(2).opts.onLine?.('https://host.tailnet.ts.net', 'stdout'); // unchanged address
    call(2).opts.onExit?.(0, null);
    await r;
    // Address unchanged → no PATCH, no re-register, still ready.
    expect(reg.calls.update.length).toBe(0);
    expect(reg.calls.register.length).toBe(1);
    expect(mgr.getStatus().state).toBe('ready');
  });
});
