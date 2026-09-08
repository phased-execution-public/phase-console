---
slug: {{SLUG}}
created: {{DATE}}
status: active            # open: active | approved | proposal | backlog · closed: complete | abandoned | superseded
phases: TODO              # total phase count
handoffs: docs/handoffs/{{SLUG}}/
memory: project_{{SLUG}}  # or pre-existing project_<other> key if reusing an existing memory
---

# {{SLUG}}

<!-- Optional: if this plan continues from prior work, add a provenance blockquote here:
> Continues from `docs/handoffs/<prior-slug>/phase-NN-*.md` and `~/.claude/plans/<scratch>.md`.
> Memory key: `project_<key>` (pre-existing — NOT a new slug-named memory).
-->

## Context
<!-- Why this work exists: the problem/need, what prompted it, the intended outcome. -->

<!-- Optional: if a prior handoff claimed incorrect state, add a Reconciliation note here:
**Reconciliation:** The phase-NN handoff at `docs/handoffs/<slug>/...` claimed X was uncommitted —
it is in fact committed at sha XXXXXXX. Use `git log` as the source of truth; ignore stale claims.
-->

## Architecture / approach
<!-- Key design decisions; critical files BY REPO; reused utilities (with paths). -->

## Session budget
<!-- The model these phases are SIZED FOR, so a future session can re-check it. See references/sizing.md.
     Budget is summed phase WEIGHT (S/M/L), ~0.2 × the effective window (real context runs ~3× weight,
     so a full session lands near ~60% of the window): 1M-class models → ~200K; Haiku 200K → ~40K. -->
**Target model:** `claude-opus-5`  ·  **Budget:** ~200K weight/session (≈60% of a 1M window)  ·  **Branch:** current branch (no new branch)
**Skills (every session):** <!-- optional — backtick each skill to use across ALL phases, e.g. `design-system`, `some-plugin:test-first`; the engine re-injects them into every phase's boot prompt + QA brief. Remove this line if none. -->
**MCP servers (every session):** <!-- optional — backtick each MCP server id this work needs across ALL phases, e.g. `github`, `context7`. Registered in Phase Console → MCP; checked before a phase spends a token, so a wall costs a probe rather than an hour. Keep it to 3-6. Remove this line if none. -->
<!-- **MCP policy:** require   <-- optional. By default a server that cannot connect does NOT stop the
     phase: it runs without that server, is told which are missing, and records the gap as an operator
     errand. Add the line above only when the work genuinely cannot proceed without its servers — a
     parked phase with no other ready phase behind it halts the whole plan. A single phase can disagree
     with `- **MCP policy:** require` (or `continue`) in its own block. -->
<!-- QA is OFF by default (phase-finish runs each phase's §Verification commands instead). ONLY if the
     user asked for QA on this work, add a line with exactly:  **QA gate:** on
     (every phase-finish then dispatches a fresh-context QA subagent; `**QA gate:** off` records an
     explicit waiver). Only the exact bolded form is machine-read — phase-graph.sh --qa-mode.
     A single phase can disagree with "- **QA:** on|off" in its own block; the phase's word wins. -->
<!-- - **Worktrees:** on   <-- optional, and OFF by default. Add it only when this plan's disjoint lanes
     should each get their own git checkout instead of sharing the run's. It changes nothing for a
     hand-driven session; Phase Console reads it, runs each concurrent lane in a `git worktree` of the run
     branch, and merges the lane back when it settles. Needs the console's NEW-BRANCH git strategy, and it
     on a superproject it builds a MIRROR instead — one linked worktree per scoped sub-repository, one
     mirror per RUN, so per-lane worktrees there share it, and since 2026-09-05 the superproject's own
     ROOT mounts as the mirror's first tree; `scope-unmapped` and `has-submodules` still refuse by name.
     See references/plan-format.md. -->
<!-- Branch policy (references/conventions.md §Branches): default = commit to the branch already checked out;
     create a branch ONLY if the user asked, and then use ONE branch for ALL phases (incl. independent ones).
     Optional: per-phase model overrides, e.g. "Phase 5 (architecture) → Opus; Phases 2–3 (codegen) → Haiku". -->

## Phase graph
<!-- Make blocking vs parallel obvious. This table is MACHINE-READ: scripts/phase-graph.sh
     parses the "Depends on" column to compute live readiness. List EVERY prerequisite per phase.
     Cell accepts: 4 · 4, 5 · a range 1–7 · 1–7 (+8–10) · — for none.
     After filling it in, run `scripts/phase-graph.sh <slug>` and confirm the parsed count
     matches `phases:` above (it warns on drift). Mark externally-blocked phases *(GATED)* in
     their ### Phase N heading + a "- **Gates (must clear first):** …" line + a categorized
     "- **Gate-check:** …" — `ai <check>` (a session verifies/does/clears it itself — PREFER this) |
     `manual <who>` (a person does the numbered steps, then approves on the console's Gate card) |
     `date`/`deadline`/`by`/`phase`/`phases`/`plan`/`cmd` (self-evaluating). -->
<!--
     Tag each phase's rough working-set with "- **Size:** S|M|L" in its ### Phase N block, then
     `scripts/phase-graph.sh <slug> --session-plan <model>` proposes which sequential small phases
     to batch into one session. See references/sizing.md. -->

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | TODO | — | — | TODO | TODO |
| 2 | TODO | 1 | — | TODO | TODO |

**Blocking:** 1 → 2 → …
**Independent (run in any order):** none (update as phases are added)

## Phases
<!-- One subsection per phase, each self-contained (it runs in a fresh session — alone, or batched with
     an adjacent small sequential phase per references/sizing.md). -->

### Phase 1 — TODO
- **Goal:**
- **Size:** M  <!-- S | M | L — rough working-set; drives batching. -->
<!-- Per-phase overrides, all optional, all beating the plan-wide line for this phase alone:
     - **Model:** opus            <-- an alias, a full id, or either with the [1m] window suffix
     - **Effort:** high           <-- low | medium | high | xhigh | max
     - **QA:** on                 <-- on | off — this phase's own QA gate, whatever the plan says
     - **MCP:** `github`          <-- UNIONED with the plan-wide MCP servers line
     - **MCP policy:** require    <-- require | continue — OVERRIDES the plan-wide policy
     Read back with phase-graph.sh --size/--qa-mode/--mcp/--mcp-policy <N>. -->
  <!-- Externally gated? mark *(GATED)* in the heading, write the conditions (numbered operator steps
       for human gates) in "- **Gates (must clear first):**", and categorize with
       "- **Gate-check:** ai <check>" (a session clears it — prefer) | "manual <who>" (a person
       approves via the console's Gate card or scripts/gate-approve.sh) | "date 2026-12-01" | "phase 8". -->
- **Read first:** this plan §Phase 1 (phase 1 has no prior handoff)
- **Files to create/modify:**
- **Steps:** high level (the `p1.taskM` task list is created at execution time)
- **Exit criteria:** numbered, specific, **independently verifiable** outcomes — the contract phase-finish
  verifies (and QA re-checks, when enabled).
  1. <e.g. "POST /x with an empty body returns HTTP 400">
  2. <…>
<!-- Verification commands must be WHOLE and copy-runnable (no `…` fragments — the runner refuses
     them into person-checks and, when nothing runnable remains, parks the phase at boarding).
     cwd-sensitive leads (docker, docker-compose, pnpm/npm/yarn, task/make/just, pytest/vitest/jest,
     go/cargo/alembic/tsc/node — scripts/verify.env is the list) need `- **Verify in:** <path>` (F18). -->
- **Setup:** *(optional)* bring-up the runner runs BEFORE §Verification and whose failures can never
  colour the phase red — e.g. `docker compose up -d`. Bring-up inside §Verification is what F22 fires on.
- **Verification:** the runnable command/test that proves each exit criterion above — phase-finish runs
  these green before handing off. Re-check a CLI flag's current docs before relying on its semantics.
  <!-- Monorepo? Add "- **Verify in:** <repo-relative dir>" to run them somewhere other than the root.
       Omitted = the root. A missing or escaping path falls back to the root and journals it. -->
- **Handoff must record:** what Phase 2 needs to start cold

### Phase 2 — TODO
- **Goal:**
- **Size:** M
- **Read first:** `docs/handoffs/{{SLUG}}/phase-01-*.md` + this plan §Phase 2 + memory `project_{{SLUG}}`
- **Files to create/modify:**
- **Steps:**
- **Exit criteria:** numbered, specific, **independently verifiable** outcomes.
- **Verification:** the runnable command/test that proves each exit criterion (run green at phase-finish).
- **Handoff must record:**

## End-to-end verification
<!-- How to test the whole feature once all phases land (run it, MCP checks, tests). -->
