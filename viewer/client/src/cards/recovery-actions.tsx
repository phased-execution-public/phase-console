/**
 * Every way forward, rendered ONE way (7.0 in quiet-console phase 5).
 *
 * This component renders the shared model's answer (`recoveryActionsFor`) for
 * whatever context a surface holds: the recommended verb first and solid,
 * then the next, and everything else folded behind *More ways forward* —
 * every action carrying the exact "what will happen" blurb (a hover tooltip on
 * a desk, a tappable ⓘ on touch), disabled-with-reason rather than absent, and
 * one live-session chip instead of two differently-named buttons silently
 * sharing one session.
 *
 * A repair agent is launched through the one launch door (`screens/launch/door`),
 * fetched when the press opens it. The account a repair spends is drawn by
 * `screens/settings/account-row.tsx` (phase 22), and a surface LENDS it (`parts`).
 */

import { useMemo, useState, type ComponentType } from 'react';
import { Bot } from 'lucide-react';
import { haltReasonOf } from '@shared/halt-categories.js';
import { MECHANISMS, MECHANISM_LEGEND, RECOVERY_TITLES, recoveryActionsFor } from '@shared/recovery-model.js';
import { EFFORT_LEVELS } from '@shared/run-settings.js';
import type { Errand, RecoverySlot } from '@/data/api';
import { useConsoleState } from '@/data/console';
import { LaunchDoor } from '@/screens/launch/door';
import { useSessions } from '@/data/sessions';
import { cn } from '@/lib/cn';
import { ladderView } from '@/lib/ladder';
import { useTouch } from '@/lib/media';
import { liveRecovery, type RecoveryClass } from '@/lib/recovery';
import { RUN_RECOVER_VERBS } from '@/lib/run-recover-verbs';
import { sessionsHref } from '@/shell/routes';
import { Button, Label } from '@/ui';
import { Disclosure } from '@/ui/disclosure';
import { NativeSelect } from '@/ui/native-select';
import { Textarea } from '@/ui/textarea';
import { InfoTip, Tooltip, TooltipProvider } from '@/ui/tooltip';
import { ErrandCard, LadderStrip } from './errand';
import { runRecoverVerb, type RunRecoverVerb } from './recover';

/**
 * The placeholder for the addendum box, prefilled from what actually went
 * wrong — a placeholder, never the value: a prefilled VALUE would be submitted
 * by anyone who pressed without reading, and "the halt reason, repeated back to
 * the session that caused it" is not an instruction.
 */
function failureHint(ctx: RecoveryCtx): string {
  const reason = haltReasonOf(ctx.run?.halt) ?? ctx.record?.status;
  const short = typeof reason === 'string' && reason.length > 90 ? `${reason.slice(0, 90)}…` : reason;
  return short
    ? `It stopped on: ${short}\n\nWhat should this attempt do differently?`
    : 'What should this attempt do differently?';
}

/** What a surface knows; everything optional — the model tolerates absence. */
export type RecoveryCtx = {
  boardState?: string;
  record?: {
    status: string;
    resumable?: boolean;
    /** The classifier's cached word on the phase (`PhaseRecord.situation`). */
    situation?: { key: string } | undefined;
  } | null;
  run?: {
    status: string;
    /** Which account it spends — what the account row shows and moves. */
    accountId?: string;
    halt?: { reason?: string; kind?: string; phase?: number } | null;
    resolved?: unknown;
    /** The ladder's bookkeeping per phase — rungs climbed, the errand left. */
    recoveries?: Record<string, RecoverySlot> | undefined;
    /** The run-level errand (a wall with no phase to hang it on). */
    errand?: Errand | null | undefined;
  } | null;
  lock?: { holder?: string | null; expired?: boolean };
  authFailure?: boolean;
  /** The plan itself fails lint/health — plan-repair's own case. */
  planIssues?: boolean;
  /**
   * The classifier's situation for the phase, when the surface holds it. Leads
   * the ordering and names the ladder; absent, the record's cached situation
   * or the rung history speaks.
   */
  situation?: { id: string; sub?: string } | null;
};

/** The piece of a recovery a surface lends it — the account row (`ACCOUNT_RECOVERY_PARTS`). */
export interface RecoveryParts {
  /** The account a repair spends, where a repair is the headline (`account`). */
  AccountRow?: ComponentType<{ slug: string; run: RecoveryCtx['run'] }>;
}

type ActionView = {
  id: string;
  mechanism: keyof typeof MECHANISMS;
  label: string;
  blurb: string;
  group: 'primary' | 'secondary' | 'overflow';
  recoveryClass?: string;
  disabledReason?: string;
};

const RUN_VERBS = new Set<string>(RUN_RECOVER_VERBS);

/** The verbs that open a box for words first: Resume needs them, Delegate and Done take them. */
type WordsVerb = 'resume' | 'delegate' | 'errand-answered';

const WORDS: Record<WordsVerb, { label: string; placeholder: string; go: string; going: string }> = {
  resume: {
    label: 'Your instruction',
    placeholder: 'What it should fix before closing out…',
    go: 'Resume with this',
    going: 'Resuming…',
  },
  delegate: {
    label: 'Your words to the session',
    placeholder: 'Anything it should know about these acts (optional)…',
    go: 'Delegate the acts',
    going: 'Delegating…',
  },
  'errand-answered': {
    label: 'What you did',
    placeholder: 'What you did, for the session to read (optional)…',
    go: 'Done — continue',
    going: 'Continuing…',
  },
};

export function RecoveryActions({
  target,
  ctx,
  max = 2,
  legend = false,
  showBlurbs = false,
  account = false,
  perform,
  bare = false,
  leadTestId,
  parts = {},
  className,
}: {
  /** What the actions are about — the ticket, the verbs and the dedupe key all use it. */
  target: { slug: string; phase?: number; runId?: string };
  ctx: RecoveryCtx;
  /** How many non-overflow actions render inline; the rest fold into *More ways forward*. */
  max?: number;
  /**
   * Offer the account this repair will spend — where a repair is the headline
   * (the run page, the phase drawer), because every verb but a new agent fires
   * straight away on the run's stored account. Drawn by `parts.AccountRow`.
   */
  account?: boolean;
  /** Say how the two AI families differ when both are on offer. */
  legend?: boolean;
  /** Every blurb as visible text (the diagnosis panel), not only on hover. */
  showBlurbs?: boolean;
  /** Surface-owned verbs (continue-run, dismiss, release, force-release): offered only when the surface performs them. */
  perform?: Partial<Record<string, () => void>>;
  /** Buttons only — no errand card and no ladder (a row that links to the full card). */
  bare?: boolean;
  /** `data-testid` for the RECOMMENDED button — the first inline one, when the model put it first. */
  leadTestId?: string;
  /** What the surface lends: the account row. */
  parts?: RecoveryParts;
  className?: string;
}) {
  const touch = useTouch();
  const { data: state } = useConsoleState();
  const { data: sessions } = useSessions(state);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<RecoveryClass | null>(null);
  const [wordsFor, setWordsFor] = useState<WordsVerb | null>(null);
  const [instruction, setInstruction] = useState('');
  const [editsOpen, setEditsOpen] = useState(false);
  const [addendum, setAddendum] = useState('');
  // '' means "unchanged" for both — an operator who opens the panel and types
  // only words gets a retry that changed only the words.
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const { AccountRow } = parts;

  const running = liveRecovery(sessions?.sessions, target);
  // The ladder's own story for this target: what it tried, what it does now,
  // what it tries next — or the one errand it left. Empty for a resolved run.
  const ladder = useMemo(
    () => ladderView({ run: ctx.run, phase: target.phase, situation: ctx.situation, record: ctx.record }),
    [ctx.run, ctx.situation, ctx.record, target.phase],
  );
  const actions = useMemo(
    () =>
      (
        recoveryActionsFor({
          ...ctx,
          flags: {
            allowRun: Boolean(state?.allowRun),
            allowWrites: Boolean(state?.allowWrites),
            allowAgent: Boolean(state?.allowAgent),
          },
          live: { recoverySessionId: running?.id ?? null },
        }) as ActionView[]
      ).filter((action) => RUN_VERBS.has(action.id) || action.id === 'fix-agent' || perform?.[action.id]),
    [ctx, state, running?.id, perform],
  );

  if (!actions.length && !running && (bare || ladder.empty)) return null;

  const inline = actions.filter((action) => action.group !== 'overflow').slice(0, max);
  const rest = actions.filter((action) => !inline.includes(action));
  const bothFamilies =
    actions.some((action) => action.mechanism === 'own-session') &&
    actions.some((action) => action.mechanism === 'new-agent');

  const act = (action: ActionView) => {
    if (action.disabledReason) return;
    if (action.id === 'fix-agent' && action.recoveryClass) {
      setDialog(action.recoveryClass as RecoveryClass);
      return;
    }
    if (action.id === 'resume' || action.id === 'delegate' || action.id === 'errand-answered') {
      const verb = action.id;
      setWordsFor((open) => (open === verb ? null : verb));
      return;
    }
    if (action.id === 'retry-edits') {
      setEditsOpen((open) => !open);
      return;
    }
    if (perform?.[action.id]) {
      perform[action.id]!();
      return;
    }
    if (!RUN_VERBS.has(action.id)) return;
    setBusy(action.id);
    void runRecoverVerb(action.id as RunRecoverVerb, target).finally(() => setBusy(null));
  };

  const renderButton = (action: ActionView, lead = false) => (
    // `min-w-0` and a label that may wrap: a button wider than its cell would
    // escape the track it sits in rather than break onto a second line. The
    // kit's button never shrinks (`shrink-0`, so a toolbar never squeezes an
    // icon), which here is exactly the escape: a 245 px label kept its width
    // in a 148 px cell at 360 (the register's plan-phases stop). So THIS
    // button shrinks, and its words wrap instead.
    <span key={action.id} className="inline-flex min-w-0 items-center gap-0.5">
      <Tooltip content={action.disabledReason ?? action.blurb}>
        {/* The span keeps the tooltip reachable on a DISABLED button —
            Radix triggers never fire on disabled elements. */}
        <span className="inline-flex min-w-0" tabIndex={action.disabledReason ? 0 : undefined}>
          <Button
            size="sm"
            {...(lead && leadTestId ? { 'data-testid': leadTestId, 'data-recommended': action.id } : {})}
            variant={lead && !action.disabledReason ? 'primary' : 'default'}
            disabled={Boolean(action.disabledReason) || busy === action.id}
            onClick={() => act(action)}
            aria-label={action.label}
            className="h-auto min-h-7 shrink whitespace-normal py-1 text-start"
          >
            {action.mechanism === 'new-agent' && <Bot size={13} aria-hidden className="shrink-0" />}
            {busy === action.id ? 'Working…' : action.label}
            <span className="font-normal" aria-hidden>
              {MECHANISMS[action.mechanism].badge}
            </span>
          </Button>
        </span>
      </Tooltip>
      {touch && <InfoTip content={action.disabledReason ?? action.blurb} label={`About ${action.label}`} />}
    </span>
  );

  const words = wordsFor ? WORDS[wordsFor] : null;

  return (
    // Its own provider, so the component is whole wherever it is dropped.
    <TooltipProvider delayDuration={300}>
      <div className={cn('flex min-w-0 flex-col gap-3', className)}>
        {/* The machine's account of itself comes first: what was already tried
            before anything is pressed — and when the ladder is spent, the ONE
            errand is the headline. */}
        {!bare && ladder.errand && (
          <ErrandCard
            errand={ladder.errand}
            situationLabel={ladder.situation?.label}
            scope={{ slug: target.slug, runId: target.runId }}
          />
        )}
        {!bare && <LadderStrip view={ladder} />}

        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {running && (
            <Button size="sm" asChild>
              <a
                href={sessionsHref(running.id)}
                title="The recovery session already working on this — open it."
              >
                <Bot size={13} aria-hidden />
                {(RECOVERY_TITLES as Record<string, string>)[running.meta?.recovery?.kind ?? ''] ??
                  'Recovery'}{' '}
                — running
              </a>
            </Button>
          )}
          {inline.map((action, index) => renderButton(action, index === 0 && action.group === 'primary'))}
        </div>

        {account && AccountRow && <AccountRow slug={target.slug} run={ctx.run ?? null} />}

        {wordsFor && words && (
          <div className="flex min-w-0 flex-col gap-2">
            <Textarea
              block
              rows={2}
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              aria-label={words.label}
              placeholder={words.placeholder}
              className="max-w-xl"
            />
            <Button
              size="sm"
              variant="primary"
              className="self-start"
              disabled={(wordsFor === 'resume' && !instruction.trim()) || busy === wordsFor}
              onClick={() => {
                const verb = wordsFor;
                setBusy(verb);
                void runRecoverVerb(verb, target, { instruction: instruction.trim() })
                  .then((ok) => {
                    if (!ok) return;
                    setWordsFor(null);
                    setInstruction('');
                  })
                  .finally(() => setBusy(null));
              }}
            >
              {busy === wordsFor ? words.going : words.go}
            </Button>
          </div>
        )}

        {editsOpen && (
          <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-rule bg-surface p-3">
            <Label htmlFor="retry-addendum" className="text-meta">
              What this attempt should do differently
            </Label>
            <Textarea
              id="retry-addendum"
              block
              rows={3}
              value={addendum}
              onChange={(event) => setAddendum(event.target.value)}
              placeholder={failureHint(ctx)}
              className="max-w-xl"
            />
            <div className="flex min-w-0 flex-wrap items-end gap-2">
              <label className="flex min-w-0 flex-col gap-1 text-meta text-ink-muted">
                Model
                <NativeSelect
                  aria-label="Model for this attempt"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                >
                  <option value="">unchanged</option>
                  {/* The SERVER's list, never a copy of one: a second model
                      vocabulary in the client is the drift `single-source.test`
                      exists to refuse. */}
                  {(state?.models ?? []).map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <label className="flex min-w-0 flex-col gap-1 text-meta text-ink-muted">
                Effort
                <NativeSelect
                  aria-label="Effort for this attempt"
                  value={effort}
                  onChange={(event) => setEffort(event.target.value)}
                >
                  <option value="">unchanged</option>
                  {EFFORT_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <Button
                size="sm"
                variant="primary"
                disabled={busy === 'retry-edits' || (!addendum.trim() && !model && !effort)}
                onClick={() => {
                  setBusy('retry-edits');
                  const options = { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
                  void runRecoverVerb('retry-edits', target, {
                    edits: {
                      ...(addendum.trim() ? { addendum: addendum.trim() } : {}),
                      ...(Object.keys(options).length ? { options } : {}),
                    },
                  })
                    .then((ok) => {
                      if (!ok) return;
                      setEditsOpen(false);
                      setAddendum('');
                      setModel('');
                      setEffort('');
                    })
                    .finally(() => setBusy(null));
                }}
              >
                {busy === 'retry-edits' ? 'Re-boarding…' : 'Retry with these'}
              </Button>
            </div>
            <p className="max-w-prose text-meta text-ink-muted">
              This attempt only. Nothing here is written to the plan, and the next retry starts from the plan
              again.
            </p>
          </div>
        )}

        {rest.length > 0 && (
          <Disclosure label="More ways forward" openLabel="Fewer ways forward" count={rest.length}>
            <ul className="mt-2 flex min-w-0 flex-col gap-2.5 border-s border-rule ps-3">
              {rest.map((action) => (
                <li key={action.id} className="flex min-w-0 flex-col items-start gap-1">
                  {renderButton(action)}
                  <p className="max-w-prose text-meta text-ink-muted">
                    {action.disabledReason ?? action.blurb}
                  </p>
                </li>
              ))}
            </ul>
          </Disclosure>
        )}

        {showBlurbs && inline.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            {inline.map((action) => (
              <li key={action.id} className="max-w-prose text-meta text-ink-muted">
                <span className="font-medium text-ink">{action.label}:</span>{' '}
                {action.disabledReason ?? action.blurb}
              </li>
            ))}
          </ul>
        )}

        {legend && bothFamilies && <p className="max-w-prose text-meta text-ink-muted">{MECHANISM_LEGEND}</p>}

        {dialog && (
          <LaunchDoor
            request={{
              kind: 'recovery',
              recoveryClass: dialog,
              slug: target.slug,
              ...(target.phase != null ? { phase: target.phase } : {}),
              ...(target.runId ? { runId: target.runId } : {}),
            }}
            onClose={() => setDialog(null)}
          />
        )}
      </div>
    </TooltipProvider>
  );
}
