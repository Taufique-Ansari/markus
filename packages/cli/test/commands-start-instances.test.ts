/**
 * Slice G2 — startup iterates bot instances, not platforms.
 *
 * `connectConfiguredPlatforms` must build one adapter per persisted
 * `platform_instances` row (each with its own credentials), fall back to the
 * legacy platform path only when a platform has no instance row, and keep the
 * pre-G2 identity (instance id = platform id) for that implicit bot.
 */
import { describe, it, expect, vi } from 'vitest';
import { MessageRouter } from '@markus/comms';
import type { CommAdapter, CommAdapterConfig, PlatformManifest } from '@markus/comms';
import type { MarkusConfig } from '@markus/shared';
import { connectConfiguredPlatforms, createInstanceReconciler } from '../src/commands/start.js';
import type { PersistedBotInstance } from '../src/commands/start.js';

interface CreatedAdapter {
  calls: CommAdapterConfig[];
  adapter: CommAdapter;
}

/** A manifest whose factory returns a fresh adapter each call, recording connect configs. */
function telegramManifest(created: CreatedAdapter[]): PlatformManifest {
  return {
    id: 'telegram',
    label: 'Telegram',
    fields: [{ key: 'botToken', label: 'Bot Token', type: 'password', required: true, secret: true }],
    capabilities: { inbound: true, outbound: true, threads: true },
    createAdapter: () => {
      const rec: CreatedAdapter = { calls: [], adapter: undefined as unknown as CommAdapter };
      rec.adapter = {
        platform: 'telegram',
        async connect(config) {
          rec.calls.push(config);
        },
        async disconnect() {},
        async sendMessage() {
          return 'msg-id';
        },
        async sendReply() {
          return 'msg-id';
        },
        onMessage() {},
        isConnected() {
          return true;
        },
      };
      created.push(rec);
      return rec.adapter;
    },
  };
}

function makeConfig(integrations?: MarkusConfig['integrations'] & Record<string, unknown>): MarkusConfig {
  return {
    org: { id: 'default', name: 'Test Org' },
    llm: { defaultProvider: 'anthropic', defaultModel: 'test-model', providers: {} },
    ...(integrations ? { integrations } : {}),
  };
}

describe('connectConfiguredPlatforms — bot instances (G2)', () => {
  it('connects two instances of the same platform, each with its own credentials', async () => {
    const created: CreatedAdapter[] = [];
    const results = await connectConfiguredPlatforms({
      router: new MessageRouter(),
      manifests: [telegramManifest(created)],
      config: makeConfig(),
      instances: [
        { id: 'bi_tg_sales', platform: 'telegram', label: 'sales-bot', config: { botToken: 'SALES' }, enabled: true },
        { id: 'bi_tg_ops', platform: 'telegram', label: 'ops-bot', config: { botToken: 'OPS' }, enabled: true },
      ],
    });

    expect(created).toHaveLength(2);
    expect(created[0].calls[0]).toMatchObject({ platform: 'telegram', botToken: 'SALES' });
    expect(created[1].calls[0]).toMatchObject({ platform: 'telegram', botToken: 'OPS' });
    expect(results).toEqual([
      { id: 'bi_tg_sales', label: 'Telegram (sales-bot)', connected: true },
      { id: 'bi_tg_ops', label: 'Telegram (ops-bot)', connected: true },
    ]);
  });

  it('skips a disabled instance', async () => {
    const created: CreatedAdapter[] = [];
    const results = await connectConfiguredPlatforms({
      router: new MessageRouter(),
      manifests: [telegramManifest(created)],
      config: makeConfig(),
      instances: [
        { id: 'bi_a', platform: 'telegram', label: 'a', config: { botToken: 'A' }, enabled: true },
        { id: 'bi_b', platform: 'telegram', label: 'b', config: { botToken: 'B' }, enabled: false },
      ],
    });

    expect(created).toHaveLength(1);
    expect(results).toEqual([{ id: 'bi_a', label: 'Telegram (a)', connected: true }]);
  });

  it('falls back to the legacy path (instance id = platform) when there is no instance row', async () => {
    const created: CreatedAdapter[] = [];
    const results = await connectConfiguredPlatforms({
      router: new MessageRouter(),
      manifests: [telegramManifest(created)],
      config: makeConfig({ telegram: { botToken: 'LEGACY' } }),
    });

    expect(results).toEqual([{ id: 'telegram', label: 'Telegram', connected: true }]);
    expect(created[0].calls[0]).toMatchObject({ platform: 'telegram', botToken: 'LEGACY' });
  });

  it('prefers instance rows over the legacy fallback for the same platform (dual read)', async () => {
    const created: CreatedAdapter[] = [];
    const storedConfig = vi.fn(() => ({ values: { botToken: 'LEGACY' }, enabled: true }));
    const results = await connectConfiguredPlatforms({
      router: new MessageRouter(),
      manifests: [telegramManifest(created)],
      config: makeConfig(),
      instances: [{ id: 'bi_new', platform: 'telegram', label: 'new-bot', config: { botToken: 'NEW' }, enabled: true }],
      storedConfig,
    });

    expect(results).toEqual([{ id: 'bi_new', label: 'Telegram (new-bot)', connected: true }]);
    expect(created[0].calls[0]).toMatchObject({ botToken: 'NEW' });
    // The legacy source is not even consulted once a platform has an instance row.
    expect(storedConfig).not.toHaveBeenCalled();
  });
});

// ─── Runtime reconciler — the "a saved bot goes live without a restart" contract ─
//
// Before this existed, the only writer of the router's adapter set was startup:
// `registerAdapter` was called at boot and never again, and `reconnectPlatform`
// could only reach bots that were *already* registered. So a bot created or saved
// in Settings was persisted but dead until the process restarted. These tests pin
// the fix: the adapter set is derived state, and a Settings change re-derives it.

/** In-memory `platform_instances` repo — the reconciler's desired state. */
class FakeInstanceRepo {
  private rows = new Map<string, PersistedBotInstance>();
  put(row: PersistedBotInstance): void {
    this.rows.set(row.id, row);
  }
  remove(id: string): void {
    this.rows.delete(id);
  }
  findById(id: string): PersistedBotInstance | undefined {
    return this.rows.get(id);
  }
  listByPlatform(_orgId: string, platform: string): PersistedBotInstance[] {
    return [...this.rows.values()].filter((row) => row.platform === platform);
  }
}

/**
 * A manifest on a platform id the real registry does not know, so the injected
 * list is the only source and `resolveManifestConfig`'s env fallback
 * (`<PLATFORM>_<FIELD>`) can never leak a value in from the test machine.
 */
function reconcileManifest(created: CreatedAdapter[], id = 'testplat'): PlatformManifest {
  return {
    id,
    label: 'TestPlat',
    fields: [{ key: 'botToken', label: 'Bot Token', type: 'password', required: true, secret: true }],
    capabilities: { inbound: true, outbound: true, threads: true },
    createAdapter: () => {
      const rec: CreatedAdapter = { calls: [], adapter: undefined as unknown as CommAdapter };
      rec.adapter = {
        platform: id,
        async connect(config) {
          rec.calls.push(config);
        },
        async disconnect() {},
        async sendMessage() {
          return 'msg-id';
        },
        async sendReply() {
          return 'msg-id';
        },
        onMessage() {},
        isConnected() {
          return true;
        },
      };
      created.push(rec);
      return rec.adapter;
    },
  };
}

describe('createInstanceReconciler — a saved bot goes live without a restart', () => {
  it('registers AND connects a bot that did not exist at startup (the reported defect)', async () => {
    const created: CreatedAdapter[] = [];
    const router = new MessageRouter();
    const repo = new FakeInstanceRepo();
    repo.put({ id: 'bi_late', platform: 'testplat', label: 'late', config: { botToken: 'LATE' }, enabled: true });

    const reconciler = createInstanceReconciler({
      router,
      manifests: [reconcileManifest(created)],
      instanceRepo: repo,
      orgId: 'default',
      sections: {},
    });

    // Before: the router knows nothing about it — the exact state that used to
    // persist until the process restarted.
    expect(router.hasInstance('bi_late')).toBe(false);

    await reconciler.syncInstance('bi_late');

    expect(router.hasInstance('bi_late')).toBe(true);
    expect(created).toHaveLength(1);
    // Resolved from the row's own credentials, and bound to the instance id.
    expect(created[0].calls[0]).toMatchObject({ platform: 'testplat', botToken: 'LATE', instanceId: 'bi_late' });
  });

  it('drops the adapter when the row is deleted (no leaked socket)', async () => {
    const created: CreatedAdapter[] = [];
    const router = new MessageRouter();
    const repo = new FakeInstanceRepo();
    repo.put({ id: 'bi_gone', platform: 'testplat', label: 'gone', config: { botToken: 'G' }, enabled: true });
    const reconciler = createInstanceReconciler({
      router,
      manifests: [reconcileManifest(created)],
      instanceRepo: repo,
      orgId: 'default',
      sections: {},
    });

    await reconciler.syncInstance('bi_gone');
    expect(router.hasInstance('bi_gone')).toBe(true);

    repo.remove('bi_gone');
    await reconciler.syncInstance('bi_gone');
    expect(router.hasInstance('bi_gone')).toBe(false);
  });

  it('drops the adapter when the bot is switched off', async () => {
    const created: CreatedAdapter[] = [];
    const router = new MessageRouter();
    const repo = new FakeInstanceRepo();
    repo.put({ id: 'bi_off', platform: 'testplat', label: 'off', config: { botToken: 'O' }, enabled: true });
    const reconciler = createInstanceReconciler({
      router,
      manifests: [reconcileManifest(created)],
      instanceRepo: repo,
      orgId: 'default',
      sections: {},
    });

    await reconciler.syncInstance('bi_off');
    expect(router.hasInstance('bi_off')).toBe(true);

    repo.put({ id: 'bi_off', platform: 'testplat', label: 'off', config: { botToken: 'O' }, enabled: false });
    await reconciler.syncInstance('bi_off');
    expect(router.hasInstance('bi_off')).toBe(false);
  });

  it('never connects a half-configured bot', async () => {
    const created: CreatedAdapter[] = [];
    const router = new MessageRouter();
    const repo = new FakeInstanceRepo();
    repo.put({ id: 'bi_empty', platform: 'testplat', label: 'e', config: {}, enabled: true });
    const reconciler = createInstanceReconciler({
      router,
      manifests: [reconcileManifest(created)],
      instanceRepo: repo,
      orgId: 'default',
      sections: {},
    });

    await reconciler.syncInstance('bi_empty');

    expect(router.hasInstance('bi_empty')).toBe(false);
    expect(created).toHaveLength(0);
  });

  it('re-derives every instance of a platform (rows win over the legacy path)', async () => {
    const created: CreatedAdapter[] = [];
    const router = new MessageRouter();
    const repo = new FakeInstanceRepo();
    repo.put({ id: 'bi_a', platform: 'testplat', label: 'a', config: { botToken: 'A' }, enabled: true });
    repo.put({ id: 'bi_b', platform: 'testplat', label: 'b', config: { botToken: 'B' }, enabled: true });
    const reconciler = createInstanceReconciler({
      router,
      manifests: [reconcileManifest(created)],
      instanceRepo: repo,
      orgId: 'default',
      sections: { testplat: { botToken: 'FROMFILE' } },
    });

    await reconciler.syncPlatform('testplat');

    expect(router.hasInstance('bi_a')).toBe(true);
    expect(router.hasInstance('bi_b')).toBe(true);
    // The implicit platform bot must NOT also exist alongside the rows.
    expect(router.hasInstance('testplat')).toBe(false);
    expect(created[0].calls[0]).toMatchObject({ botToken: 'A' });
    expect(created[1].calls[0]).toMatchObject({ botToken: 'B' });
  });

  it('syncPlatform falls back to the implicit platform bot, with saved values winning', async () => {
    const created: CreatedAdapter[] = [];
    const router = new MessageRouter();
    const reconciler = createInstanceReconciler({
      router,
      manifests: [reconcileManifest(created)],
      instanceRepo: new FakeInstanceRepo(),
      orgId: 'default',
      sections: { testplat: { botToken: 'FROMFILE' } },
    });

    await reconciler.syncPlatform('testplat', { botToken: 'SAVED' });

    expect(router.hasInstance('testplat')).toBe(true);
    expect(created[0].calls[0]).toMatchObject({ platform: 'testplat', botToken: 'SAVED', instanceId: 'testplat' });
  });
});
