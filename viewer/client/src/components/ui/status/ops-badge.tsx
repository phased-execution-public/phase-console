import { describeWord, type StatusVocab } from '@shared/status-model.js';
import { ViewBadge, type BadgeChrome, type WordOf } from './view-badge';

/**
 * The vocabularies with a badge of their own are not ops words: a run, a phase,
 * a plan, QA, an account and an MCP server each have their wrapper.
 */
type OwnBadge = 'run' | 'phase' | 'board' | 'plan' | 'qa-result' | 'qa-mode' | 'auth' | 'entitlement' | 'mcp';

/** Every other word the console paints — the console's machinery and the plan file's lesser words. */
export type OpsVocab = Exclude<StatusVocab, OwnBadge>;

/**
 * One word of one ops vocabulary — a handoff, a gate kind, a delivery, a watch,
 * a decision, presence, a console's liveness, a rung, health, a probe, a
 * restart, a checkout, the radar, a verification, a note. The word is typed by
 * the vocabulary named beside it: `vocab="probe"` accepts `ok`, `fail`, `skip`
 * and nothing else.
 */
export function OpsBadge<V extends OpsVocab>({
  vocab,
  word,
  ...chrome
}: { vocab: V; word: WordOf<V> | null | undefined } & BadgeChrome) {
  return <ViewBadge view={describeWord(vocab, word)} {...chrome} />;
}
