/**
 * The notification picker rendered from **real backend data** (req_8f391, U5).
 *
 * The unit suites (`notificationPicker`, `notificationPanel`, `notificationGuide`)
 * pin behaviour against hand-made fixtures. This one closes the gap: the same
 * panel is rendered with the payloads the **live** `/channels` route actually
 * produced for the owner's real bots, captured by `scripts/probe-u5-realdata.ts`:
 *
 *   • branch 1 — bot IS in a group  → the real groups become pickable chips
 *   • branch 2 — bot in NO group    → the "add the bot …" hint, no hand-fill box
 *   • branch 3 — cannot enumerate   → the manifest's guidance, not silence
 *
 * Run it against the capture the probe wrote (skipped otherwise, so CI — which
 * has no bots — stays green):
 *
 *   npx tsx scripts/probe-u5-realdata.ts             # writes /tmp/u5-capture.json
 *   U5_CAPTURE=/tmp/u5-capture.json npx vitest run --project web-ui \
 *     packages/web-ui/test/notificationRealData.test.tsx
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import i18n from '../src/i18n/index.ts';
import type { PlatformStatus } from '../src/lib/platformIntegrations.ts';
import type { InstanceStatus } from '../src/lib/instanceIntegrations.ts';
import { InstanceCard, type InstanceClient } from '../src/components/integrations/InstanceCard.tsx';

const CAPTURE = process.env['U5_CAPTURE'];
const maybe = CAPTURE ? describe : describe.skip;

interface Capture {
  feishu?: { supported: boolean; channels: Array<{ id: string; name: string; kind: string }> };
  telegram?: { supported: boolean; channels: unknown[]; guidance: string | null };
}
const capture: Capture = CAPTURE ? (JSON.parse(readFileSync(CAPTURE, 'utf8')) as Capture) : {};

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

// ─── Harness (same shape as notificationPicker.test.tsx) ──────────────────────

const ENUMERABLE: PlatformStatus = {
  id: 'feishu',
  label: 'Feishu',
  capabilities: { inbound: true, outbound: true, threads: true },
  fields: [
    { key: 'appId', label: 'App ID', type: 'text', required: true },
    { key: 'appSecret', label: 'App secret', type: 'password', required: true, secret: true },
    { key: 'notifyChatId', label: 'Notification chat', type: 'text', required: false, notifyTarget: 'chat' },
    { key: 'notifyOnApproval', label: 'Notify on approvals', type: 'boolean', required: false, default: true },
  ],
  defaultEnabled: false,
  enabled: true,
  connected: true,
  hasConfig: true,
  values: {},
  secrets: { appSecret: { hasValue: true } },
};

const MANUAL_ONLY: PlatformStatus = { ...ENUMERABLE, id: 'telegram', label: 'Telegram' };

function instance(status: PlatformStatus, over: Partial<InstanceStatus> = {}): InstanceStatus {
  return {
    id: `bi_${status.id}`,
    platform: status.id,
    label: 'Default',
    enabled: status.enabled,
    connected: status.connected,
    hasConfig: status.hasConfig,
    capabilities: status.capabilities,
    fields: status.fields,
    values: status.values,
    secrets: status.secrets,
    agentId: null,
    notifyAgentId: null,
    channels: [],
    lastError: null,
    canListChannels: true,
    lastVerifiedAt: null,
    ...over,
  };
}

function clientStub(channels: Array<{ id: string; name: string }>): InstanceClient {
  return {
    create: vi.fn(async () => instance(ENUMERABLE)),
    save: vi.fn(async () => undefined),
    test: vi.fn(async () => ({ ok: true, message: 'pong' })),
    remove: vi.fn(async () => undefined),
    listChannels: vi.fn(async () => ({ supported: true, channels })),
    saveChannels: vi.fn(async () => undefined),
    startConnectionTest: vi.fn(async () => null),
    getConnectionTest: vi.fn(async () => null),
  };
}

function renderCard(
  status: PlatformStatus,
  over: Partial<InstanceStatus> = {},
  channels: Array<{ id: string; name: string }> = [],
) {
  return render(
    <InstanceCard instance={instance(status, over)} client={clientStub(channels)} extras={{}} defaultExpanded />,
  );
}

// ─── The three branches, driven by the live capture ───────────────────────────

maybe('notification picker from REAL backend data (U5)', () => {
  it('branch 1 — bot in a group: the real groups become pickable chips', async () => {
    const channels = capture.feishu?.channels ?? [];
    expect(channels.length).toBeGreaterThan(0);

    renderCard(ENUMERABLE, { canListChannels: true }, channels);
    const panel = await screen.findByTestId('notification-panel');

    expect(within(panel).getByTestId('notification-chat-list')).toBeInTheDocument();
    for (const c of channels) {
      expect(await within(panel).findByTestId(`notification-chat-pick-${c.id}`)).toBeInTheDocument();
    }
    // Picker-first: the raw id box is folded away, not the default.
    expect(within(panel).getByTestId('notification-manual-toggle')).toBeInTheDocument();
    expect(within(panel).queryByTestId('integration-field-notifyChatId')).toBeNull();
  });

  it('branch 2 — bot in no group: the "load groups" hint, not a hand-fill box', async () => {
    renderCard(ENUMERABLE, { canListChannels: true }, []);
    const panel = await screen.findByTestId('notification-panel');

    const empty = await within(panel).findByTestId('notification-chat-empty');
    expect(empty.textContent ?? '').toMatch(/load groups/i);
    expect(within(panel).queryByTestId('integration-field-notifyChatId')).toBeNull();
  });

  it('branch 3 — cannot enumerate: the manifest guidance, not silence', async () => {
    renderCard(MANUAL_ONLY, {
      canListChannels: false,
      channelsGuidance: capture.telegram?.guidance ?? null,
    });
    const panel = await screen.findByTestId('notification-panel');

    expect(within(panel).queryByTestId('notification-chat-list')).toBeNull();
    const guidance = await within(panel).findByTestId('notification-chat-guidance');
    // A real, translated sentence — never a raw i18n key.
    expect(guidance.textContent ?? '').not.toMatch(/settings:/);
    expect(guidance.textContent ?? '').toMatch(/Telegram/);
    // No picker exists, so the manual box stays visible.
    expect(within(panel).getByTestId('integration-field-notifyChatId')).toBeInTheDocument();
  });
});
