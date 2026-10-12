/**
 * Everything the run needs to tell a person, in one ordered place (7.0,
 * quiet-console phase 11; the 6.2 status strip's notes,
 * `features/runs/status-strip.tsx`).
 *
 * A notice is data: each condition the run is in lights ONE note, and the
 * notes stand in a single declared order — worst first, by how much each
 * needs a person (`RUN_NOTE_ORDER`) — never in the order code happened to add
 * them. The stop is the halt card itself (`cards/halt-card.tsx`), the one
 * rendering of why a run stopped; every other note is a quiet `Banner`: a
 * short title, then only the sentence a person needs to act, with the longer
 * reading one hover away. Scope, profile and read-only are standing facts
 * about how the run was configured — worth knowing, never urgent — so they
 * close the list.
 *
 * Beside the notes, each its own piece for the view to place: the budgets
 * nearing their end with their raise, the run's asks drawn as their Your turn
 * items, the card for an expired login, and the note a console shows when its
 * server predates the autopilot.
 */

import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { budgetHeadline, type BudgetFact } from '@shared/budget-model.js';
import { heldStopReason } from '@shared/orchestration-model.js';
import { SETTLED, SETTLED_WELL, runEndedBadly } from '@shared/run-lifecycle.js';
import { PROFILE_LABELS } from '@shared/run-settings.js';
import { waitSentence } from '@shared/status-model.js';
import { runStatusWord, waitReasonOf } from '@shared/status-vocab.js';
import { ErrandCard } from '@/cards/errand';
import { BudgetRaise, HaltCard } from '@/cards/halt-card';
import { useInboxActions } from '@/cards/inbox-row';
import { LazyItemRow } from '@/cards/lazy-item-row';
import { accountsApi, type AccountView } from '@/data/api/accounts';
import { runsApi, type RunGitView, type RunState } from '@/data/api/runs';
import { systemApi, type AuthStatus } from '@/data/api/system';
import { useAttentionInbox } from '@/data/inbox';
import { keys } from '@/data/keys';
import { press } from '@/data/press';
import { approvalRows } from '@/data/turn';
import { money, plural } from '@/lib/format';
import { errandsOf, situationLabelFor } from '@/lib/ladder';
import { askToNotify, notifyState, type NotifyState } from '@/lib/notify';
import type { FleetHoldView } from '@/screens/runs/model';
import { settingsHref } from '@/shell/routes';
import { Banner, Button, Mono, RelativeTime, SectionHeading, toast, type Severity } from '@/ui';
import { ACCOUNT_RECOVERY_PARTS } from '@/screens/settings/account-row';
import { RUN_FOLD_WORDS } from './sections';
import { useRunPatch } from './settings-sheet';

/** A refusal in the server's own words — the honest floor when it said nothing. */
const words = (cause: unknown): string =>
  cause instanceof Error && cause.message ? cause.message : 'The press failed and said nothing.';

/** A wall clock, as a person reads it: the clocks here are deadlines, mostly ahead. */
function When({ at }: { at: string | number }) {
  const date = new Date(at);
  return (
    <time dateTime={date.toISOString()} className="tnum">
      {date.toLocaleString()}
    </time>
  );
}

/* ------------------------------------------------------------------ *
 * The notes
 * ------------------------------------------------------------------ */

/** The declared order. Index in this array IS the priority. */
export const RUN_NOTE_ORDER = [
  'halt',
  'ended',
  'pause',
  'frozen',
  // Two live branches would not merge. Advisory: nothing has failed, nothing
  // has stopped, and the run carries on — which is why it sits here and not
  // lower. A conflict is cheapest to undo while both lanes are still working.
  // It never wears `error`: the radar predicts a merge that has not happened,
  // and a healthy run's page must not turn red on one.
  'conflict',
  // The run stopped ON a clock and waits for a person — worse than
  // `waiting-window`, which resumes itself. The slot is about who must act;
  // `waitReasonOf` says which wait it is, and the two are independent.
  'limit-paused',
  'waiting-window',
  'budget',
  'scoped',
  'profile',
  'read-only',
] as const;

export type RunNoteId = (typeof RUN_NOTE_ORDER)[number];

/** One quiet note: a short title, the sentence to act on, the longer reading on hover. */
interface NoteSpec {
  id: Exclude<RunNoteId, 'halt'>;
  severity: Severity;
  head?: string | undefined;
  body?: ReactNode;
  hint?: string | undefined;
  action?: ReactNode;
}

function NoteBanner({ spec }: { spec: NoteSpec }) {
  return (
    <Banner data-note={spec.id} severity={spec.severity} title={spec.hint} action={spec.action}>
      <div className="flex min-w-0 flex-col gap-1">
        {spec.head && <p className="font-medium text-ink">{spec.head}</p>}
        {spec.body != null && <div className="min-w-0 break-words text-ink-muted">{spec.body}</div>}
      </div>
    </Banner>
  );
}

/** The resource ladder's one budget raise, in a sentence — or nothing. */
function budgetRaiseText(run: RunState): string | undefined {
  const raise = run.budgetRaise;
  if (!raise) return undefined;
  return `The autopilot already raised the run budget once, from ${money(raise.from)} to ${money(raise.to)} (+${raise.pct}%).`;
}

/**
 * The two ways on from an identity park (control-tower phase 91, #131): the
 * run's account now answers somebody else's login, and whether to spend it is
 * a person's call — continue on the new login, or move back to a profile of
 * the person the run started on. Each press resumes the run; a refusal (no
 * such profile, a hold) comes back in the server's own words.
 */
function IdentityChoice({ run, allowRun }: { run: RunState; allowRun: boolean }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const who = run.identity?.email ?? run.identity?.org ?? 'the login it started on';
  const answer = (choice: 'continue' | 'move') => {
    setBusy(true);
    press(() => runsApi.runIdentity(run.slug, choice))
      .then((pressed) =>
        pressed.state === 'asked'
          ? toast(pressed.words, 'info')
          : toast(
              choice === 'continue' ? 'Continuing on the new login.' : `Moved to ${who}’s profile.`,
              'ok',
            ),
      )
      .catch((cause: unknown) => toast(words(cause), 'error'))
      .finally(() => {
        setBusy(false);
        for (const key of keys.afterRunAct(run.slug)) void client.invalidateQueries({ queryKey: key });
      });
  };
  const why = allowRun ? undefined : 'Answering it resumes the run, which needs --allow-run';
  return (
    <div className="flex min-w-0 flex-wrap gap-2" data-testid="identity-choice">
      <Button size="sm" disabled={busy || !allowRun} title={why} onClick={() => answer('continue')}>
        Continue on the new login
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-auto shrink whitespace-normal"
        disabled={busy || !allowRun}
        title={why}
        onClick={() => answer('move')}
      >
        Move to {who}’s profile
      </Button>
    </div>
  );
}

export interface RunNotesProps {
  slug: string;
  run: RunState | null;
  /** `isLiveStatus(run.status)`: a standing halt over a live run is history. */
  live: boolean;
  allowRun: boolean;
  /** The branch probe's cached view; absent is no conflict — an unprobed pair is not a clean one, nor a clash. */
  git?: RunGitView | null | undefined;
  /**
   * The hold binding this console now (`bindingHoldOf`). A stopped run's
   * stored "it continues by itself" is read through it, so a freeze that
   * survived a restart is named — who, when, and how it ends.
   */
  fleetHold?: FleetHoldView | null | undefined;
  /** The auth override — every other reading of an auth halt is wrong. */
  authFailure: boolean;
  /** What the halt card's recovery verbs are about. */
  target: { slug: string; phase?: number; runId?: string };
}

/** Every quiet note the run raises — everything but the halt, which is its card. */
function noteSpecs(
  { run, live, allowRun, git, fleetHold }: Omit<RunNotesProps, 'slug' | 'authFailure' | 'target'>,
  patch: ReturnType<typeof useRunPatch>,
): NoteSpec[] {
  const notes: NoteSpec[] = [];

  // Why the loop stopped, for every ending that is not a halt. A run scoped to
  // one phase that stops after it is the most-reported "it doesn't advance".
  // Parked means every remaining move is a person's, so it is named so.
  if (run && !live && !run.halt && run.finishedReason) {
    const finished = run.status === 'finished';
    const parked = run.status === 'parked';
    // A RESOLVED stop is settled — the board moved past it or a person
    // dismissed it — and must never wear the alarm of the halt it no longer has.
    const resolved = Boolean(run.resolved) && !finished;
    const errands = resolved || finished ? [] : errandsOf(run);
    const raised = budgetRaiseText(run);
    // A promise the hold has made false reads as the hold, and it is a
    // person's to end — so it wears a caution, not the calm of a stop that
    // heals itself.
    const reason = heldStopReason(run.finishedReason, fleetHold);
    const held = reason !== run.finishedReason;
    notes.push({
      id: 'ended',
      severity: finished ? 'ok' : resolved ? 'info' : parked || held ? 'warn' : 'info',
      head: finished
        ? 'Run finished.'
        : resolved
          ? 'Stopped and resolved on its own.'
          : parked
            ? 'Parked until you act.'
            : 'Run stopped.',
      body: resolved ? (
        (run.resolved?.reason ?? reason)
      ) : (
        <div className="flex min-w-0 flex-col gap-1.5">
          <p>{reason}</p>
          {raised && <p className="text-meta">{raised}</p>}
          {errands.length > 0 && (
            <div className="mt-1 flex min-w-0 flex-col gap-1.5" data-testid="ended-errands">
              {errands.map((errand) => (
                <ErrandCard
                  key={`${errand.phase}-${errand.situation}-${errand.at}`}
                  errand={errand}
                  situationLabel={situationLabelFor(errand.situation)}
                  scope={{ slug: run.slug, runId: run.id }}
                />
              ))}
            </div>
          )}
        </div>
      ),
    });
  }

  if (run?.status === 'pausing') {
    notes.push({
      id: 'pause',
      severity: 'warn',
      head: 'Pause armed.',
      body: (
        <p>
          {run.pause?.afterPhase != null
            ? `Phase ${run.pause.afterPhase} finishes and is verified, then the run stops.`
            : 'The run stops at the next phase boundary.'}{' '}
          {run.pause?.requestedAt && (
            <span className="text-meta text-ink-faint">
              Asked <RelativeTime at={run.pause.requestedAt} />.{' '}
            </span>
          )}
          Stop now ends it sooner.
        </p>
      ),
      hint: 'Nothing is cut off: a pause waits for the phase to reach a boundary, so the work in flight is finished and checked rather than abandoned.',
    });
  } else if (run?.status === 'paused' && !run.waitUntil) {
    // A paused run CARRYING a reset time is the limit-paused slot below — one
    // note per condition, and that one says why it stopped.
    notes.push({
      id: 'pause',
      severity: 'info',
      head: 'Paused between phases.',
      body: 'Continue picks up from the board.',
      hint: 'Nothing has to be remembered about where it stopped.',
    });
  }

  if (run?.status === 'frozen') {
    notes.push({
      id: 'frozen',
      severity: 'warn',
      head: 'Frozen mid-phase.',
      body: (
        <p>
          {run.freeze?.phase != null ? `Phase ${run.freeze.phase} is` : 'The session is'} stopped where it
          stood, and Continue picks up mid-token.
          {run.freeze?.escalateAt && (
            <>
              {' '}
              Left frozen past <When at={run.freeze.escalateAt} /> it becomes a checkpoint: the session is
              asked to stop, and Continue resumes it rather than starting the phase over.
            </>
          )}
        </p>
      ),
      hint: 'The process is alive and holding its session; it is simply not being scheduled. A stopped process holds memory and a prompt cache that expires anyway, so an overnight freeze is not the cheap option it looks like.',
    });
  }

  // Two branches the console can see would not merge: a caution, never an
  // error — the merge has not happened, and serializing two lanes is cheap
  // NOW and expensive once one of them has landed.
  const conflicted = (git?.radar ?? []).filter((pair) => pair.state === 'conflicted');
  if (conflicted.length) {
    const files = [...new Set(conflicted.flatMap((pair) => pair.files))];
    notes.push({
      id: 'conflict',
      severity: 'warn',
      head: `${plural(conflicted.length, 'branch pair')} would not merge.`,
      body: (
        <div className="flex min-w-0 flex-col gap-1">
          <p className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
            {conflicted.slice(0, 3).map((pair) => (
              <span key={`${pair.a}~${pair.b}`} className="min-w-0 wrap-anywhere">
                <Mono value={pair.a} /> ↔ <Mono value={pair.b} />
              </span>
            ))}
            {conflicted.length > 3 && <span>and {conflicted.length - 3} more</span>}
          </p>
          {files.length > 0 && (
            <p className="min-w-0 wrap-anywhere text-meta">
              Over{' '}
              {files.slice(0, 5).map((file, index) => (
                <span key={file}>
                  {index > 0 && ', '}
                  <Mono value={file} />
                </span>
              ))}
              {files.length > 5 && `, and ${files.length - 5} more`}
            </p>
          )}
          <p className="text-meta">Nothing has failed yet; {RUN_FOLD_WORDS.git.name} has the whole radar.</p>
        </div>
      ),
      hint: 'This is a merge that has not happened yet: nothing has failed and nothing has stopped.',
    });
  }

  // Two different facts share `waitUntil`, and telling a person the wrong one
  // is worse than saying nothing: a phase parked on a CI run announced as a
  // usage limit sends them to switch accounts against a wall that is not there.
  const waitReason = run?.waitUntil ? waitReasonOf(run) : null;
  if (run?.waitUntil && waitReason === 'person') {
    // A wait on a PERSON — a verification check or an approval only they can
    // make — never on a clock or an account.
    notes.push({
      id: 'waiting-window',
      severity: 'warn',
      head: run.status === 'paused' ? 'Stopped while waiting for a person.' : undefined,
      body: (
        <p>
          Waiting until <When at={run.waitUntil} /> for a person to answer a card, a verification check or an
          approval only you can make. Answer it, or the phase parks for you when the card expires.
        </p>
      ),
      hint: 'Nothing is spent while it waits and no account is at its limit.',
    });
  } else if (run?.waitUntil && run.status === 'paused' && runStatusWord(run) === 'waiting') {
    // Nobody paused this run (control-tower phase 88, #148): a console restart
    // kept its clock, and the console re-arms it by itself. It reads as the
    // wait it is, in the sentence every surface uses — never "Stopped".
    notes.push({
      id: 'limit-paused',
      severity: 'info',
      head: `${waitSentence(run as Parameters<typeof waitSentence>[0]) ?? 'Waiting'}.`,
      body:
        waitReason === 'usage-limit' ? (
          <p>
            Nobody paused this run: it resumes by itself when the window reopens at{' '}
            <When at={run.waitUntil} />. Continue now under another account, or switch this run’s account.
          </p>
        ) : (
          <p>
            Nobody paused this run: it resumes by itself at <When at={run.waitUntil} />. Continue picks the
            phase’s own session back up now.
          </p>
        ),
      hint: 'Nothing is spent while it waits.',
    });
  } else if (run?.waitUntil && run.status === 'paused') {
    // Stopped ON the clock: the run's own policy said "pause and ask", or
    // someone stopped a run that was parked.
    const external = waitReason === 'external';
    notes.push({
      id: 'limit-paused',
      severity: 'warn',
      head: external
        ? 'Stopped while waiting on external work.'
        : `Stopped on a usage limit${run.accountId ? ` (${run.accountId})` : ''}.`,
      body: external ? (
        <p>
          A phase is parked on work outside its session, due back at <When at={run.waitUntil} />. Continue
          picks the phase’s own session back up, now or when the wait is over.
        </p>
      ) : (
        <p>
          The window reopens at <When at={run.waitUntil} />. Continue now under another account, switch this
          run’s account, or wait: the checkpointed session resumes either way.
        </p>
      ),
      hint: external
        ? 'Nothing is spent while it waits and no account is at its limit.'
        : 'The work already done is kept whichever way it resumes.',
    });
  } else if (run?.waitUntil) {
    notes.push({
      id: 'waiting-window',
      severity: 'warn',
      body:
        waitReason === 'external' ? (
          <p>
            Waiting on external work until <When at={run.waitUntil} />, a wait the phase declared itself. The
            run resumes by itself.
          </p>
        ) : (
          <p>
            Waiting for a usage window to reopen at <When at={run.waitUntil} />
            {run.onLimit === 'switch' ? ', with no other account left with headroom' : ''}. The run resumes by
            itself.
          </p>
        ),
      hint:
        waitReason === 'external'
          ? 'Nothing is wrong, and no account is at its limit.'
          : 'Nothing is wrong: the window reopens on its own clock.',
    });
  }

  // The account's own figure, reported by the session rather than estimated.
  if (run?.limits && run.limits.status !== 'allowed' && (run.limits.utilization ?? 0) >= 0.75) {
    const percent = Math.round((run.limits.utilization ?? 0) * 100);
    const window = (run.limits.window ?? 'usage').replace(/_/g, ' ');
    notes.push({
      id: 'budget',
      severity: 'warn',
      head: `${percent}% of ${run.accountId ? `${run.accountId}’s` : 'your'} ${window} window is used.`,
      body: (
        <p>
          {run.limits.resetsAt ? (
            <>
              It resets <When at={run.limits.resetsAt * 1000} />.{' '}
            </>
          ) : null}
          A long run started now may stop partway.
          {run.onLimit === 'switch'
            ? ' This run switches to the account with the most headroom when it hits the wall.'
            : ''}
        </p>
      ),
      hint: 'The session reports this itself: it is the account’s own figure, not an estimate.',
    });
  }

  if (run?.onlyPhases?.length) {
    notes.push({
      id: 'scoped',
      severity: 'info',
      head: 'Scoped run.',
      body: `This run drives ${
        run.onlyPhases.length === 1
          ? `phase ${run.onlyPhases[0]} only`
          : `phases ${run.onlyPhases.join(', ')} only`
      }, then stops.`,
      hint: 'It will not carry on into whatever those phases unblock. Run only this, on a phase row, sets it.',
      action: allowRun ? (
        <Button size="sm" disabled={patch.busy != null} onClick={patch.clearScope}>
          {patch.busy === 'scope' ? 'Clearing…' : 'Run the whole plan'}
        </Button>
      ) : undefined,
    });
  }

  // A run with the guard rails down must never look like an ordinary one.
  if (run?.permissionProfile && run.permissionProfile !== 'guarded') {
    const bypass = run.permissionProfile === 'bypass';
    notes.push({
      id: 'profile',
      severity: 'warn',
      head: bypass ? 'Bypass permissions.' : 'Trusted run.',
      body: bypass
        ? 'Nothing raises an approval card and the CLI is not asking either: only the deny list holds this run.'
        : 'Nothing raises an approval card. The deny list still refuses pushes, destructive git, deploys and publishes.',
      hint: bypass ? PROFILE_LABELS.bypass : `${PROFILE_LABELS.trusted}, even if this console dies`,
      action:
        live && allowRun ? (
          <Button size="sm" disabled={patch.busy != null} onClick={patch.guard}>
            {patch.busy === 'profile' ? 'Switching…' : 'Go back to Guarded'}
          </Button>
        ) : undefined,
    });
  }

  if (!allowRun) {
    notes.push({
      id: 'read-only',
      severity: 'info',
      body: (
        <p>
          This console is read-only for runs. Restart it with <Mono value="--allow-run" /> to start, pause or
          approve anything.
        </p>
      ),
      hint: 'You can still watch a run that another console started.',
    });
  }

  return notes;
}

/** A phase a stop left behind: settled, and not well. */
const stoppedPhase = (status: string): boolean =>
  (SETTLED as readonly string[]).includes(status) && !(SETTLED_WELL as readonly string[]).includes(status);

/**
 * The stop the card is about. A run that halted carries its own. One that
 * stopped with the cause on a PHASE's record instead — a park on a red
 * verification, a wait that ran out — is about that phase's stop, the
 * lowest-numbered first; every other stopped phase is the Ways forward fold's.
 * A live or resolved run has no phase stop to answer.
 */
export function runStopOf(run: RunState | null, live: boolean): RunState['halt'] {
  if (!run) return null;
  if (run.halt) return run.halt;
  if (live || run.resolved || !runEndedBadly(run)) return null;
  const record = Object.values(run.phases ?? {})
    .filter((one) => one && stoppedPhase(one.status) && one.halt)
    .sort((a, b) => a!.phase - b!.phase)[0];
  return record?.halt ? { ...record.halt, phase: record.halt.phase ?? record.phase } : null;
}

/**
 * Every notice this run raises, worst first, as one stack. The halt is the
 * halt card — live again, it is the stop as history and offers no remedy,
 * because every remedy boards a session onto a phase that already holds one.
 */
export function RunNotes({ slug, run, live, allowRun, git, fleetHold, authFailure, target }: RunNotesProps) {
  const patch = useRunPatch(slug);
  const notes: { id: RunNoteId; node: ReactNode }[] = noteSpecs(
    { run, live, allowRun, git, fleetHold },
    patch,
  ).map((spec) => ({ id: spec.id, node: <NoteBanner key={spec.id} spec={spec} /> }));

  const stop = runStopOf(run, live);
  if (run && stop) {
    // A phase's stop is drawn as the run's: the card reads its family, its
    // sentence and its recovery from the stop and the phase's own record.
    const stopped = stop === run.halt ? run : { ...run, halt: stop };
    const about = stop === run.halt || stop.phase == null ? target : { ...target, phase: stop.phase };
    const raised = budgetRaiseText(run);
    notes.push({
      id: 'halt',
      node: (
        <div key="halt" data-note="halt" className="min-w-0">
          <HaltCard
            run={stopped}
            live={live}
            authFailure={authFailure}
            target={about}
            parts={ACCOUNT_RECOVERY_PARTS}
          >
            {!live && stop.kind === 'identity-changed' && <IdentityChoice run={run} allowRun={allowRun} />}
            {raised && <p className="max-w-prose text-meta text-ink-muted">{raised}</p>}
          </HaltCard>
        </div>
      ),
    });
  }

  if (!notes.length) return null;
  notes.sort((a, b) => RUN_NOTE_ORDER.indexOf(a.id) - RUN_NOTE_ORDER.indexOf(b.id));
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="run-notes">
      {notes.map((note) => note.node)}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * A budget near its end, drawn before the park
 * ------------------------------------------------------------------ */

/** Every budget of this run still approaching: the run's own, then each open phase's. */
export function budgetApproaches(run: RunState): { phase: number | null; fact: BudgetFact }[] {
  const out: { phase: number | null; fact: BudgetFact }[] = [];
  for (const fact of Object.values(run.budgetApproaching ?? {})) out.push({ phase: null, fact });
  for (const record of Object.values(run.phases ?? {})) {
    if (!record || record.status === 'done' || record.status === 'skipped') continue;
    for (const fact of Object.values(record.budgetApproaching ?? {})) out.push({ phase: record.phase, fact });
  }
  return out;
}

/**
 * Each budget past its warning line and not yet raised (control-tower phase
 * 25, #40), with the same raise the halt card offers — worded by
 * `budgetHeadline(fact, 'approaching')`, never arithmetic of this page's own.
 */
export function RunBudgetBanners({ slug, run }: { slug: string; run: RunState }) {
  const approaches = budgetApproaches(run);
  if (!approaches.length) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="budget-approaching">
      {approaches.map(({ phase, fact }) => (
        <Banner key={`${phase ?? 'run'}:${fact.budget}`} severity="warn">
          <div className="flex min-w-0 flex-col gap-2">
            <p>
              {phase != null ? `Phase ${phase}: ` : ''}
              {budgetHeadline(fact, 'approaching')}
            </p>
            <BudgetRaise slug={slug} phase={phase} fact={fact} />
          </div>
        </Banner>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The run's asks
 * ------------------------------------------------------------------ */

/**
 * What waits on a person in this run, each ask drawn as its Your turn item
 * (control-tower phase 139, #216): the row's ONE primary, pressed exactly as
 * the server spelled it, and a link to its place on the page, where the rest
 * lives. The frame is the summons — a session is parked on every ask in it —
 * so its leading edge is amber, and nothing else here is. Acknowledged asks
 * count: an ack is "seen", never "done", and the session is still parked.
 *
 * The offer to notify sits here, where its value is on screen; asked on page
 * load instead, it is refused by reflex, and that refusal sticks.
 */
export function RunAsks({ runId, slug }: { runId?: string | undefined; slug?: string | undefined }) {
  const { data } = useAttentionInbox(true);
  const { perform, busy } = useInboxActions();
  const [notify, setNotify] = useState<NotifyState>(() => notifyState());
  const rows = approvalRows(data?.items ?? [], { runId, slug });
  if (!rows.length) return null;
  return (
    <section
      data-testid="approval-queue"
      className="state-needs-you flex min-w-0 flex-col gap-3 rounded-lg border border-rule border-s-2 border-s-state bg-surface px-3 py-3 sm:px-4"
    >
      <SectionHeading
        count={rows.length}
        aside={
          notify === 'default' ? (
            <Button size="sm" variant="ghost" onClick={() => void askToNotify().then(setNotify)}>
              Notify me next time
            </Button>
          ) : undefined
        }
      >
        Waiting on you
      </SectionHeading>
      {notify === 'granted' && (
        <p className="text-meta text-ink-muted">You will be notified when this happens again.</p>
      )}
      {notify === 'denied' && (
        <p className="text-meta text-ink-muted">
          Notifications are blocked for this site; your browser’s settings can undo that.
        </p>
      )}
      <div className="flex min-w-0 flex-col gap-2">
        {rows.map((row) => (
          <LazyItemRow key={row.id} row={row} perform={perform} busy={busy} />
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * An expired login, and a server older than the page
 * ------------------------------------------------------------------ */

/**
 * An expired login — the cheapest thing here to fix and the most confusing to
 * hit, because a signed-out session does not look like a failure: it reports
 * success, uses one turn, costs nothing and changes nothing. The card names
 * what happened and puts the fix one press away, because "run /login in this
 * workspace" is an instruction a browser cannot carry out. A card, not a
 * note: it has two buttons and a command, acted on as a unit.
 */
export function AuthCard({
  auth,
  allowRun,
  onRecheck,
  account,
}: {
  auth: AuthStatus | undefined;
  allowRun: boolean;
  onRecheck: () => void;
  /**
   * The RUN's account, when it is not the machine login. Its sign-in and its
   * command are composed by the server, which knows the profile's config
   * directory; this card never builds a path.
   */
  account?: AccountView | undefined;
}) {
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [command, setCommand] = useState<string | null>(null);
  const label = account ? (account.name ?? account.email ?? account.id) : null;
  const tokenAccount = account?.kind === 'token';

  const signIn = () => {
    setBusy(true);
    const done =
      account && account.kind === 'profile'
        ? press(() => accountsApi.accountLogin({ accountId: account.id })).then((pressed) => {
            if (pressed.state === 'asked') return toast(pressed.words, 'info');
            const result = pressed.result;
            if (result.mode === 'warn')
              return toast(result.warning ?? result.detail ?? 'Nothing was opened.', 'warn');
            setOpened(true);
            setCommand(result.command);
            return result.mode === 'command'
              ? toast(result.detail ?? 'Run the command below in a terminal.', 'warn')
              : toast('A sign-in is open — finish there, then choose Check again.', 'ok');
          })
        : press(() => systemApi.authLogin()).then((pressed) => {
            if (pressed.state === 'asked') return toast(pressed.words, 'info');
            setOpened(true);
            return pressed.result.opened
              ? toast('A terminal is open on the sign-in — finish there, then choose Check again.', 'ok')
              : toast(pressed.result.detail ?? 'Run the command below in a terminal.', 'warn');
          });
    void done.catch((cause: unknown) => toast(words(cause), 'error')).finally(() => setBusy(false));
  };

  return (
    <section
      data-testid="auth-card"
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-rule bg-surface p-4"
    >
      <header className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="min-w-0 text-section font-semibold text-ink">
          {label ? `${label} is signed out` : 'Claude Code is signed out'}
        </h2>
        {auth?.checkedAt && (
          <span className="text-meta text-ink-faint">
            Checked <RelativeTime at={auth.checkedAt} />
          </span>
        )}
      </header>
      <p className="max-w-prose text-body text-ink-muted">
        {label ? `This run pays as ${label}, and that login is expired or signed out. ` : ''}
        Sessions still start and report success, but cannot do anything: a run can look like it worked and
        change nothing.
        {auth?.detail && <span className="text-meta"> ({auth.detail})</span>}
      </p>
      <div className="flex min-w-0 flex-wrap gap-2">
        {tokenAccount ? (
          <Button asChild>
            <a href={settingsHref('accounts')}>Paste a fresh setup-token in Settings</a>
          </Button>
        ) : (
          <Button disabled={!allowRun || busy} onClick={signIn}>
            {busy ? 'Opening a sign-in…' : label ? `Sign ${label} in again` : 'Open a terminal and sign in'}
          </Button>
        )}
        <Button variant="ghost" onClick={onRecheck}>
          Check again
        </Button>
      </div>
      {opened && (
        <p className="text-meta text-ink-muted">
          Finish signing in over there, then choose Check again and continue the run.
        </p>
      )}
      {!tokenAccount && (!account || command) && (
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-meta text-ink-muted">
          Or run it yourself: <Mono value={command ?? 'claude auth login'} copyable />
        </p>
      )}
      {!allowRun && !tokenAccount && (
        <p className="text-meta text-ink-muted">
          Opening a sign-in needs <Mono value="--allow-run" />
          {account ? (
            <>
              {' '}
              (and account changes <Mono value="--allow-accounts" />)
            </>
          ) : null}
          ; the command {account && !command ? 'is available from Settings' : 'above works regardless'}.
        </p>
      )}
    </section>
  );
}

/**
 * A console talking to a server that predates the autopilot. The client is
 * served fresh from disk; the server is whatever Node loaded at startup, so an
 * upgrade under a running console leaves this page asking an API with no run
 * endpoints — and the honest thing to show is why, not a stack of failed
 * requests.
 */
export function StaleServerNote() {
  return (
    <Banner
      severity="warn"
      data-testid="stale-server-note"
      title="The page was loaded from disk, but the server behind it started before the autopilot existed — that is what the 404s in the browser console are."
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-medium text-ink">This console is running an older build.</p>
        <p className="text-ink-muted">
          Its server predates the autopilot, so the run endpoints are missing. Restart it to pick up the new
          server; <Mono value="--allow-run" /> is what turns the autopilot on.
        </p>
      </div>
    </Banner>
  );
}
