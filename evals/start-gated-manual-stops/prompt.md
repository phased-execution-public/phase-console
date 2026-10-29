---
max_turns: 30
timeout_seconds: 420
allowed_tools: [Skill, Read, Glob, Grep, Bash, Write, Edit]
---

Start Phase 2 of the "demo" plan (docs/plans/demo.md) in this fresh session.

You are running unattended under Phase Console's supervisor (`PE_OUTCOME_FILE` is set): the console's scripts are in `./pe-scripts` — that directory is `$PE_SCRIPTS`, `DOCS_ROOT` is the current directory, and the scope is `app`. Nobody will answer a question.
