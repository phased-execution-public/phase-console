/**
 * How a board's phases divide into five sections — the rule, with no table
 * around it.
 *
 * ⚠️ **This file must stay a leaf: no imports, and nothing that renders.**
 *
 * It lived in `phase-table.tsx` and was imported from there by the plan page's
 * Phases tab, which is one small helper and 888 lines of table. ES modules have
 * no notion of taking only the part you named: importing `groupRows` pulled
 * `phase-table.tsx` into the plan route's chunk, and `phase-table` imports the
 * run-setup surface, so 77.6 KB of a form nobody on that route can see followed
 * it in. `check-dist.mjs` asserts it does not come back.
 *
 * The rule itself is unchanged, and the two callers still share it — which is
 * the point of it being one function. A second `groupOf` on the plan page is
 * how "Needs you" comes to mean two different things on two pages.
 */

/**
 * A run's word against the board's, for one row.
 *
 * The board reads handoff files, so a phase this run is working on right now
 * still reads `ready` — "Boarding" — until its handoff lands, which can be an
 * hour later. Two vocabularies for two different facts, and the row showed only
 * the stale one: retry a phase and the console went on calling it Boarding
 * while a session was demonstrably running in it.
 *
 * Never against `done` — that is the board saying the work is finished, and the
 * run record has never been allowed to overrule it.
 */
export function displayState(boardState: string, { running }: { running: boolean }): string {
  return running && boardState !== 'done' ? 'in-progress' : boardState;
}

/**
 * The five sections, in the order they are read.
 *
 * `needs-you` first because it is the only one with a person in it; `done` is
 * last and collapsed, because a finished phase is the one thing here nobody is
 * looking for.
 */
export const PHASE_GROUPS = [
  {
    id: 'needs-you',
    label: 'Needs you',
    hint: 'A gate, an errand, or a claim only a person can settle.',
    // Every board word the shared table calls `needs-you`, not just `stuck`.
    // `gated` and `blocked` were missing, so the two states that most need a
    // person fell through `groupOf`'s default and filed themselves under
    // Waiting — the one group a reader scrolls past.
    states: ['stuck', 'gated', 'blocked'],
  },
  {
    id: 'running',
    label: 'Running',
    hint: 'Live lanes, and what is queued behind a scope.',
    states: ['in-progress'],
  },
  { id: 'ready', label: 'Ready', hint: 'Every dependency is done.', states: ['ready'] },
  { id: 'waiting', label: 'Waiting', hint: 'Blocked on a phase that is not finished.', states: ['waiting'] },
  { id: 'done', label: 'Done', hint: 'Finished — by this run or any other session.', states: ['done'] },
] as const;

export type PhaseGroupId = (typeof PHASE_GROUPS)[number]['id'];

/**
 * The least a row has to be to be grouped: a board state, and optionally what a
 * run recorded against it.
 *
 * Wider than the run page's `MergedPhase` because the plan page groups the SAME
 * five ways over rows that have no run at all.
 */
export interface GroupablePhase {
  phase: number;
  state: string;
  record?: { status?: string };
}

/**
 * Which group a row belongs in.
 *
 * Read from the DISPLAYED state, not the board's: a phase this run is working
 * on right now belongs under Running even while the board still says `ready`.
 * A state the vocabulary does not name falls to `waiting` rather than
 * disappearing — a row that vanishes because the server learned a new word is
 * the worst outcome here.
 */
export function groupOf(row: GroupablePhase): PhaseGroupId {
  const running = row.record?.status === 'running';
  const showing = displayState(row.state, { running });
  const group = PHASE_GROUPS.find((g) => (g.states as readonly string[]).includes(showing));
  return group?.id ?? 'waiting';
}

/** The rows, split into the five groups, empty groups dropped. */
export function groupRows<Row extends GroupablePhase>(
  rows: readonly Row[],
): { id: PhaseGroupId; label: string; hint: string; rows: Row[] }[] {
  return PHASE_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    hint: group.hint,
    rows: rows.filter((row) => groupOf(row) === group.id),
  })).filter((group) => group.rows.length > 0);
}
