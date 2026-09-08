# Journal events

Every event kind this console can write, what emits it, and what it means.

**Why the file exists.** Every event kind the console emits is a row in the table below — a
couple of hundred, and `viewer/test/debug-index.test.ts` pins the table against the code, so the
number is never written here to go stale; before this the five doc surfaces between them named 27. A journal is only evidence if a reader can tell
what a line means, and "grep the server for the string" is not a document — it
is the absence of one.

**Two sinks, and the difference matters.**

| sink | goes to | who reads it |
|---|---|---|
| `journal` | the RUN's journal (`runs/<instance>/<slug>/run-<runId>.jsonl`) | the console's timeline, the phase detail, `analysis/timeline.ts`, and you |
| `log` | the console's own log file | an operator debugging the console itself |

A `log` line is about the CONSOLE; a `journal` line is about the WORK. A few
kinds appear in both, and are marked `both`.

**This table is machine-checked in BOTH directions** by
`viewer/test/docs-parity.test.ts`: every `'<phase|run|policy>.<name>'` string
literal under `viewer/server/` must appear here, and every row here must appear
there. Add an event without a row and the suite goes red; delete an event and
leave its row and the suite goes red the other way. That is the only thing that
keeps a list this size true.

**Payload.** Every entry carries `at`, and a phase-scoped one carries `phase`.
The rest is per-event; the emitting file named below is the authority on it.

| event | sink | emitted by | meaning |
|---|---|---|---|
| `phase.account-switch` | journal | `runner/runner-control.ts` | The lane moved to another Claude account — which one, and whether the transcript was ported with it. |
| `phase.admitted` | journal | `runner/runner-control.ts` | Admission let the phase through: it holds its lock and its scope, after this long queued. |
| `phase.api-retry` | journal | `runner/runner.ts` | The CLI's own retry watchdog fired. Not work, and deliberately not productive output. |
| `phase.asked` | journal | `runner/runner-control.ts` | A question was written into the session's stdin and an answer is expected back. |
| `phase.auto-nudge-refused` | journal | `runner/runner.ts` | The watchdog meant to nudge and the write did not reach the child — recorded instead of the nudge, because a line claiming a nudge that never happened is the record lying. |
| `phase.auto-nudged` | journal | `runner/runner.ts` | Rung 1 of a stall ladder: one line written into the open stdin. `scope: 'local'` marks the local-job ladder rather than the silent one. |
| `phase.auto-recycled` | journal | `runner/runner.ts` | Rung 2 of the silent ladder: the child was ended and the phase re-boarded on its own session id. |
| `phase.awaiting-verification` | journal | `analysis/timeline.ts`, `runner/runner.ts` | §Verification started. Every stall signal is suppressed until `phase.verify` closes it — a build is silent and fine. |
| `phase.brief` | journal | `runner/runner-loop.ts` | Which boarding brief this attempt was given (fresh · resume · unblock), and what asked for it. |
| `phase.brief-degraded` | journal | `runner/runner.ts` | The brief that was wanted could not be composed, and what was used instead. |
| `phase.checkpointed` | journal | `runner/runner-control.ts` | The lane's state was written to disk and its child ended — the primitive under recycle, account switch and park. |
| `phase.closeout` | journal | `runner/runner-attempt.ts` | A closeout session was boarded to finish a phase whose own session stopped without one. |
| `phase.closeout-done` | journal | `runner/runner-attempt.ts` | That closeout ended — whether it worked, what it cost, and its last words. |
| `phase.closeout-frozen` | journal | `runner/runner-attempt.ts` | The closeout did not run because the console (or the fleet) was frozen. |
| `phase.declaration-consumed` | journal | `runner/state.ts` | `record.declared` was deleted, and under which of the four licences. The ONE writer, so a declaration cannot evaporate unexplained. |
| `phase.disposition` | journal | `runner/runner-attempt.ts` | How an attempt was judged (`runner/outcome.ts`) and what that judgement will do next. |
| `phase.done` | journal | `analysis/timeline.ts`, `runner/runner-attempt.ts` | The board reads this phase done. Terminal. |
| `phase.errand` | journal | `converge.ts`, `runner/runner-attempt.ts`, `runner/runner-control.ts`, `runner/runner.ts`, `service-recovery.ts`, `service.ts` | Something a person must settle, raised against this phase. The errand's actions carry the door. |
| `phase.errand-cleared` | journal | `service-recovery.ts` | A standing errand stopped being true and was retracted. |
| `phase.external-wait` | journal | `runner/runner.ts` | The lane is parked because a Bash call was waiting on a clock — `scope` says whose, and `watch` any `cmd:` ref lifted out of a local poll loop. |
| `phase.failed` | journal | `analysis/timeline.ts`, `runner/runner-attempt.ts` | The attempt ended red and the ladder now owns it. |
| `phase.gate-ai` | journal | `runner/runner-loop.ts` | The phase's gate is one an AI session may clear, and the session was told to clear it first. |
| `phase.gate-delegated` | journal | `runner/runner-loop.ts` | A HUMAN gate whose verification the operator delegated to the session (Settings ▸ Automation). |
| `phase.gated` | journal | `analysis/timeline.ts`, `runner/runner-loop.ts` | The phase is held by a gate nobody has cleared. Terminal for this boarding. |
| `phase.git-strategy` | journal | `runner/runner-loop.ts` | Which checkout the session was given — branch, worktree, PR intent — and which checkout bullet it was told (`lane` · `mirror` · `run` · `detached` · `shared`). |
| `phase.halted` | journal | `runner/runner.ts` | The phase settled with a halt: the reason and, since P1, its KIND (phase-level halts write `record.halt`, run-level ones `state.halt`). |
| `phase.human-verified` | journal | `runner/runner.ts` | A person answered the verification card themselves — their decision, and who they were. |
| `phase.ladder-deferred` | journal | `runner/runner.ts` | A rung was available and deliberately not climbed, naming what is left. |
| `phase.ladder-extended` | journal | `service-recovery.ts` | The phase's rung count was spent but the newest settled rung landed commits, so ONE more rung was granted (`ladderExtendOnProgress`, off by default; once per phase; the dollar caps stand). |
| `phase.ladder-skipped` | journal | `runner/runner.ts` | No rung was climbed because auto-recovery is off for this run. |
| `phase.live-wall` | journal | `analysis/timeline.ts`, `runner/runner.ts` | A usage wall detected on the STREAM, while the child is still running, rather than from a corpse. |
| `phase.liveness` | journal | `runner/runner.ts` | A stall episode CLEARED — the card comes down, with the signals that now read healthy. |
| `phase.lock-cap-rearmed` | journal | `converge.ts`, `runner/runner.ts` | The lock a capped waiter was queued behind is gone, so its two-hour wait starts over. |
| `phase.lock-debris-released` | journal | `runner/runner-loop.ts` | A lock whose holder is provably gone was released at boarding. |
| `phase.lock-lost` | journal | `runner/runner.ts` | The lease keepalive failed and this lane can no longer prove it holds its claim. |
| `phase.lock-race` | journal | `runner/runner-loop.ts` | Two boardings wanted one scope and this one lost; it backs off and queues. |
| `phase.lock-refreshed` | journal | `runner/runner.ts` | The lease keepalive renewed the claim. |
| `phase.lock-refused` | journal | `runner/runner-loop.ts` | `phase-lock.sh claim` said no, and who holds it. |
| `phase.lock-wait-capped` | journal | `runner/runner-control.ts`, `runner/runner-loop.ts` | A waiter hit the two-hour cap and parked rather than queueing for ever — for the ONE shape `isCappableBlocker` allows. |
| `phase.mcp` | journal | `runner/runner-attempt.ts` | The MCP servers this phase was attached to. |
| `phase.mcp-config-failed` | journal | `runner/runner-attempt.ts` | The MCP config for this phase could not be written; the session runs without those servers. |
| `phase.mcp-degraded` | journal | `runner/runner-loop.ts` | Some named servers would not connect, so the phase boards without them and owes an errand. |
| `phase.mcp-preflight-parked` | journal | `analysis/timeline.ts`, `runner/runner-loop.ts` | `MCP policy: require` and a server would not connect, so the phase parked instead of boarding. |
| `phase.mcp-preflight-skipped` | journal | `runner/runner-attempt.ts` | The MCP probe itself could not run, so nothing was concluded from it. |
| `phase.mcp-require-timeout` | journal | `runner/runner-control.ts`, `service.ts` | A `require` phase waited out its window for a server nobody signed in. |
| `phase.mcp-unmanaged` | journal | `runner/runner-attempt.ts` | The named servers are not in this console's registry, so it attached nothing and said so. |
| `phase.model-differs` | journal | `runner/runner.ts` | The model the CLI reports is not the model the phase asked for. |
| `phase.model-escalated` | journal | `runner/runner-loop.ts` | The ladder moved this phase to a stronger model for the next attempt. |
| `phase.model-switch` | journal | `runner/runner-attempt.ts` | The attempt's disposition moved the model mid-phase. |
| `phase.model-window-retry` | journal | `runner/runner-attempt.ts` | A model-specific usage window closed and the attempt was retried on another. |
| `phase.model-window-wait` | journal | `analysis/timeline.ts`, `runner/runner-attempt.ts` | Every model is inside its own usage window, so the phase waits for the earliest to open. |
| `phase.needs-human` | journal | `runner/runner-attempt.ts` | The phase parked on something only a person can settle. |
| `phase.not-started` | journal | `analysis/timeline.ts`, `runner/runner-loop.ts` | The boarding stopped before the session began — a gate, a lock, a preflight. |
| `phase.outcome` | journal | `runner/runner-control.ts`, `runner/runner.ts`, `service-runs.ts` | A `phase-outcome.sh` declaration was read: what it said, and any clock it named. |
| `phase.outcome-ignored` | journal | `runner/runner-control.ts` | A declaration was read and deliberately not acted on, with the reason. |
| `phase.outcome-lock-blocked` | journal | `runner/runner-attempt.ts` | The session declared `blocked` on a lock, with the `lock:` ref that will free it. |
| `phase.outcome-needs-human` | journal | `runner/runner-attempt.ts` | The session declared `needs-human`; the phase parks and the errand stands. |
| `phase.outcome-no-defect` | journal | `runner/runner-attempt.ts` | A repair session found nothing wrong. Deliberately NOT `fixed` — and it does not retire the halt. |
| `phase.outcome-partial` | journal | `runner/runner-attempt.ts` | The session declared `partial`: work remains, resume it rather than re-run it. |
| `phase.outcome-superseded` | journal | `runner/runner-attempt.ts` | A declaration arrived about a phase the board already reads done. |
| `phase.pr-session` | journal | `runner/runner-loop.ts` | A session was boarded to open the run's pull request. |
| `phase.pr-session-done` | journal | `runner/runner-loop.ts` | That PR session ended — cost, turns, and what it said. |
| `phase.pr-session-failed` | journal | `runner/runner-loop.ts` | The PR session threw before it could open anything. |
| `phase.qa-exhausted` | journal | `runner/qa-recover.ts` | The QA round budget is spent: every round this run allows on a phase failed. Carries the rounds, the dollars and the LAST report, which is the one the errand names. |
| `phase.qa-mode` | journal | `service.ts` | The plan's QA regime was switched from the console while this run was live — the directive written (`on`, `off`, or `inherit` for one phase) and the regime the engine reads back for the plan and the phase, so a verdict that starts or stops holding dependents mid-run has its reason on the record. |
| `phase.qa-recover` | journal | `runner/qa-recover.ts` | A QA recovery started on this phase — the verb (`qa-recover` or `qa-rerun`), the verdict it is answering, the fix strategy, the round budget and who asked. |
| `phase.qa-recovered` | journal | `runner/qa-recover.ts` | A QA recovery ended with the gate OPEN — the verdict that released it, how many rounds failed first, and what the loop spent. |
| `phase.qa-round` | journal | `runner/qa-recover.ts` | One round of a QA recovery ended: which round, the verdict it recorded, its report, what it cost, and whether the fix session resumed or boarded fresh. |
| `phase.qa-session` | journal | `runner/runner-attempt.ts` | A fresh-context QA subagent session was boarded over this phase's diff — with the round it produces, the report it was told to write, and the brief it was sent. |
| `phase.qa-session-done` | journal | `runner/runner-attempt.ts` | The QA session ended, with the verdict it recorded (or `pending` if it recorded none), the round and report it landed, and how many rounds this phase has now had. |
| `phase.qa-session-skipped` | journal | `runner/runner-attempt.ts` | No QA session was boarded, and why. |
| `phase.qa-waived` | journal | `runner/qa-recover.ts` | An operator waived this phase's verdict, with the reason they gave and the round it answers. The gate stops holding dependents from the next board read. |
| `phase.queued` | journal | `runner/runner-control.ts` | The phase is waiting for a scope somebody else holds, naming the head of the queue. |
| `phase.reboard-requested` | journal | `runner/runner-control.ts`, `service-runs.ts` | Something asked for this phase to be boarded again, naming the situation and the rung. |
| `phase.reconciled` | journal | `runner/runner-base.ts`, `runner/runner.ts` | A record was corrected against the board — the board wins over a stale checkpoint. |
| `phase.recovery-cancelled` | journal | `runner/runner-control.ts` | A recovery in flight was cancelled. |
| `phase.repair` | journal | `runner/runner-control.ts` | A repair session (`claude -p` under the run) was boarded for a rung of the ladder. |
| `phase.repair-done` | journal | `runner/runner-control.ts` | That repair session ended, and whether it fixed anything. |
| `phase.repair-script` | journal | `service-recovery.ts` | The deterministic `repair-artefacts.sh` rung ran — the free first rung, no session. |
| `phase.repair-skipped` | journal | `runner/runner-control.ts` | A repair was not boarded, and why (usually a freeze). |
| `phase.repair-stopped` | journal | `runner/runner-control.ts` | A repair session was stopped before it settled. |
| `phase.resume` | journal | `analysis/timeline.ts`, `runner/runner-attempt.ts` | The phase's own session was resumed with `--resume`. |
| `phase.resume-at-boot` | journal | `converge.ts` | The convergence loop resumed this phase when the console started. |
| `phase.resume-checkpoint` | journal | `runner/runner-attempt.ts` | Which checkpointed transcript the resume attached to. |
| `phase.resume-done` | journal | `runner/runner-control.ts` | A resume ended — cost, turns, last words. |
| `phase.resume-instruction` | journal | `runner/runner-control.ts` | The instruction a resume was given, verbatim (capped). |
| `phase.resume-lost` | journal | `runner/runner-control.ts` | A `--resume` that cannot reach its conversation: the CLI answered `No conversation found`, or the transcript could not be carried to the account paying. The session is marked gone on the record and the rung that tried it settles `failed` — never `interrupted`, which would offer the same resume again. |
| `phase.retry-context` | journal | `runner/runner-loop.ts` | How much failure context was prepended to the next attempt's prompt. |
| `phase.retry-override` | journal | `runner/runner-loop.ts` | A retry carried an operator's addendum or option overrides. |
| `phase.retry-requested` | journal | `runner/runner-control.ts` | Something asked for a retry, with whatever it wants changed. |
| `phase.retry-storm-parked` | journal | `runner/runner.ts` | Rung 2 of the retry-storm ladder: parked on the wall, with `limits.status = 'limited'` so the classifier answers `resource-wall:usage`. |
| `phase.retry-storm-recycled` | journal | `runner/runner.ts` | Rung 1 of the retry-storm ladder, on its OWN counter — a rung spent for silence is not a rung spent for a storm. |
| `phase.review-follow-up` | journal | `runner/runner-control.ts` | A reviewer's requested changes were written into the phase as a follow-up. |
| `phase.review-held` | journal | `runner/runner-loop.ts` | The phase is held by a reviewer's `requested-changes`, exactly as a person's would hold it. |
| `phase.review-session` | journal | `runner/runner-loop.ts` | A reviewer session was boarded over this phase's diff (`reviewEachPhase`). |
| `phase.review-session-done` | journal | `runner/runner-loop.ts` | The reviewer ended, with its verdict. |
| `phase.review-session-failed` | journal | `runner/runner-loop.ts` | The reviewer session threw. |
| `phase.review-session-skipped` | journal | `runner/runner-loop.ts` | No reviewer ran, and why. |
| `phase.ruling` | journal | `runner/runner-base.ts`, `service-runs.ts` | A judgement the session recorded with `phase-outcome.sh … ruling` — what it decided and why. Never an outcome; nothing acts on it. |
| `phase.rung` | journal | `analysis/timeline.ts`, `runner/runner.ts`, `service-recovery.ts` | A ladder rung was climbed: the situation it was chosen for, the rung, and the vehicle that drove it. |
| `phase.rung-settled` | journal | `service-recovery.ts` | That rung's outcome, read from the session's own declaration. |
| `phase.rung-unavailable` | journal | `analysis/timeline.ts`, `service-recovery.ts` | A rung the ladder chose that THIS console cannot drive, and what it fell back to. |
| `phase.session` | journal | `analysis/timeline.ts`, `runner/runner-attempt.ts`, `runner/runner-control.ts` | A session started or ended on this lane — its id, cost and turns. |
| `phase.shared-checkout` | journal | `runner/runner-loop.ts` | The phase is working in a checkout something else also holds, naming the overlapping holders. |
| `phase.situation` | journal | `runner/runner.ts`, `service-recovery.ts` | The classifier's answer for this phase: which situation, which sub-kind, and why. |
| `phase.skills` | journal | `runner/runner-loop.ts` | The skills injected into this phase's boot prompt. |
| `phase.skip` | journal | `analysis/timeline.ts`, `runner/runner-control.ts` | The phase was skipped rather than run. Terminal for this boarding. |
| `phase.stall` | journal | `runner/runner.ts` | A stall episode OPENED — one line per episode, never per tick. |
| `phase.stall-parked` | journal | `runner/runner.ts` | The silent ladder is exhausted and the phase parked on an errand. |
| `phase.start` | journal | `analysis/timeline.ts`, `runner/runner-loop.ts` | A boarding began: this phase now has a session, a lock and an attempt number. |
| `phase.steered` | journal | `runner/runner-control.ts` | An instruction was written into the session's stdin — a steer, which outranks the plan for the rest of the phase. |
| `phase.stop-requested` | journal | `runner/runner-control.ts` | Somebody asked this lane to stop, and who. |
| `phase.stopped` | journal | `analysis/timeline.ts`, `runner/runner-control.ts` | The lane stopped. Terminal for this boarding. |
| `phase.tasks` | journal | `runner/runner.ts` | The session's `phase-tasks.sh` list moved — totals and the active item. |
| `phase.tool-auto-granted` | journal | `service.ts` | A card the console answered itself under a standing auto-grant setting, and at which level it was decided. |
| `phase.tool-denied` | journal | `service.ts` | A tool call this console refused. `rule` names the line — a `policy.deny` rule, or `in-turn-wait` for the guard that refuses waiting inside a turn. |
| `phase.tools` | journal | `runner/runner.ts` | Which tools the session was given at boot. |
| `phase.transcript-port` | journal | `runner/runner-attempt.ts`, `runner/runner-control.ts` | A transcript was copied between accounts' config directories so a resume could find it. |
| `phase.verify` | journal | `analysis/timeline.ts`, `runner/runner-attempt.ts` | §Verification finished. Closes the bar `phase.awaiting-verification` opened. |
| `phase.verify-command` | journal | `service-runs.ts` | One verification command run from the console's terminal, with its exit code. |
| `phase.verify-in-missing` | journal | `runner/runner-attempt.ts` | The phase's `**Verify in:**` resolves outside the repository root, so the root was used instead. |
| `phase.verify-overtaken` | journal | `runner/runner-attempt.ts` | §Verification was red and the BOARD says the phase is done — the board overtook it. |
| `phase.verify-preflight` | journal | `runner/runner-attempt.ts` | The boarding preflight's warnings about the §Verification it is about to trust. |
| `phase.verify-preflight-parked` | journal | `analysis/timeline.ts`, `runner/runner-loop.ts` | The preflight refused to board on a §Verification it could not run. |
| `phase.verify-stopped` | journal | `runner/runner-attempt.ts` | The run was stopped mid-verification; what ran, and what never did. |
| `phase.verify-unanswered` | journal | `runner/runner.ts` | A verification fragment needed a person and nobody answered. |
| `phase.verify-unrunnable` | journal | `runner/runner-attempt.ts` | Every verification command's lead is missing from the PATH here — a fact about the MACHINE, never a verdict about the work. |
| `phase.verify-waived` | journal | `runner/runner-attempt.ts` | The plan states no §Verification and `allowUnverifiedPhases` is on: the phase boarded (`stage: preflight`) and passed on its handoff alone (`stage: verify`), instead of parking. |
| `phase.wait-budget-spent` | journal | `service-runs.ts` | This phase has spent its allowance of waits; the next one will not be granted. |
| `phase.wait-resume` | journal | `analysis/timeline.ts`, `runner/runner-loop.ts` | A parked phase's window elapsed (or its watch landed) and it is coming back. |
| `phase.waiting` | journal | `analysis/timeline.ts`, `runner/runner-attempt.ts`, `service-runs.ts` | The phase parked with a clock — declared or automatic — naming the window and any watch refs. |
| `phase.watch-checked` | journal | `watch-scheduler.ts` | A watch ref was probed and its state changed. Written on TRANSITION only. |
| `phase.watch-landed` | journal | `service-recovery.ts` | A watch ref landed. Written once, on the declaration it answers. |
| `phase.watch-refused` | journal | `watch-scheduler.ts` | The policy judged a `cmd:` ref and will judge it identically for ever, so it is journalled once and dropped from the rotation. Terminal for that ref. |
| `phase.worktree` | journal | `runner/runner-loop.ts` | A lane worktree was created for this phase, and on which branch. |
| `phase.worktree-adopted` | journal | `runner/runner-control.ts` | An existing lane worktree was picked up rather than created. |
| `phase.worktree-failed` | journal | `runner/runner-loop.ts` | The lane worktree could not be created; the phase degrades to the shared checkout. |
| `phase.worktree-landed` | journal | `runner/runner-loop.ts` | The lane branch was merged back into the run branch. |
| `phase.worktree-resynced` | journal | `runner/runner-loop.ts` | The lane worktree was brought up to date with the run branch. |
| `policy.edited` | journal | `service-live.ts` | The approval policy was edited through the console, with what was added and removed. |
| `policy.updated` | log | `runner/approvals.ts` | The policy file on disk was rewritten — the counts, and by whom. |
| `run.account-env-failed` | journal | `runner/runner-control.ts` | Building the environment for an account threw; the run continues on the default. |
| `run.account-env-missing` | journal | `runner/runner-control.ts` | An account's stored environment is not on this machine. |
| `run.account-switch` | journal | `runner/runner-control.ts` | The run was asked to move to another account. |
| `run.account-switched` | journal | `runner/runner-control.ts` | It did — at preflight, for an auth reason. |
| `run.adopt.alive` | journal | `runner/runner-control.ts` | On boot the console found its own children still running and adopted them. |
| `run.adopt.interrupted` | journal | `runner/runner-control.ts` | A child from a previous console is gone; its phase is marked interrupted. |
| `run.agent-artefacts` | journal | `runner/runner-control.ts` | What a session left behind — repos touched, branches, worktrees. Registered, never deleted. |
| `run.anchor-classify-failed` | log | `service-recovery.ts` | The classifier threw while choosing the phase an action should anchor to. |
| `run.auto-recovery` | both | `service-recovery.ts` | The convergence loop chose a rung for a stopped run. |
| `run.auto-recovery-failed` | log | `service-recovery.ts` | That attempt threw; the rung is settled `failed`. |
| `run.branch-mismatch` | journal | `runner/runner-loop.ts` | The plan names one branch and the run stands on another. |
| `run.budget-raised` | journal | `runner/runner-control.ts` | The run's USD budget was raised, by how much, and against what cap. |
| `run.console-shutdown` | journal | `runner/runner.ts` | The console is going down and is ending its children. |
| `run.converge` | journal | `converge.ts` | The convergence loop acted on this run — which action, and what triggered the sweep. |
| `run.converge-failed` | journal | `converge.ts` | That convergence action threw; the run is left as it was. |
| `run.errand` | journal | `converge.ts`, `runner/runner-control.ts` | Something a person must settle, raised against the run rather than one phase. |
| `run.resume-asked` | journal | `converge.ts` | A console restart stopped this run and `resumeAtBoot` is `ask`, so nothing was relaunched and the operator is asked on the next app load. |
| `run.failure-streak-reset` | journal | `runner/runner-control.ts` | The consecutive-failure counter was cleared. |
| `run.finished` | journal | `analysis/timeline.ts`, `runner/runner-loop.ts` | The run ended. Its timeline axis stops here. |
| `run.freeze-escalate-frozen` | log | `service.ts` | An escalation was due and the console itself is frozen, so nothing was escalated. |
| `run.freeze-escalated` | both | `runner/runner-control.ts`, `service.ts` | A frozen lane's escalation clock ran out and the freeze was escalated. |
| `run.freeze-standing` | journal | `runner/runner-control.ts` | A lane's escalation clock is held because the console was frozen under it. |
| `run.frozen` | journal | `analysis/timeline.ts`, `runner/runner-control.ts` | The run was frozen (SIGSTOP). Silence after this is the feature, not a fault. |
| `run.frozen-idle` | journal | `runner/runner-loop.ts` | The drive loop found the run frozen with nothing to do and stood down. |
| `run.git-radar` | journal | `runner/runner.ts` | A branch/worktree pair changed state under the run. |
| `run.branches-pruned` | journal | `runner/runner-loop.ts` | Merged `pe/*` branches were deleted (`-d` only) once the trunk contained them. |
| `run.halt` | journal | `runner/runner.ts` | The run stopped. `kind` is a RUN-level halt kind; a kindless halt stays run-level. |
| `run.halt-classify-failed` | log | `service-runs.ts` | The classifier threw while reading a halt. |
| `run.halt-retracted` | log | `service-live.ts` | A halt stopped being true and was withdrawn. |
| `run.halt-superseded` | journal | `runner/runner-loop.ts` | The board overtook the halt while the lanes were still draining. |
| `run.held` | journal | `runner/runner-control.ts` | The run's queue is holding: admitted nothing new, by whose hand. |
| `run.isolation` | journal | `runner/runner-loop.ts` | A worktree lane was REFUSED, with the refusal class; the run degrades to a shared checkout. |
| `run.isolation-kept` | journal | `runner/runner-loop.ts` | A refusal was overridden and the worktree kept. |
| `run.isolation-detached` | journal | `runner/runner-loop.ts` | The run's checkout owns no branch: detached at the default branch's head, with the sha it stands at. |
| `run.isolation-reclaim-failed` | log | `runner/runner-loop.ts` | The reclaim threw. Never fails the run — the build simply refuses `branch-in-use`. |
| `run.isolation-reclaimed` | journal | `runner/runner-loop.ts` | A CLEAN checkout sitting on the run branch was switched to the default branch, so the run can take it. |
| `run.limit-paused` | journal | `analysis/timeline.ts`, `runner/runner-control.ts`, `runner/runner.ts` | A usage wall paused the run, from the stream or from a corpse. |
| `run.limit-resume` | log | `service-base.ts` | The wall's window elapsed and the run is being resumed. |
| `run.limit-resume-failed` | log | `service-base.ts` | That resume threw; the run stays paused on the wall. |
| `run.limit-resume-frozen` | log | `service-base.ts` | The resume was due and the console is frozen, so it did not happen. |
| `run.lock-debris-released` | journal | `converge.ts` | The convergence loop released a lock whose holder is provably gone. |
| `run.mcp-continue` | journal | `service-runs.ts` | Phases parked on `MCP policy: require` were released to continue. |
| `run.parked` | journal | `runner/runner-control.ts`, `runner/runner-loop.ts` | The run parked — waiting on something rather than stopped by something. |
| `run.pause-cancelled` | journal | `runner/runner-control.ts` | A requested pause was taken back. |
| `run.pause-requested` | journal | `runner/runner-control.ts` | A pause was requested, after which phase. |
| `run.paused` | journal | `runner/runner-loop.ts` | The run actually paused, after the phase the request named. |
| `run.permission-profile` | journal | `runner/runner-control.ts` | The run's permission profile was changed mid-run, and by whom. |
| `run.plan-recover` | journal | `service-runs.ts` | A deterministic plan-repair step ran over the run's artefacts. |
| `run.pr-pending` | journal | `runner/runner-loop.ts` | Every phase is done and the work branch still owes a pull request. |
| `run.pr-session-skipped` | journal | `runner/runner-loop.ts` | The PR session did not run — usually a freeze. |
| `run.preflight-refused` | journal | `runner/runner-control.ts` | The run's own preflight refused to start it, and what was tried. |
| `run.push-carve-out` | journal | `runner/runner-control.ts` | The new-branch push carve-out was switched, and by whom. |
| `run.readopt-failed` | log | `service-base.ts` | Re-adopting a previous console's runs threw. |
| `run.readopt-frozen` | log | `service-base.ts` | Re-adoption was skipped because the fleet is frozen. |
| `run.readopt-queued` | log | `service-base.ts` | A queued run from a previous console was picked up. |
| `run.rearmed-freeze` | log | `service.ts` | A freeze escalation clock was re-armed after a restart. |
| `run.rearmed-wait` | log | `service-base.ts` | A park's clock was re-armed after a restart. |
| `run.reconfigured` | journal | `runner/runner-control.ts` | The run's settings were patched mid-flight. |
| `run.records-swept` | log | `service-base.ts` | Old run records nothing will read again were dropped. |
| `run.recover` | journal | `runner/runner-control.ts` | A recovery was started — its mode, its phase, and who asked. |
| `run.recover.refused` | journal | `runner/runner-control.ts` | A recovery was refused, with the orphan condition that refused it. |
| `run.recovered` | journal | `runner/runner-control.ts` | The recovery finished and the run may be driven again. |
| `run.recovery-continue` | log | `service-base.ts`, `service-recovery.ts` | A recovery's result let the run continue, and it was restarted. |
| `run.recovery-continue-failed` | log | `service-base.ts` | That restart threw; the run stays where the recovery left it. |
| `run.recovery-continue-frozen` | log | `service-base.ts`, `service-recovery.ts` | The restart was due and the console is frozen. |
| `run.released` | journal | `runner/runner-control.ts` | A held queue was released and admission resumes. |
| `run.resolved` | log | `service-runs.ts` | The run was marked resolved — nothing more is owed on it. |
| `run.rung-still-driving` | log | `service-recovery.ts` | A rung was asked about and its vehicle is still running. |
| `run.secrets-pruned` | log | `runner/runner-control.ts` | Per-run secret files for a finished run were removed. |
| `run.secrets-swept` | log | `service-base.ts` | Secret files no live run claims were removed. |
| `run.settings` | journal | `runner/runner-control.ts` | The run's `--settings` file was written, with the profile it encodes. |
| `run.settings.prune-failed` | log | `runner/approvals.ts` | Pruning a settings file threw. |
| `run.settle-pending` | journal | `runner/runner-loop.ts` | The run's branch is queued to merge and the settlement is not finished. |
| `run.settle-unsupported` | journal | `runner/runner-loop.ts` | The settle strategy cannot apply to this run's checkout shape, and why. |
| `run.settled` | journal | `runner/runner-loop.ts` | The run's branch and checkout were settled — or deliberately left as they are. |
| `run.shutdown-child` | journal | `runner/runner.ts` | One child was ended during shutdown, and how. |
| `run.situation-failed` | log | `service-runs.ts` | The classifier threw for one phase. |
| `run.stall-escalated` | log | `service-live.ts` | An unresolved stall was said once more, urgently. |
| `run.stall-retracted` | log | `service-live.ts` | A stall escalation was withdrawn. |
| `run.start` | journal | `runner/runner-control.ts`, `service-runs.ts` | The run started, and its timeline axis begins here. |
| `run.stop-requested` | journal | `runner/runner-control.ts` | A stop was requested for the run, naming the children it will end. |
| `run.stopped-while-idle` | journal | `runner/runner-control.ts` | The run was stopped while it had nothing in flight. |
| `run.thawed` | journal | `analysis/timeline.ts`, `runner/runner-control.ts` | The freeze was lifted and the lanes are running again. |
| `run.ultrareview` | journal | `runner/ultrareview.ts` | A cloud `claude ultrareview` was started over this run's work, and which checkout it reads. |
| `run.ultrareview-done` | journal | `runner/ultrareview.ts` | The cloud review ended: its verdict and finding count, or `ok: false` and the reason it could not answer. |
| `run.ultrareview-skipped` | journal | `runner/runner-loop.ts`, `runner/ultrareview.ts` | No cloud review ran — a freeze, no review surface, or a run that finished no phase to hang one on. |
| `run.usage-window` | journal | `runner/runner.ts` | The account's usage window as the CLI reported it. |
| `run.waiting` | journal | `runner/runner-control.ts` | The run is waiting on a clock, until when and why. |
| `run.waiting-external` | journal | `runner/runner-control.ts`, `runner/runner.ts`, `service-runs.ts` | Every phase that could start is parked on somebody else's clock — composed once, whichever path parked the last one. |
| `run.watch-landed-frozen` | log | `service-recovery.ts` | A watch landed and the fleet is frozen, so the resume did not happen. |
| `run.watch-resume-failed` | log | `service-recovery.ts` | A watch-landed resume threw. |
| `run.watch-resume-settle-failed` | log | `service-recovery.ts` | Settling a watch-landed resume threw. |
| `run.watch-resume-void` | log | `service-recovery.ts` | A watch-landed delivery launched nothing, so the delivery was UN-charged. |
| `run.worktree-discard-failed` | log | `runner/runner-loop.ts` | Discarding a worktree threw. |
| `run.worktree-release-failed` | log | `runner/runner-loop.ts` | Releasing a worktree threw. Never fails the run. |
| `run.worktree-released` | journal | `runner/runner-loop.ts` | The run's worktree was released — what was removed and what was kept. |
| `run.worktree-setup` | journal | `runner/runner-loop.ts` | The worktree's setup command ran, with its output. |
| `run.worktree-setup-discarded` | journal | `runner/runner-loop.ts` | A worktree whose setup failed was discarded. |
| `run.worktree-sweep-failed` | log | `runner/runner-loop.ts`, `service-base.ts` | The worktree sweep threw. |
| `run.worktree-unavailable` | journal | `runner/runner-loop.ts` | A worktree could not be had at all, with the refusal. |
| `run.worktrees-pruned` | both | `runner/runner-loop.ts`, `service-base.ts` | Stale worktrees were pruned — including registrations whose directory is gone (`unmanaged`). |
| `run.worktrees-unmanaged` | both | `runner/runner-loop.ts`, `service-base.ts` | A working tree this console did not make is holding a `pe/*` branch. Reported, never removed. |
| `run.worktrees-swept` | both | `runner/runner-loop.ts`, `service-base.ts` | The worktree sweep ran across the console's runs. |
