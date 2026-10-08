## Two layers, and they are not equally strong

The difference matters most on the night the console falls over. One layer is enforced inside Claude
Code with no network involved; the other is an HTTP call to this console, and a call that cannot be
made does not stop anything.

## The deny list holds

Enforced inside Claude Code itself. **Measured still blocking with the console unreachable.**

`git push`, `terraform apply`, `terraform destroy`, `sudo`, publishing a package, `kubectl delete`.

An approval card cannot get past these at run time, and neither can auto-grant. A person can lower a
deny rule only with a **grant**: one press on a permission item, with a scope and an end — a time limit,
or your revoke (see **Grants**, below). The rules on the never list have no grant at all. Add your own in
`~/.config/phase-console/autopilot.json`, or from **Settings** — your rules merge on top of the
defaults, and shipped defaults can be struck by name (each list has ↩ and **Restore defaults** as
the ways back). Striking a shipped **deny** rule is the one edit Settings confirms first: it widens
what every future run may do, with this console dead included.

## The approval hook does not

It is an HTTP call to this console, and Claude Code treats a call it cannot make as a **non-blocking**
error. Measured: with nothing listening, the tool ran.

So approvals are **workflow**, not safety. They let you decide from a phone; they are not what stands
between an agent and a deploy.

> This is why anything genuinely irreversible belongs in the **deny** list rather than the ask list,
> and why the guide says so here rather than burying it.

## The three lists

| List | Enforced by | Behaviour |
|---|---|---|
| `deny` | The CLI | Never runs, whatever an approval card says. The wall — editable in Settings, behind its one confirm, and lowered only by a grant. |
| `ask` | The HTTP hook | Raises a card and waits. **Fails open** if the console is not running. |
| `allow` | The CLI | Runs unasked. The ones *you* add outrank the ask list. |

Evaluation order is **deny → allow-you-wrote → ask → allow**. First match wins, and **specificity is
irrelevant** — a more specific rule does not beat an earlier one.

## When the AI meets a wall

When a session meets a rule it cannot pass, the console records the wall on that session's lane. A wall is
one of these: a deny rule; an ask with nobody there to answer it; a tool outside the allow list; an MCP
tool the plan was not given; a capability flag that is off; a missing credential; the console's own guard;
a sandbox or network wall; Claude Code's own classifier. The session then declares `blocked --needs
permission` and cites the wall it met.

That raises one **permission** item on Your turn (`#/turn`). It says "Raised because the AI lacks
permission to …" and shows the command, why the phase needs it, and the wall with its rule. Two lanes that
meet the same wall share one item, and every waiting session is resumed when it is answered. A declaration
that cites nothing the console recorded is refused at the door ("nothing refused this — run it", exit 4):
the AI cannot ask for a permission nothing denied.

You answer a permission item in one of three ways:

- **Grant** it, at a scope you choose (next section). The waiting session resumes by itself.
- **I'll do it myself.** The item becomes your own act: its guide is the command, and its *I've done this —
  check* resumes the session.
- **Deny** it. The session is told "denied — do not retry; find another way inside the plan or say what
  remains".

The older cards are this same item, drawn another way, and their **Allow** is a grant too: the approval
card's *Allow* with remember, the widen card's *Allow* (the ladder's offer to strike a rule for the plan)
and a standing card's one-time allow. Nothing else writes a rule on a person's behalf.

## Grants

A grant is one press on a permission item that the console applies itself. It enforces the grant at the
right layer, ends it on time, records it with its cause and can take it back.

The card offers the scopes the item's wall allows as one control, narrowest first. Each says what it covers
and when it ends:

| Scope | What it covers | When it ends | Applied as |
|---|---|---|---|
| *This call* | This one call, once. | When it is used; 24 hours at most. | The console's hook lets that call through. |
| *This phase* | Every call it matches in that phase, in this run. | When the phase settles; 24 hours at most. | The hook, for that lane and that rule only. |
| *This plan* | Every phase of the plan, this run and every later one. | When you revoke it. | An edit to the plan's policy file. |
| *This repository* | Every plan of this console's repository. | When you revoke it. | An edit to the repository layer, which sits between the plan's file and the machine's. |
| *Always* | Every plan on this machine. | When you revoke it. | An edit to the machine's policy file. |

The risk of the chosen scope sits beside **Grant**. It depends on the wall and on the scope. For a rule
that asks, a tool outside the allow list or an MCP tool the plan was not given, *This call* and *This
phase* are low risk, *This plan* and *This repository* are medium, and *Always* is high. Lifting a deny
rule, turning on a capability flag or raising a run's permission profile is high at every scope. The tier
decides what a press takes:

- **low** and **medium** are one press.
- **high** shows what the grant reaches (the runs, plans and phases that gain it, and until when), asks you
  to type the rule back, and on a console with an owner key waits for a touch of the key within the last
  five minutes. With no key the card says so, and the typed rule alone grants it.
- **never** offers no **Grant** at all. The item says why and gives the manual path (see **The never
  list**).

The console's answer wins. The card previews what a grant reaches, and the console replaces the preview
with its own the moment it answers. On a console with an owner key, a press from a door that may not make
it is only recorded: the card says it was asked of the owner, never that it was granted (see **The owner
key**).

**Grant every low-risk ask**, at the top of Your turn, grants every open low-risk ask in one press, each
for this call or this phase and nothing wider. On a phone's lock screen, a low or medium-risk permission
push offers **Allow** and **Deny**; *Allow* grants at the narrowest scope the item offers. A high-risk or
never push offers **Open** and **Deny**, because a risky grant is typed on the page.

What a grant does to the walls, plainly. Below plan scope the console's hook enforces the grant for exactly
that lane, that rule and, for *This call*, that call: never a sibling lane, never after the phase has
settled, never a neighbouring rule. A grant below plan scope also lowers the rule in that run's settings
until the grant ends, and for that long the CLI's own list does not hold the rule with the console dead.
At plan scope and wider the grant is an edit to a policy file, and its row names the file, the list and the
rule. A capability flag is different: it is granted at the machine only, by putting it into the console's
launch unit and restarting when the console is idle, and never from another device.

The waiting session resumes by itself, told `The operator granted <rule> for <scope> until <end> — run
it again`. A hook call it was holding open is answered at no cost, and an open item that a later grant
covers withdraws itself.

Every grant is a row in `grants.ndjson`: who gave it, through which door, the item that asked, the wall, the
rule, the scope, the end, and exactly what it changed. It is journalled (`policy.grant-applied`,
`policy.grant-ended`) and announced in the push category **Permission granted**, which opens Settings ▸
Permissions ▸ Grants at that grant. That page lists every grant with **Revoke** and **Revoke all**, and the
terminal does the same with `phase-console grants list`, `phase-console grants revoke <id>` and
`phase-console grants revoke-all`. A grant ends one of three ways: spent (a call, once used), expired (its
phase settled, or its 24 hours passed) or revoked. A revoke undoes exactly what the row says the grant
changed — a lowered rule is raised again, a struck rule restored, a capability leaves the unit — and
nothing another live grant still holds. Taking authority back needs no owner key.

## The never list

Some walls have no grant, through any door: not the card, not the lock screen, not the CLI, not a phone, not
the owner key. The item says why, and gives the manual path as a guide: the steps, the command to run
yourself if you mean it, and then **I'll do it myself**, which makes it your own act and lets its check
resume the session.

| The wall | Why there is no grant | What you do instead |
|---|---|---|
| The console's own guard | Standing policy that no profile, strike or grant reaches. | Do what the refusal told the session to do instead. If the act must happen, do it yourself in a terminal. |
| A missing credential | A credential is provided, never granted; no session is handed one. | Store it where the item says (it is read by name, never shown), then press **I've done this — check**. |
| A sandbox or network wall | It is the machine's, not this console's; no policy here can lift it. | Run the step yourself where it can reach what it needs, then press **I've done this — check**. |
| Claude Code's own classifier | Claude Code decided, and the console never writes your settings. | Add the rule the item shows to your own Claude Code settings if you want it allowed, or run the step yourself. |
| A forced or deleting push | It rewrites or removes what a remote already holds. | Push it yourself from a terminal if you mean it. The session can push a new branch without force. |
| A host command: `sudo`, `shutdown`, `reboot`, `mkfs`, `dd` | It acts on the machine, not on a repository. | Run it yourself at the machine if it is really needed. |
| A protected path | Claude Code reserves it for an interactive session; no console policy can allow it. | Make the edit by hand, or in an interactive session, and commit it on the run branch; then press **I've done this — check**. |
| A secret's value | A secret's value is never handed to a session. | Store it where the item says. The session reads it by name. |

Lifting the `git push` wall never opens a forced or deleting push. Under a lifted wall a push passes only
in a plain, known shape, and anything else counts as forced: an abbreviated flag such as `--force-w`,
configuration before the verb, a forcing refspec, an option that runs a program, arguments fed by `xargs`,
or any text the shell has yet to expand.

## The owner key

An owner key is a passkey that proves a press is yours. It is optional, and it belongs to one console. With
no key, the console works exactly as it always has: a press from this machine counts as a person's. With a
key, the presses that carry your authority have to come through you.

Enrol it at the machine. `phase-console owner enroll` prints a one-time link, good for ten minutes, that
opens Settings ▸ Permissions ▸ Owner keys (`#/settings/permissions?enrol=<token>`) and enrols a passkey
(WebAuthn, with user verification required). A passkey is bound to a name, never an address: open the
console at `localhost` or at an https host it serves, because an IP address is refused. A console that
already has a key refuses `owner enroll`. A later key, and a removal, happen only inside an owner session,
in this browser or through a link made for another device. Each key is listed with where and when it was
made and last used, and a removal asks once. Every change is journalled, pushed to every subscribed device
and kept in the bell for a week.

**Sign in with the owner key** opens an owner session in that browser. It ends after twelve hours with no
press, or at once when you lock it: **Lock this browser**, **Lock every session**, or `phase-console owner
lock`, which ends every session. A high-risk press needs the key touched again within the last five
minutes (**Touch the key again**). `phase-console owner status` says whether a key is enrolled:
`unenrolled` or `enrolled`; a browser signed in as the owner reads `unlocked`. Settings ▸ Permissions ▸ Owner keys also lists which presses need
the key, read from the same door table the console uses.

Every press reaches the console through one door, decided by what the request can prove and never by what
its body says. A script that claims to be the operator is still `local`.

- `owner`: a browser signed in with the owner key.
- `device`: a person the `--remote` proxy vouched for, or a signed lock-screen action.
- `local`: a script, the CLI, a browser with no key, any process on the machine.
- `session`: a session's own token.
- `checker`: a checking session, for its own item.
- `console`: the console's own clocks, such as probes, withdrawals and timers.


With a key, a press that carries your authority comes through the `owner` door. A `device` may also make a
low or medium-risk grant, answer a card or a decision, and approve a gate or a plan, and every door a
person uses (`owner`, `device` and `local`) may **Deny**, say **I can't** and **Revoke**. A press through
any other door — a script, the CLI, a browser with no key, a phone beyond its low and medium answers, a
session's token — is not applied and not dropped.
It is recorded as a request, shown on its item as `asked by <label> — confirm?`, with **Confirm** and
**Refuse** for the owner, and it is pressed through the owner's door only when the owner confirms it. What
the plan's manifest already allows still executes. A lock-screen **Allow** is the `device` door, and it
never grants a high-risk ask.

A session cannot press its own console. Its HTTP client, and the CLI's authority verbs aimed at a loopback
console, are denied before they run (the guard is called `console-forge`), and so is a write under the
console's state directory.

The key proves who pressed. It does not make your own account safe from itself, and the console says so
plainly:

*a process running as you that deliberately rewrites the console's own files can forge anything below the owner key, and can replace the key registry itself; the console walls the paths a session takes and makes every grant visible, and it is not a boundary against your own account.*

## Auto-grant approvals

By default the console **answers ask-list cards itself**: the ask still happens — the classifier
still says ask, the hook still holds — but the answering hand is the console's, not yours. Each
auto-granted card is recorded in the queue's history, marked *decided by auto-grant* with the ask rule
that matched, and written to the run's journal (`phase.approval-auto-granted`), so the audit trail is
what it always was; only the waiting is gone. Your turn counts them too, under **Handled by the AI**: one
row for each rule in each phase, with a count. The deny list is untouched — auto-grant answers only what
classified `ask` — and a wrapper hiding something the deny list would stop still gets a person.

**Auto-grant never answers the three publishing asks**, `git push`, `gh pr create` and `gh pr merge`:
those stay a card for a person on every scope and every profile. A plan that means to publish unattended
says so in its `## Decisions` table: a `permission.destructive` row with a clause that begins with
`allow` and names the rule — `` deny; allow `Bash(gh pr create:*)` `` — lets auto-grant answer that one
rule for that plan (a row scoped to a phase, for that phase), and every such grant is announced on the
*Permission needed* channel. A console setting cannot carve that exception; only the plan's own manifest
can.

The auto-grant switch has three scopes of its own, and the most specific wins: a **phase** (the launch
dialog's per-phase "More" panel) beats the **plan** (this page, scope "to one plan only") beats
**everywhere** (this page, global scope). Turn it off at any scope and those cards wait for a person
again — the off state is the one worth setting deliberately, since on is the shipped default.
Verification sign-offs ("a check only you can make") and gates are never auto-granted; they are
judgments, not permissions.

## Permission profiles

A profile is the posture a whole run takes, chosen when it starts. **Only the ask list moves; `deny`
is identical in all three.**

| Profile | What it silences |
|---|---|
| **Guarded** | Nothing: the ask list is live, and anything on it stops and raises a card. Deny still refuses. |
| **Trusted** | The ask list — the workflow asks are dropped. Deny still refuses everything on it. For a plan you have already watched run. |
| **Bypass** | The ask list and the CLI's own prompts. Deny is still the wall, but nothing else stops. |

Each label says what it silences and that deny still refuses, because that is the only difference
the policy can deliver. **No profile silences a question.** A call that is a question for a person rather
than a permission — `AskUserQuestion` — is held on all three, right after the deny list. On a run whose
**relay** is armed (`relay: last-resort`, at a CLI of 2.1.268 or later) it goes on the queue for 60 seconds
as a question card — pick an option there or on the phone — and, unanswered, the console answers it at 55
seconds by a relay rule (Settings ▸ Automation ▸ policy answers), else its `(Recommended)` option, else its
first, and tells the session it did (`phase.question-answered`). A multi-select question, one with a
destructive option, one the deny list touches, one raised while the run is stopped, or the same question
twice in a phase is never answered that way: the phase parks for a person. Anywhere else a question is
answered by the plan's `ambiguity` decision (`phase.policy-answered`): by default the session is told to
decide from the plan and record a ruling, and a plan that wants a person there makes the session declare
`needs-human` instead. When the effective ask list is **empty** — every shipped ask rule struck and
none of your own written — Guarded and Trusted are the same posture, and the page says so in an
advisory banner you acknowledge once; it comes back if the rules change. A struck shipped **deny**
rule raises the same kind of banner, since that wall is the one layer that holds with the console
dead. Both are logged once per boot as `policy.advisory`.

`guarded` is the one profile written as an **omission**, so an unrecognised *or absent* profile reads
as guarded. A typo can never grant trust, and a run file written before profiles existed cannot
become trusted because a default moved under it.

## Questions the relay answers

A relayed question leaves a trail. Its answer is journalled as `phase.question-answered` with who
chose it — `human`, `rule`, `recommended` or `first-option` — and written as a ruling in the plan's
ledger. When the console chose, the session is told so in plain terms: the answer, what chose it,
that it is not a change to the phase, and to declare `blocked --needs ambiguity` rather than ask again.

The ruling it leaves in the inbox offers **Remember as a relay rule**: this question, this answer,
kept in `relayRules` with the rest of Settings ▸ Automation ▸ policy answers. From then on that rule
is the console's answer to the same question when its window closes — a person inside the window still
wins. Each phase may put 8 questions through the relay; past that the phase parks for a person
(`budget-spent`), the same way an excluded question does (`phase.question-unanswerable`).

On a run whose relay is **off**, or armed on a CLI below 2.1.268, every session carries
`--permission-prompts none` (Claude Code 2.1.259 or later): anything that would prompt is denied, the
session is told nobody can approve and not to retry, `AskUserQuestion` is removed and elicitations are
cancelled. On an older CLI the flag is left off, and the journal says so once
(`run.permission-prompts-skipped`).

## Cards a restart left behind

A card never survives a restart by pretending to wait. Whatever an earlier console was still asking
comes back **answerable** — a session of that run survived and its hook token was read back — or is
filed `unanswerable`, with the reason that holds:

| Reason | What happened |
|---|---|
| `session-gone` | No session of that run survived the restart, so nothing is left to receive an answer. |
| `token-lost` | A session survived, but its hook token could not be read back from the run's settings file: its later calls arrive unauthorised, and the hook fails open. |
| `asker-gone` | A verification or gate card. The runner that raised it stopped with the console, and the phase raises it again when the run resumes. |
| `reoffered` | A standing offer — the ladder's rule to widen. The healer offers it again on its next pass. |
| `hook-closed` | A relayed question the console could not defer before it stopped. The console answered it at boot, and gives that answer if the session asks again. |

A relayed question the session did defer across the restart is answered by rule as the console comes
back, with the outage counted in its wait.

## Writing a rule

The builder in **Settings** covers the forms people get wrong from memory.

| Form | Builds | Watch out for |
|---|---|---|
| Command prefix | `Bash(git commit:*)` | Matches at a **word boundary** — `Bash(ls:*)` is `Bash(ls *)`, and does not match `lsof`. `:*` only works at the end. |
| Command glob | `Bash(npm run test *)` | Mind the space: `ls *` is not `ls*`. |
| A whole tool | `WebFetch` | As a deny rule this removes the tool from the session entirely. |
| One parameter | `Agent(model:opus)` | One parameter per rule. `Bash(command:…)` looks like this and is **silently ignored**. |
| A path | `Read(~/.ssh/**)` | Only `Read(…)` and `Edit(…)` paths are consulted. `Write(…)`, `NotebookEdit(…)` and `Glob(…)` paths are ignored. A bare name means anywhere: `Read(.env)` is `Read(**/.env)`. |
| A web domain | `WebFetch(domain:*.example.com)` | Covers subdomains, not the bare domain. |
| MCP | `mcp__server` | Covers everything that server exposes; `mcp__server__tool` is one of them. |
| A directory | `Cd(~/code/**)` | `*` is one segment deep; `**` is any depth. |

**Wrappers are seen through** — `timeout time nice nohup stdbuf command builtin noglob` and bare
`xargs`. Some deliberately are not: `watch`, `setsid`, `flock` and `find -exec` never auto-approve,
because what they actually run cannot be seen from the outside, so they get a card.

Settings lists any rule you have written that **parses and does nothing**, rather than leaving you to
discover it at 3am.

## Shells and agent sessions

`--allow-terminal` and `--allow-agent` sit outside everything above, on purpose. They are two flags
over one page (**Sessions**): with neither, the page still lists the lanes and the sessions the
presence hook sees, and starts nothing of its own. A shell is a person
typing — no deny list, no approval hook, no profile; the only policy is whoever is at the keyboard.

An agent session sits in between: the console builds the `claude` command itself from allowlisted
choices (model, effort, permission mode), but once the session is up, approvals happen **in the
terminal**, not in the console's queue.

**Bypass on an agent session exists in exactly one place: a QA review.** A review reads a diff and
runs a phase's tests, and stopping it every few minutes to approve a `git log` is how a review stops
happening. So `permissionProfile` is accepted with a QA launch and refused on every other agent
session — a rule rather than a habit, so the surface cannot drift open later. `trusted` is
deliberately not offered there: it means *no approval card*, and there is no card in a terminal you
are watching.

Neither capability weakens the autopilot's rules. They are different doors into the same machine,
each behind its own flag.

## The push carve-out

`git push` is on the deny wall for every run. The one exception is a run started with the work-branch
and PR-on-completion options: for that run, bare `git push` becomes an approval card and
`gh pr create` stays a card **even under Trusted** — publishing takes one tap, and force-pushes stay
denied outright. Auto-grant never answers either card; only a `permission.destructive` exception in the
plan's manifest lets the console answer one, and that answer is announced. A plan that lands by pull
request (`Land: pr` or `trunk`) pins `gh pr create` and `gh pr merge` the same way: a card for a person
under every profile, while the push itself stays the console's own act, made before the landing session
is boarded.

If the console process dies mid-run, that run's CLI-side deny no longer contains bare `git push` (the
destructive shapes still do) — which is why the carve-out is per-run, never global.
