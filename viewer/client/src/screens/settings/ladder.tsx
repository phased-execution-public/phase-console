/**
 * Settings ▸ Automation, what happens when a phase stops (7.0, quiet-console
 * phase 21): how far the console repairs by itself and what it may spend
 * doing so, what else it does unasked, what it does at a usage wall, and when
 * a lane counts as stalled.
 *
 * ```
 * The ladder
 * A stopped phase is classified and the console climbs that situation's ladder …
 * Repair attempts per phase                         [ 3 ] attempts
 * Repair spend per phase                          [ 100 ] dollars
 * …
 * What it does by itself     [x] Unblock attempts … Resume killed lanes at boot [Ask ▾] …
 * At a usage wall            [x] Switch accounts at a wall …
 * When a lane stops being work
 * Call a lane silent after                          [ 10 ] minutes
 * …
 * ```
 *
 * Every number is the server's, read from the settings schema, and saves its
 * one key when the field is left. A clock is typed in minutes and sent in
 * milliseconds. A threshold the server keeps only above zero refuses a zero
 * here rather than having its save dropped in silence; where zero means
 * something, the hint says what. The start ceiling is the next group's
 * (`ceiling.tsx`).
 */

import { resumeAtBootMode, RESUME_AT_BOOT_MODES, type ResumeAtBootMode } from '@shared/automation-model.js';
import { STALL_DEFAULTS, STALL_ESCALATE_MS, STALL_LOCAL_JOB_MS } from '@shared/attention-model.js';
import { LADDER_PREF_DEFAULTS } from '@/data/api';
import { BoolSetting, NumberSetting, SettingsGroup, WordSetting, useSetting } from './setting';
import { formatUsd } from '@/ui/money';

/** A clock is typed in minutes and stored in milliseconds. */
const MINUTE = 60_000;

/** A stored clock, in the minutes a person types. */
const minutes = (ms: number): number => Math.round((ms / MINUTE) * 100) / 100;

/** The three answers to a lane a restart killed, in a person's words. */
const RESUME_WORDS: Readonly<Record<ResumeAtBootMode, string>> = {
  ask: 'Ask',
  auto: 'Always',
  off: 'Never',
};

const D = LADDER_PREF_DEFAULTS;

export function LadderGroups() {
  return (
    <>
      <LadderGroup />
      <ByItselfGroup />
      <UsageWallGroup />
      <StallGroup />
    </>
  );
}

/* ---------------- the caps ---------------- */

function LadderGroup() {
  return (
    <SettingsGroup
      id="automation-ladder"
      title="The ladder"
      lead="A stopped phase is classified and the console climbs that situation’s ladder, its own session first and a fresh briefed one next, until an attempt holds or these limits are spent. Then it leaves one errand and drives everything else."
    >
      <NumberSetting
        pref="ladderPerPhaseRungs"
        label="Repair attempts per phase"
        unit="attempts"
        integer
        min={0}
        hint={`How many repair attempts one phase gets before its errand is written and a person is asked (shipped: ${D.ladderPerPhaseRungs}).`}
      />
      <NumberSetting
        pref="ladderPerPhaseUsd"
        label="Repair spend per phase"
        unit="dollars"
        min={0}
        step={10}
        hint={`What the ladder may spend on one phase, every attempt counted (shipped: ${formatUsd(D.ladderPerPhaseUsd, 'short')}).`}
      />
      <NumberSetting
        pref="ladderPerRunRungs"
        label="Repair attempts per run"
        unit="attempts"
        integer
        min={0}
        hint={`Across every phase of one run (shipped: ${D.ladderPerRunRungs}).`}
      />
      <NumberSetting
        pref="ladderPerRunUsd"
        label="Repair spend per run"
        unit="dollars"
        min={0}
        step={10}
        hint={`Across every phase of one run (shipped: ${formatUsd(D.ladderPerRunUsd, 'short')}). The one automatic budget raise stays inside it.`}
      />
      <NumberSetting
        pref="ladderPerDayUsd"
        label="Repair spend per day"
        unit="dollars"
        min={0}
        step={10}
        hint={`What the ladder may spend in a day across every run this console drives; what the runs themselves cost is not counted (shipped: ${formatUsd(D.ladderPerDayUsd, 'short')}).`}
      />
      <NumberSetting
        pref="budgetAutoRaisePct"
        label="Raise a spent run budget once by"
        unit="%"
        min={0}
        hint={`The resource ladder’s one budget raise, inside the per-run limit above (shipped: ${D.budgetAutoRaisePct}%). 0 never raises: a spent budget halts with an errand at once.`}
      />
      <BoolSetting
        pref="ladderExtendOnProgress"
        label="One more attempt while the work is moving"
        hint={
          <>
            When a phase spends its attempts but the newest one landed commits, the ladder grants that phase
            one more (<code>phase.ladder-extended</code>); the dollar limits stand. Off, the count is the
            count.
          </>
        }
      />
    </SettingsGroup>
  );
}

/* ---------------- what it does by itself ---------------- */

function ByItselfGroup() {
  const resume = useSetting<unknown>('resumeAtBoot');
  return (
    <SettingsGroup
      id="automation-by-itself"
      title="What it does by itself"
      lead={
        <>
          Every automatic act is journalled on its run (<code>phase.situation</code>, <code>phase.rung</code>,{' '}
          <code>phase.errand</code>, <code>run.converge</code>) and yields to your Stop. QA is never
          dispatched by itself: that stays a press.
        </>
      }
    >
      <BoolSetting
        pref="unblockAttempts"
        label="Unblock attempts"
        hint="A handoff marked blocked for a reason no machine category fits gets one bounded session allowed to do the unblocking work, then an errand. Off, the errand at once."
      />
      <BoolSetting
        pref="staleClaimTakeover"
        label="Take over stale claims"
        hint="An expired foreign lock over unfinished work is taken over and the work continued. A live session’s claim is never touched, whatever this says."
      />
      {/* Three words, read through the owner: a stored `true` from before 3.5.0 is Ask. */}
      <WordSetting
        pref="resumeAtBoot"
        label="Resume killed lanes at boot"
        hint="A lane a console restart killed can resume its own session, at most 3 restarts in a row per phase before an errand. Ask (shipped) puts the question on screen the next time you open the app and starts nothing until you answer; Always resumes without asking; Never writes an errand and waits."
        options={RESUME_AT_BOOT_MODES.map((mode) => [mode, RESUME_WORDS[mode]] as const)}
        value={resumeAtBootMode(resume.value)}
        onChange={resume.save}
      />
      <BoolSetting
        pref="delegateHumanGates"
        label="Let a session clear an overdue gate"
        hint={
          <>
            A gate past its deadline goes to the phase’s session, which must cite evidence for every condition
            and stops, naming the condition, when it has none. On since 5.0.0: this console’s word for the
            manifest’s <code>gates</code> row (<code>gates: delegated</code>), which a plan’s own{' '}
            <code>## Decisions</code> row outranks. A gate the plan marks manual is yours whatever this says.
          </>
        }
      />
      <BoolSetting
        pref="allowUnverifiedPhases"
        label="Board a phase that states no verification"
        hint={
          <>
            Off, and deliberately: a phase whose plan has no Verification bullet parks at boarding until a
            command is added, because nothing would prove the work. On, it boards and passes on its handoff
            alone, recorded as <code>phase.verify-waived</code>; a bullet the runner cannot read still parks.
          </>
        }
      />
      <NumberSetting
        pref="convergeEveryMs"
        label="Sweep every"
        unit="minutes"
        scale={MINUTE}
        min={0}
        hint={`How often the convergence loop re-reads every open plan when nothing happened (shipped: ${minutes(D.convergeEveryMs)} minutes). Boot, a docs change and the minute after a stop always run a pass; 0 turns the timer off.`}
      />
      <NumberSetting
        pref="mcpRequireTimeoutMs"
        label="Park on a required MCP server for"
        unit="minutes"
        scale={MINUTE}
        min={0}
        hint={`A phase parked by the require policy continues without the server after this long, with an errand recorded (shipped: ${minutes(D.mcpRequireTimeoutMs)} minutes). 0 waits for the server to heal, however long.`}
      />
    </SettingsGroup>
  );
}

/* ---------------- at a usage wall ---------------- */

function UsageWallGroup() {
  return (
    <SettingsGroup id="automation-usage" title="At a usage wall">
      <BoolSetting
        pref="autoAccountSwitch"
        label="Switch accounts at a wall"
        hint="A signed-out run account, or a usage window too far off to sleep on, switches the run to a registered account that can pay, and the session’s transcript comes along. Off, the wall halts with an errand."
      />
      <NumberSetting
        pref="usageForecastLeadHours"
        label="Warn before an account walls"
        unit="hours"
        min={0}
        hint={`How long before an account serving live runs is projected to wall, at its measured burn, the Usage climbing notification says so (shipped: ${D.usageForecastLeadHours} hours).`}
      />
      <BoolSetting
        pref="usageForecastHold"
        label="Hold new work on an account projected to wall"
        hint="When that warning fires, the account takes no new lane while one is live on it, until its window resets, so no phase starts work the wall will cut off. Off, the warning only warns."
      />
    </SettingsGroup>
  );
}

/* ---------------- when a lane stops being work ---------------- */

/**
 * Thresholds, not policy: crossing one announces it and journals it, and what
 * happens next is a person's press — except the two park rows, which say so.
 * The server keeps the detectors' numbers only above zero, so those fields
 * refuse a zero; the two clocks whose zero means something say what it means.
 */
function StallGroup() {
  return (
    <SettingsGroup
      id="automation-stalls"
      title="When a lane stops being work"
      lead="Crossing one of these is announced and journalled; what happens next is your press, except where a row says it parks the lane."
    >
      <NumberSetting
        pref="stallSilentMs"
        label="Call a lane silent after"
        unit="minutes"
        scale={MINUTE}
        min={1}
        hint={`No productive output for this long, API retries not counted, and never while a phase is verifying (shipped: ${minutes(STALL_DEFAULTS.stallSilentMs)} minutes).`}
      />
      <NumberSetting
        pref="stallRetryBurst"
        label="Call it retrying after"
        unit="retries"
        integer
        min={1}
        hint={`API retries in a row with no turn and no tool call between them: the session cannot reach the API (shipped: ${STALL_DEFAULTS.stallRetryBurst}). Noticing only; the run’s on-limit policy acts on its own, stricter count.`}
      />
      <NumberSetting
        pref="stallExternalWaitMs"
        label="Park a lane waiting on an external clock after"
        unit="minutes"
        scale={MINUTE}
        min={0}
        hint={
          <>
            A Bash call that waits on something outside the session, such as <code>gh run watch</code>, an{' '}
            <code>until … sleep</code> poll or a <code>--watch</code> flag, open this long (shipped:{' '}
            {minutes(STALL_DEFAULTS.stallExternalWaitMs)} minutes). This one acts: the phase parks, its lock
            is released and its own session resumes when the window elapses. 0 never parks a lane for waiting.
          </>
        }
      />
      <BoolSetting
        pref="stallAutomaticPark"
        label="Park a waiting lane by itself"
        hint="On (shipped), a lane waiting inside its turn, an open poll loop or a wait the console refused, is checkpointed and parked in the console’s own name, never on the session’s declared waits. Off, the stall card still stands and the background-job nudge still goes, but nothing is parked."
      />
      <NumberSetting
        pref="stallLocalJobMs"
        label="Park a lane waiting on its own background job after"
        unit="minutes"
        scale={MINUTE}
        min={1}
        hint={
          <>
            The same open Bash call when what it waits on is a job the session started itself, a suite, a
            build or a log it tails (shipped: {minutes(STALL_LOCAL_JOB_MS)} minutes). Far longer on purpose:
            the session first gets one nudge to background the job, and the park, when it comes, carries the
            loop’s own condition as a <code>cmd:</code> watch ref. This clock has no off.
          </>
        }
      />
      <NumberSetting
        pref="stallSpinTurns"
        label="Call it spinning after"
        unit="turns"
        integer
        min={1}
        hint={`Assistant turns in a row with no tool call in any of them: thinking, not doing (shipped: ${STALL_DEFAULTS.stallSpinTurns}).`}
      />
      <NumberSetting
        pref="stallLoopRun"
        label="Call it looping after"
        unit="identical failures"
        integer
        min={1}
        hint={
          <>
            Identical failing tool calls in a row: the same tool, the same command, the same words back
            (shipped: {STALL_DEFAULTS.stallLoopRun}). Noticing only, an inbox row and{' '}
            <code>phase.suspect</code>, never a park.
          </>
        }
      />
      <NumberSetting
        pref="stallStalemateAttempts"
        label="Call it a stalemate after"
        unit="attempts"
        integer
        min={1}
        hint={`Attempts in a row that committed nothing and left a clean tree, when re-running has stopped being a remedy (shipped: ${STALL_DEFAULTS.stallStalemateAttempts}).`}
      />
      <NumberSetting
        pref="stallEscalateMs"
        label="Say it again, urgently, after"
        unit="minutes"
        scale={MINUTE}
        min={0}
        hint={`A stall nothing has resolved by then is announced once more, urgently (shipped: ${minutes(STALL_ESCALATE_MS)} minutes). 0 never escalates a stall.`}
      />
    </SettingsGroup>
  );
}
