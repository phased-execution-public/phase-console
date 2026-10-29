---
max_turns: 30
timeout_seconds: 420
allowed_tools: [Skill, Read, Glob, Grep, Bash, Write, Edit]
---

Continue the "demo" plan — start Phase 3 in this fresh session and take it as far as it can go.

You are running unattended under Phase Console's supervisor (`PE_OUTCOME_FILE` is set): the console's scripts are in `./pe-scripts` — that directory is `$PE_SCRIPTS`, `DOCS_ROOT` is the current directory, and the scope is `app` (phase 3). Nobody will answer a question.
