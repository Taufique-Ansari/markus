/**
 * Settings → Remote Access tab is *reachable* (T9 regression guard).
 *
 * The T9 wizard shipped a brand-new `RemoteAccessSection` and mounted it at
 * `Settings.tsx` line ~2769 (`resolvedTab === 'remote' && <RemoteAccessSection />`),
 * but the settings *navigation* had lost its `remote` entry two commits earlier
 * (6671d906 folded it into `account` and left a `remote → account` legacy alias).
 * Net effect: the panel was dead code — no sidebar entry, and hand-typing
 * `#settings/remote` was rewritten to `account`. The component-level tests all
 * passed because they `render(<RemoteAccessSection />)` directly and never touch
 * the routing/nav seam. This file pins that seam.
 *
 * Everything asserted here is a behavioural invariant of the *wiring*, so it goes
 * red for the right reason if anyone:
 *   • drops the `remote` entry from the tab list,
 *   • drops it from a nav group (rendered `SETTINGS_TAB_GROUPS` drives the sidebar),
 *   • re-introduces a `remote → …` legacy alias that shadows the real tab.
 */
import { describe, it, expect } from 'vitest';
import {
  SETTINGS_TABS,
  SETTINGS_TAB_GROUPS,
  resolveSettingsTab,
} from '../src/pages/Settings.tsx';

/** The ids that actually render in the sidebar = union of all group members. */
const navGroupTabs = SETTINGS_TAB_GROUPS.flatMap(g => g.tabs);

describe('Settings → Remote Access reachability', () => {
  it('declares a `remote` tab entry', () => {
    expect(SETTINGS_TABS.some(t => t.id === 'remote')).toBe(true);
  });

  it('the `remote` tab is placed in a rendered nav group', () => {
    // A tab missing from every group renders nowhere, even though it is "declared".
    expect(navGroupTabs).toContain('remote');
  });

  it('every rendered nav group member is a declared tab (no dangling ids)', () => {
    const declared = new Set(SETTINGS_TABS.map(t => t.id));
    for (const id of navGroupTabs) expect(declared.has(id)).toBe(true);
  });

  it('`#settings/remote` resolves to the remote tab (not aliased away)', () => {
    expect(resolveSettingsTab('#settings/remote')).toBe('remote');
    expect(resolveSettingsTab('#settings/remote')).not.toBe('account');
  });

  it('still resolves every other tab by its own name (alias table not over-eager)', () => {
    expect(resolveSettingsTab('#settings/account')).toBe('account');
    expect(resolveSettingsTab('#settings/appearance')).toBe('appearance');
    expect(resolveSettingsTab('#settings/integrations')).toBe('integrations');
  });

  it('keeps the deliberate legacy aliases (old bookmarks must not 404)', () => {
    expect(resolveSettingsTab('#settings/users')).toBe('account');
    expect(resolveSettingsTab('#settings/organization')).toBe('account');
    expect(resolveSettingsTab('#settings/license')).toBe('account');
  });

  it('rejects unknown / malformed hashes', () => {
    expect(resolveSettingsTab('#settings/nope')).toBeNull();
    expect(resolveSettingsTab('#settings')).toBeNull();
    expect(resolveSettingsTab('')).toBeNull();
  });
});
