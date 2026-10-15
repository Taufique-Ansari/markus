import { describe, it, expect } from 'vitest';
import {
  AGENT_SETUP_PLATFORMS,
  AGENT_SETUP_PLAN_VERSION,
  DEFAULT_LOCAL_API_PORT,
  buildAgentSetupPlan,
  buildAgentSetupPrompt,
  buildAgentTunnelTaskContract,
  buildEntryUrl,
} from '../src/agent-setup.js';
import {
  TunnelManager,
  type TimerHandle,
  type TimerPort,
  type TunnelRegistry,
} from '../src/tunnel-manager.js';
import { createLegacyController, createTunnelController } from '../src/remote-controller.js';
import type { RemoteEndpointKind } from '../src/contract.js';

const KINDS: RemoteEndpointKind[] = [
  'cloudflare_quick',
  'cloudflare_named',
  'tailscale_funnel',
  'tailscale_serve',
  'custom',
];

describe('Path B — AgentTunnelTaskContract builder (T10)', () => {
  it('exposes a versioned plan and the three supported platforms', () => {
    expect(AGENT_SETUP_PLAN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect([...AGENT_SETUP_PLATFORMS]).toEqual(['macos', 'linux', 'windows']);
    expect(DEFAULT_LOCAL_API_PORT).toBe(8056);
  });

  it('emits install → start → register for cloudflare_quick, in that order', () => {
    const c = buildAgentTunnelTaskContract({ kind: 'cloudflare_quick', platform: 'linux', localPort: 8056 });
    expect(c.commands).toHaveLength(3);
    expect(c.commands[0]!.run).toContain('cloudflared');
    expect(c.commands[0]!.purpose).toContain('安装');
    expect(c.commands[1]!.run).toBe('cloudflared tunnel --url http://127.0.0.1:8056');
    expect(c.commands[2]!.run).toContain('/api/settings/remote/tunnel/register');
    expect(c.commands[2]!.run).toContain('<TUNNEL_URL>');
  });

  it('points every command at loopback, never 0.0.0.0', () => {
    for (const kind of KINDS) {
      const c = buildAgentTunnelTaskContract({ kind, platform: 'linux' });
      for (const cmd of c.commands) {
        expect(cmd.run).not.toContain('0.0.0.0');
      }
    }
  });

  it('marks the install + Hub-register steps sensitive and the tunnel start not', () => {
    const c = buildAgentTunnelTaskContract({ kind: 'cloudflare_quick', platform: 'linux' });
    expect(c.commands[0]!.sensitive).toBe(true);
    expect(c.commands[1]!.sensitive).toBe(false);
    expect(c.commands[2]!.sensitive).toBe(true);
  });

  it('skips the register step for tailscale_serve (tailnet-only, never reaches the Hub)', () => {
    const c = buildAgentTunnelTaskContract({ kind: 'tailscale_serve', platform: 'macos' });
    expect(c.commands.some((x) => x.run.includes('/tunnel/register'))).toBe(false);
    expect(c.successCriteria.some((s) => s.id === 'hub_entry_ready')).toBe(false);
  });

  it('emits no install step for custom (the user already runs a proxy)', () => {
    const c = buildAgentTunnelTaskContract({ kind: 'custom', platform: 'linux' });
    expect(c.commands.some((x) => x.purpose.includes('安装'))).toBe(false);
    expect(c.commands.some((x) => x.run.includes('/tunnel/register'))).toBe(true);
  });

  it('always carries binary/tunnel/address criteria, adding the Hub entry one only with a username', () => {
    const without = buildAgentTunnelTaskContract({ kind: 'cloudflare_quick', platform: 'linux' });
    expect(without.successCriteria.map((s) => s.id)).toEqual([
      'binary_present',
      'tunnel_enabled',
      'address_registered',
    ]);
    const withUser = buildAgentTunnelTaskContract({
      kind: 'cloudflare_quick',
      platform: 'linux',
      username: 'alice',
      hubUrl: 'https://www.markus.global/',
    });
    const entry = withUser.successCriteria.find((s) => s.id === 'hub_entry_ready');
    expect(entry).toBeDefined();
    expect(entry!.check).toContain('https://www.markus.global/api/remote/entry/alice');
  });

  it('uses `where` on Windows and `command -v` elsewhere for the binary check', () => {
    const win = buildAgentTunnelTaskContract({ kind: 'tailscale_funnel', platform: 'windows' });
    expect(win.successCriteria[0]!.check).toContain('where tailscale');
    const nix = buildAgentTunnelTaskContract({ kind: 'tailscale_funnel', platform: 'linux' });
    expect(nix.successCriteria[0]!.check).toContain('command -v tailscale');
  });

  it('always provides a rollback that disables local remote access', () => {
    for (const kind of KINDS) {
      const c = buildAgentTunnelTaskContract({ kind, platform: 'linux' });
      expect(c.rollback.length).toBeGreaterThan(0);
      expect(c.rollback.some((r) => r.run?.includes('/api/settings/remote/disable'))).toBe(true);
    }
  });

  it('states the goal in terms of the entry URL and the no-server-relay promise', () => {
    const c = buildAgentTunnelTaskContract({ kind: 'cloudflare_quick', platform: 'linux', username: 'bob' });
    expect(c.goal).toContain('bob.remote.markus.global');
    expect(c.goal).toContain('不经过');
  });

  it('is deterministic — the same input yields a byte-identical plan and prompt', () => {
    const a = buildAgentSetupPlan({ kind: 'cloudflare_named', platform: 'macos', localPort: 9000, username: 'x' });
    const b = buildAgentSetupPlan({ kind: 'cloudflare_named', platform: 'macos', localPort: 9000, username: 'x' });
    expect(a.prompt).toBe(b.prompt);
    expect(JSON.stringify(a.contract)).toBe(JSON.stringify(b.contract));
  });

  it('embeds the contract as JSON plus the non-negotiable execution rules', () => {
    const { contract, prompt } = buildAgentSetupPlan({ kind: 'cloudflare_quick', platform: 'linux' });
    expect(prompt).toContain(JSON.stringify(contract, null, 2));
    expect(prompt).toContain('sensitive=true');
    expect(prompt).toContain('successCriteria');
    expect(prompt).toContain('不要执行契约之外的操作');
    expect(buildAgentSetupPrompt(contract)).toBe(prompt);
  });

  it('asks the Agent to report the URL(s) that reach the local Markus, entry URL included', () => {
    const withUser = buildAgentSetupPlan({ kind: 'cloudflare_quick', platform: 'linux', username: 'bob' });
    expect(withUser.prompt).toContain('可以用哪个（哪些）地址访问本机 Markus');
    expect(withUser.prompt).toContain('https://bob.remote.markus.global');
    expect(withUser.prompt).toContain('隧道直接地址');
    // The wizard prefills this into a composer; it must read as the user's ask.
    expect(withUser.prompt).not.toContain('用户已在设置向导中点过');

    // Without a username there is no fixed entry URL to promise — only the tunnel.
    const anon = buildAgentSetupPlan({ kind: 'cloudflare_quick', platform: 'linux' });
    expect(anon.prompt).not.toContain('固定入口地址');
    expect(anon.prompt).toContain('隧道直接地址');
  });

  it('derives the entry URL from the Hub apex, tolerating a `www.` prefix', () => {
    expect(buildEntryUrl('bob', 'https://www.markus.global')).toBe('https://bob.remote.markus.global');
    expect(buildEntryUrl('bob', 'https://markus.global')).toBe('https://bob.remote.markus.global');
    expect(buildEntryUrl('bob')).toBe('https://bob.remote.markus.global');
    expect(buildEntryUrl(undefined, 'https://www.markus.global')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// adopt() — the "调本地 API 注册" half of the flow
// ─────────────────────────────────────────────────────────────────────────────

function makeTimer(): TimerPort {
  let seq = 0;
  return {
    setTimeout: () => ({ id: ++seq }),
    clearTimeout: (h: TimerHandle) => void h,
    setInterval: () => ({ id: ++seq }),
    clearInterval: (h: TimerHandle) => void h,
  };
}

function makeRegistry() {
  const calls = { register: [] as Array<Record<string, unknown>>, update: [] as string[] };
  let n = 0;
  const registry: TunnelRegistry = {
    register: async (input) => {
      calls.register.push(input as unknown as Record<string, unknown>);
      n += 1;
      return { endpointId: `ep_${n}`, verifyToken: `vtok_${n}`, verifyPath: '/api/remote/verify' };
    },
    verify: async (id) => ({ verified: true, secret: 'sekret', verifiedAt: `${id}`, }) as never,
    update: async (id) => {
      calls.update.push(id);
      return { endpoint: {} as never };
    },
    remove: async () => undefined,
  };
  return { registry, calls };
}

describe('TunnelManager.adopt (T10)', () => {
  it('adopts an external https address, registers it with the Hub, and goes ready', async () => {
    const { registry, calls } = makeRegistry();
    const mgr = new TunnelManager(
      { kind: 'cloudflare_quick', apiPort: 8056 },
      { registry, timer: makeTimer() },
    );
    const status = await mgr.adopt('https://brave-otter.trycloudflare.com/some/path');
    expect(status.publicUrl).toBe('https://brave-otter.trycloudflare.com');
    expect(status.enabled).toBe(true);
    expect(status.state).toBe('ready');
    expect(calls.register).toHaveLength(1);
    expect(calls.register[0]!.publicUrl).toBe('https://brave-otter.trycloudflare.com');
  });

  it('refuses a non-https address without registering anything', async () => {
    const { registry, calls } = makeRegistry();
    const mgr = new TunnelManager(
      { kind: 'cloudflare_quick', apiPort: 8056 },
      { registry, timer: makeTimer() },
    );
    const status = await mgr.adopt('http://insecure.example.com');
    expect(status.publicUrl).toBeNull();
    expect(status.state).toBe('error');
    expect(status.message).toContain('https://');
    expect(calls.register).toHaveLength(0);
  });

  it('is reachable through the tunnel controller, and rejected by the legacy controller', async () => {
    const { registry } = makeRegistry();
    const mgr = new TunnelManager(
      { kind: 'cloudflare_quick', apiPort: 8056 },
      { registry, timer: makeTimer() },
    );
    const controller = createTunnelController(mgr);
    await controller.adopt('https://abc.trycloudflare.com');
    expect(controller.getRemoteStatusV2().publicUrl).toBe('https://abc.trycloudflare.com');

    const legacy = createLegacyController({
      getStatus: () => ({ enabled: false, state: 'idle' }) as never,
      start: async () => undefined,
      stop: async () => undefined,
      onStatus: () => () => undefined,
    });
    await expect(legacy.adopt('https://abc.trycloudflare.com')).rejects.toThrow(/legacy relay/);
  });
});
