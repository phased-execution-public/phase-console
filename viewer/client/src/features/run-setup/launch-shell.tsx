/**
 * The overlay around a launch — the frame every RunSetup in a dialog wears.
 *
 * Two layouts, one contract. A PHONE (below the shell breakpoint) gets a
 * full-screen sheet: the title and the buttons are fixed, only the body
 * scrolls, and the sheet is exactly `--app-height` tall so the footer sits on
 * the keyboard's upper edge while a field is being typed in. A DESK gets a
 * framed dialog: fixed title, one scrolling body, fixed buttons.
 *
 * Since control-tower phase 22 a staged launch is the quick view — one
 * screen, no stage bar (the `Stepper` retired from it) and no ticket pane
 * beside it: what the ticket said is the quick view's own first line and its
 * "values differ" fold. Launch is the ONE ink primary button, on every
 * screen, phone included — the departure line above the tiles has already
 * said what will happen.
 *
 * A flat mode (a QA review, a recovery) wears the same frame: fixed title,
 * scrolling form, fixed buttons — which is what fixes the launch dialog's
 * off-screen Start button (register row 441).
 */

import { Bot, Play, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { Button, Dialog, DialogContent, Sheet, SheetContent } from '@/components/ui';
import { usePhone } from '@/lib/media';
import type { RunSetupMode } from './modes';

export interface LaunchSubmit {
  label: string;
  busy: boolean;
  disabled: boolean;
  /** Why it is disabled, for the button's hover. */
  title?: string;
  onSubmit: () => void;
  /** The muted line beside the buttons. */
  note?: ReactNode;
}

export function LaunchShell({
  open,
  onOpenChange,
  title,
  description,
  mode,
  staged,
  scrollKey,
  banners,
  submit,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  mode: RunSetupMode;
  /** The quick view — a wider dialog on a desk. */
  staged: boolean;
  /** When this changes the body opens at its top — a phone's pushed sub-view, and back. */
  scrollKey?: string;
  /** Above the form: claims, verdicts, the no-run banner. */
  banners?: ReactNode;
  submit: LaunchSubmit;
  children: ReactNode;
}) {
  const phone = usePhone();
  const bodyRef = useRef<HTMLDivElement>(null);

  // A pushed sub-view opens at its top, and so does the list it came back to.
  // `scrollTop`, never `scrollIntoView` — the shell contract (`docs/design.md`
  // §10) — and instant, because the stylesheet's `scroll-behavior: smooth`
  // does not apply to a property write.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [scrollKey]);

  const Icon = mode === 'qa' ? ShieldCheck : mode === 'session' ? Play : Bot;
  const footer = (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
      {submit.note != null && submit.note !== '' && (
        <span className="min-w-0 flex-1 basis-full text-2xs text-ink-muted sm:basis-auto">{submit.note}</span>
      )}
      <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          variant="action"
          disabled={submit.disabled}
          title={submit.title}
          onClick={submit.onSubmit}
          data-testid="launch-submit"
        >
          <Icon size={15} aria-hidden /> {submit.busy ? 'Starting…' : submit.label}
        </Button>
      </div>
    </div>
  );

  return phone ? (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="full"
        title={title}
        description={description}
        footer={footer}
        bodyRef={bodyRef}
        bodyClassName="p-3"
      >
        {banners}
        {children}
      </SheetContent>
    </Sheet>
  ) : (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        frame
        title={title}
        description={description}
        footer={footer}
        bodyRef={bodyRef}
        className={staged ? 'w-[min(64rem,calc(100%-2rem))]' : undefined}
      >
        {banners}
        {children}
      </DialogContent>
    </Dialog>
  );
}
