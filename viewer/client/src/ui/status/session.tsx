import { describeWord, type StatusView } from '@shared/status-model.js';
import { DotWord } from './dot-word';
import type { Chrome } from './view';

/** The three vocabularies a session's word comes from: a lane's phase, a pty's `terminal`, a registry presence. */
export type SessionVocab = 'phase' | 'terminal' | 'presence';

/**
 * One session's mark (quiet-console phase 15). The Sessions list folds four
 * kinds of process into one row, so its word is one of three vocabularies at
 * run time — named beside the word, as `OpsStatus` names its own.
 *
 * A session stopped on a PERSON keeps its own word and takes the summons'
 * paint and fact, the way a summoned run does: one dot that says "Running"
 * and that it needs you.
 */
export function SessionStatus({
  vocab,
  word,
  summons,
  ...chrome
}: {
  vocab: SessionVocab;
  word: string | null | undefined;
  /** What it waits on a person for, in words ("needs your permission"). */
  summons?: string | undefined;
} & Chrome) {
  const view = describeWord(vocab, word);
  return <DotWord view={summons ? summoned(view, summons) : view} {...chrome} />;
}

function summoned(view: StatusView, text: string): StatusView {
  const next: StatusView = {
    ...view,
    paint: 'needs-you',
    tense: 'standing',
    attention: 'needs-you',
    note: { kind: 'waiting-on', text },
  };
  delete next.outcome;
  return next;
}
