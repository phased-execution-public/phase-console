# The helper scripts — one entry each

**First:** look a script up here, then ask the script itself — `phase-graph.sh --help` lists every engine
mode in one line each, `--explain <F-code>` prints one lint's paragraph, and `phase-outcome.sh --help`
(likewise `phase-tasks.sh` and `phase-lane.sh`) prints its `usage()`.
This file names every script and every flag; the scripts print the rest.

Contents: Helper scripts · Sourced, hooked and the operator's · The console · For maintainers

## Helper scripts

Run them from the repo root that owns `docs/` (in a monorepo, the **superproject root**), or set
`DOCS_ROOT`; inside a submodule they find the superproject themselves. A session Phase Console starts
carries `PE_SCRIPTS` — the console's own scripts directory — and every prompt it composes names a script
as `$PE_SCRIPTS/<script>`; a boot prompt says `"${PE_SCRIPTS:-<skill-root>/scripts}"`, so the same line
runs by hand. Write them that way in a handoff, too. The boot prompt also carries the console's commit,
and says so when the skill you loaded is at another one: then the prompt and `$PE_SCRIPTS` win.

- `scripts/new-plan.sh <slug>` — scaffold `docs/plans/<slug>.md` from `templates/plan.md`.
- `scripts/phase-graph.sh <slug> [<mode> [N]]` — **the engine**: the live board by default (done / in
  progress / stuck / ready / waiting, unmet deps, gated flags, `SUGGESTED BATCHES:` when sizes are
  present), and one machine mode per question. `--help` prints them all, one line each. Reading a phase:
  `--section`, `--deps`, `--dependents`, `--ready`, `--ready-after`, `--size`, `--repos`, `--setup`,
  `--verify-in`, `--checkout`, `--floor`, `--out-of-scope` (a phase's `- **Out of scope:**` lines), `--model`, `--model-policy`, `--subagent-model`, `--permission-mode`,
  `--fast-gate`, `--may-delete-tests`, `--human-steps`, `--notes`, `--decisions`, `--boot-prompt`, `--boot-fanout`, `--brief` (the SessionStart
  brief the presence hook prints for a supervised session; under `PE_BRIEF=hook`, `--boot-prompt` leaves
  out what it carries). Gates and QA:
  `--gated`, `--gate-kind`, `--gate-status`, `--qa-mode`, `--qa-result`, `--qa-history`, `--qa-prompt`,
  `--qa-exhausted`, `--person-check`, `--verified`. Waits and budgets: `--wait-budget`, `--wait-count`,
  `--waits-on`, `--verify-timeout`, `--verification-tier`. Resources: `--skills`, `--plugins`, `--mcp`,
  `--mcp-policy`, `--credentials`, `--credential-policy`, `--accounts`. Landing and issues: `--land`, `--gitlink`, `--isolation`,
  `--issues`, `--conflict-policy`, `--messaging`, `--base-branch`, `--clash-zones`,
  `--landing`. The plan: `--lint`, `--explain`, `--plan-status`, `--closed`, `--not-yet-specified` (the plan's
  `## Not yet specified` lines), `--memory-block`,
  `--session-plan [model|budget]` (the forecast in measured sessions, `1 phase ≥ 1 session`, and the
  groups a person may batch by hand; `references/sizing.md`).
  The constants it reads live in `scripts/*.env` (`sizing.env`, `models.env`, `gates.env`, `mcp.env`,
  `verify.env`, `decisions.env`, `lints.env`), each the single source of its words.
- `scripts/validate.sh <slug>` — the plan's structural lint plus the handoffs' body and consistency
  checks; run it before trusting a board. **Gating lints** exit non-zero: F1 a malformed row, F2 an
  undefined dependency, F3 a cycle, F14 an open phase with nothing runnable to verify it, F20 a table
  whose shape cannot be trusted, F21 a cell read but not believed, F24 a gate with no or an unknown
  `Gate-check`, F25 a decision row nobody owes, F26 a note to an unknown phase, F27 an unknown landing
  word, F29 a `landed` gate on an unknown phase, F31 an unknown permission mode, F37 a `Human step:` the
  reader skips, F42 a `guide:` file that is missing. The **advisory family F15–F19, F22–F23, F28, F30,
  F32–F36, F38–F41, F43, F45–F52** warns on stderr and never changes the exit code.
  `phase-graph.sh --explain <F-code>` prints any lint's name, tier and paragraph (`scripts/lints.env`).
- `scripts/new-handoff.sh <slug> <N> <title> [status] [--qa] [--force]` — scaffold the phase handoff
  and its `INDEX.md` row; fills `depends_on`/`blocks` and the `## ▶ Start next phase(s)` pointer.
  `status` is one of `complete | in-progress | blocked | pending` (default `complete`); `--force`
  rewrites an existing handoff and its INDEX cell; `--qa` turns QA on for this finish.
- `scripts/handoff-status.sh <slug>` — INDEX, per-file status and the live board.
- `scripts/next-phase-prompt.sh <slug> <completed-phase|none> [--phase N]` — the end-of-phase banner,
  the board, batching advice and the boot for every phase now ready; `none` forces the closeout.
- `scripts/phase-lock.sh <slug> <claim|release|status|list|conflicts|mirror> <N> [--owner ID] [--lease
  S] [--scope CSV] [--session ID] [--worktree PATH] [--branch NAME] [--here] [--git] [--force]` —
  cooperative phase locks under `docs/handoffs/<slug>/.locks/`. `conflicts` asks across every plan
  (exit 0 clear, 1 collides); a branch AND a tree carve two intersecting scopes apart
  (`references/conventions.md` §Locking).
- `scripts/phase-lane.sh <slug> <create|merge|remove|list> <N> [--qa R] [--detach] [--repo TOKEN]
  [--owner ID] [--force]` — a hand checkout of your own under `<root>/.worktrees/hand/`.
- `scripts/phase-landing.sh <slug> <N> <state> [--repo KEY] [--policy WORD] [--ref REF] [--sha SHA]
  [--pr URL] [--by WHO] [--note TEXT] [--allow-backward]` · `<slug> list [N]` — the writer for
  `landing.md`, one forward-moving row per (phase, repo).
- `scripts/qa-record.sh <slug> <N> <pass|fail|waived|pending> --report <rel-path> [--round R] [--reason
  TEXT]` — the writer for `test-status.md`'s current verdict and its rounds and waivers ledgers.
- `scripts/qa-mode.sh <slug> [--phase N] on|off|inherit` — the writer for `**QA gate:**` and a
  phase's `- **QA:**` bullet.
- `scripts/wait-budget.sh <slug> [--phase N [--ref REF]…] <max>` · `<slug> [--phase N] --count <n>` —
  the writer for `**Wait budget:**` / `- **Waits on:**` and `**Wait count:**`.
- `scripts/phase-tasks.sh <slug> <N> <reset|create|update> [--id ID] [--subject TEXT] [--status
  pending|in_progress|completed|deleted] [--active-form TEXT]` — the session's task list ("What it is
  doing"); `deleted` belongs to `update` alone.
- `scripts/phase-outcome.sh <slug> <N> <status>` — the session→runner channel: ONE atomic JSON file at
  `$PE_OUTCOME_FILE` (unsupervised: the console's inbox,
  `runs/<instance>/<slug>/outcomes/phase-NN-<stamp>.json`). The statuses and the four record shapes are
  in `SKILL.md` §Under Phase Console; `--help` prints every flag. `--resumed-with TEXT` is the
  console's, never yours: on a deferred step's resume it prints the person's answer, declares nothing
  and exits 0 (`references/turn.md` §A deferred step). `partial` warns on stderr of every scope tree
  whose `pe/…` branch is ahead of `origin/<branch>`. Parking: `--reason`, `--watch REF`
  (to 8), `--wait-minutes N` or `--until ISO8601`. The refs: `gh:<repo>#run/<id>` (the run completes),
  `gh:<repo>#pr/<n>` (the PR leaves OPEN), `date:<ISO8601>`, `unit:<host>/<unit>` (a job on another
  machine), `credential:gh` (a credential is present, read by name, never its value), `lock:<slug>/<phase>` (somebody ELSE's lock),
  `phase:<slug>/<N>` (the console's record of a sibling reads done — the way to wait on a sibling,
  rather than a `cmd:` grep of its handoff), `verify:<slug>/<N>` (your own red §Verification lines pass
  again on a new head) and `cmd:"<command>"`. A `cmd:` probe is self-contained, because the console runs
  it later from its own directory: absolute paths, no shell variables, no backticks, no cd, balanced
  quotes, and exit 0 only when the thing has happened. A ref is at most 1,000 characters and the script
  never cuts one: a longer ref, or a `cmd:` ref holding a `$` or a relative path, exits 2 with nothing
  written. A `date:` beside a live ref is its backstop. Blocks: `--needs KEY`, `--rule`, `--command`,
  `--run-act ACT`. A human step: `--step KIND --title TEXT`, `--open-url`/`--open-command`, `--where`,
  `--proof`, `--step-line`, `--code`, `--credential`, `--due-when`/`--due`, `--why`, `--guide` with
  `--lang`, `--effort`, `--unblocks`, `--proof-type`, `--proof-words`, `--option`, `--recommended`,
  `--allow-decline`, `--decision-key`, `--window`, `--tried`, and `--act` (an operator act). A ruling:
  `--what`, `--why`, `--kind`, `--cost-if-wrong`, `--for`, `--needs`, `--remember`, `--by`. A proof:
  `verified --command --exit [--in DIR]`. Progress: `--label --done --of`. Handled: `--what --note
  --link`. Exit 3 means a watched ref already landed (carry on); exit 4 is the guard's refusal (run it
  yourself, `references/turn.md`).
- `scripts/decisions.sh <slug> [--phase N] answer <key> --value TEXT | waive <key> --reason TEXT |
  promote --from-ruling <id> --key <key> | list` with `[--by WHO] [--blocking yes|no] [--evidence
  TEXT]` — the writer for `decisions.md`, merged over the plan's `## Decisions`.
- `scripts/gate-approve.sh <slug> <N> [--by WHO] [--note TEXT] [--revoke]` — record or revoke a gate
  clearance in `gate-status.md`; commit and push it.
- `scripts/repair-artefacts.sh <slug> [--apply] [--reset-not-started N[,N…]]` — the deterministic
  repair of an INDEX cell, a handoff's `depends_on`, an expired lock and a never-started `blocked`
  marker; it reports by default.
- `scripts/close-plan.sh <slug> [--status abandoned|superseded|complete] [--reason "…"] [--reopen]
  [--force]` — the stored decision "does anyone still care?"; `complete` is refused while work is
  unlanded or a `plan:<slug>` issue is open, and (even with `--force`) while the plan's
  `## Not yet specified` section holds a line. Ask with `phase-graph.sh <slug> --closed`.
- `scripts/amend-plan.sh <slug> --title "…" --size S|M|L --repos <csv> --depends <csv|-> [--from <id>]
  [--gate "<type> <value>"] [--goal "…"] [--date YYYY-MM-DD]` — the ONE writer of a plan amendment: a
  `### Phase N` section numbered last, then its graph row, then the dated `*(Amendment K, …)*` note, then
  the `phases:` count, each an atomic write in that order (#416); prints N; exit 2 on bad arguments, 1
  (plan restored) when the lint finds a problem the original lacked (`references/plan-format.md`
  §Amendments).

## Sourced, hooked and the operator's

- `scripts/session-hook.sh` — the user-scope Claude Code hook (SessionStart / SessionEnd / Stop /
  Notification) that tells the console which sessions are live; it always exits 0.
- `scripts/guard-hook.sh` — the run's local `PreToolUse` command hook, written into every run's
  settings beside the HTTP one: it asks the console's own classifier, with no console up, whether a
  call writes a protected file or deletes a test (`references/console-surface.md`). A hook that
  cannot run blocks the call.
- `scripts/instance.sh`, `scripts/scope.sh` and `scripts/cmd-ref.sh` are **sourced**: the bash halves
  of where a console's state lives, how a Repos column is read, and how a `cmd:` ref reads — held to
  their JS twins by the parity tests.
- `scripts/build-plugin-tree.mjs --out DIR [--rev REV | --worktree]` — the skill materialized from one
  revision (≤ 5 MB, with `hooks/hooks.json` and a `plugin.json`), what a console hands its sessions.
- Tests: `tests/run-tests.sh` runs the bats unit + integration suite under bash 3.2.

## The console

**`start`** (→ `run`) — **Phase Console**, a local web app over the whole system: every plan's
live board, the graph, phase and handoff detail, the composed boot prompts, statistics and search
(`README.md`). It delegates every status claim to these scripts. **With no flags it only reads.**
Eight flags each unlock one act, and **all eight default off**: `--allow-writes` (scaffold plans and
handoffs, record QA, take locks — it never commits or pushes) · `--allow-run` (spawn unattended
`claude -p` sessions) · `--allow-terminal` (a real shell) · `--allow-agent` (interactive sessions and
the plan wizard) · `--allow-accounts` (register Claude accounts, pick one per run) · `--allow-webhooks`
(POST every announcement to URLs you register) · `--allow-publish` (push a finished phase's `pe/*`
branch where the plan's `permission.destructive` row allows it) · `--allow-mcp` (register MCP servers
and attach them).
Shut down is deliberately not behind a flag. **`--no-converge`** switches the convergence loop's
automatic triggers OFF; the operator's own *Recover & continue* press converges regardless.
`phase-console doctor [instance]` runs the start's probes and the machine checks with no plan in front
of them; `phase-console sessions ingest [instance]` drains the presence inbox with no console up.
What the console wraps around a session: `references/console-surface.md`.

## For maintainers

The release gate and the publishing scripts belong to whoever maintains this repository, and a session
working a plan has no use for them. Each one's signature and purpose is in `docs/maintainers.md`, the
release contract in `docs/releasing.md`:

- `scripts/gates.sh` — the release gate on this machine; `scripts/gates-marker.sh` is sourced by it, the
  pre-push hook and the release script — where a green run is recorded, and its one reader.
