/**
 * NotificationPanel — where a bot's approvals and notifications are delivered.
 *
 * Design: docs/architecture/notification-delivery.md §2 R7, §3, §4 T6;
 * picker-first destination from req_8f391 (U3). Layout revised on Owner
 * feedback (2026-10-13 → 2026-10-14):
 *
 *   Notifications                   ● Not set      [master] (switch)
 *   ─────────────────────────────────────────────────────────
 *   Destination
 *     [Load groups]  [chip][chip][chip]
 *     ▸ Enter an ID manually
 *   What to send
 *     Approvals                     [switch]
 *     Minimum priority              [Low][Med][High][Urgent]
 *
 * ── One row shape, one type scale ─────────────────────────────────────────
 *
 * Every setting is a *row*: label left, control right, on one line — the same
 * shape the credentials and the rest of the card use (`ui.ts`). Preferences go
 * through `PlatformFields` for that reason; the panel used to carry its own
 * near-copy of the field renderer, and that copy is exactly how the two drifted
 * (it kept `brand-600`, whose dark-palette chroma is 0.04 — grey — so a selected
 * chip and an unselected one were indistinguishable in dark mode).
 *
 * ── The master switch ──────────────────────────────────────────────────
 *
 * `notifyEnabled` (a real manifest field — see `NOTIFY_MASTER_FIELD`) renders as
 * a switch on the heading row, right of the status chip. Off suppresses every
 * approval and event for this bot at the dispatcher — one writer, one
 * enforcement point. A platform manifest that predates the field (or a test
 * fixture) simply shows no switch.
 *
 * Nothing here is keyed on a platform id — the *manifest* decides what renders,
 * so every outbound platform takes this same path. The panel never saves: it
 * edits the card's draft through `setValue`, so the card stays the single writer.
 */
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlatformChannel } from '../../lib/instanceIntegrations.ts';
import {
  chatDestinationField,
  notificationDestinationFields,
  notificationMasterField,
  notificationPreferenceFields,
  notificationReachability,
} from '../../lib/platformNotifications.ts';
import type { PlatformStatus } from '../../lib/platformIntegrations.ts';
import { Switch } from '../Switch.tsx';
import { ChannelsRefresh } from './ChannelsRefresh.tsx';
import { PlatformFields } from './PlatformCard.tsx';
import { CARD, CARD_TITLE, HINT, chipClass } from './ui.ts';

export interface NotificationPanelProps {
  /** The card's platform view (manifest fields + stored values). */
  status: PlatformStatus;
  /** The card's current draft, keyed by manifest field key. */
  values: Record<string, unknown>;
  /** Write one draft value. The card's save persists it. */
  setValue: (key: string, value: unknown) => void;
  /** Conversations the platform advertised — enables the picker. */
  channels?: PlatformChannel[];
  /** Whether the platform lets us enumerate conversations at all. */
  canListChannels?: boolean;
  /** Listing state, shared with the chat-bindings fold (one `useChannelList`). */
  channelsLoading?: boolean;
  channelsError?: string | null;
  onReloadChannels?: () => void;
  /** *Why* an un-enumerable platform cannot list its conversations (slice U1). */
  channelsGuidance?: string | null;
  /** A platform-provided test-send control (opt-in `PlatformExtras.sendTest`). */
  testSlot?: ReactNode;
}

export function NotificationPanel({
  status,
  values,
  setValue,
  channels = [],
  canListChannels = false,
  channelsLoading = false,
  channelsError = null,
  onReloadChannels = () => {},
  channelsGuidance = null,
  testSlot,
}: NotificationPanelProps) {
  const { t } = useTranslation(['settings', 'common']);
  const [manualOpen, setManualOpen] = useState(false);

  const destinations = notificationDestinationFields(status.fields);
  const preferences = notificationPreferenceFields(status.fields);
  const master = notificationMasterField(status.fields);
  const reachability = notificationReachability(status.fields, values);
  const chatField = chatDestinationField(status.fields);
  // Absent means "not switched off": the manifest default for `notifyEnabled`
  // is `true`, and a fixture that predates the field must keep forwarding.
  const masterOn = master ? values[master.key] !== false : true;

  // The picker's destination key, or `null` when there is nothing to pick into.
  const pickerKey = canListChannels && chatField ? chatField.key : null;
  const selected = pickerKey !== null ? String(values[pickerKey] ?? '') : '';

  // A compact status chip on the heading row, not a paragraph of its own.
  const reachText: Record<typeof reachability, string> = {
    configured: t('settings:instances.notify.reachConfigured', { defaultValue: 'Configured' }),
    'not-configured': t('settings:instances.notify.reachNotConfigured', { defaultValue: 'Not set' }),
    unsupported: t('settings:instances.notify.reachUnsupported', { defaultValue: 'Not supported' }),
  };
  const reachStyle: Record<typeof reachability, string> = {
    configured: 'text-green-600',
    'not-configured': 'text-amber-600',
    unsupported: 'text-fg-tertiary',
  };
  const reachDot: Record<typeof reachability, string> = {
    configured: 'bg-green-500',
    'not-configured': 'bg-amber-400',
    unsupported: 'bg-gray-400',
  };

  const guidanceFallback = t('settings:instances.notify.guidanceFallback', {
    defaultValue: 'This platform can’t list its conversations — enter the destination ID manually.',
  });
  const guidanceText = channelsGuidance
    ? t(channelsGuidance, { defaultValue: guidanceFallback })
    : guidanceFallback;

  // A destination already in force may not be in the list we just read.
  const orphanDestination =
    pickerKey !== null &&
    !channelsLoading &&
    selected !== '' &&
    !channels.some((c) => c.id === selected);

  const groupLabel = 'text-xs font-medium text-fg-secondary mb-2';

  return (
    <section
      data-testid="notification-panel"
      data-reachability={reachability}
      className={CARD}
    >
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 className={CARD_TITLE}>
          {t('settings:instances.notify.title', { defaultValue: 'Notifications' })}
        </h3>
        <div className="flex items-center gap-3">
          <span
            className={`inline-flex items-center gap-1.5 text-xs ${reachStyle[reachability]}`}
            data-testid="notification-reachability"
            data-state={reachability}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${reachDot[reachability]}`} />
            {reachText[reachability]}
          </span>
          {master && (
            <Switch
              checked={masterOn}
              onChange={(next) => setValue(master.key, next)}
              label={t('settings:instances.notify.masterLabel', {
                defaultValue: 'Enable notifications',
              })}
              size="md"
              testId={`integration-field-${master.key}`}
            />
          )}
        </div>
      </div>

      <div className={`space-y-4${masterOn ? '' : ' opacity-60'}`}>
        {/* Destination — pick a conversation the platform advertises, or type an id. */}
        {destinations.length > 0 && (
          <div>
            <div className={groupLabel}>
              {t('settings:instances.notify.destination', { defaultValue: 'Destination' })}
            </div>

            {pickerKey !== null && (
              <div data-testid="notification-chat-list" className="space-y-1.5">
                <ChannelsRefresh
                  loading={channelsLoading}
                  error={channelsError}
                  onReload={onReloadChannels}
                  empty={channels.length === 0}
                  buttonTestId="notification-chat-refresh"
                  errorTestId="notification-chat-error"
                />
                {channels.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {channels.map((channel) => (
                      <button
                        key={channel.id}
                        type="button"
                        aria-pressed={selected === channel.id}
                        data-testid={`notification-chat-pick-${channel.id}`}
                        onClick={() => setValue(pickerKey, channel.id)}
                        className={chipClass(selected === channel.id)}
                      >
                        {channel.name}
                      </button>
                    ))}
                  </div>
                )}
                {channels.length === 0 && !channelsLoading && !channelsError && (
                  <p data-testid="notification-chat-empty" className={HINT}>
                    {t('settings:instances.notify.pickEmpty', {
                      defaultValue:
                        'Add the bot to a group in your IM → click “Load groups” → pick it from the list.',
                    })}
                  </p>
                )}
                {orphanDestination && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      aria-pressed="true"
                      data-testid="notification-chat-pick-current"
                      onClick={() => setValue(pickerKey, selected)}
                      className={chipClass(true)}
                    >
                      {selected}
                    </button>
                  </div>
                )}
              </div>
            )}

            {pickerKey === null && (
              <p data-testid="notification-chat-guidance" className={HINT}>
                {guidanceText}
              </p>
            )}

            {pickerKey !== null ? (
              <div className="mt-2">
                <button
                  type="button"
                  aria-expanded={manualOpen}
                  data-testid="notification-manual-toggle"
                  onClick={() => setManualOpen((v) => !v)}
                  className="inline-flex items-center gap-1 text-xs font-medium text-fg-tertiary hover:text-fg-secondary transition-colors"
                >
                  <svg
                    className={`w-3 h-3 transition-transform ${manualOpen ? 'rotate-90' : ''}`}
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path
                      fillRule="evenodd"
                      d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
                      clipRule="evenodd"
                    />
                  </svg>
                  {t('settings:instances.notify.manualInput', { defaultValue: 'Enter an ID manually' })}
                </button>
                {manualOpen && (
                  <div className="space-y-4 mt-3" data-testid="notification-manual-fields">
                    <PlatformFields status={status} draft={values} fields={destinations} onChange={setValue} />
                  </div>
                )}
              </div>
            ) : (
              <div className="mt-2">
                <PlatformFields status={status} draft={values} fields={destinations} onChange={setValue} />
              </div>
            )}
          </div>
        )}

        {/* What to send — the same rows the credentials use, no paragraphs. */}
        {preferences.length > 0 && (
          <div data-testid="notification-preferences" className="space-y-3">
            <div className={groupLabel}>
              {t('settings:instances.notify.content', { defaultValue: 'What to send' })}
            </div>
            <PlatformFields status={status} draft={values} fields={preferences} onChange={setValue} />
          </div>
        )}

        {testSlot}
      </div>
    </section>
  );
}
