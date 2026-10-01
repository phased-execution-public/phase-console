import { describeRun, type RunCtx, type RunLike } from '@shared/status-model.js';
import { ViewBadge, type BadgeChrome, type WordOf } from './view-badge';

/** A run, in context: a closed plan, a newer run, the inbox and the clock decide what its word means. */
export type RunStatusBadgeProps = {
  run: Omit<RunLike, 'status'> & { status: WordOf<'run'> };
  ctx?: RunCtx;
} & BadgeChrome;

/** A RUN's status — `describeRun`'s first-match table, drawn. Accepts run words only. */
export function RunStatusBadge({ run, ctx, ...chrome }: RunStatusBadgeProps) {
  return <ViewBadge view={describeRun(run, ctx)} {...chrome} />;
}
