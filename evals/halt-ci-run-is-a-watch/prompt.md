---
max_turns: 30
timeout_seconds: 420
allowed_tools: [Skill, Read, Glob, Grep, Bash, Write, Edit]
---

Finish Phase 2 of the "demo" plan: its work is committed and pushed, and the CI run it waits on (GitHub Actions run 4242 of `acme/demo`) started a minute ago.

You are running unattended under Phase Console's supervisor (`PE_OUTCOME_FILE` is set): the console's scripts are in `./pe-scripts` — that directory is `$PE_SCRIPTS`, `DOCS_ROOT` is the current directory, and the scope is `app`. Nobody will answer a question.
