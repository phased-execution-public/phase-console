/**
 * QA on or off — for the plan, or for ONE phase — from the page (2026-09-07).
 *
 * The plan file has carried both switches for as long as the engine has read
 * them: `**QA gate:** on|off` in §Session budget, `- **QA:** on|off` in a
 * phase's own block. The console could only ever turn the gate ON (the old
 * Enable QA button ran `new-handoff --qa`); turning it off, or exempting one
 * phase, was a hand edit the inbox described in prose. `scripts/qa-mode.sh`
 * is the writer and this is its control.
 *
 * Two rules it keeps from every other remedy on this console:
 *
 *  - **write-class.** It edits the plan file, so it sits behind
 *    `--allow-writes`; without the flag the buttons are disabled AND the hand
 *    command is printed, the way `QaRecoveryActions` prints `qa-record.sh`.
 *  - **the engine's word comes back, never the directive echoed.** The label
 *    reads what `phase-graph.sh --qa-mode [N]` reports — with a ledger on disk
 *    a written `off` reads `waived (plan directive: QA gate: off)` — because
 *    that is the regime every board read will actually apply.
 */

import { Button, toast } from '@/components/ui';
import { api } from '@/lib/api';
import { keys, useApiMutation } from '@/lib/queries';
import type { QaModeSetOutcome } from '@/lib/api';

export type QaDirective = 'on' | 'off' | 'inherit';

const CAPTION: Record<QaDirective, string> = { on: 'On', off: 'Off', inherit: 'Inherit' };
const TITLE: Record<QaDirective, string> = {
  on: 'Write `on` — a recorded fail or pending verdict holds every dependent phase.',
  off: 'Write `off` — verdicts stay on file and stop holding dependents.',
  inherit: "Remove this phase's own directive so the plan's regime applies.",
};
const SEALED = 'Switching QA writes the plan file. Restart the console with --allow-writes.';

export function QaModeControl({
  slug,
  mode,
  reason,
  phase,
  phaseMode,
  allowWrites,
  scriptsDir = 'scripts',
  size = 'sm',
}: {
  slug: string;
  /** The PLAN's regime as the engine reads it (`summary.qaMode`). */
  mode?: string;
  /** The engine's reason beside it (`summary.qaModeReason`). */
  reason?: string;
  /** Set for the per-phase control. */
  phase?: number;
  /** THIS phase's resolved regime and which line answered (`PhaseView.qaMode`). */
  phaseMode?: { mode: string; source: 'phase' | 'plan' };
  /** `undefined` means the caller does not track the flag — treated as allowed. */
  allowWrites?: boolean;
  /** Where `qa-mode.sh` lives on this machine, for the hand command. */
  scriptsDir?: string;
  size?: 'sm' | 'md';
}) {
  const perPhase = phase != null;
  const set = useApiMutation<QaDirective, QaModeSetOutcome>({
    fn: (directive) => api.qaModeSet(slug, { mode: directive, ...(perPhase ? { phase } : {}) }),
    invalidates: keys.afterPlanWrite(slug),
    // The server's own sentence: it read the regime back from the engine.
    say: (result) => (result.ok ? result.detail : null),
    onDone: (result) => {
      if (!result.ok) toast(result.detail || 'The QA regime did not change.', 'error');
    },
  });

  const planWord = mode ?? 'off';
  const own = phaseMode?.source === 'phase';
  const current: QaDirective = perPhase
    ? own
      ? phaseMode?.mode === 'on'
        ? 'on'
        : 'off'
      : 'inherit'
    : planWord === 'on'
      ? 'on'
      : 'off';
  const label = perPhase
    ? `QA for this phase · ${own ? `${phaseMode?.mode} (phase directive)` : `inherits the plan (${phaseMode?.mode ?? planWord})`}`
    : `QA gate · ${planWord}${reason ? ` (${reason})` : ''}`;
  const sealed = allowWrites === false;
  const choices: QaDirective[] = perPhase ? ['inherit', 'on', 'off'] : ['on', 'off'];
  const hand = `bash ${scriptsDir}/qa-mode.sh ${slug}${perPhase ? ` --phase ${phase} <on|off|inherit>` : ' <on|off>'}`;

  return (
    <div className="flex flex-col gap-1.5" data-testid={perPhase ? `qa-mode-phase-${phase}` : 'qa-mode-plan'}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-2xs text-ink-muted">{label}</span>
        <div className="flex gap-1" role="group" aria-label={perPhase ? `QA for phase ${phase}` : 'QA gate'}>
          {choices.map((choice) => (
            <Button
              key={choice}
              size={size}
              aria-pressed={choice === current}
              disabled={sealed || set.isPending || choice === current}
              title={sealed ? SEALED : TITLE[choice]}
              onClick={() => set.mutate(choice)}
            >
              {CAPTION[choice]}
            </Button>
          ))}
        </div>
      </div>
      {/* Printed rather than a dead button: a console that cannot write can
          still do this — in a terminal, with this exact line. */}
      {sealed && (
        <p className="text-2xs text-ink-faint">
          By hand: <code className="rounded bg-surface-raised px-1 font-mono break-all">{hand}</code>
        </p>
      )}
    </div>
  );
}
