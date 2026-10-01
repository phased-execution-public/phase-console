/**
 * The icons a note (a banner, a toast) is drawn with — one per note severity,
 * by the name `shared/status-notes.js` gives it.
 *
 * A module of its own for first paint's sake: `StatusStack` and the toast sit
 * in the preloaded `@/components/ui` barrel and draw only these four. Were they
 * read from `status-icons.ts`, that whole module — all 98 icons — would land in
 * the chunk every visitor downloads first, because a module a first-paint file
 * and a page both import is placed whole (`scripts/check-dist.mjs`).
 */
import { CircleCheck, CircleX, Info, TriangleAlert, type LucideIcon } from 'lucide-react';

export const NOTE_ICONS: Readonly<Record<string, LucideIcon>> = Object.freeze({
  'circle-x': CircleX,
  'triangle-alert': TriangleAlert,
  info: Info,
  'circle-check': CircleCheck,
});
