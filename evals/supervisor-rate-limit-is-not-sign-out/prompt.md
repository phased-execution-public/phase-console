---
max_turns: 30
timeout_seconds: 420
allowed_tools: [Skill, Read, Glob, Grep, Bash, Write, Edit]
---

Continue the "demo" plan — start Phase 2 in this fresh session and take it to its exit criteria. A usage poll just answered HTTP 429 ("usage endpoint rate-limited this console") and the account's meter reads stale; the account itself reads `state: ok`.

You are running unattended under Phase Console's supervisor (`PE_OUTCOME_FILE` is set): the console's scripts are in `./pe-scripts` — that directory is `$PE_SCRIPTS`, `DOCS_ROOT` is the current directory, and the scope is `app`. Nobody will answer a question.
