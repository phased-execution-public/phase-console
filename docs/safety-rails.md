# Safety rails

Things that stop the system hurting you, all of them mechanical.

**Phase locks.** Starting a phase claims it — a small lock file in your repo recording who holds it,
a lease that auto-expires, and the **scope** it is working in. If a second session finds the phase held
by a live session, it stops and asks rather than building the same phase twice. Locks are committed, so
they work across machines and accounts.

**Scope decides who may run beside you.** What makes two sessions dangerous is a shared *working tree*,
not the mere fact of being two — so the rule is about scope: *never two live sessions whose scopes
intersect; same repo ⇒ serialized; `all` ⇒ exclusive against every unqualified claim; disjoint ⇒ parallel.* Scope comes from the plan's
Repos column, and `phase-lock.sh <slug> conflicts <N> --scope "<csv>"` answers the question across every
plan before you start — a working tree doesn't know which plan asked for it. Every boot prompt states
its phase's scope and the command to check it. A phase that declares nothing counts as `all` and runs
alone; still want to overlap two sessions on one repo? Give each its own checkout or `git worktree`.

**Never stash to hand off.** A `git stash` lives in one working tree and is invisible to every other
session and clone. Commit instead — even a WIP commit. The filesystem of a closed session is not a
channel; git is.

**Verification before handoff.** A phase's own verification commands must be green before it can be
handed off as complete. Red work is handed off as `blocked`, with the failure recorded, so the board
shows the truth.

**Structural validation.** `scripts/validate.sh <slug>` catches malformed graph rows, dependencies on
phases that do not exist, cycles, invalid handoff statuses, missing required sections, and handoffs
whose declared dependencies disagree with the plan. Since 5.0.0 three checks that were advisory fail
it too, each naming itself in the line so a failure can be grepped for: **F14**
`verification-empty-open` (an open phase whose §Verification holds nothing runnable), **F24**
`gate-directive-missing` and `gate-type-unknown` (a `*(GATED)*` heading with no `Gate-check`, or a
directive whose type is not on the list), and **F25** `decision-outstanding-unowned`,
`decision-key-unknown` and `decision-state-unknown` (a `## Decisions` row nobody owes, or a key or
state outside the vocabulary). Run it before trusting a board.

**Explicit-path commits.** Never `git add -A` — a phase commits the files it touched, so unrelated
work in your tree is not swept in.

---


**The one deliberate hole in the push wall.** The console's autopilot hard-denies `git push` for
every session, at two layers (its approvals hook and the CLI-side deny list it writes into each
run's settings). The single exception is a run started with the **work branch + open a PR**
options: for that run — and only that run — bare `git push` moves from the wall to an approval
card, and `gh pr create` stays a card even under the `trusted` profile, so publishing the branch
still takes one human tap — auto-grant never answers either card; only a `permission.destructive`
exception in the plan's manifest lets the console answer one, and that answer is announced.
Force-pushes, `--force-with-lease` and `--delete` stay denied outright.
Residual risk, stated plainly: with the console process dead its hook cannot ask, and that run's
CLI-side deny list no longer contains bare `git push` — the destructive shapes still do.

The carve-out narrows a wall that stands; it never rebuilds one that does not. Since shipped deny
rules became strikeable from Settings (by name, behind a confirm), an operator who struck
`Bash(git push:*)` has made pushing their standing policy — and a PR-run's carve-out will not
quietly re-add the force-push denials on top of a wall they removed. The two asks (`git push`,
`gh pr create`) stay pinned either way: one human tap to publish is about the run's shape, not the
wall.

**The console's own push is a second door, and a narrower one.** `--allow-publish` is the eighth
capability flag, off by default like the other seven, and the only way this console itself ever
reaches a remote: a finished phase's own `pe/*` branch, pushed to `origin` through one seam
(`pushRef` in `runner/worktree.ts`) with one frozen argv — `git push --porcelain --no-follow-tags
origin refs/heads/<ref>:refs/heads/<ref>`. Never a trunk, never `pe/integration`, never with force,
never a delete, never a second try after a non-fast-forward rejection, never a name outside
`^pe/[A-Za-z0-9._-]+(-p\d+)?$` — a ref outside that shape is refused before git is spawned. Two
conditions must both hold, the flag and a `permission.destructive` row in the plan that allows
`git push`; without either the landing parks with `phase.landing-push-refused {reason}` and nothing
reaches the origin. A free console parses the flag and pushes nothing. The wall above stands
untouched: the landing session the console boards afterwards never pushes — the push was the
console's act, and the deny wall still refuses it — and its two acts, `gh pr create` and
`gh pr merge`, are pinned asks under every permission profile, answerable without a person only by
that same `permission.destructive` row.


**Every session carries two caps.** Every `claude -p` the spawn door starts passes `--max-budget-usd`
and `--max-turns`, and its `phase.session` line names the policy that set each. With no
`phaseBudgetUsd` on the run, the phase's size decides — `S` $25 and 150 turns, `M` $60 and 300, `L`
$120 and 600 (`SESSION_CAPS_BY_SIZE`, `viewer/server/runner/session-record.ts`); a side session gets
a quarter of those dollars, never under $1. A cap that bites is not a crash: the same session resumes
under double that cap (`phase.resume {raise}`), so the numbers bound a runaway without cutting a long
phase. What a size buys: [Session budget](session-budget.md) §3.

**The start ceiling.** Every door that starts a `claude` with nobody asking — boot re-adoption, the
wait clock, convergence, the MCP health probe, the automatic reviewer and the rest of `START_DOORS` —
is bounded on its own, and since 5.0.0 their sum is bounded too: at most 40 automatic starts and $250
of reported session spend per sliding hour, per console (`viewer/server/start-ceiling.ts`; the
`ceilingStartsPerHour` and `ceilingUsdPerHour` knobs under Settings ▸ Automation, where `0` switches
one off). A refused start writes `run.start-refused {door, ceiling, limit, count, until}`, and the
announcement goes out once per window. A person's Start, Retry or Continue is never counted and
never refused — a ceiling that could stop an operator starting the run they are looking at would be
the console overruling them. The dollars are what sessions reported: a session whose cost never
arrived charges nothing.

**The relay never answers what it must not.** On a `relay: last-resort` run a question a session
raises (`AskUserQuestion`) is held 60 s for a person and otherwise answered by rule
([Decisions](decisions.md) § The relay). Before any window opens, the relay checks the deny list
first — the call's tool, or a denied command written into an option — and a match never opens a
window. Then, in order: a multi-select question; an option carrying a destructive verb (a force-push,
`reset --hard`, a PR merge, a recursive forced `rm`, a publish, a table or database drop —
`DESTRUCTIVE_OPTION_RE` in `viewer/shared/relay-model.js`); a question raised while the run is halted
or parked; and the same question asked twice in one phase. Past those, a phase may put eight
questions to the relay. Every one of these goes to a person — `phase.question-unanswerable {reason}`,
a `needs-human` park and one push — and the session is told to hand off and declare rather than
guess. `(Recommended)` is written by the session, which is why a destructive option outranks it.

**The permission hook answers this machine only.** `POST /hooks/permission-request`, the relay's
transport, takes the approval hook's credential — the per-run bearer token, compared in constant
time and dead the moment the run ends — and adds the presence hook's rule: a request that did not
arrive on loopback, or that arrived through the `--remote` proxy, is refused 403 before the token is
looked at (`hook.rejected {reason: not loopback | not local}`). A Serve handler pointed at the wrong
console cannot expose a permission-deciding POST.

