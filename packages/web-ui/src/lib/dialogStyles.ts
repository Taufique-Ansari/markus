// Shared row-layout class strings for the create dialogs (project / task /
// requirement). Row form: label on the left, control on the right — this
// compresses each field to a single line and keeps every dialog in lockstep,
// so the layout can never drift between them again.

export const ROW_GRID_CLS = 'grid grid-cols-[auto_1fr] gap-x-3 gap-y-3.5 items-start';
// Same label/control pairs, but two per row on wide surfaces (detail panels);
// collapses back to a single column on narrow screens. Reuses ROW_LABEL_CLS /
// ROW_INPUT_CLS children so a wide panel never wastes half its width on one field.
export const ROW_GRID_2COL_CLS = 'grid grid-cols-[auto_1fr] sm:grid-cols-[auto_1fr_auto_1fr] gap-x-5 gap-y-3 items-start';
export const ROW_LABEL_CLS = 'pt-2 text-sm text-fg-secondary whitespace-nowrap';
export const ROW_INPUT_CLS = 'w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm focus:border-brand-500 outline-none';
export const ROW_ADD_BTN_CLS = 'shrink-0 whitespace-nowrap text-[11px] font-medium text-brand-500 hover:text-brand-400';

