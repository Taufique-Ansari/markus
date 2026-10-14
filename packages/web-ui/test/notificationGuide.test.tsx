/**
 * Onboarding the destination — "pull the bot into a group, then pick it" (req_8f391, U4).
 *
 * The SetupGuide answers "how do I connect?". A platform that declares a
 * notification destination needs one more beat — *where do the notifications
 * go* — and it must be told in the shape the platform can actually support:
 *
 *   • enumerable     → the concrete workflow (add the bot to a group → «Load groups» → pick it);
 *   • not enumerable → the manifest's own explanation, never a silent id box.
 *
 * It also pins the dead-key wiring: «Load groups» is the destination control's
 * first-load label, so the `settings:integrations.loadGroups` key — defined in
 * every locale but referenced by nobody before U4 — cannot silently fall back
 * out of the bundle again. The source-scan guard at the bottom fails if the
 * reference is removed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import i18n from '../src/i18n/index.ts';
import type { PlatformStatus } from '../src/lib/platformIntegrations.ts';
import { SetupGuide } from '../src/components/integrations/SetupGuide.tsx';
import { ChannelsRefresh } from '../src/components/integrations/ChannelsRefresh.tsx';

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** A platform that declares a chat destination the manifest, not the code, defines. */
const DESTINATION: PlatformStatus = {
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

/** A real locale key, matching the shape U1's manifests emit. */
const GUIDANCE_KEY = 'settings:instances.routing.guidance.telegram';
const GUIDANCE_TEXT =
  'Telegram bots can’t list their chats — add the bot to the group, then paste the group’s chat ID here.';

// ─── The destination step ────────────────────────────────────────────────────

describe('SetupGuide — where notifications go', () => {
  it('gives an enumerable platform the concrete "pick the group" workflow', async () => {
    render(<SetupGuide status={DESTINATION} configured={false} canListChannels />);

    expect(await screen.findByText('Pick the notification group')).toBeInTheDocument();
    // The workflow names the very control the user will press.
    expect(screen.getByText(/Load groups/)).toBeInTheDocument();
    // …and replaces the vague generic step rather than stacking on top of it.
    expect(screen.queryByText('Set a notification destination')).toBeNull();
  });

  it('shows the manifest’s own guidance — not a silent id box — when it cannot enumerate', async () => {
    render(<SetupGuide status={DESTINATION} configured={false} channelsGuidance={GUIDANCE_KEY} />);

    expect(await screen.findByText('Set a notification destination')).toBeInTheDocument();
    expect(screen.getByText(GUIDANCE_TEXT)).toBeInTheDocument();
  });

  it('falls back to the translated generic sentence when the guidance key has no copy', async () => {
    render(
      <SetupGuide
        status={DESTINATION}
        configured={false}
        channelsGuidance="settings:instances.routing.guidance.nope"
      />,
    );

    expect(
      await screen.findByText(
        'Pick the chat or user that should receive approvals and notifications — without it they have nowhere to go.',
      ),
    ).toBeInTheDocument();
  });

  it('adds no destination step for a platform that declares none', async () => {
    const plain: PlatformStatus = {
      ...DESTINATION,
      fields: [{ key: 'token', label: 'Token', type: 'password', required: true, secret: true }],
    };
    render(<SetupGuide status={plain} configured={false} canListChannels />);

    expect(screen.queryByText('Pick the notification group')).toBeNull();
    expect(screen.queryByText('Set a notification destination')).toBeNull();
  });
});

// ─── The wired "Load groups" key ─────────────────────────────────────────────

describe('destination control — the “Load groups” key is wired', () => {
  it('labels the first load “Load groups” and a later refresh “Refresh”', () => {
    const { rerender } = render(
      <ChannelsRefresh
        loading={false}
        error={null}
        onReload={() => {}}
        empty
        buttonTestId="b"
        errorTestId="e"
      />,
    );
    expect(screen.getByTestId('b').textContent).toContain('Load groups');

    rerender(
      <ChannelsRefresh
        loading={false}
        error={null}
        onReload={() => {}}
        empty={false}
        buttonTestId="b"
        errorTestId="e"
      />,
    );
    expect(screen.getByTestId('b').textContent).toContain('Refresh');
  });

  it('keeps the key referenced by a component so it cannot go dead again', () => {
    // `settings:integrations.loadGroups` had zero references before U4. If the
    // reference is ever dropped the key silently leaves the shipped bundle
    // again, so we scan the components that own destination controls.
    const candidates = [
      join(process.cwd(), 'packages/web-ui/src/components/integrations'),
      join(process.cwd(), 'src/components/integrations'),
    ];
    const dir = candidates.find((d) => existsSync(d));
    expect(dir, 'integrations components directory not found').toBeTruthy();
    const source = readdirSync(dir as string)
      .filter((f) => f.endsWith('.tsx'))
      .map((f) => readFileSync(join(dir as string, f), 'utf8'))
      .join('\n');
    expect(source).toContain('settings:integrations.loadGroups');
  });
});
