# A person's turn — the session's reference

Contents: When to ask a person · The declaration · The reasons · The guide · A template per kind ·
The proof and the check · The guard · A permission block · The answer's road back · What you handled ·
The doors

`SKILL.md` Mode 2 states the rule in one paragraph; this file is its detail. A person's turn is an act
only a person can do, declared as a typed record that the console shows on **Your turn** (`#/turn`),
announces once, checks, and answers back to your own session. The words below are the code's:
`viewer/shared/turn-model.js` (twin `scripts/turn.env`) owns the reasons, the proof types, the
verdicts, the grant scopes and risk tiers, the page's groups, the handled sources and the guard's exit;
`viewer/shared/human-step-model.js` (twin `scripts/human-steps.env`) owns the kinds and their states;
`viewer/shared/guide-grammar.js` is the one guide parser; `viewer/shared/door-model.js` owns the doors.
`references/conventions.md` §A person's turn is the lifecycle; the console's half is
`viewer/server/turn/guard.ts`.

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

Then hand off `in-progress` and stop. `--act` is `--step operator-act`. The flags:

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
`viewer/shared/guide-grammar.js`:

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

**Write the guide in the language the plan names**: a `**Guide language:**` line in its §Session
budget (`fa`, `en`, …), else English, and pass that tag as `--lang`. A right-to-left guide is drawn
right to left with its commands, refs and numbers left to right; your `--title` and the console's own
words stay as they are.

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
| G7 | nothing — the same item from another lane joins it as one more waiter | 0 | wait: every waiter is resumed when it is proven |

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
