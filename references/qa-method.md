# QA method — how to verify a phase

> **QA is opt-in (off by default since v3).** This discipline runs only when the plan enables QA —
> `**QA gate:** on` in §Session budget, `new-handoff.sh --qa` at a finish, or a plan that already has a
> `test-status.md`. Check with `scripts/phase-graph.sh <slug> --qa-mode`: `waived` means record rows
> without dispatching anyone; `off` means none of this file applies — the finishing session's own
> §Verification run is the quality bar.
>
> **The console has a second, unrelated reader — don't confuse them.** A run with `reviewEachPhase` on
> dispatches a fresh session over the phase's *diff* at every phase-finish, on any plan, whatever the QA
> gate says (`viewer/server/reviewer.ts`). It is off unless an operator turned it on, it records a
> **review** rather than a QA row, and with `reviewerPolicy: may-hold` its `requested-changes` holds this
> phase's dependents exactly as a person's review would. This file is about the QA verdict; the reviewer
> is `references/console-surface.md` §Run settings.

The goal is a trustworthy **pass/fail** verdict, reached by independent reasoning about the real code,
not by re-running the builder's own happy-path tests. Hold the work to the strongest reasonable reading
of its exit criteria — dependents will build on whatever you wave through.

## 1. Establish the real diff (don't trust the summary)

The handoff's "What this phase did" is the author's claim. Verify it against ground truth:

- **Commits:** read the shas the handoff records and `git show`/`git diff` them. Cross-check with
  `git log --oneline` for the phase's window. If the handoff claims something is committed, confirm it
  is (stale "uncommitted/committed" claims are the #1 handoff defect).
- **Files:** read every path in the handoff `key_files`, plus anything the diff touches that the handoff
  *didn't* mention (omissions are findings too).
- Restate, in your own words, what actually changed and why. If you can't, you haven't read enough.

**Large diffs:** dispatch parallel `Agent` subagents to read slices (by file/subsystem) and return
findings with file:line evidence. You synthesize and own the verdict — never delegate the judgment.

## 2. Investigate the implementation

For each exit criterion in plan §Phase N, decide met / not-met / unverifiable, with evidence. Then sweep
the changed code for:

| Lens | Looking for |
|------|-------------|
| Correctness | logic errors, off-by-one, wrong defaults, mishandled nulls/empties |
| Edge cases | boundaries, empty input, concurrency, retries, partial failure |
| Error handling | swallowed errors, missing validation, silent fallbacks |
| Regressions | broken contracts a sibling phase depends on; changed shared files |
| Security | injection, secrets in code/logs, authz gaps, unsafe deserialization |
| Tests | do the phase's tests actually exercise the criteria, or pass vacuously? |

A test suite that's green but doesn't cover the criteria is a **fail**, not a pass.

## 3. Severity rubric

- **Critical** — data loss, security hole, or the phase's main goal doesn't work. → fail.
- **High** — an exit criterion unmet, or a bug that will bite a dependent phase. → fail.
- **Medium** — real but non-blocking (degraded edge case, weak test). → note; pass allowed if criteria met.
- **Low** — style, minor nit. → note.

## 4. Tests: run, then extend

Run the phase's tests and the project suite; capture pass/fail counts and any flakiness. For every exit
criterion lacking a deterministic check, **write one and run it** (prefer the project's existing test
framework). When a criterion genuinely can't be automated, verify it by reasoning and label it
"reasoned, not automated" in the report. Deterministic checks beat narrative every time.

## 5. Verdict discipline

- **pass** only when: every exit criterion met (with evidence), tests green, no High/Critical findings.
- **fail** when: any criterion unmet, any High/Critical finding, or red/missing tests. Enumerate the
  exact follow-ups required before a re-QA.
- **waived** only for a criterion that is genuinely not applicable — justify it explicitly.

Bias toward fail when uncertain: a false pass lets a broken base propagate to every dependent.

## 6. Record + hand back

Write the report (`assets/report-template.md`) to **the path the brief names** — `reports/phase-NN-qa.md`
for a first round, `reports/phase-NN-qa-roundR.md` for every round after it, never an earlier round's
file — then record the result with `scripts/qa-record.sh` **with the same `--report` and `--round`**
(never hand-edit test-status.md). Commit + push the report
and test-status.md (shared work-state in the project repo). On pass, show the engine board so the newly
unblocked phases are visible; on fail, restate what must change.

**Rounds — which report file is yours.** A phase is often reviewed more than once, so a round is a real
thing and `--qa-prompt` hands you the next one's number and report name:

| Round | Report | Record it with |
|---|---|---|
| 1 | `reports/phase-NN-qa.md` | `qa-record.sh <slug> N <verdict> --report reports/phase-NN-qa.md --round 1` |
| 2 | `reports/phase-NN-qa-round2.md` | `… --report reports/phase-NN-qa-round2.md --round 2` |
| R | `reports/phase-NN-qa-roundR.md` | `… --round R` |

A record without `--round` is numbered from its report's filename (`-roundR.md` is round R, a plain name
is round 1), so pass the `--round` the brief gave you and never reuse an earlier round's name. **Never
write your report over an earlier round's** — that convention was invented by sessions and enforced by nothing, and
on one measured run 22 report files existed across 12 phases while `test-status.md` pointed at the last
one and the other ten were invisible to the engine, the API and every screen.

You no longer have to count. **Use the filename the brief gives you** — it is chosen from the round
ledger and then advanced past anything already on disk, so it is a name nothing has written yet. Every
round is listed by `scripts/phase-graph.sh <slug> --qa-history N`.

One implementation per language answers this now (`viewer/server/qa-round.ts` and `qa_next_round()`
in the engine), held equal by `viewer/test/qa-round.test.ts`, because the six places that used to
answer it separately drifted apart four times in a row. It is still a *convention the tools uphold*
rather than a lock: `--report` writes whatever you pass it, so pass what you were given.

**There is a budget on failing.** Under the autopilot a run may say `qaMaxRounds` (default **3**):
QA may return `fail` that many times on one phase, and then the ladder stops asking and parks the
phase with one errand for a person, naming the round count and the newest report. Only `fail`
rounds spend it — a `pass`, a `waived` and a round that recorded nothing do not — and a `pending`
verdict is always chased, because a review nobody gave is not a review that failed. So a third
`fail` on the same phase is the end of the automatic road: say in the report exactly what a person
must do, not merely what is wrong.

`test-status.md` holds two tables and they answer different questions. `## QA status` keeps ONE row per
phase — the CURRENT verdict, the only thing that gates — with a fourth `Round` column saying which review
produced it. `## QA rounds` is the append-only ledger behind it. A three-column table written before
rounds existed still reads (`Result` is the third cell either way) and is upgraded in place on the next
record. `pending` is recorded roundless and `--round` is refused with it: a round is a review that
happened, and `pending` is the absence of one.

A third section, `## QA waivers`, appears the first time a waiver carries `--reason` and never
otherwise. A waiver is the one verdict with no report to explain it — `pass` and `fail` point at a
review somebody wrote, while a waiver is a DECISION ("this finding does not apply to this phase")
regularly recorded with no report at all — so `--reason` is `waived`-only, refused on the other three
rather than dropped, and keyed `(phase, round)` like the ledger. It is a section rather than a fifth
cell because both tables are counted positionally by the bash and JS readers, and prose is the one
value that cannot promise to be short.

**A verdict that holds is not a dead end (issue #11).** A recorded `fail` — and a `pending` — holds
every dependent phase, and the console offers three verbs on the phase page and the inbox row:

| Verb | What it does | Flag |
|---|---|---|
| **Fix & re-QA** (`qa-recover`) | The loop, with settings of its own: a fix session carrying the last report's findings VERBATIM, which itself dispatches the reviewer and records round N+1 — repeating while rounds remain. `pass`/`waived` releases every dependent; a spent budget parks the phase with ONE errand naming the LAST report. | `--allow-run` |
| **Re-run QA** (`qa-rerun`) | The review alone, no fix session — for a verdict that failed on the ENVIRONMENT rather than the work (a flake, a missing binary, a reviewer that read the wrong tree). | `--allow-run` |
| **Waive with a reason** (`qa-waive`) | Records `waived` with the operator's words through `qa-record.sh --reason`. Starts nothing. | `--allow-writes` |

All three refuse on a phase with **no recorded verdict at all**: `qa-record.sh` would happily write a
round for a phase nobody has reviewed, and a "re-run" of a review that never happened is a first
review wearing the wrong name — which the budget would then count as a failed round. Start a review
with **QA this phase** instead. **Fix & re-QA** is additionally offered only on a `fail`, because a
pending verdict names no findings for a fix session to read.

Two things the loop deliberately does not do: it never re-reviews a verdict that already releases the
gate (a loop that "fixes" a passing phase is how a green plan turns red at 3am — so the verdict is
re-read off the file at the top of EVERY round, not trusted from the last one's return, because a
verdict recorded by hand or from another clone in the minutes a round takes is exactly as real), and
it never launches itself. The ladder's exhausted `qa-*` rung hands the operator the verb BY NAME in
its errand and stops there: re-arming a budget an earlier loop spent is a decision with a price.

**On fail.** Record `fail`, commit + push the report + test-status.md (the gate must reach every clone), and
enumerate the exact required follow-ups in the report. You return the verdict; you do **not** fix the code —
the finishing session owns the fix. Re-QA is always a **new** fresh-context subagent, never a re-run in this
context: after the builder re-commits, a fresh subagent re-reads the new diff cold (`qa-record.sh` overwrites
the row `fail`→`pass`). If the builder can't fix immediately, the phase's handoff is set `status: blocked`,
which the engine reads as `stuck` — that holds dependents independently of the QA row until a later session
fixes it and re-QAs to `pass`.

## 7. Engine sub-commands the QA step uses

The QA subagent's brief comes from `scripts/phase-graph.sh <slug> --qa-prompt <N>`. These read-only engine
commands help while reviewing (run from the project root that owns `docs/`, or set `DOCS_ROOT`):

| Command | Use |
|---------|-----|
| `<slug>` | human board: done/ready/waiting + QA markers (QA:verified / FAILED / pending) |
| `<slug> --qa-result N` | the CURRENT QA verdict for phase N — the one that gates |
| `<slug> --qa-history N` | every round on file, oldest first: `round⇥result⇥report⇥recorded` |
| `<slug> --gate-status N` | evaluate N's machine gate (clear / blocked / manual / ai / OVERDUE / unevaluated; exit 0/1) |
| `<slug> --memory-block` | the canonical done/ready/waiting block (handy for the qa-full roll-up) |
| `<slug> --deps N` / `--dependents N` | N's prerequisites / the phases N blocks |

Record results **only** via
`scripts/qa-record.sh <slug> <N> <pass|fail|waived> --report <the report the brief named> --round R`
(`pending` takes neither: it is the absence of a review) — an idempotent upsert into `test-status.md`
(its existence turns on QA gating in the engine). Never hand-edit the table. Re-recording the SAME
round replaces it rather than adding a second: running this twice is running it once, which is the
script's whole contract. A record without `--round` is numbered from the report's filename when it
carries one, else from the highest conventional report on disk, else previous + 1 — but pass it.

**Four verdicts, not three.** `pending` is a real recordable result, and it is the one that surprises
people: it means *the QA pass has been claimed but has not returned a verdict yet*, and it **holds every
dependent exactly as hard as `fail` does** — a dependent is `ready` only on `pass` or `waived`. So a row
left `pending` is not a neutral placeholder; it is a stop. `new-handoff.sh` writes one when it creates
`test-status.md`, which is why finishing a phase under QA-`on` means dispatching the verdict, not merely
writing the handoff. (Owner: `viewer/shared/plan-vocab.js` `QA_RESULTS`. `unknown` — a row the engine
could not read — is a fifth word and deliberately not in this list: it is not something you can record.)
