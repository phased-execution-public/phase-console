/**
 * The kit — the LIGHT barrel (7.0, quiet-console phase 1).
 *
 * One modulepreloaded chunk every visitor downloads before the first frame, so
 * it carries only what the first frame draws: the button, the data atoms, the
 * feedback shapes, the banner and the toast store, the field class, the page
 * frame and the row. Everything heavier is imported BY PATH and never
 * re-exported here — `ui/{dialog,sheet,popover,dropdown,command,tooltip,
 * select,combobox,tabs,table,markdown,disclosure,inspector,toolbar,
 * data-list}.tsx`, the typed status family `ui/status`, the line `ui/track`,
 * the grid `ui/grid` — because one re-export is
 * all it takes to put a library in every visitor's first load
 * (`scripts/check-dist.mjs` fails the one that reaches first paint).
 */

/* ---- actions ---- */
export { Button, ButtonGroup, buttonVariants, type ButtonProps } from './button';

/* ---- words and numbers ---- */
export { Kbd, KbdChord } from './kbd';
export { Mono } from './mono';
export { RelativeTime } from './relative-time';
export { Duration, isoDuration } from './duration';
export { Money } from './money';

/* ---- feedback ---- */
export { Empty, Skeleton, Spinner } from './feedback';
export { Banner, NoteIcon, type Severity } from './banner';
export {
  Toaster,
  copy,
  dismissToast,
  toast,
  useToasts,
  type ToastAction,
  type ToastKind,
  type ToastRecord,
} from './toast';

/* ---- forms ---- */
export { field, fieldSurface } from './field';
export { Input, type InputProps } from './input';
export { Label } from './label';

/* ---- the page grammar ---- */
export { SectionHeading } from './section-heading';
export { KeyValue, type KeyValueItem } from './key-value';
export { Page } from './page';
export { Row, type RowProps } from './row';
export { EVERYTHING_PREF, useEverything, type Everything, type EverythingPref } from './everything';
