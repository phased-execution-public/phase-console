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
- one button to start, chosen by the kind of item and where it stands: *Open sign-in*, *Open the link*,
  *Open in terminal*, *Enter it at the machine*, *Send my answer*, *I've done this — check*, or, for a
  permission, *Grant*.

## The page

**Your turn** (`#/turn`, under Runs) lists every act only you can do. Under the title it says which round
of the console read it, and when, and one sentence sums the page up: how many things need you now, which
has waited longest, how many are being checked or coming up, and how many the AI handled since you last
looked. The console composes that sentence by rules from its counts. No model writes it.

Below it come six sections, always in this order:

| Section | What is in it |
|---|---|
| **Do now** | Items waiting for you to act, including any that a check sent back. |
| **Needs one detail from you** | Decisions and questions: you answer instead of doing. |
| **Coming up** | Acts that are not due yet (see Acts that come due later). |
| **Being checked** | Items whose check is running. There is nothing to press until the verdict lands. |
| **Done** | What was settled today, with the older ones beneath, under *Earlier*. |
| **Handled by the AI** | What the AI settled on its own, instead of asking you. |

The page keeps itself current. Once a minute, and whenever a run writes to its journal, the console
takes a *round*: it sends the reminders that are due, expires a window that closed, withdraws an item
nobody needs any more, brings a coming-up act due, reads the proofs it can and ends the grants that ran
out. A round that changed anything updates the page on every screen. A quiet round changes nothing.

`#/turn/<id>` opens one item, and a push opens its item there for you. The phone queue's older addresses,
`#/approve` and `#/approve?step=<id>`, land on the page in one hop. The approval queue, the question card,
the gate card and the errand card no longer draw a shape of their own: each shows the item as one row with
its one button, and **Open on Your turn** takes you to the whole card. On the Tower, a Needs-you strip's
one action is its oldest item's button, and **Your turn (n)** in the situation line counts items and
opens the page.

Narrow the page by plan, run, kind, reason or risk, or search it for a title, a command or a plan. Every
filter is part of the address, so a narrowed view is a link. **Export** downloads the open items and
their guides as one Markdown document, and **Print** prints the same.

## Each item, and why only you

An item is one card. Its head says what state it is in and what kind of act it is, then gives its title,
then **Only you:** and the reason. Under that come the plan, phase and run it belongs to, each a link;
what it unblocks; a countdown while its window runs; and roughly how long it takes. Then the guide, how
it will be checked, and the buttons.

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

The guide is a short why, then the steps as stations on a line. Tick a station once that step is done. The
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
when it lands, on every screen at once.

- **Passed.** Every session waiting on the item is resumed, once, and told what was proven and what the
  check read.
- **Back to you.** The item returns to **Do now**. It says *Back to you — attempt 2: …* with exactly what to
  redo, and it resumes nothing. When the check needs one more detail it says *Back to you — attempt 2 needs
  one detail: …*. Every attempt keeps its own evidence and verdict, side by side in the history.
- **After three rejections** (the shipped number; Settings ▸ Automation changes it) the item asks how it
  should end: **Rewrite the guide**, which withdraws the item and asks its session for a better one;
  **I can't do this**; or **Accept anyway**. *Accept anyway* is the owner's press. It asks once more, then
  records the item as passed on your word, unverified, and the session carries on.

No session and no agent can mark its own item passed. Only the console's own check, the checking session
for that one item and the owner's *Accept anyway* write a verdict.

## Your other moves

Beside the check, an item offers these. Each is a press only you make.

- **Send my answer.** A decision shows its options as cards, each with what choosing it means and the
  recommended one marked, and a note you can add. A note is an answer by itself when no option fits. Your
  answer goes back to the waiting session as one resume per waiter: `The operator answered <option>:
  <note>`. When the answer names a key of the plan's `## Decisions` table, the console writes it there first.
- **Not doing this.** Where the raiser allows it, you can decline, with a reason. The item ends as
  *declined*, which is your own no; *withdrawn* is the console's word for an item nobody needs any more. The
  session is told `The operator declined: <reason>. Do not ask again; …` and finds another way.
- **I can't.** Say why and press **Hand it back**. The item becomes an errand carrying your words, and it
  does not repeat.
- **Ask.** A question about the task. The session reads it when it resumes.
- **Attach.** A note, an image or a file as evidence for this attempt: 160 KB a piece and six an attempt,
  screened for secrets, kept on this machine under its hash, and never pushed or journalled.
- **Snooze.** Holds the next reminder back by an hour.

## When the AI lacks permission

A **permission** item is the AI meeting a wall and asking you. The card opens "Raised because the AI lacks
permission to …" and shows the command, why the phase needs it, and the wall with its rule. It then offers
one control for how far a grant should reach, with the risk of the chosen scope beside **Grant**: *This
call*, *This phase*, *This plan*, *This repository* or *Always*. **I'll do it myself** turns the item into
your own act: its guide is the command, and its check resumes the session. **Deny** tells the session to
find another way.

A low or medium-risk grant is one press. A high-risk one asks you to type the rule back. A wall that is
never granted offers no **Grant** at all, only why, and the steps to take yourself. **Grant every low-risk
ask**, at the top of the page, grants every open low-risk ask in one press, each for this call or this
phase only.

The **Permissions** guide has the rest: the scopes, the tiers, the ledger, the never list and the owner key.

## Reminders, snoozing and quiet hours

A waiting item is repeated after 15 minutes, an hour and six hours, then once a day, until it is done or
its window closes (seven days, when the item names none). **Snooze** holds the next reminder back by an
hour. Reminders keep each device's own quiet hours, set in Settings ▸ Notifications ▸ Devices: a reminder
that falls due while every device that would hear it is quiet waits for the first one to wake, and it is
never urgent, so it never breaks through. The reminder is not dropped.

A reminder stops when the item settles: proven, declined with **Not doing this**, handed back with
**I can't**, or expired.

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

## Handled by the AI

The last section is the record of what you were spared. Each row says who handled it: a guard that refused
to raise something the AI could do itself, a standing grant or a relay rule that answered for you, the
recovery ladder, or the session itself. It says what was handled, how many times (×3), which plan and
phase, and when, with links to whatever shows it: a commit, a pull request, an issue or a journal line. One
row stands for one rule in one phase, with a count, so 452 auto-grants are one row. Nothing there is a
summons. The section starts folded, and the headline tells you how many rows are new since you last looked.

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

