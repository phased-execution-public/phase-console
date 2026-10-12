import { describeWord } from '@shared/status-model.js';
import { DotWord } from './dot-word';
import type { Chrome, WordOf } from './view';

/**
 * QA — a phase's recorded verdict, or a plan's regime. Two vocabularies that
 * share a word (`waived`) and mean different things by it, so the member takes
 * exactly one of them and says which.
 */
export type QaStatusProps = (
  | { result: WordOf<'qa-result'> | null | undefined; mode?: never }
  | { mode: WordOf<'qa-mode'> | null | undefined; result?: never }
) &
  Chrome;

export function QaStatus({ result, mode, ...chrome }: QaStatusProps) {
  const view = mode !== undefined ? describeWord('qa-mode', mode) : describeWord('qa-result', result);
  return <DotWord view={view} {...chrome} />;
}
