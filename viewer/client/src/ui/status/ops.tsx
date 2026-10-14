import { describeWord, type StatusVocab } from '@shared/status-model.js';
import { DotWord } from './dot-word';
import type { Chrome, WordOf } from './view';

/**
 * The vocabularies with a member of their own are not ops words: a run, a
 * phase, a plan, QA, an account and an MCP server each have their wrapper.
 */
type OwnMember =
  | 'run'
  | 'phase'
  | 'board'
  | 'plan'
  | 'qa-result'
  | 'qa-mode'
  | 'auth'
  | 'entitlement'
  | 'mcp'
  | 'turn'
  | 'readiness';

/** Every other word the console paints — the console's machinery and the plan file's lesser words. */
export type OpsVocab = Exclude<StatusVocab, OwnMember>;

/**
 * One word of one ops vocabulary — a handoff, a gate kind, a delivery, a watch,
 * a decision, presence, a console's liveness, a rung, health, a probe, a
 * restart, a checkout, the radar, a verification, a note, a step. The word is
 * typed by the vocabulary named beside it: `vocab="probe"` accepts `ok`,
 * `fail`, `skip` and nothing else.
 */
export function OpsStatus<V extends OpsVocab>({
  vocab,
  word,
  ...chrome
}: { vocab: V; word: WordOf<V> | null | undefined } & Chrome) {
  return <DotWord view={describeWord(vocab, word)} {...chrome} />;
}
