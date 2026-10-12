## Open the launch 🟡

The launch is the one screen that starts a run. Every choice a start could ask of you sits on it — the
model, how much the run may do without asking, the branch, the budget, the accounts — and nearly all of
it stays folded away until you want it. There are no stages to walk through.

You need two things before you open it:

- A plan file under `docs/plans/` in your repository. Ask Claude for one with `/phased-execution`;
  **Concepts** says what a plan is.
- A console started with `--allow-run`. **Starting up** lists every way to start one. Without the flag
  the screen still opens, and a banner says **This console cannot start runs**, with the command to
  restart it and a **Copy the command** button.

It opens from four places:

- **Start a run** on a plan's **Run** view, titled *Start a run*. After a stop the same button reads
  **Continue this run**. While the run is live it reads **Settings** and opens *Run settings*: the same
  screen, for changing a run that is working.
- **Start phase N**, the one act on a plan's glance when the plan has no run yet.
- **Start** on a phase in the **Ready to start** group on **Runs**.
- **Run only this** on a phase row of a plan's phase table, under **Phases** or in the run's own
  **Phases** fold.

The last two start that one phase alone, and the screen is titled *Run only phase N*. On a desk it is a
dialog; on a phone it is a full-screen sheet. In both, the body scrolls while **Cancel** and the start
button stay fixed at the foot.


## Read its first line 🟡

Under the title, one sentence in large type says what the start button will do: which plan, from which
phases, on which model and effort, how much a session may do without asking, and on which branch. For
example: *Runs checkout-rewrite from phase 1, on opus at max effort, trusted, on the current branch.*

Read it as the contract. If it names the wrong phase or the wrong branch, fix that first; everything
below only refines it. A one-phase launch reads *Runs phase 4 of checkout-rewrite on its own, …*

Under it the route says where the run boards, as stations on a line — *3 done*, *P4*, *P5 gated*, *6 more*
— with *Then whatever those unblock, until the plan ends or a stop condition hits.* A fold called **The
plan, its phases and what will hold** opens the plan, the phases that will run, the gates and claims that
will hold them and, under **Before it boards**, what the plan file raises for each phase before anything
starts.

## Clear what holds the button 🟡

Under the route, what the console already knows comes as lines, worst first, each with its own action:

| It says | Press |
|---|---|
| **Launch waits for a decision.** A decision the plan asks for is still open. | **Answer** |
| **Launch waits for the plan's git lines.** The plan names a git strategy this launch does not honour. | **Choose** |
| **Accounts:**, **MCP servers:** or **Credentials:**, then why that check failed. | **Open** |
| **Nobody will hear this run.** No device, notify command or webhook would tell you it stopped. | **Acknowledge** |
| *N phases will park at boarding.* Nothing runnable in their §Verification. | **Narrow the scope** |
| **Another run holds a tree this plan needs.** | **Give this run its own checkout** |

The first two hold the start button: it stays disabled, and its note names the reason. So does *Reading
this plan's decisions…*, for the moment the console is still reading them. The others warn; the run still
starts and meets them. Advice comes last: *2 phases with something to know before it boards*.

When the plan declares steps only a person can take — a sign-in, a code — a box reads **This run will
need you 2 times**. It shows whether each step's proof already holds. **Do it now** opens a link step in
a new tab, and **Open again** opens it once more; a command step offers **Do it now — copy the command**.
**Check again** re-reads the proofs while a step is left. Do them now rather than at three in the
morning; **Your turn** covers how each kind works.

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
the row describes the preset the values match now, or says *Your own mix — no preset matches every value
below.* The row appears on a start, a continue and a one-phase launch; *Run settings* has none.

## Open a row only to change something 🟡

Below the presets, nine rows hold everything else. Each row shows its name, a few words on what it is set
to — *Work branch*, *Own checkout*, *No run ceiling* — and the word for where most of its values came
from: **from defaults**, **from Settings**, **from the plan**, **from preset**, **from your last launch** or
**from this run**. **changed 2** counts what you edited here. Your defaults live in Settings ▸ Automation;
a launch overrides them for itself only.

| Row | What it decides |
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


**Edit** opens a row's controls in place, under the row, one row at a time and at every width, and
**Done** closes it. A row that holds a blocking decision turns amber and its button reads **Answer**. A
one-phase launch draws fewer rows, because it asks fewer things.

At the foot, *3 values differ from a fresh console* opens the list, each value with its source and a
**Change** link back to its row — or the line says *Every value is what a fresh console ships with.*
**Every value this launch sends** lists them all.

## Press Start 🟡

The one solid button at the foot starts the run. It reads **Start** on a fresh run, **Continue** on a
stopped one, **Run phase N** on a single phase and **Apply changes** on *Run settings*. It stays disabled
while a decision or the plan's git lines are open, and says which. If you would rather not answer a
decision, **Start anyway, recorded as** in the **Decisions** row is the one way past; **A run** explains
it.

When you press it the screen closes and the console starts the run. Anything the start found that you
should know — phases that will park at boarding, phases another session holds that this run will queue
behind — arrives as a warning beside the confirmation. This browser then remembers the posture, which is
what **Last launch** offers next time.

## The console boards the phase 🟢

The console checks the phase's gate and who holds it, waits for a free lane if the console is full, and
starts one fresh session for it. **A run** follows one phase from boarding to *done*, and says what
verifies it.

Within seconds the run is a line on **Runs**, usually under **Running**. If the phase has to wait for a
lane or for files another run holds, its line says what it waits on. Nothing more is asked of you yet.

## Watch what it does 🟢

Three places show a working run, from a glance to the full text:

1. **The line** on Runs. It shows the run's word (**Running**), one clock (`running 12m 03s`), how many
   phases are done (`2/5`), what it has cost so far, and one line on what it is doing.
2. **Phase N now.** Open the line with its chevron and **Phase N now** names the task in hand, what it
   waits on, why it is slow if it is, and a rough estimate of the time left.
3. **The run's own page**, the plan's **Run** view, and its fold **Sessions and their consoles**: one pane
   for each working lane, with the session's text as it writes it.

The line's one action is **Pause**, which stops at the next phase boundary. **A run** has the heavier
verbs: freeze, stop, and asking the session something.

## When it needs you 🟡

A run that needs a person stays where it is, its word turned amber, and the act joins **Your turn** at the
top of **Runs**; the header says so (*1 needs you*, *Your turn (1)*). The console also tells you in the ways
**Alerts** describes, so you do not have to be watching. A session that asks permission is an item there
too, and a row under **Waiting on you** on the run's page.

- **Runs home** says where everything is and what each line's one button does.
- **Your turn** covers a sign-in, a code or a look only you can do, and doing it from any device.
- **Halts** covers a run that stopped: what kind of stop it is, and which recovery fits.
