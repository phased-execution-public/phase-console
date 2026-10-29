# Mode 3 — `phase-finish` (the phase is done)

**First:** publish this checklist with `scripts/phase-tasks.sh` and work it top to bottom. Step 1
(verify) is the step a hurried finish drops, because committing *feels* like the end — the checklist is
what makes it unmissable: **a phase is handed off `complete` only on green verification.**

```
1. VERIFY — run EVERY line of plan §Phase N's Verification; ALL green (never hand off red)
2. Commit changed files — explicit paths; verify the sha with: git log -1
3. Write the handoff — new-handoff.sh, then the body; `complete` + INDEX last, once every line is green
4. Leave notes for later phases — one addressed bullet each; nothing else reaches them
5. Update memory — docs/memory/<slug>/index.md, dated and commit-cited, + the MEMORY.md pointer
6. Stop & hand off — the console runs one phase per session; batch only by hand
```

Contents: Step 1 verify · Step 2 commit · Step 3 the handoff · Step 4 notes · Step 5 memory · QA gate ·
Stopping before the end · Step 6 stop · It's working if

## Step 1 — Verify

Run the phase's own `Verification` commands from plan §Phase N (tests, build, lint — whatever the plan
names) and confirm **every exit criterion** against them. All green is the bar for `status: complete`.
A red you cannot fix now means a **blocked** handoff (`new-handoff.sh <slug> <N> <title> blocked`) with
the failure recorded.

**Not run is not green:** a line owed, deferred or skipped (a device sweep left for later, a check
"owed at idle") means the handoff says `in-progress` and, under a supervisor, the phase declares
`partial` (`waiting-external` when the line waits on a clock you do not control). `complete`, and the
INDEX row's flip to it, are written LAST, after every §Verification line ran green: the board reads a
`complete` handoff as done the moment it holds a body, and its dependents board at once (#153).

**Record each command as you run it**, red ones too: `bash scripts/phase-outcome.sh <slug> <N> verified
--command "<the command as the plan writes it>" --exit <its exit status>`. A supervising console then
re-runs only what you did not prove at an equivalent tree (the same one, or one where only your
handoff, a lock or `CHANGELOG.md` changed since), and a red verdict of its own re-opens the phase
whatever the handoff says.

**Done when** every line exited 0 and each is recorded.

## Step 2 — Commit

Commit changed files by explicit path (`git add <path>…`); commit inside the relevant submodule(s),
then bump the pointer; end the message with the repo's `Co-Authored-By:` trailer. Commit to the plan's
recorded branch — **the current branch by default** — or the run branch the boot prompt names, which
then owns the branch discipline (a `git checkout -b` happens only when the user asked and the plan
names the branch). **Read the sha from `git log -1`** — the environment may have auto-committed.

On a SHARED branch commit only work whose checks you ran green (the console's wrap-up notice says which
branch you are on); on a lane's own branch commit what is done.

**Done when** `git log -1` shows the commit and `git status` shows only what you meant to leave.

## Step 3 — Write the handoff

`bash <skill-root>/scripts/new-handoff.sh <slug> <N> <title>` (status defaults to `complete`; pass
`in-progress` while any §Verification line is still owed), then fill the frontmatter and body
(`references/handoff-format.md`). Put every ruling you recorded into **Key decisions / gotchas** — the
handoff is what a person reads, the ledger what the console reads. The script fills `depends_on` and
`blocks` from the graph and writes the `## ▶ Start next phase(s)` section as a POINTER (#338):
`next-phase-prompt.sh <slug> <N>` composes the prompts when they are read, so leave them out of the
handoff. Write a handoff for every phase, even mid-batch — it keeps each one resumable cold.

**Done when** the handoff's body says what was done, what changed, every ruling and what remains.

## Step 4 — Leave notes for later phases

Fill `## Notes for later phases` with what a later phase would otherwise have to rediscover — a
measured fact, a trap, a name it must keep. **This is the only channel that reaches a phase which has
not started**: `scripts/phase-graph.sh <slug> --notes N` puts your bullet into its boot prompt. Every
bullet is **addressed** — `- **Phase 7:** …` (one phase), `- **Next:** …` (every phase depending on
yours), `- **All:** …` — because an unaddressed line is collected by nobody; one naming a phase the
plan lacks fails the lint (**F26**), one naming a phase already done warns (**F30**). Only a `complete`
handoff's notes are read; delete the section when there is genuinely nothing. Grammar, the
500-character note and the 12-note bound: `references/handoff-format.md` §7. A mid-phase decision
belongs in the ledger too — `ruling --kind deferral --for <M|next|all>` arrives in the same block.

**Done when** each note names its addressee.

## Step 5 — Memory

The plan's memory lives in the docs root, versioned with the plan: `docs/memory/<slug>/index.md` plus a
page per subject beside it (the docs root's docs/memory/README.md is the layout). A console run points the CLI's auto
memory there (`autoMemoryDirectory` in the run's settings file), so every config dir and every lane
writes the same place, and the brief carries the index's first 40 lines into the next session.

- **Write history, not the present.** Every claim is a dated line that cites its commit: `- 2026-10-25
  (phase 4, 1a2b3c4d): the brief replaces the prompt decision rows`. A later fact is a new line
  under the old one, never an edit of it. `close-plan.sh` names every claim in `index.md` that carries
  neither a date nor a commit.
- **Status as a set** — "done: 1,4,5 / ready: 2,3" — so the record stays truthful under out-of-order
  progress; `scripts/phase-graph.sh <slug> --memory-block` prints the canonical block.
- **The index stays short**: the status, this phase's line, and one line per page. A page holds the
  durable narrative of one subject (a trap, a measured figure, a gate); the board is always recomputable.
- **Keep the `MEMORY.md` pointer** in the config dir for a hand session: one line, `project_<slug>`,
  naming `docs/memory/<slug>/index.md`.

**Done when** `index.md` and its pointer name this phase's commits, each claim dated.

## QA gate — only when this plan runs QA

Check `scripts/phase-graph.sh <slug> --qa-mode`:

- `off` → skip this section (the default; step 1 is the phase's quality bar).
- `waived <reason>` → `new-handoff.sh` records the row as `waived` by itself; dispatch no QA subagent.
- `on <reason>` → before step 6, dispatch an **independent `Agent` subagent with a clean context**, in
  the FOREGROUND, using the brief from `scripts/phase-graph.sh <slug> --qa-prompt <N>` (discipline:
  `references/qa-method.md`). It reads the real diff cold, runs and extends tests, and records
  `pass|fail|waived` via `qa-record.sh`. Commit and push the report and `test-status.md` (a `fail` must
  reach every clone). On `fail` the finishing session owns the fix: fix now and dispatch a **fresh** QA
  subagent — the brief is ROUND-AWARE and names the report file its round writes; a run bounds this
  with `qaMaxRounds` — or hand off blocked (`new-handoff.sh <slug> <N> <title> blocked --force`) with the
  follow-ups listed. Dependents wait for `pass`/`waived`. Batched phases QA one subagent per phase.
- The user asks for QA on a plan that did not record it? Pass `--qa` to `new-handoff.sh` (it creates
  `test-status.md`, backfilling earlier completed phases as `waived`), then follow `on`.

## Stopping before the end

- **An external clock** (a CI build, a PR's auto-merge, a deploy window): (1) commit what is done;
  (2) write the handoff **now** with `status: in-progress` — what is done, what remains, what you wait
  on; (3) declare `bash scripts/phase-outcome.sh <slug> <N> waiting-external --wait-minutes <M>
  --reason "<what>" --watch <ref>`; (4) stop. The supervisor parks the phase and resumes THIS session
  when the ref lands or the window elapses, within the phase's wait budget (`- **Waits on:** <ref> ·
  <max>` allows more). A background shell dies with the turn and a background subagent lives ten minutes,
  so the declaration is the wait. A session nobody supervises (no `PE_OUTCOME_FILE`) writes the same
  declaration into the console's inbox, `runs/<instance>/<slug>/outcomes/phase-NN-<stamp>.json`; a
  running Phase Console with `--allow-run` parks the phase and resumes THAT session at the window.
  Plans avoid the park by splitting build ∥ verify-later behind a Gate-check (`references/plan-format.md`).
- **Out of budget or context, work still left**: (1) commit what is done; (2) write the handoff
  `in-progress` with **Outstanding** naming exactly what remains; (3) declare `bash
  scripts/phase-outcome.sh <slug> <N> partial --reason <budget|context|other>`; (4) stop. The supervisor
  reads `partial` as *resume me*. `partial` is for work that remains, `waiting-external` for a clock you
  do not control, `blocked`/`needs-human` for what a machine cannot settle, and `no-defect` — "I looked,
  and there was nothing to fix" — for a session sent to mend something already mended.

## Step 6 — Stop and hand off

Run the end-of-phase script — the live board, batching advice for a person driving by hand, and the
boot for **every** phase now ready (`--phase <M>` composes one whole):

```bash
DOCS_ROOT=<hub-root> bash <skill-root>/scripts/next-phase-prompt.sh <slug> <N>
```

Then decide, and **release the phase lock when you stop** (`phase-lock.sh <slug> release <N> --owner …
--git`):

- **Under a supervisor (`$PE_OUTCOME_FILE` set), this is the stop** — the console runs one phase per
  session; batch only by hand. The console boards every phase in a session of its own; the next one is
  its to start.
- **By hand, batch (continue in THIS session)** when a ready phase fits the **remaining session budget**
  — sequential on this one or an independent sibling — and is not GATED; it saves a bootstrap and keeps
  the cache warm (`--session-plan` shows which phases belong together).
- **Stop for a fresh session** when the budget is spent, the next phase is **GATED** (a 🔒GATED·ai
  phase's fresh session clears the gate itself, a 🔒GATED·human one waits for the operator's approval),
  it wants a **different model**, the account's usage window is exhausted (note the reset time in the
  handoff), or — with QA `on` — it depends on this phase's unrecorded verdict. Print the script's output
  verbatim as the session's last message, then STOP.
- **Several phases ready:** disjoint scopes may run as separate sessions at once (the banner names the
  pairs); shared repos run one at a time. **None ready but work remains:** pick up any other `ready`
  phase the board shows.
- **All done:** the script prints the closeout — run the plan's §End-to-end verification yourself,
  dispatch the `qa-full` subagent only if the closeout prints its brief, then — once every line is
  green — mark the plan `status: complete` (`close-plan.sh`, which refuses while work is unlanded or a
  `plan:<slug>` issue is open) and check memory for user gates.

## It's working if

- every §Verification line ran green and was recorded before `complete` was written;
- the commit's sha in the handoff is the one `git log -1` printed;
- the handoff names every ruling and leaves the prompts to the composer;
- each note for a later phase is addressed;
- memory records the status as a set;
- a supervised session stopped after its handoff, its lock released.
