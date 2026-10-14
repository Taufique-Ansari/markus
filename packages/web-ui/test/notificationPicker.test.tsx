/**
 * Picker-first destination — "pick the group, don't paste an id" (req_8f391, U3).
 *
 * "Where do notifications go?" used to be answered by typing an opaque id into a
 * text box. For any platform that can enumerate its conversations the panel now
 * answers it by **picking the group**, and the text box is demoted to a collapsed
 * escape hatch — hand-entry is a deliberate choice, never the default.
 *
 * The pre-U3 panel fails every assertion here: the id box was always on screen
 * (there is no `notification-manual-toggle` to open), an empty list simply hid
 * the picker (no `notification-chat-empty`), and a platform that cannot enumerate
 * showed a bare, unexplained text box (no `notification-chat-guidance`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '../src/i18n/index.ts';
import type { PlatformStatus } from '../src/lib/platformIntegrations.ts';
import type { InstanceStatus } from '../src/lib/instanceIntegrations.ts';
import { InstanceCard, type InstanceClient } from '../src/components/integrations/InstanceCard.tsx';

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** Enumerable: the platform lists its conversations and declares a chat one. */
const ENUMERABLE: PlatformStatus = {
  id: 'slack',
  label: 'Slack',
  capabilities: { inbound: true, outbound: true, threads: true },
  fields: [
    { key: 'botToken', label: 'Bot token', type: 'password', required: true, secret: true },
    { key: 'notifyChannelId', label: 'Default channel', type: 'text', required: false, notifyTarget: 'chat' },
    { key: 'notifyUserId', label: 'Default user', type: 'text', required: false, notifyTarget: 'user' },
    { key: 'notifyOnApproval', label: 'Notify on approvals', type: 'boolean', required: false, default: true },
  ],
  defaultEnabled: false,
  enabled: true,
  connected: true,
  hasConfig: true,
  values: {},
  secrets: { botToken: { hasValue: true } },
};

/** Not enumerable, but still chat-addressed — the manual box is the only way in. */
const MANUAL_ONLY: PlatformStatus = { ...ENUMERABLE, id: 'telegram', label: 'Telegram' };

/** A real locale key, used as a stand-in for a manifest's enumeration guidance. */
const GUIDANCE_KEY = 'settings:instances.notify.unsupported';
const GUIDANCE_TEXT = 'This platform does not declare a notification destination.';

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

// ─── Enumerable platform: the picker leads ───────────────────────────────────

describe('NotificationPanel — pick the group, don’t paste an id (U3)', () => {
  it('leads with the picker and does NOT render the raw id box by default', async () => {
    renderCard(ENUMERABLE, {}, [{ id: 'C1', name: '#one' }]);
    const panel = await screen.findByTestId('notification-panel');

    expect(within(panel).getByTestId('notification-chat-list')).toBeInTheDocument();
    expect(await within(panel).findByTestId('notification-chat-pick-C1')).toBeInTheDocument();
    // The escape hatch exists; the id box itself is not on screen.
    expect(within(panel).getByTestId('notification-manual-toggle')).toBeInTheDocument();
    expect(within(panel).queryByTestId('integration-field-notifyChannelId')).toBeNull();
  });

  it('reveals and hides the id box through the manual hatch', async () => {
    const user = userEvent.setup();
    renderCard(ENUMERABLE, {}, [{ id: 'C1', name: '#one' }]);
    const panel = await screen.findByTestId('notification-panel');
    const toggle = within(panel).getByTestId('notification-manual-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    await user.click(toggle);
    expect(within(panel).getByTestId('integration-field-notifyChannelId')).toBeInTheDocument();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    await user.click(toggle);
    expect(within(panel).queryByTestId('integration-field-notifyChannelId')).toBeNull();
  });

  it('explains an empty list instead of hiding the picker', async () => {
    renderCard(ENUMERABLE, {}, []);
    const panel = await screen.findByTestId('notification-panel');

    // The control stays reachable…
    expect(within(panel).getByTestId('notification-chat-refresh')).toBeInTheDocument();
    // …with the steps that make the list non-empty, not a blank space.
    const empty = await within(panel).findByTestId('notification-chat-empty');
    expect(empty.textContent ?? '').toMatch(/group/i);
    // …and it names the control the user actually presses: the first-load label
    // is “Load groups” (U4), not “Refresh”.
    expect(empty.textContent ?? '').toMatch(/load groups/i);
  });

  it('surfaces a destination the platform no longer advertises', async () => {
    renderCard(ENUMERABLE, { values: { notifyChannelId: 'C_OLD' } }, [{ id: 'C_NEW', name: '#new' }]);
    const current = await screen.findByTestId('notification-chat-pick-current');
    expect(current.textContent).toBe('C_OLD');
    expect(current.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows no “current destination” chip when the value is already in the list', async () => {
    renderCard(ENUMERABLE, { values: { notifyChannelId: 'C1' } }, [{ id: 'C1', name: '#one' }]);
    const chip = await screen.findByTestId('notification-chat-pick-C1');
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByTestId('notification-chat-pick-current')).toBeNull();
  });
});

// ─── Non-enumerable platform: explain, don't stay silent ──────────────────────

describe('non-enumerable platform — guidance instead of a silent text box', () => {
  it('shows the manifest’s guidance and keeps the box (no picker exists)', async () => {
    renderCard(MANUAL_ONLY, { canListChannels: false, channelsGuidance: GUIDANCE_KEY });
    const panel = await screen.findByTestId('notification-panel');

    expect(within(panel).queryByTestId('notification-chat-list')).toBeNull();
    const guidance = await within(panel).findByTestId('notification-chat-guidance');
    expect(guidance.textContent).toBe(GUIDANCE_TEXT);
    // Manual entry is the only way in, so the box is visible — not folded away.
    expect(within(panel).getByTestId('integration-field-notifyChannelId')).toBeInTheDocument();
  });

  it('falls back to translated copy — never a raw key — when there is no annotation text', async () => {
    renderCard(MANUAL_ONLY, { canListChannels: false, channelsGuidance: null });
    const panel = await screen.findByTestId('notification-panel');

    const guidance = await within(panel).findByTestId('notification-chat-guidance');
    expect(guidance.textContent ?? '').not.toMatch(/settings:/);
    expect(guidance.textContent ?? '').toMatch(/conversations/i);
  });

  it('explains the same thing in the routing fold, from the same annotation', async () => {
    const user = userEvent.setup();
    renderCard(MANUAL_ONLY, { canListChannels: false, channelsGuidance: GUIDANCE_KEY });

    await user.click(await screen.findByTestId('instance-more-toggle-bi_telegram'));
    const unsupported = await screen.findByTestId('instance-chats-unsupported-bi_telegram');
    expect(unsupported.textContent).toBe(GUIDANCE_TEXT);
  });
});
