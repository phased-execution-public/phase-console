/**
 * The primitive set — `components/ui`, one import for every view.
 *
 * Radix + cva, restyled in place; `field`/`fieldSurface` are THE control class
 * in its two backgrounds (defined once, in field.ts — a source guard holds
 * that: inset on a card, raised on the page ground). Every primitive here keeps the
 * phone bar: thumb-high on `(hover: none)`, 16 px inputs, sized by
 * `--app-height` never `dvh`, never `100vw`, never `scrollIntoView`, never a
 * sticky header inside an overflow-x wrapper, z tokens only.
 */

/* ---- words, states and numbers ---- */
export { Badge, badgeVariants, type BadgeProps, type BadgeTone } from './badge';
export {
  StatusBadge,
  StatusDot,
  STATE_ICONS,
  asUiState,
  decorateStatusWord,
  statusBadgeClass,
  type StatusBadgeProps,
} from './status-badge';
export { CountBadge } from './count-badge';
export { MonoId } from './mono-id';
export { Kbd, KbdChord } from './kbd';
export { MoneyAmount } from './money';
export { Duration, isoDuration } from './duration';
export { RelativeTime } from './relative-time';
export { Heartbeat } from './heartbeat';
export { Meter } from './meter';
export { SegmentBar, type SegmentCounts } from './segment-bar';
export {
  Legend,
  LegendSwatch,
  stateEntries,
  stateTally,
  type LegendCounts,
  type LegendEntry,
} from './legend';
export { Progress } from './progress';
/* 2.x aliases over Badge/StatusBadge — deleted with the old views in Phase 11. */
export {
  Chip,
  StateChip,
  chipVariants,
  asPhaseState,
  PHASE_STATES,
  LEGACY_TONE,
  type ChipProps,
  type ChipTone,
  type PhaseState,
} from './chip';

/* ---- actions ---- */
export { Button, ButtonGroup, buttonVariants, type ButtonProps } from './button';
export { ConfirmButton } from './confirm-button';
export { ToggleGroup, ToggleItem } from './toggle-group';
export { CopyButton } from './copy-button';

/* ---- surfaces ---- */
export { Card, CardHeader, CardTitle, CardBody, Tile, cardClass } from './card';
export { Separator } from './separator';
export { Tabs, TabsList, TabsTrigger, TabsContent } from './tabs';
export { Stepper, type Step } from './stepper';
export { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from './accordion';
export { Disclosure } from './disclosure';
export {
  TableWrap,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  DataTable,
  planColumns,
  trackOf,
  railOffsets,
  useTableFit,
  stickyHeadCell,
  stickyIdentityCell,
} from './table';
export type { Column, DataTableProps } from './table';
export { DataList, type DataListProps } from './data-list';
export { ListRow } from './list-row';
export { SectionHeading } from './section-heading';
export { KeyValue, type KeyValueItem } from './key-value';
export {
  Banner,
  StatusStack,
  noteVariants,
  type Severity,
  type StatusNote,
  type NoteOrder,
} from './status-stack';
export { Skeleton, Empty, Spinner } from './feedback';
export { CardSkeleton, PageError } from './states';

/* ---- overlays ---- */
export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from './dialog';
export { Sheet, SheetTrigger, SheetClose, SheetContent, type SheetSide } from './sheet';
export { Inspector, InspectorSection } from './inspector';
export { AlertDialog, AlertDialogTrigger, AlertDialogContent } from './alert-dialog';
export { Popover, PopoverTrigger, PopoverAnchor, PopoverClose, PopoverContent } from './popover';
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuGroup,
  DropdownMenuSub,
  DropdownMenuRadioGroup,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from './dropdown-menu';
export { InfoTip, Tooltip, TooltipProvider } from './tooltip';
export { Toaster, toast, copy, dismissToast, useToasts, type ToastKind, type ToastRecord } from './toast';
export {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandSeparator,
  CommandItem,
  CommandShortcut,
  CommandDialog,
} from './command';

/* ---- forms ---- */
export { field, fieldSurface } from './field';
export { Input, type InputProps } from './input';
export { Textarea, type TextareaProps } from './textarea';
export { Label } from './label';
export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
} from './select';
export { Combobox, type ComboboxOption } from './combobox';
export { Switch } from './switch';
export { Checkbox } from './checkbox';
export { RadioGroup, RadioItem } from './radio-group';
export { Form, FormField, Field, useFieldIds, type FieldProps } from './form';
export { Composer, type ComposerProps } from './composer';
