---
plan: docs/plans/{{SLUG}}.md
phase: {{PHASE}}
title: {{TITLE}}
status: {{STATUS}}            # complete | in-progress | blocked | pending
completed: {{DATE}}
next_phase: {{NEXT_PHASE}}    # linear hint only; the live ready-set is computed by scripts/phase-graph.sh
depends_on: [{{DEPENDS_ON}}]  # phases that had to finish before this one (from the plan graph)
blocks: [{{BLOCKS}}]          # phases that list this one as a dependency (auto-filled from the graph)
parallel_safe: []             # phases safe to run in a SEPARATE session at the same time as this
skills_used: []               # skills invoked this phase
key_files: []                 # repo-relative or absolute paths touched
memory: {{MEMORY_KEY}}
---

# Phase {{PHASE}} → next handoff: {{TITLE}}

## What this phase did
<!-- 1–3 sentences + bullets of what shipped. -->

## State now (verified)
<!-- tests X/Y green; committed (shas); deployed? migration applied? prisma republished?
     ⚠️  Verify against git log / git status BEFORE writing — never copy shas from memory.
     The environment may auto-commit (hooks); confirm the actual sha/message. Be honest. -->

## Files changed
<!-- paths grouped by repo -->

## Key decisions / gotchas
<!-- why-this-way notes the next session must not relitigate -->

## Notes for later phases
<!-- OPTIONAL, and the only way to hand something forward to a phase that has not started.
     One bullet per note, each ADDRESSED, in one of three ways:
       - **Phase 7:** …   (or "- **For phase 7:** …")  one phase, by number
       - **Next:** …      every phase that DEPENDS on this one — a dependency edge on the
                          DAG, never "the next number"
       - **All:** …       every later phase; never handed back to you
     `phase-graph.sh <slug> --notes N` is asked per phase and collects only what reaches N,
     so an UNADDRESSED line is collected by nobody. A wrapped sentence continues the bullet
     above it; 500 characters is the cap, and what does not fit belongs in the sections above,
     which the note can point at. A note for a phase this plan does not have fails the lint by
     name (F26 note-target-unknown): nothing would ever deliver it, and whoever wrote it would
     go on believing it had been handed over; one addressed to a phase already done is a
     warning, for the same reason with a softer ending.
     Only a COMPLETE handoff's notes are read — a phase still working may yet change its mind.
     Delete this section if there is nothing to say. Say nothing rather than everything:
     what belongs here is what the next phase would otherwise have to rediscover. -->

## ▶ Start next phase(s) (paste into fresh sessions)

<!-- AUTO-FILLED by scripts/new-handoff.sh from the plan's phase graph: the boot
     prompt of the phase THIS phase unblocks — or, when it unblocks several, the
     shared boot ONCE and a block per phase with only what is that phase's own
     (a booting session reads the shared boot and its own block, never a
     sibling's). None if downstream still waits on other deps. The console runs
     one phase per session, so a supervised session stops after its handoff;
     only a person driving by hand may batch straight into a ready phase while
     the budget lasts. Compose one
     phase's full prompt at launch with:
       bash "${PE_SCRIPTS:-<skill-root>/scripts}"/next-phase-prompt.sh {{SLUG}} {{PHASE}} --phase <N>
     and check live state with:
       bash "${PE_SCRIPTS:-<skill-root>/scripts}"/phase-graph.sh {{SLUG}}
     ($PE_SCRIPTS is the console's scripts in any session it starts; never write a
     skill copy's own path here — it pins the next session to that copy.) -->
{{NEXT_PROMPTS}}

## Outstanding / blockers
<!-- anything unresolved; "none" if clean -->
