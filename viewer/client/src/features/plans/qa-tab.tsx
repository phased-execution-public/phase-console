/**
 * The QA tab — one surface for the whole gate (2026-09-07).
 *
 * Measured before this: the report was only ever a PATH on every surface and
 * no route served it; the plan's regime was one bare word with its reason
 * flattened away; the per-phase regime never reached the client, so three
 * surfaces judged "is this phase held?" with the plan's word; held dependents
 * existed only as client-side prose; and the switches that the engine has read
 * for months (`**QA gate:**`, `- **QA:**`) had no writer here at all. This tab
 * puts the plan-level switch at the top and, per phase, the regime and where
 * it came from, the verdict and its round, what the verdict holds, what is
 * live on it, the actions the gate state allows, and the report itself.
 *
 * The report opens as a sheet addressed by `?report=<phase>[:<round>]` —
 * open ⟺ the URL says so, like every other overlay — so a round on a run
 * page and a verdict on Insights can LINK to it instead of printing a path.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  DataTable,
  Sheet,
  SheetContent,
  Spinner,
  StatusBadge,
} from '@/components/ui';
import { Markdown } from '@/components/markdown';
import { QaModeControl } from '@/components/qa-mode-control';
import { QaButton, QaRecoveryActions } from '@/components/qa-launcher';
import { api } from '@/lib/api';
import { keys, useConsoleState, useRun, useSessions } from '@/lib/queries';
import { canQa, isVerdict, liveQa, parseReportParam, phaseQaMode, qaReportHref } from '@/lib/qa';
import { qaResultTitle, qaUiState } from '@/lib/status-vocab';
import { laneHref, navigate, phaseHref, planHref, sessionsHref } from '@shared/routes.js';
import type { PhaseView, PlanDetail } from '@/lib/api';

/** What each plan-level regime means for the board, in one sentence. */
const REGIME: Record<string, string> = {
  on: 'A recorded fail — and a pending row — holds every phase that depends on the reviewed one.',
  waived: 'The gate is written off: verdicts stay on file and hold nothing.',
  off: 'No ledger yet. Turning the gate on creates test-status.md and records the phases already complete as waived.',
  unknown: 'The engine could not read the regime — see the health panel on the Route tab.',
};

export function QaTab({ detail, report }: { detail: PlanDetail; report?: string }) {
  const slug = detail.summary.slug;
  const planMode = detail.summary.qaMode;
  const { data: state } = useConsoleState();
  const { data: terminals } = useSessions(state);
  const { data: run } = useRun(slug);
  const held = detail.qaHeld ?? {};
  const open = parseReportParam(report);
  const allowWrites = Boolean(state?.allowWrites);
  const allowRun = Boolean(state?.allowRun);
  const allowAgent = Boolean(state?.allowAgent);
  const planSkills = detail.plan?.sessionBudget?.skills ?? [];
  const planMcp = detail.plan?.sessionBudget?.mcpServers ?? [];

  const counts = new Map<string, number>();
  for (const row of detail.qa) counts.set(row.result, (counts.get(row.result) ?? 0) + 1);
  const tally = [...counts.entries()].map(([result, n]) => `${n} ${result}`).join(' · ');

  const target = (view: PhaseView) => ({
    slug,
    phase: view.phase,
    title: view.title,
    model: view.model,
    effort: view.effort,
    qaMode: phaseQaMode(view, planMode),
    ...(view.qa ? { qa: view.qa } : {}),
    planSkills,
    planMcp: [...new Set([...planMcp, ...(view.mcpServers ?? [])])],
  });

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader>
          <CardTitle>QA gate</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-2">
          <QaModeControl
            slug={slug}
            mode={planMode}
            reason={detail.summary.qaModeReason}
            allowWrites={allowWrites}
            scriptsDir={state?.scriptsDir}
          />
          <p className="text-2xs text-ink-faint">{REGIME[planMode] ?? REGIME.unknown}</p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Phases</CardTitle>
          <span className="text-xs text-ink-faint">{tally || 'no verdict recorded yet'}</span>
        </CardHeader>
        <DataTable
          label="QA by phase"
          className="rounded-none border-0 border-t border-rule"
          rows={detail.phases}
          getRowKey={(view) => String(view.phase)}
          rowHref={(view) => phaseHref(slug, view.phase)}
          columns={[
            {
              id: 'phase',
              head: '#',
              priority: 1,
              min: 72,
              identity: true,
              cell: (view) => (
                <span className="font-mono" data-testid={`qa-phase-${view.phase}`}>
                  P{view.phase}
                </span>
              ),
            },
            {
              id: 'title',
              head: 'Phase',
              priority: 1,
              min: 200,
              flex: true,
              card: 'title',
              cell: (view) => (
                <span className="block truncate" title={view.title}>
                  {view.title} <span className="text-2xs text-ink-faint">{view.state}</span>
                </span>
              ),
            },
            {
              id: 'regime',
              head: 'Regime',
              priority: 2,
              min: 150,
              cell: (view) => (
                <span>
                  <span className="font-mono">{phaseQaMode(view, planMode) ?? '—'}</span>{' '}
                  <span className="text-2xs text-ink-faint">
                    {view.qaMode?.source === 'phase' ? 'phase directive' : 'plan'}
                  </span>
                </span>
              ),
            },
            {
              id: 'verdict',
              head: 'Verdict',
              priority: 1,
              min: 96,
              cell: (view) => {
                const result = view.qa?.result;
                return isVerdict(result) ? (
                  <StatusBadge state={qaUiState(result)} label={result!} title={qaResultTitle(result!)} />
                ) : (
                  <span className="text-ink-muted">{result === 'pending' ? 'pending' : '—'}</span>
                );
              },
            },
            {
              id: 'rounds',
              head: 'Rounds',
              priority: 3,
              min: 88,
              cell: (view) =>
                view.qaRounds ? (
                  <span title={view.qaRounds.latest.report}>round {view.qaRounds.count}</span>
                ) : (
                  <span className="text-ink-muted">—</span>
                ),
            },
            {
              id: 'holds',
              head: 'Holds',
              priority: 2,
              min: 96,
              cell: (view) => {
                const holds = held[view.phase] ?? [];
                return holds.length ? (
                  <span className="flex flex-wrap gap-1">
                    {holds.map((n) => (
                      <a key={n} href={phaseHref(slug, n)} className="font-mono text-warn hover:underline">
                        P{n}
                      </a>
                    ))}
                  </span>
                ) : (
                  <span className="text-ink-muted">—</span>
                );
              },
            },
            {
              id: 'live',
              head: 'Live',
              priority: 3,
              min: 130,
              cell: (view) => {
                const lane = run?.run?.phases?.[String(view.phase)]?.qaSession;
                const pty = lane ? undefined : liveQa(terminals?.sessions, { slug, phase: view.phase });
                return lane ? (
                  <a href={laneHref(slug, view.phase)} className="text-action hover:underline">
                    QA round {lane.round} live
                  </a>
                ) : pty ? (
                  <a href={sessionsHref(pty.id)} className="text-action hover:underline">
                    review live
                  </a>
                ) : (
                  <span className="text-ink-muted">—</span>
                );
              },
            },
          ]}
          // The actions the gate state allows, under the row: the recovery
          // verbs when the verdict holds, a review when there is a diff to
          // read, the report, and THIS phase's own switch.
          detail={(view) => {
            const mode = phaseQaMode(view, planMode);
            const pty = liveQa(terminals?.sessions, { slug, phase: view.phase });
            const hasReport = Boolean(view.qa?.report || view.qaRounds);
            return (
              <div className="flex flex-col gap-2 py-1">
                <QaRecoveryActions
                  slug={slug}
                  phase={view.phase}
                  qaMode={mode}
                  {...(view.qa ? { qa: view.qa } : {})}
                  allowRun={allowRun}
                  allowWrites={allowWrites}
                  scriptsDir={state?.scriptsDir}
                  target={target(view)}
                />
                <div className="flex flex-wrap gap-2">
                  {canQa(view.state) && (
                    <QaButton
                      label="QA"
                      target={target(view)}
                      allowAgent={allowAgent}
                      allowWrites={allowWrites}
                      {...(pty ? { runningSessionId: pty.id } : {})}
                    />
                  )}
                  {hasReport && (
                    <Button
                      size="sm"
                      onClick={() => navigate(qaReportHref(slug, view.phase, view.qaRounds?.latest.round))}
                    >
                      <FileText size={13} aria-hidden /> Open report
                    </Button>
                  )}
                </div>
                <QaModeControl
                  slug={slug}
                  mode={planMode}
                  phase={view.phase}
                  phaseMode={view.qaMode}
                  allowWrites={allowWrites}
                  scriptsDir={state?.scriptsDir}
                />
              </div>
            );
          }}
        />
      </Card>

      {open && (
        <QaReportSheet
          slug={slug}
          phase={open.phase}
          round={open.round}
          rounds={detail.phases.find((p) => p.phase === open.phase)?.qaRounds?.count}
          onClose={() => navigate(planHref(slug, 'qa'))}
        />
      )}
    </div>
  );
}

/**
 * The report itself, rendered — with a round picker over the ledger when the
 * phase has had more than one. Fetched by (phase, round) from the one route
 * that serves a report; no round means the latest the ledger records.
 */
export function QaReportSheet({
  slug,
  phase,
  round,
  rounds,
  onClose,
}: {
  slug: string;
  phase: number;
  round?: number;
  /** How many rounds the ledger records for this phase — the picker's extent. */
  rounds?: number;
  onClose: () => void;
}) {
  const [which, setWhich] = useState<number | undefined>(round);
  const query = useQuery({
    queryKey: keys.qaReport(slug, phase, which),
    queryFn: () => api.qaReport(slug, phase, which),
    retry: false,
  });
  const picker = rounds && rounds > 1 ? Array.from({ length: rounds }, (_, i) => i + 1) : [];
  const shown = query.data?.round ?? which ?? rounds;
  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        side="right"
        title={`QA report — phase ${phase}`}
        showTitle
        description={
          query.data?.path ? <code className="font-mono text-2xs">{query.data.path}</code> : undefined
        }
        subheader={
          picker.length ? (
            <div className="flex flex-wrap gap-1 px-3 py-2" role="group" aria-label="Round">
              {picker.map((n) => (
                <Button key={n} size="sm" aria-pressed={shown === n} onClick={() => setWhich(n)}>
                  round {n}
                </Button>
              ))}
            </div>
          ) : undefined
        }
      >
        {query.isPending ? (
          <Spinner label="Reading the report" />
        ) : query.isError || !query.data ? (
          <p className="p-3 text-2xs text-ink-faint">No report is on file for this round.</p>
        ) : (
          <div className="p-3">
            <Markdown text={query.data.text} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
