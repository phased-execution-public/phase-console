# Plan format

Contents: Frontmatter · Sections in order (Title · Context · Architecture · Session budget · Decisions ·
Phase graph · Phases · End-to-end verification) · Notes

A plan is the durable blueprint for a multi-phase task. It lives at `docs/plans/<slug>.md`, is committed,
and is rarely edited after design. Each phase's detail must be **self-contained** — executable from the
plan + that phase's handoff with no prior conversation — because phases run in fresh sessions (usually
several phases batched per session, sized to the budget; see `references/sizing.md`).

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

`status` answers one question — **does anyone still care about this plan?**

Seven words answer it — **four open, three terminal**. Owner:
`viewer/shared/plan-vocab.js` `PLAN_STATUSES`; the engine treats every word that is not one of the three
terminal ones as open (`phase-graph.sh` `plan_is_closed`), and the portfolio sorts plans in this order.

| Status | Meaning | Board |
|---|---|---|
| `active` | open; work is expected to continue. The default a scaffolded plan gets | live |
| `approved` | open; signed off, not started | live |
| `proposal` | open; drafted, not signed off | live |
| `backlog` | open; parked deliberately, with intent to return | live |
| `complete` | closed, having finished | **closed** |
| `abandoned` | closed without finishing | **closed** |
| `superseded` | closed because another plan took over | **closed** |

The four open statuses are all the same to the engine — a `backlog` plan still reports ready phases and
boot prompts, because "nobody is working on it right now" is not "nobody cares any more". Only closure
silences a plan, and only `close-plan.sh` writes one: its `--status` accepts the three terminal words
alone, which is why parking a plan is an edit to `status:` and closing one is a script.

The last three are **terminal**. A plan with a terminal status is *closed*, and closure is what stops it
reporting: no stuck-handoff error, no QA-fail error, no missing-handoff/index-drift/stale-lock/
depends-drift warning, no ready phases, no boot prompts, no session batching, and no notifications. Its
board still renders in full — nothing is deleted or hidden — and genuine structural damage (an
unparseable graph, an undefined dependency, a cycle, an untrustworthy table shape, an unbelievable cell)
is still reported, demoted to a note so a broken
closed plan stays findable.

Closure is **not** the same as progress. Progress is computed from the handoffs and is never stored
(see `conventions.md` §Status source of truth); closure is an explicit operator decision, stored here,
and a plan may be closed with phases still unfinished. Set it with the verb, never by hand:

```bash
scripts/close-plan.sh <slug> --reason "why this stops here"     # → abandoned, dated
scripts/close-plan.sh <slug> --status superseded --reason "…"
scripts/close-plan.sh <slug> --reopen                           # → active, fields stripped
```

`--reopen` is always available, so closing is a reversible decision rather than a destructive one.

## Sections (in order)

1. **`# <Title>`** — optionally followed by a provenance blockquote if this plan continues prior work:
   > Continues from `docs/handoffs/<prior-slug>/phase-NN-*.md` and `~/.claude/plans/<scratch>.md`.
   > Memory key: `project_<key>` (pre-existing; NOT a new slug-named memory).

2. **`## Context`** — why this work exists: the problem/need, what prompted it, the intended outcome.
   If a prior handoff claimed incorrect state, add a **Reconciliation note** here:
   > **Reconciliation:** The phase-NN handoff claimed X was uncommitted — it is committed at sha XXXXXXX.
   > Use `git log` as the source of truth; ignore stale handoff claims.

3. **`## Architecture / approach`** — key design decisions; critical files **by repo**; reused utilities.
4. **`## Session budget`** — the model these phases are sized for + the per-session weight budget +
   the branch they commit to + (optionally) the **QA regime** and the **skills every session must invoke**,
   so a future session can re-check them all before building. Record the target model, the budget
   (~0.2 × the effective window in phase weight: 1M-class models → ~200K; Haiku → ~40K), any per-phase
   model overrides, the **branch** (default: the
   current branch — **no new branch** unless the user asked; then ONE branch for *all* phases, including
   independent ones), and — when the user named skills to use for this work — a **`Skills (every session):`**
   line listing them, **backticked** (e.g. `` `design-system` ``). The engine reads that line and
   re-injects those skills into **every** phase's boot prompt (and the QA brief), so each cold-start session
   re-invokes them rather than forgetting them.
   The same shape carries **MCP servers**: when the work needs one, add an
   **`MCP servers (every session):`** line naming them **backticked** (e.g.
   `` **MCP servers (every session):** `github`, `context7` ``). Those are *registry ids* from the
   Phase Console's MCP page — what the phase needs, never how to reach it, because the how is
   per-machine. The engine re-injects them into every boot prompt and the QA brief, the console
   attaches them to the session with `--mcp-config`, and checks them **before the phase is paid
   for** rather than letting a session improvise around a missing tool for an hour. A plan naming a
   server this machine has not registered is reported at plan time as an **F15** warning (advisory —
   it never fails the lint).
   **What happens when one cannot connect is a policy, and the default is to carry on.** The phase
   boards without that server, its prompt names the servers it did not get and instructs it to record
   the gap under **Outstanding** as an operator errand, and the console warns. Add
   `` **MCP policy:** require `` to §Session budget when the work genuinely cannot proceed without
   its servers, and the phase parks at boarding instead. The default moved because the park was
   answering for the phase that truly needs its server and firing for every phase that merely has one
   attached: `parked` is a settled status, so a run whose ready phases all park has nothing left to
   do — one signed-out server stopped an eleven-phase plan that named no MCP servers at all.
   **Keep the set small — three to six.** Every attached server puts its instructions and tool names
   in the system prompt of *every* turn, and attaching one mid-phase busts the prompt cache
   (`references/sizing.md`), which is why attachment happens at a phase boundary and nowhere else.
   **QA is off by default** — add a line with exactly `**QA gate:** on` ONLY when the user asked for QA on
   this work (then every phase-finish dispatches a fresh-context QA subagent); `**QA gate:** off` records
   an explicit waiver (rows written as `waived`, no subagents). Only that exact bolded form is
   machine-read (`phase-graph.sh --qa-mode`). The console's QA toggle writes this line through
   `scripts/qa-mode.sh <slug> on|off`, which is also the safe way to flip it from a session; by hand
   is equally valid.
   **A plan may also state review rules the engine cannot know** — put them in an optional
   `### QA contract` section (an H3, anywhere; §Session budget is the natural home). Its body is
   injected VERBATIM into every `--qa-prompt` brief, above the numbered steps and above the line the
   reviewer copies to record a verdict. Use it when the generic brief would be actively misleading:
   the brief offers `pass|fail|waived` because those are the three words `qa-record.sh` accepts, so
   a plan that has ruled one of them out has to say so somewhere the reviewer actually reads. Saying
   it only in prose elsewhere in the plan does not work — that reader is not the reviewer. The
   engine takes no position on what a plan demands (it neither parses nor validates the section); it
   only guarantees the demand arrives before the verb.
   **Worktrees are off by default too** — add `- **Worktrees:** on` ONLY when this plan's disjoint
   lanes should each get their own git checkout instead of sharing the run's. It changes nothing for
   a hand-driven session; it is read by Phase Console, which then runs each concurrent lane in a
   `git worktree` of the run branch under the instance root's `.worktrees/runs/<slug>/<runId>/` (or,
   with the *Worktree root* setting on `state`, its own state directory) and merges the lane back when it
   settles (a conflict halts the run, names both lanes, and loses nothing). It needs the console's
   **new-branch** git strategy, and **per-LANE** worktrees **refuse on a superproject**, because a linked
   worktree of a repo with submodules has EMPTY submodule directories and a scoped phase would board into
   nothing. Every refusal is journalled by name.
   **The superproject refusal was REOPENED and implemented** (the phase-14 deferral of
   console-concurrent-plans, superseded 2026-08-28): a run under a superproject root now takes a
   **MIRROR** — one linked worktree per scoped sub-repository, each on `pe/<slug>`, laid out at
   their root-relative paths under the run's `integration/` tree in that same `.worktrees/` folder; the superproject's own tree and its
   recorded gitlink shas are never touched. **Since 2026-09-05 the ROOT mounts too** — a scope that
   means the superproject itself (`all`, the root's name, a plain directory of it) is mounted as the
   mirror's first tree, with its initialized submodules checked out under it, so a plan that says the
   root's own name beside a submodule path — the ordinary monorepo-of-submodules shape — can have an
   isolated checkout at all; the old `root-scoped` refusal took the WHOLE run's isolation for one such
   token in one phase, and survives only as a vocabulary member so stored journal lines still render.
   Two refusals are still real and still named: `scope-unmapped`, for a token naming nothing or an
   uninitialized submodule (with the `git submodule update --init` hint), and `has-submodules`, for the
   plain non-mirror worktree of a superproject. The old
   blocker — branch qualification had no repository in it — was answered by the TREE dimension:
   two claims carve only when the branches AND the working trees both differ, so physical
   disjointness is proven by paths rather than inferred from ref names. Per-LANE worktrees still
   refuse on a superproject (phases share the run's mirror, serialized per scope), and the
   `integration`/`merge-queue` settles refuse a multi-repo run by name — use `pr` or `keep`. Full
   reasoning: `viewer/server/runner/worktree.ts` §Why it refuses on a superproject.
   See `references/sizing.md` for sizing and
   `references/conventions.md` §Branches for the branch policy. (The console may override the
   `**Branch:**` line per run with its own work branch — its sessions are told about the mismatch
   and record it in their handoffs; the line here stays authoritative for hand-driven sessions.)
   **The lines the decision manifest resolves from** (§Decisions below) live here too, each
   optional, each written plain like the MCP servers line, and each read by the engine or the
   console rather than by a person: **`Credentials:`** — backticked credential ids EVERY phase needs
   (`` **Credentials:** `gh`, `npm-token` ``), probed by the console's registry of named credential
   probes before a phase boards, never a value; `phase-graph.sh <slug> --credentials [N]` prints the
   plan line unioned with a phase's own `- **Credentials:**` bullet. **`Credential policy:`** —
   `require` (a phase naming a credential the console does not hold is refused at boarding) or
   `continue` (it runs, and the gap is reported); silence lets the run's setting decide, and a phase's
   `- **Credential policy:**` bullet overrides, exactly as MCP policy does
   (`--credential-policy [N]`). **`Accounts:`** — which Claude accounts a run may spend, in order,
   as backticked `id:minHeadroom` pairs (`` **Accounts:** `default:20`, `work:10` ``), the minimum
   five-hour headroom a percent (`--accounts` prints `id<TAB>min` per line). A credential or account
   the console has not registered is advisory (**F15**), like an unregistered MCP server.
   **`QA exhausted:`** `waive|halt|<owner>` (once the QA round budget is spent — `qa.exhausted`,
   `--qa-exhausted`) and **`Wait budget:`** (`48h`, `2d`, `90 min` — the TOTAL wall-clock one phase
   may spend parked across its declared waits, `waits`; the console's default is 8 h) are the
   console's to read at run start. The wizard also describes **`Permissions:`** (`permission.policy`),
   **`May publish:`** (`permission.destructive`) and **`When in doubt:`** (`ambiguity`) lines, but no
   engine or console code reads them — only the `## Decisions` row answers those keys, so write the
   row. Per phase, `- **Waits on:** <ref>[, <ref>…] · <max>`,
   `- **Human step:** <who, what, proof ref>` and `- **Person-check:** allow|halt|<owner>` refine
   the `waits`, `human-acts` and `verification.person-check` rows for that phase alone. `Waits on:`
   names what the phase waits on and, after the `·`, overrides the budget for that phase; a `date:` ref
   there countersigns a wait up to that instant. The console never shortens a declared window: one past
   what is left halts `waiting-external-timeout` with the arithmetic, which names these two lines as
   the way to allow it (`phase-graph.sh <slug> --wait-budget N` / `--waits-on N` print what it reads).
   **Spelling the model.** The `**Target model:**` value may be an alias (`opus`), a full id
   (`claude-opus-5`), or either carrying the `[1m]` window suffix (`opus[1m]`, `claude-opus-5[1m]`) — all
   parse the same. The suffix, not the alias, is what claims the ~200K budget (`references/sizing.md`;
   the name vocabulary is `scripts/models.env`).
   Example:
   > **Target model:** `claude-opus-5` (1M window) · **Budget:** ~200K weight/session (≈60% of the window) · **Branch:** current branch (no new branch).
   > **Skills (every session):** `design-system`, `some-plugin:test-first`
   > Hard-reasoning phases → Opus/Fable; mechanical phases → Haiku if run in their own sessions.
5. **`## Decisions`** — the **decision manifest**: every decision a run can need, answered BEFORE the
   run starts, so nothing has to ask a person mid-run (the sep-review audit measured 494 mid-run asks
   and found every one had an answer before the money was spent). **Machine-read by both engines** —
   `scripts/phase-graph.sh <slug> --decisions [N]` and the console — one row per key of a closed
   vocabulary owned once (`viewer/shared/decisions-model.js`; `scripts/decisions.env` is its bash
   twin), in this shape:

   | key | value | owner | state | blocking | source | evidence |
   |---|---|---|---|---|---|---|
   | `credentials` | `gh` and the machine `claude` login | operator | answered | yes | plan | errand E7 |
   | `waits` | | dev-lead | outstanding | yes | plan | to be bounded before phase 6 |
   | `qa.exhausted` | QA is off on this plan | operator | waived | no | plan | decision 4 |

   Columns are located **by name**, never by position (like the Phase graph's); `key`, `owner`,
   `state`, `blocking` and `source` are read with bold and backticks stripped, `value` and `evidence`
   as written. **The seventeen keys:** `permission.policy` (this plan's ask/deny/allow overlay,
   `autoApprove`) · `permission.destructive` (publishing and destructive verbs — `deny`, with named
   exceptions: a clause beginning `allow` naming backticked rules, the only thing that lets
   auto-grant answer `git push` / `gh pr create`) · `credentials` (backticked ids + the credential policy) · `accounts` (accounts in
   order, minimum headroom each, `onLimit`) · `mcp` (the servers and the MCP policy) · `gates`
   (`Gate-check` on every gated heading; `delegated` or `operator`) · `verification.person-check`
   (allow, halt or an owner when a §Verification fragment is prose) · `qa.exhausted` (waive, halt or
   an owner once the round budget is spent) · `waits` (each expected wait: what, whose clock, the
   `--watch` ref, the maximum) · `human-acts` (steps denied to an agent, each with the ref that
   proves it landed) · `ambiguity` (ruling, ask or halt when the plan did not decide; it also answers a question a
   session asks mid-run while no relay is armed) · `budgets`
   (run, phase and turn ceilings) · `resume.on-restart` (continue, hold or ask — the RUN's answer) ·
   `plan-health` (whether the advisory lints gate this plan) · `stop` (`autonomy`, who is told on a
   halt) · `relay` (`off` or `last-resort` — whether a question a session asks mid-run is put in front
   of a person for 60 s and then answered by rule; it arms only on a CLI at or above
   `RELAY_CLI_FLOOR`, 2.1.268, and below it, or under `off`, the `ambiguity` row answers) · `announce` (which
   categories push, to whom). **`state`** is `answered`, `outstanding` (somebody still owes it —
   `owner` says who; an outstanding row with NO owner fails `validate.sh`, **F25**
   `decision-outstanding-unowned`, as do a key outside the vocabulary, `decision-key-unknown`, a state
   outside those three, `decision-state-unknown`, and a `source` outside the four below,
   `decision-source-unknown`) or `waived` (deliberately left open, the
   reason as its value). **`blocking: yes`** means a run must not start while the row is
   `outstanding` — the console's start door refuses it. **`source`** is `plan` (this table), `run`
   (answered at run time), `default` (the shipped policy answered it) or `ruling` (promoted from a
   session's ruling). Mode 1 elicits the rows one question at a time; the template carries the
   skeleton with the shipped defaults (`gates: delegated` · `qa.exhausted: waive` ·
   `resume.on-restart: continue` · `ambiguity: ruling`) already `answered`. Those four are the
   operator's; the console's policy table (`POLICY_DEFAULTS`, `viewer/shared/policy-model.js`) ships
   five more for a key neither the plan nor this console's own `policy.<key>` answers —
   `verification.person-check: operator` · `credentials: continue` · `mcp: continue` · `relay: off` ·
   `waits: window` — and a row the start door synthesises from one of them reads `source: default`.
   (For `resume.on-restart`, `relay` and `accounts` the RUN's own answer from the launch form outranks
   all of these.)

   **Answers that arrive later never edit this table.** They go to the mutable twin
   `docs/handoffs/<slug>/decisions.md`, written only by `scripts/decisions.sh <slug> [--phase N]
   answer <key> --value … | waive <key> --reason … | promote --from-ruling <id> --key <key> | list`
   in exactly the shape the readers parse (the `qa-mode.sh` rule). `--decisions` merges the twin OVER
   the plan's rows — a twin row replaces the plan's whole row for its key, and a row written with
   `--phase N` replaces both, for that phase — and prints one
   `key<TAB>state<TAB>owner<TAB>blocking<TAB>source<TAB>value` line per row that exists, in
   vocabulary order (a plan with no manifest prints nothing and lints clean). The boot prompt hands
   every phase its rows, `outstanding` first, together with the one duty the manifest puts on a
   session: a block is declared **by key** — `phase-outcome.sh <slug> <N> blocked --needs <key>` —
   never asked in prose (`references/conventions.md` §Rulings). The other direction exists too: a
   ruling that names its key (`… ruling --needs <key> --remember plan`) becomes a twin row with
   `source: ruling` the moment it is recorded, and the console's inbox offers the same for any
   keyed ruling — which is how what one plan's sessions decided seeds the next plan's manifest
   (the console's plan wizard opens by reading these ledgers).

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
   - The phase number lives in column 1; **markdown-bold cells (`| **6** |`) are tolerated**, but don't put
     a phase's number anywhere the parser could mistake it. After writing, run `scripts/phase-graph.sh
     <slug>` and confirm the parsed phase count matches the frontmatter `phases:` (it warns on mismatch).
   - **`Repos` is the SCOPE column, and it is machine-read.** It names the repos/paths the phase touches,
     and that is what decides whether two sessions may run at the same time — so write it for every phase,
     not as decoration. Accepts a comma/`+`/space list, `` `backticks` ``, **bold**, parenthetical asides
     (dropped), and paths (`packages/cart-api` stays one token; `/` never separates). `all` means it
     touches everything. **An empty cell also means `all`** — the conservative default, and a phase that
     runs alone for no reason. Check what the engine read with `scripts/phase-graph.sh <slug> --repos N`.
     The cell is the ONLY declaration — nothing in the phase body overrides it. (Plans already use
     `- **Scope …:**` bullets for prose, and reading those as repo names would silently mis-scope a
     phase.) If a phase's real reach differs from its cell, fix the cell.
   - **Gated phases — mark, describe, categorize.** Mark `*(GATED)*` in the `### Phase N` heading, add a
     `- **Gates (must clear first):** …` line (the full conditions — it may span several lines, and for
     human gates it MUST be numbered step-by-step operator instructions; the boot prompt and the console's
     Gate card both render it whole), and add a category directive `- **Gate-check:** <type> <value>`.
     The vocabulary (one source: `scripts/gates.env`) and what each type means:

     | Type | Category | Cleared by |
     |------|----------|-----------|
     | `ai <one-line check>` | **ai** | a booted session: it verifies each condition, does the work to make failing ones true, records the clearance (`gate-approve.sh`), then implements. A person may also approve. **The default — bias here.** |
     | `manual <who/what>` | **human** | a person doing the numbered Gates steps, then approving (console Gate card, or `gate-approve.sh`) |
     | `date YYYY-MM-DD` | auto | the calendar (opens on that date) |
     | `deadline YYYY-MM-DD` / `by …` | auto | staying before the date — after it, `OVERDUE` |
     | `phase N` / `phases N,M,…` | auto | those phases of THIS plan reaching verified |
     | `plan <slug>:<phases>` | auto | those phases of ANOTHER plan reaching done |
     | `cmd <read-only command>` | auto | the command exiting 0 (executed only under `PHASE_EXEC_GATES=1` — the autopilot sets it; page views never do, and answer `unevaluated:` instead) |

     **The directive is required.** A `*(GATED)*` heading with **no** Gate-check reads as **ai** (the
     default `scripts/gates.env` names — `GATE_DEFAULT`; it read as human until 5.0.0, and the
     sep-review audit found 15 of 143 gated headings demanding a person by that accident alone) —
     and `validate.sh` **fails** it (**F24** `gate-directive-missing`), as it fails a directive whose
     type is not on the list (`gate-type-unknown`): the default answers the board, the lint makes the
     author say it. `scripts/phase-graph.sh <slug> --gate-status N` evaluates any of them
     (exit 0 = clear; 1 = every other verdict, and the WORD says which: `blocked:` not met yet,
     `manual:` a person must act, `ai:` a session must verify and record, `OVERDUE:` a deadline passed,
     `unevaluated:` a `cmd` gate this caller did not run — the one that means nobody has to do anything,
     re-read it with `PHASE_EXEC_GATES=1`); `--gate-kind N` answers the category
     (`human` · `ai` · `auto` · `none`). **Approval is the one door for every kind:**
     `scripts/gate-approve.sh <slug> <N> [--by WHO] [--note TEXT]` records a clearance row in
     `docs/handoffs/<slug>/gate-status.md` that `--gate-status` honours before evaluating anything
     (`--revoke` restores the gate). Commit + push that file — a clearance only exists where it can be
     pulled.
   - **Size (optional, drives batching):** tag each phase's rough working-set in its `### Phase N` block —
     `- **Size:** S|M|L` (default `M`; `S` ≤ ~15K, `M` ~15–50K, `L` ~50–120K tokens). Then
     `scripts/phase-graph.sh <slug> --session-plan <model>` groups the remaining phases — sequential
     chains *and* independent siblings — into sessions while deps are met and the summed weight fits the
     budget (GATED phases and QA boundaries always cut), and the board prints `SUGGESTED BATCHES:`.
     Absent any `Size:` tags every phase is treated as `M`. See `references/sizing.md`.

7. **`## Phases`** — one subsection per phase, each self-contained:

   ```
   ### Phase N — <title>
   - **Goal:** what ships.
   - **Size:** S | M | L   (rough working-set; drives batching — see `references/sizing.md`).
     Optionally add `- **Model:** <model>` if this phase wants a specific model — an alias (`opus`), a
     full id (`claude-opus-5`), or either with the `[1m]` window suffix (`opus[1m]`) — and
     `- **Effort:** low|medium|high|xhigh|max` if it wants a specific reasoning level. Both are
     machine-read: the Phase Console's autopilot resolves what a phase runs as from the operator's
     choice for that run, then these bullets, then the run's own defaults — **per field**, so naming
     a model here does not discard an effort, or the reverse. Write the model anywhere in the line
     (`**Model:** Opus — the hard reasoning` parses, as does `**Model:** claude-opus-5[1m]`); anything
     unrecognised is ignored rather than guessed at. A `[1m]` phase is budgeted by its window rather than
     by its family, so it batches differently — see `references/sizing.md`.
     Add `- **MCP:** \`server\`, \`server\`` when THIS phase needs servers the rest of the plan does
     not — a browser-driving phase wanting `playwright`, a triage phase wanting `sentry`. Backticked
     registry ids, same as the plan-wide line, and **unioned** with it: a phase gets the plan's
     servers plus its own. An operator can add more for one run from the console; they cannot untick
     what the plan named, because that is a statement about the work rather than a preference.
     Add `- **MCP policy:** require` (or `continue`) when THIS phase disagrees with the plan-wide
     line. Unlike `**MCP:**` this **overrides** rather than unions — a policy is one answer, and the
     more specific statement wins — so a plan-wide `require` can carve out the one phase that
     touches none of it, and a plan-wide silence can single out the one phase that must not proceed
     without its server. Anything other than those two words reads as saying nothing, which falls
     through to the plan and then to the run's own setting; only an operator's per-phase choice in
     the console outranks this bullet.
     Add `- **QA:** off` (or `on`) when THIS phase disagrees with the plan's `**QA gate:**` line.
     Same shape as the MCP policy above and for the same reason — a regime is one answer and the
     more specific statement wins — so a plan that gates on QA can exempt the docs phase, the
     scaffold, or the ship phase whose real check is the deploy, and a plan that does not gate can
     single out the two phases that touch money. It governs both halves: an exempt phase is never
     asked for a verdict at finish, and a verdict recorded against it holds nothing. Anything other
     than those two words reads as saying nothing and inherits the plan.
     (`scripts/phase-graph.sh <slug> --qa-mode <N>` reports the resolved regime and says whether it
     came from the phase or the plan; `scripts/qa-mode.sh <slug> --phase N on|off|inherit` writes,
     replaces or — with `inherit` — removes this bullet, and is what the console's per-phase QA toggle
     runs.)
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
     Every command must be WHOLE and copy-runnable: an ellipsis fragment (`… -m "not slow" -q`) is
     refused by the runner's extractor and becomes a card a person must hand-confirm — a real phase
     spent $45 and 68 minutes before its verification turned out to contain nothing runnable, which
     the console now parks on at boarding instead. Commands that depend on their directory
     (`docker compose`, `pnpm`, `npm`, `task`, `pytest`, …) need the phase's `- **Verify in:** <path>`
     bullet — a bare path on ONE line — or they run at the repository root.
     **Both of these shapes are machine-read** (the extractor sees backticked spans and fenced lines;
     prose around them is ignored; nested sub-bullets fold into the field and nested bold labels like
     a nested `**Verify in:**` stay addressable):

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

     `validate.sh` **fails** (**F14** `verification-empty-open`) on any open, not-done phase whose
     §Verification would extract nothing runnable — a gate since 5.0.0, where it used to warn: at run
     time the same defect parks the phase at boarding after the phase was paid for (and, under
     keep-going autonomy, dispatches a plan-repair agent to author the bullet from the exit criteria),
     and the audit found a prose-only verification card asking a person for twelve hours. A done
     phase is not judged about history, and a closed plan's issues are noted, not gating.
     Backticked numbers alone (`1`, an exit-code table) do not count as runnable.
     It warns (**F17**) when a command's lead binary is **not installed on this machine** — write the
     check with what exists (`grep -R` not `rg`, `python3` not `python`): the autopilot SKIPS such a
     command at verification (recorded, not failed), and a phase whose every check is skipped parks.
     It warns (**F18**) when a cwd-sensitive lead (`pnpm`, `npm`, `docker`, `task`, `pytest`, …) has
     no `- **Verify in:** <dir>` — verification runs at the repository root, where the command may
     test the wrong tree (a `cd <dir> && …` prefix also settles it).
     It also warns (**F16**) when a §Verification command **waits on an external clock** — `gh run
     watch`, a `task deploy` that needs a CI-built image, a `--watch`/`wait` flag, a `watch -n`, a
     `sleep` of a minute or more, or an `until`/`while … do` poll loop (including one written across
     several fenced lines: both readers fold the block to one line first) —
     because the runner bounds each verification command at 30 minutes and an unattended session cannot
     outlive its turn. One carve-out: `docker compose up -d` RETURNS, so it never counts as a wait —
     though it does earn an F22, being bring-up rather than proof.
     The same vocabulary is the console's runtime guard: a supervised session's Bash call matching it
     is **denied before it runs**, and one already open is parked (or, when it waits on a job the
     session started ITSELF, nudged first and parked much later — `stallLocalJobMs`, 45 min). Prefer **splitting the phase**: a build phase whose verification proves what is
     provable now, and a verify/deploy follow-up phase behind a `- **Gate-check:** ai <condition>` (or
     `cmd <observe-only command>`) that clears once the external process lands. A phase that keeps an
     external-clock verification will **park at runtime as `waiting`** instead of failing: the session
     writes an `in-progress` handoff, declares the wait via `scripts/phase-outcome.sh … waiting-external`,
     and the runner resumes it when the window elapses — capped at 4 waits / 8 h per phase.
     Two ways to name that window, and **`--until <ISO8601>` is the right one whenever the wall-clock
     moment is what you actually know** ("not before the release lands at 09:00"); `--wait-minutes <M>`
     is for a duration. They are mutually exclusive, and both work with `blocked` and `needs-human` as
     well as `waiting-external` — the clock only decides when the console next brings the phase up, and
     never replaces the ask. Better still where it applies: a `--watch date:<ISO8601>` ref, which the
     watch clock resolves once, at that instant, and which sits beside the other four schemes
     (`gh:` run/pr, `lock:`, `cmd:`) rather than being a separate mechanism.
     It warns (**F22**) when a §Verification line is **bring-up rather than proof** — `docker compose
     up -d`, `npm ci`, the `sleep 8` after them. Those belong in `- **Setup:**` (below): the runner runs
     Setup before §Verification and never marks the phase red for one, while the same line inside
     §Verification is a command the boarding preflight asks a person to vouch for AND a line that can
     turn a phase red for a reason unrelated to its work.
     It warns (**F23**) when an **expected failure is stated in prose** beside a command —
     "`task verify:local` — expected to fail until Phase 9". The runner executes the command and takes
     its exit code; the sentence is invisible to it, so the phase goes red. Encode the expectation in
     the command instead (`! <cmd>`, or a grep for the specific error), so the thing asserted is the
     thing run.
     It warns (**F19**) when the plan **cannot progress at all** — nothing ready, nothing in flight,
     and a QA verdict holding every remaining phase. Unlike F14–F18 this is not a claim about one
     phase's §Verification but about the whole board, so it fires once and names the rows responsible.
     The three exits are the ones in [qa-gating](../docs/qa-gating.md): re-QA to `pass`/`waived`
     (`scripts/qa-record.sh`), `**QA gate:** off` in §Session budget (releases the gate plan-wide;
     the verdicts stay recorded and reported), or closing the plan.
     **Phase-finish runs these green before handing off** (Mode 3 step 1). Add a deterministic test for
     every criterion you can; flag any that can only be reasoned about. Before relying on a CLI flag's
     semantics in one of these commands, re-check the tool's current docs and note the check in the
     handoff — a flag that changed meaning turns a green verification into a claim about nothing.
   - **Verify in:** *(optional)* the directory those commands mean, **relative to the repo root** — e.g.
     `- **Verify in:** packages/cart-api`. Omit it and they run at the root, which is right for a
     single-repo plan and wrong for a monorepo phase: `docker compose run … -v "$PWD:/app"` at the
     superproject mounts the whole monorepo. The autopilot honours this and records where it ran; a path
     that escapes the root or does not exist falls back to the root with a `phase.verify-in-missing`
     journal line. When a verification fails and the phase's Repos column names one repo that IS a
     directory near the root, the halt suggests this bullet — it never picks a directory on its own,
     because a wrongly-guessed cwd verifies the wrong tree and reports green.
   - **Setup:** *(optional)* bring-up that runs **before** §Verification and is **never part of the
     verdict** — `- **Setup:** \`docker compose up -d\`, \`sleep 8\``. A preamble that a plan used to
     have nowhere to put: 19 plans wrote it into §Verification, where every line is a command the
     boarding preflight asks a person to vouch for and a line that can turn a phase red for a reason
     unrelated to the work. A Setup command's exit code cannot fail the phase, cannot raise a card and
     cannot colour anything red; a failure is recorded on `record.verification.setup` as context for
     the §Verification failure that will follow. Same extractor and same wall as §Verification, with
     exactly two widenings so bring-up is possible at all: the leads in `SETUP_LEADS`
     (`scripts/verify.env`) are recognised, and `docker`'s read-only gate also admits the bring-up
     half (`up`, `start`, `build`, `create`). **Every other reach-outside gate holds** —
     `ssh`, `psql`, `curl`, `gh`, `kubectl` and `redis-cli` are judged exactly as in §Verification,
     and so is `docker compose down`, which destroys volumes and is not bring-up.
     `rm`, `git push`, `terraform apply`, `npm publish` and a script named for a verb of consequence
     stay refused. Each command is bounded at 10 minutes, at most 8 per phase. A plan-wide preamble every phase needs goes on one `**Setup (every phase):**` line
     in §Session budget and is UNIONED with each phase's own bullet, plan first — bring-up is ordered.
     Ask the engine what a phase will actually run: `scripts/phase-graph.sh <slug> --setup <N>`.
   - **Checkout:** *(optional)* which branch this phase's session works ON, when it is not the run's
     own. **One value the console acts on: the default branch** — `main`, `master`, or the word
     `default` — meaning *do not stand this phase on the run branch*: board it in a checkout
     **detached** at the trunk's head. That is what a phase after the run's pull request has merged
     needs, because `pe/<slug>` has been deleted and re-creating it would re-open the work the merge
     just closed. A detached checkout owns no ref, so any number of them may stand beside each other
     and beside whoever holds the branch; its lock is qualified `branch=detached@<sha12>` and
     contends with nobody holding a real ref — and with another detached claim only when the two
     name the same working tree, so two such runs at one commit run side by side. The console reaches the same
     state on its own for any phase driven after the run has settled and its branch is gone — this
     bullet is how a plan says so up front. Every other value is carried verbatim and acted on by
     nobody: a plan may document which branch it means without the console inferring a mechanism.
     Ask the engine: `scripts/phase-graph.sh <slug> --checkout <N>`.
   - **Handoff must record:** what Phase N+1 needs to start cold.
   ```

8. **`## End-to-end verification`** — how to test the whole feature once all phases land (run it, MCP
   checks, tests).

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
  `docs/handoffs/<slug>/test-status.md`, gating dependents. Write criteria you
  could hand to an independent reviewer. Validate the whole plan with `scripts/validate.sh <slug>` before
  trusting the board (it flags malformed rows, undefined deps, cycles, a table whose columns cannot be
  located by name, cells it read but could not believe, and inconsistent handoffs).
- Scaffold with `scripts/new-plan.sh <slug>`; the literal template is `templates/plan.md`.
