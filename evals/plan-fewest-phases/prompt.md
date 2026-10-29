---
max_turns: 40
timeout_seconds: 600
allowed_tools: [Skill, Read, Glob, Grep, Bash, Write, Edit]
---

Plan this work with phased execution and write the plan to docs/plans/rename.md: rename the function `greet` to `say_hello` in `src/greet.sh` and in its one test, `tests/greet.test.sh`. Write the plan, check it, and stop there — implement nothing.

The phased-execution scripts for this project are in `./pe-scripts` (treat that directory as `$PE_SCRIPTS`; `DOCS_ROOT` is the current directory). Nobody will answer a question: decide from what is here and record what you decided.
