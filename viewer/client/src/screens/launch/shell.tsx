/**
 * The frame every launch wears — a full-height sheet below 900, a framed dialog
 * above (7.0, quiet-console phase 13; control-tower phase 22's contract kept).
 *
 * One contract in two layouts: the title is fixed, ONE body scrolls, and the
 * footer is fixed. On a phone the sheet is exactly `--app-height` tall, so with
 * a field focused the footer rides on the keyboard's upper edge and Launch
 * still wins its tap (`e2e/launch.spec.ts`). Launch is the screen's ONE ink
 * primary, phone included — the departure notice above it has already said
 * what will happen — and a held Launch says why in its title and in the
 * footer's line, never only in a hover.
 *
 * A flat mode (a QA review, a recovery) wears the same frame around its form.
 */

import { Bot, Play, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from '@/ui';
import { Dialog, DialogContent } from '@/ui/dialog';
import { Sheet, SheetContent } from '@/ui/sheet';
import { usePhone } from '@/lib/media';
import type { RunSetupMode } from './model/modes';

export interface LaunchSubmit {
  label: string;
  busy: boolean;
  disabled: boolean;
  /** Why it is held — the button's title, and the footer's line. */
  title?: string;
  onSubmit: () => void;
  /** The quiet line beside the buttons. */
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
  /** The departure notice — a wider dialog on a desk. */
  staged: boolean;
  /** When this changes the body opens at its top. */
  scrollKey?: string;
  /** Above the form: claims, verdicts, the no-run banner. */
  banners?: ReactNode;
  submit: LaunchSubmit;
  children: ReactNode;
}) {
  const phone = usePhone();
  const bodyRef = useRef<HTMLDivElement>(null);

  // `scrollTop`, never `scrollIntoView` — the shell owns scrolling (design.md
  // §10) — and instant, because a property write ignores `scroll-behavior`.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [scrollKey]);

  const Icon = mode === 'qa' ? ShieldCheck : mode === 'session' ? Play : Bot;
  const footer = (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-2">
      {submit.note != null && submit.note !== '' && (
        <div
          data-testid="launch-note"
          className="min-w-0 flex-1 basis-full text-meta text-ink-muted sm:basis-auto"
        >
          {submit.note}
        </div>
      )}
      <div className="ms-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          variant="primary"
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
      <SheetContent side="full" title={title} description={description} footer={footer} bodyRef={bodyRef}>
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
        className={staged ? 'w-[min(52rem,calc(100%-2rem))]' : undefined}
      >
        {banners}
        {children}
      </DialogContent>
    </Dialog>
  );
}
