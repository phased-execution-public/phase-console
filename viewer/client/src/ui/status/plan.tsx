import { describeWord } from '@shared/status-model.js';
import { DotWord } from './dot-word';
import type { Chrome, WordOf } from './view';

/**
 * A plan's stored `status:`, drawn. A plan file whose status line is missing
 * or is not a plan status (a sentence, an emoji) draws as Unknown — never as
 * grey text that looks like a word.
 */
export function PlanStatus({ status, ...chrome }: { status: WordOf<'plan'> | null | undefined } & Chrome) {
  return <DotWord view={describeWord('plan', status)} {...chrome} />;
}
