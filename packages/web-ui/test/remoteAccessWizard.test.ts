/**
 * Remote-access wizard state machine + contract-mirror probes (T9).
 *
 * The wizard is the acceptance surface for this task — "组件测试覆盖向导状态机
 * (idle→installing→…→ready/error)". Because the machine is a pure reducer, we
 * assert every transition here without rendering React or standing up a backend.
 *
 * A second block is a **teeth** check: it reads the real `Settings.tsx` source,
 * extracts every `remoteAccess.*` i18n key it references, and fails if any is
 * missing from the locale files. That is what makes "i18n key 齐全" provable
 * rather than aspirational.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONNECTION_METHODS,
  REMOTE_ENDPOINT_KINDS,
  REMOTE_MODES,
  REMOTE_STATES,
  SETUP_STEPS,
  adaptRemoteStatus,
  afterSelfRun,
  connectionMethod,
  detectPlatform,
  entryUrlFor,
  hubLoginUrl,
  initialWizardState,
  phaseFromRemoteState,
  setupCommands,
  stepIndex,
  verifyReasonKey,
  wizardReducer,
  type RemoteStatusV2,
  type WizardEvent,
  type WizardState,
} from '../src/lib/remoteAccess.ts';

const here = dirname(fileURLToPath(import.meta.url));

function run(events: WizardEvent[], from: WizardState = initialWizardState): WizardState {
  return events.reduce(wizardReducer, from);
}

const status = (over: Partial<RemoteStatusV2>): RemoteStatusV2 => ({
  enabled: true,
  mode: 'cloudflare_quick',
  state: 'starting',
  entryUrl: null,
  publicUrl: null,
  health: 'unknown',
  ...over,
});

// ── Regression: "I have run it" must NEVER leave the wizard frozen ────────────
// Real failure (2026-10-14): the handler only dispatched on `!enabled` or
// `enabled && publicUrl`; the `enabled && !publicUrl` state (what a hand-run
// quick tunnel leaves behind) fell through and the button did nothing at all.
describe('afterSelfRun', () => {
  it('advances to the resolve step when no address is known yet (no silent no-op)', () => {
    const ev = afterSelfRun(status({ enabled: true, publicUrl: null }));
    expect(ev).toEqual({ type: 'processStarted' });
    expect(run([{ type: 'beginInstall' }, { type: 'installSucceeded' }, ev]).phase).toBe('resolve');
  });

  it('goes straight to register when the supervisor already knows an address', () => {
    const ev = afterSelfRun(status({ enabled: true, publicUrl: 'https://x.trycloudflare.com' }));
    expect(ev).toEqual({ type: 'addressResolved', publicUrl: 'https://x.trycloudflare.com' });
  });

  it('still advances for a null / not-enabled status', () => {
    expect(afterSelfRun(null)).toEqual({ type: 'processStarted' });
    expect(afterSelfRun(status({ enabled: false, publicUrl: null }))).toEqual({ type: 'processStarted' });
    expect(afterSelfRun(status({ enabled: false, publicUrl: 'https://x.trycloudflare.com' }))).toEqual({
      type: 'processStarted',
    });
  });
});

describe('contract mirror', () => {
  it('mirrors the five endpoint kinds (verbatim from contract.ts)', () => {
    expect(REMOTE_ENDPOINT_KINDS).toEqual([
      'cloudflare_quick',
      'cloudflare_named',
      'tailscale_funnel',
      'tailscale_serve',
      'custom',
    ]);
  });

  it('mode = kinds ∪ relay_legacy; states match the contract', () => {
    expect(REMOTE_MODES).toEqual([...REMOTE_ENDPOINT_KINDS, 'relay_legacy']);
    expect(REMOTE_STATES).toEqual([
      'idle',
      'installing',
      'starting',
      'verifying',
      'ready',
      'degraded',
      'error',
    ]);
  });

  it('offers every kind in the chooser exactly once, with cloudflare_named recommended', () => {
    expect(CONNECTION_METHODS.map((m) => m.kind)).toEqual([...REMOTE_ENDPOINT_KINDS]);
    expect(CONNECTION_METHODS.filter((m) => m.recommended)).toHaveLength(1);
    expect(connectionMethod('cloudflare_named').recommended).toBe(true);
    // Only tailscale_serve must NOT reach the Hub (guide-only kind, contract §1).
    expect(connectionMethod('tailscale_serve').reachesHub).toBe(false);
    expect(connectionMethod('cloudflare_quick').reachesHub).toBe(true);
  });

  it('labels each method with barrier/stability/account/domain metadata', () => {
    for (const m of CONNECTION_METHODS) {
      expect(['low', 'medium', 'high']).toContain(m.barrier);
      expect(['high', 'medium', 'low']).toContain(m.stability);
      expect(typeof m.needsAccount).toBe('boolean');
      expect(typeof m.needsDomain).toBe('boolean');
    }
    // Named tunnel needs a domain + account; quick tunnel needs neither.
    expect(connectionMethod('cloudflare_named')).toMatchObject({ needsDomain: true, needsAccount: true });
    expect(connectionMethod('cloudflare_quick')).toMatchObject({ needsDomain: false, needsAccount: false });
  });
});

describe('setup commands (path A)', () => {
  const platforms = ['macos', 'linux', 'windows'] as const;

  it('produces a non-empty install + run command for every kind × platform', () => {
    for (const kind of REMOTE_ENDPOINT_KINDS) {
      for (const p of platforms) {
        const c = setupCommands(kind, p);
        expect(c.install.trim().length).toBeGreaterThan(0);
        expect(c.run.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('targets the configured local port', () => {
    expect(setupCommands('cloudflare_quick', 'macos', 9000).run).toContain('localhost:9000');
    expect(setupCommands('cloudflare_quick', 'macos').run).toContain('localhost:8056');
    expect(setupCommands('tailscale_funnel', 'linux').run).toContain('tailscale funnel 8056');
  });
});

describe('wizard state machine — happy path', () => {
  it('walks idle → install → start → resolve → register → verify → ready', () => {
    // idle
    expect(initialWizardState.phase).toBe('idle');

    const s1 = run([{ type: 'selectKind', kind: 'cloudflare_named' }, { type: 'choosePath', path: 'self' }]);
    expect(s1.phase).toBe('idle');
    expect(s1.kind).toBe('cloudflare_named');
    expect(s1.path).toBe('self');

    expect(wizardReducer(s1, { type: 'beginInstall' }).phase).toBe('install');
    expect(wizardReducer(s1, { type: 'beginInstall' })).toBeDefined();
    expect(run([{ type: 'beginInstall' }, { type: 'installSucceeded' }], s1).phase).toBe('start');
    expect(
      run([{ type: 'beginInstall' }, { type: 'installSucceeded' }, { type: 'processStarted' }], s1).phase,
    ).toBe('resolve');
    expect(
      run(
        [
          { type: 'beginInstall' },
          { type: 'installSucceeded' },
          { type: 'processStarted' },
          { type: 'addressResolved', publicUrl: 'https://x.trycloudflare.com' },
        ],
        s1,
      ).phase,
    ).toBe('register');
    expect(
      run(
        [
          { type: 'beginInstall' },
          { type: 'installSucceeded' },
          { type: 'processStarted' },
          { type: 'addressResolved', publicUrl: 'https://x.trycloudflare.com' },
          { type: 'registered', entryUrl: 'https://bob.remote.markus.global' },
        ],
        s1,
      ).phase,
    ).toBe('verify');

    const done = run(
      [
        { type: 'beginInstall' },
        { type: 'installSucceeded' },
        { type: 'processStarted' },
        { type: 'addressResolved', publicUrl: 'https://x.trycloudflare.com' },
        { type: 'registered', entryUrl: 'https://bob.remote.markus.global' },
        { type: 'verifyStarted' },
        { type: 'ready' },
      ],
      s1,
    );
    expect(done.phase).toBe('ready');
    expect(done.wasReady).toBe(true);
    expect(done.publicUrl).toBe('https://x.trycloudflare.com');
    expect(done.entryUrl).toBe('https://bob.remote.markus.global');
  });

  it('stepIndex increases monotonically along SETUP_STEPS', () => {
    const idx = SETUP_STEPS.map(stepIndex);
    expect(idx).toEqual([0, 1, 2, 3, 4, 5]);
    expect(stepIndex('idle')).toBe(-1);
    expect(stepIndex('error')).toBe(-1);
  });
});

describe('wizard state machine — failure paths', () => {
  it('install failure lands in error with a message', () => {
    const s = run([{ type: 'beginInstall' }, { type: 'installFailed', message: 'cloudflared not found' }]);
    expect(s.phase).toBe('error');
    expect(s.message).toBe('cloudflared not found');
    expect(s.wasReady).toBe(false);
  });

  it('verify failure keeps the reason and is retryable', () => {
    const s = run([
      { type: 'beginInstall' },
      { type: 'installSucceeded' },
      { type: 'processStarted' },
      { type: 'addressResolved', publicUrl: 'https://x.trycloudflare.com' },
      { type: 'registered' },
      { type: 'verifyFailed', reason: 'token_mismatch' },
    ]);
    expect(s.phase).toBe('error');
    expect(s.verifyFailure).toBe('token_mismatch');
    const retried = wizardReducer(s, { type: 'verifyStarted' });
    expect(retried.phase).toBe('verify');
  });

  it('a dropped tunnel that HAD been ready becomes "reconnecting" (never silent)', () => {
    const ready = run([{ type: 'ready' }], { ...initialWizardState, wasReady: true });
    const dropped = wizardReducer(ready, { type: 'disconnected' });
    expect(dropped.phase).toBe('reconnecting');
    expect(dropped.health).toBe('down');
  });

  it('a drop before ever being ready is an error, not a reconnect', () => {
    const s = run([{ type: 'processStarted' }, { type: 'disconnected' }]);
    expect(s.phase).toBe('error');
  });

  it('reset returns to idle but keeps the chosen kind', () => {
    const s = run([{ type: 'selectKind', kind: 'tailscale_funnel' }, { type: 'userError', message: 'x' }]);
    const reset = wizardReducer(s, { type: 'reset' });
    expect(reset.phase).toBe('idle');
    expect(reset.kind).toBe('tailscale_funnel');
    expect(reset.message).toBeNull();
  });
});

describe('wizard state machine — backend status is authoritative', () => {
  it('maps each RemoteState to a phase', () => {
    const ctx = { publicUrl: null, entryUrl: null };
    expect(phaseFromRemoteState('idle', ctx)).toBe('idle');
    expect(phaseFromRemoteState('installing', ctx)).toBe('install');
    expect(phaseFromRemoteState('starting', ctx)).toBe('start');
    expect(phaseFromRemoteState('starting', { publicUrl: 'https://x', entryUrl: null })).toBe('register');
    expect(phaseFromRemoteState('starting', { publicUrl: 'https://x', entryUrl: 'https://e' })).toBe('verify');
    expect(phaseFromRemoteState('verifying', ctx)).toBe('verify');
    expect(phaseFromRemoteState('ready', ctx)).toBe('ready');
    expect(phaseFromRemoteState('degraded', ctx)).toBe('ready');
    expect(phaseFromRemoteState('error', ctx)).toBe('error');
  });

  it('a ready status event sets phase + wasReady', () => {
    const s = wizardReducer(initialWizardState, {
      type: 'status',
      status: status({ state: 'ready', publicUrl: 'https://x.ts.net', entryUrl: 'https://bob.remote.markus.global' }),
    });
    expect(s.phase).toBe('ready');
    expect(s.wasReady).toBe(true);
    expect(s.publicUrl).toBe('https://x.ts.net');
  });

  it('regressing from ready to a progress state surfaces "reconnecting"', () => {
    const ready = wizardReducer(initialWizardState, { type: 'status', status: status({ state: 'ready' }) });
    const back = wizardReducer(ready, { type: 'status', status: status({ state: 'starting' }) });
    expect(back.phase).toBe('reconnecting');
    expect(back.wasReady).toBe(true);
  });

  it('an error status surfaces error', () => {
    const s = wizardReducer(initialWizardState, {
      type: 'status',
      status: status({ state: 'error', message: 'cloudflared not detected' }),
    });
    expect(s.phase).toBe('error');
    expect(s.message).toBe('cloudflared not detected');
  });

  it('disabled status returns to idle', () => {
    const s = wizardReducer(
      { ...initialWizardState, phase: 'ready', wasReady: true, kind: 'cloudflare_quick' },
      { type: 'status', status: status({ enabled: false, state: 'idle' }) },
    );
    expect(s.phase).toBe('idle');
    expect(s.kind).toBe('cloudflare_quick');
  });
});

describe('status adapter (legacy → V2)', () => {
  it('passes a V2 payload through unchanged', () => {
    const v2 = status({ state: 'ready', health: 'up', latencyMs: 42 });
    expect(adaptRemoteStatus(v2)).toEqual(v2);
  });

  it('maps the legacy status shape onto V2', () => {
    const legacy = {
      enabled: true,
      connected: true,
      state: 'connected',
      remoteUrl: 'https://legacy.example',
      peerCount: 2,
    };
    const out = adaptRemoteStatus(legacy);
    expect(out).toMatchObject({
      enabled: true,
      mode: 'relay_legacy',
      state: 'ready',
      publicUrl: 'https://legacy.example',
      health: 'up',
    });
  });

  it('maps legacy connecting → starting and idle → idle', () => {
    expect(adaptRemoteStatus({ enabled: true, state: 'connecting' })?.state).toBe('starting');
    expect(adaptRemoteStatus({ enabled: false, state: 'idle' })?.state).toBe('idle');
  });

  it('returns null for garbage', () => {
    expect(adaptRemoteStatus(null)).toBeNull();
    expect(adaptRemoteStatus(42)).toBeNull();
    expect(adaptRemoteStatus({ unrelated: true })).toBeNull();
  });
});

describe('helpers', () => {
  it('builds the stable entry URL', () => {
    expect(entryUrlFor('bob')).toBe('https://bob.remote.markus.global');
    expect(entryUrlFor(null)).toBeNull();
    expect(entryUrlFor('')).toBeNull();
  });

  it('builds the Hub login URL with an encoded redirect', () => {
    expect(hubLoginUrl()).toBe('https://www.markus.global/auth/login');
    expect(hubLoginUrl('https://bob.remote.markus.global')).toBe(
      'https://www.markus.global/auth/login?redirect=https%3A%2F%2Fbob.remote.markus.global',
    );
  });

  it('detects the platform from a user-agent', () => {
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)')).toBe('macos');
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64)')).toBe('windows');
    expect(detectPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
  });

  it('names verify-reason i18n keys', () => {
    expect(verifyReasonKey('token_mismatch')).toBe('verifyReason.token_mismatch');
  });
});

/**
 * ── Teeth: every i18n key the wizard uses must exist in all three locales ────
 *
 * We read the real component source rather than a hand-kept list, so adding a
 * `t('remoteAccess.foo')` without its translation turns this red.
 */
describe('i18n coverage for the remote-access wizard', () => {
  // The section was extracted to its own component; both files may reference keys.
  const sources = [
    join(here, '..', 'src', 'pages', 'Settings.tsx'),
    join(here, '..', 'src', 'components', 'RemoteAccessSection.tsx'),
  ].map((p) => readFileSync(p, 'utf8'));
  const localesDir = join(here, '..', 'src', 'locales');
  const locales = ['en', 'zh-CN', 'es'] as const;

  /** i18next v4 plural suffixes — a bare `foo` may only exist as `foo_one`/`foo_other`. */
  const PLURAL = /_(zero|one|two|few|many|other)$/;
  const stripPlural = (k: string) => k.replace(PLURAL, '');

  function flatKeys(obj: Record<string, unknown>, prefix = ''): string[] {
    const out: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...flatKeys(v as Record<string, unknown>, path));
      else out.push(stripPlural(path));
    }
    return out;
  }

  // Capture the FULL dotted key from a translation call site
  // (`t('settings:remoteAccess.path.agent.pickFirst')` → `remoteAccess.path.agent.pickFirst`).
  // The `settings:`/`common:` namespace anchor keeps the match from picking up
  // module references like `lib/remoteAccess.ts` in comments/imports.
  const referenced = [
    ...new Set(
      sources.flatMap((src) =>
        [...src.matchAll(/['"`](?:settings|common):(remoteAccess(?:\.[A-Za-z0-9_]+)+)/g)].map((m) => stripPlural(m[1])),
      ),
    ),
  ].sort();

  it('finds a meaningful number of referenced keys (guard against a broken regex)', () => {
    expect(referenced.length).toBeGreaterThan(15);
  });

  for (const locale of locales) {
    it(`${locale}: has every remoteAccess key referenced by Settings.tsx`, () => {
      const json = JSON.parse(
        readFileSync(join(localesDir, locale, 'settings.json'), 'utf8'),
      ) as Record<string, unknown>;
      const keys = new Set(flatKeys(json));
      const missing = referenced.filter((k) => !keys.has(k));
      expect(missing).toEqual([]);
    });
  }
});
