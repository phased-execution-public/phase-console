/**
 * A plan in the panel — the drawer its status opens, and Inspect's Overview
 * (design.md §1, principle 3; the panel is the column at 1200 and up, a sheet
 * below, a bottom sheet on a phone).
 *
 * ```
 * Why it says Needs you
 *   It needs you: Decide whether the fix release goes first.
 * What needs you
 *   NOW  Decision
 *   Decide whether the fix release goes first
 *   Make a decision: add a fix release before Release B?
 *   asked 10 minutes ago   Open it on Your turn
 * Running now
 *   ● Running  Phase 16, Release A.1      started 20 minutes ago   Open phase 16
 * What it waits on
 *   Phase 14 waits on phase 13 (in progress).                     Open phase 14
 * Its phases
 *   ▮▮▮▮▮▮▮▮▮▮▮▮▯▯▮▯   (75 %)
 *   (12 done) (2 in progress) (2 waiting) (3 gated)
 * About this plan
 *   Status · Run · Phases · Left · …
 * ```
 *
 * The reasons are `whyOf` (`./why`), the words the row's status is explained
 * by; a run's stop is the halt card's, which says its family, its sentence and
 * the one recovery it recommends (`cards/halt-card.tsx`, the one renderer of
 * why a run stopped). The phases are the plan's line in their own order
 * (`pipelineOf`), every phase a cell where it stands.
 *
 * It READS the plan itself — the list, the runs and the inbox the page already
 * holds, and, once open, the plan's detail, its newest run's whole record and
 * the queue — rather than keeping what the row handed it, because the panel
 * outlives the render that opened it (`screens/turn/panel-card.tsx`'s rule): a
 * run moving on, an item answered, a gate opened redraw the reasons in place.
 */

import { useId, useMemo } from 'react';
import { progressReading } from '@shared/plan-vocab.js';
import type { PlanSummaryFull, RunState } from '@/data/api';
import { useAccounts } from '@/data/accounts';
import { useConsoleState } from '@/data/console';
import { useAttentionInbox } from '@/data/inbox';
import { usePlan, usePlans } from '@/data/plans';
import { useQueue } from '@/data/queue';
import { useRun, useRunList } from '@/data/runs';
import { HaltCard } from '@/cards/halt-card';
import { TurnRowWords } from '@/cards/turn/row-words';
import { closedTitle } from '@/lib/closure';
import { useNow } from '@/ui/clock';
import { etaLabel, money, plural } from '@/lib/format';
import { KeyValue, Mono, RelativeTime, SectionHeading } from '@/ui';
import { PhaseStatus, PlanStatus, type WordOf } from '@/ui/status';
import { ACCOUNT_RECOVERY_PARTS } from '@/screens/settings/account-row';
import { concerns, kindWord, leftWords, pipelineOf, repoLabel, toRows, type PlanRow } from './model';
import { NextUpLinks, PlanMark, RunLink } from './row';
import { PlanTrack } from './track-bar';
import { whyOf, type PlanReason, type PlanWhySection } from './why';

const list = (phases: readonly number[] | undefined): string | null =>
  phases?.length ? phases.map((p) => `P${p}`).join(', ') : null;

/** One reason: its card words when it is an item of Your turn, its sentence, the server's words, its clock, where to act. */
function Reason({ reason }: { reason: PlanReason }) {
  return (
    <li data-reason={reason.key} className="flex min-w-0 flex-col gap-1">
      {reason.item?.turn && <TurnRowWords turn={reason.item.turn} />}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {reason.lane && <PhaseStatus record={{ status: reason.lane as WordOf<'phase'> }} />}
        <span className="min-w-0 break-words text-body text-ink">{reason.text}</span>
      </div>
      {reason.detail && (
        <p className="min-w-0 max-w-(--measure) break-words text-meta text-ink-muted">{reason.detail}</p>
      )}
      {(reason.at || reason.href) && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-meta">
          {reason.at && (
            <span className="text-ink-faint">
              {reason.verb ? `${reason.verb} ` : ''}
              <RelativeTime at={reason.at} />
            </span>
          )}
          {reason.href && (
            <a
              href={reason.href}
              data-testid="plan-why-act"
              className="tap-row inline-flex min-h-6 items-center text-ink underline underline-offset-2"
            >
              {reason.act}
            </a>
          )}
        </div>
      )}
    </li>
  );
}

function ReasonSection({ section }: { section: PlanWhySection }) {
  const id = useId();
  return (
    <section aria-labelledby={id} data-why={section.key} className="flex min-w-0 flex-col gap-2">
      <SectionHeading as="h3" id={id}>
        {section.title}
      </SectionHeading>
      <ul className="flex min-w-0 flex-col gap-3">
        {section.reasons.map((reason) => (
          <Reason key={reason.key} reason={reason} />
        ))}
      </ul>
    </section>
  );
}

/** Every fact the summary carries, in words — what the panel's Overview always held. */
function PlanFacts({ row }: { row: PlanRow }) {
  const s: Partial<PlanSummaryFull> = row.summary ?? {};
  const reading = progressReading(row);
  const worst = concerns(row);
  return (
    <KeyValue
      items={[
        [
          'Status',
          row.isPlan ? (
            <PlanStatus status={row.status as WordOf<'plan'>} chrome="badge" data-testid="plan-status" />
          ) : (
            kindWord(row)
          ),
        ],
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
        !row.isClosed && (['Gated', list(row.gated)] as const),
        !row.isClosed && (['QA failed at', list(row.qaFailures)] as const),
        row.needsYou > 0 && (['Waiting on you', plural(row.needsYou, 'thing')] as const),
        row.turn.open > 0 &&
          ([
            'On Your turn',
            `${row.turn.open} open${row.turn.now ? `, ${row.turn.now} to do now` : ''}`,
          ] as const),
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
        row.spend.runs > 0 &&
          ([
            'Spent',
            `${money(row.spend.usd)} over ${plural(row.spend.runs, 'run')}${row.spend.liveUsd > 0 ? `, ${money(row.spend.liveUsd)} in flight` : ''}`,
          ] as const),
        Boolean(row.account) && (['Account', `${row.account!.who}, ${row.account!.provider}`] as const),
        row.activity > 0 && (['Moved', <RelativeTime key="moved" at={row.activity} live={false} />] as const),
        Boolean(s.startedAt) &&
          (['Started', <RelativeTime key="started" at={s.startedAt} live={false} />] as const),
        row.repos.length > 0 && (['Repositories', repoLabel(row.repos).title] as const),
        Boolean(row.branch) && (['Branch', <Mono key="branch" value={row.branch!} />] as const),
        Boolean(s.targetModel) && (['Model', <Mono key="model" value={s.targetModel!} />] as const),
        Boolean(s.qaMode) && (['QA', s.qaModeReason ? `${s.qaMode} — ${s.qaModeReason}` : s.qaMode] as const),
        Boolean(s.skills?.length) && (['Skills', s.skills!.join(', ')] as const),
        Boolean(s.mcpServers?.length) && (['MCP servers', s.mcpServers!.join(', ')] as const),
        ['Handoffs', String(row.handoffCount)],
      ]}
    />
  );
}

/**
 * The plan's row as it stands NOW — the summary, every run of it (the newest
 * one whole once read), the inbox and the accounts, folded by `toRows` — and
 * the detail and the queue the reasons read. The row the page handed over
 * stands in until each read lands.
 */
function useLivePlan(slug: string, held: PlanRow) {
  const now = useNow(true, 30_000);
  const { data: state } = useConsoleState();
  const autopilot = state != null && state.autopilot !== false;
  const plans = usePlans();
  const runList = useRunList(autopilot);
  const { data: inbox } = useAttentionInbox();
  const { data: accounts } = useAccounts();
  const detail = usePlan(slug);
  // The newest run's whole record, for the halt card, and the queue, for a
  // phase's place in line: read only while this plan has a run.
  const hasRun = Boolean(held.run) || (runList.data ?? []).some((run) => run.slug === slug);
  const whole = useRun(slug, autopilot && hasRun);
  const { data: queue } = useQueue(autopilot && hasRun);

  const row = useMemo(() => {
    const summary = (plans.data as unknown as PlanSummaryFull[] | undefined)?.find(
      (plan) => plan.slug === slug,
    );
    if (!summary) return held;
    const latest = whole.data?.run ?? null;
    const runs = (runList.data ?? (held.run ? [held.run.record] : [])).map((run) =>
      latest && run.id === latest.id ? (latest as RunState) : run,
    );
    return toRows([summary], runs, now, inbox?.items ?? held.inbox, accounts?.accounts)[0] ?? held;
  }, [plans.data, slug, held, whole.data, runList.data, now, inbox, accounts]);
  return { row, detail: detail.data, queue: queue?.entries, now };
}

/** The panel's identity row: the plan's status as its row draws it, read live, and its slug. */
export function PlanPanelMeta({ slug, held }: { slug: string; held: PlanRow }) {
  const { row } = useLivePlan(slug, held);
  return (
    <>
      <PlanMark row={row} />
      <Mono value={row.slug} copyable />
    </>
  );
}

/** The plan, read live: the reasons behind its word, its phases in order, its facts. */
export function PlanOverview({ slug, held }: { slug: string; held: PlanRow }) {
  const { row, detail, queue, now } = useLivePlan(slug, held);
  const why = useMemo(() => whyOf({ row, detail, queue, now }), [row, detail, queue, now]);
  const order = useMemo(() => pipelineOf(row, detail?.phases), [row, detail]);
  const head = useId();
  const phasesHead = useId();
  const factsHead = useId();

  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="plan-why" data-word={why.word}>
      <section aria-labelledby={head} className="flex min-w-0 flex-col gap-2">
        <SectionHeading as="h3" id={head}>
          Why it says {why.word}
        </SectionHeading>
        {why.stop ? (
          // The halt card IS the answer: its sentence, its family, the one way on.
          <HaltCard run={why.stop.run} parts={ACCOUNT_RECOVERY_PARTS} />
        ) : (
          <p data-testid="plan-why-headline" className="max-w-(--measure) text-body text-ink">
            {why.headline}
          </p>
        )}
      </section>

      {why.sections.map((section) => (
        <ReasonSection key={section.key} section={section} />
      ))}

      {row.phases > 0 && (
        <section aria-labelledby={phasesHead} className="flex min-w-0 flex-col gap-2">
          <SectionHeading as="h3" id={phasesHead}>
            Its phases
          </SectionHeading>
          <PlanTrack row={row} order={order} nowMs={now} />
        </section>
      )}

      <section aria-labelledby={factsHead} className="flex min-w-0 flex-col gap-2">
        <SectionHeading as="h3" id={factsHead}>
          About this plan
        </SectionHeading>
        <PlanFacts row={row} />
      </section>
    </div>
  );
}
