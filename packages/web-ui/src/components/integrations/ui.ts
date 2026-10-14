/**
 * The integration settings **design language** — the one place the type scale
 * and the settings-row shape are defined.
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 * The card used to mix `text-[10px]`, `text-[11px]`, `text-xs`, `text-sm` and
 * two different section-heading treatments inside a single view, so nothing
 * read as more important than anything else — the "font sizes are chaotic"
 * report. A settings screen is a *hierarchy*, and each level must look the same
 * everywhere:
 *
 *   Card title     → CARD_TITLE   a section of the card ("Bot setup")
 *   Field label    → ROW_LABEL    the name of a setting ("Bot name")
 *   Field value    → INPUT / text-sm text-fg-primary   the control's own text
 *   Hint / help    → HINT         the sentence under a setting
 *   Meta / badge   → META         counts, chips, timestamps
 *
 * Fixing this at call sites does not hold — the next edit reintroduces a
 * one-off. So the scale lives here and every surface consumes it.
 *
 * ── The settings row ────────────────────────────────────────────────────────
 * A setting is a **row**: its label on the left, its control on the right, on
 * one line — not a label stacked above a full-width box. `ROW` wraps when the
 * viewport is too narrow for both, which is what makes it behave on mobile
 * without a separate breakpoint.
 *
 * ── The selected / active look ──────────────────────────────────────────────
 * `chipClass` reads the `selected-*` theme tokens (index.css), never
 * `brand-600`: in the dark palette `brand-600` is chroma 0.04 — grey — so a
 * selected chip and an unselected one were indistinguishable. The token
 * resolves per theme, so one definition is right in every theme.
 */

/** A card — one visual section of the settings surface. */
export const CARD = 'rounded-xl border border-border-default bg-surface-secondary p-4';

/** The title of a card / section. */
export const CARD_TITLE = 'text-sm font-semibold text-fg-primary';

/** Secondary sentence under a card title. */
export const CARD_SUBTITLE = 'text-xs text-fg-tertiary';

/**
 * A settings row: label left, control right, on one line. `flex-wrap` + a
 * `min-w` on the control (below) is what turns it into "label above control"
 * on a narrow screen, with no breakpoint to remember.
 */
export const ROW = 'flex flex-wrap items-center justify-between gap-x-4 gap-y-2';

/** Row variant whose control is taller than one line (chips, a textarea). */
export const ROW_START = 'flex flex-wrap items-start justify-between gap-x-4 gap-y-2';

/** The name of a setting. */
export const ROW_LABEL = 'shrink-0 text-sm text-fg-secondary';

/** The control column of a row. `justify-end` right-aligns a self-sized control
 *  (a switch, an agent picker) while a `w-full` control still fills the row. */
export const ROW_CONTROL = 'flex-1 min-w-[10rem] flex justify-end';

/** The sentence under a setting. */
export const HINT = 'text-xs text-fg-tertiary';

/** Inline meta: counts, timestamps, small chips. */
export const META = 'text-xs text-fg-tertiary';

/** A text / password / number / select control. */
export const INPUT =
  'w-full px-3 py-2 text-sm bg-surface-primary border border-border-default rounded-lg ' +
  'text-fg-primary placeholder-fg-tertiary focus:outline-none focus:ring-2 ' +
  'focus:ring-brand-500/40 focus:border-brand-500 transition-colors';

/**
 * A selectable chip / segmented option. `active` resolves from the theme, so
 * the selection stays visible in dark mode (see the module note).
 */
export function chipClass(active: boolean): string {
  return (
    'inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg border transition-colors ' +
    (active
      ? 'bg-selected-bg border-selected-border text-selected-fg'
      : 'bg-surface-primary border-border-default text-fg-secondary hover:border-fg-tertiary')
  );
}
