## Open Quick start 🟡

Quick start is the one screen that starts a run. Every choice a start could ask of you sits on it — the
model, how much the run may do without asking, the branch, the budget, the accounts — and nearly all of
it stays folded away until you want it. There are no stages to walk through.

You need two things before you open it:

- A plan file under `docs/plans/` in your repository. Ask Claude for one with `/phased-execution`;
  **Concepts** says what a plan is.
- A console started with `--allow-run`. **Launch** lists every way to start one. Without the flag the
  screen still opens, and a banner says **This console cannot start runs**, with the command to restart
  it and a **Copy the command** button.

It opens from three places:

- **Start a run** on a plan’s **Autopilot** tab. After a stop the same button reads **Continue this run**.
  While the run is live it reads **Settings** and opens **Run settings**: the same screen, for changing
  a run that is working.
- **Start** on a phase in the **Ready to start** bay of the Tower.
- **Run only this** on a phase row of the Autopilot tab.

The last two start that one phase alone, and the screen is titled **Run only phase N**. On a desk it is
a dialog; on a phone it is a full-screen sheet. In both, the body scrolls while **Cancel** and the start
button stay fixed at the foot.


## Read its first line 🟡

The top of the screen is one sentence in large type, and it says what the start button will do: which
plan, from which phases, on which model and effort, how much a session may do without asking, and on
which branch. For example: *Runs checkout-rewrite from phase 1, on opus at max effort, trusted, on the
current branch.*

Read it as the contract. If it names the wrong phase or the wrong branch, fix that first; everything
below only refines it. A one-phase launch reads *Runs phase 4 of checkout-rewrite on its own, …*

Under it, a fold called **The plan, its phases and what will hold** opens the plan, the phases that will
run, the gates and claims that will hold them and, under **Before it boards**, what the plan file raises
for each phase before anything starts.

## Clear what holds the button 🟡

Under the first line, banners list what the console already knows, the ones that hold the start button
first. Each carries its own action:

| It says | Press |
|---|---|
| **Launch waits for a decision.** A decision the plan asks for is still open. | **Answer** |
| **Launch waits for the plan’s git lines.** The plan names a git strategy this launch does not honour. | **Choose** |
| **Accounts:**, **MCP servers:** or **Credentials:**, then why that check failed. | **Open** |
| **Nobody will hear this run.** No device, notify command or webhook would tell you it stopped. | **Acknowledge** |
| *N phases will park at boarding.* Nothing runnable in their §Verification. | **Narrow the scope** |
| **Another run holds a tree this plan needs.** | **Give this run its own checkout** |

The first two hold the start button: it stays disabled, and its note names the reason. The others warn;
the run still starts and meets them.

When the plan declares steps only a person can take — a sign-in, a code — a box reads **This run will
need you 2 times**. It shows whether each step’s proof already holds. **Do it now** opens a link step in
a new tab; a command step shows the command to copy. **Check again** re-reads the proofs. Do them now
rather than at three in the morning; **Your turn** covers how each kind works.

## Choose a posture 🟡

A row of presets sets a whole posture in one press. They move only what the run asks of you, where it
stops and how far it recovers alone — never the scope, the model, the branch or a dollar figure.

- **Careful** — you are watching. Commits and installs ask first, anything unclear stops and asks, a
  usage limit pauses, and recovery stops early.
- **Balanced** — what this console ships with: trusted, keeps going where it safely can, and recovers
  by itself.
- **Hands-off** — nobody is watching. A question you do not answer in 60 s is answered by rule, and the
  run tolerates a longer failure streak before it stops.

**Last launch** joins the row when this browser remembers how it last started this plan. The line under
the row names the preset the values match now, or says *Your own mix* when none does. The row appears on
a start, a continue and a one-phase launch; **Run settings** has none.

## Open a tile only to change something 🟡

Below the presets, nine tiles hold everything else. Each tile shows what it is set to as a few badges —
*Work branch*, *Own checkout*, *No run ceiling* — and the word for where most of its values came from:
**from defaults**, **from Settings**, **from the plan**, **from preset**, **from your last launch** or
**from this run**. **changed 2** counts what you edited here. Your defaults live in Settings ▸ Automation;
a launch overrides them for itself only.

| Tile | What it decides |
|---|---|
| **Scope** | Which phases this run drives, and what it waits for before it starts. |
| **Engine** | The model and its effort, whether the model may move, and the per-phase overrides. |
| **Safety** | What a session may do without asking, the CLI permission mode, and how long a card waits. |
| **Git** | The branch it works on, its checkout, and what happens to the branch. |
| **Money and stops** | What it may spend, and every condition that stops it. |
| **Review and QA** | Who reviews the work: a reviewer per phase, the cloud review, and the QA gate. |
| **Tools** | What every session is given: skills and MCP servers. |
| **Accounts** | Who pays, which login each account is right now, and the accounts it may fail over to. |
| **Decisions** | Everything this run could ask a person mid-run, answered before it starts. |


On a desk, **Edit** opens a tile’s controls in place, one tile at a time, and **Done** closes it. A tile
that holds a blocking decision turns amber and its button reads **Answer**. On a phone each tile is a
whole row: a press pushes its controls as a sub-view, and **All settings** brings you back. A one-phase
launch draws fewer tiles, because it asks fewer things.

At the foot, *3 values differ from a fresh console* opens the list, each value with its source and a
**Change** link back to its tile. *Every value this launch sends* lists them all.

## Press Start 🟡

The one solid button at the foot starts the run. It reads **Start** on a fresh run, **Continue** on a
stopped one, **Run phase N** on a single phase and **Apply changes** on **Run settings**. It stays
disabled while a decision or the plan’s git lines are open, and says which. If you would rather not
answer a decision, **Start anyway, recorded as** in the **Decisions** tile is the one way past;
**Runs** explains it.

When you press it the screen closes and the console starts the run. Anything the start found that you
should know — phases that will park at boarding, phases another session holds that this run will queue
behind — arrives as a warning beside the confirmation. This browser then remembers the posture, which is
what **Last launch** offers next time.

## The console boards the phase 🟢

The console checks the phase’s gate and who holds it, waits for a free lane if the console is full, and
starts one fresh session for it. **Runs** follows one phase from boarding to *done*, and says what
verifies it.

Within seconds the run is a strip on the Tower, usually in **Live**. If the phase has to wait for a lane
or for files another run holds, its strip says what it waits on. Nothing more is asked of you yet.

## Watch what it does 🟢

Three places show a working run, from a glance to the full text:

1. **The strip** on the Tower. It shows the run’s word (**Running**), one clock (`running 12m 03s`), how
   many phases are done (`2/5`), what it has cost so far, and the last thing the session did, read from
   its own log.
2. **The Now panel.** Press that last-activity line and the strip opens in place. **Now — phase N** names
   the task in hand, what it waits on, why it is slow if it is, and a rough estimate of the time left.
3. **The console** below the bays: one tab for each working lane, with the session’s text as it writes it.

The strip’s one action is **Pause**, which stops at the next phase boundary. **Runs** has the heavier
verbs: freeze, stop, and asking the session something.

## When it needs you 🟡

A run that needs a person moves to **Needs you** on the Tower, and the header line says so (*1 needs
you*). The console also tells you in the ways **Alerts** describes, so you do not have to be watching.

- **Tower** says where everything is and what each strip’s one button does.
- **Your turn** covers a sign-in, a code or a look only you can do, and doing it from any device.
- **Halts** covers a run that stopped: what kind of stop it is, and which recovery fits.

A session that asks permission appears above the bays as a **Waiting on you** card.
