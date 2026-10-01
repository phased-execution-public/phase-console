import { describeWord } from '@shared/status-model.js';
import { ViewBadge, type BadgeChrome, type WordOf } from './view-badge';

/**
 * A plan's stored `status:`, painted. A plan file whose status line is missing
 * or is not a plan status (a sentence, an emoji) draws as Unknown — never as
 * grey text that looks like a word.
 */
export function PlanStatusBadge({
  status,
  ...chrome
}: { status: WordOf<'plan'> | null | undefined } & BadgeChrome) {
  return <ViewBadge view={describeWord('plan', status)} {...chrome} />;
}
