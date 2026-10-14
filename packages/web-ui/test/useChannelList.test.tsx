/**
 * useChannelList — the ONE front-end action that lists a bot's conversations.
 *
 * Design: req_8f391 (U2). Before this hook, the list was fetched by an inline
 * effect in `InstanceCard` that ran once on expand and could not be re-run: the
 * notification picker and the chat-bindings fold each looked live, but neither
 * offered a refresh, and a failure surfaced in only one of them.
 *
 * These pin the contract the two surfaces rely on:
 *   • one load per target, owned by the hook;
 *   • `reloadChannels()` is the shared refresh — it fetches again and the new
 *     list wins;
 *   • a failure is reported (response `error` or a throw), never fatal;
 *   • only the most recent request may write state (no double-fetch races).
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useChannelList } from '../src/hooks/useChannelList.ts';
import type { InstanceChannelsResponse, PlatformChannel } from '../src/lib/instanceIntegrations.ts';

const ONE: PlatformChannel[] = [{ id: 'C1', name: '#one' }];
const TWO: PlatformChannel[] = [{ id: 'C2', name: '#two' }];

describe('useChannelList — one shared conversation-list action', () => {
  it('lists once on mount and exposes the channels', async () => {
    const load = vi.fn(async (): Promise<InstanceChannelsResponse> => ({ supported: true, channels: ONE }));
    const { result } = renderHook(() => useChannelList(load, 'bi_1', true));

    await waitFor(() => expect(result.current.channels).toEqual(ONE));
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith('bi_1');
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('does not ask when disabled or when there is no id', async () => {
    const load = vi.fn(async (): Promise<InstanceChannelsResponse> => ({ supported: true, channels: ONE }));

    renderHook(() => useChannelList(load, 'bi_1', false));
    renderHook(() => useChannelList(load, '', true));
    await act(async () => {
      await Promise.resolve();
    });

    expect(load).not.toHaveBeenCalled();
  });

  it('reports a listing error the server sent in the response', async () => {
    const load = vi.fn(async (): Promise<InstanceChannelsResponse> => ({
      supported: true,
      channels: [],
      error: 'token expired',
    }));
    const { result } = renderHook(() => useChannelList(load, 'bi_1', true));

    await waitFor(() => expect(result.current.error).toBe('token expired'));
    expect(result.current.loading).toBe(false);
  });

  it('reports a thrown failure instead of leaving a silent empty list', async () => {
    const load = vi.fn(async (): Promise<InstanceChannelsResponse> => {
      throw new Error('network down');
    });
    const { result } = renderHook(() => useChannelList(load, 'bi_1', true));

    await waitFor(() => expect(result.current.error).toBe('network down'));
  });

  it('reloadChannels() fetches again and the fresh list replaces the old one', async () => {
    const load = vi
      .fn<() => Promise<InstanceChannelsResponse>>()
      .mockResolvedValueOnce({ supported: true, channels: [] })
      .mockResolvedValueOnce({ supported: true, channels: TWO });
    const { result } = renderHook(() => useChannelList(load, 'bi_1', true));

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(result.current.channels).toEqual([]);

    act(() => {
      result.current.reloadChannels();
    });

    await waitFor(() => expect(result.current.channels).toEqual(TWO));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('lets only the most recent request write state (an older reply cannot win)', async () => {
    let resolveFirst!: (v: InstanceChannelsResponse) => void;
    let resolveSecond!: (v: InstanceChannelsResponse) => void;
    const load = vi
      .fn<() => Promise<InstanceChannelsResponse>>()
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockImplementationOnce(() => new Promise((r) => { resolveSecond = r; }));
    const { result } = renderHook(() => useChannelList(load, 'bi_1', true));

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.reloadChannels();
    });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));

    // The newer request answers first…
    await act(async () => {
      resolveSecond({ supported: true, channels: TWO });
    });
    await waitFor(() => expect(result.current.channels).toEqual(TWO));

    // …so the older one, arriving late, must not overwrite it.
    await act(async () => {
      resolveFirst({ supported: true, channels: ONE });
    });
    expect(result.current.channels).toEqual(TWO);
  });
});
