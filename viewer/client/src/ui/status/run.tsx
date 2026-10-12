import { describeRun, type RunCtx, type RunLike } from '@shared/status-model.js';
import { DotWord } from './dot-word';
import type { Chrome, WordOf } from './view';

/** A run, in context: a closed plan, a newer run, the inbox and the clock decide what its word means. */
export type RunStatusProps = {
  run: Omit<RunLike, 'status'> & { status: WordOf<'run'> };
  ctx?: RunCtx;
} & Chrome;

/** A RUN's status — `describeRun`'s first-match table, drawn. Accepts run words only. */
export function RunStatus({ run, ctx, ...chrome }: RunStatusProps) {
  return <DotWord view={describeRun(run, ctx)} {...chrome} />;
}
