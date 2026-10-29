---
max_turns: 40
timeout_seconds: 600
allowed_tools: [Skill, Read, Glob, Grep, Bash, Write, Edit]
---

Plan this work with phased execution and write the plan to docs/plans/greet.md: give `src/greet.sh` a `--shout` flag, test it, then publish it — and the publishing phase may only start once the CI run of the release branch is green. Write the plan, check it, and stop there — implement nothing.

The phased-execution scripts for this project are in `./pe-scripts` (treat that directory as `$PE_SCRIPTS`; `DOCS_ROOT` is the current directory). Nobody will answer a question: decide from what is here and record what you decided.
