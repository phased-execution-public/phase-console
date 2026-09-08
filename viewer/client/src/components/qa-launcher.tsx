/**
 * "QA this phase" — the button's three states, and the recorded verdict.
 *
 * The dialog itself is `LaunchDialog` over `RunSetup` in `qa` mode, where
 * every AI launch shares one field matrix (model, effort, permissions, skills,
 * the attach-defaults toggle) seeded from the Automation preferences. What
 * stays here is what is QA-specific and public: the `QaTarget` shape callers
 * build, the three-state button, and the verdict chip.
 *
 * The `QaDialog` wrapper is gone (Phase 6): it existed to spare callers from
 * knowing the dialog had been unified, and it had exactly one caller left —
 * this file — plus its own test. A wrapper whose only job is to hide a
 * consolidation is a place for the two to drift.
 */

import { useState } from 'react';
import { ShieldCheck, ShieldPlus, Wrench } from 'lucide-react';
import { Button, ConfirmButton, StatusBadge, toast } from '@/components/ui';
import { api } from '@/lib/api';
import { keys, useApiMutation } from '@/lib/queries';
import { sessionsHref } from '@/app/routes';
import { qaResultTitle, qaUiState } from '@/lib/status-vocab';
import { isVerdict } from '@/lib/qa';
import { qaGateHolds } from '@shared/plan-vocab.js';
import { ACTION_VOCAB } from '@shared/recovery-model.js';
import { LaunchDialog } from '@/features/run-setup/lazy-launch-dialog';
import type { QaTarget } from '@/features/run-setup/launch-dialog';
import type { QaRound as QaRoundView } from '@/lib/api';

export type { QaTarget } from '@/features/run-setup/launch-dialog';

/**
 * The three verbs' blurbs, read off the OWNER rather than retyped here —
 * `shared/recovery-model.js` is where every way-forward's words live, and a
 * second copy on the tooltip is exactly the drift `vocab-owners.test.ts`
 * exists to stop.
 */
const RECOVERY_BLURBS_QA = {
  'qa-recover': ACTION_VOCAB['qa-recover'].blurb,
  'qa-rerun': ACTION_VOCAB['qa-rerun'].blurb,
  'qa-waive': ACTION_VOCAB['qa-waive'].blurb,
} as const;

/**
 * Start a review, or go to the one already running.
 *
 * Three states and no fourth — the same contract `RecoveryButton` keeps: a live
 * session is a link, a permitted console is a button, and a console without
 * `--allow-agent` is a disabled button naming the flag that turns it on. Never
 * simply absent: a capability that exists and is unavailable has to say so.
 */
export function QaButton({
  target,
  allowAgent,
  allowWrites,
  runningSessionId,
  size = 'sm',
  label = 'QA this phase',
}: {
  target: QaTarget;
  allowAgent: boolean;
  /** Passed through to the activation checkbox — a different flag, a different gate. */
  allowWrites?: boolean;
  runningSessionId?: string;
  size?: 'sm' | 'md';
  label?: string;
}) {
  const [open, setOpen] = useState(false);

  if (runningSessionId) {
    return (
      <Button size={size} asChild>
        <a href={sessionsHref(runningSessionId)}>
          <ShieldCheck size={13} aria-hidden /> QA running
        </a>
      </Button>
    );
  }

  return (
    <>
      <Button
        size={size}
        disabled={!allowAgent}
        title={
          allowAgent
            ? 'Opens a fresh Claude session that reviews this phase and records the verdict itself.'
            : 'Agent sessions are disabled. Restart the console with --allow-agent.'
        }
        onClick={() => setOpen(true)}
      >
        <ShieldCheck size={13} aria-hidden /> {label}
      </Button>
      {/* Turning the gate on WITHOUT minting a review. The dialog's activation
          checkbox has always been able to do both at once, which left the
          plainer act — "hold this plan's dependents behind a verdict from now
          on" — reachable only by starting a session you may not want yet. */}
      {target.qaMode === 'off' && (
        <QaEnableButton slug={target.slug} phase={target.phase} allowWrites={allowWrites} size={size} />
      )}
      {open && (
        <LaunchDialog
          request={{ kind: 'qa', target, ...(allowWrites !== undefined ? { allowWrites } : {}) }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/**
 * Turn the QA gate on for a plan that has it off.
 *
 * WRITE-class, not agent-class, and the difference is the whole reason this is
 * its own button: it creates `test-status.md` and backfills every
 * already-complete phase as `waived` — a change to the repository, whether or
 * not a review is ever run. So it is gated on `--allow-writes` (and follows
 * `QaButton`'s three-state contract: never simply absent, because a capability
 * that hides when disabled looks like a bug).
 *
 * The confirm is not ceremony. `**QA gate:** on` means a recorded `fail` — and
 * a `pending` — holds every dependent phase, which is a plan-wide change to
 * what the autopilot may board.
 */
export function QaEnableButton({
  slug,
  phase,
  allowWrites,
  size = 'sm',
}: {
  slug: string;
  /** The phase the activation is anchored on — the engine records the backfill against it. */
  phase: number;
  allowWrites?: boolean;
  size?: 'sm' | 'md';
}) {
  const enable = useApiMutation<void, { ok: boolean; mode: string; detail: string }>({
    fn: () => api.qaActivate(slug, phase),
    invalidates: keys.afterPlanWrite(slug),
    // The server's own words: it knows whether it created the file or found
    // one already there, and inventing a sentence here would hide the second.
    say: (result) => (result.ok ? (result.detail ?? 'QA is on for this plan.') : null),
    onDone: (result) => {
      if (!result.ok) toast(result.detail || 'QA was not turned on.', 'error');
    },
  });

  // Disabled and SAYING SO, rather than absent — and as a plain Button,
  // because a confirm dialog behind a control that cannot act is a question
  // with no answer. `undefined` means the caller does not track the flag, which
  // is how `LaunchDialog` reads it too (`allowWrites !== false`).
  if (allowWrites === false) {
    return (
      <Button
        size={size}
        disabled
        title="Turning the QA gate on writes test-status.md. Restart the console with --allow-writes."
      >
        <ShieldPlus size={13} aria-hidden /> Enable QA
      </Button>
    );
  }

  return (
    <ConfirmButton
      size={size}
      busy={enable.isPending}
      busyLabel="Turning QA on…"
      title={`Turn QA on for ${slug}?`}
      description="Every phase from here on needs a recorded verdict before its dependents may board."
      confirmLabel="Turn QA on"
      details={
        <p className="mt-2 text-sm text-ink-muted">
          This writes <code className="rounded bg-surface-raised px-1 font-mono">test-status.md</code> into
          the plan&rsquo;s handoff folder and marks the phases that are already complete as{' '}
          <code className="rounded bg-surface-raised px-1 font-mono">waived</code> — nothing finished is
          re-opened. From then on a <code className="font-mono">fail</code>, and a{' '}
          <code className="font-mono">pending</code>, holds every dependent phase until it is answered.
        </p>
      }
      onConfirm={() => enable.mutate()}
    >
      <ShieldPlus size={13} aria-hidden /> Enable QA
    </ConfirmButton>
  );
}

/**
 * The three verbs behind a verdict that is HOLDING this phase's dependents.
 *
 * Issue #11: a recorded `fail` — and a `pending` — holds every dependent phase,
 * and until this existed there was nothing on any surface to press. The ladder's
 * `qa-fix` rung climbed until its attempt and dollar caps were spent and then
 * parked with an errand naming no action; a hand-driven plan never had a rung.
 *
 * Renders NOTHING when the gate is not holding — no verdict recorded, or one
 * that reads `pass`/`waived`, or a plan whose QA is off. That is the one place
 * this differs from `QaButton`'s three-state contract, and deliberately: these
 * are not a capability that exists and is unavailable, they are three answers to
 * a question nobody has asked.
 *
 * Without `--allow-run` the two loop verbs are DISABLED and the hand command is
 * printed instead of a dead button — the same rule the launcher keeps, with the
 * addition that a console which cannot run can still waive, because waiving
 * writes a row and starts nothing.
 */
export function QaRecoveryActions({
  slug,
  phase,
  target,
  qaMode,
  qa,
  allowRun,
  allowWrites,
  scriptsDir = 'scripts',
}: {
  slug: string;
  phase: number;
  /** Passed to the `qa-fix` launch flow — the same target a review takes. */
  target: QaTarget;
  qaMode?: string;
  qa?: { result: string; report?: string };
  allowRun: boolean;
  allowWrites?: boolean;
  /** Where `qa-record.sh` lives on this machine, for the hand command. */
  scriptsDir?: string;
}) {
  const [open, setOpen] = useState(false);
  const [waiving, setWaiving] = useState(false);
  const [reason, setReason] = useState('');
  const held = qaGateHolds(qaMode, qa?.result);

  const rerun = useApiMutation<void, { run: unknown; error?: string }>({
    fn: () => api.qaRerun(slug, phase),
    invalidates: keys.afterPlanWrite(slug),
    onDone: (result) => {
      if (result.error) toast(result.error, 'error');
      else toast(`Re-running QA on phase ${phase} — the round is recorded when it lands.`, 'ok');
    },
  });
  const waive = useApiMutation<string, { ok: boolean; detail: string }>({
    fn: (why) => api.qaWaive(slug, phase, why),
    invalidates: keys.afterPlanWrite(slug),
    onDone: (result) => {
      toast(result.detail, result.ok ? 'ok' : 'error');
      if (result.ok) {
        setWaiving(false);
        setReason('');
      }
    },
  });

  if (!held) return null;

  const runOff = 'Runs are disabled. Restart the console with --allow-run.';
  return (
    <div className="flex flex-col gap-2" data-testid="qa-recovery">
      <p className="text-2xs text-ink-muted">
        {held === 'fail'
          ? 'This verdict is holding every phase that depends on it.'
          : 'No verdict is recorded, and a pending row holds dependents exactly as a failure does.'}
      </p>
      <div className="flex flex-wrap gap-2">
        {/* Only on a `fail`: a pending verdict names no findings for a fix
            session to read, so the honest first move there is the review. */}
        {held === 'fail' && (
          <Button
            size="sm"
            disabled={!allowRun}
            title={allowRun ? RECOVERY_BLURBS_QA['qa-recover'] : runOff}
            onClick={() => setOpen(true)}
          >
            <Wrench size={13} aria-hidden /> Fix &amp; re-QA
          </Button>
        )}
        <Button
          size="sm"
          disabled={!allowRun || rerun.isPending}
          title={allowRun ? RECOVERY_BLURBS_QA['qa-rerun'] : runOff}
          onClick={() => rerun.mutate()}
        >
          <ShieldCheck size={13} aria-hidden /> {rerun.isPending ? 'Starting…' : 'Re-run QA'}
        </Button>
        <Button
          size="sm"
          disabled={allowWrites === false}
          title={
            allowWrites === false
              ? 'Writes are disabled. Restart the console with --allow-writes.'
              : RECOVERY_BLURBS_QA['qa-waive']
          }
          onClick={() => setWaiving((was) => !was)}
        >
          <ShieldPlus size={13} aria-hidden /> Waive with a reason
        </Button>
      </div>

      {waiving && allowWrites !== false && (
        <div className="flex flex-col gap-1.5">
          <label className="text-2xs text-ink-muted" htmlFor={`qa-waive-${slug}-${phase}`}>
            Why this is waived
          </label>
          <textarea
            id={`qa-waive-${slug}-${phase}`}
            className="min-h-16 rounded border border-rule bg-surface px-2 py-1.5 text-2xs"
            maxLength={280}
            value={reason}
            placeholder="what does not apply, and why"
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={!reason.trim() || waive.isPending}
              onClick={() => waive.mutate(reason.trim())}
            >
              {waive.isPending ? 'Recording…' : 'Record the waiver'}
            </Button>
            <Button size="sm" onClick={() => setWaiving(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* The hand command, printed rather than a dead button. A console without
          `--allow-run` can still do all of this — it just does it in a terminal,
          and the exact line is the difference between "you cannot" and "here". */}
      {!allowRun && (
        <p className="text-2xs text-ink-faint">
          By hand:{' '}
          <code className="rounded bg-surface-raised px-1 font-mono break-all">
            bash {scriptsDir}/qa-record.sh {slug} {phase} &lt;pass|fail|waived&gt; --report{' '}
            {qa?.report || `reports/phase-${String(phase).padStart(2, '0')}-qa.md`} --round &lt;n&gt;
          </code>{' '}
          — and{' '}
          <code className="rounded bg-surface-raised px-1 font-mono">
            phase-graph.sh {slug} --qa-prompt {phase}
          </code>{' '}
          prints the reviewer&rsquo;s brief.
        </p>
      )}

      {open && (
        <LaunchDialog
          request={{ kind: 'qa-fix', target, ...(allowWrites !== undefined ? { allowWrites } : {}) }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * The recorded verdict, beside the control that produced it.
 *
 * `pending` is deliberately not rendered as a result: a row that says pending
 * is a review that was asked for and never answered, and showing it as a chip
 * next to `pass` and `fail` would read as a third verdict.
 */
export function QaVerdict({ qa, href }: { qa?: { result: string; report?: string }; href?: string }) {
  if (!qa || !isVerdict(qa.result)) return null;
  const chip = (
    <StatusBadge state={qaUiState(qa.result)} label={`QA ${qa.result}`} title={qaResultTitle(qa.result)} />
  );
  return qa.report && href ? (
    <a href={href} className="hover:underline" title={qa.report}>
      {chip}
    </a>
  ) : (
    chip
  );
}

/**
 * Every QA round a phase has been through, oldest first — round, verdict,
 * report and what it spent.
 *
 * This is the surface issue #7 was written about. QA was spawned, it decided
 * whether every dependent phase could start, it cost real money, and the only
 * thing any run surface ever showed was a cost line: the report the QA method
 * REQUIRES the reviewer to write was never read back, never linked and never
 * rendered, and re-recording a verdict overwrote the previous row, so the
 * earlier rounds existed only as filenames nobody listed. On the run that issue
 * was written from, twelve phases cost $818 and ten QA rounds inside that
 * number were invisible to every screen.
 *
 * Renders nothing for a phase with no rounds — which is most of them, and on a
 * QA-off plan is all of them. `pending` IS shown here, unlike in `QaVerdict`:
 * in a history a round that was asked for and never answered is a fact about
 * what happened, not a third verdict competing with `pass`.
 */
export function QaRounds({
  rounds,
  reportHref,
  sessionHref,
}: {
  rounds?: readonly QaRoundView[];
  /** Turns a report path into a link. Absent renders the path as plain text. */
  reportHref?: (reportPath: string) => string;
  /**
   * Turns the session that produced a round into a link to its page. The
   * record carried `sessionId` all along and nothing drew it — so a round's
   * log was one click away from nowhere.
   */
  sessionHref?: (sessionId: string) => string;
}) {
  if (!rounds?.length) return null;
  return (
    <ol className="flex flex-col gap-1" data-testid="qa-rounds">
      {rounds.map((entry) => {
        const spend = [
          typeof entry.costUsd === 'number' ? `$${entry.costUsd.toFixed(2)}` : null,
          typeof entry.turns === 'number' ? `${entry.turns} turns` : null,
        ]
          .filter(Boolean)
          .join(' · ');
        const href = entry.reportPath && reportHref ? reportHref(entry.reportPath) : undefined;
        return (
          <li key={`${entry.round}-${entry.at ?? ''}`} className="flex flex-wrap items-center gap-1 text-2xs">
            <span className="font-mono text-ink-muted">round {entry.round}</span>
            {isVerdict(entry.verdict) ? (
              <StatusBadge
                state={qaUiState(entry.verdict)}
                label={entry.verdict}
                title={qaResultTitle(entry.verdict)}
              />
            ) : (
              <span className="text-ink-muted">{entry.verdict || 'no verdict'}</span>
            )}
            {entry.reportPath &&
              (href ? (
                <a href={href} className="font-mono text-ink-muted hover:underline" title={entry.reportPath}>
                  {entry.reportPath}
                </a>
              ) : (
                <span className="font-mono text-ink-muted" title={entry.reportPath}>
                  {entry.reportPath}
                </span>
              ))}
            {spend && <span className="text-ink-muted">{spend}</span>}
            {entry.sessionId && sessionHref && (
              <a
                href={sessionHref(entry.sessionId)}
                className="text-ink-muted hover:underline"
                title={entry.sessionId}
              >
                session
              </a>
            )}
          </li>
        );
      })}
    </ol>
  );
}
