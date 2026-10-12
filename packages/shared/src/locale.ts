/**
 * Locale helpers — the single place that answers "what language is this host /
 * user running in?".
 *
 * Used to internationalize generated *display* strings (e.g. the name of the
 * default Secretary agent) so a first-run user never sees an English name in a
 * non-English environment.
 */

/** Reduce a BCP-47 / POSIX locale to its bare language subtag ('zh-CN' → 'zh'). */
export function normalizeLanguage(locale?: string): string {
  if (!locale) return 'en';
  const lang = locale.toLowerCase().trim().split(/[-_]/, 1)[0];
  return lang || 'en';
}

/**
 * Best-effort locale of the machine running Markus. Node's `Intl` reflects the
 * OS/`LANG` setting; we fall back to the raw POSIX env vars, then to 'en'.
 */
export function resolveHostLocale(): string {
  try {
    const l = Intl.DateTimeFormat().resolvedOptions().locale;
    if (l) return l;
  } catch { /* Intl unavailable — fall through */ }
  return process.env['LC_ALL'] || process.env['LC_MESSAGES'] || process.env['LANG'] || 'en';
}
