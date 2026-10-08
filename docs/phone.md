# 📱 Reaching it from your phone

> *An unattended run exists so you can stop watching it. That only pays off if it can still reach you.*

A run halts when it needs a person — a command it will not take on its own authority, a check only
you can make. It raises an **approval** and waits. If the console is only reachable from the chair in
front of it, every one of those pauses lasts until you sit back down.

This section sets up the console so you can watch a run, answer an approval, and start the next phase
from a phone, on any network, without putting anything on the public internet.

It takes about ten minutes, and most of it is clicking two switches.

> **The short way.** Settings → *Reach this console from your phone* reads your tailnet live: which
> devices are on it, whether `serve` points at this console, and whether the console's own remote
> settings agree with it — that last disagreement is the one that looks fine from your desk and fails
> from the phone. The card carries a copy-paste prompt that does the whole setup; it is
> [Prompt 2 in the README](../README.md). Everything below is the same thing done by hand, plus the
> parts the card does not cover — the machine profile, push notifications, out-of-band alerts, and
> what is enforced.

## The shape of it

```
  your phone, anywhere                       your machine
  ────────────────────                       ────────────
  https://your-machine.your-tailnet.ts.net
        │
        │  encrypted, private network, no open ports
        ▼
  tailscaled ──────────── sets Tailscale-User-Login: you@example.com
        │
        │  http://127.0.0.1:4123
        ▼
  Phase Console ───────── still bound to loopback. It always was.
```

**The console does not open a port on a network — not before this, and not after.** It keeps
listening on `127.0.0.1`, and something that already knows who you are is placed in front of that
socket. [Tailscale Serve][ts-serve] is that something: it terminates TLS, authenticates the caller
against your private network, and forwards to loopback with the caller's login in a header.

That header is the whole authentication story, and it is only worth anything *because* the console
stays on loopback. If it listened on a network interface, anyone who could reach it could simply send
the header themselves. This is [Tailscale's own guidance][ts-serve]: *"it's best practice to only
have the service listen on localhost."*

You need a [Tailscale](https://tailscale.com) account. The free tier covers this comfortably.


## Once for the machine — not once per repository

Everything the phone path needs belongs to the machine and to you, not to a repository, so it is done
once:

| Once, for the machine | Where |
|---|---|
| Three tailnet switches, and the phone on the tailnet | Steps 1–2 |
| The machine profile: the tailnet name and the logins allowed through it | Step 3 |
| One Serve handler, the Home Screen install, one push subscription | Steps 4–6 |
| A notifier that needs no browser *(optional)* | Step 7 |

A console on its own is one repository's, and the steps publish that console. Once Step 3 is written
it needs no remote flags to start — `phase-console ~/code/your-repo`, or `./start --root
~/code/your-repo` from the console's folder — because it reads the profile itself.


## Step 1 · Turn on three things for your tailnet

All three are off by default and all three are needed. The first two are on the [DNS page of the
admin console](https://login.tailscale.com/admin/dns):

1. **Enable MagicDNS.** This is what makes `your-machine.your-tailnet.ts.net` resolve for your own
   devices. Without it you would be typing an IP address, and an IP address cannot have a
   certificate.
2. **Enable HTTPS Certificates.** Tailscale then provisions a real, publicly-trusted certificate for
   that name. HTTPS *requires* MagicDNS, so do them in this order.
3. **Enable Serve.** This one has no switch to find in advance: the first time you run
   `tailscale serve` on a tailnet that has never used it, the command prints an approval link
   containing that machine's node ID and then **waits** rather than exiting. Open the link, approve
   it, and the command you already ran continues on its own. If you would rather do it up front, run
   the Step 4 command now and click what it gives you.

> **Know what you are agreeing to.** Every certificate on the web is recorded in the public
> Certificate Transparency log, so enabling this publishes your machine's name — e.g.
> `your-machine.your-tailnet.ts.net`. The **name** becomes public. The machine does not: it stays
> unreachable from the internet, and nothing about this opens a port.

While you are in the admin console, on the [Machines
page](https://login.tailscale.com/admin/machines), **disable key expiry** for this machine. Node keys
expire by default, and when one does, remote access stops with no warning and no obvious cause.

## Step 2 · Put your phone on the same tailnet

Install the Tailscale app, sign in with the same account, and — this one is easy to miss — make sure
**"Use Tailscale DNS" is ON** in the app's settings. It is what lets the phone resolve the `.ts.net`
name. Without it the name simply will not load, and nothing else in this guide will work.

Check `tailscale status` on your machine; the phone should be listed.

## Step 3 · Tell the console who may arrive — once, in the machine profile

A phone is admitted on two facts: the hostname the proxy serves, and the logins allowed through it.
Both are the machine's, so write them once in the **machine profile**,
`~/.config/phase-console/fleet.json`, from the console's folder:

```bash
node viewer/shared/instances.mjs profile-set remoteHost '"your-machine.your-tailnet.ts.net"'
node viewer/shared/instances.mjs profile-set remoteUsers '["you@example.com"]'
node viewer/shared/instances.mjs profile      # the file as every console reads it
```

Use your real MagicDNS name — `tailscale status --json` prints it as `Self.DNSName` — and the login
you signed in with. The value is JSON; `null` clears a key, and a value the profile cannot act on is
refused rather than written.

Every console reads the profile when it starts, field by field. A console started with no `--remote`
and no `--remote-user` inherits both, so neither belongs on its command line. Remote access is
inherited only as a usable pair: a host with no login, or logins with no host, is left alone and the
console boots local-only rather than refusing to start over a half-written file. The profile is read
at startup — restart a running console to pick up a change.

What the file holds, and what a console does with each field:

| Field | Read as |
|---|---|
| `remoteHost` | The hostname the console also answers to behind the proxy — what `--remote` names. |
| `remoteUsers` | The logins allowed to arrive that way — what `--remote-user` names. |
| `notifyCommand` | The out-of-band notifier (Step 7), when `PHASE_CONSOLE_NOTIFY` is not set. |
| `webhooks` | Rows of `{url, name?, categories?}` that every console started with `--allow-webhooks` delivers to. They are the file's: a console lists them and never stores or removes them. |
| `maxSessions` | The machine's lane ceiling — every console's live lanes summed. `--max-sessions` stays each console's own ceiling. |
| `hookScript` | An absolute path to the session-presence hook script `install-hooks` and `hooks-status` use, when that file exists. |
| `categories`, `quietHours` | Recorded, and reported among what a console inherits. What reaches a device is still chosen on that device (Step 6). |
| `instances` | Per console, by id: `autostart` (`true`, `false` or `once` — whether it starts its work unattended at boot) and `overrides` of `remoteHost`, `remoteUsers`, `notifyCommand`, `webhooks`, `categories` and `quietHours` for that console alone. |

**A flag still wins, for the one console it is passed to.** Neither flag changes what the server binds
to:

| Flag | Meaning |
|---|---|
| `--remote <host>` | The console also answers to this hostname, which is fronted by an authenticating proxy. Repeatable. Wins over `remoteHost`. |
| `--remote-user <login>` | A login allowed to arrive that way. Repeatable, or `PHASE_CONSOLE_REMOTE_USERS` as a comma-separated list. Wins over `remoteUsers`. |

```bash
./start --root ~/code/your-repo --allow-writes --allow-run \
        --remote your-machine.your-tailnet.ts.net \
        --remote-user you@example.com
```

`--remote` with no allowed login at all — none from `--remote-user`, the environment or the profile —
**refuses to start**. Starting with no allowlist would look completely correct and quietly admit
everyone on your network, so it is an error rather than a warning.


## Step 4 · Put the proxy in front of it

Settings → *Reach this console from your phone* prints the command for this console's own port. For
the console on 4123 it is:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:4123
tailscale serve status          # confirm what is being served
```

**The first run on a tailnet that has never used Serve will not return.** It prints
*"Serve is not enabled on your tailnet"* with an approval link, and waits for you to open it. That is
the Step 1 item you cannot do in advance — approve it and the command finishes by itself. Every run
after that returns immediately.

**`--bg` is not optional if you want this to last.** With it, Serve is persistent: it comes back
after a reboot and after `tailscale down` / `tailscale up`. Without it, Serve lives only as long as
that foreground command, and you will be re-running it by hand forever.

To undo it: `tailscale serve --https=443 http://127.0.0.1:4123 off`, or `tailscale serve reset` to
clear everything.


Now open `https://your-machine.your-tailnet.ts.net/` on the phone. Padlock, no warning, no port
number.

## Step 5 · Install it on the Home Screen

In Safari: **Share → Add to Home Screen**.

This is not decoration. On iOS, **web notifications only exist for a site installed to the Home
Screen** — in an ordinary Safari tab the permission cannot even be requested. Since the notification
is the entire point of being reachable, the install is part of the setup rather than a nicety.

Once it is installed, open it from the Home Screen and grant notification permission from the button
in **Settings**. Permission is never demanded on load: a page that asks the moment it opens gets
refused by reflex, and that refusal is permanent.

You will get a notification when a run **halts**, when it is **parked**, when it **finishes**, and
when an **approval** is waiting — and deliberately not for every phase, because a channel that fires
constantly is a channel you learn to ignore.

Android needs none of this — notifications work in a normal HTTPS tab — but installing it still gives
you a cleaner window.


## Step 6 · Turn on push, and choose what it sends

**Settings ▸ Notifications** (`#/settings/notifications`) has two switches, and the difference between them is the
whole point:

| | What it is | When it fires |
|---|---|---|
| **In this tab** | The Notification API, raised by the page off the console's own live event. | Only while a tab is open somewhere — and only when that tab is in the background and the browser holds no push subscription (a subscribed browser's service worker shows the card instead, so nothing arrives twice). |
| **On this device** | A push subscription, delivered by Apple, Google or Mozilla to a service worker. | With the console closed, the phone locked, the laptop asleep. |

Press **Turn on** under *On this device*, then **Send a test** — it goes out through the real push
service and back, so a notification appearing proves the whole chain rather than the last hop of it.

Do it on the laptop too. `http://127.0.0.1` counts as a secure context, so the same button works
there with no HTTPS involved, and every browser gets its own subscription and its own choices.


**Every notification names its console.** A push carries the console that sent it, and the card's
title reads `<title> · <console name>` unless the title already says it — one device can hear more
than one console. A notification's tag, which decides which card replaces which, is namespaced by the
console's id, so two consoles never overwrite each other's cards. That namespacing changed every tag
once, at 5.0.0: a card delivered before the upgrade stands beside its successor rather than being
replaced by it.

**Twenty categories, per device**, because a phone and a laptop rarely want the same ones. This
table is the catalogue (`viewer/server/push/catalogue.ts`), and a test holds it to it — if the two
ever disagree, the catalogue is right:

| Category | Default | Fires when |
|---|---|---|
| **Permission needed** | on | A session is blocked on a decision only you can make — a command outside its rules, a gate, or a check it cannot make itself. Nothing proceeds until you answer. |
| **Session waiting on you** | on | A Claude session is stopped at a permission prompt or a question — a lane of the autopilot, one you ran in a terminal, or an agent session. The body is the question itself, with the plan and phase when the console can tell which, never the directory. A lane whose phase already has a card waiting in the approval queue is not pushed twice. The row is resolved when the wait is answered or the session ends, and a wait still unanswered after an hour is pushed once more. A question a relayed session asks arrives here too, answered by rule when its window closes unless you answer first. |
| **A phase needs you** | on | A phase did its work and stopped at something no automation may sign off — a check written as prose, a verification only a person can make, or a human step: a sign-in, a code, a secret, a permission, an approval only you can give. A push for an item opens the item itself (`#/turn/<id>`), with the buttons a paired device may press (below) — and, for a device code, the code. It is not failed and not finished; it is waiting, and it will keep waiting. |
| **Gate needs a person** | on | A phase is held at a gate only a person may clear — a physical act, a third party, a credential no session holds. The board will call the phase ready the moment it is approved and not one second before, so nothing else moves and nothing else will ask. |
| **QA verdict owed or failed** | on | A finished phase still owes its QA verdict, or QA recorded a fail. Either way the plan gates on it: every dependent phase is held until pass or waived is recorded, and nothing records one by itself. Sent only after the console's own chase (the at-finish dispatcher, then the ladder) left the verdict owed. |
| **Run halted** | on | A run stopped on something that must not be automated past — a failed verification, a phase that would not settle. Includes a run that was interrupted with nothing driving it. |
| **Run parked or waiting** | on | Every remaining phase needs a person, or the run is asleep until a usage window reopens. Not an error — it just will not move on its own. |
| **Nothing is happening** | on | A session is still running and still spending, and it has stopped producing work — silent for ten minutes, six turns without touching a tool, or three attempts that changed nothing. Not urgent: it is not blocked on you, and the run has not stopped. It is the money question rather than the permission question. |
| **Phase finished or failed** | on | Each phase as it lands, with what it cost. The steady pulse of a run you are not watching. |
| **Plan finished** | on | A run reached the end of its plan. The one you actually wanted to be told about. |
| **Work became ready** | off | A phase became startable because what it was waiting on finished — including work finished by a session you ran yourself, elsewhere. |
| **Plans changed on disk** | off | Any plan or handoff was written. Genuinely everything — an agent editing a handoff mid-phase fires this. Off by default because it is a firehose, not a signal. |
| **A session ended** | on | An agent session or terminal finished while you were not watching it, or exited with an error. Closing one yourself is not announced — you already know. |
| **Console problems** | on | The console degraded, its file watch went deaf, or it restarted after a crash. The supervisor failing quietly is the worst case, because everything else still looks fine. |
| **Usage limits** | on | A Claude account this console runs work as hit a usage window — the 5-hour session, the weekly allowance, or a per-model one — with when it resets, plus what the run did about it (waited, switched account, paused) and an account that needs signing in again. Also **Login needs renewing** — before a login a live or queued run depends on can no longer be renewed (see below). |
| **Usage climbing** | on | Early warning while a window fills — 80% is "plan your afternoon", 95% is "the next long phase will not finish" — and, hours ahead, an account serving live runs that its measured burn will wall: when, when it resets, and which runs are burning it (2 hours before by default). On by default since control-tower phase 92 (#141): the warning that could have said "walls ≈10:50, resets in four days" was off. The wall itself still announces under Usage limits. The lead is the `usageForecastLeadHours` preference (hours, default 2); `usageForecastHold: true` also holds new admissions on that account until the window resets. |
| **Budget spent or running low** | on | A budget that can stop work reached 80% or ran out — a phase's wait (its `Waits on:` max or the plan's `Wait budget:`), a phase's or the run's dollars, the recovery ladder's cap, the failure streak. The first line says which budget and the arithmetic — `60m wait budget · 39.7m accrued · 20.3m left · asked for 90m` — and what spent it; the run page's card beside it raises the budget where it was declared (the plan's line for a wait, the run's setting for dollars and rungs, Clear streak for the streak) and retries in one press. Once per budget per attempt; not urgent (control-tower phase 14, #40). |
| **Issue drafted by a session** | on | A session tripped over a problem outside its phase and drafted an issue for it (the plan's `Issues:` word allows it). Under `draft` it waits in the inbox for your Approve, Discard or edit; under `file` it was filed at once and this tells you what landed. Not urgent: nothing is spending while a draft waits, and a filed issue is a record, not a wall. |
| **Hourly digest** | off | A summary instead of a stream: once an hour, Your turn first — `Your turn: 3 need you — 1 came back from a check · 4 handled by the AI since the last digest`, counted from the page's own answer — then every decision waiting on you with how long it has waited and when it expires, every parked run and every stalled session — and, once the channel answers again, the notifications an outage kept from arriving. Nothing waiting sends nothing: what the AI handled is said beside something that waits, never on its own. Off by default: the categories above already say each thing as it happens. |
| **Permission granted** | on | A grant was applied (control-tower phase 149): who granted which rule, through which door, for how far — this call, this phase, this plan, this repository or always — until when, and exactly what it changed. Every grant is a row Settings ▸ Permissions lists and revokes, and the push opens there, at that grant (`#/settings/permissions?grant=<id>`, control-tower phase 138); the session it answered resumes by itself. Not urgent: it records authority given, it asks nothing of you. |

**Login needs renewing** (under *Usage limits*, control-tower phase 91). A signed-in account's
access token lapses every few hours; while the console runs it renews each one through the Claude
CLI's own refresh a few minutes before it lapses, so an unattended run does not stop for it. When a
renewal FAILS — the refresh was refused, or the CLI could not reach the sign-in service — and a live
or queued run depends on that account, the phone and the notification inbox say so once, with the
runs that wait on it and the exact fix: `CLAUDE_CONFIG_DIR=$HOME/…/<profile>/config claude auth login`
for a profile, `claude auth login` for the machine login, or "paste a new setup-token" for a token
account. A run already stopped by an expired or signed-out login resumes by itself once `claude auth
status` and a usage read both succeed on the identity it started on; an organisation or policy refusal
still waits for your press. For runs left alone for days, a long-lived token (`claude setup-token`)
never needs renewing — the account card and the start door offer it.

Five are sent **urgent** — *Permission needed*, *Session waiting on you*, *A phase needs you*,
*QA verdict owed or failed* and *Run halted* — because they are the ones that mean nothing moves
until you act; urgent interrupts a focus mode and buzzes a wrist. The other fifteen arrive quietly.
A channel that always buzzes is a channel you turn off, and the notification it gets turned off for
is the one that mattered. A REMINDER of a person's turn is never urgent, whatever its category: it is
a repeat, not news, so it never breaks through a device's quiet hours (below).

A gate is deliberately one of the quiet fifteen, and it is the distinction the split exists for: it
waits on a decision rather than on a session parked dead with a hook open, and nothing is spending
while it waits.

Payloads are encrypted to a key only your browser holds ([RFC 8291][rfc8291]), so the push service
relays a notification about your plans without being able to read one. Nothing is installed to make
that work — the implementation is `node:crypto` and about four hundred lines.

### Your turn — a human step on the phone

When a run needs an act only you can do — a sign-in that opens a browser, a device code, a token to
paste, an approval on somebody else's dashboard — the push says so as *A phase needs you*, titled
"Your turn: …" with the kind and the phase, and its body says what to do and where: *at the machine
the console runs on* for a step that must be done there, nothing added for one you can do from the
phone. A `device-code` step puts the code itself in the body, so the phone is enough. **Every push for
an item opens the item** — Your turn's `#/turn/<id>`, expanded with its guide and its buttons — the tap
on the body and *Open* alike, and the bell's row and a webhook's link go to the same address (control-tower
phase 138). No code you type, token or password is ever in a push — only a device code, which is useless
without your own signed-in browser.

**The lock screen offers only what a paired device may press.** A pressed button is a signed action,
and a signed action is the `device` door: the door table lets it make low and medium grants, answers and
declines — nothing else on its own (`viewer/shared/door-model.js`, the one table every door is read
from). So the buttons an item's push carries are read from that table, never written by hand:

| The item | Its two buttons | Why |
|---|---|---|
| an act — a sign-in, a code, a token, somebody else's approval | *Open* · **I did it** | *I did it* runs the item's proof on the console; a proof that lands resumes the phase's own session told what was proven, one that does not is said, and the item waits on. |
| a permission item at low or medium risk — the wall an ask or an allow list, priced at its narrowest scope | **Allow** · **Deny** | *Allow* grants it at the NARROWEST scope the item offers (this one call), through the `device` door, exactly as the item's own Grant would; *Deny* tells the session to find another way. |
| a permission item at high risk — a deny-wall rule, a capability, a profile raise | *Open* · **Deny** | A high grant needs the rule typed and, with an owner key, the key touched: the first button opens the item, where both are. The console reads the table again when a press arrives, so a grant pressed anyway is refused and the item opens. |
| a permission item on the never list — a guard, a credential, a forced push, the host family | *Open* · **Deny** | No grant is offered through any door; the item says why, and the manual path. |
| a decision — options to choose between | *Open* | Its answer is one of its options, on the page; a check of an unanswered decision would only send it back. |

iOS draws no buttons at all and shows the notification, so there the tap is the whole answer: it opens
the item.

One turn is one push (control-tower phase 132). The errand a parked phase writes for the same step —
or for a person errand, a credential the preflight found missing, a question the relay will not
answer — is the same item, not a second card: it pushes nothing of its own, and its row's button is
*I've done this — check* on that item. Every push for an item, the first and each reminder, rides one
tag, so the phone holds one notification per item.

A step you have not done is **reminded**: 15 minutes after the first push, then an hour after that,
six hours after that, then daily — each gap counted from the last reminder or from your last open or
check, whichever is later. A reminder replaces the step's notification rather than stacking beside it
("Still your turn … Reminder 2"). *Snooze* holds the next reminder back (an hour, a day at most), and
reminders obey **the devices' own quiet hours** — the one quiet-hours setting there is (below): a
reminder that falls due while every device that would hear it is inside its window waits for the first
one to end — deferred, never dropped — and, being a repeat rather than news, it never breaks through a
quiet window the way an urgent first push may. Reminders stop when the step is proven,
when you press *I can't do this* (it becomes an errand carrying your reason), or when it is
withdrawn; a step whose window closes (seven days when it names none) expires into an errand too, so
nothing reminds for ever.

### When nothing would reach you

A console that announces to nobody looks exactly like a console with nothing to say, so it checks.
An announcement no subscribed device will take is recorded as `no-device` in the delivery ledger (Debug
shows it); when the reason is that no device is subscribed at all, it is also logged, once per process,
as `push.no-device`. The console then
judges its whole channel — a subscribed device, a notifier (`PHASE_CONSOLE_NOTIFY` or the profile's
`notifyCommand`), or a webhook row — and while none of them reaches anyone it keeps one `push-broken`
issue, `delivery-channel`, naming the first category that found nobody. Under `--remote` the channel
also needs Tailscale running and Serve pointing at this console's port. The issue withdraws itself the
moment a channel appears (`env.delivery-channel` is logged both ways), and quiet hours alone never
raise it. With nothing to hear it and unread items waiting, the inbox raises its own row about it.
`phase-console doctor` asks the same probe in its `delivery` row, which reports and does not block.


### Quiet hours on a device

Each subscribed device can carry a daily **quiet window** — *Settings ▸ Notifications ▸ Devices ▸ Quiet
hours*, off until you switch it on (it opens at 22:00–08:00; edit from there). Inside the window
nothing is **pushed** to that device. Everything else still happens: the inbox gets the record, an
open tab gets the event, the notifier runs, webhooks post — the morning finds the night in the bell,
and the delivery ledger reads `quiet` for the device rather than reading as a failure.
**Urgent still gets through** by default (an approval held until morning stops the fleet dead until
morning); untick it on a device that must never buzz at night. Times are on the console's own clock.

**It is the only quiet-hours setting for notifications** (control-tower phase 138, #215). A person's
turn's reminders obey it: one falls due while every device that hears *A phase needs you* is inside its
window, and it waits for the first of them to end; a reminder is never urgent, so it never breaks
through. A device with no window — or no device at all — is always awake, and a reminder goes out when
it is due. The reminders' own quiet hours, the `reminderQuiet` preference of earlier versions, are
gone: a config that still holds one has it moved, once, at boot, onto every device with no window of
its own (a device with its own keeps it), and the key is removed (`push.quiet-migrated` in the log). A
page from before the change that still sends it is treated the same way, and nothing stores it again.

Not the scheduler's *Quiet hours* in `docs/controls.md` — those stop phases **boarding**; these stop
pushes **reaching one device**. The two are independent and the names collide on purpose: both mean
"not now", about different things.

### Answering from the notification itself

Some notifications carry buttons, and pressing one answers without opening anything:

| Button | On | What it does |
|---|---|---|
| **Allow** | Permission needed | Answers the card. The session unblocks where it stands. |
| **Allow** | A phase needs you — a permission item a paired device may grant: low or medium risk at the narrowest scope it offers (control-tower phase 138) | Grants it at that scope — this one call — through the `device` door, as the item's own Grant would: the item settles, the session resumes by itself, and a *Permission granted* push opens Settings ▸ Permissions at the grant. Never on a high or never item: there the first button is the tap that opens the item. |
| **Deny** | Permission needed; a permission item | Answers the card the other way, or denies the item; either way the session is told and finds another way. |
| **Approve** | Gate needs a person, when the gate is a person's to clear (`manual`, or overdue) — never an `ai`/`auto` gate | Records the gate clearance in `gate-status.md` and lets the phase board. |
| **Extend 2 h** | Permission needed — the T-15 and T-5 warning a card sends before it runs out, beside **Allow** | Moves the card's deadline two hours later. Inside the hook call's hour it simply moves; past it the session is told no at the hour and the card stands for twelve hours, and allowing it then resumes the phase with that one call granted once. |
| **I did it** | A phase needs you — an act ("Your turn: …") | Runs the step's proof on the console. A proof that lands marks the step proven and resumes the phase's own session saying what was proven; one that does not land records what it read, and the step waits on. A step that names no proof is proven on your word. |

Android and desktop render them. **iOS ignores the array and shows the notification**, which is the
correct degradation — tapping it opens the item (`#/turn/<id>`) or Your turn (`#/approve` lands there,
below), where the same buttons are. Which of them an item's push carries is the table in *Your turn — a human step on the
phone*, above: only what the `device` door may press.

Three things this deliberately cannot do, and the reasons are worth knowing before you rely on it:

- **A button may answer a question; it may never start or kill work.** *Recover*, *Nudge*, *Freeze*
  and *Stop* are never on a notification. A mis-tap on a lock screen should not be able to set a
  session running or tear one down, so those keep the button they have always had: **Open**.
- **The notification carries no address.** What it holds is a signed token naming one inbox item and
  the verbs the console offered for it. The service worker posts that token to one fixed route and
  the console decides what it means — so a payload can never become a general request generator
  sitting in your notification shade.
- **It expires, and it is spendable once.** Twelve hours, and a second press answers `already
  answered` rather than trying again. An expired or already-cleared item opens the console instead,
  which is exactly what every button did before this existed.

A relayed question carries no buttons: a button may allow or deny, never choose one of several
labels, so its answer is a tap on Your turn (`#/approve` lands there), where its options are cards.


### `#/approve` — the whole queue, thumb-sized: now Your turn

`https://your-console/#/approve` — the address every push linked to until 6.2, and the one bookmarks
hold — and `#/approve?step=<id>` land in one hop on **Your turn**: `#/turn`, and `#/turn/<id>` for one item
(control-tower phase 137). That page is the phone's whole queue: one column of cards under *Do now*, *Needs
one detail from you*, *Coming up*, *Being checked*, *Done* and *Handled by the AI*, each item with why only
you, its guide as steps and its ONE primary action, in buttons big enough to hit. Bookmark `#/turn`, or reach
it from any notification.

A `Session waiting on you` is an item like the rest. A lane of the autopilot that the console can place on a
plan and phase carries **Answer it**, and your words reach that lane's session as an instruction for the
rest of the phase (behind `--allow-run`). A session stopped at its own terminal prompt has no action — the
console genuinely cannot answer for it — and its card says so: you answer it where it runs.

Where the action carries your words — evidence on a gate, a reason on a permission card, the answer to a
lane — the card has a text field, and on Chrome and Safari a **microphone button** beside it that dictates
into it. Firefox has no speech API, so there is no button there rather than a dead one. Dictation fills the
field; it never presses the button.

## Step 7 · Alerts with no browser involved at all *(optional)*

Push still needs a browser somewhere, even a closed one. For a machine where that is not true — a
headless box, a pager, a chat channel — point a notifier at a script. It is run as
`your-script "<title>" "<body>"` whenever a run needs a person:

```bash
#!/bin/sh
# ~/.local/bin/phase-notify
curl -s -H "Title: $1" -d "$2" https://ntfy.sh/your-private-topic-name >/dev/null
```

Set it once for every console in the machine profile, or for one shell with the environment variable,
which wins over the file:

```bash
chmod +x ~/.local/bin/phase-notify
node viewer/shared/instances.mjs profile-set notifyCommand '"/absolute/path/to/phase-notify"'   # every console
export PHASE_CONSOLE_NOTIFY=~/.local/bin/phase-notify                                            # this shell only
```

[ntfy](https://ntfy.sh) is the shortest path — install its app, subscribe to the topic. Pushover,
Slack or a webhook of your own work the same way.

> **This sends plan names and approval details to whatever service you choose.** Pick a topic name
> nobody will guess, and if the work is sensitive, [self-host ntfy](https://docs.ntfy.sh/install/) or
> point the script somewhere you control. Both places are out of a web page's reach on purpose: the
> environment, and a file no route writes — so nothing reachable from a browser gets to choose which
> command runs.



## What is actually enforced

Once a console has a hostname — `--remote`, or `remoteHost` from the profile — strict `Host` checking
turns on, and every request is judged by this table:

| Request | Verdict |
|---|---|
| Loopback `Host`, no identity header | **Served.** You, at this machine — unchanged from before. |
| Your remote hostname + an allowlisted login | **Served.** You, through the proxy. |
| Your remote hostname, no identity header | **403.** Something reached the console without going through the proxy. |
| Your remote hostname, a login not on the list | **403.** Someone else on your network. |
| Any other `Host` | **421.** This is what a DNS-rebinding page arrives with. |
| Loopback `Host` **carrying** an identity header | **421.** See below. |

That last row is doing real work and is worth understanding. Anyone on your private network can put
whatever they like in a `Host` header — including `127.0.0.1`. If a loopback `Host` alone meant
"local", such a request would skip the identity check entirely. It cannot: the proxy sets the
identity header on everything it forwards, so a loopback `Host` arriving *with* one is a combination
no honest client produces.

The other half of the assumption is that a caller cannot simply claim to be you. Serve **overwrites**
`Tailscale-User-Login` with the authenticated identity rather than passing through whatever the
client sent — worth knowing rather than assuming, and easy to confirm on your own setup:

```bash
# sent with a forged identity, through the proxy — served, because the proxy replaced it
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Tailscale-User-Login: mallory@example.com' https://your-machine.your-tailnet.ts.net/api/state
```

A `200` means the header you sent never reached the console. A `403` would mean it did, and that the
only thing standing between you and impersonation is the attacker not knowing which login to claim.

You can check the rest of it from the machine, without a phone:

```bash
C=http://127.0.0.1:4123
H=your-machine.your-tailnet.ts.net
curl -s -o /dev/null -w '%{http_code}\n' $C/api/state                                        # 200
curl -s -o /dev/null -w '%{http_code}\n' -H "Host: evil.example"  $C/api/state               # 421
curl -s -o /dev/null -w '%{http_code}\n' -H "Host: $H"            $C/api/state               # 403
curl -s -o /dev/null -w '%{http_code}\n' -H "Host: $H" -H "Tailscale-User-Login: you@example.com" $C/api/state   # 200
```

Use `curl`, not a `fetch()` in a browser console — `Host` is a forbidden header name there, so it is
dropped silently and every case will look like a pass.


## Locking it down further *(optional)*

Serve obeys your access rules like anything else on the tailnet. If more than one person or machine
is on yours, scope it. In the [access controls](https://login.tailscale.com/admin/acls):

```jsonc
{
  "grants": [
    { "src": ["autogroup:owner"], "dst": ["autogroup:self"], "ip": ["tcp:443"] }
  ]
}
```

It is also worth removing machines you no longer use. They are the only devices that could reach the
console at all.

## What not to do

- **Do not use `--host 0.0.0.0` instead of this.** It puts the console — which with `--allow-run`
  starts agent sessions that edit your repository — on every network you join, with no
  authentication whatsoever. It also breaks the approval hook: the address the child sessions call
  back on is derived from the bind address, and that hook **fails open**, so the ask-list would stop
  working *silently* and every session would run on the deny rules alone.
- **Do not use `tailscale funnel`.** Funnel is Serve's public sibling: it publishes to the entire
  internet. Everything above depends on the caller being someone your network already vouched for.
- **Do not skip HTTPS.** Plain HTTP to a hostname is not a [secure context], so notifications are
  unavailable and the Home Screen install is degraded. The tunnel is encrypted either way — this is
  about what the browser will let the page do.

## When it does not work

| Symptom | Cause |
|---|---|
| The name does not resolve on the phone | MagicDNS off in the admin console, or **"Use Tailscale DNS"** off in the phone's Tailscale app. |
| `tailscale serve` prints *"Serve is not enabled on your tailnet"* and never returns | Serve is a tailnet capability that is off until someone approves it. Open the link the command printed — it is specific to that machine — and approve it. The command is waiting for exactly that and will continue on its own; do not kill it. |
| `tailscale serve` errors about certificates | HTTPS Certificates not enabled. Step 1. |
| **403** — *"No caller identity"* | You reached the console directly rather than through Serve, or Serve is not running. Check `tailscale serve status`. |
| **403** — *"… is not allowed to use this console"* | The login is real but not in `--remote-user` (or, with no flag, the profile's `remoteUsers`). |
| **421** — *"does not answer to …"* | The hostname you opened is not the one you passed to `--remote` (or, with no flag, the profile's `remoteHost`). They must match exactly. |
| **421** — *"arrived through a proxy but asks for a local hostname"* | Something rewrote the `Host` header to `localhost`. Serve does not; a proxy in between might. |
| The console will not start | `--remote` with no allowed login from `--remote-user`, the environment or the profile. The error says so. |
| The console starts local-only although the profile names a host | Remote access is inherited only as a pair: the profile has `remoteHost` and no `remoteUsers` (or the reverse), and no flag supplies the other half. |
| A *delivery-channel* issue says announcements are reaching nobody | No subscribed device, no notifier and no webhook — or, under `--remote`, Tailscale stopped or Serve pointing elsewhere. Give the console one channel; the issue withdraws itself. |
| The notification button does nothing on iOS | Not installed to the Home Screen, or you are on plain HTTP. Both are required. |
| **Turn on** is missing and a banner explains why | Permission was refused for this site once. A page cannot ask twice — it has to be changed in browser settings. |
| **Send a test** says it was handed over, and nothing appears | Three separate yeses are involved — the push service, the browser, and the operating system — and only the first answers back. This is almost always the third: macOS *System Settings → Notifications → your browser*, or Windows *Settings → System → Notifications*. A Focus mode does it silently too. |
| **Send a test** says *gone* | The subscription was revoked at the browser end. Turn it off and on again; the register drops dead subscriptions by itself. |
| Push worked, then stopped after reinstalling the app | A reinstall makes a new subscription. The old row is dropped on its next failure; subscribe again from the new install. |
| Worked yesterday, dead after a reboot | `tailscale serve` was run without `--bg`. |
| Worked for weeks, then stopped | The machine's node key expired. Disable key expiry (Step 1). |
| Works on wifi, not on cellular | Tailscale toggled off on the phone, or iOS disabled its VPN profile. |

[ts-serve]: https://tailscale.com/docs/features/tailscale-serve
[secure context]: https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts
[rfc8291]: https://datatracker.ietf.org/doc/html/rfc8291

---

