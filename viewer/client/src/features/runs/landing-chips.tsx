/**
 * The two landing chips a phase row wears (many-plans-one-repo phase 15), and
 * the sentences behind them.
 *
 * Two chips because they are two facts from two sources. `Land:` is what the
 * PLAN says happens to the phase's commits — the phase's own line, else the
 * plan's, else the shipped default — resolved by the server (`PhaseView.land`)
 * and never changing while the run drives. The state is where the landing HAS
 * GOT TO, written by the engine on the run record (`PhaseRecord.landing`) and
 * moving as it works.
 *
 * Free code on purpose, though only the Pro engine ever writes a landing: the
 * phase table is a free file, and a chip that renders nothing without its
 * fact costs the free tree nothing. The run page's landing card (Pro) reads
 * the same sentences from here, so the row and the card never disagree about
 * what `watch` means.
 */

import { LAND_LABELS } from '@shared/landing-model.js';
import { Chip, type ChipTone } from '@/components/ui';
import type { PhaseLanding, PhaseView } from '@/lib/api';

/** The engine's step, as a sentence — finer than the ledger's word, and what a person waits on. */
export function landingStepText(landing: PhaseLanding): string {
  switch (landing.step) {
    case 'local':
      return 'landing locally';
    case 'push':
      return 'pushing the branch';
    case 'session':
      return 'a landing session is opening the pull request';
    case 'verify':
      return 'verifying the pull request with gh';
    case 'watch':
      return 'watching the pull request — the phase lands when it merges';
    case 'done':
      return 'done';
    case 'parked':
      return landing.resumeFrom
        ? `parked — resumes from ${landing.resumeFrom} on the next drive`
        : 'parked — a person owns the next step';
    default:
      return String(landing.step);
  }
}

/**
 * The tone a landing paints in. A PARKED landing is the amber family — a
 * person owns the next step — never the failed red: nothing failed, the
 * engine set the phase aside and drove on. `conflict` under any other step
 * and `failed` are what they say.
 */
export function landingTone(landing: Pick<PhaseLanding, 'state' | 'step'>): ChipTone {
  if (landing.step === 'parked') return 'accent';
  const { state } = landing;
  if (state === 'landed' || state === 'pr-merged' || state === 'integrated') return 'ok';
  if (state === 'conflict' || state === 'failed') return 'bad';
  if (state === 'held') return 'neutral';
  return 'wait';
}

const LAND_SOURCE_TITLE: Record<NonNullable<PhaseView['land']>['source'], string> = {
  phase: 'From this phase’s own `Land:` line.',
  plan: 'From the plan’s `Land:` line (§Session budget).',
  default: 'The shipped default — the plan says nothing.',
};

/**
 * The plan's word, on the row. Nothing for the shipped default: every row
 * would read `hold`, and a chip on every row says nothing. A `hold` the plan
 * asked for by name is a decision, and it shows.
 */
export function LandChip({ land }: { land: PhaseView['land'] | undefined }) {
  if (!land || land.source === 'default') return null;
  return (
    <Chip
      tone="neutral"
      mono
      data-testid="land-chip"
      title={`${LAND_LABELS[land.value] ?? land.value}\n${LAND_SOURCE_TITLE[land.source]}`}
    >
      Land: {land.value}
    </Chip>
  );
}

/** Where the landing has got to — the ledger's word, with the engine's step on hover. */
export function LandingStateChip({ landing }: { landing: PhaseLanding | undefined }) {
  if (!landing) return null;
  return (
    <Chip tone={landingTone(landing)} mono data-testid="landing-state-chip" title={landingStepText(landing)}>
      {landing.state}
    </Chip>
  );
}
