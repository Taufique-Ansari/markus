/**
 * Cross-locale key parity — every namespace, every locale.
 *
 * ── The defect this exists to prevent ────────────────────────────────────────
 *
 * `integrationLocaleKeys.test.ts` compares zh-CN with en, and only the
 * `instances` namespace. Everything else was unguarded, so gaps accumulated
 * where nobody looked: Spanish was missing the whole notification-destination
 * guide step and the bound-agent picker's labels (both rendered in the bot
 * card), English and Spanish were missing `integrations.status.*`, and the
 * Chinese plural used i18next **v3**'s `_plural` suffix which v4+ (this app is
 * on v26) never resolves — so Chinese fell through to the fallback for that
 * string.
 *
 * Parity is the right invariant because a key that exists in one locale and not
 * another is *always* a bug: either the string is user-visible and someone sees
 * the wrong language, or it is dead and should be deleted. Asserting it here
 * makes both cases impossible to miss.
 *
 * Plural suffixes are normalised per language: a locale only needs the
 * categories its language has (`_other` for Chinese and Spanish; `_one` +
 * `_other` for English). A **v3-era suffix** (`_plural`) is therefore reported
 * as a gap rather than silently matching.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'src', 'locales');

const LOCALES = readdirSync(localesDir).filter((entry) => !entry.startsWith('.'));

/** Every dot-path in an object; plural suffixes are keys too, so keep them. */
function dottedKeys(obj: unknown, prefix = ''): string[] {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return prefix ? [prefix] : [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    out.push(...dottedKeys(value, prefix ? `${prefix}.${key}` : key));
  }
  return out;
}

/** i18next v4+ plural suffixes. A locale only needs its own categories. */
const PLURAL = /_(zero|one|two|few|many|other)$/;
const strip = (keys: string[]) => [
  ...new Set(keys.map((k) => k.replace(PLURAL, ''))),
].sort();

function localeFile(locale: string, namespace: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(localesDir, locale, `${namespace}.json`), 'utf8')) as Record<
    string,
    unknown
  >;
}

const NAMESPACES = readdirSync(join(localesDir, 'en'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''));

describe('locale parity', () => {
  it('ships the locales this suite assumes', () => {
    expect(LOCALES.sort()).toEqual(['en', 'es', 'zh-CN']);
    expect(NAMESPACES.length).toBeGreaterThan(5);
  });

  for (const namespace of NAMESPACES) {
    it(`${namespace}: every locale has the same keys`, () => {
      const sets = Object.fromEntries(
        LOCALES.map((locale) => [locale, new Set(strip(dottedKeys(localeFile(locale, namespace))))]),
      ) as Record<string, Set<string>>;

      const reference = sets['en'];
      const missing: string[] = [];
      for (const key of [...reference].sort()) {
        for (const locale of LOCALES) {
          if (locale !== 'en' && !sets[locale].has(key)) missing.push(`${locale}  ${key}`);
        }
      }
      // …and the other direction, so a key only Spanish has is caught too.
      for (const [locale, set] of Object.entries(sets)) {
        if (locale === 'en') continue;
        for (const key of [...set].sort()) {
          if (!reference.has(key)) missing.push(`en  ${key}  (present in ${locale})`);
        }
      }

      expect(missing).toEqual([]);
    });
  }

  it('uses i18next v4 plural suffixes, never the retired `_plural`', () => {
    const offenders: string[] = [];
    for (const locale of LOCALES) {
      for (const namespace of NAMESPACES) {
        for (const key of dottedKeys(localeFile(locale, namespace))) {
          if (/_plural$/.test(key)) offenders.push(`${locale}/${namespace}  ${key}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
