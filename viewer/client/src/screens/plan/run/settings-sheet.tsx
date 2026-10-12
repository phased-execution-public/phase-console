/**
 * The run's whole-run verbs, and the door to its settings (7.0, quiet-console
 * phase 11; the 6.2 controls card and settings sheet,
 * `features/runs/lane-setup.tsx` and `features/runs/settings-sheet.tsx`).
 *
 * ONE row of what is pressed while watching: the settings opener, then — while
 * the run is live — its two pauses and Stop, then one cloud review of the
 * branch. Two pauses, named apart for what they do to the work in flight:
 * *Pause after this phase* lets the phase finish and be verified, *Freeze now*
 * stops every session where it stands, holding its context. Calling both
 * "Pause" is how an operator presses the wrong one while watching a phase do
 * the wrong thing. Stop asks first, and says what stopping costs before the
 * choice. Every verb goes through the one lifecycle door (`useLifecycle`), so
 * one busy word, one toast and one invalidation set.
 *
 * The opener is enabled without `--allow-run`: the sheet opens and says what
 * this console cannot do, which a greyed button never could. It opens while a
 * lane is still working too — as a settings PATCH (`mode="live"`), the wedged
 * run being the one where a budget most needs lowering — and never as a
 * Continue over a session that has not stopped, which would put a second agent
 * on one working tree. The form is mounted only while open, so every opening
 * seeds from the run as it is now.
 *
 * `useRunPatch` is the two one-tap patches the run's notes offer — a scope
 * cleared, the guard rails back up — written field by field, because a
 * settings patch outside the one form is a verb, never a second form
 * (`screens/launch/single-source.test.ts` reads both payloads).
 */

import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  LIVE_LANE_LOCKED_FIELDS,
  SETTING_EFFECTS,
  SETTING_EFFECT_LABELS,
  SETTING_VERBS,
} from '@shared/run-settings.js';
import type { PhaseView, PlanReviewer } from '@/data/api/plans';
import { runsApi, type RunState } from '@/data/api/runs';
import { keys } from '@/data/keys';
import { lanesOf } from '@/data/lanes';
import { useLifecycle } from '@/data/lifecycle';
import { press } from '@/data/press';
import { plural } from '@/lib/format';
import { settingsHref } from '@/shell/routes';
import { Button, Mono, toast } from '@/ui';
import { ConfirmButton } from '@/ui/confirm';
import { LaunchForm } from '@/screens/launch/door';
import { RunAccountRow } from '@/screens/settings/account-row';

/** A refusal in the server's own words — the honest floor when it said nothing. */
const words = (cause: unknown): string =>
  cause instanceof Error && cause.message ? cause.message : 'The press failed and said nothing.';

/* ------------------------------------------------------------------ *
 * The two one-tap patches
 * ------------------------------------------------------------------ */

type RunPatchBusy = 'scope' | 'profile' | null;

/**
 * Clear a run's phase scope, or put a loosened run back on Guarded — each one
 * field, pressed through the owner door, toasted, and followed by the re-read
 * every run act shares (`keys.afterRunAct`).
 */
export function useRunPatch(slug: string): { clearScope: () => void; guard: () => void; busy: RunPatchBusy } {
  const client = useQueryClient();
  const [busy, setBusy] = useState<RunPatchBusy>(null);
  const patch = useCallback(
    (what: 'scope' | 'profile', call: () => Promise<unknown>, said: string) => {
      setBusy(what);
      press(call)
        .then((pressed) => (pressed.state === 'asked' ? toast(pressed.words, 'info') : toast(said, 'ok')))
        .catch((cause: unknown) => toast(words(cause), 'error'))
        .finally(() => {
          setBusy(null);
          for (const key of keys.afterRunAct(slug)) void client.invalidateQueries({ queryKey: key });
        });
    },
    [client, slug],
  );
  const clearScope = useCallback(
    () =>
      patch(
        'scope',
        () => runsApi.runSettings(slug, { onlyPhases: [] }),
        'Scope cleared — this run continues through the whole plan',
      ),
    [patch, slug],
  );
  const guard = useCallback(
    () =>
      patch(
        'profile',
        () => runsApi.runSettings(slug, { permissionProfile: 'guarded' }),
        'Back to Guarded — the next call that matters raises a card',
      ),
    [patch, slug],
  );
  return { clearScope, guard, busy };
}

/* ------------------------------------------------------------------ *
 * What a patch does, and when
 * ------------------------------------------------------------------ */

/**
 * The settings a person reaches for mid-run, in their words. Which of the two
 * sentences each lands in is never decided here: it is read off
 * `SETTING_EFFECTS`, so the note follows the table the runner reads.
 */
const FIELD_WORDS: Readonly<Record<string, string>> = {
  maxParallel: 'the lane cap',
  autonomy: 'autonomy',
  runBudgetUsd: 'the run’s budget',
  maxConsecutiveFailures: 'the failure ceiling',
  permissionProfile: 'the permission profile',
  model: 'model',
  effort: 'effort',
  phaseBudgetUsd: 'the phase budget',
  skills: 'skills',
  mcpServers: 'servers',
  gitMode: 'the branch strategy',
  isolation: 'the checkout',
};

/** Every settings field that lands at one effect word, in the table's order. */
function landingAt(word: 'now' | 'next-phase'): string[] {
  return Object.keys(SETTING_EFFECTS).filter((field) => SETTING_EFFECTS[field] === word);
}

/** "Takes effect now: the lane cap, …, and 10 other settings." — the whole list on hover. */
function Landing({ word }: { word: 'now' | 'next-phase' }) {
  const fields = landingAt(word);
  const named = fields.flatMap((field) => (FIELD_WORDS[field] ? [FIELD_WORDS[field]] : []));
  const others = fields.length - named.length;
  return (
    <span data-effect-group={word} title={fields.join(', ')}>
      {SETTING_EFFECT_LABELS[word]}: {named.join(', ')}
      {others > 0 ? `, and ${plural(others, 'other setting')}` : ''}.
      {word === 'next-phase' ? ' The session running now keeps what it started with.' : ''}
    </span>
  );
}

/**
 * The per-field truth of a live patch: what lands now and what from the next
 * phase, in `SETTING_EFFECT_LABELS`' words; the fields a working lane holds;
 * and the one choice the sheet does not carry — who pays — with where it moves.
 * Inline only: it is the dialog's description, a paragraph.
 */
export function RunSettingsNote({ stillWorking }: { stillWorking: boolean }) {
  const held = LIVE_LANE_LOCKED_FIELDS.map((field) => FIELD_WORDS[field] ?? field);
  return (
    <span className="flex flex-col gap-1" data-testid="run-settings-note">
      <Landing word="now" />
      <Landing word="next-phase" />
      {stillWorking && (
        <span>
          A lane is still working, so what it stands on — {held.join(' and ')} — is refused by name, and
          everything else is applied.
        </span>
      )}
      <span>
        Who pays is moved by <Mono value={SETTING_VERBS.accountId} /> on the account row, which checkpoints
        the live sessions first. Repair or add a login in{' '}
        <a href={settingsHref('accounts')} className="text-ink underline underline-offset-2">
          Settings ▸ Accounts
        </a>
        .
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * One cloud review of the branch
 * ------------------------------------------------------------------ */

type ReviewAnswer = Awaited<ReturnType<typeof runsApi.runUltraReview>>;

/** The review's own result — one that could not happen says why, never "nothing found". */
function reviewAnswerText(answer: ReviewAnswer): string {
  if (answer.state !== 'landed')
    return `The review could not run: ${answer.reason ?? 'no reason was given'}.`;
  return `Reviewed phase ${answer.phase}: ${answer.verdict ?? 'done'}, ${plural(answer.findings ?? 0, 'finding')}.`;
}

/** Billed work on the operator's own account, so the press asks first and does exactly one review. */
function ReviewBranch({ slug, disabled }: { slug: string; disabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  return (
    <>
      <ConfirmButton
        variant="ghost"
        title="Review this run’s branch now?"
        description="One cloud review of the branch as it stands, billed to your own account. It changes nothing on the branch."
        confirmLabel="Review the branch now"
        busy={busy}
        disabled={disabled}
        onConfirm={() => {
          setBusy(true);
          setSaid(null);
          press(() => runsApi.runUltraReview(slug))
            .then((pressed) =>
              setSaid(pressed.state === 'asked' ? pressed.words : reviewAnswerText(pressed.result)),
            )
            .catch((cause: unknown) => setSaid(`The review could not run: ${words(cause)}`))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? 'Reviewing…' : 'Review the branch now'}
      </ConfirmButton>
      {said && (
        <span className="text-meta text-ink-muted" data-testid="review-now-answer" role="status">
          {said}
        </span>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * The row
 * ------------------------------------------------------------------ */

export interface RunVerbsProps {
  slug: string;
  run: RunState | null;
  /** `isLiveStatus(run.status)` — the run's own word about itself. */
  live: boolean;
  /**
   * A lane still has a session although the run's status says it stopped —
   * the console's own liveness, which a killed console's leftover word cannot
   * fake. Continuing over it is the double spawn the server refuses; the row
   * refuses it first.
   */
  stillWorking: boolean;
  allowRun: boolean;
  /** Whether the console may write — the sheet's QA toggle asks it. */
  allowWrites: boolean;
  planPhases: PhaseView[];
  planSkills: string[];
  planMcp?: string[];
  planReviewers?: PlanReviewer[];
  qaMode?: string;
}

const PATCH_WORDS =
  'Each setting lands when its kind does: the lane cap and budgets at the next decision, model and skills from the next phase to board.';
const CHECKPOINT_WORDS =
  'Picks up the checkpointed session with --resume, rather than starting the phase over.';
const BOARD_WORDS = 'Picks up from the board, not from a saved position.';
const FRESH_WORDS = 'Fresh or half finished is the same button: the done-set decides where it begins.';

export function RunVerbs({
  slug,
  run,
  live,
  stillWorking,
  allowRun,
  allowWrites,
  planPhases,
  planSkills,
  planMcp = [],
  planReviewers = [],
  qaMode,
}: RunVerbsProps) {
  const lifecycle = useLifecycle(slug);
  const [open, setOpen] = useState(false);
  const resumable = Boolean(run) && !live && !stillWorking && run?.status !== 'finished';
  // A lane still working is a run to PATCH, never one to continue over.
  const patching = live || (stillWorking && Boolean(run));
  const mode = patching ? 'live' : resumable ? 'continue' : 'start';
  // A lane in flight holds its checkout and branch: the sheet names those
  // fields refused beside their controls, before the press.
  const laneWorking = stillWorking || lanesOf(run ? [run] : []).some((lane) => lane.status !== 'queued');
  const disabled = !allowRun || lifecycle.busy != null;
  const pausing = run?.status === 'pausing';
  const stopping = run?.status === 'stopping';
  // A draining halt: sessions are still live (Stop applies), but a pause or a
  // freeze aimed at "the current phase" is aimed at a run that already stopped
  // admitting — the server refuses both, so the buttons say so up front.
  const halting = run?.status === 'halting';
  // A single frozen lane of several leaves the run `running` with the freeze
  // recorded on the run — either way the row offers the Continue.
  const frozen = run?.status === 'frozen' || Boolean(run?.freeze);
  const checkpointed = Object.values(run?.phases ?? {}).some((record) => record?.resumeSessionId);
  const said = patching
    ? PATCH_WORDS
    : resumable
      ? checkpointed
        ? CHECKPOINT_WORDS
        : BOARD_WORDS
      : FRESH_WORDS;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="run-verbs">
        <Button
          variant={patching ? 'ghost' : 'default'}
          aria-haspopup="dialog"
          aria-expanded={open}
          title={said}
          onClick={() => setOpen(true)}
        >
          {live || stillWorking ? 'Settings' : resumable ? 'Continue this run' : 'Start a run'}
        </Button>

        {live && (
          <>
            {pausing ? (
              <Button disabled={disabled} onClick={() => void lifecycle.act('resume')}>
                {lifecycle.busy === 'resume' ? 'Cancelling…' : 'Cancel pause — keep going'}
              </Button>
            ) : (
              <Button
                disabled={disabled || stopping || halting}
                title="The phase finishes and is verified, then the run stops"
                onClick={() => void lifecycle.act('pause')}
              >
                {lifecycle.busy === 'pause' ? 'Arming…' : 'Pause after this phase'}
              </Button>
            )}
            {frozen ? (
              <Button disabled={disabled} onClick={() => void lifecycle.act('thaw')}>
                {lifecycle.busy === 'thaw' ? 'Continuing…' : 'Continue the frozen session'}
              </Button>
            ) : (
              <Button
                disabled={disabled || stopping || halting || run?.activePhase == null}
                title="Stops every running session where it stands, losing nothing; a lane’s own row freezes that lane alone"
                onClick={() => void lifecycle.act('freeze')}
              >
                {lifecycle.busy === 'freeze' ? 'Freezing…' : 'Freeze now'}
              </Button>
            )}
            <ConfirmButton
              variant="danger"
              destructive
              disabled={disabled}
              title="Stop the run now?"
              description="Its sessions get SIGTERM, so their own end-of-session hooks still run, and anything already written to the repository stays written: stopping does not undo work."
              details={
                <p className="max-w-prose text-meta text-ink-muted">
                  The phase is recorded as interrupted, not failed: a phase cut off partway may have
                  half-finished something, so continuing later asks you about it instead of running it again.
                </p>
              }
              confirmLabel="Stop now"
              cancelLabel="Keep running"
              onConfirm={() => void lifecycle.act('stop')}
            >
              {lifecycle.busy === 'stop' ? 'Stopping…' : 'Stop now'}
            </ConfirmButton>
          </>
        )}

        {run && <ReviewBranch slug={slug} disabled={!allowRun} />}
      </div>

      {stillWorking && (
        <p className="max-w-prose text-meta text-ink-muted">
          The run has stopped but a session has not. Stop it or wait for it: continuing now would put a second
          agent on the same working tree.
        </p>
      )}
      {!allowRun && (
        <p className="text-meta text-ink-muted">
          Controls need <Mono value="--allow-run" />.
        </p>
      )}

      <RunAccountRow slug={slug} run={run} disabled={disabled} />

      {open && (
        <LaunchForm
          mode={mode}
          context={{ slug, run }}
          planPhases={planPhases}
          planSkills={planSkills}
          planMcp={planMcp}
          planReviewers={planReviewers}
          {...(qaMode !== undefined ? { qaMode } : {})}
          allowWrites={allowWrites}
          blocked={!allowRun}
          laneWorking={patching && laneWorking}
          {...(!allowRun ? { blockedReason: 'Controls need --allow-run.' } : {})}
          overlay={{
            open,
            onOpenChange: setOpen,
            title: patching ? 'Run settings' : resumable ? 'Continue this run' : 'Start a run',
            description: patching ? <RunSettingsNote stillWorking={!live && stillWorking} /> : said,
          }}
          // Closing on success is the point of a sheet: the form said what it
          // did with a toast, and leaving it open invites a second submit.
          onDone={() => setOpen(false)}
        />
      )}
    </div>
  );
}
