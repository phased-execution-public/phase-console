/**
 * A phase row, opened in place: why the phase is where it is, and what moves it.
 *
 * What costs nothing is drawn at once — the runner's own words on the record,
 * the phase's QA with its regime, rounds and verbs, its labelled clocks. What
 * costs a subprocess is behind ONE press: "Why is this not done?" fetches the
 * diagnosis (`GET /api/run/:slug/diagnosis/:phase` — a `git status` and two
 * script runs) only once it is opened, because most rows never are. Under it:
 * the situation the healer read and its evidence, what the lane did last and is
 * doing now, the gate, claimed versus evidenced, what failed with its output,
 * what was red before the phase began, the rulings this phase recorded (and the
 * way to make one a standing answer), the notes earlier phases left, the issues
 * its sessions filed, and every way forward. The phase's own prose and its
 * handoff's facts close the detail, fetched on open as well.
 */

import { Fragment, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { TerminalSquare } from 'lucide-react';
import { RULING_KIND_LABELS, inboxItemId } from '@shared/attention-model.js';
import { wallReading } from '@shared/situation-model.js';
import {
  api,
  type HandoffRow,
  type Issue,
  type PhaseEta,
  type PhaseRecord,
  type PhaseView,
  type Ruling,
  type RulingKind,
  type RunState,
} from '@/data/api';
import { useConsoleState } from '@/data/console';
import { keys } from '@/data/keys';
import { usePlan } from '@/data/plans';
import { press } from '@/data/press';
import { useIssues } from '@/data/repo';
import { useDiagnosis, useRulings } from '@/data/runs';
import { useSessions } from '@/data/sessions';
import { cn } from '@/lib/cn';
import { useNow } from '@/ui/clock';
import { clockTime, clockWords, countdown, plural, relativeTime } from '@/lib/format';
import { canQa, isVerdict, liveQa, phaseQaMode, qaReportHref, qaReportRound } from '@/lib/qa';
import { qaResultTitle } from '@/lib/status-vocab';
import { Button, KeyValue, RelativeTime, SectionHeading, toast } from '@/ui';
import { Accordion, AccordionItem } from '@/ui/accordion';
import { Disclosure } from '@/ui/disclosure';
import { OpsStatus, QaStatus, type WordOf } from '@/ui/status';
import { RecoveryActions } from '@/cards/recovery-actions';
import { TreeLine, verdictTree } from '@/cards/verify-tree';
import { handoffHref, laneHref, navigate, sessionsHref } from '@/shell/routes';
import { recordClocks, phaseClockList } from '@/screens/runs/model';
import { ACCOUNT_RECOVERY_PARTS } from '@/screens/settings/account-row';
import { LastActivity, NowPanel } from '../run/activity';
import { PROSE_INCLUDES } from '../tabs';
import { PhaseDetails } from './cells';
import { PhaseGate } from './gate-card';
import { mcpCallWords } from './model';
import { NotesSection } from './notes';
import { QaButton, QaRecoveryActions, QaRounds } from './qa-launcher';
import { QaModeControl } from './qa-mode';
import { EvidenceWords } from './row';
import { SituationSummary } from './situation';

const RULING_LABEL = RULING_KIND_LABELS as Record<RulingKind, string>;

/** The inbox id of a ruling row — exactly what `server/inbox.ts` mints; nothing here knows the escaping. */
const rulingItemId = (ruling: Ruling): string =>
  (inboxItemId as (item: Record<string, unknown>) => string)({
    kind: 'ruling',
    slug: ruling.slug,
    phase: ruling.phase,
    subject: ruling.id,
  });

const BLOCKED_ON: Record<string, string> = {
  board: 'the board — no handoff, or it is not marked complete',
  verification: 'the verification commands',
  lint: 'validate.sh',
};

const PRE =
  'mt-1 max-h-56 overflow-auto rounded-(--radius) bg-ground-deep px-2 py-1.5 font-mono text-meta whitespace-pre-wrap';

export interface PhaseDrawerProps {
  slug: string;
  phase: number;
  /** The run, for the kind-aware order of the ways forward. */
  run?: RunState | null;
  /** The phase as the board reads it — given, the drawer carries its QA. */
  view?: PhaseView;
  /** This run's record of the phase. */
  record?: PhaseRecord | undefined;
  /** The phases this phase's verdict holds (`PlanDetail.qaHeld`). */
  holds?: readonly number[];
  eta?: PhaseEta | undefined;
  /** The handoff file's own row, and INDEX.md's word for it. */
  handoff?: HandoffRow | undefined;
  index?: string | undefined;
  planQaMode?: string;
  planSkills?: readonly string[];
  /**
   * `record` when the reading the drawer opens from IS the phase's record
   * (Handoffs & QA): the handoff and the QA lead the row's detail as two
   * cards (`PhaseRecord`), so the drawer leaves them out below.
   */
  lead?: 'record' | undefined;
}

export function PhaseDrawer({
  slug,
  phase,
  run,
  view,
  record,
  holds,
  eta,
  handoff,
  index,
  planQaMode,
  planSkills,
  lead,
}: PhaseDrawerProps) {
  const r = record ?? run?.phases?.[String(phase)];
  const recordLeads = lead === 'record';
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid={`phase-drawer-${phase}`}>
      {r && <RunnerWords record={r} />}
      {view && !recordLeads && (
        <QaSection
          slug={slug}
          view={view}
          holds={holds ?? view.qaHeld ?? []}
          run={run ?? null}
          {...(planQaMode ? { planQaMode } : {})}
          planSkills={planSkills ?? []}
        />
      )}
      {r && <PhaseClocks record={r} />}
      {/* A fold strip: its one line says what the drawer already knows, and
          opening it is the request (the diagnosis is fetched only then). */}
      <Accordion>
        <AccordionItem
          value="why"
          label="Why is this not done?"
          summary={whySummary(r, view)}
          testId={`why-${phase}`}
          bodyClassName="pt-1"
        >
          <Diagnosis slug={slug} phase={phase} run={run ?? null} />
        </AccordionItem>
      </Accordion>
      {view && !recordLeads && <HandoffFacts slug={slug} view={view} handoff={handoff} index={index} />}
      {view && <PhaseProse slug={slug} phase={view} eta={eta} />}
    </div>
  );
}

/** The diagnosis fold's one line, from what the drawer holds already — opening the fold is what costs. */
function whySummary(record: PhaseRecord | undefined, view: PhaseView | undefined): string {
  if (view?.state === 'done') return 'the board reads it done';
  if (record?.verification && !record.verification.ok) return 'a verification command failed';
  if (record?.halt) return `the run halted${record.halt.kind ? `, ${record.halt.kind}` : ''}`;
  if (record?.status) return `this run reads it ${record.status}`;
  return 'the situation, what failed and every way forward';
}

/* ---------------- the record, as two cards ---------------- */

const RECORD_CARD = 'flex min-w-0 flex-col gap-2 rounded-lg border border-rule bg-surface px-3 py-2.5';

/**
 * A phase's record — what its session said it did, and what the review found
 * — as two cards that lead the row's detail on the Handoffs & QA reading
 * (2026-10-20, Tower strips): side by side once the detail has 40 rem to give
 * (a container query, so a row in the panel or on a narrow page stacks them),
 * stacked below that. Each card's status is its one LEAD badge: the handoff's
 * word, the verdict.
 */
export function PhaseRecord({
  slug,
  view,
  run,
  holds,
  handoff,
  index,
  planQaMode,
  planSkills,
}: {
  slug: string;
  view: PhaseView;
  run?: RunState | null | undefined;
  holds?: readonly number[] | undefined;
  handoff?: HandoffRow | undefined;
  index?: string | undefined;
  planQaMode?: string | undefined;
  planSkills?: readonly string[] | undefined;
}) {
  return (
    <div className="@container/record min-w-0" data-testid={`phase-record-${view.phase}`}>
      <div className="grid min-w-0 gap-3 @min-[40rem]/record:grid-cols-2">
        <div className={RECORD_CARD} data-testid="record-handoff">
          <HandoffRecord slug={slug} view={view} handoff={handoff} index={index} />
        </div>
        <div className={RECORD_CARD} data-testid="record-qa">
          <QaSection
            slug={slug}
            view={view}
            holds={holds ?? view.qaHeld ?? []}
            run={run ?? null}
            {...(planQaMode ? { planQaMode } : {})}
            planSkills={planSkills ?? []}
            lead
          />
        </div>
      </div>
    </div>
  );
}

/** The handoff card: its word as the card's lead badge, then the file's own facts — or that none was written yet. */
function HandoffRecord({
  slug,
  view,
  handoff,
  index,
}: {
  slug: string;
  view: PhaseView;
  handoff?: HandoffRow | undefined;
  index?: string | undefined;
}) {
  const status = view.handoff?.status ?? handoff?.status;
  const completed = view.handoff?.completed ?? handoff?.completed;
  return (
    <section aria-label={`Handoff — phase ${view.phase}`} className="flex min-w-0 flex-col gap-2">
      <SectionHeading
        as="h4"
        aside={
          status ? <OpsStatus vocab="handoff" word={status as WordOf<'handoff'>} chrome="tint" /> : undefined
        }
      >
        Handoff
      </SectionHeading>
      {status ? (
        <>
          {completed && <p className="text-meta text-ink-muted tabular-nums">Completed {completed}</p>}
          <HandoffFacts slug={slug} view={view} handoff={handoff} index={index} />
        </>
      ) : (
        <p className="text-meta text-ink-muted">
          No handoff yet — the session writes one when it signs the phase off.
        </p>
      )}
    </section>
  );
}

/* ---------------- the runner's own words ---------------- */

/**
 * What the runner wrote on the record, in full: its note, a waiting phase's
 * park and watches, the verdict with the tree it judged, the steps a person
 * must check, the warnings boarding raised, the servers it ran without.
 */
function RunnerWords({ record: r }: { record: PhaseRecord }) {
  const anything =
    r.note ||
    r.status === 'waiting' ||
    r.verification ||
    r.preflight?.length ||
    r.mcpDegraded?.length ||
    (r.mcpPark && r.status === 'parked') ||
    (r.mcpCalls && Object.keys(r.mcpCalls).length);
  if (!anything) return null;
  const tree = verdictTree(r.verification);
  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-meta" data-testid="runner-words">
      {r.note && <p className="text-ink-muted">{r.note}</p>}
      {r.status === 'waiting' && <WaitWords record={r} />}
      {r.verification && (
        <p className={cn(r.verification.ok ? 'text-ink' : 'state-failed text-state')}>
          {r.verification.reason}
          {tree && <TreeLine tree={tree} />}
        </p>
      )}
      {r.verification?.notRun?.length ? (
        <Disclosure
          label={`${plural(r.verification.notRun.length, 'step')} a person must check`}
          openLabel="Hide them"
        >
          <ul className="flex flex-col gap-0.5">
            {r.verification.notRun.map((n, i) => (
              <li key={i}>
                <span className="font-mono">{n.text}</span> — {n.reason}
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
      {r.preflight?.length ? (
        <Disclosure
          label={`${plural(r.preflight.length, 'verification warning')} from boarding`}
          openLabel="Hide the warnings"
        >
          <ul className="flex flex-col gap-0.5">
            {r.preflight.map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
      {r.mcpDegraded?.length ? (
        <p className="text-ink">
          Ran without {r.mcpDegraded.map((d) => `${d.id} (${d.detail ?? d.reason})`).join(', ')} — the session
          was told to record what it could not do.
        </p>
      ) : null}
      {r.mcpPark && r.status === 'parked' ? <McpParkWords park={r.mcpPark} /> : null}
      {r.mcpCalls && Object.keys(r.mcpCalls).length ? (
        <p className="text-ink-muted">MCP servers it reached for: {mcpCallWords(r.mcpCalls)}.</p>
      ) : null}
    </div>
  );
}

/**
 * A waiting phase's park: whose park it is, why, when the runner resumes it —
 * a countdown that moves — and what each watched ref's last probe found.
 * Ticks every 30 s on its own: a waiting run has no live lane to move it.
 */
function WaitWords({ record: r }: { record: PhaseRecord }) {
  useNow(true, 30_000);
  const until = r.parkedUntil ? Date.parse(r.parkedUntil) : NaN;
  const clock = Number.isFinite(until) ? clockTime(until) : '';
  const rows = r.watchState?.refs ?? [];
  // The declared refs first, in their order; a ref the console minted beside
  // them is shown too, and marked, so it is never read as the session's.
  const refs = [
    ...(r.watch ?? []),
    ...rows.filter((row) => row.minted && !(r.watch ?? []).includes(row.ref)).map((row) => row.ref),
  ];
  const probe = (ref: string): string => {
    const row = rows.find((w) => w.ref === ref);
    if (!row) return 'not checked yet';
    const found = row.state === 'refused' && row.detail ? `refused: ${row.detail}` : row.state;
    return `${found}, checked ${relativeTime(Date.parse(row.checkedAt))}${row.minted ? ', the console’s' : ''}`;
  };
  return (
    <div className="flex min-w-0 flex-col gap-0.5 text-ink-muted" data-testid="wait-words">
      <p>
        {r.declared?.by === 'watchdog'
          ? 'Parked by the console — it was waiting inside its turn'
          : 'Waiting on external work'}
        {r.parkReason ? `: ${r.parkReason}` : ''}
        {clock
          ? until > Date.now()
            ? `. Resumes at ${clock}, ${countdown(until)}`
            : `. Was due to resume at ${clock}`
          : ''}
        {r.declared?.by === 'watchdog'
          ? r.watchdogParks
            ? ` (automatic park ${r.watchdogParks})`
            : ''
          : r.waits
            ? ` (wait ${r.waits})`
            : ''}
        .
      </p>
      {r.resumeRefused && (
        <p>
          The resume is held: session{' '}
          <span className="font-mono">{r.resumeRefused.sessionId.slice(0, 8)}</span> is still running.
        </p>
      )}
      {refs.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {refs.map((ref) => (
            <li key={ref} className="min-w-0 break-words">
              Watching <span className="font-mono">{ref}</span> — {probe(ref)}
            </li>
          ))}
        </ul>
      )}
      {r.watchUnpollable?.length ? (
        <p>
          Not watchable:{' '}
          {r.watchUnpollable.map((u, i) => (
            <Fragment key={u.ref}>
              {i > 0 ? ', ' : null}
              <span className="font-mono" title={u.reason}>
                {u.ref}
              </span>
            </Fragment>
          ))}
        </p>
      ) : null}
    </div>
  );
}

/** A `require` MCP park on its clock: when, on which servers, and when the phase continues without them. */
function McpParkWords({ park }: { park: NonNullable<PhaseRecord['mcpPark']> }) {
  const { data: state } = useConsoleState();
  const timeoutMs =
    typeof state?.prefs?.mcpRequireTimeoutMs === 'number' ? state.prefs.mcpRequireTimeoutMs : 1_800_000;
  const since = Date.parse(park.at);
  const servers = park.degraded.map((d) => d.id).join(', ') || 'an MCP server';
  const due = timeoutMs > 0 && Number.isFinite(since) ? since + timeoutMs : null;
  return (
    <p className="text-ink" data-testid="mcp-park">
      Parked on {servers} since {Number.isFinite(since) ? clockTime(since) : park.at}
      {due != null
        ? ` — continues without ${park.degraded.length === 1 ? 'it' : 'them'} at ${clockTime(due)} unless the server heals first (an errand is recorded then).`
        : ' — waits for the server to heal; no timeout is set (Settings, Automation).'}
    </p>
  );
}

/* ---------------- QA ---------------- */

/**
 * The phase's QA in one place (#27): the regime — ALWAYS with the level that
 * decided it, because a phase's own `QA:` bullet beats the plan's line — the
 * verdict and its round, what it holds and what holds it, what is live, every
 * round's report, and the verbs.
 */
function QaSection({
  slug,
  view,
  holds,
  run,
  planQaMode,
  planSkills,
  lead = false,
}: {
  slug: string;
  view: PhaseView;
  holds: readonly number[];
  run: RunState | null;
  planQaMode?: string;
  planSkills: readonly string[];
  /** A record card's QA: the verdict is the card's lead badge. */
  lead?: boolean;
}) {
  const { data: state } = useConsoleState();
  const { data: terminals } = useSessions(state);
  const phase = view.phase;
  const mode = phaseQaMode(view, planQaMode);
  const result = view.qa?.result;
  const rounds = view.qaRounds;
  const heldBy = (view.blockedBy ?? []).filter((b) => b.why.startsWith('qa:'));
  const lane = run?.phases?.[String(phase)]?.qaSession;
  const pty = lane ? undefined : liveQa(terminals?.sessions, { slug, phase });
  const allowWrites = Boolean(state?.allowWrites);
  const target = {
    slug,
    phase,
    title: view.title,
    model: view.model,
    effort: view.effort,
    ...(mode ? { qaMode: mode } : {}),
    ...(view.qa ? { qa: view.qa } : {}),
    planSkills: [...planSkills],
    planMcp: [...new Set(view.mcpServers ?? [])],
  };
  return (
    <section
      aria-label={`QA — phase ${phase}`}
      className="flex min-w-0 flex-col gap-2"
      data-testid="drawer-qa"
    >
      <SectionHeading as="h4">QA</SectionHeading>
      <KeyValue
        items={[
          [
            'Regime',
            <>
              <span className="font-mono">{mode ?? 'unknown'}</span>, decided by{' '}
              {view.qaMode?.source === 'phase' ? 'the phase’s own QA bullet' : 'the plan’s QA gate line'}
            </>,
          ],
          [
            'Verdict',
            isVerdict(result) ? (
              <span className="inline-flex flex-wrap items-center gap-x-2">
                <QaStatus
                  result={result as WordOf<'qa-result'>}
                  title={qaResultTitle(result!)}
                  {...(lead ? { chrome: 'tint' as const } : {})}
                />
                {rounds ? `round ${rounds.latest.round} of ${rounds.count}` : ''}
              </span>
            ) : result === 'pending' ? (
              'pending — nobody has reviewed it yet'
            ) : (
              'none recorded'
            ),
          ],
          holds.length ? ['Holds', `P${holds.join(', P')} — until this verdict changes`] : null,
          heldBy.length
            ? [
                'Held by',
                heldBy
                  .map((b) => `P${b.phase}’s verdict (${b.why.slice(3)}) — the engine says ${b.why}`)
                  .join('; '),
              ]
            : null,
          lane
            ? [
                'Live',
                <a href={laneHref(slug, phase)} className="text-ink underline-offset-2 hover:underline">
                  QA round {lane.round} is live
                </a>,
              ]
            : pty
              ? [
                  'Live',
                  <a href={sessionsHref(pty.id)} className="text-ink underline-offset-2 hover:underline">
                    a review is live
                  </a>,
                ]
              : null,
        ]}
      />
      {rounds && rounds.count > 0 && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta">
          <span className="text-ink-muted">Rounds on file:</span>
          {Array.from({ length: rounds.count }, (_, i) => i + 1).map((n) => (
            <a
              key={n}
              href={qaReportHref(slug, phase, n)}
              className="text-ink underline-offset-2 hover:underline"
            >
              round {n}
            </a>
          ))}
        </p>
      )}
      <QaRecoveryActions
        slug={slug}
        phase={phase}
        {...(mode ? { qaMode: mode } : {})}
        {...(view.qa ? { qa: view.qa } : {})}
        allowRun={Boolean(state?.allowRun)}
        allowWrites={allowWrites}
        {...(state?.scriptsDir ? { scriptsDir: state.scriptsDir } : {})}
        target={target}
      />
      <div className="flex flex-wrap items-center gap-2">
        {canQa(view.state) && (
          <QaButton
            label="Run QA"
            target={target}
            allowAgent={Boolean(state?.allowAgent)}
            allowWrites={allowWrites}
            {...(pty ? { runningSessionId: pty.id } : {})}
          />
        )}
        {(view.qa?.report || rounds) && (
          <Button size="sm" variant="default" asChild>
            <a href={qaReportHref(slug, phase, rounds?.latest.round)}>Open the report</a>
          </Button>
        )}
      </div>
      <QaModeControl
        slug={slug}
        {...(planQaMode ? { mode: planQaMode } : {})}
        phase={phase}
        {...(view.qaMode ? { phaseMode: view.qaMode } : {})}
        allowWrites={allowWrites}
        {...(state?.scriptsDir ? { scriptsDir: state.scriptsDir } : {})}
      />
    </section>
  );
}

/* ---------------- the clocks ---------------- */

/**
 * The phase's clocks, each labelled (#28): this attempt, since it first
 * boarded, worked, queued, to its first tool — and every attempt's own window
 * — from the one reading the strip and the rows fold too.
 */
export function PhaseClocks({ record }: { record: PhaseRecord }) {
  const live = record.status === 'running' || record.status === 'verifying';
  const now = useNow(live, 1000);
  const windows = recordClocks(record, now).attemptWindows ?? [];
  const clocks = phaseClockList(record, now, live);
  return (
    <section data-testid="phase-clocks" className="flex min-w-0 flex-col gap-1.5" aria-label="Clocks">
      <SectionHeading as="h4">Clocks</SectionHeading>
      <KeyValue
        items={clocks.map((clock) => [
          clock.label,
          <span className="tabular-nums" data-clock={clock.field}>
            {clockWords(clock)}
          </span>,
        ])}
      />
      {windows.length > 0 && (
        <ol aria-label="Attempt windows" className="flex flex-col gap-0.5 text-meta text-ink-muted">
          {windows.map((window) => {
            const started = Date.parse(window.startedAt);
            const ended = window.endedAt ? Date.parse(window.endedAt) : null;
            return (
              <li
                key={`${window.attempt}-${window.startedAt}`}
                data-testid="attempt-window"
                className="tabular-nums"
              >
                attempt {window.attempt}:{' '}
                {clockWords({
                  verb: ended == null ? 'running' : 'ran',
                  ms: (ended ?? now) - started,
                  tense: 'for',
                })}{' '}
                from {clockTime(started)}
                {ended != null ? ` to ${clockTime(ended)}` : ''}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/* ---------------- why is this not done? ---------------- */

/**
 * One click: this exact recorded command, in YOUR shell, in the phase's own
 * directory, in the console's terminal. The exit code is written back onto the
 * phase when it ends; all green, the phase re-checks itself.
 */
function RunInTerminal({ slug, phase, command }: { slug: string; phase: number; command: string }) {
  const { data: state } = useConsoleState();
  const [busy, setBusy] = useState(false);
  const allowed = Boolean(state?.allowTerminal);
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={!allowed || busy}
      title={
        allowed
          ? "Runs exactly this recorded command in the console's terminal — your shell, the phase's own directory. The exit code is written back onto this phase when it ends."
          : 'The terminal is off. Restart the console with --allow-terminal.'
      }
      onClick={() => {
        setBusy(true);
        void press(() => api.runVerifyCommand(slug, phase, command))
          .then((pressed) => {
            if (pressed.state === 'asked') toast(pressed.words, 'info');
            else navigate(sessionsHref(pressed.result.sessionId));
          })
          .catch((error: Error) => toast(error.message, 'error'))
          .finally(() => setBusy(false));
      }}
    >
      <TerminalSquare size={13} aria-hidden /> {busy ? 'Opening' : 'Run in the terminal'}
    </Button>
  );
}

/** Mounted only while open — mounting is the request (a `git status` and two script runs). */
function Diagnosis({ slug, phase, run }: { slug: string; phase: number; run: RunState | null }) {
  const { data, error, isFetching } = useDiagnosis(slug, phase, true);
  // The ledger is per PLAN and cheap; it answers for a phase with no run record.
  const { data: ledger } = useRulings(slug, true);
  const rulings = (ledger?.rulings ?? []).filter((ruling) => ruling.phase === phase);
  // What this phase's sessions FILED: joined by provenance alone, never by title.
  const { data: issuesPayload } = useIssues(true);
  const filed = (issuesPayload?.repos ?? [])
    .flatMap((repo) => repo.issues)
    .filter((issue) => issue.provenance?.slug === slug && issue.provenance.phase === phase);
  const record = run?.phases?.[String(phase)];
  const failed = (data?.verification?.ran ?? []).filter((x) => !x.ok);
  const qaRounds = record?.qa ?? [];
  const baselineReds = (record?.baseline?.commands ?? []).filter((line) => !line.ok);
  const tree = verdictTree(data?.verification);

  if (error) return <p className="state-failed text-meta text-state">{(error as Error).message}</p>;
  if (!data) return isFetching ? <p className="text-meta text-ink-muted">Reading the run</p> : null;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid={`diagnosis-${phase}`}>
      <SituationSummary
        situation={data.situation}
        evidence={data.evidence}
        wall={wallReading(record, Date.now())}
      />
      <LastActivity slug={slug} phase={phase} enabled />
      <NowPanel slug={slug} phase={phase} enabled />
      <PhaseGate slug={slug} phase={phase} />
      {data.proof && <EvidenceWords proof={data.proof} verbose />}
      <KeyValue
        items={[
          ['Blocked on', BLOCKED_ON[data.blockedOn ?? ''] ?? 'nothing the runner can name'],
          ['Board says', <span className="font-mono">{data.boardState}</span>],
          data.verifiedIn
            ? [
                'Verified in',
                <>
                  <span className="font-mono">{data.verifiedIn}</span>
                  {data.verifiedIn === '.' ? ' (the repository root)' : ''}
                  {tree && <TreeLine tree={tree} />}
                </>,
              ]
            : null,
          data.lock ? ['Claim', <span className="text-ink-muted">{data.lock}</span>] : null,
          data.sessionId
            ? [
                'Session',
                <>
                  <span className="font-mono">{data.sessionId}</span>
                  {data.resumable ? ', can be resumed' : ''}
                </>,
              ]
            : null,
        ]}
      />
      {qaRounds.length > 0 && (
        <div className="flex flex-col gap-1">
          <SectionHeading as="h4">QA rounds</SectionHeading>
          <QaRounds
            rounds={qaRounds}
            sessionHref={sessionsHref}
            reportHref={(path: string) => qaReportHref(slug, phase, qaReportRound(path))}
          />
        </div>
      )}
      {data.said && (
        <div className="flex flex-col gap-1">
          <SectionHeading as="h4">The session signed off</SectionHeading>
          <pre className={PRE}>{data.said}</pre>
        </div>
      )}
      {failed.length > 0 && (
        <div className="flex flex-col gap-1">
          <SectionHeading as="h4">What failed</SectionHeading>
          {failed.map((x, i) => (
            <div key={i} className="flex min-w-0 flex-col gap-1">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-meta">
                <span className="min-w-0 wrap-anywhere font-mono">{x.command}</span>
                <span className="text-ink-muted">exited {x.code}</span>
                {x.via === 'terminal' && <span className="text-ink-muted">ran in your terminal</span>}
                <RunInTerminal slug={slug} phase={phase} command={x.command} />
              </div>
              {(x.tree ?? tree) && <TreeLine tree={(x.tree ?? tree)!} className="text-meta" />}
              <pre className={PRE}>{x.output || '(no output)'}</pre>
            </div>
          ))}
        </div>
      )}
      {baselineReds.length > 0 && (
        <div className="flex flex-col gap-1">
          <SectionHeading as="h4">Red before this phase began</SectionHeading>
          {baselineReds.map((line, i) => (
            <div key={i} className="flex min-w-0 flex-col gap-1 text-meta">
              <span className="min-w-0 wrap-anywhere">
                <span className="font-mono">{line.command}</span>{' '}
                <span className="text-ink-muted">
                  {line.environment ? `could not run here — ${line.environment}` : `exited ${line.code}`}
                </span>
              </span>
              {line.failures?.length ? (
                <span className="text-ink-muted">Failing: {line.failures.slice(0, 5).join('; ')}</span>
              ) : null}
              {line.tail && <pre className={PRE}>{line.tail}</pre>}
            </div>
          ))}
        </div>
      )}
      {(data.verification?.skipped?.length ?? 0) > 0 && (
        <div className="flex flex-col gap-1">
          <SectionHeading as="h4">Skipped — this machine cannot run them</SectionHeading>
          {data.verification!.skipped!.map((x, i) => (
            <div key={i} className="flex min-w-0 flex-wrap items-center gap-x-2 text-meta">
              <span className="min-w-0 wrap-anywhere font-mono">{x.command}</span>
              <span className="text-ink-muted">{x.reason}</span>
              <RunInTerminal slug={slug} phase={phase} command={x.command} />
            </div>
          ))}
        </div>
      )}
      {data.lint && !data.lint.ok && (
        <div className="flex flex-col gap-1">
          <SectionHeading as="h4">
            <span className="font-mono">validate.sh</span>
          </SectionHeading>
          <pre className={PRE}>{data.lint.summary}</pre>
        </div>
      )}
      {data.closeout && (
        <p className="text-meta text-ink-muted">
          A closeout was already attempted <RelativeTime at={data.closeout.at} />:{' '}
          {data.closeout.ok ? 'the session ran' : 'it did not complete'}
          {data.closeout.note ? ` (${data.closeout.note})` : ''}.
        </p>
      )}
      {data.workingTree.length > 0 && (
        <Disclosure label={`${plural(data.workingTree.length, 'uncommitted path')}`} openLabel="Hide them">
          <pre className={PRE}>{data.workingTree.join('\n')}</pre>
        </Disclosure>
      )}
      {rulings.length > 0 && <RulingList slug={slug} rulings={rulings} />}
      <NotesSection slug={slug} phase={phase} enabled />
      {filed.length > 0 && <FiledIssues issues={filed} />}
      <RecoveryActions
        target={{ slug, phase, ...(run?.id ? { runId: run.id } : {}) }}
        ctx={{
          ...(run ? { run } : {}),
          record: { status: data.status, resumable: data.resumable },
          ...(data.situation
            ? {
                situation: {
                  id: data.situation.id,
                  ...(data.situation.sub ? { sub: data.situation.sub } : {}),
                },
              }
            : {}),
        }}
        max={3}
        showBlurbs
        legend
        account
        parts={ACCOUNT_RECOVERY_PARTS}
      />
    </div>
  );
}

/** What this phase's sessions FILED — each a link to where it lives, with GitHub's own word for its state. */
function FiledIssues({ issues }: { issues: readonly Issue[] }) {
  return (
    <section className="flex min-w-0 flex-col gap-1" aria-label="Issues filed by this phase">
      <SectionHeading as="h4">Issues filed by this phase</SectionHeading>
      <ul className="flex flex-col gap-1 text-meta">
        {issues.map((issue) => (
          <li key={issue.url} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <a href={issue.url} target="_blank" rel="noreferrer" className="tabular-nums text-ink underline">
              #{issue.number}
            </a>
            <span className="min-w-0 break-words text-ink">{issue.title}</span>
            <span className="text-ink-muted">{issue.state}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * What the sessions on this phase DECIDED, oldest first. Nothing acts on a
 * ruling — that is what makes one safe to record — so Mark seen only hides the
 * inbox row, and Remember is the one way to make a decision a standing answer:
 * for this plan (a `## Decisions` row, behind `--allow-writes`) or for every
 * plan on this console (a preference).
 */
function RulingList({ slug, rulings }: { slug: string; rulings: readonly Ruling[] }) {
  const client = useQueryClient();
  const { data: state } = useConsoleState();
  const [busy, setBusy] = useState<string | null>(null);
  const remember = (ruling: Ruling, scope: 'plan' | 'global') => {
    setBusy(ruling.id);
    void press(() => api.rememberRuling(slug, ruling.id, scope))
      .then((pressed) => {
        if (pressed.state === 'asked') toast(pressed.words, 'info');
        else
          toast(
            scope === 'plan'
              ? 'Remembered for this plan — a Decisions row now answers it'
              : 'Remembered on this console',
            'ok',
          );
        void client.invalidateQueries({ queryKey: keys.plan(slug) });
      })
      .catch((error: Error) => toast(error.message, 'error'))
      .finally(() => setBusy(null));
  };
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-label="Rulings" data-testid="ruling-list">
      <SectionHeading as="h4">Decisions the plan did not make for it</SectionHeading>
      <ul className="flex flex-col gap-3">
        {rulings.map((ruling) => (
          <li key={ruling.id} className="flex min-w-0 flex-col gap-0.5 text-meta">
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <span className="text-ink">{RULING_LABEL[ruling.kind] ?? ruling.kind}</span>
              <RelativeTime at={ruling.at} className="text-ink-muted" />
              {ruling.ack && <span className="text-ink-muted">seen</span>}
            </span>
            <p className="text-body text-ink">{ruling.what}</p>
            {ruling.why && <p className="text-ink-muted">Why: {ruling.why}</p>}
            {ruling.costIfWrong && <p className="text-ink-muted">If this was wrong: {ruling.costIfWrong}</p>}
            <span className="flex flex-wrap items-center gap-2 pt-1">
              {!ruling.ack && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void api
                      .inboxAck(rulingItemId(ruling))
                      .then(() => toast('Marked as seen — the ruling itself stays', 'ok'))
                      .catch((error: Error) => toast(error.message, 'error'));
                  }}
                >
                  Mark seen
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={busy === ruling.id || !state?.allowWrites}
                title={
                  state?.allowWrites ? undefined : 'Writes are off. Restart the console with --allow-writes.'
                }
                onClick={() => remember(ruling, 'plan')}
              >
                Remember for this plan
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy === ruling.id}
                onClick={() => remember(ruling, 'global')}
              >
                Remember on this console
              </Button>
            </span>
          </li>
        ))}
      </ul>
      <p className="text-meta text-ink-muted">
        Every ruling for {slug} is in the ledger, phases nobody is looking at too.
      </p>
    </section>
  );
}

/* ---------------- the handoff and the prose ---------------- */

/** The handoff file's own facts: its title, size, the skills it used, and what INDEX.md says of it. */
function HandoffFacts({
  slug,
  view,
  handoff,
  index,
}: {
  slug: string;
  view: PhaseView;
  handoff?: HandoffRow | undefined;
  index?: string | undefined;
}) {
  if (!handoff && !view.handoff) return null;
  const skills = handoff?.skillsUsed ?? view.handoff?.skillsUsed ?? [];
  return (
    <KeyValue
      items={[
        [
          'Handoff',
          <a href={handoffHref(slug, view.phase)} className="text-ink underline-offset-2 hover:underline">
            Read the handoff{handoff?.title ? `: ${handoff.title}` : ''}
          </a>,
        ],
        handoff ? ['Size', `${Math.round(handoff.bytes / 1024)}K`] : null,
        skills.length ? ['Skills used', <span className="font-mono">{skills.join(', ')}</span>] : null,
        index ? ['INDEX.md', index === 'missing' ? 'has no row for it' : `reads ${index}`] : null,
      ]}
    />
  );
}

/**
 * The live record merged over the fetched one, with the `handoff` sub-field
 * merged too: the board keeps the handoff REFERENCE and strips only its
 * `outstanding`, so a flat spread of the live copy would throw away the
 * paragraph the fetch was for.
 */
export function mergedPhase(fetched: PhaseView, live: PhaseView): PhaseView {
  const record: PhaseView = { ...fetched, ...live };
  if (fetched.handoff && live.handoff) record.handoff = { ...fetched.handoff, ...live.handoff };
  return record;
}

/**
 * A phase's prose, fetched on open with the inspector's own include set — on
 * the phase page and the Run view the key is already warm. The live record
 * wins every field it carries.
 */
export function PhaseProse({
  slug,
  phase,
  eta,
}: {
  slug: string;
  phase: PhaseView;
  eta?: PhaseEta | undefined;
}) {
  const { data: full } = usePlan(slug, PROSE_INCLUDES);
  const prose = full?.phases.find((p) => p.phase === phase.phase);
  return (
    <div className="max-w-(--measure)">
      <PhaseDetails slug={slug} phase={prose ? mergedPhase(prose, phase) : phase} eta={eta} />
    </div>
  );
}
