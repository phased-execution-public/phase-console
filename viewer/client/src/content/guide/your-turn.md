## When a run needs you, not a decision

Some steps only a person can take. A tool opens a browser and waits for a sign-in. A service sends a
code to your phone. A permission dialog appears on the machine. Nothing is broken when this happens,
and the run is not stuck. It is your turn, and the console says so in one place and one shape.

Each turn is a card. The card tells you:

- what to do, in plain words, with numbered steps when there are several;
- where to do it: **At the machine** (the computer the console runs on) or **Any device**, your phone
  included;
- one button to start, chosen by the kind of step: *Open sign-in*, *Open in terminal*, *Enter it at
  the machine*, *Approve*, or *I did it — check*.

## Doing it

Press the card's button. A link opens in a new tab, and the card stays where it was. A command opens in
the embedded terminal. The command is printed first and runs only when you press Enter, so you can
read it before it runs. If you lose the tab or the code expires, press **Open again**. You can open a
step as often as you need, and the console counts every time.

A device code is shown large on the card and in the push. Copy it, or select it with one tap, and
type it into the page that asks for it, from any device.

A secret, such as an API key, is typed once into the card's form. It goes straight to the machine's
keychain and is never shown again, not even to you.

## Proving it

When you are done, press **I did it — check**, or **Check now**. The console runs the step's proof
straight away, usually the tool's own status command. When the proof holds, the step is done and the
phase's own session carries on, told what was proven. When it does not hold, the card shows what the
proof said, in its own words, so you can see what is still missing.

Many steps prove themselves. The console keeps checking in the background, and the card clears when
the proof lands, on every screen at once.

## Reminders, snoozing, and handing it back

A waiting step is repeated after 15 minutes, an hour and six hours, then once a day, until it is done
or its window closes. **Snooze** holds the next reminder back by an hour. Quiet hours, set under
Settings › Notifications, delay a reminder until they end; the reminder is not dropped.

If you cannot do a step, press **I can't do this** and say why. The step becomes an errand carrying
your reason, and it will not repeat.

## Acts that come due later

Some steps are not a sign-in but a task only you carry out: a command to run where the console cannot,
or a few clicks on somebody else's dashboard, such as publishing a release once its build has finished.
A plan can name such a step ahead of time, or a session can declare one, together with what makes it
due: a ref of the kind a wait names, such as a build finishing or a date passing.

Until that ref lands, the step is **Coming up**. It is listed at the foot of the Tower's Needs-you bay
and on the approve page, after what is due now, with its command ready to copy. It sends nothing and
reminds no one, and its window has not started. The only thing you can do with it yet is **I can't do
this**.

When the ref lands, the step is due, with one notification: `NOW:` and the command to run, or the step's
title when it is a click path. The card then offers **Open in terminal** for a command, or **Open the
link** or **I did it — check** for a click path. When the step's proof holds, it is done and the phase that
needed it carries on.
If the console cannot check the ref at all, the step comes due at once and says why.

In a plan, such a step is a `- **Human step:** operator-act · … · due: <ref>` bullet, in a phase or
under `## Operator errands` for the plan as a whole. A session declares one with `phase-outcome.sh …
needs-human --act --due-when <ref>`.

## From your phone

A turn's push carries two buttons. **Open** goes straight to the step's card, and **I did it** runs the
proof without opening anything. Everything on the card works from a phone at 360 px: the code, the
link, the check and the snooze. Only a step marked *At the machine* needs you at the computer.
