## When a run needs you, not a decision

Some steps only a person can take. A tool opens a browser and waits for a sign-in. A service sends a
code to your phone. A permission dialog appears on the machine. The AI needs to run a command that a
rule stops. Nothing is broken when this happens, and the run is not stuck. It is your turn, and the
console says so in one place and one shape: the page called **Your turn**, at `#/turn`.

Everything on that page is an **item**. An item tells you:

- what to do, in plain words, as steps you can tick off;
- why only you can do it, and which plan, phase and run is waiting for it;
- where to do it: **At the machine** (the computer the console runs on) or **Any device**, your phone
  included;
- how it will be checked;
- one button to start, chosen by the type of item and where it stands: *I've done this — check* for a
  task, with *Open sign-in*, *Open the link*, *Open in terminal* or *Enter it at the machine* beside it;
  *Send my decision* for a decision; *Approve* and *Deny* for an approval, or, for a permission,
  *Approve* at a scope; *Got it* for a heads-up.

## The page

**Your turn** (`#/turn`) is a place of its own, second in the rail after **Runs**, and it lists every act
only you can do. Its badge in the rail counts what needs you now. Its heading counts the page in one
line, such as *1 to do now · 5 coming up · 6 done today*, and adds how many are being checked and how
many the AI handled since you last looked. The console composes that line by rules from its counts. No
model writes it, and it never quotes an item.

Under the heading sits the strip: three numbers, **to do**, **checking** and **passed today**; then the
live line, the round that read the page (*Round 14, read at 12:00. It last changed at 11:50.*); and **Next
deadline**, the nearest deadline any open item carries, with how long is left or how overdue it is. Its
title is a link to that item.

Under the strip come four tabs, each with its count:

| Tab | What is in it |
|---|---|
| **Open** | The default: what you approve, do now and decide, what is being checked, what is coming up, and the heads-ups. |
| **Done** | What was settled today, then the older items the console still holds. |
| **Handled by the AI** | What the AI settled on its own instead of asking you. |
| **All** | All of the above, on one page. |

The items sit in six groups, always in this order:

| Group | What is in it |
|---|---|
| **Approve** | Approvals: a yes or a no on something the AI, a plan or a session wants to do — a permission, a gate, a held plan, a run request. |
| **Do now** | Tasks waiting for you to act, including any that a check sent back to redo. |
| **Decide** | Decisions and questions: you choose one of the options instead of doing. |
| **Being checked** | Items whose check is running. There is nothing to press until the verdict lands. |
| **Coming up** | Acts that are not due yet (see Acts that come due later). |
| **Done** | What was settled, on the **Done** tab, never mixed in with the open work. |

Groups with nothing in them fold into one line, such as *Nothing to approve, to do now or to decide.*, so
empty headings never push the work down. A group the filters emptied keeps its heading and says how many
the filters hid.

**Handled by the AI** is a tab and a section, not a group. A plan's errand that no step names is a
**Heads-up**: nothing checks it or waits on it, it is counted nowhere, and it sits in its own section
after the groups until you press *Got it*. Last, **Where the plans stand** gives one line for every plan
the open items name: how many of its phases are done, the phase it is on now, the phase it can take next,
and how many of its items wait on you, which is a link to the page narrowed to that plan.

**View**, in the toolbar, draws the items four ways:

| View | What it draws |
|---|---|
| **List** | The default. One line per item: NOW or NOT YET, the type's mark, a short title, then your status, the plan and phase, and its clock: the deadline, in red once it is overdue, or how long it has waited. |
| **Board** | Columns by your status: **To do**, **Checking**, **Redo**, **Waiting for the owner** and **Done**. Each group is a lane, so `?view=board&group=plan` gives a lane to each plan. |
| **Cards** | Every item drawn whole, as the page was drawn before. |
| **Timeline** | Every item on one clock: a bar from when it was raised to its deadline, or dashed to now when it has none, a ring at when it is due to start, and a rule at now. |

Press a line in the list to select it. The address names it, `#/turn/<id>`, and its whole card opens in
the panel: beside the list at 1200 px and wider, a sheet from 900 to 1200 px, and on a phone the card as
a page of its own. ↑ and ↓, or j and k, move the selection, and Enter opens it. An older link that asks
for `?view=compact` opens the list.

**Group** puts the items under **What is asked** (the default, the six groups above), **Plan**, **Type**,
**Deadline** (past its deadline, due within a day, due later, no deadline) or **Status**. Whatever you
choose, what is done and the handled log stay apart from the open work. **Sort** puts the oldest, the
newest or the nearest deadline first.

Search for a title, a command or a plan. **Filter** narrows the page by **Status**, **Time** (past its
deadline, a deadline ahead, raised in the last day, waiting more than a day), **Plan**, **Type** and
**Goes to**; with **Everything** on it also offers run, kind, reason and risk. On a desk, 900 px and
wider, every filter is also a row of chips under the toolbar, each with its count. Press a chip to narrow
the page, and press it again to clear it. *Showing 3 of 9 items* says when the page is narrowed, with
**Clear the filters**.

The address is the page's whole state: the tab, the view, the grouping, the order, every filter and the
search, as in `#/turn?tab=done&view=board&group=plan`. A choice left at its default adds nothing to the
address. So a narrowed page is a link you can send.

To act on several items at once, tick their lines in the list, then press **Not doing**, **Hand back** or
**Snooze**. **Not doing** takes one reason for all of them and waits a few seconds with **Undo**, like the
card's own press. **Hand back** takes one reason, and each item's session takes its item back. **Snooze**
holds the next reminders back by an hour, four hours or until tomorrow. Only the items the console holds
in its ledger take these. A gate, an approval card or a relayed question is answered on its own card,
and the bar says how many of the ticked items it skips, and why.

Hover over a status word, focus it or tap it, and it says what it means and what comes next, with **More
in Help** for the rest. Under **⋯**, **Export as Markdown** downloads the open items as one document, each
with its options, its timing and what an approval is about, and **Print** prints the same. **Everything**
opens every folded card and section. On a phone the filters sit in the toolbar's sheet, with **Group**,
**Sort**, **View**, **⋯** and **Everything**.

Every plan has the same page as a view of its own: **Your turn**, beside **Phases**, **Run** and
**Source**, at `#/plan/<slug>/turn`, with its open count. It is this page narrowed to that plan, so it has
no **Plan** filter and no *Where the plans stand*.

The page keeps itself current. Once a minute, and whenever a run writes to its journal, the console
takes a *round*: it sends the reminders that are due, expires a window that closed, withdraws an item
nobody needs any more, brings a coming-up act due, reads the proofs it can and ends the grants that ran
out. A round that changed anything updates the page on every screen. A quiet round changes nothing.

A round also closes what nobody needs any more. When you start a plan again, the new run supersedes the
old one, and the old run's own items close themselves: an identity question, a refused checkout, a
streak of failures. An act that outlives a run, such as a sign-in, a secret or an errand at the
machine, moves to the new run and stays open. An item also closes when its phase is done on the board,
or when the errand behind it is gone. Each closed item reads **Closed** and leaves a row under
**Handled by the AI** saying why. A card that names a run acts only on that run: pressed after a new run
took its place, it refuses and says so, and the old run is never touched.

`#/turn/<id>` opens one item: it is selected in the list and its card opens in the panel, for an item the
ledger holds and for one the console projects from a gate or a card alike. A push opens its item there
for you. The phone queue's older addresses, `#/approve` and `#/approve?step=<id>`, land on the page in one
hop. The approval queue, the question card, the gate card and the errand card no longer draw a shape of
their own: each shows the item as one row with its one button, and **Open on Your turn** takes you to the
whole card. On **Runs**, the **Your turn** group lists the same items, one line each, and a run your turn
summons offers its oldest item's button as its one action; **Your turn (n)** in the situation line counts
items and opens the page. The bell shows a few of them too, and **Open Your turn** at its top brings you
here.

## Each item, and why only you

An item is one card. Its head says three things. First, whether the act is due: **NOW** means you can
do it this minute; **NOT YET** means it opens later, and says when, as a time or as the thing it waits
for (*when Phase 13 is done*). A NOT YET card has nothing to press. Second, what type of act it is:

| Type | What it asks of you | Its buttons |
|---|---|---|
| **Approval** | A yes or a no on something the AI, a plan or a session wants to do. | **Approve** and **Deny**, each with a note; a permission is approved at a scope. |
| **Task** | Something only you can do: sign in, type a code, store a secret, pay, act at a device or at the machine. | **I've done this — check**, with the button that opens it beside it. |
| **Decision** | A choice among named options, the recommended one marked. | The options, the last one **Hand it to the AI** where the AI can take it, a note for the AI, and **Send my decision**. |
| **Heads-up** | Nothing. It is there so you know. | **Got it**. |

Third, where you stand with it:

| Status | What it means |
|---|---|
| **To do** | It waits for you. |
| **Checking** | You said it is done and the check is running; **Undo: I'm not finished** takes it back. |
| **Passed** | The check passed, or your answer settled it. |
| **Redo** | The check sent it back, with exactly what to redo. |
| **Not doing** | You said you will not do it, or that you cannot. |
| **Closed** | It ended without you: it expired, it was withdrawn, or the run that needed it moved on. |
| **Waiting for the owner** | Another door asked for it, and the console's owner confirms it with the owner key. |

Then it gives its title, which names the act, then the plan, phase and run it belongs to, each a link,
what it unblocks and roughly how long it takes. A title is short, at most about 80 characters, and
starts with a capital; when the act takes more words, the whole wording is a muted line under it. A
plan's own errand carries its id, such as **E-4**, as a chip beside the title. When an errand is about
files to land, its list of files is folded under **Details**, grouped by repository, with a button that
copies it.

Under the title sits the **timing grid**, every clock of the item on one page clock, so a countdown moves
every second while the card is on screen:

| Cell | What it says |
|---|---|
| **Assigned** | When it became yours, and how long ago. |
| **Do it** | *Now*, or when it opens: a time with a countdown, or the thing it waits for. |
| **Deadline** | When it must be done by, what is left or how overdue it is, with a bar. *None set* when the plan named none. |
| **Open until** | When the item stops being open. It is the item's window, never its deadline. |
| **You sent it** | When you pressed the check. |
| **Checked** | When the verdict landed. |

The first three are always there; the other three appear once the item has them. Then comes **Only
you:** and the reason, once. A verdict that sent the item back comes next, before the guide, with its
numbered steps to redo. **From the AI** says what the session tried first and its last word. Then the
guide, **How it's checked**, and two lines that say where your press goes:

| Goes to | What happens when you press |
|---|---|
| **The phase** | Its session picks up where it stopped. |
| **The run** | The run applies it and carries on. |
| **The gate** | The gate opens and its phase starts. |
| **The console** | The console checks it, and the phases waiting on it start. |


**Checked by** says who decides it is done: *The console runs a check*, *A checking session reads your
evidence*, *Your answer is the result*, *Your word* or *Your grant*.

Last come the buttons, one act form for the item's type. A press that ends an item, *Approve*, *Deny*,
*Not doing this* or *Send my decision*, waits a few seconds on the page with **Undo** before it is sent.
**Inspect**, in the card's head, puts the item in the panel, and **Withdraw** takes back an item nobody
needs any more.

Every item carries one of ten reasons. The page's reason filter names them by these labels:

| Reason | What the card says after *Only you:* |
|---|---|
| The AI is not allowed | The AI lacks a permission it would need to do this. |
| Only you can sign in | Only you can sign in as yourself. |
| Only you hold the secret | Only you hold the secret it needs. |
| It spends money | It spends money, which is your call. |
| It accepts terms | It accepts terms on your behalf. |
| It is your decision | It is your decision to make. |
| It needs hands at a device | It needs hands at a device. |
| The AI cannot reach it | The AI cannot reach the system it happens on. |
| Somebody else must approve | Somebody else must approve it. |
| A rule reserves it for a person | A rule reserves it for a person. |

The raiser names the reason. When it names none, the item is given its kind's default, and the card says
it was inferred from its kind.

The console will not raise an item the AI could do itself. When a session says the AI is not allowed, or
cannot reach the system, or that a rule reserves the act, and the AI could in fact do it, the console
refuses to raise it and tells the session to run the commands itself. Those refusals are not lost: they
appear under **Handled by the AI**.

The guide is a short why, then the steps as stations on a line. It comes from the first of these that
exists: the guide the session or the plan wrote for the item, the row of the plan's errands table the
item names, the console's own words for that situation, or, last, the link or command to open and the
check said in words. So every item has steps, even one raised by an older console. Tick a station once that step is done. The
tick is yours, kept in this browser; the check, not the tick, decides when the item is done. A step may
also say what you should see (**Expect**), warn you of something (**Warning**) and carry a link.
**If it goes wrong** lists symptoms and what to do about each. A guide carries its language: one written in
Persian, or any right-to-left language, is drawn right to left, with its commands, refs and numbers left to
right.

Everything the console knows about an item is within two presses. **The history** shows who raised it and
when, every move, every attempt side by side with its evidence, the questions asked and the answer, and
**The raw record** beneath it shows the record itself. When the session says what it tried first, or left a
last word, the card shows both.


## Doing it

Press the card's button. A link opens in a new tab, and the card stays where it was. The link's whole
address is shown beneath it before you follow it, and only an `http` or `https` link opens. A command opens
in the embedded terminal: the command is printed first and runs only when you press Enter, so you can read
it before it runs, and when the item names no other proof, its exit proves the step. That terminal is the
console's `--allow-terminal` door; without it the card shows the command to run in a terminal of your own.
If you lose the tab or the code expires, press **Open again**. You can open an item as often as you need,
and the console counts every time.

Every command in a guide has two copy buttons: **Copy**, and **Copy for Claude Code**, which puts `!` in
front so your own Claude Code session runs it as a shell command. The page never runs a command from a
guide. Copying is the whole act.

A device code is shown large on the card and in the push. Copy it, or select it with one tap, and type it
into the page that asks for it, from any device. An item that needs hands at a device shows its link whole,
to open on the device in your hand.

**The console never takes a secret.** A secret-entry item says where the value goes: the keychain item
`phase-console-<id>` on macOS, a 0600 file elsewhere, or the place the item names itself (a `credential:`
ref). You put the value there yourself, then press **I've done this — check**, and the check finds it by
name. It reads that the value is there, never the value. The card has no field for a secret, and a check
that carries one is refused. A credential the console finds missing before a run starts raises the same
kind of item, proven by `credential:<id>`: `gh`, `claude`, `env:NAME`, `keychain:SERVICE` or `file:PATH`,
read by presence and never by value.

## The check

When you are done, press **I've done this — check**. The console runs the proof straight away and answers
with a verdict: *passed*, *rejected* with exactly what to redo, or *needs one detail*.

A proof the console can read itself, such as a command's exit or a tool's own status, is read at once, and
a miss says what it read, in its own words. A proof only words can state is read by a short checking
session, read-only and for that one item. It reads what you did, and what you sent for that attempt (see
**Attach**), against the words of the proof, in at most 12 turns, $0.50 and five minutes. It runs as
`sonnet` at `low` effort unless Settings ▸ Automation says otherwise. Switch the check off there and such
an item is taken on your word and marked unverified. A few items ask for your word by name, and for those
the check records it as yours; on a console with an owner key, that is the owner's press.

Many items prove themselves. The console keeps reading the proof in the background, and the card clears
when it lands, on every screen at once. An item whose proof reads a gate closes when that gate opens: its
press reads *Approve the gate on Phase N — the item closes when the gate opens.*, and the sessions waiting on
it resume once, whichever way the gate was opened.

- **Passed.** Every session waiting on the item is resumed, once, and told what was proven and what the
  check read. Since 9.0 a session usually waits at the very call that raised the item (the run's *When a
  phase needs a person* is *Defer* on a CLI that can): it carries on from that call with the answer, its
  context intact, where a parked session is boarded again from its handoff.
- **Back to you.** The item returns to **Do now**. It says *Back to you — attempt 2: …* with exactly what to
  redo, and it resumes nothing. When the check needs one more detail it says *Back to you — attempt 2 needs
  one detail: …*. The card reads **Redo**, shows those steps before the guide, and its button becomes
  **I've redone it**. Every attempt keeps its own evidence and verdict, side by side in the history.
- **Cannot run.** When the proof's own script does not exist on the console's checkout, the proof itself
  cannot run, and the check says so: *the proof itself cannot run — <script> does not exist on the
  console's checkout; exit 127*. That is not your miss. No verdict is written and no rejection is counted;
  the item goes back to **To do**, or to **Redo** if an earlier check had sent it back, and the card names
  the script and where the console looked.
- **After three rejections** (the shipped number; Settings ▸ Automation changes it) the item asks how it
  should end: **Rewrite the guide**, which withdraws the item and asks its session for a better one;
  **I can't do this**; or **Accept anyway**. *Accept anyway* is the owner's press. It asks once more, then
  records the item as passed on your word, unverified, and the session carries on.

No session and no agent can mark its own item passed. Only the console's own check, the checking session
for that one item and the owner's *Accept anyway* write a verdict.

## Your other moves

Beside the check, an item offers these. Each is a press only you make.

- **Send my decision.** A decision shows its options as cards, each with what choosing it means and the
  recommended one marked, and a note you can add. Nothing is chosen for you. A note is an answer by itself when no option fits. Your
  answer goes back to the waiting session as one resume per waiter: `The operator answered <option>:
  <note>`. When the answer names a key of the plan's `## Decisions` table, the console writes it there first.
  A decision with a proof has no separate check: *Send my decision* sends your answer, writes it where the
  proof reads it, and then runs the same check as **I've done this — check**. It passes only when the proof
  holds; otherwise it comes back on **Redo**, saying your decision was sent and what the console still
  cannot see. Every decision has a box for your words: the option's own field when the option takes
  words, else a note for the AI, which reaches whoever the item goes to before your choice is pressed. A
  stopped phase's card says what its session asked for, in its own words, with its own steps and options,
  never a pointer to its handoff.
- **Hand it to the AI.** A decision the AI can take ends with it: a session's decision, a plan's own
  decision that recommends an option, a stopped phase's ask that its session can clear, a branch
  conflict. Choose it, say in the box what the AI should know, and send. A session's decision is answered
  *decide it yourself*, with your note; a plan's own decision goes with the option the plan recommends,
  written where the plan reads it (`deprecations: deprecate` in its answers file), and your note is pinned
  for the phases it unblocks; a stopped phase resumes with the choice its own; a conflict goes to
  **Done**, and its run gets your words as a pinned note. A gate's Approve, which login a run goes on with, a sign-in, a secret and a permission are
  never handed over. A decision that offers it has no separate *I can't do this*.
- **Not doing this.** Where the raiser allows it, you can decline, with a reason. The item ends as
  *declined*, which is your own no; *withdrawn* is the console's word for an item nobody needs any more. The
  session is told `The operator declined: <reason>. Do not ask again; …` and finds another way.
- **I can't do this.** Every open item offers it, one press from the card, save a decision the AI can
  take, which hands itself over instead. It asks why. An item a session
  or a plan raised, a task, a decision or an approval, becomes an errand carrying your words, and it does
  not repeat. An item the console builds itself, a gate, a sign-in, a conflict or a stopped phase's ask,
  goes to **Done** as **Not doing** with your reason; the gate stays shut and the sign-in stays undone.
  Where the console runs phases, its run gets a pinned note with your words, which that phase's next
  session reads before it starts.
- **Hand it back.** It opens two ways to give the item back instead of doing it. **Give back to Phase
  N** returns it to the phase that raised it: its session takes it back and finds another way, or raises
  a better version. **Ask the session a question** sends your question; the session reads it when it
  resumes.
- **Undo.** While an item is **Checking**, **Undo: I'm not finished** takes your press back: the item
  returns to **To do**, or to **Redo** if a check had sent it back, and a verdict that arrives for that
  attempt is dropped. A press that ends an item waits a few seconds on the page with its own **Undo**
  before it is sent; after that it is settled. Once it went through, the card reads **Checking** and says
  what was sent and when, with nothing to press again, until the console moves the item; **Show the
  choices again** brings them back for an item that stays open.
- **Attach.** A note, an image or a file as evidence for this attempt: 160 KB a piece and six an attempt,
  screened for secrets, kept on this machine under its hash, and never pushed or journalled.
- **Snooze.** Holds the next reminder back by an hour, four hours, or until tomorrow.

## When the AI lacks permission

A **permission** item is the AI meeting a wall and asking you. The card opens "Raised because the AI lacks
permission to …" and shows the command, why the phase needs it, and the wall with its rule. It then offers
one control, **How far the grant reaches** — *This call*, *This phase*, *This plan*, *This repository* or
*Always* — and the button names the reach, **Approve, this call** to **Approve, always**, with the risk of
that scope beside it. **I'll do it myself** turns the item into
your own act: its guide is the command, and its check resumes the session. **Deny** tells the session to
find another way.

A low or medium-risk grant is one press. A high-risk one asks you to type the rule back. A wall that is
never granted offers no **Approve** at all, only why, and the steps to take yourself. **Grant every low-risk
ask (N)**, beside the **Approve** heading, grants every open low-risk ask in one press, each for this call
or this phase only. A granted item stays until the console confirms the grant applied, and says so.

The **Permissions** guide has the rest: the scopes, the tiers, the ledger, the never list and the owner key.

## When the run must act

Some things a phase cannot do for itself, because they belong to the whole run: run it again in a
checkout of its own, move it to another account, raise a phase's dollar budget, stop it, or hold it so
that no new phase starts. A phase that needs one of these asks the run, and the ask is a **run
request**, never a permission.

A run request is an **Approval** in the **Approve** group, one item for each run and act however many
phases asked. Its title is the act, *Relaunch this run isolated*, *Move this run to another account*,
*Raise the phase's dollar budget*, *Stop this run* or *Hold this run*, and it says what happens if you
approve and what happens if you deny. **Approve** takes the act on the run, and the phases that asked
carry on from it. For a budget, write the amount in the note. **Deny** leaves the run as it is, and the
phases that asked are told no. The card acts only on the run it names: if a new run of the plan has taken
its place, the press refuses and says so.


## Reminders, snoozing and quiet hours

A waiting item is repeated after 15 minutes, an hour and six hours, then once a day, until it is done or
its window closes (seven days, when the item names none). **Snooze** holds the next reminder back by an
hour, four hours or until tomorrow. Reminders keep each device's own quiet hours, set in Settings ▸ Notifications ▸ Devices: a reminder
that falls due while every device that would hear it is quiet waits for the first one to wake, and it is
never urgent, so it never breaks through. The reminder is not dropped.

A reminder on an item the check sent back keeps it on **Redo**. A reminder stops when the item settles: proven, declined with **Not doing this**, handed back with
**Hand it back**, or expired.

## Acts that come due later

Some steps are not a sign-in but a task only you carry out: a command to run where the console cannot,
or a few clicks on somebody else's dashboard, such as publishing a release once its build has finished.
A plan can name such a step ahead of time, or a session can declare one, together with what makes it
due: a ref of the kind a wait names, such as a build finishing or a date passing.

Until that ref lands, the step is **Coming up**. It is listed under **Coming up** on Your turn, after what
is due now. Its card is folded to its head, and **What it will ask** opens its guide, with its command
ready to copy. It sends nothing and reminds no one, its window has not started, and there is nothing to
press yet.

When the ref lands, the step is due, with one notification: `NOW:` and the command to run, or the step's
title when it is a click path. It moves to **Do now**, and the card offers **Open in terminal** for a
command, or **Open the link** or **I've done this — check** for a click path. When the step's proof holds,
it is done and the phase that needed it carries on. If the console cannot check the ref at all, the step
comes due at once and says why.

In a plan, such a step is a `- **Human step:** operator-act · … · due: <ref>` bullet, in a phase or
under `## Operator errands` for the plan as a whole. A session declares one with `phase-outcome.sh …
needs-human --act --due-when <ref>`.

## What a session's closing words ask

A session sometimes ends its turn on a question instead of asking it properly. The console reads the
last message of a session that ended without saying what it needs, so the question still reaches you,
once, as a **Decision**:

- **A session's questions.** When its last message ends on one or more questions, you get one item that
  lists them, each with the answer the session recommended. Choose **Go with the recommended answers**,
  or **Answer them myself** and write your answers in the note. A single question with named choices
  offers those choices instead, the recommended one marked. The same session carries on from your
  answer.
- **A gstack run at its gate.** gstack stops a run at its gate and never approves it for you. When an
  approval is waiting, you get an **Approval** with gstack's own options, the recommended one marked.
  When the console cannot read the gate, you get a Decision: **Take every recommendation**, or **Walk me
  through each item**. The session relays your answer to gstack, and the next approval, if there is
  one, comes after it.

A setup step a plan describes with a wizard (a script that walks you through stages) reaches you as a
**Task**, one step per stage, from "Stage 1 of 3" on, each with its commands. A secret never goes into the
console: the step says where it goes (the repository's GitHub secret, set with `gh secret set`, the
env file, or the login keychain), and you type it only at that hidden prompt.

## Handled by the AI

The **Handled by the AI** tab is the record of what you were spared. Each row says who handled it: a guard that refused
to raise something the AI could do itself, a standing grant or a relay rule that answered for you, the
recovery ladder, or the session itself. It says what was handled, how many times (×3), which plan and
phase, and when, with links to whatever shows it: a commit, a pull request, an issue or a journal line. One
row stands for one rule in one phase, with a count, so 452 auto-grants are one row. Nothing there is a
summons. The headline tells you how many rows are new since you last looked.

A session can add a row for something it settled itself. Its row always reads as the session's. A session
can never speak as the guard or the rule table.

## From your phone

The page works on a phone at 360 px: the code, the link, the guide, the check and the snooze. Only an item
marked *At the machine* needs you at the computer. A push opens its item, already open, and carries only
the buttons a phone may press:

| The push is about | Its buttons |
|---|---|
| An act | **Open**, and **I did it**, which runs the proof without opening anything. |
| A decision | **Open**. Its answer is one of its options, on the page. |
| A permission at low or medium risk | **Allow**, a grant at the narrowest scope the item offers, and **Deny**. |
| A permission at high risk, or one that is never granted | **Open** and **Deny**. A risky grant is typed on the page. |

**I did it** only asks the console to run the item's proof. The verdict stays the console's or the
checker's, never the phone's. Android shows at most two buttons; iOS shows the notification without them,
and a tap opens the item.

