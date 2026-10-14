/**
 * Notification destinations in the Settings UI — regression guards (slice T6 of
 * the notification-delivery fix).
 *
 * Design: docs/architecture/notification-delivery.md §2 R7, §3 ("UI / guidance,
 * generic"), §4 T6.
 *
 * Three claims this file exists to keep true, each of which was false before:
 *
 *  1. **The panel is generic.** A platform the front-end has no code for
 *     (`slack` here, and a made-up one) renders the destination form the moment
 *     its *manifest* annotates a destination — no per-platform branch, no entry
 *     in the extras registry. This is the front-end half of root cause R5.
 *  2. **Reachability is one predicate.** "Can this bot deliver?" is derived by a
 *     single pure function (`notificationReachability`) that mirrors the
 *     resolver's declared-destination scan. The panel's status line is that
 *     function's output — nothing re-derives it.
 *  3. **The unconfigured warning actually renders.** The old tip tested a field
 *     *definition* (`!notifyChatId`, always truthy) so it could never appear;
 *     here the not-configured state is asserted on the rendered DOM.
 *
 * Slice U3 (req_8f391) made the picker primary and demoted the raw id box to a
 * collapsed "enter an id manually" hatch, so the generic-panel and reachability
 * guards below reach the destination field through that hatch. The picker-first
 * behaviour itself is covered by `notificationPicker.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '../src/i18n/index.ts';
import type { PlatformField, PlatformStatus } from '../src/lib/platformIntegrations.ts';
import {
  chatDestinationField,
  notificationDestinationFields,
  notificationFields,
  notificationPreferenceFields,
  notificationReachability,
} from '../src/lib/platformNotifications.ts';
import type { InstanceStatus } from '../src/lib/instanceIntegrations.ts';
import { InstanceCard, type InstanceClient } from '../src/components/integrations/InstanceCard.tsx';
import { SetupGuide } from '../src/components/integrations/SetupGuide.tsx';
import { PLATFORM_EXTRAS } from '../src/components/integrations/platformExtras.tsx';

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

/**
 * A platform with a declared destination that the front-end has *no* code for.
 * `slack` is deliberately absent from `PLATFORM_EXTRAS` — if the panel only
 * showed up for a platform someone had written code for, these tests go red.
 */
const SLACK: PlatformStatus = {
  id: 'slack',
  label: 'Slack',
  capabilities: { inbound: true, outbound: true, threads: true },
  fields: [
    { key: 'botToken', label: 'Bot token', type: 'password', required: true, secret: true },
    { key: 'notifyChannelId', label: 'Default channel', type: 'text', required: false, notifyTarget: 'chat' },
    { key: 'notifyUserId', label: 'Default user', type: 'text', required: false, notifyTarget: 'user' },
    { key: 'notifyOnApproval', label: 'Notify on approvals', type: 'boolean', required: false, default: true },
    {
      key: 'notifyPriority',
      label: 'Notify priority',
      type: 'select',
      required: false,
      multiple: true,
      options: [
        { value: 'high', label: 'High' },
        { value: 'normal', label: 'Normal' },
      ],
    },
  ],
  defaultEnabled: false,
  enabled: true,
  connected: true,
  hasConfig: true,
  values: {},
  secrets: { botToken: { hasValue: true } },
};

/** The same platform, minus the annotation — nothing to configure, no panel. */
const PLAIN: PlatformStatus = {
  ...SLACK,
  id: 'glip',
  label: 'Glip',
  fields: SLACK.fields.filter((f) => !f.notifyTarget),
};

/** Feishu as the registry now ships it: annotated destination keys (slice T4). */
const FEISHU: PlatformStatus = {
  id: 'feishu',
  label: 'Feishu / Lark',
  capabilities: { inbound: true, outbound: true, threads: true, cards: true },
  fields: [
    { key: 'appId', label: 'App ID', type: 'text', required: true },
    { key: 'appSecret', label: 'App Secret', type: 'password', required: true, secret: true },
    { key: 'notifyChatId', label: 'Default chat', type: 'text', required: false, notifyTarget: 'chat' },
    { key: 'notifyOpenId', label: 'Default user', type: 'text', required: false, notifyTarget: 'user' },
    { key: 'notifyOnApproval', label: 'Notify on approvals', type: 'boolean', required: false, default: true },
  ],
  defaultEnabled: false,
  enabled: true,
  connected: true,
  hasConfig: true,
  values: { appId: 'cli_abc' },
  secrets: { appSecret: { hasValue: true } },
};

/** Slack as the registry now ships it: destination + preferences + the master switch. */
const SLACK_WITH_MASTER: PlatformStatus = {
  ...SLACK,
  fields: [
    { key: 'notifyEnabled', label: 'Notifications', type: 'boolean', required: false, default: true },
    ...SLACK.fields,
  ],
};

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

function clientStub(over: Partial<InstanceClient> = {}) {
  const calls: Array<{ op: string; id?: string; payload?: unknown }> = [];
  const client: InstanceClient = {
    create: vi.fn(async (platform, label) => instance(SLACK, { id: 'bi_new', platform, label })),
    save: vi.fn(async (id, payload) => { calls.push({ op: 'save', id, payload }); }),
    test: vi.fn(async () => ({ ok: true, message: 'pong' })),
    remove: vi.fn(async (id) => { calls.push({ op: 'remove', id }); }),
    listChannels: vi.fn(async () => ({ supported: true, channels: [] })),
    saveChannels: vi.fn(async () => undefined),
    startConnectionTest: vi.fn(async () => null),
    getConnectionTest: vi.fn(async () => null),
    ...over,
  };
  return { client, calls };
}

// ─── The single predicate ────────────────────────────────────────────────────

describe('lib/platformNotifications — the manifest scan the panel is built on', () => {
  it('splits the notification surface into destinations and preference knobs', () => {
    expect(notificationDestinationFields(SLACK.fields).map((f) => f.key)).toEqual([
      'notifyChannelId',
      'notifyUserId',
    ]);
    expect(notificationPreferenceFields(SLACK.fields).map((f) => f.key)).toEqual([
      'notifyOnApproval',
      'notifyPriority',
    ]);
    // A secret is never a preference even if it were `notify`-named.
    expect(notificationFields(SLACK.fields).map((f) => f.key)).not.toContain('botToken');
    expect(chatDestinationField(SLACK.fields)?.key).toBe('notifyChannelId');
  });

  it('reports unsupported / not-configured / configured from the destination values alone', () => {
    expect(notificationReachability(PLAIN.fields, {})).toBe('unsupported');
    expect(notificationReachability(SLACK.fields, {})).toBe('not-configured');
    // Whitespace is not an address.
    expect(notificationReachability(SLACK.fields, { notifyChannelId: '   ' })).toBe('not-configured');
    // Either destination kind counts; neither is required to be the "first" one.
    expect(notificationReachability(SLACK.fields, { notifyUserId: 'U1' })).toBe('configured');
    expect(notificationReachability(SLACK.fields, { notifyChannelId: 'C1' })).toBe('configured');
  });

  it('never consults a platform id — the same fields decide for any platform', () => {
    const renamed: PlatformField[] = SLACK.fields.map((f) =>
      f.key === 'notifyChannelId' ? { ...f } : f,
    );
    expect(notificationReachability(renamed, { notifyChannelId: 'C1' })).toBe('configured');
  });
});

// ─── The master switch ───────────────────────────────────────────────────────

describe('NotificationPanel — the master switch', () => {
  it('sits on the heading row, is not one of the preference rows, and toggles the draft', async () => {
    const { client, calls } = clientStub();
    const user = userEvent.setup();
    render(
      <InstanceCard instance={instance(SLACK_WITH_MASTER)} client={client} extras={{}} defaultExpanded />,
    );

    const card = await screen.findByTestId('instance-card-bi_slack');
    const panel = await within(card).findByTestId('notification-panel');

    const master = within(panel).getByTestId('integration-field-notifyEnabled');
    expect(master).toHaveAttribute('aria-checked', 'true');

    // One control, one fact: it must not ALSO render as a preference row.
    const prefs = within(panel).getByTestId('notification-preferences');
    expect(within(prefs).queryByTestId('integration-field-notifyEnabled')).toBeNull();

    await user.click(master);
    await waitFor(() =>
      expect(calls.find((c) => c.op === 'save')?.payload?.['notifyEnabled']).toBe(false),
    );
  });

  it('shows no switch when the manifest predates the field', async () => {
    const { client } = clientStub();
    render(<InstanceCard instance={instance(SLACK)} client={client} extras={{}} defaultExpanded />);

    const card = await screen.findByTestId('instance-card-bi_slack');
    const panel = await within(card).findByTestId('notification-panel');
    expect(within(panel).queryByTestId('integration-field-notifyEnabled')).toBeNull();
  });
});

// ─── The panel is generic ────────────────────────────────────────────────────

describe('NotificationPanel — visible for every platform whose manifest declares a destination', () => {
  it('renders the destination controls for a NON-Feishu platform, with no extras registry entry', async () => {
    const { client } = clientStub();
    const user = userEvent.setup();
    render(
      <InstanceCard instance={instance(SLACK)} client={client} extras={{}} defaultExpanded />,
    );

    const card = await screen.findByTestId('instance-card-bi_slack');
    const panel = await within(card).findByTestId('notification-panel');
    // Enumerable platform → the picker leads…
    expect(within(panel).getByTestId('notification-chat-list')).toBeInTheDocument();
    // …and its destination fields are the panel's own, behind the manual hatch.
    await user.click(within(panel).getByTestId('notification-manual-toggle'));
    expect(within(panel).getByTestId('integration-field-notifyChannelId')).toBeInTheDocument();
    expect(within(panel).getByTestId('integration-field-notifyUserId')).toBeInTheDocument();
  });

  it('owns those fields: they are not rendered a second time in the generic form', async () => {
    const { client } = clientStub();
    const user = userEvent.setup();
    render(
      <InstanceCard instance={instance(SLACK)} client={client} extras={{}} defaultExpanded />,
    );

    const card = await screen.findByTestId('instance-card-bi_slack');
    // Exactly one control for the destination, wherever it lives. Open the
    // panel's manual hatch, then look for a second copy of the same field.
    await user.click(within(card).getByTestId('notification-manual-toggle'));
    expect(within(card).getAllByTestId('integration-field-notifyChannelId')).toHaveLength(1);

    await user.click(within(card).getByTestId('instance-more-toggle-bi_slack'));
    const more = await within(card).findByTestId('instance-more-bi_slack');
    expect(within(more).queryByTestId('integration-field-notifyChannelId')).toBeNull();
    expect(within(more).queryByTestId('integration-field-notifyOnApproval')).toBeNull();
  });

  it('renders no panel for a platform that declares no destination', async () => {
    const { client } = clientStub();
    const user = userEvent.setup();
    render(
      <InstanceCard instance={instance(PLAIN)} client={client} extras={{}} defaultExpanded />,
    );
    const card = await screen.findByTestId('instance-card-bi_glip');
    expect(within(card).queryByTestId('notification-panel')).toBeNull();
    // …and the platform's fields stay in the generic form rather than vanishing.
    // A bot with stored credentials folds them behind "Change" — open it first.
    const edit = within(card).queryByTestId('instance-credentials-edit-bi_glip');
    if (edit) await user.click(edit);
    await screen.findByTestId('integration-field-botToken');
  });

  it('is a draft-free section: a brand-new (unsaved) bot does not show it yet', async () => {
    const { client } = clientStub();
    render(
      <InstanceCard instance={instance(SLACK, { id: '' })} client={client} extras={{}} defaultExpanded />,
    );
    const card = await screen.findByTestId('instance-card-new-slack');
    expect(within(card).queryByTestId('notification-panel')).toBeNull();
  });
});

// ─── Reachability is honest, and the warning really shows ────────────────────

describe('reachability status — the warning that used to be dead code', () => {
  it('shows the not-configured warning when the destination is blank', async () => {
    const { client } = clientStub();
    render(
      <InstanceCard instance={instance(SLACK)} client={client} extras={{}} defaultExpanded />,
    );
    const status = await screen.findByTestId('notification-reachability');
    expect(status.getAttribute('data-state')).toBe('not-configured');
    expect(status.textContent ?? '').not.toBe('');
  });

  it('flips to configured as soon as a destination is entered', async () => {
    const { client } = clientStub();
    const user = userEvent.setup();
    render(
      <InstanceCard instance={instance(SLACK)} client={client} extras={{}} defaultExpanded />,
    );

    const status = await screen.findByTestId('notification-reachability');
    expect(status.getAttribute('data-state')).toBe('not-configured');

    // The id box is folded away by default; reach it on purpose.
    await user.click(screen.getByTestId('notification-manual-toggle'));
    await user.type(screen.getByTestId('integration-field-notifyChannelId'), 'C123');
    await waitFor(() =>
      expect(screen.getByTestId('notification-reachability').getAttribute('data-state')).toBe(
        'configured',
      ),
    );
  });

  it('offers the platform’s conversations as destinations, from the manifest’s chat field', async () => {
    const { client } = clientStub({
      listChannels: vi.fn(async () => ({
        supported: true,
        channels: [{ id: 'C_RELEASE', name: '#release' }],
      })),
    });
    const user = userEvent.setup();
    render(
      <InstanceCard instance={instance(SLACK)} client={client} extras={{}} defaultExpanded />,
    );

    const pick = await screen.findByTestId('notification-chat-pick-C_RELEASE');
    expect(pick.getAttribute('aria-pressed')).toBe('false');
    await user.click(pick);

    await waitFor(() =>
      expect(screen.getByTestId('notification-reachability').getAttribute('data-state')).toBe(
        'configured',
      ),
    );
    expect(screen.getByTestId('notification-chat-pick-C_RELEASE').getAttribute('aria-pressed')).toBe(
      'true',
    );
    // The picker writes the *manifest's* chat field — not a parallel one — so the
    // (folded) id box carries the same value once opened.
    await user.click(screen.getByTestId('notification-manual-toggle'));
    expect((screen.getByTestId('integration-field-notifyChannelId') as HTMLInputElement).value).toBe(
      'C_RELEASE',
    );
  });
});

// ─── Feishu: the same panel, plus its opt-in test control ────────────────────

describe('Feishu — one generic panel, no duplicated status judgement', () => {
  it('uses the generic panel and carries no second "configured" tip', async () => {
    const { client } = clientStub();
    const user = userEvent.setup();
    render(
      <InstanceCard
        instance={instance(FEISHU)}
        client={client}
        extras={PLATFORM_EXTRAS}
        defaultExpanded
      />,
    );

    const card = await screen.findByTestId('instance-card-bi_feishu');
    const panel = await within(card).findByTestId('notification-panel');
    expect(within(panel).getByTestId('notification-chat-list')).toBeInTheDocument();
    // The destination field is the generic panel's, reached via the manual hatch.
    await user.click(within(panel).getByTestId('notification-manual-toggle'));
    expect(within(card).getByTestId('integration-field-notifyChatId')).toBeInTheDocument();
    // The old tip rendered a *field definition* check that could never be false.
    expect(within(card).queryByTestId('feishu-tip')).toBeNull();
  });

  it('injects the Feishu test-send control through the generic slot', async () => {
    const { client } = clientStub();
    render(
      <InstanceCard
        instance={instance(FEISHU)}
        client={client}
        extras={PLATFORM_EXTRAS}
        defaultExpanded
      />,
    );

    const card = await screen.findByTestId('instance-card-bi_feishu');
    const panel = await within(card).findByTestId('notification-panel');
    expect(within(panel).getByTestId('feishu-test-message')).toBeInTheDocument();
  });

  it('keeps the scan-to-create panel for a bot with no credentials yet', async () => {
    const { client } = clientStub();
    render(
      <InstanceCard
        instance={instance(FEISHU, {
          hasConfig: false,
          values: {},
          secrets: { appSecret: { hasValue: false } },
        })}
        client={client}
        extras={PLATFORM_EXTRAS}
        defaultExpanded
      />,
    );
    const card = await screen.findByTestId('instance-card-bi_feishu');
    expect(within(card).getByTestId('feishu-register')).toBeInTheDocument();
  });
});

// ─── Guidance ────────────────────────────────────────────────────────────────

describe('SetupGuide — "connect, then say where notifications go"', () => {
  it('appends a generic destination step when the manifest declares one', async () => {
    render(<SetupGuide status={SLACK} configured={false} />);
    expect(await screen.findByText('Set a notification destination')).toBeInTheDocument();
  });

  it('adds no step for a platform with nothing to declare', async () => {
    render(<SetupGuide status={PLAIN} configured={false} />);
    await waitFor(() =>
      expect(screen.queryByText('Set a notification destination')).toBeNull(),
    );
  });
});
