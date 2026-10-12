/**
 * QA on or off — for the plan, or for ONE phase — from the page (7.0,
 * quiet-console phase 10).
 *
 * The plan file carries both switches — `**QA gate:** on|off` in §Session
 * budget, `- **QA:** on|off` in a phase's own block — and `scripts/qa-mode.sh`
 * is their writer; this is its control. Two rules ride with it:
 *
 *  - **write-class.** It edits the plan file, so it sits behind
 *    `--allow-writes`; without the flag the switch is disabled AND the hand
 *    command is printed, never nothing.
 *  - **the engine's word, never the directive echoed.** The word drawn is the
 *    regime every board read applies — with a ledger on disk a written `off`
 *    reads as released — with the engine's own reason beside it, verbatim.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { QA_DIRECTIVES } from '@shared/plan-vocab.js';
import { api } from '@/data/api';
import { keys } from '@/data/keys';
import { press } from '@/data/press';
import { Button, ButtonGroup, Mono, toast } from '@/ui';
import { QaStatus, type WordOf } from '@/ui/status';

/** What a QA directive may be SET to — the writer's vocabulary, which the engine reads back as a regime. */
export type QaDirective = (typeof QA_DIRECTIVES)[number];

/** A plan has nothing to inherit from: its switch is every directive but a phase's own. */
const PLAN_DIRECTIVES: readonly QaDirective[] = QA_DIRECTIVES.filter((directive) => directive !== 'inherit');

const CAPTION: Record<QaDirective, string> = { on: 'On', off: 'Off', inherit: 'Inherit' };
const TITLE: Record<QaDirective, string> = {
  on: 'Writes on: a recorded failing or pending verdict holds every dependent phase.',
  off: 'Writes off: verdicts stay on file and stop holding dependents.',
  inherit: 'Removes this phase’s own directive, so the plan’s regime applies.',
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
  mode?: string | undefined;
  /** The engine's reason beside it (`summary.qaModeReason`). */
  reason?: string | undefined;
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
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const perPhase = phase != null;
  const planWord = mode ?? 'off';
  const own = phaseMode?.source === 'phase';
  const word = perPhase ? (phaseMode?.mode ?? planWord) : planWord;
  const current: QaDirective = perPhase && !own ? 'inherit' : word === 'on' ? 'on' : 'off';
  const choices: readonly QaDirective[] = perPhase ? QA_DIRECTIVES : PLAN_DIRECTIVES;
  const sealed = allowWrites === false;
  const hand = `bash ${scriptsDir}/qa-mode.sh ${slug}${perPhase ? ` --phase ${phase}` : ''} <${choices.join('|')}>`;

  const set = (directive: QaDirective) => {
    // The current choice is a mark, not a press: there is nothing to write.
    if (directive === current || busy || sealed) return;
    setBusy(true);
    void (async () => {
      try {
        const pressed = await press(() =>
          api.qaModeSet(slug, { mode: directive, ...(perPhase ? { phase } : {}) }),
        );
        if (pressed.state === 'asked') toast(pressed.words, 'info');
        // The server's own sentence: it read the regime back from the engine.
        else if (pressed.result.ok) toast(pressed.result.detail, 'ok');
        else toast(pressed.result.detail || 'The QA regime did not change.', 'error');
      } catch (cause) {
        toast(
          cause instanceof Error && cause.message ? cause.message : 'The press failed and said nothing.',
          'error',
        );
      } finally {
        setBusy(false);
        for (const queryKey of keys.afterPlanWrite(slug)) void client.invalidateQueries({ queryKey });
      }
    })();
  };

  return (
    <div
      className="flex min-w-0 flex-col gap-1.5"
      data-testid={perPhase ? `qa-mode-phase-${phase}` : 'qa-mode-plan'}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <QaStatus mode={word as WordOf<'qa-mode'>} />
        {perPhase ? (
          <span className="text-meta text-ink-muted">{own ? 'set by this phase' : 'from the plan'}</span>
        ) : (
          reason && <span className="min-w-0 break-words text-meta text-ink-muted">{reason}</span>
        )}
        <ButtonGroup aria-label={perPhase ? `QA for phase ${phase}` : 'QA gate'}>
          {choices.map((choice) => (
            <Button
              key={choice}
              size={size}
              variant="ghost"
              aria-pressed={choice === current}
              disabled={sealed || busy}
              title={sealed ? SEALED : choice === current ? undefined : TITLE[choice]}
              onClick={() => set(choice)}
            >
              {CAPTION[choice]}
            </Button>
          ))}
        </ButtonGroup>
      </div>
      {/* The exact line, rather than a dead switch: a console that cannot
          write can still do this, in a terminal. */}
      {sealed && (
        <p className="min-w-0 text-meta text-ink-muted">
          By hand: <Mono copyable className="wrap-anywhere" value={hand} />
        </p>
      )}
    </div>
  );
}
