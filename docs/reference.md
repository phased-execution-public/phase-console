# Reference

## How Agent Skills work

A [Skill](https://code.claude.com/docs/en/skills) is a folder with a `SKILL.md` whose frontmatter
(`name` + `description`) is the *only* part always loaded. Claude reads the full body **only when the
skill is relevant or invoked**, and bundled scripts run via Bash without their code ever entering the
context window. That is why a skill costs almost nothing until it is used — this one's description is about
**150 tokens** in every session (615 characters). When it fires, the body is a core of about 14.5 KB
(≈3.6K tokens: the console contract, the three modes as pointers, the guardrails), and a session then
reads the ONE mode file it is in — each at most 20 KB (≈5K tokens), the size a re-attach after
compaction keeps whole. The references and the script index are read on demand. (Measured at
measured-console phase 3; before it the body was 142 KB, ≈35K tokens, read whole every boot.)

```
phased-execution/
├── SKILL.md          # frontmatter + the core: the console contract, the modes as pointers, the guardrails
├── USAGE.md          # human-facing orientation
├── start             # launch the console
├── bin/              # phase-console — the same launcher, on PATH for plugin installs
├── scripts/          # the engine and its helpers (run, don't read)
├── references/       # mode-plan/-phase-start/-phase-finish.md (one per mode), scripts.md (the index),
│                     #   plan/handoff formats, conventions, sizing, QA method
├── templates/        # plan, handoff and INDEX scaffolds
├── tests/            # bats suite for the scripts
├── viewer/           # Phase Console — the local web app
└── .claude-plugin/   # marketplace.json — makes this repo installable as a plugin
```

There is deliberately no `plugin.json`. The marketplace entry carries the plugin's metadata itself
(`strict: false`), which keeps this folder a plain skill when you clone it — one tree, both install
paths, neither getting in the other's way. The root `package.json` is not a plugin manifest either:
it shapes the tagged-release tarball a GitHub Release carries, and changes nothing about how the
plugin or a clone behaves.

**▶ How the loop actually runs, in detail:** [USAGE.md](../USAGE.md).

# Requirements

**Bash** for the scripts — that is the whole skill. The console additionally needs **Node 22.18 or
newer (or 23.6+) with npm**: its server runs TypeScript directly, and its client is built once per
machine (`npm ci && npm run build` in `viewer/`; the console names those commands itself until they
have run). Once built it bundles everything — fonts
included — so it works offline and installs to a phone's home screen. No service, no configuration
file.

**Platforms:** macOS and Linux are first-class.
The terminal's native module (`node-pty`, optional) ships macOS
prebuilds and compiles during install on Linux when the distro's build tools are present
(`build-essential` + `python3` on Debian/Ubuntu); without it the console still runs and the
Terminal page says exactly what is missing. On Windows, run it inside **WSL2** (see
[install.md](install.md)); there is no native Windows build.

# Tests

```bash
tests/run-tests.sh                                        # the scripts (bats)
cd viewer && npm ci && npm test                           # the console (no build needed)
PHASE_CONSOLE_TEST_ROOT=~/code/your-repo npm test         # + engine parity, against a real plan library
npm run test:client                                       # the client suite (Vitest)
```

The parity test re-derives every plan's board from the console's own parser and asserts it matches the
engine. Run it after any change to a parser.

