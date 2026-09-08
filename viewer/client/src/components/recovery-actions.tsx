/**
 * Every way forward, rendered ONE way.
 *
 * The pages used to hand-roll four different subsets of the same five verbs —
 * halt banner, next-steps, phase row, diagnosis — under five word-books, and
 * the two AI mechanisms ("Fix with AI" vs "Finish this phase") sat side by
 * side with nothing saying how they differ. This component renders the shared
 * model's answer (`recoveryActionsFor`) for whatever context a surface holds:
 * grouped primary → secondary → overflow, every action carrying the exact
 * "what will happen" blurb (hover tooltip on desktop, a tappable ⓘ on touch),
 * disabled-with-reason rather than absent, and one live-session chip instead
 * of two differently-named buttons silently sharing one session.
 */

import { useMemo, useState } from 'react';
import { Bot, ChevronDown } from 'lucide-react';
import { Button, InfoTip, Tooltip, TooltipProvider } from '@/components/ui';
import { sessionsHref } from '@/app/routes';
import { LaunchDialog } from '@/features/run-setup/lazy-launch-dialog';
import { ErrandCard, LadderStrip } from '@/components/errand';
import { useConsoleState, useSessions } from '@/lib/queries';
import { ladderView } from '@/lib/ladder';
import type { Errand, RecoverySlot } from '@/lib/api';
import { useTouch } from '@/lib/media';
import {
  MECHANISMS,
  MECHANISM_LEGEND,
  RECOVERY_TITLES,
  liveRecovery,
  recoveryActionsFor,
  type RecoveryClass,
} from '@/lib/recovery';
import { runRecoverVerb, type RunRecoverVerb } from '@/lib/run-recover';
import { cn } from '@/lib/cn';
import { EFFORTS } from '@/features/runs/defaults';
import { SwitchAccountRow } from '@/components/switch-account';

/**
 * The placeholder for the addendum box, prefilled from what actually went
 * wrong.
 *
 * Not the addendum itself — a prefilled VALUE would be submitted by anyone who
 * pressed the button without reading, and "the halt reason, repeated back to
 * the session that caused it" is not an instruction. As a placeholder it does
 * the useful half: it reminds the operator what they are answering.
 */
function failureHint(ctx: RecoveryCtx): string {
  const reason = ctx.run?.halt?.reason ?? ctx.record?.status;
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
    /** The classifier's cached word on the phase (`PhaseRecord.situation`) — the strip reads it. */
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
   * The classifier's situation for the phase (the diagnosis endpoint's), when
   * the surface holds it. Leads the ordering (`leadActionFor`) and names the
   * strip; absent, the record's cached situation or the rung history speaks.
   */
  situation?: { id: string; sub?: string } | null;
};

type ActionView = {
  id: string;
  mechanism: keyof typeof MECHANISMS;
  label: string;
  blurb: string;
  group: 'primary' | 'secondary' | 'overflow';
  recoveryClass?: string;
  disabledReason?: string;
};

const RUN_VERBS = new Set<string>([
  'recheck',
  'closeout',
  'resume',
  'retry',
  'retry-edits',
  'skip',
  'mcp-continue',
  'auto-recover',
]);

export function RecoveryActions({
  target,
  ctx,
  max = 2,
  legend = false,
  showBlurbs = false,
  account = false,
  perform,
  className,
}: {
  /** What the actions are about — the ticket, the verbs and the dedupe key all use it. */
  target: { slug: string; phase?: number; runId?: string };
  ctx: RecoveryCtx;
  /** How many non-overflow actions render inline; the rest fold into "More ways forward". */
  max?: number;
  /**
   * Offer the account this repair will spend.
   *
   * Opt-in because this component is embedded on ten surfaces and most of them
   * are a row of buttons in a table cell, where a select would be noise. It
   * belongs where a repair is the headline — the run page and the phase drawer
   * — because every verb below except "repair with a new agent" fires straight
   * away on the run's stored account, with no dialog to change it in.
   */
  account?: boolean;
  /** Show the two-mechanism legend when both AI families are on offer. */
  legend?: boolean;
  /** Render every blurb as visible text (the diagnosis panel) instead of tooltip-only. */
  showBlurbs?: boolean;
  /** Surface-owned verbs (continue-run, dismiss, release, force-release):
   * rendered only when the surface says how to perform them. */
  perform?: Partial<Record<string, () => void>>;
  className?: string;
}) {
  const touch = useTouch();
  const { data: state } = useConsoleState();
  const { data: sessions } = useSessions(state);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<RecoveryClass | null>(null);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [editsOpen, setEditsOpen] = useState(false);
  const [addendum, setAddendum] = useState('');
  // '' means "unchanged" for both — the same empty-string-inherits convention
  // the per-phase table uses, so an operator who opens the panel and types only
  // words gets a retry that changed only the words.
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');

  const running = liveRecovery(sessions?.sessions, target);
  // The ladder's own story for this target: what it tried, what it does now,
  // what it tries next — or the one errand it left. Empty for a resolved run.
  const ladder = useMemo(
    () =>
      ladderView({
        run: ctx.run,
        phase: target.phase,
        situation: ctx.situation,
        record: ctx.record,
      }),
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

  if (!actions.length && !running && ladder.empty) return null;

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
    if (action.id === 'resume') {
      setResumeOpen((open) => !open);
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

  const renderButton = (action: ActionView, variant: 'action' | 'default') => {
    const button = (
      <Button
        size="sm"
        variant={action.disabledReason ? 'default' : variant}
        disabled={Boolean(action.disabledReason) || busy === action.id}
        onClick={() => act(action)}
        aria-label={action.label}
        // `h-auto` with its own padding, because a label that may wrap needs
        // somewhere to wrap INTO — `size="sm"` is a fixed `h-7`, and a second
        // line inside it paints over the row below. See the span around this.
        className="h-auto py-1 whitespace-normal"
      >
        {action.mechanism === 'new-agent' && <Bot size={13} aria-hidden />}
        {busy === action.id ? 'Working…' : action.label}
        <span className="ml-0.5 text-2xs font-normal text-ink-faint" aria-hidden>
          {MECHANISMS[action.mechanism].badge}
        </span>
      </Button>
    );
    return (
      // `min-w-0` and a label that may wrap — the safety net under the run
      // phase table's declared `actions` track. The group around these already
      // wraps, which does nothing when ONE item is wider than the cell: a
      // `whitespace-nowrap` button is an unbreakable box, so it escapes the
      // track instead and takes the table's sticky header with it. The track is
      // still declared against the widest label there is; this is what happens
      // when a new verb is longer than the last one measured.
      <span key={action.id} className="inline-flex min-w-0 items-center gap-0.5">
        <Tooltip content={action.disabledReason ?? action.blurb}>
          {/* The span keeps the tooltip reachable on a DISABLED button —
              Radix triggers never fire on disabled elements. */}
          <span className="inline-flex" tabIndex={action.disabledReason ? 0 : undefined}>
            {button}
          </span>
        </Tooltip>
        {touch && <InfoTip content={action.disabledReason ?? action.blurb} label={`About ${action.label}`} />}
      </span>
    );
  };

  return (
    // Its own provider, so the component is whole wherever it is dropped —
    // it is embedded on ten surfaces, and half their test harnesses mount
    // without the app shell. Nesting under the app's provider is fine.
    <TooltipProvider delayDuration={300}>
      <div className={cn('flex flex-col gap-2', className)}>
        {/* The machine's account of itself comes first: a person reading Ways
          forward should know what was already tried before pressing anything
          — and when the ladder is spent, the ONE errand is the headline. */}
        {ladder.errand && <ErrandCard errand={ladder.errand} situationLabel={ladder.situation?.label} />}
        <LadderStrip view={ladder} />
        <div className="flex flex-wrap items-center gap-2">
          {running && (
            <Button size="sm" variant="default" asChild>
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
          {inline.map((action, index) =>
            renderButton(action, index === 0 && action.group === 'primary' ? 'action' : 'default'),
          )}
        </div>

        {account && <SwitchAccountRow slug={target.slug} run={ctx.run ?? null} disabled={false} />}

        {resumeOpen && (
          <div className="flex flex-wrap items-end gap-2">
            <textarea
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              rows={2}
              placeholder="What it should fix before closing out…"
              className="min-h-16 w-full max-w-xl rounded border border-rule bg-ground px-2 py-1 text-sm"
            />
            <Button
              size="sm"
              variant="action"
              disabled={!instruction.trim() || busy === 'resume'}
              onClick={() => {
                setBusy('resume');
                void runRecoverVerb('resume', target, { instruction: instruction.trim() })
                  .then((ok) => {
                    if (ok) {
                      setResumeOpen(false);
                      setInstruction('');
                    }
                  })
                  .finally(() => setBusy(null));
              }}
            >
              {busy === 'resume' ? 'Resuming…' : 'Resume with this'}
            </Button>
          </div>
        )}

        {editsOpen && (
          <div className="flex flex-col gap-2 rounded border border-rule bg-ground/40 p-2">
            <label className="text-2xs text-ink-muted" htmlFor="retry-addendum">
              What this attempt should do differently
            </label>
            <textarea
              id="retry-addendum"
              value={addendum}
              onChange={(event) => setAddendum(event.target.value)}
              rows={3}
              placeholder={failureHint(ctx)}
              className="min-h-20 w-full max-w-xl rounded border border-rule bg-ground px-2 py-1 text-sm"
            />
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-0.5 text-2xs text-ink-muted">
                Model
                <select
                  aria-label="Model for this attempt"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  className="h-7 w-40 rounded border border-rule bg-ground px-1 text-2xs"
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
                </select>
              </label>
              <label className="flex flex-col gap-0.5 text-2xs text-ink-muted">
                Effort
                <select
                  aria-label="Effort for this attempt"
                  value={effort}
                  onChange={(event) => setEffort(event.target.value)}
                  className="h-7 w-32 rounded border border-rule bg-ground px-1 text-2xs"
                >
                  <option value="">unchanged</option>
                  {EFFORTS.filter(Boolean).map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                size="sm"
                variant="action"
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
            <p className="max-w-prose text-2xs text-ink-faint">
              This attempt only. Nothing here is written to the plan, and the next retry starts from the plan
              again.
            </p>
          </div>
        )}

        {rest.length > 0 && (
          <details className="text-sm">
            <summary className="flex min-h-(--tap-min) w-fit cursor-pointer select-none items-center gap-1 text-2xs text-ink-muted sm:min-h-0">
              <ChevronDown size={12} aria-hidden /> More ways forward ({rest.length})
            </summary>
            <ul className="mt-1 flex flex-col gap-2 border-l border-rule pl-3">
              {rest.map((action) => (
                <li key={action.id} className="flex flex-col gap-0.5">
                  <div>{renderButton(action, 'default')}</div>
                  <p className="max-w-prose text-2xs text-ink-faint">
                    {action.disabledReason ?? action.blurb}
                  </p>
                </li>
              ))}
            </ul>
          </details>
        )}

        {showBlurbs && inline.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            {inline.map((action) => (
              <li key={action.id} className="max-w-prose text-2xs text-ink-faint">
                <strong className="font-medium text-ink-muted">{action.label}:</strong>{' '}
                {action.disabledReason ?? action.blurb}
              </li>
            ))}
          </ul>
        )}

        {legend && bothFamilies && <p className="max-w-prose text-2xs text-ink-faint">{MECHANISM_LEGEND}</p>}

        {dialog && (
          <LaunchDialog
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
