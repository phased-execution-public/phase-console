/**
 * A phase's QA, from where an operator stands (7.0, quiet-console phase 10):
 * the review button and its three states, turning the gate on, the three verbs
 * behind a verdict that holds, the recorded verdict and every round on file.
 *
 * The review itself is the launch form in QA mode — every AI launch shares one
 * field matrix there (model, effort, permissions, skills, the attach-defaults
 * toggle) — reached through its lazy door (`screens/launch/door`): its chunk is
 * fetched when a person presses, never when a plan is opened. What lives here is what is QA's own: the target a review is
 * about, the controls, and the history.
 *
 * Every write goes through `press()`, the owner door: a press the owner must
 * confirm is said as asked, never as done, and what it moved is re-read either
 * way.
 */

import { useId, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ShieldCheck, ShieldPlus, Wrench } from 'lucide-react';
import { qaGateHolds } from '@shared/plan-vocab.js';
import { ACTION_VOCAB } from '@shared/recovery-model.js';
import { api, type QaRound } from '@/data/api';
import { keys } from '@/data/keys';
import { press } from '@/data/press';
import { plural } from '@/lib/format';
import { isVerdict } from '@/lib/qa';
import { qaResultTitle } from '@/lib/status-vocab';
import { LaunchDoor, type QaTarget } from '@/screens/launch/door';
import { sessionsHref } from '@/shell/routes';
import { Button, Label, Mono, Money, toast } from '@/ui';
import { ConfirmButton } from '@/ui/confirm';
import { QaStatus, type WordOf } from '@/ui/status';
import { Textarea } from '@/ui/textarea';

/**
 * What a review is about — the phase, the plan's words for it and the verdict
 * already on file — is the launch's own request shape, declared once beside
 * the form that reads it.
 */
export type { QaTarget };

type ButtonSize = 'sm' | 'md';

/** The three verbs' words, read off their owner — every way forward is spelled once, in `shared/recovery-model.js`. */
const RECOVER = ACTION_VOCAB['qa-recover'];
const RERUN = ACTION_VOCAB['qa-rerun'];
const WAIVE = ACTION_VOCAB['qa-waive'];

const RUN_OFF = 'Runs are disabled. Restart the console with --allow-run.';
const WRITES_OFF = 'Writes are disabled. Restart the console with --allow-writes.';

/** A refusal in the server's own words — the honest floor when it said none. */
const refused = (cause: unknown): string =>
  cause instanceof Error && cause.message ? cause.message : 'The press failed and said nothing.';

/**
 * One QA write through the owner door: a press the owner must confirm is said
 * as asked, a refusal in the server's words, and the plan re-read whatever
 * happened — the commonest failure is another console having answered first,
 * and only a re-read takes that from the page.
 */
async function pressQa<T>(
  client: QueryClient,
  slug: string,
  call: () => Promise<T>,
  done: (result: T) => void,
): Promise<void> {
  try {
    const pressed = await press(call);
    if (pressed.state === 'asked') toast(pressed.words, 'info');
    else done(pressed.result);
  } catch (cause) {
    toast(refused(cause), 'error');
  } finally {
    for (const queryKey of keys.afterPlanWrite(slug)) void client.invalidateQueries({ queryKey });
  }
}

/**
 * Start a review, or go to the one already running.
 *
 * Three states and no fourth: a live review is a link to it, a console that
 * may mint agent sessions offers the button, and one without `--allow-agent`
 * draws the button disabled, naming the flag. Never simply absent — a
 * capability that exists and cannot be used has to say so.
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
  /** Handed to the form's activation box and to *Turn QA on* — a different flag, a different gate. */
  allowWrites?: boolean;
  runningSessionId?: string;
  size?: ButtonSize;
  label?: string;
}) {
  const [open, setOpen] = useState(false);

  // The flag gates STARTING a review; a running one is somewhere to go.
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
      {/* The plainer act on its own — "hold this plan's dependents behind a
          verdict from now on" — without spending a session on one phase. */}
      {target.qaMode === 'off' && (
        <QaEnableButton
          slug={target.slug}
          phase={target.phase}
          size={size}
          {...(allowWrites !== undefined ? { allowWrites } : {})}
        />
      )}
      {open && (
        <LaunchDoor
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
 * Write-class, not agent-class: it creates `test-status.md` and records every
 * phase already complete as waived — a change to the repository whether or not
 * a review ever runs — so it is gated on `--allow-writes`, disabled and naming
 * the flag without it. It asks first, because a recorded `fail` (and a
 * `pending`) then holds every dependent phase: a plan-wide change to what the
 * autopilot may board.
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
  /** `undefined` means the caller does not track the flag — treated as allowed. */
  allowWrites?: boolean;
  size?: ButtonSize;
}) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);

  // A plain disabled button rather than a confirm: a question behind a
  // control that cannot act is a question with no answer.
  if (allowWrites === false) {
    return (
      <Button
        size={size}
        disabled
        title="Turning the QA gate on writes test-status.md. Restart the console with --allow-writes."
      >
        <ShieldPlus size={13} aria-hidden /> Turn QA on
      </Button>
    );
  }

  const enable = () => {
    setBusy(true);
    void pressQa(
      client,
      slug,
      () => api.qaActivate(slug, phase),
      // The server's own words: it knows whether it created the file or found one there.
      (result) =>
        result.ok
          ? toast(result.detail || 'QA is on for this plan.', 'ok')
          : toast(result.detail || 'QA was not turned on.', 'error'),
    ).finally(() => setBusy(false));
  };

  return (
    <ConfirmButton
      size={size}
      busy={busy}
      title={`Turn QA on for ${slug}?`}
      description="Every phase from here on needs a recorded verdict before its dependents may board."
      confirmLabel="Turn QA on"
      details={
        <p className="max-w-prose text-body text-ink-muted">
          This writes <Mono value="test-status.md" /> into the plan’s handoff folder and marks the phases that
          are already complete as <Mono value="waived" />, so nothing finished is opened again. From then on a
          failing verdict, and a pending one, holds every dependent phase until it is answered.
        </p>
      }
      onConfirm={enable}
    >
      <ShieldPlus size={13} aria-hidden /> {busy ? 'Turning QA on' : 'Turn QA on'}
    </ConfirmButton>
  );
}

/**
 * The three verbs behind a verdict that is HOLDING this phase's dependents
 * (issue #11): fix and review again, review again, or waive with a reason.
 *
 * Drawn only while the gate holds (`qaGateHolds`: a `fail`, or a `pending`,
 * under a plan whose gate is on) — not a capability that is unavailable but
 * three answers to a question nobody has asked, so otherwise nothing. Fix &
 * re-QA only on a `fail`: a pending row names no findings for a fix session to
 * read. Without `--allow-run` the two loop verbs are disabled and the hand
 * command is printed instead; a console that may write can still waive,
 * because waiving writes a row and starts nothing.
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
  /** Handed to the fix loop's launch form — the same target a review takes. */
  target: QaTarget;
  /** THIS phase's QA regime. */
  qaMode?: string;
  qa?: { result: string; report?: string };
  allowRun: boolean;
  allowWrites?: boolean;
  /** Where `qa-record.sh` lives on this machine, for the hand command. */
  scriptsDir?: string;
}) {
  const client = useQueryClient();
  const reasonId = useId();
  const [fixing, setFixing] = useState(false);
  const [waiving, setWaiving] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'rerun' | 'waive' | null>(null);
  const held = qaGateHolds(qaMode, qa?.result);
  if (!held) return null;

  const writesOff = allowWrites === false;
  const rerun = () => {
    setBusy('rerun');
    void pressQa(
      client,
      slug,
      () => api.qaRerun(slug, phase),
      (result) =>
        result.error
          ? toast(result.error, 'error')
          : toast(`Re-running QA on phase ${phase}. The round is recorded when it lands.`, 'ok'),
    ).finally(() => setBusy(null));
  };
  const waive = () => {
    setBusy('waive');
    void pressQa(
      client,
      slug,
      () => api.qaWaive(slug, phase, reason.trim()),
      (result) => {
        toast(result.detail, result.ok ? 'ok' : 'error');
        if (result.ok) {
          setWaiving(false);
          setReason('');
        }
      },
    ).finally(() => setBusy(null));
  };
  // A pending row has no report yet: round 1's plain name is what the brief hands out.
  const report = qa?.report || `reports/phase-${String(phase).padStart(2, '0')}-qa.md`;

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="qa-recovery">
      <p className="max-w-prose text-meta text-ink-muted">
        {held === 'fail'
          ? 'This verdict is holding every phase that depends on it.'
          : 'No verdict is recorded, and a pending row holds dependents exactly as a failure does.'}
      </p>
      <div className="flex min-w-0 flex-wrap gap-2">
        {held === 'fail' && (
          <Button
            size="sm"
            disabled={!allowRun}
            title={allowRun ? RECOVER.blurb : RUN_OFF}
            onClick={() => setFixing(true)}
          >
            <Wrench size={13} aria-hidden /> {RECOVER.label}
          </Button>
        )}
        <Button
          size="sm"
          disabled={!allowRun || busy === 'rerun'}
          title={allowRun ? RERUN.blurb : RUN_OFF}
          onClick={rerun}
        >
          <ShieldCheck size={13} aria-hidden /> {busy === 'rerun' ? 'Starting' : RERUN.label}
        </Button>
        <Button
          size="sm"
          disabled={writesOff}
          aria-expanded={waiving && !writesOff}
          title={writesOff ? WRITES_OFF : WAIVE.blurb}
          onClick={() => setWaiving((was) => !was)}
        >
          <ShieldPlus size={13} aria-hidden /> {WAIVE.label}
        </Button>
      </div>

      {waiving && !writesOff && (
        <div className="flex min-w-0 max-w-prose flex-col gap-1.5">
          <Label htmlFor={reasonId}>Why this is waived</Label>
          <Textarea
            id={reasonId}
            block
            maxLength={280}
            value={reason}
            placeholder="What does not apply, and why"
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            {/* A waiver with no reason is a plan forgetting what it decided not
                to fix — and the server refuses one too. */}
            <Button size="sm" disabled={!reason.trim() || busy === 'waive'} onClick={waive}>
              {busy === 'waive' ? 'Recording' : 'Record the waiver'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setWaiving(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* The exact line, rather than a dead button: a console that may not run
          can still do all of this, in a terminal. */}
      {!allowRun && (
        <p className="min-w-0 max-w-prose text-meta text-ink-muted">
          By hand, record a verdict with{' '}
          <Mono
            copyable
            className="wrap-anywhere"
            value={`bash ${scriptsDir}/qa-record.sh ${slug} ${phase} <pass|fail|waived> --report ${report} --round <n>`}
          />{' '}
          and print the reviewer’s brief with{' '}
          <Mono
            copyable
            className="wrap-anywhere"
            value={`bash ${scriptsDir}/phase-graph.sh ${slug} --qa-prompt ${phase}`}
          />
          .
        </p>
      )}

      {fixing && (
        <LaunchDoor
          request={{ kind: 'qa-fix', target, ...(allowWrites !== undefined ? { allowWrites } : {}) }}
          onClose={() => setFixing(false)}
        />
      )}
    </div>
  );
}

/**
 * The recorded verdict, beside the control that produced it — linked to its
 * report when there is one.
 *
 * `pending` is not drawn: a review asked for and never answered is not a third
 * verdict beside `pass` and `fail`.
 */
export function QaVerdict({ qa, href }: { qa?: { result: string; report?: string }; href?: string }) {
  if (!qa || !isVerdict(qa.result)) return null;
  const word = <QaStatus result={qa.result as WordOf<'qa-result'>} title={qaResultTitle(qa.result)} />;
  return qa.report && href ? (
    <a href={href} className="hover:underline" title={qa.report}>
      {word}
    </a>
  ) : (
    word
  );
}

/**
 * Every QA round a phase has been through, oldest first: its verdict, its own
 * report, what it spent and the session that produced it (issue #7 — a review
 * cost real money and decided whether dependents could start, and no surface
 * drew the report it was required to write).
 *
 * Nothing for a phase with no rounds, which is most of them. Unlike
 * `QaVerdict`, a `pending` round IS drawn: in a history, a round asked for and
 * never answered is a fact about what happened.
 */
export function QaRounds({
  rounds,
  reportHref,
  sessionHref,
}: {
  rounds?: readonly QaRound[] | undefined;
  /** Turns a report path into a link; absent, the path is drawn as plain text. */
  reportHref?: (reportPath: string) => string;
  /** Turns the session that produced a round into a link to its page. */
  sessionHref?: (sessionId: string) => string;
}) {
  if (!rounds?.length) return null;
  return (
    <ol className="flex min-w-0 flex-col gap-1" data-testid="qa-rounds">
      {rounds.map((entry) => {
        const href = entry.reportPath && reportHref ? reportHref(entry.reportPath) : undefined;
        return (
          <li
            key={`${entry.round}-${entry.at ?? ''}`}
            className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-meta"
          >
            <span className="text-ink-muted">Round {entry.round}</span>
            {entry.verdict ? (
              <QaStatus result={entry.verdict as WordOf<'qa-result'>} title={qaResultTitle(entry.verdict)} />
            ) : (
              <span className="text-ink-muted">No verdict</span>
            )}
            {entry.reportPath &&
              (href ? (
                <a
                  href={href}
                  className="min-w-0 wrap-anywhere font-mono text-ink underline-offset-2 hover:underline"
                  title={`Read ${entry.reportPath}`}
                >
                  {entry.reportPath}
                </a>
              ) : (
                <Mono value={entry.reportPath} className="min-w-0 wrap-anywhere" />
              ))}
            {typeof entry.costUsd === 'number' && <Money usd={entry.costUsd} className="text-ink-muted" />}
            {typeof entry.turns === 'number' && (
              <span className="text-ink-muted">{plural(entry.turns, 'turn')}</span>
            )}
            {entry.sessionId && sessionHref && (
              <a
                href={sessionHref(entry.sessionId)}
                className="text-ink underline-offset-2 hover:underline"
                title={entry.sessionId}
              >
                Open its session
              </a>
            )}
          </li>
        );
      })}
    </ol>
  );
}
