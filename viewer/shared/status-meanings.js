/**
 * What every status word MEANS, and what comes next — one plain sentence each
 * (one-pool phase 14, #365).
 *
 * A status used to explain nothing on hover: the tooltip repeated the label,
 * so "Parked" said "Parked". Every row of `WORD_ROWS` (`shared/status-model.js`)
 * now carries two sentences from this table, `meaning` (what the word means in
 * THIS vocabulary — "Active" is a plan being pursued, and a licence that
 * checks out) and `next` (what a person should do, or, when nothing is to be
 * done, what happens next on its own). The model copies them onto each row at
 * load, so every view `describeWord`, `describeRun` and `describePhase` build
 * carries them, and the status family's tooltip (`ui/status/dot-word.tsx`)
 * says them on hover, on keyboard focus and on a tap.
 *
 * Keyed by the model's vocabularies and their words; `test/status-model.test.ts`
 * fails a row with no sentence and a sentence with no row. The note
 * severities carry theirs in `shared/status-notes.js`, which first paint
 * loads. Plain words only: no command, no route, no id.
 *
 * Dependency-free ESM, like the model.
 *
 * @typedef {{ meaning: string, next: string }} StatusWords
 */

/** @param {string} meaning @param {string} next @returns {StatusWords} */
const say = (meaning, next) => Object.freeze({ meaning, next });

/** @type {Readonly<Record<string, Readonly<Record<string, StatusWords>>>>} */
export const STATUS_MEANINGS = Object.freeze({
  run: Object.freeze({
    running: say(
      'The autopilot is driving this plan: sessions start, verify and hand off by themselves.',
      'Nothing to do: watch its lanes, or pause or stop it if you need to.',
    ),
    halting: say(
      'A halt was recorded, and the sessions still running are finishing before the run stops.',
      'Nothing to do yet: once it reads Halted, its halt card says the way forward.',
    ),
    halted: say(
      'The run stopped on something it must not drive past by itself, most often a red verification.',
      'Read the halt card and take its recommended way forward, or fix the cause and retry the phase.',
    ),
    parked: say(
      'The run stopped driving at a point it can name, and nothing new boards; its reason says why.',
      'Read its reason, answer any item it has in Your turn, then press Continue to carry on.',
    ),
    interrupted: say(
      'Nothing is driving the run and nothing recorded why, usually because a console or a session died mid-flight.',
      'Press Continue or recover it; work already on disk is kept.',
    ),
    waiting: say(
      'The run is asleep on a clock: a usage window, an outside wait, the schedule or a person’s answer.',
      'Nothing to do unless it waits on you: it resumes by itself when the clock comes round.',
    ),
    paused: say(
      'The run stopped between phases, and nothing is running.',
      'Press Continue when you are ready: it picks up where it left off.',
    ),
    pausing: say(
      'A pause is armed: the work in flight finishes, and nothing new starts.',
      'Nothing to do: it reads Paused when the work in flight ends, or cancel the pause to keep going.',
    ),
    frozen: say(
      'Its sessions are stopped where they stand, warm and losing nothing.',
      'Continue the frozen session to resume at once, or stop it.',
    ),
    stopping: say(
      'A stop was asked for, and the sessions are being wound down.',
      'Nothing to do: it settles in a moment.',
    ),
    queued: say(
      'The run is in line behind other work holding the same repositories.',
      'Nothing to do: it starts by itself when the repositories free.',
    ),
    finished: say(
      'The run has nothing left to do on this plan.',
      'Nothing to do; a red count beside it names any phase that did not settle well.',
    ),
  }),
  phase: Object.freeze({
    running: say(
      'A session is working on this phase right now.',
      'Nothing to do: watch its lane, or ask the session something while it works.',
    ),
    verifying: say(
      'The session finished, and the console is running the plan’s own verification checks.',
      'Nothing to do: green marks it done, red stops it with the evidence.',
    ),
    'awaiting-verification': say(
      'The machine checks passed, and steps only a person can confirm remain.',
      'Answer its sign-off item: it lists exactly what needs your eyes.',
    ),
    queued: say(
      'The phase waits for repositories another phase or plan is holding.',
      'Nothing to do: it starts by itself when they free.',
    ),
    pending: say(
      'This run has not started the phase yet.',
      'Nothing to do: the run reaches it once its dependencies are done.',
    ),
    waiting: say(
      'The phase is asleep on an outside clock its session declared, such as a build or a deploy window.',
      'Nothing to do: the phase’s own session resumes when the wait ends.',
    ),
    gated: say(
      'The phase is held at a gate the plan reserves, which the run cannot clear by itself.',
      'Do the gate’s steps and approve the gate on the phase page; the run carries on from there.',
    ),
    parked: say(
      'The run set this phase aside, and its note says why: a gate, a claim, a decision or a spent recovery.',
      'Read the note and act on it, then retry the phase. It reads Needs you only while an item for it is open.',
    ),
    interrupted: say(
      'The session or the console died mid-phase, and the working tree is wherever it stopped.',
      'Pick it up with a new session or retry it; uncommitted work is kept.',
    ),
    skipped: say(
      'The phase was taken off this run’s list on purpose. It is neither finished nor failed.',
      'Retry it later if it should still happen.',
    ),
    failed: say(
      'This attempt failed: a red verification, or a session that produced nothing the board accepts.',
      'Open the evidence, then fix it with a new session or retry the phase.',
    ),
    done: say(
      'The phase is finished and verified.',
      'Nothing to do: the phases that depend on it can start.',
    ),
  }),
  board: Object.freeze({
    done: say(
      'The handoff is complete: the work is finished and verified on disk.',
      'Nothing to do: the phases that depend on it are free to start.',
    ),
    'in-progress': say(
      'A session is on this phase now, and its handoff is not complete yet.',
      'Nothing to do: the board catches up when the handoff lands.',
    ),
    stuck: say(
      'Its handoff says blocked or in progress, and nobody is working on it.',
      'Read the handoff’s outstanding section on the phase page, or use Ways forward on the run.',
    ),
    ready: say(
      'Every dependency is met, so this phase can start now.',
      'Start it, or let the autopilot board it when a lane frees.',
    ),
    waiting: say(
      'An earlier phase it depends on is not done yet.',
      'Nothing to do here: it becomes ready when that phase is done.',
    ),
    gated: say(
      'The plan holds this phase behind a gate before it may run.',
      'Open the phase’s gate card for its steps and approve it; a gate a session checks clears itself.',
    ),
    blocked: say(
      'Its handoff is marked blocked, and the handoff says why.',
      'Read the handoff’s outstanding section, settle what it names, then retry.',
    ),
  }),
  plan: Object.freeze({
    active: say(
      'Live work: the plan is being pursued and asks for attention.',
      'Follow the board: its ready phases are what boards next.',
    ),
    approved: say('Signed off, and not started yet.', 'Start a run when a lane frees.'),
    proposal: say('Drafted, and not signed off yet.', 'Read it and decide: approve it or set it aside.'),
    backlog: say(
      'Set aside on purpose, with the intent to come back to it.',
      'Nothing to do until you choose to take it up again.',
    ),
    complete: say(
      'Every phase landed, and the work is finished.',
      'Nothing to do: it no longer asks for anything.',
    ),
    abandoned: say(
      'Dropped on purpose: it will not be finished, and that is a decision, not a failure.',
      'Nothing to do; reopen it if it comes back.',
    ),
    superseded: say('Replaced by another plan, which its reason names.', 'Follow the plan that replaced it.'),
  }),
  handoff: Object.freeze({
    absent: say(
      'No handoff has been written for this phase yet.',
      'Nothing to do: the phase’s session writes it when it finishes.',
    ),
    pending: say(
      'The handoff exists and says the work has not started.',
      'Nothing to do: it moves when a session takes the phase.',
    ),
    'in-progress': say(
      'The handoff says a session is partway through the work.',
      'Nothing to do while a session is on it; with nobody on it, the board reads it as stuck.',
    ),
    blocked: say(
      'The handoff says the work is blocked, and names why.',
      'Read its outstanding section and settle what it names.',
    ),
    complete: say(
      'The handoff says the work is finished.',
      'Nothing to do: the board counts the phase as done.',
    ),
    unknown: say(
      'The handoff’s status line could not be read.',
      'Open the handoff and correct its status: complete, in progress, blocked or pending.',
    ),
  }),
  'qa-result': Object.freeze({
    pass: say(
      'A fresh review read the work cold, ran the checks and confirmed the phase.',
      'Nothing to do: the phases that depend on it are free.',
    ),
    fail: say(
      'The review recorded a failure, and every phase that depends on this one stays held on it.',
      'Repair the phase with a new session, which runs the review again; never edit the verdict away.',
    ),
    waived: say(
      'The review was skipped on purpose for this phase.',
      'Nothing to do; review it later if you want the confidence.',
    ),
    pending: say(
      'Review is on for this plan, and this phase has not been reviewed yet.',
      'Run the review from the phase page once it is done; the phases after it wait until then.',
    ),
    unknown: say(
      'The review record for this phase could not be read.',
      'Open the plan’s review record and correct this phase’s row.',
    ),
  }),
  'qa-mode': Object.freeze({
    off: say(
      'This plan runs no review between phases.',
      'Nothing to do; turn review on in the plan if you want it.',
    ),
    on: say(
      'A fresh review checks each phase, and a failure holds the phases that depend on it.',
      'Nothing to do: reviews run as phases finish.',
    ),
    waived: say(
      'Review verdicts are still recorded, but they no longer hold the phases after them.',
      'Nothing to do; turn the review gate back on in the plan to make verdicts hold again.',
    ),
    unknown: say(
      'The plan’s review setting could not be read.',
      'Check the plan’s review gate line and correct it.',
    ),
  }),
  gate: Object.freeze({
    human: say('A person clears this gate.', 'Do its steps, then approve it on the phase page.'),
    ai: say(
      'The phase’s own session clears this gate when it starts.',
      'Nothing to do: the session checks it as it boards.',
    ),
    auto: say(
      'The console clears this gate by itself once its condition holds.',
      'Nothing to do: it opens when the condition is met.',
    ),
    none: say('This phase has no gate.', 'Nothing to do: it starts once its dependencies are done.'),
  }),
  mcp: Object.freeze({
    connected: say(
      'The server answered, and its tools are available to sessions.',
      'Nothing to do: sessions that name it can use it.',
    ),
    'needs-auth': say(
      'The server needs a sign-in through a browser before sessions can use it.',
      'Sign it in from its row in Settings; a session cannot do it for you.',
    ),
    pending: say('The console is connecting to the server now.', 'Nothing to do: it settles in a moment.'),
    failed: say(
      'The server would not connect when it was last checked.',
      'Check its command and credentials in Settings, then check it again.',
    ),
    unknown: say(
      'The server has not been checked yet.',
      'Nothing to do: the next check reads it, or check it now.',
    ),
  }),
  auth: Object.freeze({
    ok: say('The account is signed in and can start sessions.', 'Nothing to do: runs may spend it.'),
    expiring: say(
      'The account’s sign-in runs out soon.',
      'Sign in again before it ends, so a run does not stop on it.',
    ),
    refreshable: say(
      'The login is idle and its short-lived token lapsed, but it renews itself at the next session.',
      'Nothing to do: the next session renews it.',
    ),
    expired: say(
      'The account’s sign-in was refused as expired.',
      'Sign the account in again; a session cannot do it.',
    ),
    'signed-out': say(
      'The account is not signed in, so it cannot start sessions.',
      'Sign it in from Settings.',
    ),
    unknown: say('The console has not checked this account yet.', 'Nothing to do: the next check reads it.'),
    unusable: say(
      'The provider refused this credential on a ground a new sign-in does not mend, such as a policy or a billing hold.',
      'Fix the cause with the provider, then clear the account in Settings.',
    ),
  }),
  entitlement: Object.freeze({
    unknown: say(
      'Nothing has proved yet that this credential can pay for work.',
      'Nothing to do: a usage reading or a session proves it.',
    ),
    entitled: say('The credential has proved it can pay for work.', 'Nothing to do: runs may spend it.'),
    cooling: say(
      'The credential hit a usage limit and is resting until the limit resets.',
      'Nothing to do: it rejoins at the reset.',
    ),
    suspect: say(
      'The credential was set aside as refused, but a later reading disagrees.',
      'Nothing to do: a successful check or session clears it, or check it now.',
    ),
    retired: say(
      'The provider refused this credential, and every account in its organisation is left out.',
      'Fix the cause with the provider, then clear it in Settings.',
    ),
  }),
  delivery: Object.freeze({
    sent: say('The notification reached the device’s push service.', 'Nothing to do: the device shows it.'),
    throttled: say(
      'The notification was held back because too many went out at once.',
      'Nothing to do: later ones still go out.',
    ),
    failed: say(
      'The push service refused the notification or could not take it.',
      'Check the device in Settings and send a test.',
    ),
    gone: say(
      'The browser retired this device’s subscription, so it was dropped.',
      'Subscribe the device again from its browser if you still want notifications there.',
    ),
    quiet: say(
      'The device was inside its quiet hours, so nothing was sent, on purpose.',
      'Nothing to do: the quiet hours are your own setting.',
    ),
    skipped: say(
      'The console could not see this announcement delivered, and the line beside it says why.',
      'Nothing to do unless the reason names something to fix.',
    ),
    'no-device': say(
      'No device was subscribed to take this notification.',
      'Subscribe a device in Settings if you want it on your phone.',
    ),
  }),
  watch: Object.freeze({
    pending: say(
      'The console is watching the outside thing this phase waits on.',
      'Nothing to do: the phase resumes when it lands.',
    ),
    landed: say(
      'The outside thing the phase waited on has happened.',
      'Nothing to do: the phase carries on.',
    ),
    unknown: say(
      'The console could not ask about the outside thing, so it cannot say.',
      'Check that the tool it needs is installed and signed in.',
    ),
    refused: say(
      'The console will not run this check, by policy, and has stopped asking.',
      'Change the plan to wait on something the console may check.',
    ),
    unrunnable: say(
      'The check behind this wait could not start, which says nothing about the thing it checks.',
      'Make sure the script it names exists and runs; it is asked again meanwhile.',
    ),
  }),
  decision: Object.freeze({
    answered: say(
      'The decision the plan asked for has an answer.',
      'Nothing to do: the phases that need it can use it.',
    ),
    outstanding: say('The plan asks for a decision, and the run cannot guess it.', 'Answer it in Your turn.'),
    waived: say('The decision was set aside on purpose.', 'Nothing to do: the run goes on without it.'),
  }),
  presence: Object.freeze({
    live: say(
      'A Claude session is open and working right now.',
      'Nothing to do: it shows here while it runs.',
    ),
    ended: say('The session has finished.', 'Nothing to do: its record stays.'),
    unknown: say(
      'The console cannot tell whether the session is still open.',
      'Nothing to do: the next sign of it settles the question.',
    ),
  }),
  terminal: Object.freeze({
    running: say('The terminal’s process is running.', 'Nothing to do: open it to watch or type.'),
    frozen: say('The terminal’s process is paused where it stands.', 'Continue it to resume, or stop it.'),
    stopping: say('The terminal is being closed.', 'Nothing to do: it settles in a moment.'),
    exited: say('The terminal’s process ended cleanly.', 'Nothing to do: start a new one when you need it.'),
    failed: say(
      'The terminal’s process ended with an error code.',
      'Read its last lines to see why, then start a new one.',
    ),
  }),
  liveness: Object.freeze({
    running: say('The console is up and answering.', 'Nothing to do: open it from the switcher.'),
    stopped: say('The console is not running.', 'Start it when you need it.'),
    orphaned: say(
      'The folder this console served no longer exists.',
      'Remove the console, or restore the folder it served.',
    ),
    'port-taken': say(
      'Another program holds the port this console needs.',
      'Free the port, or move the console to another one, then start it.',
    ),
    unknown: say(
      'The console has sent no recent sign that it is alive.',
      'Open it to see whether it answers.',
    ),
  }),
  rung: Object.freeze({
    running: say(
      'This recovery step is being tried right now.',
      'Nothing to do: its result shows here when it ends.',
    ),
    fixed: say('The recovery step mended what stopped the phase.', 'Nothing to do: the run carries on.'),
    'no-defect': say(
      'The recovery step found nothing wrong, which is not the same as fixing it.',
      'Nothing to do: the next step is tried if the phase is still stopped.',
    ),
    superseded: say(
      'Something else settled the phase before this step finished.',
      'Nothing to do: the step no longer matters.',
    ),
    withdrawn: say(
      'The step was called off before it ran, because the run stopped or moved on.',
      'Nothing to do: it runs again if the phase still needs it.',
    ),
    failed: say(
      'The recovery step did not mend the phase.',
      'Nothing to do: the next step is tried, and an item asks you once the steps run out.',
    ),
    interrupted: say(
      'The step was cut off before it could say how it ended.',
      'Nothing to do: the console decides whether to try it again.',
    ),
    'work-in-progress': say(
      'The step left work in the tree that is not finished yet.',
      'Nothing to do: the next step picks it up.',
    ),
  }),
  rungCause: Object.freeze({
    merit: say(
      'The step ran, and its result is a verdict about the remedy.',
      'Nothing to do: the same step is not tried twice.',
    ),
    environment: say(
      'The machine defeated the step: a refused credential, a network outage or an early stop.',
      'Nothing to do: it says nothing about the remedy, so the step may be tried again.',
    ),
    'never-ran': say('The step never started.', 'Nothing to do: it may run later.'),
  }),
  health: Object.freeze({
    error: say(
      'Something is broken and stops part of the console from working.',
      'Read the line: it says what is wrong and how to fix it.',
    ),
    warning: say(
      'Something is off, but the console still works.',
      'Read the line and fix it when convenient.',
    ),
    info: say('A fact worth knowing; nothing is wrong.', 'Nothing to do: read it if it helps.'),
  }),
  probe: Object.freeze({
    ok: say('The check passed.', 'Nothing to do: this part is fine.'),
    fail: say(
      'The check failed, and its reason says what to fix.',
      'Fix what the reason names, then check again.',
    ),
    skip: say(
      'The check could not be asked here, which is not a failure.',
      'Nothing to do: it never refuses a start.',
    ),
  }),
  restart: Object.freeze({
    waiting: say(
      'A restart waits for the live sessions to finish, and no new phase starts meanwhile.',
      'Nothing to do: it restarts at the first quiet point.',
    ),
    running: say(
      'The console is updating itself before it restarts.',
      'Nothing to do: it comes back in a moment.',
    ),
    restarting: say(
      'The update checked out, and the console is restarting on it.',
      'Nothing to do: the page reconnects by itself.',
    ),
    stopped: say(
      'The restart did not happen, and the line beside it says why.',
      'Read the reason, then restart again once it is settled.',
    ),
  }),
  checkout: Object.freeze({
    shared: say(
      'The run works in the console’s own checkout and takes turns with other runs there.',
      'Nothing to do: it queues behind work in the same repositories.',
    ),
    worktree: say(
      'The run works in a checkout of its own, apart from other runs.',
      'Nothing to do: its work is folded back when it settles.',
    ),
    refused: say(
      'The run asked for a checkout of its own and could not have one, so it shares the console’s.',
      'Read why beside it; the run still works, taking turns with others.',
    ),
  }),
  radar: Object.freeze({
    clean: say('These branches touch no common file.', 'Nothing to do: they merge without a fight.'),
    overlap: say(
      'These branches touch the same files but still merge cleanly.',
      'Nothing to do now; keep an eye on it as they grow.',
    ),
    conflicted: say(
      'These branches already conflict, and merging them needs a person.',
      'Settle the conflict before landing either branch.',
    ),
    unknown: say(
      'The overlap could not be measured, so it is not known to be safe.',
      'Nothing to do: the next check tries again.',
    ),
  }),
  settle: Object.freeze({
    settled: say('The run’s branch had its fate decided.', 'Nothing to do: the history keeps the record.'),
    landed: say('A lane’s commits reached the run’s branch.', 'Nothing to do: the run carries them forward.'),
    pushed: say(
      'The console pushed a phase’s branch to its remote.',
      'Nothing to do: review or merge it there.',
    ),
    pending: say(
      'A settle was asked for and waits on something.',
      'Nothing to do: it completes when what it waits on is done.',
    ),
    unsupported: say(
      'This repository cannot take that way of settling.',
      'Nothing to do: the run settles another way.',
    ),
    failed: say(
      'A lane’s commits did not reach the run’s branch.',
      'Read why, then land the lane’s branch by hand or retry the phase.',
    ),
    released: say('A checkout was given back to the machine.', 'Nothing to do: its branch is kept.'),
    pruned: say(
      'A branch the trunk already holds was deleted.',
      'Nothing to do: its commits are on the trunk.',
    ),
  }),
  'checkout-role': Object.freeze({
    root: say('The repository’s main working tree.', 'Nothing to do: it is never reclaimed.'),
    run: say(
      'A run’s own checkout, holding that run’s work.',
      'Nothing to do: it is released when the run settles.',
    ),
    lane: say(
      'One phase’s checkout, apart from the rest of its run.',
      'Nothing to do: it is folded back and released when the phase lands.',
    ),
    staging: say(
      'Where the plans’ folded work waits before it reaches the trunk.',
      'Nothing to do: it is never swept.',
    ),
    operator: say(
      'A linked checkout made by hand; the console did not create it.',
      'Nothing to do: the console never touches it.',
    ),
    debris: say(
      'A leftover checkout that no live run claims.',
      'Read it first, then reclaim it if nothing in it is needed.',
    ),
  }),
  landing: Object.freeze({
    held: say(
      'The phase’s work is kept on its branch on purpose, by the plan’s landing rule.',
      'Nothing to do: land it by hand when you choose.',
    ),
    integrated: say(
      'The phase’s work was folded into the run’s branch.',
      'Nothing to do: it lands with the run.',
    ),
    pushed: say(
      'The phase’s branch was pushed, and a pull request comes next.',
      'Nothing to do: the request opens next.',
    ),
    'pr-open': say(
      'A pull request for the phase is open and waits to be merged.',
      'Review and merge it where it is hosted.',
    ),
    'pr-merged': say('The phase’s pull request was merged.', 'Nothing to do: the work is on the trunk.'),
    landed: say(
      'The phase’s work reached the trunk.',
      'Nothing to do: the phases that wait on its landing can start.',
    ),
    conflict: say(
      'Git could not merge the phase’s work, so it waits for a person.',
      'Resolve the conflict between the two lanes it names, then land it.',
    ),
    failed: say(
      'The landing failed for a reason other than a conflict.',
      'Read why, then retry the landing.',
    ),
  }),
  verification: Object.freeze({
    none: say('The phase’s verification has not run.', 'Nothing to do: it runs when the session finishes.'),
    red: say('A verification check failed.', 'Open the evidence, fix the cause, then check it again.'),
    skipped: say(
      'The checks were skipped, for example because a tool they need is not on this machine.',
      'Install what is missing, or run the checks yourself.',
    ),
    human: say(
      'A check only a person can make is waiting.',
      'Make the check, then answer its item in Your turn.',
    ),
    green: say('Every verification check passed.', 'Nothing to do: the phase is marked done.'),
  }),
  'verification-line': Object.freeze({
    green: say('This check ran and passed.', 'Nothing to do.'),
    red: say('This check ran and failed.', 'Read its output, fix the cause, then check it again.'),
    'timed-out': say(
      'The console cut this check at its time limit, so it was not judged: it ran past the limit, which proves nothing either way.',
      'Give the phase a longer verify timeout, or make the check faster, then check it again.',
    ),
    skipped: say(
      'This machine could not run this check, for example because its tool is not installed.',
      'Install what is missing, or run the check yourself.',
    ),
  }),
  'issue-category': Object.freeze({
    bug: say(
      'Something does not work as it should.',
      'Nothing to do here: its severity and plan say what happens next.',
    ),
    enhancement: say(
      'A request for something new or better.',
      'Nothing to do here: its severity and plan say what happens next.',
    ),
    documentation: say(
      'A gap or a mistake in the documentation.',
      'Nothing to do here: its severity and plan say what happens next.',
    ),
    question: say(
      'A question rather than a defect.',
      'Answer it on the issue, or turn it into a bug or a request.',
    ),
    other: say('The issue carries no category label.', 'Label it so it sorts with its kind.'),
  }),
  'issue-severity': Object.freeze({
    critical: say(
      'It breaks work or loses data, and comes before everything else.',
      'Plan a fix for it now.',
    ),
    high: say('It hurts real work and should be fixed soon.', 'Plan it ahead of the rest.'),
    medium: say('A real problem, with a way around it.', 'Plan it with the next batch.'),
    low: say('A small problem or a nicety.', 'Plan it when there is room.'),
    none: say('The issue carries no severity label.', 'Give it a severity so it sorts with the rest.'),
  }),
  'issue-plan': Object.freeze({
    'needs-plan': say('No plan covers this issue yet.', 'Write a plan for it, or add it to one.'),
    planned: say('A plan covers this issue.', 'Nothing to do: it closes when that plan fixes it.'),
    deferred: say('The issue was set aside on purpose for now.', 'Nothing to do until it is taken up again.'),
    fixed: say('A plan fixed this issue.', 'Nothing to do: close it if it is still open.'),
    none: say('The issue carries no plan label.', 'Label it if it should be planned.'),
  }),
  step: Object.freeze({
    upcoming: say(
      'An act only a person can do is on its way, and not due yet.',
      'Nothing to do yet: it moves to Do now when it is due.',
    ),
    declared: say(
      'An act only a person can do has been asked for.',
      'Open it in Your turn and follow its steps.',
    ),
    notified: say(
      'You were told about an act only you can do, and it waits on you.',
      'Open it in Your turn and follow its steps.',
    ),
    opened: say('You opened the act and have not finished it.', 'Finish its steps, then ask for the check.'),
    checking: say(
      'The console is checking what you did.',
      'Nothing to do: it comes back passed or sent back.',
    ),
    returned: say(
      'The check sent the act back with what to redo.',
      'Redo what it names, then ask for the check again.',
    ),
    proven: say('The check confirmed the act.', 'Nothing to do: what waited on it carries on.'),
    declined: say(
      'The act was declined, so it will not be done.',
      'Nothing to do: the work that needed it hears so.',
    ),
    expired: say(
      'The act ran out of time before it was done.',
      'Nothing to do: it is asked again if still needed.',
    ),
    cannot: say('Someone said the act cannot be done.', 'Nothing to do: the phase that asked hears why.'),
    dismissed: say(
      'The act was withdrawn because nothing needs it any more.',
      'Nothing to do: it is closed.',
    ),
  }),
  verdict: Object.freeze({
    passed: say('The check accepted what the person did.', 'Nothing to do: the work carries on.'),
    rejected: say(
      'The check rejected what the person sent.',
      'Read what it found, fix it and send it again.',
    ),
    'needs-info': say(
      'The check needs one more thing before it can pass.',
      'Give it what it asks for, then ask for the check again.',
    ),
  }),
  risk: Object.freeze({
    low: say('Granting this can do little harm.', 'Grant it for as long as suits you.'),
    medium: say(
      'Granting this could change things that matter.',
      'Grant it for this phase or plan rather than always.',
    ),
    high: say(
      'Granting this could do real damage if it were misused.',
      'Grant it for this one call, and only if you expected the ask.',
    ),
    never: say(
      'This is on the never list, so no door grants it.',
      'Do it yourself, by hand, if it must be done.',
    ),
  }),
  grant: Object.freeze({
    live: say(
      'The grant is in force and answers matching asks.',
      'Nothing to do; revoke it when it is no longer wanted.',
    ),
    spent: say(
      'The grant was used up by the call it covered.',
      'Nothing to do: the next ask needs a new answer.',
    ),
    expired: say('The grant’s time or scope ran out.', 'Nothing to do: a new ask needs a new answer.'),
    revoked: say(
      'The grant was taken back, and what it changed was undone.',
      'Nothing to do: a new ask needs a new answer.',
    ),
  }),
  turn: Object.freeze({
    todo: say('An act only you can do is yours to do.', 'Follow its steps, then ask for the check.'),
    checking: say(
      'The console is checking what you did.',
      'Nothing to do: it comes back passed, or with what to redo.',
    ),
    passed: say('The check confirmed what you did.', 'Nothing to do: what waited on it carries on.'),
    redo: say(
      'The check sent it back with what to redo.',
      'Redo what it names, then ask for the check again.',
    ),
    'not-doing': say('You said you are not doing this one.', 'Nothing to do: the phase that asked hears so.'),
    closed: say(
      'Nothing needs this any more, so the console closed it.',
      'Nothing to do: it is kept for the record.',
    ),
    owner: say(
      'The press waits for the console’s owner to confirm it.',
      'Confirm it with the owner key, or wait for the owner.',
    ),
  }),
  readiness: Object.freeze({
    now: say('The act is due now.', 'Do it now: the work waits on you.'),
    'not-yet': say('The act is not due yet.', 'Nothing to do yet: the card says when it becomes due.'),
  }),
});
