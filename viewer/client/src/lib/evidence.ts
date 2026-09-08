/**
 * The client half of the evidence vocabulary — a re-export, like
 * `lib/situation.ts`: the words, the truth table and the `why[]` prose live in
 * `shared/evidence-model.js`, imported by the server's `detail()`/
 * `phaseDiagnosis()`, by the runner's classifier and by this client alike, so
 * a badge, a panel and a journal line can never disagree about whether a phase
 * was actually verified. `test/evidence-model.test.ts` holds them identical by
 * import identity.
 *
 * The one thing to keep in mind when rendering this: `evidenced` is not
 * `done`. The board's `done` is a CLAIM — a `status: complete` line in a
 * handoff — and `evidenced` is whether anything ever ran to back it. A phase
 * can be legitimately done and not evidenced; say so, do not hide it.
 */

// Relative, not `@shared/…`: the node test suite imports THIS file directly
// and node resolves no Vite alias.
export {
  BOARD_WORDS,
  HANDOFF_WORDS,
  LIVE_VIA,
  QA_WORDS,
  RULING_KINDS,
  VERIFICATION_WORDS,
  deriveEvidence,
  isLiveVia,
  isQaWord,
  isVerificationWord,
} from '../../../shared/evidence-model.js';

// Re-exporting does NOT bind these locally, and the type aliases below read
// them — so they are imported as well as re-exported above. Same objects.
import {
  type BOARD_WORDS,
  type HANDOFF_WORDS,
  type RULING_KINDS,
  type VERIFICATION_WORDS,
} from '../../../shared/evidence-model.js';
import { type QA_DISPLAY_WORDS } from '../../../shared/plan-vocab.js';

export type VerificationWord = (typeof VERIFICATION_WORDS)[number];

export type QaWord = (typeof QA_DISPLAY_WORDS)[number];

export type BoardWord = (typeof BOARD_WORDS)[number];

export type HandoffWord = (typeof HANDOFF_WORDS)[number];

export type RulingKind = (typeof RULING_KINDS)[number];

/** Which witness saw a phase being worked — `LIVE_VIA`, as a type. */
export type LiveVia = 'run' | 'lock' | 'registry';

/**
 * The wire shape the plan and diagnosis endpoints carry. Optional on every
 * client mirror that embeds it: a freshly built client must keep working
 * against a not-yet-restarted older server, where the field is simply absent —
 * and absent reads as "we do not know", never as evidenced.
 */
export type EvidenceView = {
  board: BoardWord | string;
  handoff: HandoffWord | string;
  verification: VerificationWord | string;
  qa: QaWord | string;
  evidenced: boolean;
  /** The board paints work in flight and nothing live was found behind it. */
  stale?: boolean;
  why: string[];
};
