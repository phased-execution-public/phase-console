/**
 * The recovery verbs a surface performs through the run's own route
 * (`runRecoverVerb`) — the one list.
 *
 * It had two copies: the `RunRecoverVerb` union in `run-recover.ts` and a
 * `Set` in `components/recovery-actions.tsx`, which decides which of the
 * recovery model's verbs a button may press. The strip (control-tower phase
 * 19) asks the same question to pick its ONE action — the button the halt card
 * draws first — so the answer moved here, dependency-free, where a pure model
 * can read it without the router and the toast `run-recover.ts` imports.
 */

export const RUN_RECOVER_VERBS = Object.freeze([
  'recheck',
  'closeout',
  'resume',
  'delegate',
  'errand-answered',
  'retry',
  'retry-edits',
  'skip',
  'mcp-continue',
  'auto-recover',
] as const);

export type RunRecoverVerb = (typeof RUN_RECOVER_VERBS)[number];

export function isRunRecoverVerb(id: string): id is RunRecoverVerb {
  return (RUN_RECOVER_VERBS as readonly string[]).includes(id);
}
