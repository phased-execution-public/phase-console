import { describePhase, type PhaseCtx, type PhaseRecordLike } from '@shared/status-model.js';
import { DotWord } from './dot-word';
import type { Chrome, WordOf } from './view';

/**
 * A phase — its run record when a run has one, its board word always when the
 * plan has been read. The board saying `done` wins over any record.
 */
export type PhaseStatusProps = {
  record?: (Omit<PhaseRecordLike, 'status'> & { status: WordOf<'phase'> }) | null;
  board?: WordOf<'board'> | null;
  ctx?: Omit<PhaseCtx, 'boardState'>;
} & Chrome;

/** A PHASE's status — `describePhase`, drawn. Accepts phase-record and board words only. */
export function PhaseStatus({ record, board, ctx, ...chrome }: PhaseStatusProps) {
  return <DotWord view={describePhase(record ?? null, { ...ctx, boardState: board ?? null })} {...chrome} />;
}
