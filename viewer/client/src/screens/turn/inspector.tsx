/**
 * An item in the panel — Inspect, the second door to depth (7.0, quiet-console
 * phase 8; design.md principle 3).
 *
 * The card hands the shell ONE record: the item's name, its state and risk as
 * dots and words, the facts of its explain view (`GET /api/turn/:id`, read
 * only when the panel opens on it — why only a person fits it as a sentence,
 * the commands its guide asks for, how it is proven, who waits on it), the
 * ledger's moves and verdicts as its history, and the record as the machine
 * holds it. A projected item (a gate, an approval card, a relayed question)
 * has no explain view — its record is its row — and the panel says so. An item
 * that stands for a permission card carries the card's own verbs as Actions,
 * pressed at the card the item names. Why only a person fits it is said once
 * (#332): one *Only you* row, the reason's sentence and never its label too.
 */

import { KIND_META } from '@shared/human-step-model.js';
import { whyPersonWords } from '@shared/turn-model.js';
import { BIRTH_WORDS, MoveLine, stamp } from '@/cards/human-step-card';
import type { HumanStepRecord } from '@/data/human-steps';
import { useTurnItem, type TurnItem } from '@/data/turn';
import { ApiError } from '@/data/http';
import { phaseHref, planHref, runHref } from '@/shell/routes';
import { ActionsTab } from '@/shell/panel/actions-tab';
import { inspect } from '@/shell/panel/inspector-host';
import { KeyValue, Mono, Skeleton, type KeyValueItem } from '@/ui';
import { OpsStatus } from '@/ui/status';

const link = 'tap-row text-ink underline decoration-rule-strong underline-offset-2 hover:decoration-ink';

/** The explain view's facts, read when the panel opens — or the row's own, for a projected item. */
export function ExplainOverview({ item }: { item: TurnItem; record?: HumanStepRecord | undefined }) {
  const ledger = item.record === 'ledger';
  const explain = useTurnItem(ledger ? item.item : null, ledger);
  if (ledger && explain.isPending) {
    return (
      <div className="flex flex-col gap-2" data-testid="turn-explain-loading">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    );
  }
  const gone = ledger && explain.isError && explain.error instanceof ApiError && explain.error.status === 404;
  const view = ledger && explain.data ? explain.data : null;
  const step = item.step;
  // Why only a person fits it, said ONCE (#332): the explain view's sentence,
  // else the reason's own — a projected item's is the composer's need, which
  // the panel then does not repeat beside it.
  const why = view?.whyPerson ?? (ledger || !item.need ? whyPersonWords(step?.why ?? item.why) : item.need);
  const facts: KeyValueItem[] = [
    [
      'Only you',
      <span data-testid="turn-explain-why">
        {why}
        {(view?.whySource ?? step?.whySource) === 'inferred' ? ' (inferred from its kind)' : ''}
      </span>,
    ],
    item.slug
      ? [
          'Plan',
          <a className={link} href={planHref(item.slug)}>
            {item.slug}
          </a>,
        ]
      : null,
    item.slug && item.phase != null
      ? [
          'Phase',
          item.phase ? (
            <a className={link} href={phaseHref(item.slug, item.phase)}>
              Phase {item.phase}
            </a>
          ) : (
            'The plan itself'
          ),
        ]
      : null,
    item.slug && item.runId
      ? [
          'Run',
          <a className={link} href={runHref(item.slug)} title={item.runId}>
            <Mono value={item.runId} chars={8} />
          </a>,
        ]
      : null,
    [
      'Raised by',
      `${BIRTH_WORDS[view?.birth ?? step?.birth ?? ''] ?? view?.birth ?? step?.birth ?? item.source}, ${stamp(view?.declaredAt ?? step?.declaredAt ?? item.since)}`,
    ],
    view?.source && ['From', `${view.source.kind}${view.source.ref ? ` ${view.source.ref}` : ''}`],
    [
      'Proof',
      view || step ? (
        <>
          {view?.proofType ?? step?.proofType}
          {(view?.proof ?? step?.proof) && (
            <>
              {' '}
              <Mono value={view?.proof ?? step?.proof ?? ''} words />
            </>
          )}
          {(view?.proofWords ?? step?.proofWords) && ` — ${view?.proofWords ?? step?.proofWords}`}
        </>
      ) : (
        item.proofType
      ),
    ],
    view &&
      view.commands &&
      view.commands.length > 0 && [
        'Commands',
        <ul className="flex list-none flex-col gap-0.5 p-0" data-testid="turn-explain-commands">
          {view.commands.map((command, index) => (
            <li key={`${index}-${command}`}>
              <Mono value={command} words />
            </li>
          ))}
        </ul>,
      ],
    view && [
      'Attempts',
      view.attempts
        ? `${view.attempts}${view.verdicts.length ? `, last ${view.verdicts.at(-1)?.state}` : ''}`
        : 'none yet',
    ],
    view?.escalatedAt ? ['Escalated', stamp(view.escalatedAt)] : null,
    (view?.waiters ?? step?.waiters ?? []).length > 0
      ? [
          'Waiting on it',
          (view?.waiters ?? step?.waiters ?? [])
            .map((w) => `${w.slug} phase ${w.phase}${w.runId ? ` (run ${w.runId.slice(0, 8)})` : ''}`)
            .join(', '),
        ]
      : null,
    (view?.note ?? step?.note) ? ['Its last word', view?.note ?? step?.note ?? ''] : null,
  ];
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="turn-explain">
      {!ledger && (
        <p className="max-w-(--measure) text-meta text-ink-muted" data-testid="turn-explain-projected">
          A projected item: its record is the row it stands for.
        </p>
      )}
      {gone && (
        <p className="max-w-(--measure) text-meta text-ink-muted" data-testid="turn-explain-gone">
          The ledger no longer holds this item; what the page read is shown.
        </p>
      )}
      <KeyValue items={facts} />
    </div>
  );
}

/** The ledger's moves and verdicts, as the panel's History tab. */
function ItemHistory({ record }: { record: HumanStepRecord }) {
  const moves = record.moves ?? [];
  const verdicts = record.verdicts ?? (record.verdict ? [record.verdict] : []);
  if (!moves.length && !verdicts.length) return null;
  return (
    <div className="flex min-w-0 flex-col gap-3 text-meta" data-testid="turn-explain-history">
      {verdicts.length > 0 && (
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-medium text-ink">Every verdict</p>
          <ol className="flex list-none flex-col gap-1 p-0">
            {verdicts.map((verdict) => (
              <li key={`${verdict.attempt}-${verdict.at}`} className="flex flex-wrap items-baseline gap-x-2">
                <OpsStatus vocab="verdict" word={verdict.state} />
                <span className="text-ink">
                  Attempt {verdict.attempt}: {verdict.note}
                </span>
                <span className="text-ink-muted">
                  {verdict.by}, {stamp(verdict.at)}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {moves.length > 0 && (
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-medium text-ink">Every move</p>
          <ol className="flex list-none flex-col gap-0.5 p-0">
            {moves.map((move, index) => (
              <MoveLine key={`${move.at}-${index}`} move={move} />
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

/**
 * The permission card an item stands for: the card its own Allow and Deny are
 * pressed at, else the card a broker grant would answer.
 */
export function approvalIdOf(item: Pick<TurnItem, 'actions' | 'permission'>): string | undefined {
  for (const action of item.actions) {
    const card = /^\/api\/approvals\/([^/?]+)$/.exec(action.endpoint);
    if (card) return decodeURIComponent(card[1]!);
  }
  const grant = item.permission?.grant;
  return grant && 'approvalId' in grant ? grant.approvalId : undefined;
}

/**
 * Show the item in the panel. `open: false` hands the panel the record without
 * opening it — what `#/turn/<id>` does where the panel would cover the card.
 */
export function inspectItem(
  { item, record }: { item: TurnItem; record: HumanStepRecord | undefined },
  options: { open?: boolean } = {},
): void {
  const state = record?.state ?? item.step?.state ?? item.humanStep?.state ?? 'notified';
  const risk = item.permission?.risk ?? item.step?.permission?.risk ?? record?.permission?.risk;
  const title = record?.title ?? item.step?.title ?? item.title;
  const where = item.slug ? `${item.slug}${item.phase != null ? `, phase ${item.phase}` : ''}` : item.source;
  const card = approvalIdOf(item);
  inspect(
    {
      key: `turn:${item.item}`,
      title,
      description: `${KIND_META[item.kind]?.label ?? item.kind} — ${where}.`,
      meta: (
        <>
          <OpsStatus vocab="step" word={state} />
          {risk && <OpsStatus vocab="risk" word={risk} />}
          <Mono value={item.item} chars={16} copyable />
        </>
      ),
      overview: <ExplainOverview item={item} record={record} />,
      ...(card ? { actions: <ActionsTab kind="approval" args={{ id: card }} /> } : {}),
      ...(record ? { history: <ItemHistory record={record} /> } : {}),
      raw: JSON.stringify(record ?? item, null, 2),
    },
    options,
  );
}
