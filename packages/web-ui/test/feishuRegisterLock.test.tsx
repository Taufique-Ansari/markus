/**
 * FeishuExtras — the answering agent is committed to the QR the moment it is
 * minted.
 *
 * The app is created server-side (and named after the agent) the instant the
 * scan is confirmed, so the picker must lock while a scan is in flight:
 * letting it change afterwards would show one agent while the created bot
 * answers as another. Cancelling unlocks it again.
 *
 * `api` is stubbed because the panel owns the two Feishu register calls — the
 * register promise deliberately never settles, which is what keeps the panel on
 * the "scan requested" frame so the lock can be observed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '../src/i18n/index.ts';

vi.mock('../src/api.ts', () => ({
  api: {
    settings: {
      getFeishuRegisterStatus: vi.fn(async () => ({ active: false })),
      registerFeishuApp: vi.fn(() => new Promise(() => { /* stays pending */ })),
    },
    agents: { list: vi.fn(async () => ({ agents: [] })) },
  },
}));

import { FeishuExtras } from '../src/components/integrations/FeishuExtras.tsx';
import type { PlatformExtrasContext, PlatformStatus } from '../src/lib/platformIntegrations.ts';

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

const STATUS: PlatformStatus = {
  id: 'feishu',
  label: 'Feishu / Lark',
  capabilities: { inbound: true, outbound: true, threads: true, cards: true },
  fields: [
    { key: 'appId', label: 'App ID', type: 'text', required: true },
    { key: 'appSecret', label: 'App Secret', type: 'password', required: true, secret: true },
    { key: 'agentId', label: 'Agent', type: 'agent', required: true },
  ],
  defaultEnabled: false,
  enabled: false,
  connected: false,
  hasConfig: false,
  values: {},
  secrets: { appSecret: { hasValue: false } },
};

function ctx(over: Partial<PlatformExtrasContext> = {}): PlatformExtrasContext {
  return {
    platformId: 'feishu',
    status: STATUS,
    values: {},
    setValue: vi.fn(),
    reload: vi.fn(),
    agents: [{ id: 'agt_sales', name: 'Sales' }],
    ...over,
  };
}

const picker = () => screen.getByRole('combobox') as HTMLInputElement;

describe('FeishuExtras — the agent is locked into the QR once it is minted', () => {
  it('leaves the agent picker editable until a scan is started', () => {
    render(<FeishuExtras ctx={ctx()} />);
    expect(picker().disabled).toBe(false);
  });

  it('locks the agent picker the moment the QR is requested', async () => {
    const user = userEvent.setup();
    render(<FeishuExtras ctx={ctx({ values: { agentId: 'agt_sales' } })} />);
    expect(picker().disabled).toBe(false);

    await user.click(screen.getByTestId('feishu-register-start'));

    // The scan is in flight: the choice is committed, so the picker locks and a
    // cancel affordance appears.
    await waitFor(() => expect(picker().disabled).toBe(true));
    expect(screen.getByTestId('feishu-register-cancel')).toBeTruthy();
  });

  it('unlocks again when the scan is cancelled', async () => {
    const user = userEvent.setup();
    render(<FeishuExtras ctx={ctx({ values: { agentId: 'agt_sales' } })} />);
    await user.click(screen.getByTestId('feishu-register-start'));
    await waitFor(() => expect(picker().disabled).toBe(true));

    await user.click(screen.getByTestId('feishu-register-cancel'));
    await waitFor(() => expect(picker().disabled).toBe(false));
  });

  it('will not start a scan before an agent is chosen', () => {
    render(<FeishuExtras ctx={ctx()} />);
    expect((screen.getByTestId('feishu-register-start') as HTMLButtonElement).disabled).toBe(true);
  });
});
