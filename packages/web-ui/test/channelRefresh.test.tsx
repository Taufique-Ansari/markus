/**
 * Conversation-list refresh — one action, two surfaces (req_8f391, U2).
 *
 * A bot's card shows its conversations in two places: the notification picker
 * (where approvals and notifications should land) and the chat-bindings fold
 * (which agent answers in a given group). They are the **same** server fact and
 * must behave as one:
 *
 *   1. Opening a card fetches the list **once**, not once per surface.
 *   2. Refresh is a real action, reachable from either surface, and it is the
 *      same action — refreshing from the routing fold updates the picker too.
 *   3. A listing that failed says so **where the picker is**, not only down in
 *      the routing fold.
 *
 * The old code had none of these: a single effect fired on expand and could
 * never be re-run, there was no refresh control at all, and the error existed
 * only inside the routing fold. Each assertion below is written so that the
 * pre-U2 code fails it (no refresh test id; no error in the panel).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '../src/i18n/index.ts';
import type { InstanceChannelsResponse, InstanceStatus } from '../src/lib/instanceIntegrations.ts';
import type { PlatformStatus } from '../src/lib/platformIntegrations.ts';
import { InstanceCard, type InstanceClient } from '../src/components/integrations/InstanceCard.tsx';

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** A platform with a chat destination the manifest declares and no front-end code. */
const SLACK: PlatformStatus = {
  id: 'slack',
  label: 'Slack',
  capabilities: { inbound: true, outbound: true, threads: true },
  fields: [
    { key: 'botToken', label: 'Bot token', type: 'password', required: true, secret: true },
    { key: 'notifyChannelId', label: 'Default channel', type: 'text', required: false, notifyTarget: 'chat' },
  ],
  defaultEnabled: false,
  enabled: true,
  connected: true,
  hasConfig: true,
  values: {},
  secrets: { botToken: { hasValue: true } },
};

function instance(over: Partial<InstanceStatus> = {}): InstanceStatus {
  return {
    id: 'bi_slack',
    platform: 'slack',
    label: 'Default',
    enabled: true,
    connected: true,
    hasConfig: true,
    capabilities: SLACK.capabilities,
    fields: SLACK.fields,
    values: {},
    secrets: { botToken: { hasValue: true } },
    agentId: null,
    notifyAgentId: null,
    channels: [],
    lastError: null,
    canListChannels: true,
    lastVerifiedAt: null,
    ...over,
  };
}

function clientStub(listChannels: InstanceClient['listChannels']): InstanceClient {
  return {
    create: vi.fn(async () => instance()),
    save: vi.fn(async () => undefined),
    test: vi.fn(async () => ({ ok: true, message: 'pong' })),
    remove: vi.fn(async () => undefined),
    listChannels,
    saveChannels: vi.fn(async () => undefined),
    startConnectionTest: vi.fn(async () => null),
    getConnectionTest: vi.fn(async () => null),
  };
}

function renderCard(listChannels: InstanceClient['listChannels']) {
  return render(
    <InstanceCard instance={instance()} client={clientStub(listChannels)} extras={{}} defaultExpanded />,
  );
}

// ─── One fetch, two surfaces ─────────────────────────────────────────────────

describe('conversation list — one fetch, shared by both surfaces', () => {
  it('lists once on open, and the routing fold reuses it rather than fetching again', async () => {
    const user = userEvent.setup();
    const load = vi.fn(
      async (): Promise<InstanceChannelsResponse> => ({
        supported: true,
        channels: [{ id: 'C1', name: '#one' }],
      }),
    );
    renderCard(load);

    // The notification picker shows the channel…
    await screen.findByTestId('notification-chat-pick-C1');

    // …and the chat-bindings fold shows the very same one, with no second fetch.
    await user.click(screen.getByTestId('instance-more-toggle-bi_slack'));
    await screen.findByTestId('instance-chat-toggle-bi_slack-C1');

    expect(load).toHaveBeenCalledTimes(1);
  });
});

// ─── Refresh is a real, shared action ────────────────────────────────────────

describe('conversation list — refresh', () => {
  it('offers a refresh control in the notification picker even when the list is empty', async () => {
    const load = vi.fn(
      async (): Promise<InstanceChannelsResponse> => ({ supported: true, channels: [] }),
    );
    renderCard(load);

    expect(await screen.findByTestId('notification-chat-refresh')).toBeInTheDocument();
  });

  it('labels the first load “Load groups” and switches to “Refresh” once a list exists (U4 dead-key wiring)', async () => {
    const user = userEvent.setup();
    const load = vi
      .fn<() => Promise<InstanceChannelsResponse>>()
      .mockResolvedValueOnce({ supported: true, channels: [] })
      .mockResolvedValueOnce({ supported: true, channels: [{ id: 'C9', name: '#nine' }] });
    renderCard(load);

    const refresh = await screen.findByTestId('notification-chat-refresh');
    await waitFor(() => expect(refresh.textContent).toContain('Load groups'));

    await user.click(refresh);

    await waitFor(() => expect(refresh.textContent).toContain('Refresh'));
  });

  it('re-fetches on refresh and the picker picks up a group added since the page opened', async () => {
    const user = userEvent.setup();
    const load = vi
      .fn<() => Promise<InstanceChannelsResponse>>()
      .mockResolvedValueOnce({ supported: true, channels: [] })
      .mockResolvedValueOnce({ supported: true, channels: [{ id: 'C9', name: '#nine' }] });
    renderCard(load);

    const refresh = await screen.findByTestId('notification-chat-refresh');
    expect(screen.queryByTestId('notification-chat-pick-C9')).toBeNull();

    await user.click(refresh);

    expect(await screen.findByTestId('notification-chat-pick-C9')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('drives the SAME list from the routing fold — a refresh there updates the picker too', async () => {
    const user = userEvent.setup();
    const load = vi
      .fn<() => Promise<InstanceChannelsResponse>>()
      .mockResolvedValueOnce({ supported: true, channels: [] })
      .mockResolvedValueOnce({ supported: true, channels: [{ id: 'C9', name: '#nine' }] });
    renderCard(load);

    await user.click(await screen.findByTestId('instance-more-toggle-bi_slack'));
    await user.click(await screen.findByTestId('instance-chats-refresh-bi_slack'));

    // The notification picker, a different surface, sees the refreshed list.
    expect(await screen.findByTestId('notification-chat-pick-C9')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('reports progress while a listing is in flight and locks the control', async () => {
    let resolve!: (v: InstanceChannelsResponse) => void;
    const load = vi.fn(() => new Promise<InstanceChannelsResponse>((r) => { resolve = r; }));
    renderCard(load);

    const refresh = await screen.findByTestId('notification-chat-refresh');
    expect(refresh).toBeDisabled();
    expect(refresh.textContent).toContain('Refreshing');

    await act(async () => {
      resolve({ supported: true, channels: [{ id: 'C1', name: '#one' }] });
    });

    await waitFor(() => expect(refresh).not.toBeDisabled());
    expect(refresh.textContent).toContain('Refresh');
  });
});

// ─── Failure is visible where the picker is ──────────────────────────────────

describe('conversation list — a failed listing says so in place', () => {
  it('shows the error inside the notification panel, not only in the routing fold', async () => {
    const user = userEvent.setup();
    const load = vi.fn(
      async (): Promise<InstanceChannelsResponse> => ({
        supported: true,
        channels: [],
        error: 'token expired',
      }),
    );
    renderCard(load);

    const panel = within(await screen.findByTestId('notification-panel'));
    const err = await panel.findByTestId('notification-chat-error');
    expect(err.textContent).toContain('token expired');

    // …and the routing fold reports the same single failure.
    await user.click(screen.getByTestId('instance-more-toggle-bi_slack'));
    const foldErr = await screen.findByTestId('instance-chats-error-bi_slack');
    expect(foldErr.textContent).toContain('token expired');
  });
});
