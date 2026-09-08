/**
 * The overlay around a launch — the frame every RunSetup in a dialog wears.
 *
 * Two layouts, one contract. A PHONE (below the shell breakpoint) gets a
 * full-screen sheet: the title, the stage bar and the buttons are fixed, only
 * the stage scrolls, and the sheet is exactly `--app-height` tall so the
 * footer sits on the keyboard's upper edge while a field is being typed in.
 * A DESK gets a dialog with two panes: the stages on the left, the live ticket
 * on the right — the summary stays in sight while a value is changed, which is
 * what the second pane is for. On the Review stage the panes merge, because
 * the review IS the summary and a copy beside it would say the same thing.
 *
 * The one amber button is Launch. On a desk it is on every stage, because the
 * ticket beside it has already said what will happen; on a phone it is on the
 * Review stage only, one tap away on the bar — the operator has to have seen
 * the summary once, and the phone has no room to show it beside a stage.
 *
 * A flat mode (a QA review, a recovery) wears the same frame without a stage
 * bar or a ticket: fixed title, scrolling form, fixed buttons — which is what
 * fixes the launch dialog's off-screen Start button (register row 441).
 */

import { Bot, Play, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { Button, Dialog, DialogContent, Sheet, SheetContent, Stepper, Tabs } from '@/components/ui';
import { usePhone } from '@/lib/media';
import type { RunSetupMode } from './modes';
import { STAGES, type StageId } from './stages';

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
  stage,
  onStage,
  visited,
  notes,
  banners,
  ticket,
  submit,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  mode: RunSetupMode;
  staged: boolean;
  stage: StageId;
  onStage: (stage: StageId) => void;
  visited: ReadonlySet<StageId>;
  /** One line per stage under its name on the desk — "2 changed". */
  notes: Partial<Record<StageId, string>>;
  /** Above the stage, on every stage: claims, verdicts, the no-run banner. */
  banners?: ReactNode;
  /** The desk's right pane. */
  ticket?: ReactNode;
  submit: LaunchSubmit;
  children: ReactNode;
}) {
  const phone = usePhone();
  const bodyRef = useRef<HTMLDivElement>(null);

  // A new stage opens at its top. `scrollTop`, never `scrollIntoView` — the
  // shell contract (`docs/design.md` §10) — and instant, because the
  // stylesheet's `scroll-behavior: smooth` does not apply to a property write.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [stage]);

  const index = STAGES.findIndex((s) => s.id === stage);
  const first = index <= 0;
  const last = index === STAGES.length - 1;
  const paned = staged && stage !== 'review' && ticket != null && !phone;

  const stepper = staged ? (
    <Stepper
      label="Launch stages"
      steps={STAGES.map((s) => ({ id: s.id, label: s.label, short: s.short, note: notes[s.id] }))}
      visited={visited}
      onSelect={(id) => onStage(id as StageId)}
      className={phone ? '-mx-1' : undefined}
    />
  ) : undefined;

  const Icon = mode === 'qa' ? ShieldCheck : mode === 'session' ? Play : Bot;
  const launch = (
    <Button variant="action" disabled={submit.disabled} title={submit.title} onClick={submit.onSubmit}>
      <Icon size={15} aria-hidden /> {submit.busy ? 'Starting…' : submit.label}
    </Button>
  );
  const footer = (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
      <span className="min-w-0 flex-1 basis-full text-2xs text-ink-muted sm:basis-auto">{submit.note}</span>
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        {staged && !first && (
          <Button variant="ghost" onClick={() => onStage(STAGES[index - 1]!.id)}>
            Back
          </Button>
        )}
        {staged && !last && (
          <Button onClick={() => onStage(STAGES[index + 1]!.id)}>
            {phone ? 'Next' : `Next: ${STAGES[index + 1]!.label}`}
          </Button>
        )}
        {(!staged || last || !phone) && launch}
      </div>
    </div>
  );

  const content = phone ? (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="full"
        title={title}
        description={description}
        subheader={stepper}
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
        subheader={stepper}
        footer={footer}
        bodyRef={paned ? undefined : bodyRef}
        className={staged ? 'w-[min(64rem,calc(100%-2rem))]' : undefined}
        bodyClassName={
          paned
            ? 'grid grid-cols-[minmax(0,1fr)_18rem] grid-rows-[minmax(0,1fr)] overflow-hidden p-0'
            : undefined
        }
      >
        {paned ? (
          <>
            <div ref={bodyRef} className="min-h-0 overflow-y-auto overscroll-contain p-4">
              {banners}
              {children}
            </div>
            <aside
              aria-label="Launch summary"
              className="min-h-0 overflow-y-auto overscroll-contain border-l border-rule bg-ground p-4"
            >
              {ticket}
            </aside>
          </>
        ) : (
          <>
            {banners}
            {children}
          </>
        )}
      </DialogContent>
    </Dialog>
  );

  // The Tabs root has to hold BOTH the stage bar (in the frame's subheader) and
  // the stage panels (in its body); it is a context, so it wraps the overlay
  // and its portal alike. `contents` so the root's own div lays out nothing.
  return staged ? (
    <Tabs value={stage} onValueChange={(next) => onStage(next as StageId)} className="contents">
      {content}
    </Tabs>
  ) : (
    content
  );
}
