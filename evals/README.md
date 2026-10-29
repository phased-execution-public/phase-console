# The skill's eval suite

`SKILL.md` and its mode files are prose a model reads. No other suite here tests what that prose
makes a session *do*; this one does. Each directory is one `claude plugin eval` case — a `prompt.md`
a person (or the console) would send, a `case.yaml` naming the workspace it starts in, and
`graders/*.md`, each one pass/fail check. Every case has at least one free grader (a regex over a
file, the calls or the trace; a tool's use or order), so a run pays only for its agent turns.

Run it with `scripts/eval-skill.sh` or `phase-console eval run` (Pro; `docs/releasing.md` §Optional
after an edit to the skill), or bare, from this repository's root:

```bash
claude plugin eval . --trust-plugin --scaffold --allow-tools Bash Write Edit \
  --model claude-sonnet-5-5 --threshold 0.8 --max-cost-usd 25
```

`--scaffold` runs each case's `fixture.sh`, which is this suite's own code; `--allow-tools` grants the
shell the skill's work needs (it runs under the CLI's OS sandbox). Each case runs three times with the
plugin and three times without it, so the report gives the skill's Δ — reported, never judged.

## The workspace: `_fixture/seed.sh`

One fixture, sixteen variants, each a fact of the world a case needs. It makes a git repository
holding a three-phase plan (`docs/plans/demo.md`: scaffold, write and ship a greeting), phase 1's
handoff (with a note for phase 2: names are lower case), and `pe-scripts/` — stand-ins for the
console's scripts. They take the real scripts' argument order and refusals (`phase-lock.sh <slug>
<verb> <N>`, `--needs` required on `blocked`/`needs-human`), print the real scripts' `--help`, answer
the way the real ones do for that world, and record every call in `.pe/calls.log`, which the graders
read. Two marks a grader looks for: `RED-COMPLETE` (a `complete` handoff over a red verification line)
and `UNPROVEN-COMPLETE` (a `complete` handoff while a line is still owed — the gate unrun, the CI run
unfinished, the release unpublished).

The variants: `start` · `conflict` (another plan's live session holds the scope) · `gated-manual` ·
`ambiguous` (the goal admits two readings and nothing settles it) · `resume` (the last attempt's work
uncommitted in the tree) · `finish` (committed, green; HEAD is `81a9cdf`, made deterministic) ·
`finish-red` · `finish-debug` · `wrapup` · `sign-in` (`gh` not signed in, the release an exit
criterion) · `long-gate` (a three-hour `scripts/gates.sh`) · `ci-wait` · `upload` (a release asset the
plan lets the phase replace itself) · `npm-approve` (the owner's second factor) · `plan` · `plain`.

## The cases, and where each came from

| Case | Source |
|---|---|
| `start-reads-from-disk` | mode-phase-start, It's working if: the session started from disk alone |
| `start-claims-before-edit` | mode-phase-start: `claim` succeeded on a clear scope before the first edit |
| `start-gated-manual-stops` | mode-phase-start: a gated phase's gate read `clear` before implementing (here `manual`) |
| `start-publishes-tasks` | mode-phase-start: the task list is published and current |
| `start-sign-in-is-a-typed-step` | mode-phase-start: every act only a person can do is a typed human step |
| `start-ambiguity-is-a-ruling` | mode-phase-start: every judgement call has a ruling |
| `start-resume-keeps-work` | mode-phase-start: a resumed phase kept the previous attempt's uncommitted work |
| `halt-scope-conflict-stops` | the record: a foreign live lock on the scope — a lock queues, never builds over a live session |
| `halt-long-job-detached` | the record: one-pool's ~45-minute suite, turn-by-turn's ~3-hour gate — detached and declared |
| `halt-ci-run-is-a-watch` | the record: waiting-external on somebody else's clock (10 + 8 + 2 waits in the last three plans) |
| `halt-context-wrapup` | the record: quiet-console's 26 partials, every one `--reason context` |
| `halt-do-it-yourself` | the record: turn-by-turn phase 17 (E-4) asked a person for an upload its own policy allowed (guard rule G4) |
| `supervisor-load-is-not-a-halt` | #381: the supervisor held a run for machine load and never let go |
| `supervisor-rate-limit-is-not-sign-out` | #387: a rate-limited usage poll (429) was read as a sign-out |
| `errand-owner-second-factor` | the record: E-1/E-2 of the last three plans — the owner's `npm stage approve` |
| `finish-verifies-before-complete` | mode-phase-finish: every §Verification line ran green and was recorded before `complete` |
| `finish-red-is-never-complete` | mode-phase-finish, Step 1: never hand off red |
| `finish-sha-from-git-log` | mode-phase-finish: the commit's sha in the handoff is the one `git log -1` printed |
| `finish-rulings-in-handoff` | mode-phase-finish: the handoff names every ruling and leaves the prompts to the composer |
| `finish-notes-addressed` | mode-phase-finish: each note for a later phase is addressed |
| `finish-memory-as-a-set` | mode-phase-finish: memory records the status as a set |
| `finish-stops-after-handoff` | mode-phase-finish: a supervised session stopped after its handoff, its lock released |
| `finish-clean-diff` | §Architecture 4 (C7): no `[DEBUG-` line left in what is handed off |
| `plan-graph-and-verification` | mode-plan: every phase has a graph row, exit criteria and a runnable §Verification; validate.sh ran |
| `plan-gates-are-ai-by-default` | mode-plan: every gate is categorized, `ai` unless a person is genuinely required |
| `plan-fewest-phases` | mode-plan: the plan has the fewest phases that each fit one session |
| `stays-quiet` | the description's trigger: a one-line fix must not load the skill |

**`stays-quiet`** asserts three things about an ordinary request — "fix the typo in README.md" — in a
project whose README mentions phases and a plan: the Skill tool is never called (`tool_used` with
`min: 0, max: 0`, scored in BOTH arms, so it counts against the skill rather than being a with-only
indicator), the typo is fixed, and not one phase script is run (`.pe/calls.log` stays empty).

Every other case also carries `skill-fired` — `tool_used: Skill`, which the CLI reports as a
plugin-fired indicator and leaves out of the score — and the unattended ones `no-closing-question`
(the last message does not end on a question nobody is there to answer).

## Adding a case

A case is a directory with `prompt.md` (frontmatter `max_turns`, `timeout_seconds`, `allowed_tools`),
`case.yaml` (`schema_version: "1.1"`, `name`, `description` — where the case came from — `tags`, and
`context.scaffold_script: fixture.sh`), `fixture.sh` (one line: `seed.sh <variant>`) and `graders/`.
A new fact of the world is a new variant in `seed.sh`, and a new script a case needs is a stand-in in
its `_stub.sh`. Write graders that read what happened (`.pe/calls.log`, a file, the trace), never an
`llm` grader where a regex will do. `results/` is where runs land; it is ignored.
