/**
 * One item of Your turn as a ROW — the shape every other surface draws a
 * person's ask in (7.0; control-tower phase 139, #216).
 *
 * The approval queue, the gate card, the errand card, the launch door and the
 * run strips each drew an ask in a shape of its own. Now each draws this: the
 * title, the kind's mark, where it belongs, ONE primary action, and a link to
 * the item on Your turn (`#/turn/<id>`), where everything else about it is one
 * press away. The primary is chosen by rule (`rowPrimaryOf`):
 *
 * - an item coming up, being checked or done offers nothing but the link;
 * - a permission leads with its Grant (or the broker card's Allow) — but a
 *   high or never one leads with the page itself: granting it there asks for
 *   the rule typed back and the owner key, which a row cannot;
 * - a decision — and an approval that is no permission — leads with the page,
 *   where its options or its approval block sit side by side: a decision with
 *   options opens its card (turn-by-turn phase 10) — save a projected one with
 *   exactly one answer that asks for no words, pressed here (a gate's Approve
 *   asks for its evidence, so it is the page's);
 * - a step leads with the human-step card's primary — its kind's opener or its
 *   check, or a folded card's recommended verb, exactly as the server spelled it;
 * - anything else with its first pressable action, pressed verbatim.
 *
 * Since turn-by-turn phase 10 the row says the card's words first — NOW or NOT
 * YET and the type's mark (`cards/turn/row-words.tsx`) — and its title is the
 * composer's, the act, exactly as the card heads it.
 *
 * Reached through `lazy-item-row.tsx`, never imported directly: the step card's
 * glyphs, verbs and terminal sheet are no first paint's business.
 */

import type { InboxAction, InboxItem } from '@/data/api';
import { itemIdOf } from '@/data/turn';
import { cn } from '@/lib/cn';
import { turnHref } from '@/shell/routes';
import { Button } from '@/ui';
import { OpsStatus } from '@/ui/status';
import { HumanStepPrimary, KindMark } from './human-step-card';
import { TurnRowWords } from './turn/row-words';

type Perform = (item: InboxItem, action: InboxAction, says?: string) => void;

export type RowPrimary =
  | { move: 'none'; why: 'upcoming' | 'checking' | 'settled' }
  | { move: 'page' }
  | { move: 'step' }
  | { move: 'row'; action: InboxAction };

/** A permission ends by a grant; the broker's card by its Allow; failing both, by doing it yourself or a denial. */
const PERMISSION_ORDER = Object.freeze(['grant', 'allow', 'convert', 'deny'] as const);

/** The row's ONE primary, by rule — see the file's head. */
export function rowPrimaryOf(
  row: Pick<InboxItem, 'turn' | 'humanStep' | 'actions'> & Partial<Pick<InboxItem, 'options'>>,
): RowPrimary {
  const group = row.turn?.group;
  if (group === 'upcoming') return { move: 'none', why: 'upcoming' };
  if (group === 'checking') return { move: 'none', why: 'checking' };
  if (group === 'done') return { move: 'none', why: 'settled' };
  const pressable = row.actions.filter((action) => !action.flag);
  if (row.turn?.kind === 'permission' || row.turn?.proofType === 'grant') {
    const risk = row.turn.permission?.risk;
    if (risk === 'high' || risk === 'never') return { move: 'page' };
    for (const verb of PERMISSION_ORDER) {
      const action = pressable.find((candidate) => candidate.verb === verb);
      if (action) return { move: 'row', action };
    }
    return { move: 'page' };
  }
  if (group === 'decide' || group === 'approve' || row.turn?.type === 'decide') {
    // A decision with options opens its card: its options sit side by side there.
    if ((row.options?.length ?? 0) > 1) return { move: 'page' };
    // One answer, and one that asks for no words: a box for evidence is the page's.
    const only = pressable.length === 1 && row.turn?.record !== 'ledger' ? pressable[0] : undefined;
    return only && !only.says ? { move: 'row', action: only } : { move: 'page' };
  }
  if (row.humanStep) return { move: 'step' };
  const first = pressable[0];
  return first ? { move: 'row', action: first } : { move: 'page' };
}

/** What a row with nothing to press says instead. */
const NONE_WORDS: Readonly<Record<Extract<RowPrimary, { move: 'none' }>['why'], string>> = {
  upcoming: 'Not due yet.',
  checking: 'Being checked.',
  settled: 'Done.',
};

export interface ItemRowProps {
  /** The inbox row that is (or projects) the item — its `turn` view, its actions. */
  row: InboxItem;
  /** Presses a row action verbatim (`useInboxActions().perform`). */
  perform?: Perform | undefined;
  /** `${rowId}:${verb}` of whatever row action is in flight. */
  busy?: string | undefined;
  className?: string | undefined;
  /** The primary's test id — a strip names its one action `strip-action`. */
  testId?: string | undefined;
  /** The primary alone — a strip's ONE action; it falls back to the link, and `className` dresses it. */
  primaryOnly?: boolean | undefined;
}

function Primary({
  row,
  primary,
  perform,
  busy,
  testId,
  className,
}: {
  row: InboxItem;
  primary: RowPrimary;
  perform?: Perform | undefined;
  busy?: string | undefined;
  testId: string;
  className?: string | undefined;
}) {
  switch (primary.move) {
    case 'step':
      return (
        <HumanStepPrimary item={row} testId={testId} className={className} perform={perform} busy={busy} />
      );
    case 'row':
      return (
        <Button
          size="sm"
          variant="primary"
          data-testid={testId}
          data-move="row"
          data-verb={primary.action.verb}
          className={className}
          disabled={!perform || busy === `${row.id}:${primary.action.verb}`}
          onClick={() => perform?.(row, primary.action)}
        >
          {primary.action.label}
        </Button>
      );
    case 'page':
      return (
        <Button size="sm" variant="primary" className={className} asChild>
          <a href={turnHref(itemIdOf(row))} data-testid={testId} data-move="page">
            Open on Your turn
          </a>
        </Button>
      );
    default:
      return null;
  }
}

export default function ItemRow({
  row,
  perform,
  busy,
  className,
  testId = 'item-primary',
  primaryOnly = false,
}: ItemRowProps) {
  const primary = rowPrimaryOf(row);
  const shown = primary.move === 'none' && primaryOnly ? ({ move: 'page' } as const) : primary;
  if (primaryOnly)
    return (
      <Primary
        row={row}
        primary={shown}
        perform={perform}
        busy={busy}
        testId={testId}
        className={className}
      />
    );
  const kind = row.turn?.kind ?? row.humanStep?.kind;
  const risk = row.turn?.permission?.risk;
  return (
    <div
      data-testid="item-row"
      data-item={itemIdOf(row)}
      data-kind={kind}
      data-record={row.turn?.record}
      data-type={row.turn?.type}
      className={cn('flex min-w-0 flex-col gap-1.5', className)}
    >
      <TurnRowWords turn={row.turn} />
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        {/* The composer's title — the act, as the card heads it (turn-by-turn phase 3). */}
        <span data-testid="item-row-title" className="min-w-0 flex-1 basis-40 text-body font-medium text-ink">
          {row.title || row.humanStep?.title}
        </span>
        {kind && <KindMark kind={kind} />}
        {risk && <OpsStatus vocab="risk" word={risk} />}
        {row.slug && (
          <span className="text-meta text-ink-muted">
            {row.slug}
            {row.phase != null ? `, phase ${row.phase}` : ''}
          </span>
        )}
      </div>
      {/* `relative`: a pick box's touch overlay must not win this line's corner. */}
      <div className="relative flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <Primary row={row} primary={shown} perform={perform} busy={busy} testId={testId} />
        {primary.move === 'none' && (
          <span className="text-meta text-ink-muted">{NONE_WORDS[primary.why]}</span>
        )}
        {primary.move !== 'page' && (
          <a
            href={turnHref(itemIdOf(row))}
            data-testid="item-link"
            className="tap-row text-meta text-ink-muted underline decoration-rule-strong underline-offset-2 hover:text-ink"
          >
            Open on Your turn
          </a>
        )}
      </div>
    </div>
  );
}
