/**
 * THE control class, in its two looks — defined once, here (a source guard in
 * `styles/touch.test.ts` holds it so). Every hand-written `<input>`, `<select>`
 * trigger and combobox trigger wears one of these, which is what gives every
 * control the same 36 px height on a desk, the 44 px thumb floor on touch, the
 * 16 px input size iOS does not zoom into, and the `min-w-0` that stops a
 * select sizing to its widest option.
 *
 * `field` is INSET — for a control on a raised surface (a card, a sheet), it
 * sits on the ground. `fieldSurface` is RAISED — for a control on the page
 * ground, it is a surface.
 */
const CONTROL =
  '[@media(hover:none)]:min-h-(--tap-min) rounded border border-rule-strong px-2.5 text-body text-ink disabled:opacity-50';

export const field = 'h-9 min-w-0 bg-ground ' + CONTROL;
export const fieldSurface = 'h-9 min-w-0 bg-surface hover:border-ink-faint ' + CONTROL;
