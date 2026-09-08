/**
 * Asking less — the posture group.
 *
 * A read-out, not a control, and deliberately so. Every knob it names has
 * exactly one control, in the two cards above; a second checkbox here would be
 * a second copy of a preference, and two controls for one preference disagree
 * the day their fallbacks do (`automation-coverage.test.tsx` is the guard).
 *
 * What it adds is the reading none of those cards can give, because each one
 * only knows its own switch: **how often does this console stop and wait for
 * a person, and why.** That question is answered by three settings that sit in
 * two different cards under two different headings, and until you have read
 * all three you cannot say whether an unattended run will get through the
 * night.
 *
 * It is also the group Phase 12's automation-posture sweep lands in. That
 * phase's whole subject is minimising human intervention, so its new
 * preferences belong under this heading rather than appended to the end of a
 * card named after something else — and the group existing NOW means the sweep
 * inherits an information architecture instead of inventing one, which is how
 * a settings page comes to have fifteen cards and no order.
 */

import { useConsoleState } from '@/lib/queries';
import { automationPrefs, ladderPrefs } from '@/lib/api';
import { resumeAtBootMode } from '@shared/automation-model.js';
import { Card, CardBody, CardHeader, CardSkeleton, CardTitle } from '@/components/ui';

/** One posture fact: what it does now, and the word for the setting behind it. */
interface Posture {
  /** The setting's own name, as the control above spells it. */
  setting: string;
  /** What is happening today, in the operator's words. */
  reading: string;
  /** True when the console is the one deciding — the calm, hands-off answer. */
  handsOff: boolean;
}

export function PostureCard() {
  const { data: state, isPending } = useConsoleState();
  if (isPending && !state) return <CardSkeleton loading h="48" />;

  // Two readers, because the two settings live in two cards and each card
  // owns the `?? shipped` fallback for its own keys. Reading `state.prefs`
  // raw here would show `undefined` as "off" for a console whose config
  // predates the key — which is the opposite of what it does.
  const ladder = ladderPrefs(state);
  const automation = automationPrefs(state);
  const resume = resumeAtBootMode(state?.prefs?.resumeAtBoot);

  const postures: Posture[] = [
    {
      setting: 'Gates',
      handsOff: ladder.delegateHumanGates === true,
      reading:
        ladder.delegateHumanGates === true
          ? 'A session may clear a human gate itself, against evidence it can cite.'
          : 'A human gate stops the phase until you approve it.',
    },
    {
      setting: 'A phase that stops',
      handsOff: automation.autoContinueRecovery === true,
      reading:
        automation.autoContinueRecovery === true
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

  const asks = postures.filter((posture) => !posture.handsOff).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Asking less</CardTitle>
        <span className="text-2xs text-ink-faint">
          {asks === 0 ? 'nothing waits on you' : `${asks} of ${postures.length} still wait on you`}
        </span>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <p className="text-2xs text-ink-muted">
          The three moments an unattended run can end up waiting for a person. Each is set by a control above;
          this is the reading none of them can give on its own.
        </p>

        <dl className="flex min-w-0 flex-col gap-2">
          {postures.map((posture) => (
            <div key={posture.setting} className="min-w-0">
              <dt className="flex min-w-0 items-baseline gap-2 text-sm text-ink">
                {posture.setting}
                {/* The word, not a colour. Neither answer is the wrong one —
                    a console somebody watches all day SHOULD ask — so this is
                    a reading, never a warning. */}
                <span className="tnum text-2xs text-ink-faint">
                  {posture.handsOff ? 'by itself' : 'asks you'}
                </span>
              </dt>
              <dd className="mt-0.5 text-2xs text-ink-muted">{posture.reading}</dd>
            </div>
          ))}
        </dl>
      </CardBody>
    </Card>
  );
}
