/**
 * ChannelsRefresh — the refresh control for a platform's conversation list.
 *
 * Design: req_8f391 (U2). One component, rendered by **both** places that show
 * a bot's conversations — the notification picker and the chat-bindings fold —
 * so the two cannot drift in label, spinner or error text. A user who refreshes
 * from either place runs the exact same `reloadChannels()` action and sees the
 * exact same state, because it holds none of its own: `loading`, `error` and
 * `onReload` all come from the single `useChannelList` instance the card owns.
 *
 * The error is shown **in place**, right where the list would be, instead of
 * only inside the chat-bindings fold — a failed listing is the reason the
 * picker is empty, so it has to be visible wherever the picker is.
 */
import { useTranslation } from 'react-i18next';

export interface ChannelsRefreshProps {
  /** True while a listing is in flight; the button reports it and locks. */
  loading: boolean;
  /** The last listing's failure, or `null`. */
  error: string | null;
  /** The shared action — must be the card's one `reloadChannels`. */
  onReload: () => void;
  /** Explicit ids so each consumer stays addressable in tests. */
  buttonTestId: string;
  errorTestId: string;
  /**
   * No conversation list has been shown yet. Drives the label only: the *same*
   * action reads "Load groups" the first time and "Refresh" afterwards, because
   * the two questions a user asks ("what will this do?" / "is the list stale?")
   * differ, while the action does not.
   */
  empty?: boolean;
}

export function ChannelsRefresh({
  loading,
  error,
  onReload,
  buttonTestId,
  errorTestId,
  empty = false,
}: ChannelsRefreshProps) {
  const { t } = useTranslation(['settings', 'common']);

  return (
    <div className="flex items-center gap-2 flex-wrap min-h-[1.25rem]">
      <button
        type="button"
        onClick={onReload}
        disabled={loading}
        aria-busy={loading}
        data-testid={buttonTestId}
        className="inline-flex items-center gap-1 text-[11px] font-medium text-fg-tertiary hover:text-fg-secondary disabled:opacity-60 transition-colors"
      >
        <svg
          className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        {loading
          ? t('settings:instances.channels.refreshing', { defaultValue: 'Refreshing…' })
          : empty
            ? t('settings:integrations.loadGroups', { defaultValue: 'Load groups' })
            : t('settings:instances.channels.refresh', { defaultValue: 'Refresh' })}
      </button>
      {error && (
        <span data-testid={errorTestId} className="text-[11px] text-red-600">
          {error}
        </span>
      )}
    </div>
  );
}
