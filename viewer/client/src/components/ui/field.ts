/**
 * THE form-control class, defined once — in two backgrounds, because a control
 * is inset on a card and raised on the page ground.
 *
 * Four files carried this string as their own const, and every copy's
 * `text-sm` (13.2px) beat the `@layer base` 16px input floor — which is how
 * focusing the Agent launcher's selects zoomed iOS and left it zoomed. The
 * font floor now wins globally via the unlayered coarse-pointer rule in
 * theme.css; this class adds the thumb floor (the Button idiom: 44px only
 * where there is no hover). A source-text guard in styles/touch.test.ts holds
 * the literal to exactly one definition under src/.
 *
 * ## Why two, and only two
 *
 * `components/toolbar.tsx` had grown a fifth copy under a different name
 * (`fieldClass`) and it was not a mistake: a `<select>` sitting on the page
 * ground needs `bg-surface` to read as a control at all, and the same select
 * inside a Card needs `bg-ground` to read as inset. Those are the two looks
 * this system has. Everything else about them — the height, the thumb floor,
 * the border, the disabled treatment — is shared below, so a third look cannot
 * appear by someone adding a class to one of the two.
 *
 * `min-w-0` is on both deliberately: a `<select>` sizes to its widest option
 * and an `<input>` to its `size` attribute, so in a flex row either will push
 * the page sideways rather than shrink. That has cost four surfaces already
 * (see `styles/touch.test.ts`).
 */

/** Everything but the background — the half the two looks share. */
const CONTROL =
  '[@media(hover:none)]:min-h-(--tap-min) rounded border border-rule px-2 text-sm text-ink disabled:opacity-50';

/** A control on a raised surface (a Card, a Sheet): inset against it. */
export const field = 'h-9 min-w-0 bg-ground ' + CONTROL;

/**
 * A control on the page ground (a toolbar, a filter strip): raised off it.
 *
 * The hover border is only on this one. A control the page ground is already
 * behind has nothing to lift on hover; one sitting ON the ground does.
 */
export const fieldSurface = 'h-9 min-w-0 bg-surface hover:border-rule-strong ' + CONTROL;
