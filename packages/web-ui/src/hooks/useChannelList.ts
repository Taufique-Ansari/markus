/**
 * useChannelList — the **one** front-end action that asks a platform for its
 * conversations.
 *
 * Design: docs/architecture/notification-delivery.md (§ UI/guidance, T6) and
 * req_8f391 (U2 — "pick the group, don't paste an id").
 *
 * ── Why this hook exists ─────────────────────────────────────────────────────
 *
 * A bot's conversation list is shown in two places on the same card: the
 * notification picker (where approvals and notifications should land) and the
 * chat-bindings fold (which agent answers in a given group). Both surfaces are
 * reading the **same** server fact.
 *
 * They used to be fed by one inline effect in `InstanceCard` that fired once
 * when the card was expanded (`InstanceCard.tsx:349` in the pre-U2 code) and
 * could never be re-run. So a group the user had just added the bot to — or a
 * token they had just refreshed — never appeared without a full page reload,
 * and neither surface said why.
 *
 * This hook is the single writer of that fact. It owns the channels, the
 * loading flag and the error, and exposes `reloadChannels()` as the shared
 * action both surfaces call. Because both consumers are handed the *same*
 * returned object, they cannot drift into two fetches, two spinners or two
 * error strings — "single source of truth", enforced by construction rather
 * than by convention.
 *
 * Lifecycle: the card is opened → one fetch; the user refreshes → one more.
 * Never two in flight — only the most recent request may write state (a late
 * response from an older request is dropped), and unmount invalidates whatever
 * is still pending.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { InstanceChannelsResponse, PlatformChannel } from '../lib/instanceIntegrations.ts';

/**
 * The one thing this hook needs from an instance client: how to ask for the
 * conversations. Kept structural (not the whole `InstanceClient`) so the hook
 * has no import cycle with the card that renders it, and so a caller can pass a
 * bare `client.listChannels`.
 */
export type ChannelListLoader = (id: string) => Promise<InstanceChannelsResponse>;

export interface ChannelList {
  /** The conversations the platform last advertised. */
  channels: PlatformChannel[];
  /** Why the last listing failed, or `null`. Reported, never fatal to the card. */
  error: string | null;
  /** True while a listing is in flight. */
  loading: boolean;
  /**
   * Ask the platform again. The single writer of `channels` / `error` /
   * `loading` — both surfaces refresh through this one action.
   */
  reloadChannels: () => void;
}

/**
 * @param load    the client call, e.g. `client.listChannels`
 * @param id      the instance id; a blank id (a draft) means "nothing to list"
 * @param enabled whether listing applies at all — a collapsed card, or a
 *                platform that cannot enumerate its conversations, must not ask
 */
export function useChannelList(load: ChannelListLoader, id: string, enabled: boolean): ChannelList {
  const [channels, setChannels] = useState<PlatformChannel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Read through a ref so a caller that passes a fresh closure each render
  // (`client.listChannels` off an inline object) does not make `reloadChannels`
  // unstable and re-trigger the load effect on every render.
  const loadRef = useRef(load);
  loadRef.current = load;

  // Ownership token: every reload takes a new one, and only the request holding
  // the current token may write state. A reload that is superseded — or a
  // component that unmounts mid-flight — increments it, so a late response can
  // never clobber a newer one.
  const tokenRef = useRef(0);

  const reloadChannels = useCallback(() => {
    if (!enabled || !id) return;
    const token = ++tokenRef.current;
    setLoading(true);
    loadRef.current(id)
      .then((res) => {
        if (token !== tokenRef.current) return;
        setChannels(res.channels ?? []);
        setError(res.error ?? null);
      })
      .catch((err: unknown) => {
        if (token !== tokenRef.current) return;
        setChannels([]);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (token === tokenRef.current) setLoading(false);
      });
  }, [enabled, id]);

  // Load when the target becomes listable, and re-load when it changes (a
  // different bot, a card that was just opened). The cleanup invalidates any
  // in-flight request for the previous target.
  useEffect(() => {
    reloadChannels();
    return () => {
      tokenRef.current += 1;
    };
  }, [reloadChannels]);

  return { channels, error, loading, reloadChannels };
}
