/**
 * A human step's command, in the embedded terminal (control-tower phase 42).
 *
 * `POST /api/human-steps/:id/open` mints a shell on the machine that PRINTS
 * the step's command and runs it only on the person's Enter — the command is
 * prefilled, never run behind anybody's back, and its exit is the step's
 * proof. This sheet is where that shell is drawn: the command in words above
 * it (copyable, for a terminal of one's own), and the terminal itself through
 * the sessions pane's own dynamic import (`screens/sessions/pane.tsx`) — the
 * same one the session page makes, so the emulator stays in exactly one lazy
 * chunk (`check-dist`) and a page that never opens a step's command never
 * downloads it.
 */

import { Suspense, lazy } from 'react';
import type { StepTerminalTicket } from '@/data/human-steps';
import { Spinner } from '@/ui';
import { CodeBlock } from '@/ui/code-block';
import { Sheet, SheetContent } from '@/ui/sheet';

/** The emulator, behind the one dynamic import of the sessions pane. */
const TerminalPane = lazy(() => import('@/screens/sessions/pane'));

export interface StepTerminalSheetProps {
  /** The shell the open verb minted — null while nothing is open. */
  ticket: StepTerminalTicket | null;
  /** The step's command, drawn in words above the terminal. */
  command: string;
  /** The step's own words, for the sheet's title. */
  title: string;
  onClose: () => void;
}

export function StepTerminalSheet({ ticket, command, title, onClose }: StepTerminalSheetProps) {
  return (
    <Sheet open={ticket !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent
        side="bottom"
        title={`Your turn — ${title}`}
        showTitle
        description="The command is printed first and runs when you press Enter. Its exit proves the step."
        bodyClassName="flex min-h-0 flex-col gap-2 px-3 pb-3"
      >
        <div data-testid="step-terminal" className="flex min-w-0 flex-col gap-2">
          <CodeBlock
            code={command}
            testId="step-terminal-command"
            copyLabel="Copy command"
            claudeCode={false}
          />
          <div className="h-[min(22rem,calc(var(--app-height,100%)*0.55))] min-h-48 overflow-hidden rounded bg-ground-deep">
            {ticket && (
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center gap-2 text-meta text-ink-muted">
                    <Spinner /> Opening the terminal…
                  </div>
                }
              >
                <TerminalPane sessionId={ticket.sessionId} onEnded={onClose} />
              </Suspense>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
