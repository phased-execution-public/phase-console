/**
 * A plan in the panel — Inspect, the second door to depth (7.0, quiet-console
 * phase 9; design.md principle 3).
 *
 * The row hands the shell ONE record: its name and mark, every fact the
 * summary carries in words (Overview), the verbs the registry knows for a plan
 * and, once it has one, for its run (Actions), and the summary as the server
 * sent it (Raw). The shell draws it
 * where the width calls for — the column at 1200 and up, a sheet below.
 */

import { progressReading } from '@shared/plan-vocab.js';
import type { ConsoleState, PlanSummaryFull } from '@/data/api';
import { closedTitle } from '@/lib/closure';
import { etaLabel, plural } from '@/lib/format';
import { KeyValue, Mono, RelativeTime } from '@/ui';
import { PlanStatus, type WordOf } from '@/ui/status';
import { ActionsTab } from '@/shell/panel/actions-tab';
import { inspect } from '@/shell/panel/inspector-host';
import { concerns, kindWord, leftWords, repoLabel, type PlanRow } from './model';
import { NextUpLinks, PlanLine, PlanMark, RunLink } from './row';

const list = (phases: readonly number[] | undefined): string | null =>
  phases?.length ? phases.map((p) => `P${p}`).join(', ') : null;

function overviewOf(row: PlanRow) {
  const s: Partial<PlanSummaryFull> = row.summary ?? {};
  const reading = progressReading(row);
  const worst = concerns(row);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PlanLine row={row} />
      <KeyValue
        items={[
          ['Status', row.isPlan ? <PlanStatus status={row.status as WordOf<'plan'>} /> : kindWord(row)],
          row.isClosed && (['Closed', closedTitle(row).split('\n\n').slice(0, 2).join(' ')] as const),
          Boolean(row.run) && (['Run', <RunLink key="run" row={row} />] as const),
          row.phases > 0 && (['Phases', reading.text] as const),
          ['Left', leftWords(row)],
          Boolean(row.eta && !row.isClosed) &&
            (['Estimate', etaLabel(row.eta!.lowMs, row.eta!.highMs, row.eta!.basis)] as const),
          !row.isClosed &&
            row.readyPhases.length > 0 &&
            (['Next up', <NextUpLinks key="next" row={row} />] as const),
          !row.isClosed && (['In progress', list(row.inProgress)] as const),
          !row.isClosed && (['Stuck', list(row.stuck)] as const),
          !row.isClosed && row.waiting > 0 && (['Waiting on others', plural(row.waiting, 'phase')] as const),
          !row.isClosed && (['QA failed at', list(row.qaFailures)] as const),
          row.needsYou > 0 && (['Waiting on you', plural(row.needsYou, 'thing')] as const),
          worst.length > 0 && (['Health', worst.map((c) => c.text).join('; ')] as const),
          Boolean(row.claim) &&
            ([
              'Claimed by',
              `${row.claim!.owner}${row.claim!.phase != null ? ` on P${row.claim!.phase}` : ''}${row.claim!.expired ? ', lapsed' : ''}`,
            ] as const),
          Boolean(s.criticalPath?.length) && (['Critical path', list(s.criticalPath)] as const),
          Boolean(s.nextBest) &&
            (['Unblocks most', `P${s.nextBest!.phase}, ${plural(s.nextBest!.unblocks, 'phase')}`] as const),
          Boolean(s.bottleneck) &&
            ([
              'Bottleneck',
              `P${s.bottleneck!.phase}, holding ${plural(s.bottleneck!.blocks, 'phase')}`,
            ] as const),
          row.activity > 0 &&
            (['Moved', <RelativeTime key="moved" at={row.activity} live={false} />] as const),
          Boolean(s.startedAt) &&
            (['Started', <RelativeTime key="started" at={s.startedAt} live={false} />] as const),
          row.repos.length > 0 && (['Repositories', repoLabel(row.repos).title] as const),
          Boolean(row.branch) && (['Branch', <Mono key="branch" value={row.branch!} />] as const),
          Boolean(s.targetModel) && (['Model', <Mono key="model" value={s.targetModel!} />] as const),
          Boolean(s.qaMode) &&
            (['QA', s.qaModeReason ? `${s.qaMode} — ${s.qaModeReason}` : s.qaMode] as const),
          Boolean(s.skills?.length) && (['Skills', s.skills!.join(', ')] as const),
          Boolean(s.mcpServers?.length) && (['MCP servers', s.mcpServers!.join(', ')] as const),
          ['Handoffs', String(row.handoffCount)],
        ]}
      />
    </div>
  );
}

/** Show the plan in the panel. */
export function inspectPlan(row: PlanRow, state: ConsoleState | undefined): void {
  inspect({
    key: `plan:${row.slug}`,
    title: row.title,
    description: row.isPlan ? `${plural(row.phases, 'phase')}, ${row.done} done.` : kindWord(row),
    meta: (
      <>
        <PlanMark row={row} />
        <Mono value={row.slug} copyable />
      </>
    ),
    overview: overviewOf(row),
    actions: (
      <ActionsTab
        kind={row.run ? ['plan', 'run'] : 'plan'}
        args={{ slug: row.slug, runId: row.run?.id }}
        capabilities={state as Parameters<typeof ActionsTab>[0]['capabilities']}
      />
    ),
    raw: JSON.stringify(row.summary ?? row, null, 2),
  });
}
