# Plan format

Contents: Frontmatter · Sections in order (Title · Context · Architecture · Session budget · Decisions ·
Phase graph · Phases · Not yet specified · End-to-end verification) · Amendments · Notes

**The engine reads it for you.** A session reads its own phase with `phase-graph.sh <slug> --section N` —
the `### Phase N` section verbatim, its `## Phase graph` row under the table's header, and the
§Session budget directives that bind it (those the phase does not override with a bullet of the same
label; a phase's `Model:` overrides `Target model:`), each on its own line — never the whole plan.
`phase-graph.sh --help` lists every mode in one line each, and `phase-graph.sh --explain <F-code>`
prints a lint's paragraph from `scripts/lints.env`, the one catalogue of the lint codes this file
names.

A plan is the durable blueprint for a multi-phase task. It lives at `docs/plans/<slug>.md`, is committed,
and is rarely edited after design. Each phase's detail is **self-contained** — executable from the
plan + that phase's handoff with no prior conversation — because phases run in fresh sessions (the console
runs one phase per session; a person driving by hand may batch several — see `references/sizing.md`).

## Frontmatter (required)

```yaml
---
slug: <kebab-slug>          # shared by plan, handoff folder, and project_<slug> memory
created: <YYYY-MM-DD>
status: active              # active | approved | proposal | backlog | complete | abandoned | superseded
phases: <N>                 # total phase count
handoffs: docs/handoffs/<slug>/
memory: project_<slug>      # or pre-existing project_<other> when reusing an existing memory
closed: <YYYY-MM-DD>        # optional — set by close-plan.sh; absent while the plan is open
closed_reason: <one line>   # optional — why it was closed; required unless closed with --force
---
```

### Open vs closed

`status` answers one question — **does anyone still care about this plan?** Seven words answer it —
**four open, three terminal**. Owner: `shared/plan-vocab.js` `PLAN_STATUSES`; the engine treats every
word that is not one of the three terminal ones as open (`phase-graph.sh` `plan_is_closed`), and the
portfolio sorts plans in this order.

| Status | Meaning | Board |
|---|---|---|
| `active` | open; work is expected to continue. The default a scaffolded plan gets | live |
| `approved` | open; signed off, not started | live |
| `proposal` | open; drafted, not signed off | live |
| `backlog` | open; parked deliberately, with intent to return | live |
| `complete` | closed, having finished | **closed** |
| `abandoned` | closed without finishing | **closed** |
| `superseded` | closed because another plan took over | **closed** |

The four open statuses are alike to the engine: a `backlog` plan still reports ready phases and boot
prompts. Parking a plan is an edit to `status:`; closing one is `close-plan.sh`, whose `--status`
accepts the three terminal words alone.

A *closed* plan stops reporting: no stuck-handoff error, no QA-fail error, no missing-handoff/index-drift/
stale-lock/depends-drift warning, no ready phases, no boot prompts, no session batching, no
notifications. Its board still renders in full, and structural damage (an unparseable graph, an
undefined dependency, a cycle, an untrustworthy table shape, an unbelievable cell) is still reported,
as a note.

Closure is **not** progress. Progress is computed from the handoffs and never stored (see
`conventions.md` §Status source of truth); closure is an explicit operator decision stored here, and a
plan may close with phases unfinished. Set it with the verb, never by hand:

```bash
scripts/close-plan.sh <slug> --reason "why this stops here"     # → abandoned, dated
scripts/close-plan.sh <slug> --status superseded --reason "…"
scripts/close-plan.sh <slug> --reopen                           # → active, fields stripped
```

`--reopen` is always available, so closing is reversible.

## Sections (in order)

1. **`# <Title>`** — optionally followed by a provenance blockquote if this plan continues prior work:
   > Continues from `docs/handoffs/<prior-slug>/phase-NN-*.md` and `~/.claude/plans/<scratch>.md`.
   > Memory key: `project_<key>` (pre-existing; NOT a new slug-named memory).

2. **`## Context`** — why this work exists: the problem/need, what prompted it, the intended outcome.
   If a prior handoff claimed incorrect state, add a **Reconciliation note** here:
   > **Reconciliation:** The phase-NN handoff claimed X was uncommitted — it is committed at sha XXXXXXX.
   > Use `git log` as the source of truth; ignore stale handoff claims.

3. **`## Architecture / approach`** — key design decisions; critical files **by repo**; reused utilities.
4. **`## Session budget`** — the target model, the per-session weight budget (~0.2 × the effective
   window in phase weight: 1M-class models → ~200K; Haiku → ~40K), any per-phase model overrides, the
   **branch** (default: the current branch — **no new branch** unless the user asked; then ONE branch
   for *all* phases, independent ones included), and optionally the **QA regime** and a
   **`Skills (every session):`** line naming, **backticked**, the skills the user asked for (e.g.
   `` `design-system` ``) — the engine re-injects them into **every** phase's boot prompt and the QA
   brief, so each cold-start session re-invokes them. A phase adds its own with a
   `` - **Skills:** `tdd` `` bullet, UNIONED with the line (`phase-graph.sh <slug> --skills [N]`), and
   the handoffs before it add their `suggested_skills:`. The boot prompt carries all of them as ONE
   line, a Skill-tool call per skill — `Before you start: Call the Skill tool with "<plugin>:<name>".`
   — qualified by the console's loaded set where a bare name is one plugin's (measured-console phase
   11); a seeded mattpocock skill brings the six-line unattended adapter after it. **F47**
   `skill-unresolved` / `skill-user-invoked` (advisory, stderr): a skill the console's sessions do not
   load, or one marked `disable-model-invocation`, which the Skill tool refuses — told to the engine as
   `PE_SKILLS` (unset by hand, so silent; `phase-graph.sh --explain F47`).
   A phase names the **plugin kinds** its session loads with a `- **Plugins:** review, ui` bullet
   (backticks optional) over the console's kinds table — `review`, `security`,
   `planning` (plan-mode phases only), `release`, `docs`, `ui` — UNIONED with a plan-wide
   `**Plugins:**` line on §Session budget and never with another phase's (`phase-graph.sh <slug>
   --plugins [N]` prints the entries; measured-console phase 27). The console switches the set's
   plugins on for that phase's session alone. **F48** `plugin-set-over-budget` (advisory): a set
   whose entries, at 1,536 characters each, pass 1 % of the phase model's window — or a word that is
   no kind (`plugin-kind-unknown`). The sets are Pro; the Free console reads the bullet and loads none.
   **Several directives may share a line**, separated by ` · ` with each label bold
   (`**Wait budget:** 8h · **Wait count:** 8 · **Verify timeout:** 90m`): both readers split the line
   there (#419). A label after a comma or inside prose is read by nobody, and so is a second label
   inside a phase's bullet (`- **Size:** M · **Model:** …`) (**F50** `directive-mid-line`, advisory).
   **Every whitespace the readers count is a space or a tab**: the engine reads under the C locale, as
   CommonMark does, so a no-break space (U+00A0) before a fence, a pipe or a bullet, or inside a label
   (`Verify timeout`), is text (#410).
   **`MCP servers (every session):`** — **backticked** *registry ids* from the console's MCP page
   (`` **MCP servers (every session):** `github`, `context7` ``): what the phase needs, never how to
   reach it. Re-injected into every boot prompt and the QA brief, attached with `--mcp-config` and
   checked **before the phase is paid for**; an unregistered one is **F15** `registry-name-unknown`
   (advisory). **Keep the set small — three to six**: each server rides every turn's system prompt, and
   attaching mid-phase busts the prompt cache (`references/sizing.md`), so attachment happens only at a
   phase boundary.
   **`MCP policy:`** — `continue` (the default: the phase boards without an unreachable server, its
   prompt names the servers it lacks and tells it to record the gap under **Outstanding** as an
   operator errand, and the console warns) or `require` (the phase parks at boarding). Write
   `` **MCP policy:** require `` only when the work cannot proceed without its servers.
   **Permission mode has two spellings.** Add `` **Permission mode:** plan `` to §Session budget when
   every phase must present what it will do before it writes, and
   `` - **Permission mode:** acceptEdits `` on a phase that disagrees with that line —
   the bullet **overrides** the line, as `MCP policy:` does.
   The words are the CLI's `--permission-mode` words — `acceptEdits`, `auto`, `dontAsk`, `plan`,
   `manual` (`scripts/permission.env`) — matched in any case, handed over as the CLI spells them;
   `bypassPermissions` is the run's permission PROFILE, never a mode. Any other word fails the lint
   (**F31** `permission-mode-unknown`, a gate; the reader falls through it). Resolution, strongest
   first: a Retry-with-edits, the run's per-phase choice, the bullet, the line, the run's default, then
   `acceptEdits`; `scripts/phase-graph.sh <slug> --permission-mode <N>` prints `mode<TAB>phase|plan`,
   nothing when silent. Under the console a `plan` session hands its plan over through `ExitPlanMode`
   (boarding with the relay's presence-only host even when the relay is off), and the phase parks
   `plan-approval` until a person presses Approve (the session resumes in `acceptEdits`) or Reject,
   unless the plan's `plan-approval` decision says `continue`.
   **`QA gate:`** — **QA is off by default.** Write exactly `**QA gate:** on` ONLY when the user asked
   for QA (every phase-finish then dispatches a fresh-context QA subagent); `**QA gate:** off` records
   an explicit waiver (rows `waived`, no subagents). Only that bolded form is machine-read
   (`phase-graph.sh --qa-mode`); `scripts/qa-mode.sh <slug> on|off` writes it (the console's toggle
   runs it), as may a hand edit.
   **`### QA contract`** *(optional; an H3 anywhere, §Session budget the natural home)* — review rules
   the engine cannot know, injected VERBATIM into every `--qa-prompt` brief above the numbered steps
   and the verdict line (e.g. a plan that rules out one of `pass|fail|waived`, the words `qa-record.sh`
   accepts, says so here, where the reviewer reads). The engine neither parses nor validates it.
   **`Worktrees:`** — off by default; `- **Worktrees:** on` gives each concurrent disjoint lane its own
   `git worktree` of the run branch under `.worktrees/runs/<slug>/<runId>/` (the *Worktree root*
   setting `state` moves it to the state directory), merged back when it settles (a conflict halts the
   run, names both lanes, loses nothing). It needs the **new-branch** git strategy; refusals are
   journalled by name.
   **`Worktrees: on` is a per-LANE ask, and the run decides whether it can be granted.** The run's
   isolation is a LAUNCH setting: a run on a **shared checkout cannot grant** the ask, and a
   **superproject never grants** it (a linked worktree of a repo with submodules has EMPTY submodule
   directories) — its answer is the run-level **MIRROR**: one linked worktree per scoped sub-repository,
   each on `pe/<slug>`, at its root-relative path under the run's `integration/` tree in the same
   `.worktrees/` folder, the superproject's own tree and gitlinks untouched. A scope meaning the root
   (`all`, the root's name, a plain directory of it) mounts the root as the mirror's first tree, its
   initialized submodules under it. Two claims carve only when branches AND working trees both differ.
   Named refusals: `scope-unmapped` (a token naming nothing or an uninitialized submodule; hint
   `git submodule update --init`) and `has-submodules` (a plain worktree of a superproject);
   `root-scoped` survives only so stored journal lines render. Phases share the mirror, serialized per
   scope, and the `integration`/`merge-queue` settles refuse a multi-repo run by name — use `pr` or
   `keep` (`server/runner/worktree.ts` §Why it refuses on a superproject). The launch names the line
   before anything spawns (the prelude's git-strategy probe) and asks **honour** (isolate the run so
   the line holds) or **override** (run over it, telling the sessions the concrete checkout); a door no
   person pressed (the convergence loop, a boot sweep, a webhook) answers `override` and journals
   `run.git-strategy-overridden`.
   **`Branch:`** (policy: `references/conventions.md` §Branches) — the console reads only BACKTICKED
   tokens; one naming `pe/<slug>` agrees with the run. Running over the line with its own branch, or
   cutting none while the line names another, the launch asks the same **honour**-or-**override**
   question, and an overriding run tells each session its concrete branch and checkout. The line stays
   authoritative for hand-driven sessions.
   **Choose isolation at LAUNCH**: a resume cannot add it. Two explicit escapes:
   `POST /api/run/<slug>/isolate` (its own checkout at the next boundary with no lane live; a refusal
   leaves it shared, `run.isolation-switch-refused`) and `POST /api/run/<slug>/isolate-phase {phase}`
   (one waiting phase gets a lane; refused under a superproject). Launch isolated when phases write the
   superproject's root, or share a submodule with a run live for days (a branch hold lasts until the
   holder settles). A fixable refusal (`branch-in-use`, `worktree-failed`, `mount-occupied`,
   `setup-failed`, `cap-reached`) **parks** the run with git's words and the fix; a structural one
   (`scope-unmapped`, `has-submodules`, …) keeps the named shared fallback.
   **The lines the decision manifest resolves from** (§Decisions), each optional:
   **`Credentials:`** — backticked ids EVERY phase needs (`` **Credentials:** `gh`, `npm-token` ``),
   probed by name before boarding, never a value; `--credentials [N]` unions the line with a
   phase's `- **Credentials:**` bullet. **`Credential policy:`** — `require` (a phase naming a
   credential the console lacks is refused at boarding) or `continue` (it runs; the gap is reported);
   silence lets the run decide; a `- **Credential policy:**` bullet overrides (`--credential-policy [N]`). **`Accounts:`** — the Claude accounts a run may spend, in order, as
   backticked `id:minHeadroom` pairs (`` **Accounts:** `default:20`, `work:10` ``), the minimum
   five-hour headroom a percent (`--accounts` prints `id<TAB>min` per line). An unregistered credential
   or account is advisory (**F15**).
   **`Model policy:`** — what a run may do to a phase's model: `ladder` (the console may climb to a
   stronger model on a retry) or `pinned` (every attempt keeps the phase's model); a phase's
   `- **Model policy:**` bullet overrides the line, and `--model-policy [N]` reads the answer back as
   `ladder|pinned<TAB>phase|plan` (silence: the run's `modelPolicy`, then `ladder`).
   **`Subagent model:`** — the model a session's subagents run (its first word, as `- **Model:**` is
   read); a phase's `- **Subagent model:**` bullet overrides the line, and `--subagent-model [N]` reads
   it back as `model<TAB>phase|plan` (silence: nothing — the session's own default). Two per-phase
   bullets have no plan line and a default of their own: `- **Fast gate:** on|off` (the Stop hook's
   fast gate; `--fast-gate N` prints `on|off<TAB>phase`, else `on<TAB>default`) and
   `- **May delete tests:** yes|no` (whether the session may delete a test file; `--may-delete-tests
   N` prints `yes|no<TAB>phase`, else `no<TAB>default`). A word off either vocabulary is silence.
   **`QA exhausted:`** `waive|halt|<owner>` (once the QA round budget is spent — `qa.exhausted`,
   `--qa-exhausted`) and **`Wait budget:`** (`48h`, `2d`, `90 min` — the TOTAL wall-clock one phase
   may spend parked across all its waits, `waits`; the console's default is 8 h), read at run start.
   **`Wait count:`** `<n>` — how many waits a phase may declare, 1–99, over the console's four; a
   phase's `- **Wait count:** <n>` wins (`--wait-count [N]` prints `n<TAB>phase|plan`).
   **`Verify timeout:`** (`60m`) — how long one §Verification command of any phase may run before it is
   cut (`--verify-timeout`; §Phases ▸ Verify timeout). **`Setup (every phase):`** — §Phases ▸ Setup.
   **`Verification tier:`** `impact|full` — what every phase's HEAVY §Verification lines run as
   (`--verification-tier [N]` prints `impact|full<TAB>phase|plan`; a phase's `- **Verification tier:**`
   wins; silence is `full`). Under `impact` each line `scripts/verify-select.env` names — `bash
   tests/run-tests.sh`, the node suite, `test:client`, `test:e2e:dist` — runs in its SELECTED form: the
   test files the phase's diff maps to, the invariants and a sample seeded by the boarding sha, under
   `PE_VERIFY_TIER=phase`; any other line, and a heavy line whose diff touches a file no test names, runs
   as written. The ledger keys the row by the ORIGINAL text with `tier`, `selected`, `sample` and
   `covered` (`phase.verify-selected`). A release phase says `- **Verification tier:** full`: only the full
   tier verifies a commit, and only `scripts/gates.sh` writes its marker. A flaky test is set aside by
   name in `scripts/quarantine.env` (an owner and an expiry; a row past its day fails the gate), and
   the reds a release carries are listed in the console's `known-reds.json` (a new red fails its stage; a fixed
   one lowers the list).
   The wizard also describes **`Permissions:`** (`permission.policy`), **`May publish:`**
   (`permission.destructive`) and **`When in doubt:`** (`ambiguity`), but nothing reads those lines —
   write the `## Decisions` row.

   **Where the work HAPPENS and where it LANDS.** Seven lines, each read back as
   `word<TAB>phase|plan|default`: **`Landing:`**
   `hold|integrate|pr|trunk` (`--land [N]`; default `hold`, a person merges) · **`Base branch:`**
   `origin/HEAD|head|<ref>` (`--base-branch`; the two words are questions, anything else a git ref
   passed whole) · **`Gitlink:`** `bump|leave` (`--gitlink [N]`) · **`Conflicts:`**
   `halt|park|rebase-session` (`--conflict-policy`) · **`Isolation:`** `shared|worktree`
   (`--isolation [N]`) · **`Clash zones:`** backticked paths (`--clash-zones`) · **`Messaging:`**
   `on|off` (`--messaging`). Per phase, `- **Land:**`, `- **Gitlink:**`, `- **Isolation:**` and
   `- **Issues:**` OVERRIDE the line for that phase; `Base branch`, `Conflicts`, `Clash zones` and
   `Messaging` are claims about the RUN, so the arm REFUSES a phase argument; there is no per-phase
   `Notify:` bullet (who hears belongs to the run and the operator). **`Isolation` has no
   default** — a silent phase inherits the run, and `--isolation` prints nothing. **An unrecognised
   word is not adopted**: the readers fall through to the next level, and **F27** `land-word-unknown`
   (gate) fails `Land: sometimes` or `Issues: maybe`, naming the level and word; **F31**
   `permission-mode-unknown` is its twin. `Messaging: off` also suppresses the mail source of
   **`--notes N`** (what earlier phases left for phase N, carried in its boot prompt); `deferral`
   rulings and handoffs' `## Notes for later phases` bullets are still collected
   (`references/handoff-format.md` §7). **F26** `note-target-unknown` (gate): a note to a phase the plan
   lacks; **F30** `note-target-done` (advisory): one to a phase already done. **F28** `land-needs-lane`
   (advisory): a phase that LANDS from a checkout it shares carries every commit on that branch.

   **`Issues:`** `off|draft|file` (`--issues [N]`, the `issues` manifest row) — the outward-write
   directive. Silence — no bullet, no line — leaves the word to the console: the Free console files
   nothing, so there silence is `off`; Pro's falls through to the run's word and then Settings ▸
   Issues, which ships `file`, and its boot prompt names the word in force and who said it. `draft`
   is recommended: the session writes, the console holds it in the
   inbox, a person approves. A session's budget is three drafts a phase (four findings are a CLASS —
   one issue, four bullets); a fourth is held for a person rather than dropped. Plan-wide in §Session
   budget and per phase under its `### Phase N`:
   > **Issues:** draft
   ```
   ### Phase 7 — Migrate the billing job
   - **Issues:** file
   ```
   (`--issues 7` prints `file<TAB>phase`, `--issues` alone `draft<TAB>plan`, neither line
   `off<TAB>default`.) Write `file` only on a phase whose findings a person decided in advance not to
   read first (a migration sweep), never where the scope includes a repository somebody else owns.

   **Per-phase waits.** `- **Waits on:** <ref>[, <ref>…] · <max>`, `- **Human step:** …` and
   `- **Person-check:** allow|halt|<owner>` refine the `waits`, `human-acts` and
   `verification.person-check` rows for that phase. `Waits on:` names what the phase waits on and,
   after the `·`, its own wait budget; a `date:` ref countersigns a wait up to that instant, and beside
   a live ref is only its BACKSTOP (the live ref wakes the phase when it lands, #181). Past the budget,
   a wait naming a watchable ref gets what is left; one naming none parks with a `budgets` errand,
   never a failure (`--wait-budget N` / `--waits-on N` print what is read).
   `scripts/wait-budget.sh <slug> [--phase N [--ref REF]…] <max>` rewrites the phase's `Waits on:` max
   (keeping refs and note) or the plan's `Wait budget:`, idempotently, proven by read-back (the
   console's one-press raise, behind `--allow-writes`); `--count <n>` writes `Wait count:`. A park on a
   spent count or budget whose watch ref still polls is a WAIT on that ref (the run reads `waiting`). **F36** `wait-window-short` (advisory): a `Waits on:` max shorter
   than the watched workflow's timeout, told through `PE_WAIT_TIMEOUTS` — whitespace-separated
   `<ref>=<minutes>` pairs resolved once per `gh:…#run/<id>` (no `timeout-minutes` counts GitHub's
   360); unset is off, set but empty an answer.

   **A person's turn, declared by the plan.** Each act only a person can do is its own bullet, so the
   launch door asks for it before anything spawns:
   `- **Human step:** <kind> · <what> · open: <url or command> · proof: <ref> · where: host|any ·
   window: <duration> [· auto-open: host] [· credential: <id>] [· due: <ref>] [· why: <reason>]
   [· effort: <duration>] [· unblocks: <phases>] [· guide: <file>] [· options: id=Label[::consequence] | …]
   [· recommended: <id>] [· deadline: <ISO 8601>]`. Kind and what are positional; every later field is
   `key: value`, any order, a value in one pair of backticks read without them.
   The kind is one of eighteen (`scripts/human-steps.env`, owner `shared/human-step-model.js`): `browser-login`,
   `device-code`, `one-time-code`, `secret-entry`, `claude-login`, `mcp-login`, `os-prompt`,
   `os-permission`, `third-party-approval`, `physical`, `person-check`, `decision`, `protected-path`,
   `interactive-prompt`, `captcha`, `email-link`, `operator-act` (the general operator act: a command
   to run or a click path) and `permission` (a wall the AI met, ended by a grant or a denial). Fields:
   `where` defaults to the kind's; `open:` an http(s) link or a terminal command; `proof:` a watch ref
   (`cmd:`, `gh:`, …); `window:` a duration; `auto-open: host` opens a PLAN's step (never a session's)
   by itself on the machine; `credential:` the registry id a `secret-entry` stores under; `due:` a watch
   ref to wait on — until it lands the step is `upcoming` (under *Coming up*, unannounced, window not
   started), then due with ONE push, `Now: <the act>` (a `due:` fitting no scheme's shape — a date with
   no time, a `phase:` with no number — fails F37); `why:` a `WHY_PERSON` reason (`scripts/turn.env`)
   the kind allows (`KIND_REASONS`, owner `shared/turn-model.js`; else F37); `effort:` the person's
   time; `unblocks:` the phases it unblocks (`12,13`); `guide:` a file under the docs root in the
   grammar of `shared/guide-grammar.js` (a why paragraph, `## Steps` with numbered steps and their
   commands, `## If it goes wrong`; at most 20 steps and 24 KB), read at the launch door, into the item
   and on every read of Your turn — realpath under the docs root (a symlink out is refused),
   secret-screened; a refused file costs the item its guide, never the item, and a path that is not a
   file fails **F42** `guide-file-missing` (gate); `options:` a `decision` step's two to eight choices,
   `id=Label[::consequence]` separated by `|` (ids: a-z, 0-9, `-`); `recommended:` one option's id;
   `deadline:` the ISO 8601 date or instant the act must be done BY (`2026-10-20`, `2026-10-20T17:00Z`)
   — an END, where `due:` is a START. `--human-steps` prints none of the last three. A phase may carry
   several. Under a top-level `## Operator errands` heading the bullet is the PLAN's own act — phase
   `0`, asked at every launch, e.g.
   `- **Human step:** operator-act · Publish the release · open: npm publish · proof: cmd:"npm view my-package version" · due: unit:build-box/nightly-build.service`.
   **The `## Operator errands` table** — one per section, a row per act, read for the act's steps: the
   bullet keeps the machine's fields (kind, proof, due), the row a person's:
   `| Id | Phase · why | What only the owner can do | Exact steps | Expected | How the agent verifies |`.
   Columns are found by NAME (`Id` or `Ref`; `What only the owner can do` or `What`; `Exact steps` or
   `Steps`; `Expected`; `How the agent verifies` or `Verify`); the second is free text. A bullet is BOUND
   to a row when its text ends with the row's id in parentheses — `… (E-4)`, `… (E-4, hub #105)`; an
   item already raised is matched the same way, gains the row's steps with no ledger write and is never
   asked twice. In `Exact steps` a backticked `` `! cmd` `` is a command step, anything else one prose
   step (no steps invented from sentences); a command with a `<placeholder>` is shown as a template; a
   `\|` or a pipe inside backticks stays in its cell; the preamble's "runs from `<dir>`" is a hint. A
   guide comes from the bullet's `guide:` first, then its row. A row no bullet names is a heads-up —
   nothing checks or waits on it — advised about by id (**F43** `errand-row-unbound`):
   ```markdown
   ## Operator errands

   Every `!` line runs from `~/work/acme`.

   | Id | Phase · why | What only the owner can do | Exact steps | Expected | How the agent verifies |
   |---|---|---|---|---|---|
   | E-1 | 3 · third-party | restart the build box | `! bash ops/box.sh restart` then comment `restarted` on #14 | the box answers | `! bash ops/box.sh --check` |

   - **Human step:** operator-act · restart the build box after the upgrade (E-1) · open: bash ops/box.sh --check · proof: cmd:"bash ops/box.sh --check" · why: reach · due: phase:my-plan/3
   ```
   **Proofs** are read as the check reads them, through `scripts/cmd-ref.sh` (bash twin of
   `shared/proof-words.js` `cmdOfRef`). **F45** `proof-unparsable` (advisory): a `cmd:` ref with a
   shell variable, a substitution, an unclosed quote or a cwd-relative path, or a proof with no watch
   scheme (an escaped inner quote is the command's own: `cmd:"python3 -c \"import x\""` runs
   `python3 -c "import x"`; after `git` a `refs/…` word is a ref). **F46**
   `proof-script-run-branch-only` (advisory): a `cmd:` proof whose script (the first absolute path after
   `bash`, `sh`, `python3`, `node`…) is not on its repository's trunk, so the check reads `unrunnable`
   (exit 127, never a rejection) until it lands; Your turn shows **Cannot run**, never *Redo*. A
   changed bullet's proof is re-read at check time.
   `phase-graph.sh <slug> --human-steps [N]` reads them back (`0` for the plan's own; a ninth field, the
   `due:` ref, when named, and four more — why, effort in minutes, unblocks, guide — when any is named).
   **F37** (gate) fails the superseded `- **Human step:** <who, what, proof ref>` spelling
   (`human-step-superseded`, naming this grammar), a kind outside the eighteen
   (`human-step-kind-unknown`) and an unknown field (`human-step-field-invalid`). Advisories: **F38**
   `human-step-no-proof` (only a person's word can close it), **F40** `human-step-no-why` (given its
   kind's default reason, marked inferred), **F41** `human-step-no-guide` (an `operator-act`,
   `physical`, `third-party-approval` or `decision` with no `guide:`, no `options:` and no bound row —
   a title with no steps; kinds the console walks a person through itself are exempt).
   **`Target model:`** — an alias (`opus`), a full id (`claude-opus-5`), or either with the `[1m]`
   window suffix (`opus[1m]`, `claude-opus-5[1m]`), all parsed alike; the suffix, not the alias, claims
   the ~200K budget (`references/sizing.md`; names in `scripts/models.env`).
   `phase-graph.sh <slug> --model [N]` prints the model phase N runs — its `- **Model:**` bullet's first
   word, else the target model; with no argument the plan's alone; nothing when neither names one (the
   run's model answers). A session pinned to a model is held to it on every assistant frame: a
   mid-session fallback to another model parks the phase (#281).
   Example:
   > **Target model:** `claude-opus-5-5` (1M window) · **Budget:** ~200K weight/session (a preset of weight; the context target is 60% of the window) · **Branch:** current branch (no new branch).
   > **Skills (every session):** `design-system`, `some-plugin:test-first`
   > Hard-reasoning phases → Opus/Fable; balanced implementation → Sonnet; Haiku for subagents only.

   **`**Guide language:** <tag>`** — the language a person's-turn guide is written in (`fa`, `en`,
   `pt-BR`); silence means English. Read by the SESSION: it writes its `--guide` in that language and
   passes the tag as `--lang`; Your turn draws a right-to-left guide right to left, its commands left to
   right. A plan bullet's `guide:` file is written in it too (`references/turn.md` §The guide).
5. **`## Decisions`** — the **decision manifest**: every decision a run can need, answered BEFORE the
   run starts, so nothing asks a person mid-run. **Machine-read by both engines** —
   `scripts/phase-graph.sh <slug> --decisions [N]` and the console — one row per key of a closed
   vocabulary (`shared/decisions-model.js`; bash twin `scripts/decisions.env`):

   | key | value | owner | state | blocking | source | evidence |
   |---|---|---|---|---|---|---|
   | `credentials` | `gh` and the machine `claude` login | operator | answered | yes | plan | errand E7 |
   | `waits` | | dev-lead | outstanding | yes | plan | to be bounded before phase 6 |
   | `qa.exhausted` | QA is off on this plan | operator | waived | no | plan | decision 4 |

   Columns are located **by name**; `key`, `owner`, `state`, `blocking` and `source` are read with bold
   and backticks stripped, `value` and `evidence` as written. **The nineteen keys** (`DECISION_KEYS`):
   `permission.policy` (this plan's ask/deny/allow overlay, `autoApprove`) · `permission.destructive`
   (publishing and destructive verbs — `deny`, with named exceptions: a clause beginning `allow` naming
   backticked rules, the only thing that lets auto-grant answer the three publishing asks — `git push`,
   `gh pr create`, `gh pr merge` — and the one door through a session's console guard: a press named
   `Bash(phase-console <verb>:*)`, or `Console(<press>)` for a route no CLI verb presses, e.g.
   `Console(edit-policy)`; never a grant, an override or the owner keys; pushes below) · `issues`
   (`off`, `draft` or `file`, the `**Issues:**` word) · `credentials` (backticked ids + the credential
   policy) · `accounts` (in order, minimum headroom each, `onLimit`) · `mcp` (servers and MCP policy) ·
   `gates` (`Gate-check` on every gated heading; `delegated` or `operator`) ·
   `verification.person-check` (allow, halt or an owner when a §Verification fragment is prose) ·
   `qa.exhausted` (waive, halt or an owner once the round budget is spent) · `waits` (each expected
   wait: what, whose clock, the `--watch` ref, the maximum) · `human-acts` (steps denied to an agent,
   each with the ref that proves it landed) · `ambiguity` (ruling, ask or halt when the plan did not
   decide; also answers a session's mid-run question while no relay is armed) · `budgets` (run, phase
   and turn ceilings) · `resume.on-restart` (continue, hold or ask — the RUN's answer) · `plan-health`
   (whether the advisory lints gate this plan) · `stop` (`autonomy`, who is told on a halt) · `relay`
   (`off` or `last-resort` — a session's mid-run question is put to a person for 60 s, then answered by
   rule; it arms only on a CLI at or above `RELAY_CLI_FLOOR`, 2.1.268, else the `ambiguity` row
   answers) · `announce` (which categories push, to whom) · `plan-approval` (`hold` or `continue` — a
   plan-mode phase's presented plan waits for a person's Approve or Reject, or for nobody, the console
   journalling it as the record of what the session said it would do). **`state`** is `answered`,
   `outstanding` (somebody owes it — `owner` says who) or `waived` (deliberately open, the reason as
   value). `validate.sh` fails (**F25**) an outstanding row with no owner
   (`decision-outstanding-unowned`), an unknown key (`decision-key-unknown`), state
   (`decision-state-unknown`) or source (`decision-source-unknown`). **`blocking: yes`**: the start
   door refuses a run while the row is `outstanding`. **`source`** is `plan`, `run` (answered at run
   time), `default` (the shipped policy) or `ruling` (promoted from a session's ruling). Mode 1 elicits
   the rows one question at a time; the template's skeleton carries the operator's four shipped
   defaults `answered` (`gates: delegated` · `qa.exhausted: waive` · `resume.on-restart: continue` ·
   `ambiguity: ruling`); the console's policy table (`POLICY_DEFAULTS`, `shared/policy-model.js`) ships
   five more for a key neither the plan nor the console's `policy.<key>` answers —
   `verification.person-check: operator` · `credentials: continue` · `mcp: continue` · `relay: off` ·
   `waits: window` — and a row synthesised from one reads `source: default`. For `resume.on-restart`,
   `relay` and `accounts` the RUN's own launch-form answer outranks all of these.

   **How `permission.destructive` reads a push.** A clause the grammar cannot read narrows a grant,
   never widens one:
   - **A trunk** — `main`, `master`, `trunk`, or the run's base branch — is answered only by a clause
     about pushing that names it, backticked, with its phases right after it: `` `main` by phase 34 ``,
     `` push `main` in phases 35 and 144 ``. A whole `Bash(git push:*)` rule, a branch-scoped rule or a
     trunk without phases sends a trunk push to a person's card.
   - **A push rule may be scoped to a branch:** `` `Bash(git push:*)` of `pe/x` `` names `pe/x` the way
     `` `git push` of `pe/x` `` does, and lets nothing else be pushed.
   - **A negated phase list excludes.** `never`, `not`, `no`, `except`, `deny`, `refuse`, `forbid` or a
     `!` before a phase list (`phases !3`, `!3–5`) refuses those phases: `` `gh pr create` in phases
     4–33, except phases 30 and 31 `` grants 4–29, 32 and 33. A clause whose only phases are negated —
     `` `gh pr create` except in phases 30 and 31 ``, `phases !3` — grants NOTHING: write the phases it
     grants.
   - **A bare `git push`** (no remote and branch) is answered `deny`, naming the bare form to run alone.
     A force (`-f`, `--force*`, a `+` refspec), a delete, `--all`/`--mirror`/`--tags`, `--no-verify` or
     another remote goes to a person's card even under a whole `Bash(git push:*)` rule.

   **Later answers never edit this table.** They go to the mutable twin
   `docs/handoffs/<slug>/decisions.md`, written only by `scripts/decisions.sh <slug> [--phase N]
   answer <key> --value … | waive <key> --reason … | promote --from-ruling <id> --key <key> | list` —
   a value over 500 characters (an evidence over 200, a `--by` over 64) is refused with exit 2 and the
   limit named, never cut; split a long rule into `--phase N` rows. A person's Continue re-reads the
   rows into the run (`run.decisions-reread`; a resume no person pressed only journals what it held).
   `--decisions` merges the twin OVER the plan — a twin row replaces the plan's whole row for its key, a
   `--phase N` row replaces both for that phase — and prints one
   `key<TAB>state<TAB>owner<TAB>blocking<TAB>source<TAB>value` line per row, in vocabulary order (no
   manifest: nothing printed, lint clean). The boot prompt hands every phase its rows, `outstanding`
   first, with the session's one duty: declare a block **by key** —
   `phase-outcome.sh <slug> <N> blocked --needs <key>` — never in prose (`references/conventions.md`
   §Rulings). An act only the RUN can take — isolate, switch account, raise budget, stop, hold — is no
   key and no permission: `blocked --needs run --run-act <act>`, a run request the supervisor takes
   (Pro) or one approval per run and act asks a person for (`references/turn.md` §A run request). A
   ruling naming its key (`… ruling --needs <key> --remember plan`) becomes a twin row with
   `source: ruling` when recorded, and the inbox offers the same for any keyed ruling, so one plan's
   rulings seed the next plan's manifest (the plan wizard opens by reading these ledgers).

6. **`## Phase graph`** — a table that makes blocking vs parallel obvious. **This table is machine-read:**
   `scripts/phase-graph.sh` parses the `Depends on` column to compute live readiness, so keep it exact.

   | Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
   |------:|-------|-----------|--------------------|-------|---------------|

   Follow the table with an explicit callout:
   - **Blocking:** `1 → 2 → 4` (linear chains)
   - **Independent (any order; concurrent sessions when their scopes are disjoint):** `3a ∥ 3b`

   Dependency rules + parse format:
   - A phase lists **every** phase that must complete first in `Depends on`. Two phases are *parallel-safe*
     only if neither depends on the other **and** their **scopes** are disjoint (see the Repos column).
   - The `Depends on` cell accepts: a single number (`4`), a comma list (`4, 5`), a **range** (`1–7`,
     en-dash or hyphen, expands to 1…7), combinations (`1–7 (+8–10)`), or `—` for no dependencies. The
     parser keeps digits + range dashes and ignores other punctuation, so prose-y cells still parse.
   - The phase number lives in column 1 (**markdown-bold cells, `| **6** |`, are tolerated**) and
     nowhere else the parser could mistake it. After writing, run `scripts/phase-graph.sh <slug>` and
     confirm the parsed phase count matches the frontmatter `phases:` (it warns on mismatch). F1-tier
     gates on the shape: **F20** `table-shape-invalid` (columns not locatable by name: no header row, no
     `Depends on` or `Repos` column, a row shorter than the header); **F21** `table-cell-unbelievable`
     (a discarded `Depends on` token, a repeated Phase row, a zero-padded number, a phase with two
     handoff files) and `phase-section-repeated` (a `### Phase N` heading heading several sections;
     every reader takes the first alone — merge them).
   - **`Repos` is the SCOPE column, and it is machine-read**: the repos/paths the phase touches, which
     decide whether two sessions may run at once — write it for every phase. It accepts a
     comma/`+`/space list, `` `backticks` ``, **bold**, parenthetical asides (dropped), and paths
     (`packages/cart-api` stays one token; `/` never separates). `all` means everything; **an empty cell
     also means `all`**. `scripts/phase-graph.sh <slug> --repos N` shows the read. The cell is the ONLY
     declaration (`- **Scope …:**` bullets are prose); if a phase's reach differs, fix the cell.
     **A token must name something under the docs root** to be isolated: the root's own name, or an
     existing path beneath it (symlinks resolved). A token naming a repository elsewhere refuses
     isolation for THAT phase alone — it runs in the run's checkout with an unqualified lock claim,
     serialised against every claim it intersects (**F33** `repos-outside-root`, advisory, only when
     other cells are inside the root).
     **In a superproject, name the submodules a phase writes — not the root.** The root's name (`hub`)
     mounts the whole root and holds the phase behind any run holding the ROOT repository. A docs phase
     needs no root token (handoff, INDEX and locks are declared scope, `references/conventions.md`
     §Scoped concurrency; a gitlink bump commits by pathspec); keep it for root files outside `docs/`. **F34**
     `repos-root-token` (advisory): a cell naming the root in a phase whose `Files` bullet lists only
     submodule or `docs/` paths (no files listed: not judged).
     **F51** `path-no-dir` (advisory, #402): a Repos token or `Verify in:` path naming no directory
     under the docs root (`web/admin` where the repository sits at `admin`); a missing Repos token is
     named beside F33's sentence, and a plan with no token under the root (the hub shape) is exempt.
   - **Gated phases — mark, describe, categorize.** Mark `*(GATED)*` in the `### Phase N` heading, add a
     `- **Gates (must clear first):** …` line (the full conditions, possibly several lines; for human
     gates numbered step-by-step operator instructions — the boot prompt and the Gate card render it
     whole), and add `- **Gate-check:** <type> <value>`. The vocabulary (`scripts/gates.env`):

     | Type | Category | Cleared by |
     |------|----------|-----------|
     | `ai <one-line check>` | **ai** | a booted session: it verifies each condition, does the work to make failing ones true, records the clearance (`gate-approve.sh`), then implements. A person may also approve. **The default — bias here.** |
     | `manual <who/what>` | **human** | a PERSON doing the numbered Gates steps, then approving — the console's Gate card, or `gate-approve.sh` in their own terminal. Never a session, whatever the plan's `gates` row says (see below). |
     | `date YYYY-MM-DD` | auto | the calendar (opens on that date) |
     | `deadline YYYY-MM-DD` / `by …` | auto | staying before the date — after it, `OVERDUE` |
     | `phase N` / `phases N,M,…` | auto | those phases of THIS plan reaching verified |
     | `plan <slug>:<phases>` | auto | those phases of ANOTHER plan reaching verified (`--verified`'s set; `10,11`, `10, 11` and `10 11` read alike) |
     | `cmd <read-only command>` | auto | the command exiting 0 (executed only under `PHASE_EXEC_GATES=1` — the autopilot sets it; page views never do, and answer `unevaluated:` instead) |
     | `landed N` | auto | phase N's row in `docs/handoffs/<slug>/landing.md` reaching the state ITS landing policy ends at (`hold` → `held`, `integrate` → `integrated`, `pr` → `pr-merged`, `trunk` → `landed`) |
     | `pr-merged N` | auto | phase N's row reaching `pr-merged`, whatever its policy says |

     The two landing kinds read a FILE and run nothing (no `gh`, network or authentication); before any
     record (written by `scripts/phase-landing.sh`) they answer
     `blocked: phase N has no landing record yet (policy pr)`. One naming a phase the plan lacks fails
     **F29** `landed-gate-unknown-phase`.
     **The directive is required.** A `*(GATED)*` heading with no Gate-check reads as **ai**
     (`GATE_DEFAULT`), and `validate.sh` **fails** it (**F24** `gate-directive-missing`), as it fails an
     unlisted type (`gate-type-unknown`). `scripts/phase-graph.sh <slug> --gate-status N` evaluates any
     gate (exit 0 = clear; 1 = any other verdict, the WORD saying which: `blocked:` not met yet,
     `manual:` a person must act, `ai:` a session must verify and record, `OVERDUE:` a deadline passed,
     `unevaluated:` a `cmd` gate this caller did not run — nobody need act; re-read with
     `PHASE_EXEC_GATES=1`); `--gate-kind N` answers the category (`human` · `ai` · `auto` · `none`).
     **Approval is the one door for every kind:** `scripts/gate-approve.sh <slug> <N> [--by WHO]
     [--note TEXT]` records a clearance row in `docs/handoffs/<slug>/gate-status.md`, honoured by
     `--gate-status` before evaluating anything (`--revoke` restores the gate). Commit + push that file —
     a clearance exists only where it can be pulled.
     **`manual` means a person.** Whatever the `gates` decision says, a `manual` gate (and an unknown
     type, read as `manual`) counts only from a person's DOOR, which `gate-approve.sh` names from its
     own environment, never from `--by`, in `gate-status.md`'s sixth column, `Door`:

     | Door | When |
     |------|------|
     | `console` | the console wrote it for a person's press — the Gate card from a browser, a phone's signed Approve, a supervisor-chat act a person confirmed |
     | `terminal` | stdin is a terminal and no session marker is set — a person at their own shell |
     | `session` | a Claude session's environment: `PE_OWNER=autopilot/*` or `console/*`, `PE_OUTCOME_FILE`, `PE_SESSION_KIND`, `CLAUDECODE=1` |
     | `script` | anything else — a pipe, a cron job, a watchdog |

     The script refuses a manual gate from `session` or `script`, and from an `ai-*`, `autopilot*` or
     `console/*` approver at any door (exit 1, naming the Gate card and the `needs-human --needs gates`
     declaration); a revoke is taken from any door. `--gate-status` ignores, saying why, a manual row
     whose door is not `console` or `terminal` (a five-column row, a hand edit); a five-column table is
     widened in place on the next write, rows kept. A session clears an `ai` gate through any door.
   - **Size (optional, drives batching):** tag each phase's rough working-set in its `### Phase N` block —
     `- **Size:** S|M|L` (default `M`; `S` ≤ ~15K, `M` ~15–50K, `L` ~50–120K tokens).
     `scripts/phase-graph.sh <slug> --session-plan <model>` forecasts the plan in sessions and, for a
     person driving by hand, groups the remaining phases — sequential chains *and* independent siblings —
     while deps are met and the floor plus the slope × the summed weight stays under the target (GATED
     phases and QA boundaries always cut); the board prints `SUGGESTED BATCHES:`. See
     `references/sizing.md`.

7. **`## Phases`** — one subsection per phase, each self-contained:

   ```
   ### Phase N — <title>
   - **Goal:** what ships.
   - **Size:** S | M | L   (rough working-set; drives batching — see `references/sizing.md`).
     Optionally `- **Model:** <model>` (spelled as `Target model:` is) and
     `- **Effort:** low|medium|high|xhigh|max`, resolved by the autopilot from the operator's choice for
     the run, then these bullets, then the run's defaults — **per field**. The model may sit anywhere in
     the line (`**Model:** Opus — the hard reasoning`, `**Model:** claude-opus-5[1m]`); anything
     unrecognised is ignored. A `[1m]` phase is budgeted by its window, so it batches differently.
     `- **MCP:** \`server\`, \`server\`` — servers THIS phase needs beyond the plan's (`playwright` for a
     browser phase, `sentry` for triage): backticked registry ids, **unioned** with the plan-wide line.
     An operator may add more for one run, never untick what the plan named.
     `- **MCP policy:** require` (or `continue`) — **overrides** the plan-wide line (a plan-wide
     `require` can carve out a phase; a plan-wide silence can single one out). Any other word is
     silence, falling through to the plan, then the run; only an operator's per-phase choice outranks
     the bullet.
     `- **QA:** off` (or `on`) — overrides the plan's `**QA gate:**` the same way (exempt a docs,
     scaffold or deploy-checked ship phase; single out the phases that touch money). An exempt phase is
     never asked for a verdict, and a verdict recorded against it holds nothing; any other word inherits
     the plan. `scripts/phase-graph.sh <slug> --qa-mode <N>` reports the resolved regime and its level;
     `scripts/qa-mode.sh <slug> --phase N on|off|inherit` writes, replaces or (`inherit`) removes the
     bullet — the console's per-phase QA toggle.
   - **Read first:** exact artifacts to load (phase 1: just this plan; later: the prior handoff + this
     plan §Phase N + memory project_<slug>).
   - **Files to create/modify:** concrete paths.
   - **Steps:** high level — the `pN.taskM` task list is built at execution time, not here.
   - **Exit criteria:** a numbered list of **specific, independently verifiable** outcomes — each one
     confirmable by reading the code or running a command (e.g. "rejects empty input with HTTP 400", not
     "input handling works"). These ARE the contract the finishing session verifies, dependents rely on,
     and — when QA is enabled — the QA subagent checks; vague criteria get held to their strongest
     reasonable reading, so make them tight.
     Mirror the one-line summary into the Phase-graph table's `Exit criteria` column.
   - **Verification:** the concrete commands/tests proving each exit criterion — runnable, not narrative.
     Every command WHOLE and copy-runnable: an ellipsis fragment (`… -m "not slow" -q`) is refused by the
     runner's extractor and becomes a card a person must hand-confirm. Directory-dependent commands
     (`docker compose`, `pnpm`, `npm`, `task`, `pytest`, …) need `- **Verify in:** <path>` — a bare path
     on ONE line — or they run at the repository root. **Both shapes are machine-read** (backticked spans
     and fenced lines; prose is ignored; nested sub-bullets fold into the field, and nested bold labels
     like `**Verify in:**` stay addressable):

     ~~~
     - **Verification:**
       ```
       task audit:schema
       pytest tests/unit -q
       ```
     - **Verify in:** services/api
     ~~~

     or, equivalently, as nested bullets:

     ~~~
     - **Verification:**
       - **Verify in:** services/api
       - `task audit:schema`
       - `pytest tests/unit -q`
     ~~~

     **A command** is a lead from the runner's set (`npm`, `node`, `bash`, `bats`, `git`, `grep`,
     `test`, …) or a script path; `! grep …`, `2>&1`, a redirect into `/dev/null` and a `$(…)` inside
     double quotes are read; a backgrounded `cmd &` is refused; backticked numbers alone (`1`, an
     exit-code table) are not runnable. Under `- **Person-check:** halt` a fragment it will not run
     parks the phase at boarding, named with why. The **start door** asks first: the launch form's
     Decisions stage lists each, to approve by exact text (only where approval can make it run — never
     the deny wall, an off-machine write or an unparseable shape) or waive for the run, before anything
     spawns.
     **The §Verification lints** (`phase-graph.sh --explain F<n>` prints each in full):
     **F14** `verification-empty-open` (gate, `validate.sh`) — an open, not-done phase whose
     §Verification extracts nothing runnable (at run time it parks at boarding and, under keep-going
     autonomy, dispatches a plan-repair agent); a done phase and a closed plan are not gated.
     **F16** `verification-unbounded` — a wait on an external clock: `gh run watch`, a `task deploy`
     needing a CI-built image, a `--watch`/`wait` flag, `watch -n`, a `sleep` of a minute or more, an
     `until`/`while … do` poll loop (across fenced lines too; both readers fold the block to one line).
     Each command runs under a clock (30 minutes unless `Verify timeout:` or the line's history says
     longer); `docker compose up -d` RETURNS, so it is no wait (it is F22). The same vocabulary is the
     runtime guard: a supervised session's matching Bash call is **denied before it runs**, and one
     already open is parked (one waiting on a job the session started ITSELF is nudged first, parked
     later — `stallLocalJobMs`, 45 min).
     **F17** `verification-lead-missing` — a lead **not installed on this machine**: write `grep -R`
     not `rg`, `python3` not `python`; the autopilot SKIPS such a command (recorded, not failed), and a
     phase whose every check is skipped parks.
     **F18** `verification-cwd-unset` — a cwd-sensitive lead (`pnpm`, `npm`, `docker`, `task`,
     `pytest`, …) with no `- **Verify in:** <dir>` (or `cd <dir> && …` prefix).
     **F22** `verification-bring-up` — bring-up, not proof (`docker compose up -d`, `npm ci`, the
     `sleep 8` after them): move it to `- **Setup:**`.
     **F23** `verification-prose-expectation` — an **expected failure stated in prose** ("`task
     verify:local` — expected to fail until Phase 9"): encode it in the command (`! <cmd>`, or a grep
     for the specific error).
     **F32** `verification-fleet-wide` — an exit code reading **fleet-wide state** (`task hygiene`,
     `task drift`, a `ps … | grep`), which cannot pass while anything else is live. `task hygiene` has **no** scoped form (`--offline`, `--remote-only`,
     `--json`, `--stale-days N` stay fleet-wide; `--plan`, `--repos` exit 2): assert the plan's own
     footprint (`test -z "$(git -C <repo> status --porcelain)"`,
     `! git -C <repo> show-ref --verify --quiet refs/heads/<branch>`) and leave the fleet audit to a
     person after landing (`Gate-check: manual`). `task drift` reads no arguments: run
     `task drift:<gate>` or `task -d <main-tip checkout> drift`. Name one process by pid:
     `ps -o command= -p "$(lsof -tiTCP:<port> -sTCP:LISTEN)"`. Vocabulary: `FLEET_WIDE_READS` /
     `FLEET_WIDE_SCOPED` (`scripts/verify.env`); a scoped form excuses only its own `&&` member. Before
     the run's LAST phase's §Verification the console settles its own mirror branches the trunk already
     holds (0 commits ahead, or merging into it or `origin/<trunk>` without changing a path — a
     squash-merged PR) in every clean mount, the root included, and restores them before any later
     session (`run.mirror-branches-settled`, `run.mirror-branches-restored`).
     **F39** `setup-deps-missing` — a **package-manager script or `.venv/bin/*` binary in a repository
     the phase's Setup never installs** (an isolated checkout mounts each repository fresh, with no
     `node_modules` or `.venv`). The line's repository is its `**Verify in:**`, moved by a `cd <dir>` and
     the package manager's directory flag (`npm --prefix`, `pnpm -C`/`--dir`, `yarn --cwd`); a
     `.venv/bin/<x>` lead means that `.venv`'s directory. A script run is `npm run|test|start|exec …`,
     `npx`, `pnpm`/`yarn` running a script, or a `.venv/bin/*` binary (not `node`, `bash`, `git`).
     **Setup runs in the §Verification directory** and is read from there (under
     `Verify in: app/app-frontend`, `cd app/app-frontend && pnpm install` fails its `cd`). An install
     counts only for its ecosystem: `npm ci|install`, `pnpm install`, `yarn install` for node;
     `pip install`, `python3 -m pip install`, `<venv>/bin/pip install`, `uv sync|venv`,
     `uv pip install`, `python3 -m venv`, `virtualenv`, `poetry install` for a `.venv`. A directory no
     run mounts (absolute, `~`, above the root) or not placeable without running the line
     (`cd "$(…)"`, `cd -`) is not judged; one warning per repository and ecosystem. Fix: the install in
     `- **Setup:**`, spelled from Verify in (`npm --prefix web ci` under `Verify in: apps`).
     **F52** `verification-shared-checkout` (#423) — a §Verification or Setup line that `cd`s (or
     `git -C`s, `--prefix`es, `--dir`s) into an ABSOLUTE path under the docs root, the shared checkout on
     `main`, so an isolated run tests main. Spell it from `Verify in:` (`cd ../api` from `apps/web`,
     `cd apps/api` from `.`); the lint prints the relative form.
     **F19** `plan-cannot-progress` — the board: nothing ready, nothing in flight, a QA verdict holding
     every remaining phase; fires once, naming the rows. Exits ([qa-gating](../docs/qa-gating.md)):
     re-QA to `pass`/`waived` (`scripts/qa-record.sh`), `**QA gate:** off` (verdicts stay recorded), or
     close the plan.
     **An external clock: split, park or watch.** Prefer **splitting the phase**: a build phase proving
     what is provable now, and a verify/deploy follow-up behind `- **Gate-check:** ai <condition>` (or
     `cmd <observe-only command>`) that clears once the external process lands. A phase keeping an
     external-clock verification **parks at runtime as `waiting`**: the session writes an `in-progress`
     handoff, declares `scripts/phase-outcome.sh … waiting-external`, and the runner resumes it when the
     window elapses — capped at 4 waits / 8 h per phase unless the plan raises either (`Wait count:`,
     `Waits on:`). **`--until <ISO8601>`** names the window when the wall-clock moment is what you know
     ("not before the release lands at 09:00"), `--wait-minutes <M>` a duration — mutually exclusive,
     both valid with `blocked` and `needs-human` too (the clock decides when the console next brings the
     phase up, never replacing the ask). Better: a `--watch` ref, polled by the console, resuming the
     phase the moment it lands — the same nine schemes a session's `phase-outcome.sh --watch` takes and
     a `- **Waits on:**` bullet names:

     | Ref | Lands when | Use it for |
     |-----|------------|------------|
     | `gh:<owner/repo>#run/<id>` | the run reaches `completed`, whatever its conclusion | a CI run, a deploy |
     | `gh:<owner/repo>#pr/<n>` | the PR leaves OPEN, merged or closed | a review, an auto-merge |
     | `date:<ISO8601>` | that instant passes — resolved once, at that instant | "not before 09:00"; beside a live ref, only its backstop |
     | `unit:<host>/<unit>` | the systemd unit on that host leaves `activating`/`active`, its `Result=` and exit time going into the wait history — asked every 5 minutes over one shared ssh connection per host | a job on another machine, `unit:build-box/nightly-build.service`; the host's address, user, key and port come from `hosts.<host>` in `~/.config/phase-console/fleet.json`, and a host not named there is refused |
     | `lock:<slug>/<phase>` | nothing holds that phase's scope any more | somebody ELSE's lock, never your own |
     | `phase:<slug>/<N>` | the console's record of sibling phase N reads done, after its §Verification; un-lands if that phase is reopened | waiting on a sibling — never a `cmd:` grep of its handoff |
     | `verify:<slug>/<N>` | your own red §Verification lines all pass on one branch head, re-run whenever the head moves | your OWN phase, when its blocker is a sibling's red |
     | `cmd:"<command>"` | the command exits 0 — it is run, not read, under the §Verification policy | anything else, self-contained: absolute paths, no shell variables, no `cd`, at most 1,000 characters |
     | `credential:<id>` | the credential is present, read by NAME and never its value — `credential:gh`, `credential:claude`, `credential:env:<NAME>`, `credential:keychain:<service>`, `credential:file:<path>` | the proof of a `secret-entry` step: storing the secret proves it with nothing read back |

     A ref the console cannot run as written is refused where declared — `phase-outcome.sh` exits 2 and
     cuts nothing — and a ref the console mints for a refused in-turn wait obeys the same rules.
     **A session records what it proved:** `scripts/phase-outcome.sh <slug> <N> verified --command
     "<command>" --exit <status>` per §Verification command it runs (command, exit status, working
     tree). The console's own pass skips a command proven green at an equivalent tree (the same, or one
     where only `docs/handoffs/**`, `.locks/**` or `CHANGELOG.md` changed — for a `cd <sub> && …` line
     into another repository, one where that repository's tree is unchanged), runs the rest, and
     journals any disagreement. Its verdict is a GATE: a command red on its final attempt re-opens a
     phase whose handoff reads `complete` — direct dependents wait; one fix session, then an errand.
     **A timeout is not a red.** A cut command is retried ONCE by the console (no session) at twice its
     limit; a second cut is the `verify-timeout` outcome — no red verdict, no failure-streak charge — and
     the phase (and run) parks for a person to raise the limit or find the hang, then Re-check. A
     command that *exits* 124 itself is an ordinary red.
     **A red the phase inherited is not its own.** At first boarding a phase takes a **baseline** of its
     §Verification lines on the tree it boards on, before its session touches it: any plan's run of the
     line on that tree, environment and directory in the last day (named with source run and age), else
     a run BESIDE the session (niced, load-guarded, in a clean checkout of the boarding head, reported
     as a next-turn note; a superproject, which git will not export, is measured before boarding). A
     baseline red is measured once, never retried; the verdict waits for a running baseline. Reds are compared by the
     failing tests the output names (node's spec and TAP reporters, bats' TAP), else by the whole
     command. A red in the baseline is **inherited** — owned by the phase once charged with it, else the
     one phase whose sessions committed between its last green run and the base — and charged to nobody
     here; only the phase's OWN reds fail it. A red ABSENT from the baseline is attributed first: to the
     phase once charged with it (unless a later run was clean of it); to a sibling's **uncommitted
     work** when a tree clean of it (the session's proof, or a ledger run) differs from the red tree only
     in paths that sibling's session wrote and never committed (named); else to the one phase whose
     sessions committed in its range, only when the phase itself made none of those commits. A red `&&`
     chain is judged member by member, each run alone (a `cd`/`export` carried into each). A red with
     one owner is **owed** on that owner's record until its line runs green (`phase.verify-baseline`,
     `phase.verify-inherited`, `phase.verify-owed`).
     **Phase-finish runs these green before handing off** (Mode 3 step 1). Add a deterministic test per
     criterion you can; flag any only reasoned about. Re-check a CLI flag's current docs before relying
     on it, and note the check in the handoff.
   - **Verify in:** *(optional)* the directory those commands mean, **relative to the repo root** — e.g.
     `- **Verify in:** packages/cart-api`. Omitted, they run at the root (wrong for a monorepo phase:
     `docker compose run … -v "$PWD:/app"` mounts the whole monorepo). A path escaping the root or not
     existing falls back to the root (`phase.verify-in-missing`). A failing verification whose Repos
     column names one repo that IS a directory near the root makes the halt suggest this bullet; the
     console never picks one itself. Setup runs there too. The label is bold (`**Verify in:**`,
     top-level or nested under `**Verification:**`), the value a bare path (no trailing prose).
     `scripts/phase-graph.sh <slug> --verify-in <N>` prints it (empty: the root) — the reader F39 uses.
   - **Verify timeout:** *(optional)* how long ONE §Verification command of this phase may run before
     the console cuts it — `- **Verify timeout:** 90m` (the first duration after the label: `45m`,
     `2h`, `90 min`). A plan-wide `**Verify timeout:** 60m` covers every phase stating none; the
     bullet wins. With neither, the limit is 3× the longest of the line's last 10 measured runs, never
     under 30 minutes nor past 4 hours; a line never measured gets 30 minutes. Set it for a suite slow
     under load. The restart drain waits on the same limit.
     `scripts/phase-graph.sh <slug> --verify-timeout <N>` prints `minutes<TAB>phase|plan`, or nothing.
   - **Setup:** *(optional)* bring-up that runs **before** §Verification and is **never part of the
     verdict** — `- **Setup:** \`docker compose up -d\`, \`sleep 8\``. Its exit code cannot fail the
     phase, raise a card or colour anything red; a failure is recorded on `record.verification.setup`
     as context. Same extractor and wall as §Verification, widened twice: the `SETUP_LEADS`
     (`scripts/verify.env`) are recognised, and `docker`'s read-only gate admits `up`, `start`, `build`,
     `create`. **Every other reach-outside gate holds** — `ssh`, `psql`, `curl`, `gh`, `kubectl`,
     `redis-cli`, and `docker compose down` (it destroys volumes) — and `rm`, `git push`,
     `terraform apply`, `npm publish` and a script named for a verb of consequence stay refused. Each
     command is bounded at 10 minutes, at most 8 per phase. A plan-wide **`Setup (every phase):`** line
     in §Session budget is UNIONED with each phase's bullet, plan first. Setup runs in the `Verify in:`
     directory (spell paths from there) and is where a fresh checkout gets its dependencies (**F39**
     `setup-deps-missing`). `scripts/phase-graph.sh <slug> --setup <N>` prints what will run.
   - **Checkout:** *(optional)* the branch this phase's session works ON, when not the run's own. **The
     console acts on one value, the default branch** — `main`, `master` or `default` — meaning *do not
     stand this phase on the run branch*: board it **detached** at the trunk's head (a phase after the
     run's PR merged and `pe/<slug>` was deleted). A detached checkout owns no ref, so any number stand
     side by side; its lock, `branch=detached@<sha12>`, contends with nobody holding a real ref, and with
     another detached claim only on the same working tree. The console does the same by itself for a
     phase driven after the run settled and its branch is gone. Any other value is carried verbatim and
     acted on by nobody (**F35** `checkout-inert`, advisory): write `default`, or name the branch in
     prose. **`Checkout: main` is inert under a shared checkout**: detaching needs a checkout the run
     owns (its run tree or mirror). The launch names such phases beside `Worktrees: on` and
     `**Branch:**`, for the same honour-or-override answer. `scripts/phase-graph.sh <slug> --checkout <N>`.
   - **Wall-clock floor:** *(optional)* the phase's FIXED wall-clock floor (a full `gates.sh` run, a CD
     wait) — the least time it can take. **Separate from `Size:`**, which weights CONTEXT for batching;
     this is a clock an ETA cannot beat. `- **Wall-clock floor:** 95 min`, `2 h`, `1h 30m` or
     `1.5 hours`: one or more LEADING `<number><unit>` groups (decimals allowed, spaces optional), summed
     and rounded UP to the minute (`1h 30m` and `1.5h` both read 90); reading stops at the first other
     token (`95 min — a full gates.sh run` reads 95). No readable leading duration (`soon`, prose,
     empty), or zero minutes, is SILENCE. `scripts/phase-graph.sh <slug> --floor <N>` prints minutes or
     nothing; with no `N`, `N<TAB>minutes` per declaring phase, ascending.
   - **Handoff must record:** what Phase N+1 needs to start cold.
   - **Out of scope:** *(optional)* what this phase must NOT build — the bullet's text and its
     continuation lines (indented lines, nested bullets), up to the next top-level `- **Label:**`
     bullet. The independent evaluator reads it to tell a piece the phase left out from one it was told
     to leave; a reviewer reads it as the fence. `scripts/phase-graph.sh <slug> --out-of-scope <N>`
     prints it one trimmed non-empty line each, nothing when the phase has none (JS: `PhaseDetail.outOfScope`).
   ```

   **`## Not yet specified`** *(optional, plan level)* — a section of bullets naming what the plan knows
   it has not decided or written (a phase's exit criteria still a placeholder, a policy still open). It
   sits anywhere between the phases and the end-to-end section; `phase-graph.sh <slug>
   --not-yet-specified` prints its non-empty lines, nothing when it is empty or absent (JS:
   `Plan.notYetSpecified`). **`close-plan.sh --status complete` is refused while it holds a line**, and
   `--force` does not close over it — specify each item, or delete the line, first.

8. **`## End-to-end verification`** — how to test the whole feature once all phases land (run it, MCP
   checks, tests).

## Amendments — `scripts/amend-plan.sh` is the one writer

A plan is rarely edited after design, but work turns up (a deferred item a run set aside, a gap a phase
found). It enters as a new phase **numbered last** — the numbers are names, the graph is the order — and
only through `scripts/amend-plan.sh`, so every amendment has one shape and the console reads it one way:

```
amend-plan.sh <slug> --title "…" --size S|M|L --repos <csv> --depends <csv|-> \
              [--from <deferred-row-id>] [--gate "<type> <value>"] [--goal "…"] [--date YYYY-MM-DD]
```

It prints the new phase number and writes, **in this order** (each an atomic write, so a reader between
two never sees a graph row whose section is missing — #416, where the console read a GATED row before its
section and got an `ai` gate with an empty detail):

1. the `### Phase N — <title>` section, at the end of `## Phases` — Goal, Size, Depends on, placeholder
   Exit criteria and Verification, and the amendment bullet; with `--gate` the heading carries
   `*(GATED)*` and the section always has its `- **Gate-check:**` (a type not in `scripts/gates.env`
   is refused, exit 2);
2. its `## Phase graph` row, in the table's own column order;
3. the dated note under the plan's title;
4. the frontmatter `phases:` count, when it holds a number.

```
### Phase 41 — Retry policy *(GATED)*
- **Goal:** Cover the gap the evaluator found
- **Size:** M
- **Depends on:** 38
- **Gate-check:** cmd git -C phased-execution ls-remote --exit-code --tags origin v8.0.0
- **Exit criteria:** 1. TODO — name specific, independently verifiable outcomes before this phase boards.
- **Verification:**
  - `true`
- **Amendment:** 2 (2026-10-28) · from D-7
```

and, under the `# ` title (inside the provenance blockquote when there is one), one line per amendment,
K counting the notes there are:

```
> *(Amendment 2, 2026-10-28)* Phase 41 — Retry policy: Cover the gap the evaluator found (from deferred D-7)
```

The placeholders are the author's to replace before the phase boards (`true` only keeps **F14** quiet).
The result is linted; a problem the original plan did not have restores the original file (exit 1).
**F49** `amendment-malformed` (advisory) names the two halves disagreeing: a phase's `Amendment: K` with
no `*(Amendment K, …)*` note, a note naming a phase the plan lacks, or a line opening `*(Amendment` in any
other shape. A graph row marked `GATED` whose section is not written yet reads as a `manual` gate
(`--gate-kind` `human`, `--gate-status` `manual: phase N's section is not written yet`), never as the
`ai` default.

## Notes
- Size phases to the session budget (`references/sizing.md`): author the FEWEST phases that fit
  (≈ `ceil(total weight / budget)` plus earned boundaries — gates, model switches, user checkpoints);
  split anything that wouldn't fit one session's budget. Record the budget in `## Session budget` and tag
  phases with `Size:` so the engine can propose the session grouping.
- The plan is the only place the full roadmap lives. Handoffs link here; they never duplicate it.
- `memory:` may point to a pre-existing `project_<other>` key when this plan extends ongoing work.
  Document the override in the frontmatter comment and in a provenance blockquote under the title.
- **Exit criteria are the verification contract.** The finishing session proves them with the phase's
  §Verification commands before handing off; when QA is enabled (`**QA gate:** on` — off by default), a
  fresh-context QA subagent additionally re-verifies them and its results land in
  `docs/handoffs/<slug>/test-status.md`, gating dependents. Write criteria you could hand to an
  independent reviewer. Validate the whole plan with `scripts/validate.sh <slug>` before trusting the
  board (malformed rows, undefined deps, cycles, a table whose columns cannot be located by name, cells
  it read but could not believe, inconsistent handoffs).
- Scaffold with `scripts/new-plan.sh <slug>`; the literal template is `templates/plan.md`.
