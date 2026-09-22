/**
 * The ladder's knobs — what the autopilot may do by itself, and how much of it.
 *
 * Twelve server-side preferences, all per console (`~/.config/phase-console/…`
 * per instance), all already honoured by the runner and the convergence loop
 * before this card existed: the ladder caps (rungs AND dollars per phase, per
 * run, per day), how often the loop sweeps, the one budget raise, how long a
 * `require` MCP park waits, and the four toggles the design named — unblock
 * attempts on a declared blocker, taking over a stale foreign claim, resuming
 * the lanes a console restart killed, switching to an account that can pay.
 * QA auto-dispatch is deliberately not here: the autopilot never spawns
 * reviewers on its own, and a knob that does not exist cannot be turned on.
 *
 * Same discipline as the Automation card beside it: rendered from `/api/state`
 * (what the process holds, never a local copy of the intention), saved one key
 * per change through `POST /api/prefs`, which merges server-side — two tabs
 * editing different knobs must not overwrite each other. A number field saves
 * on blur or Enter; the server's sanitiser keeps finite numbers ≥ 0 and falls
 * back to the default for anything else, so a cleared field reads as the
 * shipped value on the next render rather than as zero.
 */

import { useEffect, useState, type KeyboardEvent } from 'react';
import { cn } from '@/lib/cn';
import { useConsoleState, useSavePrefs } from '@/lib/queries';
import { ladderPrefs, LADDER_PREF_DEFAULTS } from '@/lib/api';
import { STALL_DEFAULTS, STALL_ESCALATE_MS, STALL_LOCAL_JOB_MS } from '@shared/attention-model.js';
import { resumeAtBootMode } from '@shared/automation-model.js';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  CardSkeleton,
  SectionHeading,
  field,
} from '@/components/ui';

/** Minutes ⇄ milliseconds for the two interval knobs; 0 stays 0 ("off" / "forever"). */
const minutes = (ms: number) => (ms > 0 ? Math.max(1, Math.round(ms / 60_000)) : 0);

/**
 * One numeric knob: local text while typing, the preference on blur/Enter.
 * `unit` is shown after the field; `zero` is what the field means at 0.
 *
 * Exported because the Automation card needs exactly this control for the
 * worktree cap. A second copy would be a second set of edge cases — reverting
 * an invalid entry, re-syncing when another tab saves — so it is shared rather
 * than re-typed. It still LIVES here, where most of its callers are.
 */
export function NumberField({
  id,
  pref,
  label,
  hint,
  value,
  unit,
  zero,
  min = 0,
  step = 1,
  disabled,
  onSave,
}: {
  id: string;
  /**
   * The preference key this field writes — stamped as `data-pref` so the
   * Automation coverage test can walk the rendered section and prove every
   * preference the server accepts reaches exactly one control. The `id` is for
   * the label's `htmlFor` and is a DOM concern; this is the wiring.
   */
  pref?: string;
  label: string;
  hint: string;
  value: number;
  unit?: string;
  /** The sentence for a zero — e.g. "0 = never". Omit when zero is just zero. */
  zero?: string;
  min?: number;
  step?: number;
  disabled?: boolean;
  onSave: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  // The process is the truth: when a save lands (or another tab's does), the
  // field follows what the server now holds.
  useEffect(() => {
    setText(String(value));
  }, [value]);
  const commit = () => {
    const next = Number(text);
    if (!Number.isFinite(next) || next < min) {
      setText(String(value));
      return;
    }
    if (next === value) return;
    onSave(next);
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      (event.target as HTMLInputElement).blur();
    }
    if (event.key === 'Escape') {
      setText(String(value));
      (event.target as HTMLInputElement).blur();
    }
  };
  return (
    <div data-pref={pref} className="flex flex-wrap items-center justify-between gap-2">
      <span className="min-w-0">
        <label htmlFor={id} className="text-sm text-ink">
          {label}
        </label>
        <span className="mt-0.5 block text-2xs text-ink-muted">
          {hint}
          {zero ? ` ${zero}` : ''}
        </span>
      </span>
      <span className="inline-flex items-center gap-1">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={min}
          step={step}
          value={text}
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={onKey}
          className={cn(field, 'w-24 text-right font-mono tabular-nums')}
        />
        {unit && <span className="text-2xs text-ink-muted">{unit}</span>}
      </span>
    </div>
  );
}

export function LadderCard() {
  const { data: state, isPending } = useConsoleState();

  // One key at a time, merged server-side — see the Automation card.
  const save = useSavePrefs();

  if (isPending && !state) return <CardSkeleton loading h="64" />;

  const prefs = ladderPrefs(state);
  // Same `?? shipped` rule as `ladderPrefs`, for the four keys the stall
  // detector reads. A console whose config predates them reads the defaults
  // rather than zero, which would mean "never notice".
  const stored = state?.prefs ?? {};
  const positive = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
  const stall = {
    stallSilentMs: positive(stored.stallSilentMs, STALL_DEFAULTS.stallSilentMs),
    stallSpinTurns: positive(stored.stallSpinTurns, STALL_DEFAULTS.stallSpinTurns),
    stallStalemateAttempts: positive(stored.stallStalemateAttempts, STALL_DEFAULTS.stallStalemateAttempts),
    stallRetryBurst: positive(stored.stallRetryBurst, STALL_DEFAULTS.stallRetryBurst),
    stallExternalWaitMs: positive(stored.stallExternalWaitMs, STALL_DEFAULTS.stallExternalWaitMs),
    stallLoopRun: positive(stored.stallLoopRun, STALL_DEFAULTS.stallLoopRun),
    // Not a member of STALL_DEFAULTS on purpose — that map is a bijection with
    // the stall signals, and this is the clock on the ANNOUNCEMENT rather than
    // on any detector. Same `?? shipped` rule.
    stallEscalateMs: positive(stored.stallEscalateMs, STALL_ESCALATE_MS),
    // Beside `STALL_DEFAULTS` for the same reason as the row above: a SECOND
    // clock on one signal, not a detector of its own.
    stallLocalJobMs: positive(stored.stallLocalJobMs, STALL_LOCAL_JOB_MS),
  };
  const busy = save.isPending;
  const row = 'flex flex-wrap items-center justify-between gap-2';
  const onOff = (value: boolean, key: string) => (
    <Button
      size="sm"
      data-pref={key}
      aria-pressed={value}
      disabled={busy}
      onClick={() => save.mutate({ [key]: !value })}
    >
      {value ? 'On' : 'Off'}
    </Button>
  );
  const num = (key: string) => (value: number) => save.mutate({ [key]: value });
  // Read through the owner so the client and the server agree about what a
  // stored boolean means — `true` is `ask`, not `auto`. See the helper.
  const resumeMode = resumeAtBootMode(stored.resumeAtBoot);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Automation · the ladder</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <p className="text-2xs text-ink-muted">
          A stopped phase is classified (never started, work in progress, done but unrecorded, verification
          red, declared blocked, a resource wall…) and the autopilot climbs that situation&apos;s ladder — its
          own session first, a fresh briefed session next — until a rung holds or these caps are spent. Then
          it leaves ONE errand and drives everything else.
        </p>

        <SectionHeading as="h3">Caps — rungs and dollars</SectionHeading>
        <NumberField
          pref="ladderPerPhaseRungs"
          id="ladder-per-phase-rungs"
          label="Rungs per phase"
          value={prefs.ladderPerPhaseRungs}
          unit="rungs"
          hint={`How many rungs one phase may climb before its errand is written (shipped: ${LADDER_PREF_DEFAULTS.ladderPerPhaseRungs}).`}
          disabled={busy}
          onSave={num('ladderPerPhaseRungs')}
        />
        <NumberField
          pref="ladderPerPhaseUsd"
          id="ladder-per-phase-usd"
          label="Spend per phase"
          value={prefs.ladderPerPhaseUsd}
          unit="USD"
          step={10}
          hint={`What the ladder may spend on one phase, every rung counted (shipped: $${LADDER_PREF_DEFAULTS.ladderPerPhaseUsd}).`}
          disabled={busy}
          onSave={num('ladderPerPhaseUsd')}
        />
        <NumberField
          pref="ladderPerRunRungs"
          id="ladder-per-run-rungs"
          label="Rungs per run"
          value={prefs.ladderPerRunRungs}
          unit="rungs"
          hint={`Across every phase of one run (shipped: ${LADDER_PREF_DEFAULTS.ladderPerRunRungs}).`}
          disabled={busy}
          onSave={num('ladderPerRunRungs')}
        />
        <NumberField
          pref="ladderPerRunUsd"
          id="ladder-per-run-usd"
          label="Spend per run"
          value={prefs.ladderPerRunUsd}
          unit="USD"
          step={10}
          hint={`Across every phase of one run (shipped: $${LADDER_PREF_DEFAULTS.ladderPerRunUsd}). The one automatic budget raise stays inside this.`}
          disabled={busy}
          onSave={num('ladderPerRunUsd')}
        />
        <NumberField
          pref="ladderPerDayUsd"
          id="ladder-per-day-usd"
          label="Spend per day"
          value={prefs.ladderPerDayUsd}
          unit="USD"
          step={10}
          hint={`What the LADDER may spend across every run this console drives in a day — what the runs themselves cost is not counted (shipped: $${LADDER_PREF_DEFAULTS.ladderPerDayUsd}).`}
          disabled={busy}
          onSave={num('ladderPerDayUsd')}
        />

        <SectionHeading as="h3" className="mt-1">
          Start ceiling
        </SectionHeading>
        <NumberField
          pref="ceilingStartsPerHour"
          id="ladder-ceiling-starts"
          label="Automatic starts per hour"
          value={prefs.ceilingStartsPerHour}
          unit="starts"
          hint={`Every claude this console starts by itself — a boot re-adoption, a wait clock, a converge relaunch, the MCP probe, the reviewer — counted over a sliding hour; the next automatic start past the number is refused and announced once. Your own Start, Retry and Continue are never counted. 0 turns the ceiling off (shipped: ${LADDER_PREF_DEFAULTS.ceilingStartsPerHour}).`}
          disabled={busy}
          onSave={num('ceilingStartsPerHour')}
        />
        <NumberField
          pref="ceilingUsdPerHour"
          id="ladder-ceiling-usd"
          label="Session spend per hour"
          value={prefs.ceilingUsdPerHour}
          unit="USD"
          step={10}
          hint={`What the sessions that ended in the last hour reported costing, across every run; past it the next automatic start is refused until the hour rolls on. 0 turns it off (shipped: $${LADDER_PREF_DEFAULTS.ceilingUsdPerHour}).`}
          disabled={busy}
          onSave={num('ceilingUsdPerHour')}
        />

        <SectionHeading as="h3" className="mt-1">
          Clocks
        </SectionHeading>
        <NumberField
          pref="convergeEveryMs"
          id="ladder-converge-every"
          label="Sweep every"
          value={minutes(prefs.convergeEveryMs)}
          unit="min"
          hint="How often the convergence loop re-reads every open plan even when nothing happened. Boot, a docs change and the minute after a stop always run a pass."
          zero="0 turns the timer off (the other triggers stay)."
          disabled={busy}
          onSave={(v) => save.mutate({ convergeEveryMs: v * 60_000 })}
        />
        <NumberField
          pref="mcpRequireTimeoutMs"
          id="ladder-mcp-require-timeout"
          label="Park on a required MCP server for"
          value={minutes(prefs.mcpRequireTimeoutMs)}
          unit="min"
          hint={`A phase parked by the require policy continues without the server after this long, an errand recorded (shipped: ${minutes(LADDER_PREF_DEFAULTS.mcpRequireTimeoutMs)} min).`}
          zero="0 waits for the server to heal, however long."
          disabled={busy}
          onSave={(v) => save.mutate({ mcpRequireTimeoutMs: v * 60_000 })}
        />
        <NumberField
          pref="budgetAutoRaisePct"
          id="ladder-budget-raise"
          label="Raise a spent run budget once by"
          value={prefs.budgetAutoRaisePct}
          unit="%"
          hint={`The resource ladder's one budget raise, within the per-run cap above (shipped: ${LADDER_PREF_DEFAULTS.budgetAutoRaisePct}%).`}
          zero="0 never raises — a spent budget halts with an errand at once."
          disabled={busy}
          onSave={num('budgetAutoRaisePct')}
        />

        {/* Phase 5 gave the console a way to notice a lane that has stopped
            being work. These are its three thresholds — and they are
            thresholds, not policy: crossing one announces and journals it, and
            what happens next is still a person's press. */}
        <SectionHeading as="h3" className="mt-1">
          When a lane stops being work
        </SectionHeading>
        <NumberField
          pref="stallSilentMs"
          id="stall-silent"
          label="Call a lane silent after"
          value={minutes(stall.stallSilentMs)}
          unit="min"
          hint={`No PRODUCTIVE output for this long — API retries do not count — suppressed while a phase is verifying (shipped: ${minutes(STALL_DEFAULTS.stallSilentMs)} min).`}
          zero="0 never calls a lane silent."
          disabled={busy}
          onSave={(v) => save.mutate({ stallSilentMs: v * 60_000 })}
        />
        <NumberField
          pref="stallRetryBurst"
          id="stall-retry"
          label="Call it retrying after"
          value={stall.stallRetryBurst}
          unit="retries"
          hint={`API retries in a row with no turn and no tool call between them — the session cannot reach the API (shipped: ${STALL_DEFAULTS.stallRetryBurst}). Noticing only: the run's on-limit policy acts on its own, stricter debounce.`}
          zero="0 never calls a lane retrying."
          disabled={busy}
          onSave={num('stallRetryBurst')}
        />
        {/* The one row on this card whose number ACTS. Said plainly in the
            hint, because a threshold that ends a live session is not the same
            promise as the three around it. */}
        <NumberField
          pref="stallExternalWaitMs"
          id="stall-external-wait"
          label="Park a lane waiting on an external clock after"
          value={minutes(stall.stallExternalWaitMs)}
          unit="min"
          hint={`A Bash call that by construction waits on something outside the session — \`gh run watch\`, an \`until … sleep\` poll, a \`--watch\` flag — open this long (shipped: ${minutes(STALL_DEFAULTS.stallExternalWaitMs)} min). Unlike the rows around it this ACTS: the phase parks, its lock is released so other sessions can move, and its own session is resumed when the window elapses. The vocabulary is shared with lint F16 (scripts/verify.env).`}
          zero="0 never parks a lane for waiting."
          disabled={busy}
          onSave={(v) => save.mutate({ stallExternalWaitMs: v * 60_000 })}
        />
        {/* The watchdog's own park, on its own switch (the KNOWN-SINCE off
            switch). The row above says WHEN a lane reads as waiting; this says
            whether the console may take the turn away from it for that. */}
        <div className={row}>
          <span className="min-w-0">
            <span className="text-sm text-ink">Park a waiting lane by itself</span>
            <span className="mt-0.5 block text-2xs text-ink-muted">
              On (shipped): a lane waiting inside its turn — an open poll loop, or a wait the console refused
              — is checkpointed and parked in the console&apos;s own name, on its own allowance, never the
              session&apos;s declared waits. Off: the stall card still stands and the local-job nudge still
              goes, but nothing is parked.
            </span>
          </span>
          {onOff(stored.stallAutomaticPark !== false, 'stallAutomaticPark')}
        </div>
        {/* The same signal, the other clock. Its own row because the two
            numbers answer different questions and an operator who shortens one
            almost never means the other. */}
        <NumberField
          pref="stallLocalJobMs"
          id="stall-local-job"
          label="…and one waiting on its OWN background job after"
          value={minutes(stall.stallLocalJobMs)}
          unit="min"
          hint={`The same open Bash call, when what it waits on is a job this session started itself — a suite, a build, a log it is tailing (shipped: ${minutes(STALL_LOCAL_JOB_MS)} min). Far longer than the row above on purpose: that session is not idle, it has just put the waiting inside the turn, so it gets ONE nudge telling it to background the job and carry on, and the park only after this. A local park carries the loop's own condition as a \`cmd:\` watch ref, so the lane comes back when the job is genuinely done.`}
          zero="0 restores the shipped 45 minutes — this clock has no off."
          disabled={busy}
          onSave={(v) => save.mutate({ stallLocalJobMs: v * 60_000 })}
        />
        <NumberField
          pref="stallSpinTurns"
          id="stall-spin"
          label="Call it spinning after"
          value={stall.stallSpinTurns}
          unit="turns"
          hint={`Consecutive assistant turns with no tool call in any of them — thinking, not doing (shipped: ${STALL_DEFAULTS.stallSpinTurns}).`}
          zero="0 never calls a lane spinning."
          disabled={busy}
          onSave={num('stallSpinTurns')}
        />
        {/* The sixth signal, and the one no silence detector can see: a lane
            looping is producing output the whole time. Noticing only — there
            is no rung for it, because three identical failures is very often a
            session that succeeds on the fourth try. */}
        <NumberField
          pref="stallLoopRun"
          id="stall-loop"
          label="Call it looping after"
          value={stall.stallLoopRun}
          unit="identical failures"
          hint={`Identical failing tool calls in a row — same tool, same command, same words back (shipped: ${STALL_DEFAULTS.stallLoopRun}). Noticing only: an inbox row and \`phase.suspect\`, never a park.`}
          zero="0 never calls a lane looping."
          disabled={busy}
          onSave={num('stallLoopRun')}
        />
        <NumberField
          pref="stallStalemateAttempts"
          id="stall-stalemate"
          label="Call it a stalemate after"
          value={stall.stallStalemateAttempts}
          unit="attempts"
          hint={`Attempts in a row that committed nothing and left a clean tree — re-running has stopped being a remedy (shipped: ${STALL_DEFAULTS.stallStalemateAttempts}).`}
          zero="0 never calls a stalemate."
          disabled={busy}
          onSave={num('stallStalemateAttempts')}
        />
        {/* Not a detector: every row above says what a stall IS, this one says
            how long one may go on before it is said a second time. Once, and
            urgently — the quiet first card is right at minute ten and wrong at
            minute seventy. */}
        <NumberField
          pref="stallEscalateMs"
          id="stall-escalate"
          label="Say it again, urgently, after"
          value={minutes(stall.stallEscalateMs)}
          unit="min"
          hint={`A stall nothing has resolved by then is re-announced ONCE, urgently (shipped: ${minutes(STALL_ESCALATE_MS)} min).`}
          zero="0 never escalates a stall."
          disabled={busy}
          onSave={(v) => save.mutate({ stallEscalateMs: v * 60_000 })}
        />

        <SectionHeading as="h3" className="mt-1">
          What it may do by itself
        </SectionHeading>
        <div className={row}>
          <span className="min-w-0">
            <span className="text-sm text-ink">Unblock attempts</span>
            <span className="mt-0.5 block text-2xs text-ink-muted">
              A handoff marked blocked for a reason no machine category fits gets ONE bounded session
              explicitly allowed to do the unblocking work — then an errand. Off: the errand at once.
            </span>
          </span>
          {onOff(prefs.unblockAttempts, 'unblockAttempts')}
        </div>
        <div className={row}>
          <span className="min-w-0">
            <span className="text-sm text-ink">Take over stale claims</span>
            <span className="mt-0.5 block text-2xs text-ink-muted">
              An expired foreign lock over unfinished work is taken over and the work continued. A LIVE
              session&apos;s claim is never touched, whatever this says.
            </span>
          </span>
          {onOff(prefs.staleClaimTakeover, 'staleClaimTakeover')}
        </div>
        <div className={row}>
          <span className="min-w-0">
            <span className="text-sm text-ink">Resume killed lanes at boot</span>
            <span className="mt-0.5 block text-2xs text-ink-muted">
              A lane a console restart killed can resume its own session when the console is back — at most 3
              restarts in a row per phase, then an errand. <b>Ask</b> puts the question on screen the next
              time you open the app and starts nothing until you answer; <b>Always</b> is the old behaviour
              and resumes without asking; <b>Never</b> writes an errand and waits.
            </span>
          </span>
          {/* Not `onOff`: that helper writes a BOOLEAN and this setting's three
              values are words the owner list holds. Cycling in one control
              keeps the row the same shape as its neighbours — a three-way
              switch here would be the only one on the page. */}
          <Button
            size="sm"
            data-pref="resumeAtBoot"
            disabled={busy}
            aria-pressed={resumeMode !== 'off'}
            onClick={() =>
              save.mutate({
                resumeAtBoot: resumeMode === 'ask' ? 'auto' : resumeMode === 'auto' ? 'off' : 'ask',
              })
            }
          >
            {resumeMode === 'ask' ? 'Ask' : resumeMode === 'auto' ? 'Always' : 'Never'}
          </Button>
        </div>
        <div className={row}>
          <span className="min-w-0">
            <span className="text-sm text-ink">Switch accounts at a wall</span>
            <span className="mt-0.5 block text-2xs text-ink-muted">
              A signed-out run account, or a usage window too far out to sleep on, switches to a registered
              account that can pay — the session&apos;s transcript comes along. Off: the wall halts with an
              errand.
            </span>
          </span>
          {onOff(prefs.autoAccountSwitch, 'autoAccountSwitch')}
        </div>
        <div className={row}>
          <span className="min-w-0">
            <span className="text-sm text-ink">Let a session clear a human gate</span>
            <span className="mt-0.5 block text-2xs text-ink-muted">
              <strong>On since 5.0.0</strong> — this console&apos;s word for the manifest&apos;s{' '}
              <code>gates</code> row (<code>gates: delegated</code>); a plan&apos;s own{' '}
              <code>## Decisions</code> row outranks it. What makes delegation safe is not trust: the brief
              demands cited evidence for every condition and STOPS with the condition named when it has none,
              and a gate whose conditions are not written stays a person&apos;s whatever this says.{' '}
              <code>gate-status.md</code> records those approvals as <code>by: ai-session-delegated</code>.
            </span>
          </span>
          {onOff(prefs.delegateHumanGates, 'delegateHumanGates')}
        </div>
        <div className={row}>
          <span className="min-w-0">
            <span className="text-sm text-ink">Board a phase that states no verification</span>
            <span className="mt-0.5 block text-2xs text-ink-muted">
              <strong>Off, and deliberately.</strong> A phase whose plan omits the §Verification bullet parks
              at boarding — &ldquo;add a command, then Retry&rdquo; — because nothing would prove the work.
              On: it boards and passes on its handoff alone, and the record says{' '}
              <code>phase.verify-waived</code> so nobody reads &ldquo;0 commands green&rdquo; as proof. A
              bullet the runner cannot read still parks.
            </span>
          </span>
          {onOff(prefs.allowUnverifiedPhases, 'allowUnverifiedPhases')}
        </div>
        <div className={row}>
          <span className="min-w-0">
            <span className="text-sm text-ink">One more rung while the work is moving</span>
            <span className="mt-0.5 block text-2xs text-ink-muted">
              When a phase spends its rungs but the newest one landed commits, the ladder is granted ONE extra
              rung for that phase (<code>phase.ladder-extended</code>). The dollar caps stand. Off: the count
              is the count.
            </span>
          </span>
          {onOff(prefs.ladderExtendOnProgress, 'ladderExtendOnProgress')}
        </div>

        <p className="text-2xs text-ink-muted">
          Every automatic act is journalled on the run (<code>phase.situation</code>, <code>phase.rung</code>,{' '}
          <code>phase.errand</code>, <code>run.converge</code>) and yields to your Stop. QA is never
          dispatched by itself — that stays a press. The session-presence hook beside this card is what lets
          the loop see the sessions it shares the repository with.
        </p>
      </CardBody>
    </Card>
  );
}
