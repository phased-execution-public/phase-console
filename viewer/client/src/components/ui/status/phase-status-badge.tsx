import { describePhase, type PhaseCtx, type PhaseRecordLike } from '@shared/status-model.js';
import { ViewBadge, type BadgeChrome, type WordOf } from './view-badge';

/**
 * A phase — its run record when a run has one, its board word always when the
 * plan has been read. The board saying `done` wins over any record.
 */
export type PhaseStatusBadgeProps = {
  record?: (Omit<PhaseRecordLike, 'status'> & { status: WordOf<'phase'> }) | null;
  board?: WordOf<'board'> | null;
  ctx?: Omit<PhaseCtx, 'boardState'>;
} & BadgeChrome;

/** A PHASE's status — `describePhase`, drawn. Accepts phase-record and board words only. */
export function PhaseStatusBadge({ record, board, ctx, ...chrome }: PhaseStatusBadgeProps) {
  return (
    <ViewBadge view={describePhase(record ?? null, { ...ctx, boardState: board ?? null })} {...chrome} />
  );
}
