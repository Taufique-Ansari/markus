import { describe, it, expect } from 'vitest';
import { normalizeLanguage } from '../src/locale.js';
import {
  secretaryDisplayName,
  isSecretaryLikeAgent,
  pickOrgSecretary,
  SECRETARY_DISPLAY_NAMES,
} from '../src/secretary.js';

describe('normalizeLanguage', () => {
  it('reduces BCP-47 / POSIX locales to the bare language subtag', () => {
    expect(normalizeLanguage('zh-CN')).toBe('zh');
    expect(normalizeLanguage('zh_Hans')).toBe('zh');
    expect(normalizeLanguage('en-US')).toBe('en');
    expect(normalizeLanguage('fr')).toBe('fr');
  });

  it('defaults to English when unset or empty', () => {
    expect(normalizeLanguage(undefined)).toBe('en');
    expect(normalizeLanguage('')).toBe('en');
  });
});

describe('secretaryDisplayName', () => {
  it('localizes the default Secretary name by language', () => {
    expect(secretaryDisplayName('en')).toBe('Secretary');
    expect(secretaryDisplayName('zh-CN')).toBe('秘书');
    expect(secretaryDisplayName('ja')).toBe('秘書');
    expect(secretaryDisplayName('fr')).toBe('Secrétaire');
  });

  it('falls back to English for an unknown language', () => {
    expect(secretaryDisplayName('xx')).toBe('Secretary');
    expect(secretaryDisplayName(undefined)).toBe('Secretary');
  });
});

describe('Secretary identification is locale-independent', () => {
  it('recognizes every localized display name', () => {
    for (const name of Object.values(SECRETARY_DISPLAY_NAMES)) {
      expect(isSecretaryLikeAgent({ name })).toBe(true);
    }
  });

  it('still recognizes the role template regardless of the display name', () => {
    expect(isSecretaryLikeAgent({ name: '个人助理', role: 'Secretary' })).toBe(true);
    expect(isSecretaryLikeAgent({ agentRole: 'secretary' })).toBe(true);
  });

  it('picks the org secretary even when seeded with a localized name', () => {
    const agents = [
      { id: 'a1', name: '研究员', teamId: 't1' },
      { id: 'a2', name: '秘书', teamId: null },
    ];
    expect(pickOrgSecretary(agents)?.id).toBe('a2');
  });
});
