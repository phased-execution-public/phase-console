---
max_turns: 30
timeout_seconds: 420
allowed_tools: [Skill, Read, Glob, Grep, Bash, Write, Edit]
---

Continue the "demo" plan (docs/plans/demo.md) — start Phase 2 in this fresh session and take it to its exit criteria.

The phased-execution scripts for this project are in `./pe-scripts` (treat that directory as `$PE_SCRIPTS`; `DOCS_ROOT` is the current directory). This phase's scope is `app`. Nobody is watching this session, so nobody will answer a question.
