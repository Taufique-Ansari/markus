/**
 * Locale coverage for **manifest-authored** strings.
 *
 * ── The defect this exists to prevent ────────────────────────────────────────
 *
 * The platform manifest is data over HTTP: a platform's label, its field
 * labels/help/placeholders, its select options and its guide steps all arrive as
 * English strings from the backend registry. The UI renders them through
 * convention keys and falls back to the manifest string when no key exists.
 *
 * That fallback is a feature — a brand-new platform renders with zero UI code —
 * but it also means an *untranslated* string is invisible in review: the page
 * just shows English inside an otherwise Chinese (or Spanish) UI. It happened
 * repeatedly: `notifyEnabled` (the notification master switch) shipped with no
 * locale entry at all, and the notification-destination fields on telegram /
 * slack / whatsapp / discord never had one.
 *
 * So the invariant is asserted here instead of trusted to reviewers: **every
 * human-visible string the manifest authors has a locale entry in every
 * locale.** Adding a field to the registry without its translations now fails
 * this test, by name.
 *
 * Placeholders count too. A placeholder is an example the user sees in the
 * input; leaving it to the fallback is how "every field translated except the
 * grey text inside the box" happens.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORM_MANIFESTS } from '../src/platforms/registry.js';
import type { PlatformField, PlatformManifest } from '../src/platforms/registry.js';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', '..', 'web-ui', 'src', 'locales');

/** Every locale the app ships. Adding a locale means adding it here. */
const LOCALES = ['zh-CN', 'en', 'es'] as const;

type Dict = Record<string, unknown>;

const settingsFor = (locale: string): Dict =>
  JSON.parse(readFileSync(join(localesDir, locale, 'settings.json'), 'utf8')) as Dict;

const BUNDLED: Record<string, Dict> = Object.fromEntries(
  LOCALES.map((l) => [l, settingsFor(l)]),
);

/** Resolve a dotted path (`integrations.platforms.feishu.fields.appId.label`). */
function lookup(obj: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>(
    (acc, key) => (acc && typeof acc === 'object' ? (acc as Dict)[key] : undefined),
    obj,
  );
}

interface Expectation {
  platform: string;
  /** Suffix under `integrations.platforms.<id>.` */
  suffix: string;
  /** The English string the manifest authored (reported on failure). */
  english: string;
}

/** Every translatable string a manifest authors, as convention keys. */
function manifestStrings(): Expectation[] {
  const out: Expectation[] = [];
  for (const manifest of PLATFORM_MANIFESTS as PlatformManifest[]) {
    const push = (suffix: string, english: string) =>
      out.push({ platform: manifest.id, suffix, english });

    push('label', manifest.label);
    push('description', manifest.description);

    for (const field of manifest.fields as PlatformField[]) {
      const base = `fields.${field.key}`;
      push(`${base}.label`, field.label);
      if (field.help) push(`${base}.help`, field.help);
      if (field.placeholder) push(`${base}.placeholder`, field.placeholder);
      for (const option of field.options ?? []) {
        push(`${base}.options.${option.value}`, option.label);
      }
    }

    for (const [index, step] of (manifest.guide ?? []).entries()) {
      push(`guide.step${index + 1}.title`, step.title);
      if (step.desc) push(`guide.step${index + 1}.desc`, step.desc);
    }
  }
  return out;
}

describe('locale coverage — manifest-authored strings', () => {
  const strings = manifestStrings();

  it('finds the manifests (guards against a vacuous pass)', () => {
    expect(strings.length).toBeGreaterThan(50);
  });

  for (const locale of LOCALES) {
    it(`every manifest string is translated in ${locale}`, () => {
      const dict = BUNDLED[locale];
      const missing = strings
        .filter(({ platform, suffix }) => {
          const value = lookup(dict, `integrations.platforms.${platform}.${suffix}`);
          return typeof value !== 'string' || value.trim() === '';
        })
        .map(({ platform, suffix, english }) => `${platform}.${suffix}  (manifest: "${english}")`);

      expect(missing).toEqual([]);
    });
  }
});
