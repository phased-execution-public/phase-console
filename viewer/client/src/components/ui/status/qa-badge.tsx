import { describeWord } from '@shared/status-model.js';
import { ViewBadge, type BadgeChrome, type WordOf } from './view-badge';

/**
 * QA — a phase's recorded verdict, or a plan's regime. Two vocabularies that
 * share a word (`waived`) and mean different things by it, so the badge takes
 * exactly one of them and says which.
 */
export type QaBadgeProps = (
  | { result: WordOf<'qa-result'> | null | undefined; mode?: never }
  | { mode: WordOf<'qa-mode'> | null | undefined; result?: never }
) &
  BadgeChrome;

export function QaBadge({ result, mode, ...chrome }: QaBadgeProps) {
  const view = mode !== undefined ? describeWord('qa-mode', mode) : describeWord('qa-result', result);
  return <ViewBadge view={view} {...chrome} />;
}
