/**
 * Asking less — how often this console stops and waits for a person, and why
 * (7.0's, quiet-console phase 21).
 *
 * ```
 * Asking less                                       2 of 3 still wait on you
 * Gates                    By itself
 * A session may clear an overdue gate against evidence it can cite. …
 * A phase that stops       Asks you
 * It waits for you to press Recover & continue.
 * Restarting the console   Asks you
 * You are asked at boot whether to resume interrupted runs.
 * ```
 *
 * A read-out, not a control, and deliberately so. Every setting it names has
 * exactly one control elsewhere in Automation; a second one here would be a
 * second copy of a preference, and two controls for one preference disagree
 * the day their fallbacks do (`automation-coverage.test.tsx` is the guard) —
 * so it carries no `data-pref`.
 *
 * What it adds is the reading none of those controls can give, because each
 * knows only its own switch: three settings, under different headings, decide
 * whether an unattended run gets through the night. Each is read from the
 * settings schema — the value the console runs with, or its shipped default.
 */

import { resumeAtBootMode } from '@shared/automation-model.js';
import type { PrefSchemaRow } from '@/data/console';
import { Skeleton } from '@/ui';
import { SettingsGroup, useSchemaRow } from './setting';

/** One posture fact: what it does now, and the name of the setting behind it. */
export interface Posture {
  /** The setting, as a person names it. */
  setting: string;
  /** What happens today, in the operator's words. */
  reading: string;
  /** True when the console decides by itself — the hands-off answer. */
  handsOff: boolean;
}

/** The three moments, read from the three settings that decide them. */
export function postureReadings(prefs: {
  delegateHumanGates: unknown;
  autoContinueRecovery: unknown;
  resumeAtBoot: unknown;
}): Posture[] {
  const resume = resumeAtBootMode(prefs.resumeAtBoot);
  return [
    {
      setting: 'Gates',
      handsOff: prefs.delegateHumanGates === true,
      reading:
        prefs.delegateHumanGates === true
          ? 'A session may clear an overdue gate against evidence it can cite. A manual gate waits for you.'
          : 'A gate that needs a person stops the phase until you approve it.',
    },
    {
      setting: 'A phase that stops',
      handsOff: prefs.autoContinueRecovery === true,
      reading:
        prefs.autoContinueRecovery === true
          ? 'The convergence loop retries it by itself, up the ladder.'
          : 'It waits for you to press Recover & continue.',
    },
    {
      setting: 'Restarting the console',
      handsOff: resume === 'auto',
      reading:
        resume === 'auto'
          ? 'Interrupted runs resume on their own at boot.'
          : resume === 'off'
            ? 'Interrupted runs stay stopped after a restart.'
            : 'You are asked at boot whether to resume interrupted runs.',
    },
  ];
}

/** What the console runs with: the value set, or the shipped default. */
const held = (row: PrefSchemaRow | undefined): unknown => (row ? (row.value ?? row.default) : undefined);

export function PostureGroup() {
  const gates = useSchemaRow('delegateHumanGates');
  const recover = useSchemaRow('autoContinueRecovery');
  const resume = useSchemaRow('resumeAtBoot');

  const postures = postureReadings({
    delegateHumanGates: held(gates.row),
    autoContinueRecovery: held(recover.row),
    resumeAtBoot: held(resume.row),
  });
  const asks = postures.filter((posture) => !posture.handsOff).length;
  const reading = gates.reading && !gates.row;

  return (
    <SettingsGroup
      id="posture"
      title="Asking less"
      aside={
        reading ? undefined : (
          <span className="text-meta text-ink-muted" data-testid="posture-count">
            {asks === 0 ? 'Nothing waits on you' : `${asks} of ${postures.length} still wait on you`}
          </span>
        )
      }
      lead="The three moments an unattended run can end up waiting for a person. Each is set by its own control in Automation; this is the reading none of them gives alone."
    >
      {reading ? (
        <div className="flex min-w-0 flex-col gap-3" aria-busy="true" aria-label="Reading the settings">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : (
        <dl className="flex min-w-0 flex-col gap-4">
          {postures.map((posture) => (
            <div
              key={posture.setting}
              className="min-w-0"
              data-posture={posture.handsOff ? 'by-itself' : 'asks'}
            >
              <dt className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-body text-ink">
                {posture.setting}
                {/* The word, not a colour: neither answer is the wrong one — a
                    console somebody watches all day SHOULD ask — so this is a
                    reading, never a warning. */}
                <span className="text-meta text-ink-muted">
                  {posture.handsOff ? 'By itself' : 'Asks you'}
                </span>
              </dt>
              <dd className="mt-0.5 max-w-(--measure) text-meta text-ink-muted">{posture.reading}</dd>
            </div>
          ))}
        </dl>
      )}
    </SettingsGroup>
  );
}
