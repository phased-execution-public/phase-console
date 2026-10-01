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
 * Not everything it changes waits for the next phase (control-tower phase 13,
 * #31): the session already running had its model and budget fixed in its own
 * command line, but the lane cap, the budgets the loop checks, the failure
 * ceiling and the permission profile are read at the loop's next decision —
 * `SETTING_EFFECTS` says which, per field, and the sheet says so rather than
 * one sentence that was untrue of half the form.
 *
 * It opens while a lane is still working — the wedged run is the one where a
 * budget most needs lowering — as a PATCH: the server refuses by name the
 * fields a live lane holds and applies the rest. Each field says, beside its
 * control, when a change to it lands (`SETTING_EFFECTS`), and the fields a
 * working lane holds say they are refused before the press (phase 24). And it names the one choice
 * it does not carry, who pays, with a link to where that is moved.
 */

import { Slot } from '@radix-ui/react-slot';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui';
import type { PhaseView, PlanReviewer, RunState } from '@/lib/api';
import { RunSetup } from '@/features/run-setup/run-setup';
import { SETTING_EFFECT_LABELS, SETTING_VERBS } from '@shared/run-settings.js';
import { lanesOf } from './session-panes';

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
  // A lane still working is a run to PATCH, never one to continue over.
  const patching = live || (stillWorking && Boolean(run));
  const mode = patching ? 'live' : resumable ? 'continue' : 'start';
  // A lane in flight holds its checkout and branch: the sheet names those
  // fields refused beside their controls (control-tower phase 24, #31).
  const laneWorking = stillWorking || lanesOf(run).some((lane) => !lane.queued);

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
          blocked={!allowRun}
          laneWorking={patching && laneWorking}
          {...(!allowRun ? { blockedReason: 'Controls need --allow-run.' } : {})}
          overlay={{
            open,
            onOpenChange: setOpen,
            title: patching ? 'Run settings' : resumable ? 'Continue this run' : 'Start a run',
            description: patching ? (
              <SettingsNote stillWorking={!live && stillWorking} />
            ) : resumable ? (
              'Picks up from the board, not from a saved position.'
            ) : (
              'Fresh or half finished is the same button — the done-set decides where it begins.'
            ),
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

/**
 * What a patch does and when (control-tower phase 13, #31) — in the words of
 * `SETTING_EFFECT_LABELS`, grouped the way `SETTING_EFFECTS` groups the form —
 * and the one choice the sheet does not carry, linked to where it moves.
 */
export function SettingsNote({ stillWorking }: { stillWorking: boolean }) {
  return (
    <span className="flex flex-col gap-1">
      <span>
        {SETTING_EFFECT_LABELS.now}: the lane cap, the run's budget, the failure ceiling, autonomy and the
        permission profile. {SETTING_EFFECT_LABELS['next-phase']}: model, effort, skills, servers and the
        phase budget — the session running now keeps what it started with.
      </span>
      {stillWorking ? (
        <span>
          A lane is still working, so what it stands on — the branch strategy and the checkout — is refused by
          name, and everything else is applied.
        </span>
      ) : null}
      <span>
        Who pays is moved by <em>{SETTING_VERBS.accountId}</em> on the run card, which checkpoints the live
        sessions first —{' '}
        <a href="#/settings/accounts" className="underline hover:text-action">
          repair or add a login in Settings ▸ Accounts
        </a>
        .
      </span>
    </span>
  );
}

export default SettingsSheet;
