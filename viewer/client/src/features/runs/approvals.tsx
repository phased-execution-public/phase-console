/**
 * The queue: what is waiting on a person, and how to answer it.
 *
 * This is the top of the page because it is the answer to the only question
 * somebody opens this tab on a phone at 11pm to ask — "does this need me?" — so
 * the cards carry their own evidence and are answerable without scrolling past
 * anything.
 *
 * ## Two kinds of question, two vocabularies
 *
 * A permission question ("may I run this command?") and a verification question
 * ("did you check this yourself?") deserve different words. Labelling both
 * Allow/Deny is how a card that means "the plan asked for something only you can
 * confirm" reads as one more thing to rubber-stamp — and an approval nobody
 * reads is not an approval.
 *
 * ## The rule is editable before it is written
 *
 * "Always allow this" that writes something you never saw is how a policy file
 * fills up with rules nobody can account for. The suggested rule is a
 * suggestion; it is shown, editable, and only then written — with your name on
 * it and a line in the run's journal.
 */

import { useState } from 'react';
import { Button, Card, CardBody, CardHeader, CardTitle, field } from '@/components/ui';
import { useWindowLeft } from '@/lib/clock';
import { cn } from '@/lib/cn';
import { askToNotify, notifyState, type NotifyState } from '@/lib/notify';
import type { Approval } from '@/lib/api';

export type Decide = (
  id: string,
  decision: 'allow' | 'deny',
  reason?: string,
  remember?: 'plan' | 'global',
  rule?: string,
) => void;

/** A pick on a relayed question (phase 14): which card, which question, which option. */
export type Answer = (approval: Approval, key: string, label: string) => void;

/** Not yet (control-tower phase 97, #140): move a card's deadline `minutes` later. */
export type Extend = (id: string, minutes: number) => void;

/**
 * The Extend buttons — the server's `EXTEND_CHOICES_MIN`, which judges the
 * number whatever a page sends. Half an hour to finish what you are doing; two
 * hours for "I am away from the desk".
 */
const EXTEND_CHOICES = [30, 120] as const;

const extendLabel = (minutes: number): string =>
  minutes >= 60 ? `Extend ${minutes / 60} h` : `Extend ${minutes} min`;

/** Minutes while it is minutes; hours once a card has more than an hour and a half to live. */
const timeLeft = (ms: number): string =>
  ms >= 90 * 60_000 ? `${Math.round(ms / 3_600_000)} h` : `${Math.ceil(ms / 60_000)} min`;

export function ApprovalQueue({
  approvals,
  allowRun,
  onDecide,
  onExtend,
  onAnswer,
}: {
  approvals: Approval[];
  allowRun: boolean;
  onDecide: Decide;
  /** Absent: a card offers no Extend. */
  onExtend?: Extend;
  /** Absent: a question card shows its options and cannot be answered from here. */
  onAnswer?: Answer;
}) {
  if (!approvals.length) return null;
  return (
    // The queue IS the summons — a session is parked on every card in it — so its
    // frame is amber through `--accent` (tokens 6.0: `--action` is ink).
    <Card className="border-accent/50">
      <CardHeader className="flex-wrap items-center">
        <CardTitle className="flex items-center gap-2">
          Waiting on you
          <span className="rounded-sm bg-accent/15 px-1.5 py-0.5 font-mono text-sm text-accent">
            {approvals.length}
          </span>
        </CardTitle>
        <NotifyToggle />
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {approvals.map((a) =>
          a.kind === 'question' && a.question ? (
            <QuestionCard key={a.id} approval={a} allowRun={allowRun} onAnswer={onAnswer} />
          ) : (
            <ApprovalCard
              key={a.id}
              approval={a}
              allowRun={allowRun}
              onDecide={onDecide}
              onExtend={onExtend}
            />
          ),
        )}
      </CardBody>
    </Card>
  );
}

/**
 * Offered here, where the value of it is on screen: you are looking at a queue
 * that waited for you to notice it. Asking on page load instead gets refused by
 * reflex, and that refusal sticks.
 */
function NotifyToggle() {
  const [state, setState] = useState<NotifyState>(() => notifyState());

  if (state === 'unsupported') return null;
  if (state === 'granted') {
    return <span className="text-2xs text-ink-faint">You will be notified when this happens again.</span>;
  }
  if (state === 'denied') {
    return (
      <span className="text-2xs text-ink-faint">
        Notifications are blocked for this site — your browser's settings can undo that.
      </span>
    );
  }
  return (
    <Button size="sm" onClick={async () => setState(await askToNotify())}>
      Notify me next time
    </Button>
  );
}

/**
 * A question a session asked (phase 14). Not Allow/Deny: a question is answered
 * by choosing, so each option is a button, and the card says what silence will
 * choose and when — the console answers by its relay rules as the window
 * closes. An option already chosen (by a person on another device) is shown as
 * chosen; a question left open is still the console's to answer.
 */
function QuestionCard({
  approval,
  allowRun,
  onAnswer,
}: {
  approval: Approval;
  allowRun: boolean;
  onAnswer?: Answer;
}) {
  const left = useWindowLeft(approval.expiresAt) ?? 0;
  const question = approval.question!;
  const deferred = Boolean(question.deferred);

  return (
    <article className="rounded-lg border border-rule bg-surface-raised p-3" data-kind="question">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <strong className="text-sm">A session asks</strong>
        <span className="text-2xs text-ink-faint" aria-live="polite">
          {approval.slug ?? 'no plan named'} ·{' '}
          {approval.phase != null ? `phase ${approval.phase}` : 'no phase named'} ·
          {deferred
            ? 'deferred — answered when its session resumes'
            : left > 0
              ? `${left} s to answer`
              : 'answering by rule'}
        </span>
      </div>
      <p className="mt-1 max-w-prose text-sm text-ink-muted">{approval.detail}</p>

      {question.items.map((item) => {
        const chosen = question.answers[item.key];
        return (
          <section key={item.key} className="mt-3 flex flex-col gap-2">
            <p className="text-sm font-medium text-ink">
              {item.header && <span className="mr-2 text-2xs uppercase text-ink-faint">{item.header}</span>}
              {item.question}
            </p>
            <div className="flex flex-wrap gap-2">
              {item.options.map((option) => (
                <Button
                  key={option.label}
                  size="sm"
                  variant={chosen?.label === option.label ? 'action' : undefined}
                  disabled={!allowRun || !onAnswer || Boolean(chosen) || deferred || left === 0}
                  title={option.description}
                  onClick={() => onAnswer?.(approval, item.key, option.label)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
            {chosen && (
              <p className="text-2xs text-ink-faint">
                Answered “{chosen.label}” by {chosen.by === 'human' ? (chosen.who ?? 'a person') : chosen.by}.
              </p>
            )}
          </section>
        );
      })}

      {!allowRun && (
        <p className="mt-2 text-2xs text-ink-faint">
          This console cannot answer — it was started without <code className="font-mono">--allow-run</code>.
        </p>
      )}
    </article>
  );
}

function ApprovalCard({
  approval,
  allowRun,
  onDecide,
  onExtend,
}: {
  approval: Approval;
  allowRun: boolean;
  onDecide: Decide;
  onExtend?: Extend;
}) {
  const [reason, setReason] = useState('');
  const [rule, setRule] = useState(approval.suggestedRule ?? '');
  const [showRule, setShowRule] = useState(false);
  const left = Math.max(0, Date.parse(approval.expiresAt) - Date.now());

  const asking = approval.kind === 'verify';
  const yes = asking ? 'I checked it — mark verified' : 'Allow';
  const no = asking ? 'It failed' : 'Deny';
  const placeholder = asking
    ? 'What you saw (optional — recorded against the phase)'
    : 'Why (optional — the session is told)';

  return (
    <article className="rounded-lg border border-rule bg-surface-raised p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <strong className="text-sm">{approval.title}</strong>
        <span className="text-2xs text-ink-faint">
          {approval.slug ?? 'no plan named'} ·{' '}
          {approval.phase != null ? `phase ${approval.phase}` : 'no phase named'} ·
          {approval.converted
            ? `stands until ${approval.expiresAt.slice(11, 16)}Z`
            : left > 0
              ? `${timeLeft(left)} to answer`
              : 'expiring'}
        </span>
      </div>
      <p className="mt-1 max-w-prose text-sm text-ink-muted">{approval.detail}</p>
      {/* What silence will do, said before it does it (#140): a timeout also
          parked the run, and the card used to be the one place that never said so. */}
      {approval.converted ? (
        <p className="mt-1 max-w-prose text-2xs text-ink-muted" data-testid="standing">
          Its session was told no when its hook call ended; the phase is parked on this card. Allow it to
          resume the phase with this one call granted once.
        </p>
      ) : (
        approval.onTimeout && (
          <p className="mt-1 max-w-prose text-2xs text-ink-faint" data-testid="on-timeout">
            If nobody answers, it {approval.onTimeout}.
          </p>
        )
      )}

      {approval.tool?.input?.command && (
        <pre className="mt-2 overflow-x-auto rounded border border-rule bg-ground px-2 py-1.5 font-mono text-2xs">
          {approval.tool.input.command}
        </pre>
      )}

      {approval.evidence?.length > 0 && (
        <div className="mt-2 flex flex-col gap-1.5">
          {approval.evidence.map((e, i) => (
            <details key={i} open={i === 0} className="rounded border border-rule">
              <summary className="cursor-pointer px-2 py-1 text-2xs">{e.label}</summary>
              <pre className="max-h-56 overflow-auto border-t border-rule bg-ground px-2 py-1.5 font-mono text-2xs">
                {e.body}
              </pre>
            </details>
          ))}
        </div>
      )}

      {asking && (
        <p className="mt-2 max-w-prose text-2xs text-ink-faint">
          The runner will not execute prose out of a plan file, so these were left for you. Marking them
          verified records that you checked them, against this phase, with your name on it.
        </p>
      )}

      {/* The plan already spoke about publishing (#112): the row this call was
          checked against, and why it did not cover it — so a person sees what
          the plan allows before answering what it does not. */}
      {approval.manifest && approval.manifest.answer !== 'allow' && (
        <p className="mt-3 text-sm text-ink-muted" title={approval.manifest.value}>
          Checked against this plan&rsquo;s permission.destructive row, which does not cover it:{' '}
          {approval.manifest.why}.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`reason-${approval.id}`}>
          {placeholder}
        </label>
        <input
          id={`reason-${approval.id}`}
          // `field`: the one control class. Hand-rolled, this respelling was
          // missing the coarse-pointer thumb floor, so the box an operator
          // types a denial reason into was 36px tall on the phone where the
          // card most often gets answered.
          className={cn(field, 'min-w-40 flex-1')}
          placeholder={placeholder}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {/* The one amber button on the page: a session is parked until a person answers. */}
        <Button
          variant="attention"
          disabled={!allowRun}
          onClick={() => onDecide(approval.id, 'allow', reason)}
        >
          {yes}
        </Button>
        <Button variant="danger" disabled={!allowRun} onClick={() => onDecide(approval.id, 'deny', reason)}>
          {no}
        </Button>
        {/* Not yet (#140): quieter than an answer, because it is not one. */}
        {onExtend &&
          EXTEND_CHOICES.map((minutes) => (
            <Button
              key={minutes}
              size="sm"
              disabled={!allowRun}
              onClick={() => onExtend(approval.id, minutes)}
            >
              {extendLabel(minutes)}
            </Button>
          ))}
      </div>

      {!asking && approval.suggestedRule && (
        <div className="mt-2">
          <button
            type="button"
            className="text-2xs text-ink-muted underline"
            aria-expanded={showRule}
            onClick={() => setShowRule(!showRule)}
          >
            {showRule ? '▾' : '▸'} Stop asking about this
          </button>
          {showRule && (
            <div className="mt-2 flex flex-col gap-2 rounded border border-rule bg-ground p-2">
              <label className="text-2xs text-ink-faint" htmlFor={`rule-${approval.id}`}>
                The rule that gets written — check it before it goes in:
              </label>
              <input
                id={`rule-${approval.id}`}
                className="h-8 [@media(hover:none)]:min-h-(--tap-min) w-full rounded border border-rule bg-surface px-2 font-mono text-2xs"
                value={rule}
                spellCheck={false}
                onChange={(e) => setRule(e.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={!allowRun || !rule.trim()}
                  onClick={() => onDecide(approval.id, 'allow', reason, 'plan', rule.trim())}
                >
                  Always for {approval.slug}
                </Button>
                <Button
                  size="sm"
                  disabled={!allowRun || !rule.trim()}
                  onClick={() => onDecide(approval.id, 'allow', reason, 'global', rule.trim())}
                >
                  Always everywhere
                </Button>
              </div>
              <p className="max-w-prose text-2xs text-ink-faint">
                Allows and answers this call in one step. Written with your name on it and recorded in the
                run's journal; removable from Settings → Permissions.
              </p>
            </div>
          )}
        </div>
      )}

      {!allowRun && (
        <p className="mt-2 text-2xs text-ink-faint">
          This console cannot answer — it was started without <code className="font-mono">--allow-run</code>.
        </p>
      )}
    </article>
  );
}
