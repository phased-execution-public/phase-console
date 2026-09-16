## Two layers, and they are not equally strong

The difference matters most on the night the console falls over. One layer is enforced inside Claude
Code with no network involved; the other is an HTTP call to this console, and a call that cannot be
made does not stop anything.

## The deny list holds

Enforced inside Claude Code itself. **Measured still blocking with the console unreachable.**

`git push`, `terraform apply`, `terraform destroy`, `sudo`, publishing a package, `kubectl delete`.

Nothing can approve past these at run time. Add your own in
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
| `deny` | The CLI | Never runs, whatever you click. The wall — editable in Settings, behind its one confirm. |
| `ask` | The HTTP hook | Raises a card and waits. **Fails open** if the console is not running. |
| `allow` | The CLI | Runs unasked. The ones *you* add outrank the ask list. |

Evaluation order is **deny → allow-you-wrote → ask → allow**. First match wins, and **specificity is
irrelevant** — a more specific rule does not beat an earlier one.

## Auto-grant approvals

By default the console **answers ask-list cards itself**: the ask still happens — the classifier
still says ask, the hook still holds — but the answering hand is the console's, not yours. Each
auto-granted card is recorded in the queue's history, marked *decided by auto-grant* with the ask rule
that matched, and written to the run's journal (`phase.approval-auto-granted`), so the audit trail is
what it always was; only the waiting is gone. The deny list is untouched — auto-grant answers only what
classified `ask` — and a wrapper hiding something the deny list would stop still gets a person.

**Auto-grant never answers the two publishing asks**, `git push` and `gh pr create`: those stay a card
for a person on every scope and every profile. A plan that means to publish unattended says so in its
`## Decisions` table: a `permission.destructive` row with a clause that begins with `allow` and names the
rule — `` deny; allow `Bash(gh pr create:*)` `` — lets auto-grant answer that one rule for that plan (a row
scoped to a phase, for that phase), and every such grant is announced on the *Permission needed* channel.
A console setting cannot carve that exception; only the plan's own manifest can.

Three scopes, most specific wins: a **phase** (the launch dialog's per-phase "More" panel) beats the
**plan** (this page, scope "to one plan only") beats **everywhere** (this page, global scope). Turn
it off at any scope and those cards wait for a person again — the off state is the one worth
setting deliberately, since on is the shipped default. Verification sign-offs ("a check only you can
make") and gates are never auto-granted; they are judgments, not permissions.

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
plan's manifest lets the console answer one, and that answer is announced.

If the console process dies mid-run, that run's CLI-side deny no longer contains bare `git push` (the
destructive shapes still do) — which is why the carve-out is per-run, never global.
