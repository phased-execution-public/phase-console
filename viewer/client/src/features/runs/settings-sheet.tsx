/**
 * The launch flow behind one button — every field a run accepts, and what
 * the board says about the plan, in four stages.
 *
 * ## Why an overlay and not the card it replaces
 *
 * The run page used to carry the whole settings form open, all the time, above
 * the thing you came to read. On a phone that is a screenful of controls
 * between the status line and the console, and the controls are the part you
 * touch once a run rather than once a minute. So the fields moved behind
 * `Settings`, and what stayed on the page is the status strip's verbs — the
 * ones that ARE pressed while watching.
 *
 * Since Phase 8 the overlay is `RunSetup`'s own (`launch-shell.tsx`): a
 * full-screen sheet on a phone with the stage bar and the buttons fixed, a
 * two-pane dialog on a desk with the live summary beside the stages. This file
 * keeps only what is the run page's: which mode the button opens, the words at
 * the top, and the button itself.
 *
 * ## The mode is the contract
 *
 * `RunSetup` mode `live` is a settings PATCH, not a launch. It shows only the
 * fields `/api/run/:slug/settings` accepts — no `resumeRunId`, no `qa`, no
 * `accountId` (that one is its own verb, because moving a live run's account is
 * a different act from editing its budget) — and `modes.ts` `buildRunPayload`
 * reads only the fields the mode shows, so a value seeded but not rendered
 * cannot leak into the body. Phase 6 pins both the field set and the payload.
 *
 * Everything it changes reaches the NEXT phase to board. The session already
 * running had its model and budget fixed in its own command line, and there is
 * no honest way to change those underneath it — so the sheet says so rather
 * than letting the operator infer it from a value that did not take.
 */

import { Slot } from '@radix-ui/react-slot';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui';
import type { PhaseView, PlanReviewer, RunState } from '@/lib/api';
import { RunSetup } from '@/features/run-setup/run-setup';

export function SettingsSheet({
  slug,
  run,
  live,
  allowRun,
  planPhases,
  planSkills,
  planMcp = [],
  planReviewers = [],
  qaMode,
  allowWrites,
  stillWorking = false,
  trigger,
}: {
  slug: string;
  run: RunState | null;
  /** A live run patches (`live`); a stopped one is continued (`continue`); none is started. */
  live: boolean;
  /**
   * A lane is still working although the run's STATUS says otherwise.
   *
   * `live` is `isLiveStatus(run.status)` — a word the run wrote about itself,
   * and a word a killed console leaves behind. This is the console's own
   * `RunDetail.liveness[]`, which exists only for a phase whose record is in
   * flight, so a non-empty one is a session that has not stopped. Continuing
   * over it is the double-spawn the server now refuses; refusing it here is
   * the same rule shown before the button is pressed rather than after.
   */
  stillWorking?: boolean;
  allowRun: boolean;
  planPhases: PhaseView[];
  planSkills: string[];
  planMcp?: string[];
  /** Where the plan orders its own reviewer — `RunSetup` advises from it. */
  planReviewers?: PlanReviewer[];
  qaMode?: string;
  allowWrites?: boolean;
  /** The control that opens it. Defaults to a plain `Settings` button. */
  trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const resumable = Boolean(run) && !live && !stillWorking && run?.status !== 'finished';
  const mode = live ? 'live' : resumable ? 'continue' : 'start';

  return (
    <>
      {/* `Slot` merges the opener onto whatever button the caller passed, so
          the run page keeps its own label and variant and this file owns the
          fact that pressing it opens the flow. */}
      <Slot onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open}>
        {trigger ?? (
          <Button size="sm" variant="ghost">
            Settings
          </Button>
        )}
      </Slot>
      {/* Mounted only while open, so every opening re-seeds from the run, the
          preferences and this browser's memory of the plan — a form left
          mounted would keep the touched values of a launch that already went. */}
      {open && (
        <RunSetup
          mode={mode}
          context={{ slug, run }}
          planPhases={planPhases}
          planSkills={planSkills}
          planMcp={planMcp}
          planReviewers={planReviewers}
          {...(qaMode !== undefined ? { qaMode } : {})}
          {...(allowWrites !== undefined ? { allowWrites } : {})}
          blocked={!allowRun || stillWorking}
          {...(!allowRun
            ? { blockedReason: 'Controls need --allow-run.' }
            : stillWorking
              ? {
                  blockedReason:
                    'Something is still running on this plan — a lane has a live session. ' +
                    'Stop it, or wait for it, before continuing the run.',
                }
              : {})}
          overlay={{
            open,
            onOpenChange: setOpen,
            title: live ? 'Run settings' : resumable ? 'Continue this run' : 'Start a run',
            description: live
              ? 'Applies from the next phase to board. The session running now was started with its model and budget fixed in its own command line.'
              : resumable
                ? 'Picks up from the board, not from a saved position.'
                : 'Fresh or half finished is the same button — the done-set decides where it begins.',
          }}
          // Closing on success is the point of a sheet: the form said what it
          // did with a toast, and leaving it open invites a second submit of
          // the same patch.
          onDone={() => setOpen(false)}
        />
      )}
    </>
  );
}

export default SettingsSheet;
