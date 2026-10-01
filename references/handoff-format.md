# Handoff format

Contents: Brevity principle · Handoff frontmatter · Companion files · Body sections ·
Paste block format · Status source of truth · INDEX.md

A handoff is the **baton** a finishing phase hands to the next session. It must let a cold session — no
prior conversation — start the next phase. One handoff per phase, at `docs/handoffs/<slug>/phase-NN-<title>.md`,
plus a per-plan `INDEX.md`. Both are committed. Write one for **every** phase, even when — driving by
hand — you batch the next phase into the same session; that's what keeps each phase independently
resumable. (The console runs one phase per session and never batches.)

## Brevity principle
Self-contained but tight. Do **not** re-list the phase roadmap — link to `docs/plans/<slug>.md`. Put long
logs, full diffs, or large snippets in the files themselves (reference paths), not the handoff. Aim for a
reader to bootstrap in ~2 minutes.

## Handoff frontmatter (required)

```yaml
---
plan: docs/plans/<slug>.md
phase: <N>
title: <kebab-title>
status: complete            # complete | in-progress | blocked | pending
completed: <YYYY-MM-DD>
next_phase: <N+1 | none>    # linear hint only; the live ready-set comes from phase-graph.sh
depends_on: [<phases that had to finish before this one>]   # auto-filled from the plan graph
blocks: [<phases that list this one as a dependency>]        # auto-filled from the plan graph
parallel_safe: [<phases safe to run in a SEPARATE session at the same time as this>]
skills_used: [<skills actually invoked this phase — a descriptive record; distinct from the plan's prescriptive "Skills (every session)" directive>]
key_files:
  - <repo-relative or absolute path touched>
memory: project_<slug>      # or pre-existing project_<other> — see conventions.md
---
```

`new-handoff.sh` auto-fills `depends_on` (this phase's prerequisites) and `blocks` (phases that name this
one as a dependency) directly from the plan's Phase-graph table. They make each handoff self-describing in
a DAG: a reader of phase 5's handoff sees it depended on 4 and can verify 4 is `done` before building on it.

The frontmatter is machine-greppable, but **don't treat `status:` as a linear cursor** — the authoritative
"what's done / ready / waiting" is computed across all phases by `scripts/phase-graph.sh <slug>`, which
reads every handoff's `status:` and the plan graph together. `next_phase:` is only a hint; a completed
phase may unblock several phases or none.

**Status note:** `scripts/new-handoff.sh` accepts an optional fourth arg `[status]` (default `complete`).
Pass `in-progress` or `blocked` when scaffolding a handoff mid-phase. An `in-progress` handoff is also the
durable **pause marker**: a session interrupted mid-phase (usage limit, died console, deliberate stop) that
scaffolds one leaves the next session a bootstrap that says "continue from here, don't restart" — record
what is done, what is uncommitted, and (for a usage-limit stop) when the window reopens. The same marker
covers an **external wait** (a CI build, a PR auto-merge, a deploy window): write the `in-progress`
handoff *before* stopping, and — under a supervising runner — also declare the wait machine-readably with
`scripts/phase-outcome.sh <slug> <N> waiting-external …` so the autopilot parks and resumes the session
instead of reading the stop as a failure. A stop with **work still left** but nothing wrong (budget,
context) is the same marker plus `scripts/phase-outcome.sh <slug> <N> partial --reason
<budget|context|other>` — the autopilot reads it as work in progress and continues the session (or
boards a fresh one with a resume brief) by itself. The status vocabulary itself is unchanged
(`complete | in-progress | blocked | pending`): `waiting` is a **runner** phase state, never a handoff
status. `pending` / `TBD`
are valid in `INDEX.md` rows for phases not yet written (added by hand — the script only scaffolds phases
that exist). `INDEX.md` is an append log — per-handoff `status:` is the truth the board reads; a stale
INDEX row is cosmetic.
`new-handoff.sh` auto-detects the final phase by reading `phases:` from the plan and sets `next_phase: none`.
Pass `--force` to re-scaffold (repair) an existing handoff.

**When a handoff may say `complete` (#153).** Only once every line of the phase's §Verification ran
green. A line owed, deferred or skipped — a device sweep left for later, a check "owed at idle" — leaves
the handoff `in-progress` and, under a supervisor, the phase declares `partial` (`waiting-external` when
the line waits on a clock the session does not control). `complete`, and the INDEX row's flip to it, are
written LAST, after every §Verification line ran green: the board reads a `complete` handoff as done the
moment its body is written, and its dependents board at once — a shop plan's P66 flipped both before its
last line, and its dependant queued ahead of it for two hours. When the owed line does go green, the flip
is a hand edit of `status:` and the INDEX row, the phase's last edit — never `--force`, which
re-scaffolds the body from the template.

**A `complete` scaffold is not finished work (6.0, #46).** `new-handoff.sh` writes the body first — the
template sections and the spliced boot prompts, in one rename — and flips `status:` LAST, so a reader of
the working tree never sees `complete` on a half-written file; until the flip the file carries the status
it already had (a `--force` repair) or `in-progress` (a fresh scaffold). And a `complete` handoff whose
**What this phase did** is still the template — the section is there and holds nothing but its comment —
reads **`in-progress`** on the board (`phase_status` in `phase-graph.sh`, and `scaffold` in the console's
parser), and fails `--lint` as `handoff-scaffold-complete` (the F21 family), until the session writes what
the phase did. So write that section first: its dependents are not `ready`, and your `## Notes for later
phases` are not read by anyone, until it holds a sentence. A handoff written by hand without that section
is not a scaffold — it stands on its `status:` alone. `--force` still re-scaffolds from the template: carry
the body over yourself, and the board waits for you while you do.

**Companion files.** The per-plan folder also holds, beside the handoffs: `.locks/phase-NN.lock` (the
active phase claim from `phase-lock.sh`) and — **only when QA is enabled for the plan** (`--qa-mode` ≠
off; QA is opt-in since v3) — `test-status.md` (per-phase QA results that gate dependents — written via
`qa-record.sh`, never by hand) and `reports/phase-NN-qa[-roundR].md` (one report per QA ROUND — round 1
takes the bare name, and `--qa-prompt` names the file each later round writes). On a QA-`on` plan
`new-handoff.sh` scaffolds the `pending` row at phase-finish and the fresh QA subagent records the
verdict; on a `waived` plan the row is written as `waived` with no subagent; on the default (`off`)
neither file exists.

It also holds `gate-status.md` — the per-phase **gate clearances** written by `scripts/gate-approve.sh`
(the console's Gate card, an AI session that verified an `ai` gate, or a hand run), which
`phase-graph.sh --gate-status` honours for **every** gate kind. It is deliberately a **separate file
from `test-status.md` and independent of the QA regime** — that separation is the point: recording an
approval must never flip QA gating on, since anything that creates `test-status.md` turns gating on for
the whole plan. Commit and push it like the QA table; a clearance only exists where it can be pulled.

## Body sections (in order)

1. **`# Phase N → next handoff: <title>`**
2. **`## What this phase did`** — 1–3 sentences + bullets of what shipped.
3. **`## State now (verified)`** — tests X/Y green; committed (shas); deployed? migration applied?
   prisma republished? ⚠️ **Verify against `git log` / `git status` before writing — never copy commit
   shas from memory.** The environment may auto-commit (hooks); confirm the actual sha/message. If
   something is half-done, say so explicitly. Stale "uncommitted" claims are the top recurring defect.
4. **`## Files changed`** — paths grouped by repo.
5. **`## Key decisions / gotchas`** — why-this-way notes the next session must not relitigate. **Every
   ruling this phase recorded belongs here in words** (`phase-outcome.sh <slug> <N> ruling …` puts the
   same decision in the ledger the console reads; this section is what a *person* reads). The three
   shapes worth a line each: an instruction that admitted two readings and which one you took; a
   departure from what the plan said, and why; something in scope you deliberately left, and to whom.
   **Name the key and the id beside the words.** A ruling that answers a row of the plan's
   `## Decisions` manifest is recorded with `--needs <key>`, which the ledger keeps as its
   `decisionKey`; every line also carries the id `phase-outcome.sh` stamps on it (the one the inbox and
   `decisions.sh promote --from-ruling <id>` use). A ruling recorded with `--remember plan` is already a
   twin row (source `ruling`), and `--remember global` asked the console to hold it as its
   `policy.<key>` answer — say which here, so a person can find the standing answer it became.
6. **`## Notes for later phases`** *(optional)* — the only channel that reaches a phase which has
   not started. A phase with no session has no transcript and no inbox; this section, a `deferral`
   ruling and a `--deliver boot` message are the three places anything can be left for it, and
   `scripts/phase-graph.sh <slug> --notes N` is the one reader of all three. What it collects for N
   is folded into N's boot prompt as **`### Notes from earlier phases (K)`**, immediately after the
   board and before the decisions manifest — so a note written now is read by a session that does
   not exist yet.

   **The grammar.** One bullet per note, each **addressed**, in one of three ways:

   | bullet | who is handed it |
   |---|---|
   | `- **Phase 7:** …` (or `- **For phase 7:** …`) | phase 7, and nobody else |
   | `- **Next:** …` | every phase that **depends on** the writer |
   | `- **All:** …` | every phase but the writer |

   A wrapped sentence continues the bullet above it — markdown wraps and a handoff is written by
   hand, so a note long enough to matter is a note long enough to wrap. Each note is capped at
   **500 characters**; what does not fit belongs in the sections above, which the note can point at.
   The whole block is capped at **12 notes**, newest kept, with a trailer saying how many were left
   out — it is prepended to every boarding prompt of that phase, so an unbounded list is a token
   bill charged once per attempt.

   **`Next` is a dependency edge, not a number.** On a DAG "the phase after this one" is every phase
   that lists the writer; reading it as *writer + 1* would hand a root's note to a phase it never
   unblocked, which on a fan-out is most of the plan.

   **Three rules, all earned.** *Address every bullet* — the reader is asked per phase, so an
   unaddressed line is collected by nobody. *Address a phase that exists* — a note for phase 30 of a
   23-phase plan fails `--lint` by name (**F26** `note-target-unknown`), because otherwise it is not
   merely undeliverable, it is invisible: nothing prints it and nothing reports it missing, and
   whoever wrote it goes on believing it was handed on. One addressed to a phase already **done** is
   the same story with a softer ending — **F30** `note-target-done`, an advisory rather than a
   failure, and its own id because an id that both gates and warns cannot answer "did the lint
   fail?". And *only a
   `complete` handoff is read* — a phase still working may yet change its mind, and a blocked one has
   not finished the thought; neither has handed anything over.

   What belongs here is what the next phase would otherwise have to rediscover — a measured fact, a
   trap, a name it must not re-spell. What does not: the roadmap (the plan has it), this phase's own
   reasoning (§Key decisions has it), or anything the next phase will read in the code anyway.
   Omit the section when there is nothing to say.

   **The ledger half.** A note this section cannot carry — because the thing was decided mid-phase,
   rather than known at phase-finish — goes to the same reader by another door:
   `phase-outcome.sh <slug> <N> ruling --kind deferral --for <M|next|all> --what "…"`, whose
   addressee defaults to `next`. Both arrive in one block, oldest to newest, and the boot prompt asks
   the session to say in its own handoff what became of each. A note nobody answers is a note nobody
   writes next time.
7. **`## ▶ Start next phase(s) (paste into fresh sessions)`** — auto-generated by `scripts/new-handoff.sh`:
   the **plain-fenced boot prompt of the phase this phase unblocks** — or, when it unblocks several (which
   may run as concurrent sessions when their scopes are disjoint), **the shared boot ONCE and a block per
   phase** (see *The fan-out* below); sometimes none, when downstream phases still wait on other deps.
   Gated phases are flagged. Review it, don't hand-rewrite it; re-generate with
   `scripts/next-phase-prompt.sh <slug> <N>`. A booting session reads the shared boot and its own
   phase's block — never a sibling's. **Keep the heading literal** — it's a stable grep + splice
   target. Final-phase handoffs get **`## 🏁 Final phase — closeout`** instead.
8. **`## Outstanding / blockers`** — anything unresolved, or "none".

**A ruling is not a status.** The frontmatter's `status:` vocabulary is frozen at
`complete | in-progress | blocked | pending`, and the outcome protocol's is frozen at
`complete | waiting-external | blocked | needs-human | partial | no-defect` — the last is a
repair session's word ("I looked, and there was nothing to fix"; see
`references/console-surface.md`). A ruling says what a session
DECIDED, not how it ended: nothing acts on one, it never parks a phase, and declaring one is never
a substitute for declaring an outcome.

## Paste block format (section 7)

Each fenced boot prompt is copy-pasted verbatim into a fresh session. Per ready phase P:

    /phased-execution

    Continue the "<slug>" plan — start Phase P in this fresh session.
    [gate block — gated phases only, by category: an ai gate orders the session to verify each
     condition, do the work, record the clearance (gate-approve.sh) and continue; a human gate says
     STOP and points at the console's Gate card; an approved gate says proceed]
    Bootstrap from disk only:
    - docs/handoffs/<slug>/<P's dependency handoffs>
    - docs/plans/<slug>.md §Phase P + §Session budget (model, budget, branch)
    - memory <memory-key>
    This is a DAG: other phases may be ready and lower-numbered phases may still be unfinished — do NOT
    assume phases below P are done. Run scripts/phase-graph.sh <slug> for live state.

    This phase's SCOPE (the repos it touches, from the plan's Repos column): <csv>
    Two sessions may run at once ONLY on disjoint scopes. Before implementing:
      1. git pull, then: phase-lock.sh <slug> conflicts P --scope "<csv>" --git
         A reported conflict means STOP AND ASK the user.
      2. phase-lock.sh <slug> claim P --owner "<account>/<session>" --scope "<csv>" --git
    The invariant: never two live sessions whose scopes intersect; same repo ⇒ serialized;
    `all` ⇒ exclusive against every unqualified claim; disjoint ⇒ parallel. (Handoff/lock commits in the docs repo are NOT part of
    your scope — pull --rebase and retry up to 3 times if one races.)

    Then publish the pP.task* list with `phase-tasks.sh` (reset, then create/update) …
    Then implement Phase P to its exit criteria.

    When done, the deliverable is the HANDOFF — the board reads status: from it, and a
    phase with no handoff does not exist to the board. Scaffold it with:
        bash <scripts>/new-handoff.sh <slug> P <kebab-title> complete
    then fill in docs/handoffs/<slug>/phase-PP-<kebab-title>.md and commit it.
    Cannot finish? Hand off in-progress (paused, resumable) or blocked (needs help) —
    never end the session without a handoff. Stop after the handoff exists.

(4-space indent here avoids backtick nesting; the real handoff uses plain ` ``` ` fences.) The "Read first"
lines point at **P's dependency handoffs** — the phases P builds on — not merely the previous number.
`scripts/next-phase-prompt.sh` echoes the same to the terminal at end of Mode 3, a lone prompt flanked
by START COPY / END COPY markers.

### The fan-out: the shared boot once (control-tower phase 85, #115)

A handoff that unblocks several phases does NOT repeat the prompt above per phase — eight copies were
1,350 lines of which ~1,100 were the same boot, and every session told to read that handoff read them
all. It writes, after the scheduling note:

- **The shared boot, once**, in a ` ```text boot-shared ` fence: the prompt with `<N>` (and `<NN>`, the
  padded form) standing for the phase number, and a `⟨section⟩` line — `⟨reading⟩`, `⟨notes⟩`,
  `⟨gate⟩`, and any other section whose text is not the same for every sibling (`⟨setup⟩`, `⟨scope⟩`,
  `⟨locks⟩`, …) — where each phase's own part goes.
- **Per phase**, `### Phase P — <title>[ — 🔒 GATED·…]`, one line `- **Size:** … · **Model:** … ·
  **Scope:** …`, and a ` ```text boot-delta ` fence holding, under each `⟨section⟩` label, that phase's
  own part. A section that is empty for a phase is left out of its block.

The shared boot plus a phase's block composes to that phase's `--boot-prompt`, byte for byte:
`tests/unit/handoff-fanout.bats` composes it with awk and the console's `parse/handoff.ts` with
TypeScript. Nobody composes it by hand — `scripts/next-phase-prompt.sh <slug> <N> --phase P` and
Phase Console build the full prompt at launch, from the plan as it is then. A booting session reads
the shared boot and **its own block only — never a sibling's**: a sibling's block is another
session's prompt. `validate.sh` warns when a handoff's start section runs over 300 lines or 40 % of
the file.

## Status source of truth

**Status is computed, not stored as a cursor.** `scripts/phase-graph.sh <slug>` reads every handoff's
`status:` frontmatter + the plan graph and classifies each phase into one of five buckets —
`done | in-progress | stuck | ready | waiting` — correct however phases are run, including concurrently
and out of order. **`stuck` is the bucket a `blocked` handoff lands in**, folded by the engine, which is
why this list has five words and the `status:` field above has four.
INDEX.md + per-handoff `status:` are the inputs it
aggregates; keep them accurate. The plan's Phase-graph "Exit criteria" column is the *definition* of done
(may carry a `✅ DONE` note) but is secondary. A plan is finished only when the board shows **all** phases
`done` — never when the highest number is reached.

**Whether to batch the next phase in-session — by hand only; the console runs one phase per session —
is computed too**, from the plan's `## Session budget` + `references/sizing.md` + the running model — not
a handoff field. Write a handoff for **every** phase even when you batch the next one into the same
session: that's what keeps each phase independently resumable from a cold session, which is the whole
contract.

## INDEX.md (one per plan)

```markdown
# Handoffs — <slug>

Plan: [`docs/plans/<slug>.md`](../../plans/<slug>.md) · Memory: `<memory-key>`

| Phase | Title | Status | Handoff |
|------:|-------|--------|---------|
| 01 | schema | complete | [phase-01-schema.md](phase-01-schema.md) |
| 02 | api    | pending  | TBD |
```

`scripts/new-handoff.sh` creates the file from `templates/INDEX.md`, creates `INDEX.md` if missing, and
appends the phase row using the `[status]` arg. Add `pending` / `TBD` rows by hand for future phases.
