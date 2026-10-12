import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * The merge knows this project's type scale. `tailwind-merge` sorts a `text-*`
 * class by what it recognises: a t-shirt size is a font size and anything else
 * is a colour. The four sizes that make a page in 7.0 — `text-title`,
 * `text-section`, `text-body`, `text-meta` (`styles/theme.css`) — are not
 * t-shirt sizes, so without this `cn('text-meta', 'text-ink')` would read as
 * two colours and keep only the last, dropping the size on the floor. Named
 * here once, so the merge keeps a size and a colour side by side.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['title', 'section', 'body', 'meta'] }],
    },
  },
});

/**
 * Join class names, letting a later utility win over an earlier one of the same
 * kind. Without the merge step a component's default (`px-3`) and a caller's
 * override (`px-6`) both land in `class` and the cascade — not the caller —
 * decides, which reads as "the prop did nothing".
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
