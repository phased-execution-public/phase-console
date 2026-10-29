# A person's turn — the session's reference

Contents: When to ask a person · The declaration · A deferred step · The reasons · The guide · What the console reads from your closing words · A template per kind ·
The proof and the check · The guard · A permission block · A run request · The answer's road back · What you handled ·
The doors

`references/mode-phase-start.md` states the rule in one paragraph; this file is its detail. A person's turn is an act
only a person can do, declared as a typed record that the console shows on **Your turn** (`#/turn`),
announces once, checks, and answers back to your own session. The words below are the code's:
`shared/turn-model.js` (twin `scripts/turn.env`) owns the reasons, the proof types, the
verdicts, the grant scopes and risk tiers, the page's groups, the handled sources and the guard's exit;
`shared/human-step-model.js` (twin `scripts/human-steps.env`) owns the kinds and their states;
`shared/guide-grammar.js` is the one guide parser; `shared/door-model.js` owns the doors.
`references/conventions.md` §A person's turn is the lifecycle; the console's half is
`server/turn/guard.ts`.

## When to ask a person

Ask only for what you cannot do or may not do. A sign-in that opens a browser, a code sent to the
operator's phone, a secret only they hold, money, terms, a decision the plan left open, a hand at a
device, a system you cannot reach, somebody else's approval, an act a rule reserves for a person —
those are a person's. Everything else is yours: run the command, read the file, make the edit. The
console's guard refuses a declaration whose own guide you could have run (exit 4), and a refusal is
recorded on the page under *Handled by the AI*, so asking for your own work costs a person nothing and
costs you a round trip.

Before you declare, try. If the attempt fails, the failure is your evidence (`--tried`). If a rule
stopped you, that is a permission block, not a step (§A permission block). If the act is done and
only needs proving, the proof already holds and nothing is raised (exit 3).

## The declaration

```bash
bash "$PE_SCRIPTS/phase-outcome.sh" <slug> <N> needs-human --needs <key> --step <kind> --title "<what to do>" \
  --why <reason> --guide <file> [--lang <tag>] \
  [--open-url <https link> | --open-command "<command>"] [--where host|any] \
  [--proof <ref>] [--proof-words "<what proves it>"] [--proof-type probe|answer|judgement|attest] \
  [--effort <minutes>] [--due <ISO> | --due-when <ref>] [--unblocks <phases>] [--window <duration>] \
  [--option <id>=<label>[::<consequence>]]… [--recommended <id>] [--allow-decline] [--decision-key <key>] \
  [--step-line "<step>"]… [--code <device code>] [--credential <id>] [--tried "<what you ran and how it failed>"]
```

Then hand off `in-progress` and stop. `--act` is `--step operator-act`. An act only the RUN can
take is no step at all — §A run request. The flags:

| Flag | What it says |
|---|---|
| `--step KIND` | one of the eighteen kinds (§A template per kind) |
| `--title TEXT` | what to do, as one line a person reads first |
| `--why REASON` | why only a person fits it (§The reasons); absent, the kind's default, marked inferred |
| `--guide FILE` · `--lang TAG` | the full guide (§The guide) and its language (`en`, `fa`, `pt-BR`) |
| `--open-url URL` · `--open-command CMD` | what the item's first button opens: an `http`/`https` link, or a command for the terminal |
| `--where host\|any` | at the machine, or any device; the kind's default when absent |
| `--proof REF` · `--proof-words TEXT` · `--proof-type TYPE` | how it is proven (§The proof and the check) |
| `--effort MIN` | how long it takes the person (`5`, `5m`, `1h`) |
| `--due ISO` · `--due-when REF` | not yet: the item is *Coming up* until then (`--due ISO` is `--due-when date:ISO`) |
| `--unblocks PHASES` | the phases it unblocks (`12,13` or `slug/N`) |
| `--window DURATION` | how long it may wait (`90m`, `2h`, `3d`; at most 7 days) |
| `--option ID=LABEL[::CONSEQUENCE]` · `--recommended ID` · `--allow-decline` · `--decision-key KEY` | a decision's choices, the one you recommend, whether *Not doing this* is offered, and the `## Decisions` row the answer is written to |
| `--step-line TEXT` · `--code CODE` · `--credential ID` | a numbered line (the guide supersedes it), a device code (`device-code` only), the registry id a `secret-entry` stores under |
| `--tried TEXT` | what you ran and how it failed — the answer to a G4 refusal |

The exits: **0** recorded; **2** malformed, or refused by a rule of the door (a reason the kind does
not allow, no proof, a secret in a value, a guide over its limits) — nothing written, and the value
never echoed; **3** the proof already holds — nothing was raised, carry on with the phase; **4** the
guard refused (G4 or G5): you can do this yourself, or nothing refused it — run it.

A plan declares the same act ahead of time on a `- **Human step:**` bullet with `why:`, `effort:`,
`unblocks:` and `guide:` fields (`references/plan-format.md`), asked for at the launch door.

## A deferred step

Under the run setting `humanStepMode: defer` (the default on a CLI at 2.1.306 or later), the
declaration above does not end your turn the way it used to. The console's hook DEFERS the call: it
raises the person's item from your call's own words, and your turn stops at that call with nothing
lost. When the person's check passes, the console resumes THIS session and the same call runs again,
given `--resumed-with "<what was proven or answered>"`. The script then prints that answer, declares
nothing and exits 0. Read it, and carry on from the line after the call, as if the step had taken a
moment. You do not declare again, and you do not stop.

Two things keep the 8.0 shape:
- a call the console cannot read plainly — one statement, the script and its words, nothing computed
  (`$(…)`, `$VAR` outside the script's path), nothing redirected, nothing beside it on the line;
- a run set to `humanStepMode: park`.

Then the call runs, the phase parks, and a resume carries the answer as its instruction. Write the
declaration as one plain call on its own, and the deferred path is the one you get.

## The reasons

Ten, and each kind allows some of them. Three claim that the AI **cannot** (`permission`, `reach`,
`reserved`); the guard judges those (§The guard). The other seven say that only a person **may**, and
are never judged: a sign-in is the person's even when policy would let its command run.

| Reason | The page says | Example |
|---|---|---|
| `permission` | The AI is not allowed | `--step os-permission --why permission --title "Give Terminal Full Disk Access" --proof-words "a terminal can list the Mail folder in the home directory"` |
| `identity` | Only you can sign in | `--step browser-login --why identity --title "Sign the gh CLI in to the acme org" --open-command "gh auth login" --proof 'cmd:"gh auth status"'` |
| `secret` | Only you hold the secret | `--step secret-entry --why secret --credential stripe-test --title "Store the Stripe test key" --proof credential:keychain:phase-console-stripe-test` |
| `money` | It spends money | `--step decision --why money --title "Approve the 40-dollar GPU run" --option run=Run it --option skip=Skip it --recommended skip` |
| `legal` | It accepts terms | `--step decision --why legal --title "Accept the Apple Developer Program licence" --option accept=Accept --allow-decline` |
| `decision` | It is your decision | `--step decision --why decision --title "Which region holds the data?" --option eu=Europe --option us=US --recommended eu --decision-key ambiguity` |
| `physical` | It needs hands at a device | `--step physical --why physical --title "Plug the test phone in and unlock it" --proof-words "adb devices lists one device in state device"` |
| `reach` | The AI cannot reach it | `--act --why reach --title "Restart the runner on build-box" --tried "ssh build-box: Permission denied (publickey)" --proof-words "the runner shows online in the CI settings"` |
| `third-party` | Somebody else must approve | `--step third-party-approval --why third-party --title "Ask the org owner to approve the GitHub App" --open-url https://github.com/organizations/acme/settings/installations --proof-words "the app is installed for acme"` |
| `reserved` | A rule reserves it for a person | `--step protected-path --why reserved --title "Add the hook to .claude/settings.json by hand" --proof 'cmd:"grep -q session-hook /path/to/repo/.claude/settings.json"'` |

## The guide

The guide is what a person reads to act, so write it for someone who has not seen your session: why
it matters, then the steps, then what to do when one fails. One file, in the grammar of
`shared/guide-grammar.js`:

````markdown
Signing in lets the run push its branch to the acme org.

## Steps
1. Run the sign-in and choose the acme org.
   ```sh
   gh auth login
   ```
   Expect: a browser opens on GitHub's device page.
   Warning: do not sign in as a bot account.
   Link: [GitHub device login](https://github.com/login/device)
2. Check that the org is listed.
   ```sh
   gh auth status
   ```

## If it goes wrong
- The browser never opens — open the link yourself and type the code the terminal shows.
````

A paragraph first (the why), then `## Steps` with numbered steps — each with an optional fenced
command, `Expect:`, `Warning:` and `Link:` — then `## If it goes wrong`, one `symptom — fix` bullet a
line. At most 20 steps and 24 KB; `http` and `https` links only; every line passes the secret screen,
and a refusal names the line, never the value. The page draws each command with *Copy* and *Copy for
Claude Code* (which puts `!` in front) and never runs one.

**A plan writes its guide the same way, for the console to read** (turn-by-turn phase 2). A plan's
`- **Human step:**` bullet names the file with `guide: <path under the docs root>` (a plan's
guides usually live under `docs/handoffs/<slug>/guides/`); the console reads it at the launch door and
again on every read of Your turn, so an edit flows to the card. A path that is not a file fails the
lint (F42 `guide-file-missing`, a gate); a file the grammar refuses — a secret-shaped line, a link that is not http(s), a symlink
that leads out of the docs root, more than 24 KB — costs the item its guide, never the item. A plan
that keeps its steps in an `## Operator errands` table instead ends the bullet's text with the row's
id, `(E-4)`, and the console builds the guide from that row: each `` `! cmd` `` a command step, the
prose around them steps in their own words, a `<placeholder>` command marked to fill in. A decision
bullet says its choices itself: `options: box=The build box::it runs all night | cloud=The cloud
runner · recommended: box`. And `deadline: 2026-10-20T17:00Z` says when it must be done by — an end,
where `due:` is when it starts. Two advisories keep a plan honest about its guides, and neither
gates: a task or decision bullet with no `guide:`, no `options:` and no bound table row (F41
`human-step-no-guide` — the person would get a title and no steps), and a table row no bullet names
(F43 `errand-row-unbound` — the console shows it as a Heads-up that nothing checks or waits on).
`references/plan-format.md` has the grammar.

**Write the guide in the language the plan names**: a `**Guide language:**` line in its §Session
budget (`fa`, `en`, …), else English, and pass that tag as `--lang`. A right-to-left guide is drawn
right to left with its commands, refs and numbers left to right; your `--title` and the console's own
words stay as they are.

**A wizard is a guide too** (measured-console phase 29). A plan bullet's `guide:` may name a wizard
script in the shape of mattpocock's wizard template — a `run_wizard` of `stage "<name>"` blocks
of `say`/`step`, `open_url`, `ask`/`ask_secret`, `write_env`, `set_secret`/`set_var` and `confirm`.
The console reads it as a Task guide: a first step that runs the wizard (`bash <path>`), then one step
per stage, "Stage 2 of 3 · <name>", carrying its commands (`open <url>`, `gh secret set <NAME>`, `gh
variable set <NAME>`). A secret is said by **where it goes** — the env file the wizard writes, the
repository's GitHub secret (`gh secret set` asks for it hidden), else the login keychain (`security
add-generic-password … -w`) — with a warning to enter it only at a hidden prompt. Nothing on the card
takes a value, and a secret-shaped line in the script is refused by its line number.

## What the console reads from your closing words

Ending a turn on a question is not asking one — but the console reads your last message when you
declare no outcome, so a question left there still reaches a person, once (measured-console phase 29):

- **Prose questions.** When your final message ENDS on questions — walking back from the last line,
  every line a question (its words end in `?`), a lettered choice (`A) …`), a recommendation
  (`Recommended: …`, `I recommend …`) or blank, until the first other line or a code fence — the
  console raises ONE Decision item carrying them, each with the answer you recommended, and parks the
  phase on it; the same session resumes with the answer (journalled `phase.prose-question`). One
  question with lettered choices offers those choices, the `(recommended)` one marked; otherwise the
  options are *Go with the recommended answers* and *Answer them myself*. Closing courtesy ("Let me
  know if …?") is not a question. Declaring `needs-human --step decision` yourself is still the
  better road: you name the options and the proof.
- **gstack at its gate.** A last `GSTACK_RESULT: skill=<s> status=gate_pending run=<dir>` line is a
  run stopped at its gate. With an absolute `run=` whose `decisions.jsonl` holds a row `kind:
  "approval", status: "pending"` of the newest `gate_rev`, the first such row is an **Approval**, each
  option in `gate.json`'s words, the recommended one marked; with none readable, a **Decision** on the
  gate (*Take every recommendation*, recommended, or *Walk me through each item*). Either way the
  console never approves for the owner: the answer comes back to you, and you relay it through
  gstack's own `answer` command, by `agent:<id>`, in the owner's words. The next pending approval
  rises when you end again (journalled `phase.pack-item`).
- **A questionnaire's shape** (`to-questionnaire`): `### <question>` sections whose lettered choices
  become a Decision's options, the `(recommended)` one marked.

## A template per kind

The first reason is the kind's default. `where` is the kind's default place (`host` — at the machine
the console runs on; `any` — any device).

| Kind | Reasons | Where | Opens with | The proof that fits |
|---|---|---|---|---|
| `browser-login` | `identity`, `secret` | host | `--open-command "gh auth login"` | `cmd:"gh auth status"` |
| `device-code` | `identity` | any | `--open-url <the verification page> --code <code>` | `cmd:` the tool's own status |
| `one-time-code` | `identity`, `secret` | host | `--open-command` the prompt that waits for it | `cmd:` the tool's own status |
| `secret-entry` | `secret`, `identity`, `money` | any | `--credential <id>` — the person stores it, never you | `credential:<id>` |
| `claude-login` | `identity` | host | `--open-command "claude auth login"` | `credential:claude` |
| `mcp-login` | `identity`, `secret` | host | the server's sign-in in an interactive session (`/mcp`) | `--proof-words` naming the server connected |
| `os-prompt` | `physical`, `identity`, `secret` | host | a guide pointing at the dialog | `cmd:` that passes once it is accepted |
| `os-permission` | `physical`, `permission` | host | `--open-command "open x-apple.systempreferences:…"` | `cmd:` the permission makes pass |
| `third-party-approval` | `third-party`, `decision` | any | `--open-url` the request's page | `gh:` or `cmd:` that reads it, else `--proof-words` |
| `physical` | `physical` | host | a guide | `--proof-words`, or `cmd:` that sees the device |
| `person-check` | `decision`, `reserved` | any | a guide of what to look at | the answer |
| `decision` | `decision`, `money`, `legal`, `reserved` | any | `--option`… `--recommended` `--allow-decline` `--decision-key` | the answer |
| `protected-path` | `reserved`, `permission` | host | a guide naming the path and the edit | `cmd:` that reads the edit |
| `interactive-prompt` | `identity`, `secret`, `decision`, `physical` | host | `--open-command` the interactive command | `cmd:` its result |
| `captcha` | `identity` | any | `--open-url` the page | `--proof-words` |
| `email-link` | `identity`, `reach` | any | a guide naming the mail to find | `cmd:` that reads the result |
| `operator-act` | `reserved`, `permission`, `identity`, `secret`, `money`, `legal`, `decision`, `physical`, `reach`, `third-party` | host | `--act` with `--open-command` or `--open-url` and `--due-when` | `cmd:`, `gh:` or `unit:` |
| `permission` | `permission` | any | raised by the console from `blocked --needs permission` (§A permission block) | a grant |

## The proof and the check

Five proof types: `probe` — a watch ref the console reads (`cmd:`, `gh:`, `unit:`, `credential:<id>`
— `gh`, `claude`, `env:NAME`, `keychain:SERVICE`, `file:PATH`, read by presence, never by value);
`answer` — the answer is the result (a decision, a person-check); `judgement` — words a short
read-only checking session reads the person's evidence against (`--proof-words`); `attest` — the
person's word, taken only when you name it; `grant` — a permission item, ended by a grant. Unnamed, the
type follows from what you gave: a permission item is `grant`, a `--proof` is `probe`, a decision or a
person-check is `answer`, `--proof-words` alone is `judgement`. A step needs a proof unless its answer
is the result (G2); `--proof-type probe` needs `--proof`, `judgement` needs `--proof-words`.

Name the proof you would check yourself. When the person presses *I've done this — check*, the console
reads a probe at once; words are read by the checking session for that one item. The verdict is
`passed`, `rejected` (with exactly what to redo — the item goes back to the person, and you are not
resumed) or `needs-info`. Only a probe, the checker of that item and the owner's *Accept anyway* write a
verdict: no session, yours included, can mark an item passed. Three rejections end with the person's
choice — a rewritten guide, *I can't*, or *Accept anyway* (recorded as unverified).

Three more readings of a check (one-pool phase 13). **A decision with options is answered by *Send my
decision*** (#368, #367): the answer is sent, then checked against the item's proof, whatever its type —
the card has no separate check button. **An item whose proof reads a gate's row closes when that gate
opens** (#371): its last step says "Approve the gate on Phase N — the item closes when the gate opens",
and only the gate's Approve opens it, never an answer or a note. **A proof that cannot run is not a
rejection** (#374): a `cmd:` ref whose script is missing from the console's checkout, or not executable,
exits 126 or 127 and reads `unrunnable` — the card says **Cannot run**, "the proof itself cannot run —
<script> does not exist on the console's checkout; exit 127" — and it is polled again, because the
script may land; the person is not sent to redo anything. A script that lives only on the run branch is
the usual cause, which the lint names at plan time (**F46** `proof-script-run-branch-only`), beside a
proof the check reader would refuse every time (**F45** `proof-unparsable`). Both read the ref the way
the check does: `shared/proof-words.js` `cmdOfRef`, and its bash twin `scripts/cmd-ref.sh`.

## The guard

Seven rules, run at the declaration's pre-check and again when the console takes it in:

| Rule | What it refuses | Exit | How to answer it |
|---|---|---|---|
| G1 | a reason the kind does not allow, or no reason from the ten | 2 | name one the kind allows, or none (the default is taken, marked inferred) |
| G2 | a step with no proof, unless its answer is the result | 2 | give `--proof`, `--proof-words`, or `--proof-type attest` |
| G3 | nothing — a proof that already holds raises no item | 3 | carry on: the act is done |
| G4 | a declared `permission` or `reserved` reason whose every guide command this run's own policy allows; a declared `reach` with no `--tried` | 4 | run the commands it names; if one fails, declare again with `--tried` — accepted, and marked overruled by evidence |
| G5 | a permission block that cites no wall this console recorded for your lane: "nothing refused this — run it" | 4 | run the command; if it is refused, the refusal is recorded and the same declaration raises an item |
| G6 | a secret in any value, a guide line included | 2 | say where the person types or stores it, never the value |
| G7 | nothing — the same item from another lane joins it as one more waiter (never an `operator-act`: two phases' acts are two items, turn-by-turn phase 7) | 0 | wait: every waiter is resumed when it is proven |

A command a RULE stops (the deny wall, or an ask with nobody to answer it) does not refuse the
declaration: the item is re-shaped as a `permission` item naming the wall. A guide with no command is
never refused by G4. A G4 or G5 refusal is a row under *Handled by the AI*.

## A permission block

A tool you were refused is a decision, not a failure: never route around it, and never press the
console yourself. When the phase cannot go on without it, declare the wall you met:

```bash
bash "$PE_SCRIPTS/phase-outcome.sh" <slug> <N> blocked --needs permission \
  --rule "Bash(gh release create:*)" --command "gh release create v1.2.0" --reason "<why the phase needs it>"
```

The console raises ONE `permission` item when the declaration cites a wall it recorded for your lane —
a deny rule or a guard of its own hook, or the CLI's own refusal (a tool outside the allow list, an MCP
tool this run was not given, the CLI's copy of a deny rule); a refused landing push reads as a
capability that is off. One that cites nothing recorded is refused (G5, exit 4). The item says "raised
because the AI lacks permission to …", with your command, your phase, your `--reason`, the wall and its
risk tier. The person answers it one of three ways: *Grant*, at a scope — `call` (this one call, spent
on use), `phase` (until your phase settles, 24 hours at most), `plan`, `repository` or `always`; *Deny*;
or *I'll do it myself*. Below plan scope the grant covers exactly your lane, the rule it names and,
for `call`, the one call. A forced or deleting push, the host commands (`sudo`, `shutdown`, `reboot`,
`mkfs`, `dd`), a protected path, a secret's value, the console's own guard, a missing credential, a
sandbox or network wall and Claude Code's own classifier are the never list: no grant exists through
any door, so do not declare blocked on one expecting a grant — say what remains instead.


## A run request

An act only the RUN can take — relaunch it isolated, move it to another account, raise its budget, stop
it, hold it — is never a person's permission: a session cannot press its own console (`console-forge`),
so a permission ask for one reaches nobody. Declare it, hand off `in-progress`, and stop:

```
bash "$PE_SCRIPTS/phase-outcome.sh" <slug> <N> blocked --needs run --run-act <act> --reason "<why the run must>"
```

`--run-act` is one of `RUN_ACTS` (`scripts/turn.env`; owner `shared/verb-model.js`): `isolate`
(a checkout of its own at the next boundary), `switch-account` (the account with the most headroom, at
the boundary), `raise-budget` (the phase's dollar budget — money, so always a person's), `stop`, `hold`.
`--needs run` without it, `--run-act` anywhere else, or an act not on the list is exit 2. The runner
journals `run.run-requested` once per declaration and the item is ONE approval per run and act, every
phase that asked a waiter on it: *Approve* takes the act through the run verb of its name (a raise names
its dollars in the note), *Deny* resumes every waiter told no. In Pro the supervisor's `run-requested`
remedy presses `isolate` and `hold` itself (logged under *Handled by the AI*), suggests `switch-account`
and leaves `raise-budget` and `stop` to the person. A plan that already asks with `--needs
permission.policy` and no rule or command, on a shared checkout whose lane is not on `pe/<slug>`, is
read as `--run-act isolate` — the compatibility rule — and G5 never refuses it.
## The answer's road back

You are resumed once, in your own session, with the console's sentence — never the person's raw
words as an instruction:

- a check that passed — what was proven and what the check read;
- an answer — "The operator answered `<option>`: <note>";
- a decline — "The operator declined: <reason>. Do not ask again; …";
- a grant — "The operator granted `<rule>` for <scope> until <end> — run it again";
- a denial — "denied — do not retry; find another way inside the plan or say what remains";
- *I'll do it myself* — resumed when the person's own act is proven.

A question the person asked about the item rides with the answer: answer it in your work or your
handoff. A decision declared with `--decision-key <key>` has its answer written to the plan's
`## Decisions` table (through `decisions.sh`) before you are resumed, so the next phase reads it
there. A rejected check resumes nobody: the item is the person's again.

## What you handled

When you met a wall and got past it within your rights, or did yourself what you might have asked a
person for, say so — it is how a person learns what the AI did instead of asking:

```bash
bash "$PE_SCRIPTS/phase-outcome.sh" <slug> <N> handled --what "Signed npm in from the stored token instead of asking" \
  [--note "<more>"] [--link commit:<sha>]…
```

One row under *Handled by the AI*; never an outcome, and it never ends your turn. A link is a commit, a
pull request, an issue or a journal line (`commit:<sha>`, a GitHub URL, `pr:[owner/name]#<n>`,
`issue:[owner/name]#<n>`, `#<n>`, `journal:<slug>/<runId>#<line>`), at most eight; every field passes
the secret screen. Your rows go to the sessions' own file (`$PE_HANDLED_FILE`, else
`handled-sessions.ndjson`), and each reads as a session's whatever it claims: a session never speaks as
the guard, the rule table, the relay or the supervisor.

## The doors

Every press reaches the console through one door, decided by what the request can prove, never by what
its body says (`by` is only a label). Yours is `session`.

| Door | Who | What it may press |
|---|---|---|
| `owner` | an owner key verified in this browser | everything grantable; a high-risk press needs the key touched within five minutes |
| `device` | a paired device, a person the `--remote` proxy vouched for, a signed lock-screen action | low and medium grants at `call` or `phase`; answers; declines |
| `local` | a script, the CLI, an unenrolled browser, any process | reads, open, snooze, check, ask, attach, *I can't*; declines; revoke; and, with an owner key enrolled, a request for anything else |
| `session` | your run or message token | raise, declare, record what it handled — no authority verb |
| `supervisor` | the supervisor's pass and its chat | read, raise, order a re-check — no authority verb |
| `checker` | a checking session | the verdict of its own item |
| `console` | the console's own clocks | probes, withdrawals, timers |

The authority verbs are `grant`, `answer`, `decline`, `attest`, `override`, `policy-widen`,
`profile-raise`, `gate-approve`, `plan-approve`, `capability`, `owner-key` and `trust`. With no owner
key enrolled, `local` presses what it always could; with one, a press through a door that may not make
it is a request the owner confirms on the item. Whatever the plan's own manifest already allows is
carried out through any door but `checker` and `console` — except `override`, `owner-key` and `grant`,
which no manifest hands to anybody.

Your door presses no authority verb in either mode, and the hook enforces it before the CLI does:
`console-forge` denies a supervised session's call to any route or verb in `AUTHORITY_ROUTES` — through
`curl`, the CLI, a script you wrote or a payload the shell cannot read — and any write under the
console's state directory. The one door through is your plan's `permission.destructive` row naming the
press for your phase, as `Bash(phase-console <verb>:*)` or `Console(<press>)`
(`references/console-surface.md`).
