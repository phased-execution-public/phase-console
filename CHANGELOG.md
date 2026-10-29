# Changelog

This repository is a **published snapshot**, not a development history: every release is one push of
a materialized tree, so its commits say when a version was published and nothing about how it got
there. The per-version notes live on the Releases page instead, where each tag carries its own:

**https://github.com/phased-execution-public/phase-console/releases**

The version this tree is at is the `version` field of `package.json`, and the release with the
matching `vX.Y.Z` tag is its entry.

Installed as a Claude Code plugin, you are on the commit channel rather than a tagged one — every
push to `main` here is a release, and Claude Code refreshes installed plugins in the background — so
the Releases page is also the way to read what arrived since you last looked.

**This file is where those notes are written.** Each Release's body is the section below with the
matching version, published verbatim; keeping them here as well means a clone has the history
without a network round trip, and means the notes are reviewed as part of the tree rather than typed
into a web form at the moment of release.

## [Unreleased]

## [9.0.0] - 2026-10-28

**The session made cheaper, measured.** 9.0 is the work of plan `measured-console`: the skill is a
core and three mode files, a supervised session is told what it starts from at its start, the gate
runs every suite once and a phase verifies what it changed, the plugin is the skill alone, and a
phase session boots on 55K tokens where 8.0's booted on 111K. The free tree stays MIT. `PE_API` is
3: nothing an 8.x plan, session or script says changes meaning, except where *Migration* says so.

### Migration

Every entry names the file that owns what it changes. Nothing an 8.x plan says changes meaning: each new
plan line below is optional, read by both engines, and silent where a plan says nothing.

- **The skill is a core and three mode files** (`PE_API` 3, `PE_API_MIN` 2). `SKILL.md` is the console
  contract, the modes as pointers and the guardrails (under 16 KB); Mode 1–3 are
  `references/mode-plan.md`, `references/mode-phase-start.md` and `references/mode-phase-finish.md`,
  each read whole in its mode; the helper catalogue is `references/scripts.md`, and the engine prints
  its own (`phase-graph.sh --help`, `--explain`, `--section`); the maintainers' scripts are
  `docs/maintainers.md`. A console at `PE_API` 3 still runs a skill at 2, and a console at 2 runs this
  skill, so the 8.0 plugin and an updated console work together either way round. A flag added to a
  session-facing script is now a stamp bump, held by `viewer/test/skill-api-ratchet.test.ts`. Owner:
  `scripts/skill-api.env`.
- **The plugin is a materialized tree, and it carries its own hooks.** The skill installs as a
  skill-only tree of about 2.0 MB, and `assets/console.gif` is gone (the READMEs link the v8.0.0 tag's
  copy). `hooks/hooks.json` carries the four presence events, so `install-hooks` writes nothing over a
  config dir whose installed plugin already has them; `phase-console install-hooks --splice` keeps
  splicing them into `settings.json`, and while a spliced entry exists the plugin's copy stays silent
  (`PE_PLUGIN_HOOKS=1` overrides). `phase-console update-plugin` installs the tree (`--tree`).
  Owners: `scripts/build-plugin-tree.mjs`, `hooks/hooks.json`, `viewer/server/hooks-install.ts`.
- **`autopilotLoads` defaults to `console-set`**: an unattended session loads the console's own skill
  tree and the plugins in `autopilotPlugins` (default none, `name@marketplace` only), under
  `--setting-sources project,local` — the operator's user-level plugins, hooks and settings no longer
  load; their deny rules still do. Set `autopilotLoads: operator-config` to keep 8.0's behaviour.
  Owner: `viewer/shared/prefs-model.js` (resolved by `viewer/server/runner/loads.ts`).
- **The run's hooks block on failure** (`onFailure: "block"` on every hook the console registers): a
  hook that errors refuses the call instead of letting it through. The Stop hook's refusal now takes
  effect, so a session ending on red fast lines is held once; `- **Fast gate:** off` on a phase turns
  that off. Owner: `viewer/server/runner/approvals.ts` (`HOOK_ON_FAILURE`).
- **The gate's marker is a record in the common gitdir.** It was a bare sha at `git rev-parse
  --git-path phase-console-gates-ok`; it is now `phase-console-gates-ok` and
  `phase-console-gates-ok.json` under `git rev-parse --git-common-dir`, so a linked worktree counts for
  the repository. Only a green full-matrix `gates.sh` run on an unmoved, clean HEAD writes it (a dirty
  tree exits 2; a phase-tier run writes nothing), and the pre-push hook and the release's
  `--gates-passed` check refuse a bare sha or a record whose stages do not cover `gates.sh --list`. A
  `.build-rev` that is not HEAD fails both tarball gates. Owner: `scripts/gates-marker.sh` (written by
  `scripts/gates.sh`).
- **New optional plan lines**: `**Subagent model:**`, `- **Fast gate:**` and `- **May delete tests:**`
  (measured-console phase 6), `- **Skills:**` (11), `**Verification tier:**` (15), `**Evaluator:**`
  (22), `**Canary:**` (24), `**Plugins:**` / `- **Plugins:**` (27), `- **Out of scope:**`, `## Not yet
  specified` and `- **Amendment:**` (30) — each with a fixture, and each printed by its
  `phase-graph.sh` mode. Owner: `references/plan-format.md` (read by `scripts/phase-graph.sh` and
  `viewer/server/parse/plan.ts`).
- **The session model is re-fit**: 55K + 183K + 1.91 × weight, where it was 121K + 198K + 2.17
  (`reports/p33-after.json`), so `--session-plan` batches more weight into a session than it did under
  8.0. Owner: `scripts/sizing.env`.
- **`humanStepMode` defaults to `defer` on a CLI at 2.1.306 or later** (and `park` below it): a run
  that says nothing now pauses a person's step at its call instead of ending the turn. Set
  `humanStepMode: park` on a run to keep 8.0's behaviour, which is byte-identical in the journal.
  Owner: `viewer/shared/run-settings.js`.
- **`compaction` defaults to `console`**: nothing changes until a run chooses `native` or `alternate`.
  Owner: `viewer/shared/run-settings.js`.
- **The presence hook's SessionStart entry waits 15 seconds** (the brief). An install from before
  reads `brief: false` in `hooks-status` — presence still works and the boot prompt stays whole — until
  `phase-console install-hooks` refreshes the entry in place. Owner: `viewer/server/hooks-install.ts`.
- **A run's journal is a chain at its cap** (measured-console phase 17): at 32 MB `run-<id>.jsonl` is
  renamed `run-<id>.jsonl.<n>` (n from 1) and indexed in `run-<id>.jsonl.index` — `{n, file, firstSeq,
  lastSeq, bytes, offset}` per segment — and the fresh file opens with `journal.rotated`. `seq` runs on
  unbroken and every reader follows the chain; a tool that parsed `run-<id>.jsonl` alone should read
  the index's segments first. `journal.full` applies only past eight segments. Owner:
  `viewer/server/runner/journal.ts`.
- **A run's record persists incrementally** (`persistModel` 2): `run-<id>.json` is the base, and a save
  appends the records it changed to `run-<id>.json.delta` — one fsync — rewriting the whole file at
  most every minute, on a status change, or past a 4 MB delta. The first 9.0 boot rewrites every stored
  run once into the new shape and journals `run.persist-v2` on it. A tool that parsed `run-<id>.json`
  by hand sees every status change at once and other fields within a minute; fold the delta's lines
  past the base's `persistGen` for the rest. Owner: `viewer/server/runner/state.ts`.
- **Runs that never finished age out**: a halted, parked, paused or interrupted run untouched for
  `runRetainDays` (30) is pruned with its files, as a finished one always was. Owner:
  `viewer/server/retention.ts`.
- **Webhooks are signed and queued**: every POST carries `X-Phase-Console-Signature: sha256=<hmac>`
  over its body with the destination's secret (shown once at add; older rows get one at first boot),
  and a destination in backoff holds every announcement and delivers them in order when it is back.
  Owner: `viewer/server/webhooks.ts`.
- **`validate.sh`'s size warning is about the handoff's body now**, not its start section: a long
  generated section over a short body says nothing. Owner: `scripts/validate.sh`.
- **Words settled where they live:** nineteen decision keys everywhere (`issues` included); an
  unsupervised declaration lands as `outcomes/phase-NN-<stamp>.json`; a lock's branch AND tree carve
  two intersecting scopes apart; `**Wait budget:**` is the total one phase may spend parked; the
  default target model is `claude-opus-5-5`; Haiku is for subagents (a 200K window cannot hold a phase
  session's floor); `BUDGET_BIG`'s note says it is a preset, not a measurement; a session commits after
  each green step and leaves pushed history alone; the plugin listing's description is a paragraph,
  not a changelog. Owners: `references/plan-format.md` (the keys and the plan lines),
  `scripts/models.env` (the model ids) and `scripts/sizing.env` (`BUDGET_BIG`).

### Added
- **A person's step pauses the session at its call and resumes it in place.** Under the run setting
  `humanStepMode: defer` the hook defers the `phase-outcome.sh … needs-human` call itself, the console
  raises the item from the call, and when the person's check passes the SAME session carries on from
  that call: the script prints the answer (`--resumed-with`) and declares nothing. `park` keeps 8.0's
  park-and-resume. `phase.deferred`, `phase.deferred-resumed`.
- **A session's outcome arrives typed.** Every session that can declare runs under `--json-schema`
  (`viewer/shared/outcome-schema.js`, which owns the file's shape too); its `structured_output` is read
  before the outcome file, and a file naming a different word journals `phase.outcome-disagreed`. The
  script keeps writing the file, so a hand session declares exactly as before.
- **Native compaction is an arm.** `compaction: console | native | alternate` and `compactionWindow`
  (350,000): under `native` the session gets `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, the console's
  `PreCompact`/`PostCompact` hooks journal `phase.compaction` (before, after, the re-cache), the 0.8×
  checkpoint is off and the 0.6× line is a notice; `alternate` gives odd phases `native`. A resumed
  session's own `SessionStart` cost is kept (`phase.resume-cost`) and quoted by the next resume brief.
- **A wrap-up pushes what is green.** The 0.6× notice says commit AND push where the plan's
  `permission.destructive` row allows `git push origin <branch>`; `phase-outcome.sh partial` warns of
  every scope tree ahead of `origin/<branch>`; a checkpointed session's fast-forward is pushed by the
  console (to the origin it had before the session, under the hardened git); and the phase shows its
  unpushed commits — the inspector's *Unpushed* and a heads-up on Your turn — until a push lands (#397).
- **A supervised session is told what it starts from at its start, not in its prompt.** The presence
  hook prints the phase's brief at SessionStart — `phase-graph.sh <slug> --brief N`: the mode file to
  read, the phase's section head, the decisions still open, the notes earlier phases left, the scope and
  lock lines, the previous handoff's summary, the plan's errands and the memory index — within 10,000
  characters, stable content first and the session id last. With the hook installed and patient enough
  (`hooks-status` reads `brief`), the boot prompt leaves out what the brief carries (`PE_BRIEF=hook`):
  11,455 → 7,801 bytes on a 40-phase plan's phase 5. `next-phase-prompt.sh` still prints the whole prompt.
- **A plan's memory travels with the plan.** A run's settings file points the sessions' auto memory at
  `docs/memory/<slug>/` under the docs root — one directory for every config dir and lane, versioned
  beside the handoffs (`docs/memory/README.md` in the docs root says the layout). Mode 3 step 5 writes
  dated, commit-cited lines there, and `close-plan.sh` names every claim in `index.md` with neither a
  date nor a commit.
- **A handoff is a brief again.** It opens on a `## Summary` the brief hands to every dependent phase, and
  names `suggested_skills:` beside `skills_used:` — the next boot prompt's Skill-tool line reads them.
  `validate.sh` names a handoff whose body (without the frontmatter and the generated start section)
  passes 300 lines, and a secret's shape in any handoff or guide, by file and line.
- **I can't do this on every card of Your turn.** It is one press from the card, never folded under
  another. A task's, a decision's or an approval's turns the item into an errand carrying your reason,
  as before. On an item the console builds itself (a gate, a sign-in, a conflict, a stopped phase's ask)
  it is new: `POST /api/turn/:id/cannot {reason}` moves the item to Done as **Not doing** with your
  reason, leaves the blocker as it stands, and (on a console started with `--allow-run`) pins a note
  with your words on its run for that phase's next session. It is an authority press, fenced from a
  session like *Not doing this*.
- **A plan's own decision passes on one press, whatever key its answers file reads.** A decision
  whose proof greps a plan's answers file for a value (`grep -Eq '^deprecations: *[a-z]' …
  owner-answers.md`, the shape of every owner decision in a plan that keeps one `key: value` line per
  answer) came back on **Redo**: *Send my decision* recorded the choice, wrote nothing, and its proof
  read nothing. The press now writes the first line the proof's own pattern accepts — `<key>: <option
  id>`, which a plan's gate tool reads whole, then `<key>: answered — <label>` — and runs the proof,
  so the card goes to Done and the phases that wait on the key can board. A pattern no answer can
  satisfy is not written to. The card's steps say what the press writes instead of the `printf` they
  used to ask for. *Hand it to the AI* on a plan's own decision goes with the option the plan
  recommends (a plan decision that recommends nothing is not handed over), and the note on a plan's
  decision, which no session was waiting to hear, is pinned for the phases it unblocks.
- **Every decision on Your turn offers two ways on at least, and a box for your words.** An open
  decision the AI can take ends with *Hand it to the AI* (`POST /api/turn/:id/hand-off {note}`): a
  session's or a plan's decision is answered *decide it yourself* with your note, a stopped phase's ask
  resumes its session with the choice its own, and a branch conflict goes to Done with your words
  pinned on its run. A gate's Approve, which login a run goes on with, a sign-in, a secret and a
  permission are never handed over: the route refuses them with a 409. A note typed beside an option
  that takes no words of its own goes to the AI before the option is pressed
  (`POST /api/turn/:id/note {text}`, pinned on the item's phase), and the item stays as open as it was.
  A decision that can be handed over offers no separate *I can't do this*. A hand-off of an item the
  console builds goes through its run, so like the run's own verbs it needs `--allow-run`: without it
  the option is drawn off with the flag, and so is every option that presses a run's verb, and the
  route answers 403.
- **Every plan's status says why.** On Plans, a plan's status (its badge, and a run's or a person's
  word beside it) is a button: **Why** opens the panel on the reasons behind the word — what needs
  you, each item with the way to it on Your turn; what stopped its run, as the halt card with its one
  recommended recovery; which phases are running and since when; what it waits on and until when (a
  usage window's reset, its place in the queue, another session's claim, the phase before it, a gate
  that clears itself); what can start next; and, for a plan that is over, how it ended. The same
  record is Inspect's, and its Overview reads the plan live.
- **The plans table carries the plan's live facts.** Beside the status, the name and the line: *Now*,
  *Waiting on*, *Next up*, *Your turn* (its open items, and those to do now), *Left* with the estimate,
  *Spent* over every run, *Account*, *Model* and *Moved*. A desk that cannot fit them scrolls the table
  sideways with the status and the name pinned, rather than folding them away.
- **The engine prints its own catalogue** (measured-console phase 2): `phase-graph.sh --help` (every
  mode, one line), `--explain <F-code>` (one lint's paragraph, no plan needed), `--section N` (a phase's
  section, its graph row and the §Session budget lines that bind it) and `--brief N`. Three advisory
  lints: F50 `directive-mid-line`, F51 `path-no-dir`, F52 `verification-shared-checkout`.
- **A session's environment is set by the console, and a guard keeps its hands off the baselines**
  (measured-console phase 6). `BASH_MAX_OUTPUT_LENGTH` comes from `bashMaxOutput` (32,000); the
  subagents' model from a plan's `**Subagent model:**` line; `Explore`, `log-reader` and `docs-reader`
  run read-only. `scripts/guard-hook.sh` refuses a write to the baselines, ratchets, known reds,
  quarantine and snapshots, and a test file's deletion unless the phase says `- **May delete tests:**
  yes` (`phase.guard-denied`). The Stop hook runs a phase's fast lines once and holds a red exit
  (`phase.fast-gate`; `- **Fast gate:** off` turns it off).
- **The gate runs every suite once, and its marker is a record** (measured-console phase 7): the client
  is built once a commit, a run whose test file stopped part way fails (the suite ledger, in `npm
  test`, the gate and §Verification), `gates.sh --drain` holds the console's own work for at most an
  hour, and the bats suites run in four shards (`RUN_TESTS_JOBS`). The full gate took 6,443 s where
  8.0.0's took 12,611 s (0.51, `reports/p8-gate.json`).
- **A phase verifies what it changed** (measured-console phase 15): `**Verification tier:** impact`
  runs a heavy §Verification line in the form its diff selects (`scripts/verify-select.env`); a
  quarantined test is a gate stage whose expired row fails; the known reds (`viewer/known-reds.json`),
  `typecheck:test` and `lint:test` are ratchets that only tighten; `test:mutation` and
  `coverage:diff` report nightly and gate nothing.
- **The plugin is the skill and nothing else** (measured-console phase 10): a materialized tree of about
  2.0 MB (`scripts/build-plugin-tree.mjs`), its presence hooks in `hooks/hooks.json`, the GIF gone;
  `phase-console update-plugin` installs it.
- **What an unattended session loads is the console's choice** (measured-console phase 11): the
  console's own skill tree and the plugins switched on for autopilot (`autopilotPlugins`), under
  `--setting-sources project,local` (`phase.plugins`, `phase.hook`, `phase.skill-invoked`). A phase's
  `- **Skills:**` bullet and a handoff's `suggested_skills` become one *Call the Skill tool* line in
  its prompt, and F47 names a skill the sessions cannot load.
- **Settings ▸ Hooks** (measured-console phase 28): every hook a session meets, whose it is and what it
  does (`#/settings/hooks`, `GET /api/hooks`). A run's start writes its never list and its
  `permission.destructive` rows as hookify rules (`.claude/hookify.pe-<slug>-<rule>.local.md`).
- **Your turn reads what a pack leaves** (measured-console phase 29): a session that ends on prose
  questions and no outcome raises one Decision; gstack's `gate_pending` result raises an Approval (or a
  Decision on the gate), relayed back by the session; a wizard-shaped `guide:` file becomes a Task's
  numbered steps (`phase.pack-item`).
- **A plan says what it leaves out, and amends itself in writing** (measured-console phase 30): a
  phase's `- **Out of scope:**` bullet, a plan's `## Not yet specified` section (`close-plan.sh
  --status complete` refuses while it holds a line, `--force` included) and `scripts/amend-plan.sh`
  with the `- **Amendment:**` grammar (F49 `amendment-malformed`).
- **Logs ▸ Health keeps its history** (measured-console phase 31): *Over time* draws the health
  readings as a series (`GET /api/health/series`), and a phase journals its first edit
  (`phase.first-edit`).

### Changed
- **A phase session boots on half the tokens** (measured-console phases 3, 4, 5 and 33). `SKILL.md`
  is a core of 14.5 KB (it was 142 KB) with three mode files; the brief arrives at SessionStart; both
  `CLAUDE.md` files are pointer files. Measured over 20 sessions (`reports/p33-after.json`): the boot
  floor fell from 111K tokens to 55K, and `scripts/sizing.env` ships the re-fit 55K + 183K + 1.91 ×
  weight (it was 121K + 198K + 2.17), so `--session-plan` fits about 190K of weight into a 1M session
  where it fitted 129K.
- **The words agree with the code** (measured-console phase 16): eight destinations, the phone's tab
  bar, the four hook events, the journal's fields, the Issues default and the Queue sheet's *nearest
  order* (#412), the gauge's help and the halt table (#408) say what the console does.
- **One dated price book** (measured-console phase 18): `viewer/shared/price-book.js` (15 rows, read
  2026-10-17) prices every token the console counts, and a model it does not list reads *unpriced*
  instead of borrowing another's price; every dollar on a page is drawn by one component with one word
  for what it is.
- **Tower strips: colour that tells things apart.** Every status keeps its colour and its meaning,
  and gains two shades of the same hue: a vivid edge, the 4 px leading edge of a row or a card, and a
  tint, the ground of the ONE lead badge a row or a card carries (the thing it is about) and of a row
  opened in place. Every other badge stays outlined. Each shade is held to contrast in both lights and
  both rooms: the word on its tint at 4.5:1, the edge at 3:1 on every surface.
- **Tabs and section links are a bay.** The panel's tabs (Overview · Actions · History · Raw) and every
  page's section links are a recessed track whose current tab is a raised tile that slides to the one
  chosen; a section may carry a glyph and a count in a pill, in a state's tint when it counts one.
  Section links stay links, each an address.
- **Folds are strips.** A fold is a full-width head (the chevron on a round plate, the label, the count
  in a pill and a rule to the edge), its body on a rule down from the chevron, so a fold reads as a
  section rather than a grey line. Folds that belong to one record open as an accordion whose heads
  move with the arrow keys, each saying in one line what is folded.
- **Every drawer fits its content, on a phone and a tablet too.** A drawer is as wide as its content
  asks inside the bounds of what it holds (a picker, a reading, a form, a table), never past the
  screen less 2 rem, and never narrows while it is open. From 640 px it is a side drawer, so a tablet
  held upright reads a record beside the page; below 640 a bottom sheet whose handle grows it to the
  whole screen and back, and lets it go when dragged down. The panel's column fits the record it
  shows (a Your turn card opens at 34–52 rem where it was 400 px); dragging its edge sets a width, and
  a double-click on the edge, or Home, lets it go. A width the panel only ever had by default reads as
  the column that fits.
- **A Your turn card reads as a strip: the act first, the record after.** Its leading edge wears the
  person's status, its head carries the type as a neutral plate, NOW or NOT YET, the status as the one
  lead badge (with the attempt on Redo) and the errand's ref; its meta are chips. A verdict comes right
  after the head; then what you decide, do or approve — a decision's options as strips, the
  recommended one named, *Hand it to the AI* set apart under an "or" — and in the panel its primary is
  pinned to the drawer's foot. How it's checked, where it goes, its timing, a decision's steps and its
  history follow as folds that each say in a line what they hold. In the panel the card is the one
  title and the one status, and it lays itself out by its own width, wherever it is drawn.
- **One Handoffs & QA reading.** A plan's Phases readings are Table · Map · Handoffs & QA · Schedule ·
  Burn-up: QA and Handoffs were one table with two column sets, and are one now, in plan order, with a
  phase's handoff and its QA verdict side by side. An opened row leads with two record cards — the
  handoff (its status, when it completed, the link to read it, its size and skills) and the QA (its
  verdict, its round, what it holds, its reports and *Run QA*). `?view=qa`, `#/plan/<slug>/qa` and
  every report link open the merged reading, and the reading's tile counts its QA fails in red.
- **The phases grid is a rack of strips.** Each row's leading edge wears its state's hue, its number is
  a plate (`P17`) before its name, its state is the row's one lead badge and its QA, handoff and gate
  badges are outlined; an opened row sits on its state's tint with the edge running down its detail.
  The plan's two bays carry a glyph per view. A phase's and a run's record open as one accordion of
  fold strips, and *Why is this not done?* says in one line what it found.
- **Base UI joins Radix** (`@base-ui/react` 1.8.0, pinned exactly) for the tabs and the accordion; every
  overlay stays on Radix.
- **A plan's line is a pipeline with badges.** Every phase is a cell of the bar in its share's colour
  (up to 48 phases; past that each share is one stretch), the share done is a badge at the bar's end,
  and the legend under it is one badge per share — `41 done`, `1 in progress`, `3 waiting` — in the
  colour of its stretch, where it was one line of words. In the panel the cells stand in the phases'
  own order, each named on hover. The same line draws on the plan's glance, Your turn's *Where the
  plans stand* and the cards.

### Fixed
- **An approved gate leaves Your turn at once.** A gate approved on its card, or by `gate-approve.sh`
  in a terminal, stayed on the page until some other file of its plan changed, because
  `gate-status.md` did not move the plan's revision and the inbox kept its old answer.
- **A press on Your turn re-reads one plan, not every plan.** Approving a gate, or a conflict's *Leave
  them*, dropped every plan's cached board, so the next page read re-ran the engine for the whole
  portfolio (about 45 s on a console of 186 plans).
- **A press says it was sent.** *Approve* reads *Sending…* while it travels, and a press that went
  through holds its card as **Checking** with what was sent and when, with nothing to press again,
  until the console moves the item. *Show the choices again* brings them back.
- **A decision bound to a gate presses the gate.** Its own options were sent as an answer, which the
  console refuses for an item only its gate opens.
- **A stopped phase's card says what its session asked for.** An errand that names its session's
  decision draws that decision: its guide's numbered steps, its summary and its own options, each
  answered through the errand with the choice (`errand-answered {choice, note}`), even after the
  decision itself was closed. The ladder's own steps never send a person to read the handoff, and a
  branch conflict says in numbered steps what conflicts and how it can end.
- **The runner's register** (measured-console phase 13), each with the test that was red first: the
  reaper keeps a parked phase's watched processes and reaps a cut session's test servers (#409, #421);
  a mirror forks at the fetched trunk (#383, #403); a lane is re-kept (#417); a failed fetch on an
  asked-for update restarts nothing (#414); a phase's own credential and MCP policy hold on a retry
  (#379, #424, #425); `./start` refuses a bare argument that is not a directory (exit 2, #385).
- **The defects, durability and I/O** (measured-console phase 17): an open person's step survives the
  ledger's rotation; the `cannot`, `snooze` and `open` verbs are fenced from a session, a proof is
  redacted and a second confirm answers 409; an account's own defaults outrank the shipped
  `opus`/`max`; a refused preflight parks the run through its halt; no lock waits on `Atomics.wait`;
  one loopback test guards every local-only route.
- **A plan reads the same under every locale** (`LC_ALL=C`, #410), every directive on a shared
  §Session budget line is read (#419), `$'…'` quoting survives a §Verification line (#392) and a heavy
  test has its own timeout (#404).
- **Every sheet closes on Escape, and the route map is one Tab stop** whose stations the arrow keys
  move between (measured-console phase 32, #413).

## [8.0.0] - 2026-10-19

**Every open issue, fixed.** 8.0 fixes every issue that was open on 2026-10-17: Your turn becomes a
page you work from and the eighth destination, the phase graphs become instruments, any MCP server
signs in on the page, the runner's mirrors, lanes, landing, watches and gates stop losing work, the
load guard reads the machine's real CPU, and the console's own git is hardened. The free tree stays
MIT. `PE_API` stays 2: nothing a 7.1 plan, session or script says changes meaning, except where
*Migration* says so.

### Migration
- **The accounts registry is v2 in both editions.** A v1 `accounts.json` is upgraded in place on its
  first read and copied once to `accounts.json.v1.bak`.
- **A push is read by its clause.** A bare `git push` is now `deny`. A trunk (`main`, `master`,
  `trunk`, the run's base) is pushed only where a `permission.destructive` row names it with its
  phases (`` `main` by phase 34 ``); a negated phase list (`never`, `not`, `no`, `except`, `!`)
  excludes those phases, and a clause with only negated phases grants nothing. A forced or deleting
  push, `--no-verify` or another remote asks a person even under a whole `Bash(git push:*)` rule.
- **The console's own git ignores the system config** (`GIT_CONFIG_NOSYSTEM=1`) and runs no hooks
  (`core.hooksPath=/dev/null`). A credential helper set only in the system config (macOS
  `osxkeychain`) is no longer seen: set `credential.helper` in `~/.gitconfig`.
- **A plan's `**Branch:**` line names a branch only in backticks** (`` `pe/<slug>` ``); bare prose
  names none. A repeated `### Phase N` section fails the lint (F21 `phase-section-repeated`), and the
  JS parser joins it under the first.
- **`decisions.sh` refuses** a `--value` over 500 characters, an `--evidence` over 200 and a `--by`
  over 64 (exit 2) instead of cutting them.
- **The landing ledger moves forward only:** `phase-landing.sh` keeps a row that is further along and
  says so on stderr, unless `--allow-backward`.
- **`close-plan.sh --status complete` refuses** while the plan's work is unlanded, open or unfiled,
  naming each item; `--force` closes it anyway and records how many were open.
- **A press from a page of an older release is refused** with a 409 and a sentence asking for a
  reload (`x-build-rev`). The CLI, the scripts and the hooks send no such header and are never
  refused.
- **The load guard's `loadGuardFactor` keeps its name and changes its meaning:** it now scales a CPU
  reading (85 % busy over 30 s at factor 1.5), and the 5-minute load average is only a ceiling at
  factor × cores × 2.
- **Your turn is the eighth destination.** The phone's tab bar reads Runs · Your turn · Plans ·
  Sessions · More; 7.1's `?view=compact` on Your turn reads as the list.
- **`phase-outcome.sh verified`** writes `repo` and `repo_tree`, so a proof is keyed to its own
  repository.
- **New state:** `mcp/registry.json` under the instance's state directory (the MCP registry's
  24-hour cache).

### Added
- **Your turn is a page you work from** (#377, #366, #365, #334): the eighth destination and every
  plan's fourth view (`#/turn`, `#/plan/<slug>/turn`), with tabs (Open · Done · Handled by the AI ·
  All), four views (list, board, cards, timeline), five groupings and three sorts in the address; every
  status word explains itself on hover, focus and tap; the bell's drawer is a five-row preview with
  *Put back* (`POST /api/notifications/unread`).
- **The phase graphs are instruments** (#376, #364): the map's filter chips, trace, colour, layers,
  layouts, hover card and SVG or PNG export, each in its address; two new readings, **Schedule** and
  **Burn-up**; the timeline's zoom and quick ranges; and a lock map on Sessions ▸ Locks.
- **Tables and cards that say more** (#361, #360, #369, #362, #305): an outlined status badge, a plan
  track drawn to proportion with its legend, Sessions rows with what each runs on, its account, model,
  spend and context, a summary strip, the 6.x palette back as Settings ▸ Appearance ▸ **Palette**
  (`quiet` or `departures`), and the halt card on the Runs home.
- **Any MCP server, signed in on the page** (#363, #372): the open catalog searched here and cached,
  **Add by hand** for any server, **Fill it in** for a `${VAR}`, and **Sign in** told step by step;
  `phase-console mcp list | add --manual | fill`.
- **Waive this line** (#267): an operator waives one red verification line for one phase
  (`POST /api/run/<slug>/verify-waive`), listed under *Waived by the operator*.
- **Verification lines read *Timed out* and *Skipped*** as well as green and red (#331).
- **Two proof lints**, both advisories: F45 `proof-unparsable` (a `Human step:` proof the check
  cannot read) and F46 `proof-script-run-branch-only` (a `cmd:` proof whose script is not on its
  repository's trunk).
- **Two halts that name the tree:** `run-tree-config` (a session changed its tree's git
  configuration) and `run-tree-locked` (a git lock file nothing is writing blocks the tree).
- **The doctor says more** (#343, #279): a deliberately disabled launchd unit is told from a broken one
  with the line that enables it, and a check it cannot see is said, not passed.

### Changed
- **The console's own git is hardened** (#272), and a push is read by its clause (#276, #275) — see
  *Migration*.
- **The load guard reads the machine's real CPU** (#243, #223): busy over 30 seconds, every console's
  work and in-turn bursts counted. A heavy verification line waits for a seat in one machine-wide
  budget, journalled `phase.verify-queued` (#327), and a session's orphaned test runners are reaped at
  its end (#222).
- **`close-plan.sh` closes `complete` only once the work has landed** (#320).
- **A handoff's ▶ Start next phase(s) section is a pointer** to `next-phase-prompt.sh`, composed when
  read (#338); `new-handoff.sh --force` rewrites the INDEX row it supersedes (#265); a note keeps its
  indented sub-bullets (#378); and every watch scheme is documented (#233).
- **Switching a run's account is a run act**, under `--allow-run` alone (#323).
- **Every CLI verb reaches the CLI** (#359), and a release packs the client it names (#358).
- **The boot prompt's wait procedure names the `pgrep -f` trap** (#260): a wait on text in its own
  command never ends; wait on the job's pid or a file it writes.

### Fixed
- **Your turn's presses and proofs** (#368, #367, #371, #351, #374, #345, #350): *Send my decision*
  sends once and then checks the proof; an item bound to a gate closes when the gate opens; a reminder
  keeps a returned item on Redo; a proof whose script is missing reads **Cannot run** instead of
  failing you; and one reader reads every `cmd:` proof.
- **Your turn's inputs** (#346, #349, #393): a `Human step:` inside an HTML comment is ignored,
  `--needs issues` is classified as itself, and the page's touch targets are full size.
- **The graphs draw no text over text** (#375, #299, #342, #306): below 9 px only numbers show, marks
  that share a spot read `✎×4` or `●+3`, the track sits behind its labels, a Runs row keeps its count
  on one line, and the run clock counts frozen time once.
- **Small things on screen** (#339, #335, #315): a chart's heading is named, short code tokens do not
  break, and a dropdown fits the screen.
- **An update never paints the old release** (#373), this browser is found by its push endpoint
  (#325), a placeholder delivery counts as no device and no failure (#314, #324), and a repaired push
  clears its health row (#280).
- **Mirrors and verification** (#356, #357, #311, #301, #328, #333, #262, #283): a run's mirror grows
  when its plan adds a repository, a docs-only line runs where the docs are, `Verify in: .` means the
  plan's tree, a proof is keyed to its repository, an orphaned `index.lock` is named, a resolved run's
  trees are swept, the artefacts register credits only a phase's own trees, and an unexpanded `$VAR`
  is never taken for a path.
- **Lanes and landing** (#354, #295, #370, #336, #249, #240): a phase keeps its lane while it holds
  work in the shared tree (`run.lane-held`), the landing proof fetches and recognises a squash or
  pull-request merge, and the landing ledger never moves backward.
- **The lint and the decisions** (#225, #228, #226, #235, #322, #253): a sibling's half-written
  handoff no longer fails your lint, a repeated phase section does, a person's resume re-reads the
  decisions, the Branch line is read right and a shared launch asks about it, and an over-long
  decision is refused rather than cut.
- **Watches and gates** (#337, #303, #245, #264, #239, #288): a watch beside a long `cmd:` row is
  asked, Resume re-asks a settled wait, Recheck works on a waiting ref, a live run re-reads its held
  gates, and a phase whose dependency is not done is held, never boarded (`phase.dependency-held`).
- **Detectors and in-turn waits** (#219, #220, #259, #260, #292, #274): a phase serial behind a live
  lane is not undriven, the watchdog holds while a tool card stands, a turn ends without a ten-minute
  idle wait, a wait loop whose `pgrep -f` matches itself is refused, a wait on a detached job's file
  arms its own `cmd:` ref, and a git ref after "held by" is not read as a lock.
- **The inbox answers without lag** (#237).
- **Accounts** (#238, #287, #281): a run's start goes to the first account with room, the usage brake
  keys to the account a session really spends, and a pinned model is checked on every frame, so a
  fallback mid-session parks the phase.
- **The tests are hermetic and say why they fail** (#353, #352, #344, #294, #291, #297, #329, #326,
  #316, #394, #289, #302, #313, #241, #318, #246, #256, #230): `tests/run-tests.sh` scrubs every
  `PE_*` and `DOCS_ROOT` before bats, a test process's usage poller reads no meters unless given one,
  and a test file that stops mid-run fails the gate.

## [7.1.0] - 2026-10-13

**Your turn, told step by step.** 7.1 makes every item on Your turn a card a person can act on without
reading anything else: one of four types — an Approval, a Task, a Decision or a Heads-up — with
numbered steps, NOW or NOT YET and when, a timing grid, where a press goes and who checks it, and one
act form for its type. Every word on the card comes from one composer, so the bell, the Runs home, the
lock screen and the page say the same thing. What only the run can do, what went stale and what the
AI could do itself no longer reaches a person as a chore. The free tree stays MIT. Nothing a 7.0
plan, session or script says changes, and `PE_API` stays 2: an item a 7.0 console raised keeps its id
and state and gains the new words when it is read.

### Migration
- **The page's groups are v2** (`TURN_GROUPS`): *Approve* · *Do now* · *Decide* · *Being checked* ·
  *Coming up* · *Done*, placed by the item's type and readiness, with *Handled by the AI*, *Heads-up* and
  *Where the plans stand* as sections. 7.0's *Needs one detail from you* is gone: such an item is a Task
  on Redo in *Do now*.
- **`GET /api/turn` gains the card contract** on every item — `type`, `personStatus`, `readiness`,
  `route`, `checkedBy`, `timing`, `steps`, `verdict` and `verdicts`, and `options` or `approval` where they
  apply — plus `strip` and `headsUp` on the answer. Every field 7.0 sent is still there.
- **A plan's `Human step:` bullet takes three more keys**, `options:`, `recommended:` and `deadline:`,
  validated by both parsers and printed by neither, so `phase-graph.sh --human-steps` is byte-identical;
  its `guide:` key is now read as a file under the docs root (F42 `guide-file-missing` gates).
- **New routes:** `POST /api/human-steps/:id/undo` and `POST /api/run/:slug/run-request` (an authority
  route). A run verb pressed from a card carries `expectRunId` and answers 409 with a sentence when the
  plan's run is another one.
- **New state files** under the instance's state directory: `turn-first-seen.json` (when a projected
  item was first seen) and `turn-settled.json` (how a pressed projected item ended).

### Added
- **The card** (`client/src/cards/turn/`): NOW or NOT YET with its *when*, the type's mark, the
  person's status (*To do*, *Checking*, *Passed*, *Redo*, *Not doing*, *Closed*, *Waiting for the
  owner*), the title that names the act and its meta, a timing grid on one page clock (*Assigned*, *Do
  it*, *Deadline*, *Open until*, *You sent it*, *Checked*), why only you, once, the verdict before the
  steps, *From the AI*, the numbered steps, *How it's checked*, *Goes to* and *Checked by*, and one act
  form per type, its primary chosen by one move table. Every command a person runs is one command
  block, and a command with a `<placeholder>` is a template to fill in.
- **The page**: a strip (to do, checking, passed today, the next deadline) under the headline; one
  toolbar row whose Filter (Status, Time, Plan, Type, Goes to), Group, Sort and View live in the
  address; *Heads-up*; and *Where the plans stand*, one line per plan. `#/turn/<id>` marks its card and
  opens the panel on it where the panel stands beside the page.
- **One composer** (`server/turn/compose.ts`) writes every word of every item and of its inbox row
  and push. Steps come from the authored guide, else the plan's errands row, else the situation's own
  words, else a minimal guide from the link or command and the check said in words
  (`shared/proof-words.js`); no proof ref, route or "phase 0" reaches a person.
- **Plan-born guides**: a `Human step:` bullet's `guide:` file is read, and a plan's `## Operator
  errands` table is read by its headers; a bullet ending in `(E-N)` takes that row's steps, and a row
  no bullet names is a Heads-up. New advisories F41 `human-step-no-guide` and F43
  `errand-row-unbound`, and the gate F42 `guide-file-missing`.
- **What each situation asks**: every ask the console raises carries a title, steps, a check and
  options bound to their verbs; a gate, a plan approval, a permission and an owner request carry an
  approval block (what, who asked, if approved, if denied); an identity park offers exactly its two
  choices.
- **Where a press goes**: *Undo: I'm not finished* takes back a running check; a press that ends an
  item waits a few seconds on the page with *Undo*; *Hand it back* gives an item back to its phase
  (*Give back to Phase N*), asks its session a question, or says you cannot; a pressed approval card, gate,
  plan approval or question leaves a record, so Done shows how it ended, by whom and when.
- **Run requests**: `phase-outcome.sh … blocked --needs run --run-act <act>` asks the run to relaunch
  isolated, switch account, raise a phase's budget, stop or hold — one Approval per run and act, every
  asking phase a waiter; Approve takes the act and resumes them, Deny tells them no.
- **Items that close themselves**: a stopped run a later run of its plan supersedes is resolved by
  itself (journal `run.superseded`, undone by `unresolve`), and the round closes its run-specific items,
  those of a phase the board reads done and those whose errand is gone — each with a row under
  *Handled by the AI* — while a sign-in, a secret or an errand at the machine moves to the new run.
- **Every surface in the card's words**: the Runs home's and the bell's rows lead with NOW or NOT
  YET and the type, and a push's lock screen is chosen by type — a Task *Open* and *I did it*, a run
  request *Approve* and *Deny* on a console with `--allow-run`.
- **The help guide's *Your turn*, in English and Persian**, explains the four types, the statuses,
  NOW and NOT YET, the timing grid, *Goes to* and *Checked by*, *Undo*, *Hand it back* and run
  requests; the README, USAGE, `viewer/README.md` and `references/turn.md` say the same.
- **Tests**: every card the console can raise is walked in both editions and held whole
  (`viewer/test/turn-cards-coverage.test.ts`), and the tower rehearsal drives a card's round trips on
  real consoles.

### Changed
- **A permission is approved at a scope** — *Approve, this call* to *Approve, always* — and sits in
  *Approve*, where *Grant every low-risk ask* now stands.
- **A decision's button is *Send my decision***, and nothing is chosen for you.
- **The identity park skips a superseded run** and never overwrites an operator's stop.
- **An operator's act is an act of its phase**: two phases asking for one command are two items,
  each on its own clock (#261, #257).

### Fixed
- **`human-step-model.test.ts` expects the births there are** (#271).
- **An inbox row no longer reads a human step's window as a question's countdown** (#341).
- **An act due at a date ahead reads *Coming up*, not notified at once** (#255).
- **An answer pressed while its run is still parking reaches the run** (#273), and **an in-process
  resume through an automatic door no longer takes the person's slot** (#268).
- **Your turn's panel says a person's reason once** (#332).
- **A section heading's count keeps its gap right to left** (#296).
- **A run request a live run declares raises its item** before the run reaches disk, an answer that
  arrives first raises the item and answers it, a hold released on a parked run resumes the phase that
  waited, and a Done run request keeps its approval block.

## [7.0.0] - 2026-10-12

**Quiet.** 7.0 rebuilds the console's web client from zero around one question — *does anything need
me?* — answered in two seconds and fixed in one move, with everything else one expansion away. Seven
places (Runs · Plans · Sessions · Repo · Insights · Logs · Settings) under one shell; one line per
thing, a status drawn as a dot and a word, and three doors to depth on every page — **expand** in
place, **inspect** in the panel, and **Everything**, a per-page switch that shows every column, fact
and section. Every option the server has now has a door a person can reach: a registry names each
route, event, setting and operator verb with the page that offers it, and a test holds it to the
server both ways. The whole client works on a phone and a tablet, mirrored right to left, and stilled
for anyone who asks for less motion. The free tree stays MIT. The server, the runner,
the scripts and the skill are the same as 6.2's: nothing a 6.2 plan, session or script says changes,
and `PE_API` stays 2.

### Migration
- **Every 6.2 address still lands, in one hop, with its query** (`client/src/shell/redirects.ts`):
  `#/now…` and `#/ready` on the Runs home, `#/queue` on its Queued group, `#/approve` on Your turn,
  `#/debug[/<section>]` on Logs, a 6.2 Runs bay (`?bay=`) on its group (`?group=`). A bookmark, a push
  and a link a session wrote keep working.
- **Debug is Logs.** The place is `#/logs/<section>` — Logs, Journal, Delivery, Health, Access — and
  its chunk is `logs-*`.
- **The run page folds into its plan.** A run is a plan's Run view, `#/plan/<slug>/run`, with its
  earlier runs at `?view=history`; the Tower's six bays are the Runs home's groups.
- **New read routes, no flag and no journal line:** `GET /api/prefs/schema` (every preference with its
  type, default, section, description and where its value came from), `GET /api/ceiling`,
  `GET /api/credentials` and `POST /api/credentials/probe`, `GET /api/doctor/strays`,
  `GET /api/sizing`, `GET /api/report`, `GET /api/run/:slug/proofs` and
  `GET /api/run/:slug/verifications`.
- **A preference can be reset.** Settings ▸ Everything resets a key to its default, and a write keeps
  only what the file held, what the write set and what differs from the default — so a reset leaves
  the file rather than pinning the default in it.
- **First paint is held at 170 KB served** (it was 190), in this build and the free one: the free
  tree's gate now runs `check:dist` on its own client build.
- **The 6.x client is gone.** `viewer/client/src/` holds `ui/`, `cards/`, `shell/`, `screens/` and
  `data/` beside `lib/`, `styles/` and `content/`; the 6.x app, features, components and lib/api
  directories and lib/queries.ts no longer exist. A patch or a fork against a 6.x client file has
  nothing to apply to.

### Added
- **The map: seven places in three bands** (`DESTINATIONS` in `shared/route-meta.js`), the same in
  both editions. The rail from 900 px carries the instance switcher, the seven places, Help and the
  account meter; the header the page title, the situation words, search (⌘K) and the bell; below
  900 px a tab bar — Runs · Plans · Sessions · Insights · More.
- **Three doors on every page.** Expand opens a row where it stands and remembers it. Inspect puts a
  record in the panel — a column at 1200 px and up that stays open across pages, a sheet from 900 to
  1200, a bottom sheet on a phone — on four tabs, Overview · Actions · History · Raw. Everything is a
  per-page switch at the end of the toolbar. Every list's toolbar is one row in one order: search ·
  Filter · Group · Sort · View · ⋯ · Everything, and one View sheet on a phone.
- **The Runs home** (`#/runs`): the situation sentence as its heading, then Your turn, Running,
  Waiting, Queued, Ready to start and Settled today, one line per run with exactly one action — a
  halted run's comes from its halt first (#278) — and All runs as a table view.
- **Your turn** (`#/turn`) on the 7.0 cards: the headline and the round, six sections, every item's
  explanation in the panel (`GET /api/turn/:id`) and *Withdraw* among its moves.
- **Plans and a plan.** The library is one line per plan — mark, name, line, sessions left, moved —
  as a list or cards, with closed plans and documents folded. A plan opens on its glance over three
  views: Phases (one table with the spine in its identity cell, and the route map), Run (the run's
  folds: sessions and their consoles, where the time went, why it started and what it cost, what the
  ladder tried, ways forward) and Source.
- **One launch form** with a quick view: the departure line and its route, the findings in order, the
  turns it will ask for, presets, and nine rows that open in place at every width.
- **Sessions** (`#/sessions`): every lane, terminal and Claude session on one grid, a session full
  height, and the locks with their holders, narrowed by the server.
- **Repo** as six addressed sections — History, Branches, Working trees, Changes, Settles and the
  Issues desk — each record in the panel.
- **Insights**: how long is left, what it costs, what a session may spend, this week's measurements,
  velocity and approvals, each question answered by the server's own arithmetic.
- **Logs**: the explorer and its live tail, the journal on a Gantt, delivery, health — the doctor, the
  start ceiling and stray consoles — and access, plus the redacted bundle.
- **Settings** as one place: an index with what each section holds, a section per address, search that
  answers sections and keys with their controls, and **Everything** — every key the server describes,
  with its value, default, origin, reset and, for a key only the CLI or the machine sets, the line
  that sets it.
- **The palette's *do*:** every operator verb, each saying when a capability flag disables it; and the
  panel's *Actions* tab per record kind.
- **The surface registry** (`client/src/data/surface.ts`): every route, server event, settings key
  and operator verb, each with its door or an exemption naming its caller, held both ways by
  `viewer/test/surface-parity.test.ts` with nothing left unassigned.
- **The help guides describe 7.0**, in English and Persian: Runs home, the launch's one screen, and
  Getting around's card per place and its three doors.

### Changed
- **Status is a dot and a word** (`client/src/ui/status/`): the eight hues at one weight paint a 6 px
  dot, a track segment or a row's edge, never a chip behind text; settled things wear a hollow dot.
- **One type face at four sizes, one cool neutral room in two lights**, rows separated by space, a card
  only around a thing acted on as a unit, and one shadow, for overlays. The design law is
  `viewer/docs/design.md`; every rule in it names its guard.
- **One stream per browser.** A second tab no longer breaks the first (#236): one tab holds the
  console's event stream and shares it with the others, and a session console asks for its run's
  stream only while it is on screen.
- **Lists read projections**, the slim run list for the home and the header, the full record only for
  the open run (#234's client half).
- **A long token breaks only where it must.** A path, a slug, a label or a command in a cell or a
  sentence wraps at its own spaces first and breaks inside a word only when the word alone is wider
  than its box (`wrap-anywhere`, where 6.x broke every word at the line's end).
- **Phone, tablet, right to left and reduced motion are proven in a real browser** on every
  destination: the three doors by thumb at 360 and 768 px, every stop mirrored under `dir="rtl"`,
  text finding its own direction, and motion stilled when the system asks.

### Removed
- **The 6.x client** — its app, features, components and lib/api directories, lib/api.ts,
  lib/queries.ts and the two helpers only they used — every shim, every lint exemption and every
  frozen allowance that kept them, and seven dependencies only they used (`react-hook-form`,
  `@hookform/resolvers` and five Radix primitives).

### Fixed
- **The phone's situation line has its inline padding** (#284).
- **The owner's confirm prompt shows the request it confirms** — the body it replays, never a
  self-chosen label (#277).
- **An item leaves Your turn only when the server says so**, so a grant's Allow no longer dismisses an
  item before the grant is known to have applied (#270).
- **A decision step's options are its primary moves**, and a proof re-run reports its exit (#266).
- **Retention's settings save** (#317).
- **Settings ▸ Essentials ▸ Keyboard lists the keys the help sheet does**: ⌘K, `/`, ⌘I, Esc and the
  panel edge's arrows (part of #334).
- **Tests red only under the full gate's load** — the write menu, the figures, the help sheet, the
  rehearsal and the notifications specs — were rewritten with the screens they drive (#247, #227, #269).
- **Two node suites red since the rebuild began** — a stray status reader and a free package file list
  missing a shared module (#293).

## [6.2.1] - 2026-10-08

**The public tree names no paid package.** A patch to 6.2.0, with nothing to migrate: two strings in
an end-to-end fixture named the paid package, and 6.2.1 gives the fixture a neutral package name. The
free tree stays MIT. Nothing a 6.2 plan, session or console does changes.

### Fixed
- **The tests name no paid package and no paid route** (#282). An end-to-end fixture
  (`viewer/e2e/fixture/seed.ts`) named the paid package in an item's proof and in a permission's
  command; both now name a neutral one, `acme-widget`. Two server suites, `inbox.test.ts` and
  `console-forge.test.ts`, spelled routes only the paid tree serves; the free tree's copies assert each
  action's verb and method instead.

## [6.2.0] - 2026-10-08

**Your turn.** 6.2 gives every act only a person can do one page, one shape and one road back to the
work that waits on it. A sign-in, a code, a secret, a payment, a permission the AI lacks, a decision,
an errand at the machine: each is an item on Your turn (`#/turn`) that says why only a person fits it,
carries a guide to follow and a proof the console checks, so *I've done this — check* comes back
passed, or sent back with exactly what to redo, and no session can pass its own. A permission ask is
answered by a grant with a scope and an end — this call, this phase, this plan, this repository or
always — that the server applies, audits and can revoke, beside a never list no door lowers. An owner
key, a passkey, lets a console tell its owner's press from any other door's. The console keeps the
page current by itself, and the approval, gate, question and errand cards elsewhere draw the item and
link to it. The free tree stays MIT. Nothing a 6.1 plan says stops working — what moved under people's
feet is below.

### Migration
- **Update the console's scripts and the plugin together.** `PE_API` is 2, and a run refuses to start
  when the console's and the skill's stamps do not meet, naming the half to update. A 6.1
  `phase-outcome.sh` takes none of a person's turn's new flags and never exits 4.
- **A person's turn carries a reason.** A `needs-human --step` declaration says why only a person fits
  it — `--why`, one of ten reasons, held to what its kind allows — and one that names none is given its
  kind's default, marked inferred, so an older skill copy and `--act` keep working. A plan's
  `- **Human step:**` bullet gains `why:`, `effort:`, `unblocks:` and `guide:`; a bullet with no `why:`
  draws the advisory F40, never a gate.
- **A step needs a proof.** A step with no `--proof`, no `--proof-words` and no answer for a result is
  refused (exit 2); name `--proof-type attest` to take the person's word.
- **Exit 4 is the guard's.** `phase-outcome.sh` exits 4 when a declaration asks a person for what the
  AI could do itself — a `permission` or `reserved` reason whose every guide command the run's own
  policy allows, a `reach` with no `--tried` — or a permission block cites no wall the console
  recorded (G5). Read 4 as "run it yourself", never as a malformed call; `--tried` is the answer when
  running it failed.
- **"Done — continue" is *I've done this — check*.** A person errand is an `operator-act` item, and its
  row's action, like every check button, reads *I've done this — check*. A check now comes back with a
  verdict — passed, rejected with exactly what to redo, or needs-info — rather than "landed or not",
  and a probe that misses leaves the item `returned`, where it used to read `notified`.
- **The `secret-entry` field is gone.** The console never takes a secret: `check` refuses a body that
  carries one, and the item names where the value goes instead — the keychain item `phase-console-<id>`
  on macOS, a 0600 file elsewhere, or the item's own `credential:` place.
- **`#/approve` redirects.** `#/approve` and `#/approve?step=<id>` land on Your turn (`#/turn`,
  `#/turn/<id>`) in one hop, so a bookmark keeps working; a push opens `#/turn/<id>`.
- **A grant has a scope and an end.** The approval card's Allow with *remember*, the widen card's Allow
  and a standing card's one-time allow are grants now — `call` (spent on use), `phase` (until it
  settles, 24 hours at most), `plan`, `repository` (a new policy layer between the plan's file and the
  machine's) or `always` — each a row in `grants.ndjson` saying exactly what it changed, and a revoke
  undoes exactly that. The widen card no longer strikes a rule from the plan for good. A grant below
  plan scope lowers the rule in that run's settings until it ends, and for that long the CLI's own list
  does not hold the rule with the console dead.
- **What an owner key changes for a script that presses the console.** Nothing until a key is enrolled:
  a console with none behaves as before, and `/api/state.ownerDoor` reads `unenrolled`. Once one is,
  an authority press from a script, the CLI, a browser with no key, a phone beyond its low and medium
  answers or a session's token is answered 202 `{requested: true}` — recorded on its item as "asked by
  <label> — confirm?" and pressed only when the owner confirms — so a script reads 202 as waiting for
  the owner, never as done. What the plan's manifest already allows still executes through any door.
  `by` in a body is only a label: the door a request proves is recorded as `pressDoor`, and a request
  carrying a session's token presses no authority route its plan's `permission.destructive` row does
  not name (403, `owner.door-refused`).
- **A turn's push names its buttons by kind**: *Open* and *I did it* for an act, *Allow* and *Deny* for
  a low or medium permission at its narrowest scope, *Open* and *Deny* for a high or never one, *Open*
  for a decision. Quiet hours are one setting, the device's: at the first boot a console-wide
  `reminderQuiet` window moves onto every subscribed device that has none of its own, and is dropped.
- **For readers of the vocabularies:** a person's turn has an eighteenth kind, `permission`, and eleven
  states with `returned` and `declined`; `viewer/shared/turn-model.js` (twin `scripts/turn.env`),
  `viewer/shared/guide-grammar.js` and `viewer/shared/door-model.js` are new owners; the push catalogue
  has a twentieth category, `granted`.
- **`git send-pack` and `git http-push` are walled like `git push`** (control-tower phase 141): two
  default deny rules, the same on every profile. A plan that publishes through either names the rule in
  its `permission.destructive` row, as it names `git push`.
- **A guide line may not hold an invisible or direction-changing character** (control-tower phase 141):
  a control character, a zero-width space, a bidi embedding, override or isolate, a word joiner or a
  byte-order mark refuses the guide at that line, and a link holding one is not openable. The joiners
  and the direction marks (U+200C–U+200F) stay, so a Persian guide reads as before.

### Added
- **The docs say what 6.2 adds, in English and Persian** (control-tower phase 140). The help sheet's
  *Your turn* guide is rewritten around the page — its six sections, why only you, the guide, the check
  and its verdicts, your other moves, the phone — and *Permissions* says what a grant is (its five
  scopes, its risk tiers, its end, the ledger and the revoke), names the never list and the three
  publishing asks auto-grant never answers (`git push`, `gh pr create`, `gh pr merge`; it said two),
  and gives the owner key a section that ends with what the key is not: *a process running as you that
  deliberately rewrites the console's own files can forge anything below the owner key, and can replace
  the key registry itself; the console walls the paths a session takes and makes every grant visible,
  and it is not a boundary against your own account.* The tower, mobile, notifications and reference
  guides, README, USAGE and the console's README follow, each with its Persian twin, section for
  section. For sessions, `references/turn.md` is new — the reasons with an example each, the guide's
  grammar and the plan's `**Guide language:**` line, a template per kind, the proof types, the guard's
  seven rules and how to answer each, a permission block, the answer's road back, `handled` and the
  doors — and SKILL.md's rule names the five things a session does: give the reason, write the guide
  in the plan's language, state the proof in words, never ask for what it can do itself, and record
  what it handled; a denied tool is declared, never routed around, and the console is never pressed.
  `skill-sync.test.ts` and `guide-coverage.test.ts` hold each against the code it describes.
- **A decision names its `## Decisions` row** (control-tower phase 140, the deferral phase 133 left).
  `phase-outcome.sh … needs-human --step decision` takes `--decision-key KEY`: the person's answer is
  written to the plan's decisions table through `decisions.sh` before the session is resumed with it.
  Any other kind, or a key outside the manifest, is refused (exit 2).
- **The old cards move in** (control-tower phase 139, closes #216). Nothing draws a person's ask in a
  shape of its own any more: the approval queue, its question card, the gate card and the errand card
  each draw the ITEM — one row, the kind's mark, the title, ONE primary pressed exactly as the server
  spelled it, and *Open on Your turn* (`#/turn/<id>`), where everything else is one press away. A
  low or medium permission's row grants in one press; a high or never one, or a choice of options,
  opens the page. A gate no run is asked about keeps the plan's own Approve (gate-status.md). The
  Needs-you bay keeps runs: each strip's one action is its oldest item's primary, the loose rows and
  *Coming up* moved to the page, and one line links there with its counts; *Your turn (n)* in the
  situation line counts items (an errand and its step are one) and opens the page. The launch door lists the run's items — the
  pre-cleared shown done, *Do it now* opening an item a launch before this one raised — and a plan
  step marked `auto-open: host` now OPENS at launch, on the machine, behind `--allow-terminal` or
  `--allow-agent`, an `http`/`https` link only, once the door has shown it whole (the launch sends
  back exactly the links it showed); a session's step never does. A `physical` item with a link
  shows it for the phone. *Not doing this* is a person's no; the dead Dismiss fetcher
  is gone. A broker card's
  Allow that a keyed console turns into an owner request is toasted "asked of the owner", never "done".
- **Grants and owner keys on the screen** (control-tower phase 138, closes #215). A permission item on
  Your turn is answered in one press on its own card: "Raised because the AI lacks permission to …",
  the command, why the phase needs it, the wall and its rule, then the scopes the item's wall allows as
  ONE control — *This call*, *This phase*, *This plan*, *This repository*, *Always* — each saying what
  it covers and when it ends, with the chosen scope's risk beside *Grant*, *I'll do it myself* and
  *Deny*. A low or medium grant is one press. A high one shows what it reaches, asks for the rule typed
  back, and on a console with an owner key waits for a touch of the key inside the last five minutes;
  with no key the card says so and the typed rule alone grants it. A never item offers no Grant: why,
  and the manual path as a guide. The server's answer wins — a 400 `{rule, blast}` replaces the card's
  preview with its own blast radius, and a 202 `{requested}` is said to wait for the owner, never as
  done. A request another door made on an item reads "asked by … — confirm?", with *Confirm* and
  *Refuse* for the owner. *Grant every low-risk ask* grants every open low-risk ask, each for this call
  or this phase, in one press. Settings ▸ Permissions gains **Grants** — every grant with what it
  allowed, how far, who gave it through which door, when, until when, the item that asked and exactly
  what it changed, with *Revoke* and *Revoke all* — and **Owner keys**: the first key enrolled through
  the link `phase-console owner enroll` prints (it now opens `#/settings/permissions?enrol=<token>`),
  later ones in this browser or through a link for another device, each listed with where and when it
  was made and last used and removed once asked; sign in, touch again and lock; which presses need the
  key, read from the door table; and on an IP address, the same page at `localhost`.
- **Your turn — the page, the card and the guide** (control-tower phase 137, closes #214). `#/turn`,
  titled *Your turn* and lighting Runs, is where every act only a person can do is listed: the round
  that read it and its one-sentence headline, then six sections in a fixed order — *Do now*, *Needs
  one detail from you*, *Coming up*, *Being checked*, *Done* (the day's settled items, the ledger's
  older ones beneath) and *Handled by the AI* — each item one card that explains the task exactly: why
  only you can do it, the plan, phase and run it belongs to, what it unblocks with a countdown, the
  effort, then its guide as stations on a line (each step's tick kept in your browser), every command
  copyable two ways — as it is, and behind `!` for your own Claude Code session — and never run by the
  page, a link's whole address shown before it opens, *If it goes wrong*, how it will be checked, and
  ONE primary action chosen by its kind and state (the kind's own opener, *I've done this — check*,
  *Send my answer*, or a permission item's Grant), then *Not doing this*, *I can't*, *Snooze*, *Ask*
  and *Attach*. A check that sends it back says *Back to you*, the attempt and exactly what to redo;
  after the third miss the item asks how it ends — rewrite the guide, hand it back, or accept it on
  your word. A decision is answered on its card: its options as cards, the recommended one marked,
  each consequence, and a note. Every datum is within two presses, the raw record included. Filters
  (plan, run, kind, reason, risk) and the search live in the address; *Export* downloads the open
  items as one Markdown document and *Print* prints the same. A guide carries its language — a
  Persian one is drawn right to left, its commands, refs and numbers left to right — and the Markdown
  component's code blocks now carry a copy button and `dir="ltr"` everywhere, the help sheet included.
  `#/approve` and `#/approve?step=<id>` land on it in one hop; a push opens `#/turn/<id>`; the palette
  opens it. The check button reads *I've done this — check* everywhere. The
  page is a lazy chunk (`check-dist` finds it by `data-turn-page`); first paint is 189.5 KB of 190.
- **Rounds, and what the AI handled** (control-tower phase 136, closes #213). Your turn is kept up to
  date by the console itself: a ROUND — one pass of the human-step clock (a minute) and of every run's
  journal line, debounced two seconds — ends the grants that ran out, sends the reminders that are
  due, withdraws an item nobody needs, expires a window that closed, withdraws an item a live grant now
  covers and resumes its waiters, escalates an item returned `turnEscalateAfter` times that never
  escalated, brings an upcoming act due with its ONE push, and reads the open proofs the console owns
  (a console's raise — `credential:<id>` included — on its back-off) and proves one that landed. A
  round that changed the turn raises `GET /api/turn`'s `round.n` and sends ONE server-sent event,
  `turn`; a quiet round changes nothing. The headline is composed by RULES — how many need you now,
  the oldest, how long it has waited and what it holds; how many are being checked; how many are
  coming up; how many were handled since you last looked (`GET /api/turn?seen=<ISO>`) — never by a
  model. *Handled by the AI* is a new ledger, `handled.ndjson` (a retention sink): what the guard
  refused to ask (G4, G5), what the rule table allowed (ONE row per rule per phase, with a count —
  452 auto-grants are one row), relay answers by rule, the ladder's recoveries, each linked to the
  journal line that says it, and a session's own `phase-outcome.sh <slug> <N> handled --what …
  [--note …] [--link …]` — never an outcome, its links held to a commit, a pull request, an issue or a
  journal line, the secret screen on every field. A session writes a file of its own beside the
  ledger, `handled-sessions.ndjson`, and every line of it reads as the session's whatever it claims:
  a session can never speak as the guard or the rule table. The round's proof pass never runs a
  `cmd:` or `unit:` proof, and what the round resumes goes through the console's own door, never a
  person's, and only where `--allow-run` allows it.
  `GET /api/turn/:id` explains one item.
  `phase_console_turn_rounds_total` and `phase_console_turn_handled_total` count them.
- **The scoped grant: applied by the server, audited, revocable — and a never list** (control-tower
  phase 149, closes #212). A permission item is answered with ONE press — a grant for this call, this
  phase, this plan, this repository or always — that the console applies itself (`server/permissions/
  grants.ts`). `call` is one use, kept in the ledger and spent on use; `phase` lives until its phase
  settles, 24 hours at most; `plan` is the plan's policy file; `repository` is a new policy layer between
  the plan's file and the machine's, for every plan of this console; `always` is the machine's file.
  Below plan scope the console's hook enforces the grant for exactly that lane, rule and (for `call`)
  call — never a sibling lane, never after the phase settled, never a neighbouring rule — and the run's
  settings carry the rule lowered for that run only, raised again once it ends. Risk comes from
  `GRANT_RISK`: low and medium are one press; high needs the rule typed back, shows its blast radius
  and, with an owner key, the owner door touched within five minutes; the never list offers no grant
  through any door; a capability is granted at the machine only, never from another device. The waiting session resumes by itself — "The operator granted
  `<rule>` for <scope> until <end> — run it again" — a held hook call is answered at no cost, and an
  open item a later grant covers withdraws itself. Every grant is a row in `grants.ndjson` (a retention
  sink): who, which door, the item, the wall, the rule, the scope, the end and exactly what it changed,
  journalled (`policy.grant-applied`, `policy.grant-ended`) and announced in a twentieth push category,
  `granted`. `GET /api/permissions/grants` lists them; a revoke undoes exactly what the row says
  (`POST /api/permissions/grants/:id/revoke`, `…/revoke-all`, `phase-console grants list|revoke|revoke-all`).
  The approval card's Allow with *remember*, the widen card's Allow and a standing card's one-time
  allow are grants now — nothing else writes a rule on a person's behalf. The engine fails closed: it
  reads the owner key itself, and a high grant whose press did not prove a fresh owner touch is refused
  — a card's Allow included, whichever door answered it, and a confirmed request, which is pressed again
  with the confirmer's own touch and priced by the item it reaches. A `call` grant covers no other item,
  and under a lifted push wall a push passes only by an allow-list: an abbreviated flag (`--force-w`),
  configuration before the verb (`-c`), a forcing refspec, an option that runs a program
  (`--receive-pack`), arguments fed by `xargs`, or a command, verb or option the shell has yet to
  expand is a forced push. Git is found in any case (`GIT`, `git PUSH`) and as a verb's own program
  (`git-push`); a here-string a shell runs is read like its `-c`; a line that defines an alias and
  names a push is refused — and a commit message's here-doc stays data. An escape a program decodes
  (`\x2d`), a value the line assigns and then runs, and a push glued to an expansion (`"$G"push`)
  read as forced too, as does a command the line leaves unread beside a push named anywhere on it
  (`P="git push"; $P --force`).
- **An owner key: a passkey for what carries risk** (control-tower phase 148, closes #208). A person can
  now prove a press is theirs. `phase-console owner enroll` prints a one-time link, good for ten
  minutes, that enrols a passkey at the machine — WebAuthn verified by hand with `node:crypto`, no new
  dependency: attestation `none`, ES256 or EdDSA, user verification required, a single-use challenge
  good for five minutes, the origin and relying party taken from the request's own host (`localhost`
  or an https host the console serves; an IP is refused with the hint to open `localhost`), and a
  signature counter that never goes back. The key's sign-in opens a twelve-hour owner session (a
  256-bit `HttpOnly`, `SameSite=Strict` cookie, `__Host-` on https, of which only the hash is kept);
  a high-risk press needs the key touched within five minutes; `phase-console owner lock` ends every
  session, and `owner status` says whether the console is `unenrolled`, `enrolled` or `unlocked` (so
  does `/api/state.ownerDoor`). A later key, and a removal, happen only inside an owner session, and
  every change is journalled, pushed to every subscribed device and kept in the bell for a week. Once
  a console has a key, an authority press through any other door — a script, the CLI, a browser with
  no key, a phone beyond its low and medium answers, a session's token — is recorded as a
  request (202): shown on its item, or as a decision of its own, as "asked by <label> — confirm?",
  and pressed through the owner's door only when the owner confirms it. What the plan's manifest
  already allows still executes. A console with no key behaves exactly as before. The registry
  (`owner-doors.json`), the sessions and the requests are 0600 and hold no secret.
- **Permission asks: every wall the AI meets reaches a person** (control-tower phase 135, contributes to
  #212). Each wall a session meets is recorded on its lane — a deny rule and every guard of this
  console's own hook, and the CLI's own refusal: a tool outside the allow list, an MCP tool not
  granted, the CLI's copy of a deny rule — and a refused landing push is a capability that is off. A
  `blocked --needs permission` declaration that cites one raises ONE `permission` item in Your turn,
  saying "raised because the AI lacks permission X to do Y" with the command, the phase, why it was
  needed, the wall and its risk tier; one that cites nothing recorded is refused at the door, exit 4
  — "nothing refused this — run it" (G5). The widen rung's card and the approval broker's ask ARE this
  item: its Grant is what exists today, labelled as what it is (the broker's Allow, once or
  remembered; the widen's permanent plan strike). Every item also offers *Deny* — the session is told
  "denied — do not retry; find another way inside the plan or say what remains" — and *I'll do it
  myself*, which turns it into your own act whose guide is the command and whose *I've done this*
  resumes the session (`POST /api/human-steps/:id/deny`, `…/convert`). The risk table is total over
  wall × rule family × scope: a forced or deleting push, the host family (`sudo`, `shutdown`,
  `reboot`, `mkfs`, `dd`), every guard, a protected path and a secret's value are **never** — no grant
  through any door; the item says why and gives the manual path. An App that is not installed, a
  sandbox or network wall and a protected path raise their own kinds of item; the classifier's denial
  is explained with the rule you could add to your own settings, which the console never writes.
  The scoped grant that answers an item is phase 149's.
- **The check: probes, a checking session, verdicts, attempts** (control-tower phase 134, #211). A
  person's *I've done this — check* now gets a verdict — passed, rejected with exactly what to redo, or
  needs-info — instead of "landed or not". A command's proof is read at once and a miss says what it
  read; a proof only words can state is read by a short read-only checking session for that one item
  (at most 12 turns, $0.50 and five minutes; `sonnet` at `low` by default, Settings ▸ Automation),
  whose verdict is parsed from its last fenced block and never invented. Each attempt keeps its
  evidence and its verdict; a returned item tells the person once what to redo and resumes nothing;
  a pass resumes every waiting session once, saying what was proven and what the check read. Three
  rejections escalate once, with three ways out — rewrite the guide (`…/rewrite`), *I can't*, or the
  owner's *Accept anyway* (`…/override`, the one route that writes a verdict, recorded as unverified).
  No session and no agent can mark its own item passed: a judgement passes only on what the person
  sent for that attempt (a note or a piece of evidence), and an attest, an override or a rewrite counts
  only through a person's door. New metrics:
  `phase_console_turn_checks_total`, `phase_console_turn_check_usd_total`.
- **The owner's moves, and the answer's road back to the session** (control-tower phase 133, #210).
  Beside *I've done this — check*, *Snooze* and *I can't do this*, a person can now answer a decision
  (`POST /api/human-steps/:id/answer {option?, note?}` — one of its options, a note, or both), decline
  an item that allows it with a reason (`…/decline`, the new `declined` ending — *Withdrawn* stays the
  console's own word), ask a question about it (`…/ask`), and attach evidence (`…/evidence` — a note,
  an image or a file: 160 KB a piece, six an attempt, screened for secrets, kept 0600 by content hash
  in `turn-evidence/` and swept by its retention sink, never pushed or journalled). Each answer goes
  back to the waiting session as ONE resume per waiter that the console composes — "The operator
  answered `<option>`: <note>", "The operator declined: <reason>. Do not ask again; …" — carrying any
  question the person asked; an answer that names a `## Decisions` key is written to the plan's
  decisions table through `decisions.sh` first. `answer` and `decline` are authority presses, so no
  session's door can make them.
- **Every source feeds the turn: one list, one done path, one announcer** (control-tower phase 132,
  #209). Everything that asks a person for an act passes ONE door, `raiseTurn`
  (`viewer/server/turn/index.ts`, the only caller of `declareHumanStep`), and reads back as ONE list:
  `GET /api/turn` answers `{round, headline, groups, handled, counts}` — every inbox row that asks a
  person for an act, folded into one item per thing to do and grouped *Do now* · *Needs one detail
  from you* · *Coming up* · *Being checked* · *Done*. Every such inbox row carries a `turn` view
  (`viewer/server/turn/fold.ts`): which item, which record holds it — the human-step ledger, or the
  row's own for an approval card, a gate, a held plan, a QA ask, a live relay question or a
  person-check — its kind, reason and proof type. Health, lock, ruling, policy and message rows stay
  in the bell; issue drafts are one line linking to Repo ▸ Issues.
- A person errand IS an `operator-act` item: its row's action is *I've done this — check* on that
  item, and "Done — continue" checks the same item, so a step the person did ends `proven` — the
  reminder clock no longer withdraws a step its phase resumed past as `dismissed`. One turn is
  announced once: the item's push, one tag per item, the reminders under that tag.
- A credential the preflight finds missing raises a `secret-entry` item whose proof is the new watch
  scheme `credential:<id>` — `gh`, `claude`, `env:NAME`, `keychain:SERVICE`, `file:PATH`, read by
  presence and never by value — and an MCP server it cannot reach under `require` an `mcp-login` item.
  A relayed question the console will not answer by rule raises a `decision` item that keeps its
  options, the one marked `(Recommended)` recommended.
- **The owner door: who pressed is known** (control-tower phase 131, #208). Every request has ONE
  door, decided by what it can prove and never by what its body says: a session's run token is
  `session`; a login the `--remote` proxy verified, or a signed lock-screen action, is `device`;
  anything else is `local` (`viewer/shared/door-model.js` `PRESS_DOORS`, read by
  `viewer/server/owner/door.ts`). Every press records it as `pressDoor` beside `by`, which is now only
  a label — a script that says `by: operator` is recorded `local`. The door × authority verb × risk
  table (`DOOR_MAY`, `doorMay`) says what each door may do, in two modes: with no owner key — every
  console until the owner keys arrive — `local` presses what it could before, and `/api/state` says
  `ownerDoor: 'unenrolled'`.
- `AUTHORITY_ROUTES` names every authority route — new rows for the relay's answer, a presented plan,
  *Delegate*, remembering a ruling, the preferences and the lock-screen action — and is held both
  ways: a route that presses an authority method without a row fails the suite, naming its line. A
  plan's `permission.destructive` row can name a route-only press as `Console(<press>)`.
- **Your turn speaks one language** (control-tower phase 130, #207). A person's task now says WHY only
  a person fits it — one of ten reasons (`permission`, `identity`, `secret`, `money`, `legal`,
  `decision`, `physical`, `reach`, `third-party`, `reserved`), held to what its kind allows — carries a
  full guide (a why paragraph, numbered steps each with an optional command, expected result, warning
  and link, and "If it goes wrong"; 20 steps and 24 KB at most, http(s) links only, every line through
  the secret screen) and a proof a person can read. `viewer/shared/turn-model.js` (twin
  `scripts/turn.env`) owns the reasons, the proof types (`probe`, `answer`, `judgement`, `attest`,
  `grant`), the verdicts, the grant scopes, risk tiers and states, the page's groups, the handled
  sources and the walls; `viewer/shared/guide-grammar.js` is the one guide parser.
- **The human step grows to eighteen kinds and eleven states**: the kind `permission` (a wall the AI
  met, ended by a grant or a denial) and the states `returned` (a check sent it back) and `declined`
  (the person's own "not doing this"). Each state, verdict, risk tier and grant state has a status row.
- `phase-outcome.sh … needs-human --step` gains `--why`, `--guide` (with `--lang`), `--effort`, `--due`,
  `--unblocks`, `--proof-type`, `--proof-words`, `--option` (with `--recommended` and
  `--allow-decline`), `--window` and `--tried`; the plan bullet gains `why:`, `effort:`, `unblocks:` and
  `guide:`, and `--human-steps` prints them. `PE_API` is 2.
- **The guard at the door** (G1–G7), at the declaration's pre-check and again at ingest: a reason the
  kind allows; a proof unless the answer is the result (`attest` only by name); a declared
  `permission`, `reserved` or `reach` reason is refused with **exit 4** when the AI could do the act
  itself — every command its guide asks for is one the run's own policy allows, or a `reach` with no
  `--tried` — and an act a rule stops becomes a `permission` item naming the wall; the same item
  declared by another lane is ONE item with another waiter, every waiter resumed when it is proven.

### Changed
- **A `secret-entry` step no longer takes the secret** (control-tower phase 133). `check` refuses a body
  that carries one, naming where the value goes instead — the keychain item `phase-console-<id>` on
  macOS, a 0600 file elsewhere, or the item's own `credential:` place — and the check finds it there by
  name. The step card's secret field is gone; it says where the value goes.
- **A step needs a proof** (G2): a `needs-human --step` with no `--proof`, no `--proof-words` and no
  answer for a result is refused (exit 2) — name `--proof-type attest` to take the person's word. A
  step that names no `--why` is given its kind's default, marked inferred, so an older skill copy and
  `--act` keep working. The ledger writes version-2 lines and reads version-1 lines with defaults.
- An `operator-act` lights the halt family of its reason; with none, a decision.
- F40 (`human-step-no-why`, advisory): a plan bullet with no `why:`.
- **A request carrying a session's token presses no authority route** the plan's
  `permission.destructive` row does not name: it is refused 403 before any route runs, logged
  `owner.door-refused`.
- **A manual gate's person test is a door, not a User-Agent**: `owner` or `device`, and `local` on a
  console with no owner key — where the approval says so. A session's door is refused whatever its
  User-Agent. (A process outside a session could already clear one with `gate-approve.sh` in a
  terminal.)
- `bin/btw` names itself, so its ask is recorded `via: cli`.

### Fixed
- **"The release phases" in a `permission.destructive` row names them** (#250). A row that allows a
  publishing act "in the release phases", alone or beside numbered phases, read the numbers alone, so
  every release phase's `gh pr create` went to a person's card although the plan allowed it. The console
  now resolves the release phases from the plan's graph — each phase whose title opens with *Release* —
  and answers that card itself, with a journal line; a qualifier it cannot resolve still narrows the
  allowance and never widens it.
- **An approval card's evidence is the asking lane's** (control-tower phase 135, OD-17): the working
  tree and the verification it shows are read from the lane that asked — its own checkout and its own
  record — never the console's root or another plan's run.
- **A word in a pattern is not a deny rule's name** (control-tower phase 135): `matchedDenyRule`, which
  the relay asks directly, read the raw words of every line and named `Bash(shutdown:*)` for a task
  subject that said "shutdown"; it now looks inside a wrapper only where the classifier does.
- **A refused call's journal line never holds a secret the call carried** (control-tower phase 141,
  #217, found by the tower rehearsal's planted secrets): every `phase.tool-denied` line — the forge
  guard's, a deny rule's, the gate guard's, the push carve-out's and the poll loop's — keeps its command
  through the wall's own redacting reader, so an `Authorization: Bearer …` header no longer reached the
  run's journal; and `redactSecrets` reads a JSON `"password": "…"` as it reads `password=…`.
- **An answered item no longer leaves its run parked** (control-tower phase 141, found by the tower
  rehearsal): when a person's answer resumed the session and it finished its phase, the run stayed
  parked — its next phase never boarded, and converge leaves a run a person pressed. A resume that leaves
  the run parked with no halt now continues it, as a landed proof's resume always did, under the same
  guards (`autoContinueRecovery`, `--allow-run`, no live runner, no fleet hold).

## [6.1.0] - 2026-10-06

**The world outside a run.** 6.1 lets an unattended run wait on what happens outside its own checkout,
and tells the truth about where its work stands. A wait can watch a job on another machine
(`unit:<host>/<unit>`), a date can stand beside a live ref as its backstop, a plan can raise its own
wait count, and the operator's own acts — a command to run, a click path to follow — form one queue
whose entries come due when their trigger lands. A run is settled only once its branch has landed on
the trunk, a manual gate is a person's alone, a session can no longer press its own console, and the
Issues desk reads a repository's whole issue list, each issue with its category, severity and plan
status. The free tree stays MIT. Nothing a 6.0 plan says stops working — what moved under people's
feet is below.

### Migration
- **A manual gate is a person's.** A gate the plan marks `manual` is never delegated to a session,
  whatever the `gates` row says. `gate-status.md` gains a `Door` column, and `--gate-status` honours a
  manual approval only when a person's door — the console's Gate card or a person's own terminal —
  wrote it, so a row written before 6.1, which names no door, no longer clears its gate: approve it
  again.
- **A run is settled only once it has landed.** A run that owns a branch reads `finished` only when
  every repository's `pe/<slug>`, the root's included, is held by `origin/<trunk>`; until then it parks
  `unlanded` with one merge errand, where 6.0 called it finished. Under `landing: hold` nothing moves
  the branch onto the trunk by itself.
- **A session cannot press its own console.** A supervised session's HTTP client (`curl`, `wget`,
  `http`, `xh`) against a console's approval, policy, run-settings, gate or person's-step routes, and
  its writes into the console's state or config directories, are denied before they run
  (`console-forge`). A phase that must press one names that press's CLI form in the plan's
  `permission.destructive` row.
- **A §Verification line runs without `CI=1`.** The console no longer sets it, so a suite that changed
  its behaviour on `CI` runs as it does in the session; non-interactivity comes from `NO_COLOR`,
  `TERM=dumb` and a closed stdin, and a `CI` the console itself was started with passes through.
- **A session's turn ends after its own agents.** While a background subagent or monitor the session
  launched still runs, the Stop hook refuses a `partial` or `complete` exit (twice at most) and names
  the two ways out: wait for it in one bounded foreground call, or stop it and record what it was doing.
- **A new advisory lint, F39 `setup-deps-missing`,** names a §Verification line that runs a package
  script or a `.venv/bin/*` binary in a repository the phase's `- **Setup:**` installs nothing for.
  Add the install to Setup; the lint never changes the exit code.
- **Update the console's scripts and the plugin together**, as at 6.0: a 6.0.0 `phase-outcome.sh` has
  no `--act` or `--due-when` and knows no `unit:` ref, and a 6.0.0 `phase-graph.sh` has no
  `--wait-count` or `--verify-in` arm.
- **For readers of the vocabularies:** a person's turn has a seventeenth kind, `operator-act`, and a
  ninth state, `upcoming`, first in the path; a run has a new halt kind, `unlanded`.

### Added
- **A wait on another machine's job** (control-tower phase 121, #181). A new watch scheme,
  `unit:<host>/<unit>`, asks a systemd unit on another machine whether it is still running — over ONE
  shared ssh connection per host (`ControlMaster`, its socket under the console's state directory),
  every 5 minutes — and lands the moment the unit leaves `activating`/`active`, recording its `Result=`
  and exit time in the wait history. The host's address, user, key and port come from `hosts.<name>` in
  the machine profile `~/.config/phase-console/fleet.json`; a host not named there is refused, and none
  of those details is written into a run record — ssh's own failure is told in fixed words of its class,
  never its text. The master socket lives with the instance's state, or, where that path would overrun a
  Unix socket's 104 bytes, in a private directory of the user's own under the system's temporary one.
  `phase-outcome.sh` refuses a malformed `unit:` ref.
- **A date beside a live ref is a backstop** (#181). `waiting-external --watch <ref> --watch date:<iso>`
  wakes the phase the moment the ref lands; the date only bounds the wait, and if it passes first the
  phase is resumed told that the ref has NOT landed and what it last read (`phase.waiting` carries
  `backstop`). The script says which ref is the backstop when it records the declaration.
- **A plan raises its own wait count** (#40). `**Wait count:** <n>` in §Session budget, or
  `- **Wait count:** <n>` on a phase (1–99), lifts the four declared waits a phase may spend;
  `phase-graph.sh --wait-count [N]` reads it, `wait-budget.sh [--phase N] --count <n>` writes it. A park
  on a spent count or a spent time budget whose watch ref still polls now reads as a WAIT on that ref —
  the run `waiting` on it, looked at again every six hours — never an errand to re-check it by hand. A
  `date:` is a clock, not such a ref, and a ref the watch clock has refused for good no longer counts:
  either way the park is a person's again, with its `budgets` errand. The session contract states the
  raised count and where it came from.
- **The operator's acts, as one queue** (#182). A seventeenth human-step kind, `operator-act` — an act
  only the operator does, a command to run or a click path to follow — and a ninth state, `upcoming`,
  first in the path: a step declared with a due-when ref is shown under *Coming up*, unannounced and
  unreminded, its window not started, until that ref lands; then it is due with ONE notification,
  `NOW: <command>`, and its proof landing clears it and resumes the phase that needed it. A session
  declares one with `phase-outcome.sh … needs-human --act --due-when <ref>`; a plan with a `due: <ref>`
  field on its `- **Human step:**` bullet, in a phase or under `## Operator errands` (the plan's own,
  phase 0). A `due:` that fits no scheme's shape fails the F37 lint by name. While an act is coming up
  its park summons nobody — no needs-you push, no errand row — and a due-when ref the console refuses
  makes it due at once, the refusal named; a frozen console asks no due-when ref at all. The approve page
  and the Tower list *Coming up* after what is due, each row with its command to copy. New journal line
  `phase.human-step-due`, log `human-steps.due`.
- **The Issues desk** (control-tower phase 118). Repo ▸ Issues reads a repository's WHOLE issue list:
  one `gh issue list --state all` with a cap of 2,000 (`ISSUE_LIST_CAP`, asked one over so `truncated` is
  measured, never assumed), with `author`, `createdAt` and `closedAt` now among the fields and still no
  field that returns a body. Each issue carries what the desk reads off it, derived once in
  `viewer/shared/issues-model.js` (`categoryOf`, `severityOf`, `planStateOf`, `triageOf`) and drawn
  through the status family: its category (`bug` · `enhancement` · `documentation` · `question` ·
  `other`), its severity (a `severity:` label, or none) and where it stands in a plan — needs a plan
  (`awaiting-plan`), planned in `<slug>` phase N (`plan:<slug>`, with the phase a local plan's `Fixes:`
  line names), deferred (`plan:<slug>-deferred`), fixed (closed, with a plan label). Every column sorts
  and the sort is in the URL beside the new Category, Severity and Plan status filters. The repository
  picker takes any GitHub `owner/name` an operator adds (`prefs.issueRepos`, at most 12), read and
  refreshed like the estate and marked "outside this console". The palette's entry is "The Issues
  desk", and the Plans page links "Plan from issues" to it.
- **The issue rubric's words** (control-tower phase 114). `viewer/shared/issues-model.js` owns the
  three issue types (`bug` · `enhancement` · `documentation`), the four severities worst-first with their
  one-line meanings (critical — data loss, a security or permission bypass, an unapproved production
  change, or every lane blocked; high — a run halts or parks, or reaches a wrong verdict, with no in-run
  workaround; medium — time or money wasted, a workaround exists; low — cosmetic, wording, noise), the
  lifecycle labels `awaiting-plan` and `from-session` with the `severity:` prefix, and the suggestion
  words; `scripts/issues.env` is their bash twin, held word for word by `gates-vocab.test.ts`.
- **The docs say what 6.1 adds, in English and Persian** (control-tower phase 122). The help sheet's
  Halts section gains *A job on another machine* (the `unit:` watch and its `hosts.<name>` profile
  entry) and its watch card the date backstop and the raised wait count; Your turn gains *Acts that come
  due later* (`operator-act`, *Coming up*, `due:`, `--act --due-when`); Getting around's Repo card says
  what the Issues desk reads off each issue; When stuck ▸ Parked explains a run that is done but not on
  its trunk (`unlanded`). README and USAGE carry a 6.1 paragraph each and their Persian twins the same,
  `viewer/README.md` and its twin state the 6.1 wait rules, and `docs/loop.md`'s scheme table gains
  `unit:`.

### Fixed
- **A temp-file save under `docs/` no longer makes the console forget every plan** (#244). An editor's or
  an agent's atomic write reached the plan store as a change that named no plan, so the console forgot
  every plan and read them all again, and hung while every board was derived anew. The watcher now drops
  temp-file and atomic-save artifacts before they become a change, and a change forgets only the plans it
  moved or named.
- **A plan card's repository tag keeps its width on a phone** (control-tower phase 118, #203). At 360 px
  a range estimate and the time filled the card's meta row, and the tag — the one part allowed to shrink —
  gave way to zero pixels. The row now wraps the time onto a line of its own first, and the tag never
  draws narrower than three characters. The e2e register gains a probe class, `squeezed`, for text a
  layout gave a line's height and no width; without the fix it names the tag (`span "app" ×2` on the
  Plans stop at phone-360), and `e2e/baseline.json` stays `[]`.
- **No test reaches the login keychain, and the suite's slow and flaky fixtures are mended**
  (control-tower phase 116, #200, #169). `auto-recovery.test.ts` RCV-10/ACC-3.2 registered a spare token
  account on a real `Service`, so every suite run wrote a token into the operator's macOS login keychain
  and deleted it again — and went red whenever that keychain was locked. `realExec`
  (`server/accounts/credentials.ts`) now refuses every keychain write, replace and delete in any test
  process (`NODE_TEST_CONTEXT`, `VITEST`, a `--test` argv, or `PHASE_CONSOLE_KEYCHAIN=0`, which
  `test/state-sandbox.ts` sets for a file run with plain `node`, and `test/spawn-console.ts` for every
  console a test or the browser tour spawns — the tour's since phase 123) before
  a child starts, with the fix in the sentence, and `keychainStore` lets that sentence through rather than
  "unlock the login keychain". A lookup still runs: a real `Service` judges the machine login by its item.
  Production carries none of these markers; `testProcess` in `shared/instances.mjs` is the one reading of
  "a test process" for both belts. `git-browse.test.ts`'s fixture `git` is hermetic — no global or system
  config, `gc.auto=0` and `maintenance.auto=false` as command-line config, the inherited `GIT_*`
  environment dropped — and a fixture command that fails reports `.git/HEAD`, the refs and the reflog
  tail. G-DIFF builds its overflowing stat from 5 500 deep paths in one `git fast-import` (5 s under load,
  where it took 102 s). The runner suite's `sleep` stub was never a Runner option, so RF-3 and two
  connectivity tests waited out real 60 s backoffs; the harness now installs it, and the two boarding-pause
  tests press inside the slow gate's window rather than 300 ms after the start. UP-3 pins the doctor's
  Claude Code rows in the order phase 108 gave them (hooks, presence, skill), `plan-fields.ts`
  accounts for `--verify-in`, and the eight files that boot a console wait about 60 s for it, not 5–10 s.
  Phase 117 mended the two the release gate still met: BL-3 expects the suite's own priority plus the
  baseline's nice, clamped at the kernel's floor, rather than an absolute niceness, so a suite started
  niced passes; and PR-3 registers the free tree's one default slot rather than a second console its
  one-slot registry refuses.
- **One `ps` per process in flight, so a busy console cannot run out of descriptors** (control-tower
  phase 123). The process probe's single-flight started a new `ps` before it looked for the one already
  out, so it deduplicated the bookkeeping and not the subprocess: every ask on a stale sample spawned
  another `ps`. A presence backlog applied on a busy loop asked about 3,500 times about a few live pids,
  each `ps` held three pipe descriptors until the loop could reap it, and once the process had about
  10,240 open — macOS's `OPEN_MAX` — every later spawn in it failed `EBADF`, `git` and `bash` included.
  That was `sessions-presence.test.ts`'s cascade under whole-suite load (phase 116 met it twice in three
  runs). A probe already out is now the refresh, and the awaited ask joins it.
- **A session cannot press its own console** (control-tower phase 129, #218). A supervised session runs as
  the operator's own OS user, and the console's write guard is a capability flag, its header and a
  same-origin test — so one `curl` could answer the session's own permission card, strike a deny rule,
  raise its run to `bypass`, approve a manual gate or prove a person's step. A new hook guard,
  `console-forge`, denies such a call before it runs, on every profile and beside `gate-forge`: an HTTP
  client the shell would run (`curl`, `wget`, `http`, `xh`) against a console's address with a mutating
  method and a path in `viewer/shared/door-model.js`'s `AUTHORITY_ROUTES` (the approval cards, the
  policy, a run's settings, the gate route, `/api/write`, a person's step's check and dismiss), the CLI
  twins (`phase-console run approve|deny`), a wrapper whose text carries a console address and a fenced
  path, and a write into the console's state or config directories by the file tools or a shell
  redirection. A run's own checkout and a session's memory, which can live under the state directory,
  stay writable; reads, `/hooks/*`, a session's message token, the skill's scripts and the operational
  verbs pass; a press the plan's `permission.destructive` row names for the running phase passes. The
  refusal names the declaration to make instead, and is journalled `phase.tool-denied {rule:
  'console-forge', verb}`. And `POST /api/write {action: 'gate-approve'}` no longer takes a gate's door
  from its body: an approval there goes through the gate route's own person test, so a manual gate is
  refused to a script whatever door it claims.
- **Settled means landed** (control-tower phase 112, #184). A run that owns a branch now reports `finished`
  with nothing outstanding only when every repository's run branch — each mirror mount, the root's
  included — is held by `origin/<trunk>`. The proof is tree containment asked in each repository:
  `git merge-tree --write-tree <trunk> <tip>` writing `<trunk>^{tree}`, never `git cherry`; the local trunk
  only for a repository with no remote copy (`run.landing-proof`). Anything else parks the run `unlanded`
  — a new run-level halt kind — with one errand ("pe/x conflicts with main in a.md, b.md"), whose card
  opens a merge errand tree; the read path never settles it to `finished`, and Recover & continue proves it
  again. Before, a hub run settled `keep` and read `finished {outstanding: []}` with its last two phases'
  docs on an unpushed root branch that conflicted with `main` in six files. Under `landing: hold` every
  brief now says nothing moves the branch onto the trunk by itself. And untracked files never pin a mirror
  mount at the prune: they move to the run's `stale-mounts/` and the mount goes; a mount kept for tracked
  edits is named in a `run.errand` with its paths.
- **A squash-landed branch is re-seated** (control-tower phase 112, #183). Once a release squash-merges
  `pe/<slug>` and the trunk holds all its content (the same merge-tree proof), the console moves the branch
  onto `origin/<trunk>` in the run's own checkout (`run.branch-reseated`, with the old tip and the proof).
  It does this before its own verification of the phase and at every boundary, only on a clean mount, and
  never under another lane. A mount a session detached on the trunk is re-seated rather than switched back
  to the pre-squash tip. A dirty one's `isolation-refused` names that remedy instead of only "switch it
  back or remove it". And a session's `git switch --detach` / `git checkout <commit>` inside its run's own
  checkout is refused before it runs (`run-tree-detach`). Before, a release's `task drift:*` lines could go
  green only by detaching the mirror, and the next boarding was refused.
- **Retention leaves live trees alone** (control-tower phase 112, #171). A tree whose run is live, or
  whose mtime moved in the last ten minutes, keeps its last known size and is never scanned. At most one
  `du` runs console-wide. A `du` past its 30 s ceiling is ended through the signals ladder (SIGCONT,
  SIGTERM to its group, SIGKILL after 2 s) and its tree is not asked again for six hours. Nothing is
  measured while the one-minute load exceeds twice the cores. The runner's git probe no longer measures the
  run it is driving. Before, three `du -sk` of one live mirror ran at once at load 279 on 14 cores, and
  1,419 of 1,419 scans of a 14-repository mirror hit the ceiling without an answer.
- **Spend is corroborated at each model's own rates** (control-tower phase 109, #202). The price table
  had one row, `opus`, found by a family substring, so every Opus 5.5 session was priced at Opus 5's
  rates and journalled a false `phase.cost-mismatch` reading `under` (347 on one machine) — and a
  doubled booking on the default model read as agreement. Opus 5.5 now has its own row ($4 input, $8
  one-hour cache write, $0.20 cache read, $20 output per MTok) beside Opus 5's, matched by the whole
  model id; a version with no measured row, or an alias that names none, is not priced and not
  corroborated. P85's tokens price to $14.2217, the CLI's own figure. A model whose fresh sessions sit
  at one ratio all day is announced once, as `phase.cost-drift`, and a session off that ratio is still
  a finding.
- **A wrap-up keeps its lane** (control-tower phase 109, #192). A phase that hands off `partial` at the
  console's wrap-up with its own work uncommitted in a shared tree now re-boards before any sibling
  whose scope meets its own — ranked right after a person's re-board, and with its scope held for it
  in the very pass that released its lane (`phase.lane-kept`). Before, the lane's teardown woke the
  loop while the attempt was still settling, and a graph-ready sibling was admitted one second later
  over the red WIP (ai-builder-v7 P13 past P7, on a console with #128's fix).
- **A session ends when its agents do** (control-tower phase 109, #188). While a background subagent or
  monitor the session launched still runs, the Stop hook refuses a `partial` or `complete` exit (twice
  at most), with the two ways out: wait for it in one bounded foreground call, or `TaskStop` it and
  record what it was doing under Outstanding. The 0.6× wrap-up notice names the live agents. One still
  killed by the CLI's ten-minute ceiling after the handoff is named in the next attempt's brief — its
  description, its last words and the paths it wrote after the handoff (`phase.agents-killed`).
- **A live lane keeps its handle** (control-tower phase 109, #170). The input of a session that ended
  its turn to wait on its own background subagent stays open, so a steer, an ask, a peer's message and
  the wrap-up notice reach it; the turn after the agent reports closes it, bounded by the idle closer
  and the CLI's background ceiling. A refused message now names the session's real state — "phase 6's
  session (pid 7529) is running, but its input closed at 07:12:04Z (…)", or that it was adopted from
  the run record with no pipe — never "no session is running". Every close is journalled with its
  cause (`phase.input-closed`) and the lane view carries `input: {open: false, closedAt, cause}`.
- **A `/clear` ends the session it replaced, and a released lock holds nothing** (control-tower phase
  108, #172). A `SessionStart` for a new session id in a process that other records name now ends
  those records at once: the registry reads them `ended`, superseded by the new id
  (`endedBy: successor` when no end was reported), their waits closed, their messaging sockets
  dropped and a `superseded` line on their event logs. A terminal a person `/clear`ed therefore no
  longer stands in the queue as the holder of the scope it used to work in. Only records last seen
  within two seconds of the new start are ended, never another process's, and a `/resume` of the old
  id in the same process revives it. While that process runs, a lock it took is still never treated
  as debris. A `release` in a session's own transcript now cancels its earlier lock calls for that
  phase, and a claim whose lock has gone holds nothing after 60 s, so a released lock's scope no
  longer lingers on the record.
- **Hold evidence counts only the tree** (control-tower phase 108, #180). Writes under
  `~/.claude/**`, another Claude config directory, `~/.claude.json` or the session's own config
  directory are no longer evidence of touching the tree. A bare `git -C <root> …` no longer claims
  the whole root, though a git verb in a repository under the root still holds it. The queue card
  shows, under the terminal it waits on, what the hold rests on (`held because it edited …`), newest
  first.
- **Every account reports presence** (control-tower phase 108, #194). A session spawned under a
  profile account runs with that profile's `CLAUDE_CONFIG_DIR`, whose `settings.json` carried no
  presence hook, so the registry never saw it and its lock could not be tied to a session. Each
  profile workspace's `settings.json` now carries this console's four presence entries and never the
  login's other hooks: a person's own hooks are kept, a stale entry is refreshed, and a file that
  does not parse is left alone and logged (`accounts.workspace.presence-installed`,
  `…presence-failed`). A phase session on a profile now appears in the registry with its plan, phase
  and run. `phase-console doctor` gains a non-blocking `presence` row over every pooled account's
  config directory, whether the console is up or not.
- **The pre-session baseline is quick, visible and never a verdict** (control-tower phase 105, #190,
  #193, #173). A session no longer waits for its phase's baseline: what must be measured runs BESIDE
  it in a clean checkout of the boarding head, niced and held by the machine-load guard, and the
  session hears the result as a next-turn note; the verdict waits for a baseline still running and
  compares against it as before. A red baseline line is run once and recorded `red once (not
  retried)` — the one recorded retry is the verdict's alone. A line any plan of the console measured
  on the same tree, command, environment digest and directory in the last day is reused, named with
  its source run and age. A phase in its baseline or its `Setup:` is a lane on every surface
  (`baseline 9/10 · <line>` with its clock), the header names it (`running — P8 baseline 9/10`, never
  `phase ?`), and a read that does not know the run is live no longer paints it `interrupted`: the
  command's process is recorded on the run, and a lane whose lock its console keeps refreshing keeps
  the run `running`.
- **A §Verification line runs in the session's environment, and ends** (control-tower phase 106,
  #195, #191, #185, #168, #196). The console no longer sets `CI=1` on the lines it runs — suites
  read it as "this is the CI infrastructure", and a line green in the session was red every time the
  console ran it; non-interactivity comes from `NO_COLOR`, `TERM=dumb` and a closed stdin, and a
  `CI` the console itself was started with passes through untouched. A red line keeps its failing
  tests and the end of its output for a baseline as for a verdict — on the record, in the ledger,
  in the session's baseline note and in the phase drawer. A clean export of a repository that is a
  superproject's submodule now stands at its own path with the sibling repositories and the root's
  files linked around it, so a line reading a sibling (`../frontend`) reads it; untracked files no phase
  wrote, the phase's own `Setup:` outputs and dependency directories no longer send a verdict to an
  export at all; and a sibling an export cannot provide is `environment`, never red. A line that
  fails within seconds because its `node_modules` or `.venv` is not installed is `environment` too,
  with its tail, and the session is told to install the dependencies — and a new advisory lint,
  **F39** `setup-deps-missing`, names a §Verification line that runs a package script or a
  `.venv/bin/*` binary in a repository the phase's `Setup:` installs nothing for, before any run
  meets it. `phase-graph.sh <slug> --verify-in N` reads a phase's `Verify in:`. When a line's leader exits
  while a process it left behind still holds its output, the line settles on the leader's exit code
  after a two-second grace, the stragglers named and stopped; at its timeout the signal ladder now
  reaches the whole process group even when the leader is gone, and a process that left the group
  can no longer hold a line open. `phase-outcome.sh … verified` keys a proof where the console judges
  the line (`PE_VERIFY_DIR`, which the runner now gives every phase session, with `PE_RUN_ROOT`):
  `--in` is resolved against the run root, never the shell's cwd, and a proof the verdict could only
  refuse is refused when it is recorded, naming both trees.
- **A manual gate is a person's, and a cross-plan gate clears** (control-tower phase 107, #174,
  #167). A gate the plan marks `manual` is never delegated to a session, whatever the `gates` row
  says: the runner holds it, the boot prompt tells the session to stop and declare
  `needs-human --needs gates`, and the inbox always raises it. `gate-approve.sh` now names its DOOR
  from its own environment, never from `--by` — `console` (a person's press in the console),
  `terminal` (a person's own shell), `session` or `script` — refuses a manual gate from a session, a
  script or an `ai-*` approver, and records the door in a new `Door` column of `gate-status.md`;
  `--gate-status` ignores a manual approval a person's door did not write, the door-less row a
  session once wrote for itself included, and says why. The console approves a manual gate only for
  a person's press — the Gate card from a browser, a phone's signed Approve, a supervisor-chat act a
  person confirmed — and logs anything else as `gate.approve-refused`. A session's own tools cannot
  borrow a person's door either: setting `PE_GATE_DOOR`, or writing a plan's `gate-status.md` with the
  file tools, is denied before it runs (`gate-forge`), and a `--note` or `--by` carrying escapes can no
  longer write a row of its own (the cells reach awk verbatim). A `plan <slug>:<phases>` gate
  reads the other plan's verified set whatever its separators, so `plan other:10,11` clears once the
  other plan has verified 10 and 11 — it could clear only when exactly one phase was verified.
- **The approval judge reads a shell line as a shell does** (control-tower phase 107, #189, #186,
  #205). Permission rules match only the words a line would run: a quoted here-doc's body, an
  interpreter's `-c`/`-e` payload and a quoted argument are data and match no rule, while a `$( … )`,
  a backtick, a `<( … )`, a group, a compound, a shell's `-c` payload, an `eval`'s words and an
  unquoted here-doc's substitutions are commands — and what the judge cannot read it matches raw as
  well, so the deny wall is never weaker than before. A handoff written by a `python3 - <<'EOF'` whose
  text mentions `git push` no longer raises a person's card. A push the plan's
  `permission.destructive` row names is answered from the row beside read-only company — a read-only
  `$( … )`, a `$?`, `rc=$?` — and the same push in a shape the row cannot answer as it stands (a
  `git add`/`git commit` beside it, a `$( … )` that writes, a branch the shell computes, a bare
  `git push`, a push inside a here-doc or an `eval`) is refused at once, naming the bare form to re-run
  alone, rather than left an hour on a card (`phase.approval-reshaped`); a card an automatic actor
  settles under that answer no longer parks the run. A row's exceptions are read for the RUNNING
  phase: "with these allow rows: Phases 4/17/22 — `gh pr create`, `gh pr merge --squash
  --delete-branch` …" grants those commands in phases 4, 17 and 22, announced as any manifest grant,
  and another phase's card says which phases the row allows. The row answers the publishing act
  alone: a command beside it that the run would ask about on its own is never carried past the ask
  list (the call is answered at once with the bare form), a form the row names with options is that
  form (`--admin` beside `--squash --delete-branch` is a card), and a push goes to a remote the
  checkout names, never a URL or a path. What runs is what the row answered: a publishing command with
  an environment in front (`GIT_SSH_COMMAND=…`, `GH_HOST=…`, `env`) or git's own options before its
  verb (`-c …`) is a person's card, a push goes to `origin`, and a line that also assigns, changes its
  shell (`export`, `alias`, `source` …) or defines a function is answered with the bare form. The
  reader also follows bash on here-doc delimiters (`<<E"OF"`, `<<END!`), an unclosed here-doc, `$[ … ]`
  arithmetic, ANSI-C quoting (`$'git' push`) and `coproc`. A here-doc OWNER that is a shell in a quoted
  or escaped spelling — `"sh" <<EOF`, `b\ash <<EOF`, `s""h <<EOF` — now reads its body as CODE as bash
  does, so a `git push` the shell runs there meets the wall; deciding by a raw-text regex alone had
  called that body data and let the push through.
- **An orphan is a session the live console did not launch** (control-tower phase 110, #175). Each
  session's record now names the console that launched it — its pid and the instant it booted — and a
  run is parked `orphaned-session` only when that console is gone (the pid exited, or a later boot
  holds it), never because the record went quiet or a reader did not know the run was live. The hourly
  sizing census read every run file as if nothing were live, and parked the runs its own console was
  driving — on disk, once an hour, with no journal line. Every run-file read now says which runs are
  live, a real orphan park is journalled (`run.orphaned`), and a start beside a session this console
  launched is refused, naming its pid and phase, instead of parking it.
- **A heal acts on the run as it is now** (control-tower phase 110, #178). A healer pass re-reads the
  run after classifying — the slow part — and again before it climbs or launches anything, and drops
  itself (`run.heal-dropped`) when the run is live again, a phase holds a newer attempt than it read,
  or the stop was resolved meanwhile. What a pass records is merged onto the record as it stands, never
  its whole copy saved back; a dropped pass writes nothing, and converge keeps no fingerprint for it
  (`run.converge` carries `stale: true`). An operator's Retry had boarded attempt 3 while a heal read
  attempt 2 for five minutes and then saved that copy over the live run.
- **A parked run whose plan gains ready work comes back** (control-tower phase 110, #176). Resume
  continues a parked, halted or interrupted run through the one start door with its own settings — it
  refused every one ("No pause … Continue brings it back") — and an automatic press never lifts a halt
  only a person may, a person's stop or a person's dismissal. A dismissal records who made it and what
  the board read ready then: a script's is worded as a script's ("dismissed by a script, not a
  person"), and converge relaunches the run once work turns ready after it, while a person's still
  pins the run and now names the ready work it holds back. A hub run sat parked for 6.6 hours with a
  ready phase behind a watchdog's dismissal recorded as the operator's.
- **An API safeguard false positive is not the model declining the task** (control-tower phase 111,
  #177). The banner "safeguards flagged this message … This sometimes happens with safe, normal
  conversations" classifies as `safeguard-flag`, read off the API-error channel or a stop that was a
  refusal or an API error — never off a successful session quoting it. The phase is boarded FRESH with
  the resume brief (resuming would re-send the flagged message), then fresh again — or on the next
  model under a `ladder` model policy — and only the third flag asks a person: "the API's safeguards
  flagged the session (a false positive is likely); two fresh sessions were tried — report request
  req_…". `phase.safeguard-flag` carries the classifier, the request id and the message id. A twenty-hour
  run had parked on "the model declined the task".
- **The in-turn clock guard judges a wait by its subject** (control-tower phase 111, #179, #206). A loop
  on nothing but the clock is the session's own job, whatever its line runs after `done`, and a URL the
  summary's cap cut before its host was whole names no remote host — P34's fixture window had been
  checkpointed at minute five as somebody else's clock. An external-clock wait is now nudged first and
  parked only if the call is still open five minutes after a nudge the session received; a park on a
  clock loop is bounded by the loop's own target instant; the phase lifecycle names the watchdog as the
  actor (`stop.kind: watchdog`), never `declared`; and a person's Continue on a run waiting on parks
  cuts a watchdog window short, and a declared one whose ref has landed — asked at the press — or says
  why not when the relaunch could only park it again (`phase.wait-cut`). It had answered `running` and
  the run parked again 72 s later. Time a call spends held on a person's approval card is credited back
  to its wait, a window closes when its call returns once the session is in another wait, and while the
  session's own background tasks run an external wait takes the own-job rungs, so a checkpoint no longer
  ends them (two release preflights had died with one) — and a park that does end them names them.
- **A CI run GitHub never started is not a red CI** (control-tower phase 111, #166). When a watched run
  ends `completed: failure` with every failed job unstarted — no runner, no step — under the "job was not
  started … spending limit" annotation, the probe reads `not-run (billing)`: the wait stays open, ONE
  errand names the repository's Actions budget and its consumed amount when the token can read them,
  and the Tower draws one "CI refused (billing)" line per repository, however many phases wait behind
  it. When the budget is read again with room, the ref lands and the phase resumes with "re-run the
  failed jobs (`gh run rerun <id> --repo <repo> --failed`)", watching the same ref, which follows the
  run's newest attempt. Four sessions of one plan had been sent to fix a CI that never ran.
- **A keychain proof is a watch verb** (control-tower phase 111, #201). `security find-generic-password`
  and `find-internet-password` are commands the judge accepts — attributes only: `-w` and `-g`, which
  print the secret, and every other `security` subcommand stay refused, each with its reason. The plan's
  own E5.1 proof and the human-steps fixture's declare as written, with no wrapper script.
- **Recheck on a declared external wall asks the wall** (control-tower phase 111, #204). The card's
  recommended verb ran the three done-checks, which a phase waiting on the outside world can only fail,
  and re-judged the wall `failed`/`no-handoff`. It now probes the declaration's watch refs through the
  watch clock: a landed one resumes the phase's own session exactly as the scheduler's landing does, and
  otherwise one `run.recheck` line names each ref and what it read, the wall left as it was.

## [6.0.0] - 2026-10-01

**Control Tower.** 6.0 makes an unattended run something a person can read at a glance and trust to
say when it needs them. The console's home is the **Tower** (`#/runs`): what needs you, what is
moving, what waits and what is next, each strip one sentence and one action, and amber only when a
person must act — a status word alone never paints it. A run that stops itself says why in one card
and comes back with one press; a failure is a failed phase, a declared wait is a wait, and a resumed
phase keeps its seat, its settings and its session. A person's turn — a sign-in, a code, an approval
at the machine — is a typed step with its own card and its own proof. The plan page is one phase table
with four views and a route map that holds seventy stations; runs, sessions, the repository and the
numbers were rebuilt on one data grid, one status model and one design law. Quick start is one screen,
and the guide explains every page in English and Persian. The free tree stays MIT. It is a major
version because the home, the plan page's tabs and the colour law changed under people's feet — the
list is below.

### Migration
- **The home is the Tower.** An empty or unknown address opens `#/runs`, and `#/now` and `#/dashboard`
  redirect there, keeping whatever half of the address still means something. A bookmark, a handoff
  link or a notification from 5.x still lands.
- **A plan page has three tabs** — Phases, Run, Source. The four lists that were Route, Phases, QA
  and Handoffs are the Phases tab's views (`?view=table|map|qa|handoffs`); the old tab addresses
  redirect into them.
- **Amber is a summons, never a status.** A board `stuck` phase reads **Stuck** in the waiting paint
  with an alert glyph; `halted`, `parked` and `gated` read as waits. Anything that asked you for
  something still turns amber, through its inbox item.
- **A `- **Human step:**` bullet in the 5.1.0 `<who, what, proof ref>` spelling fails the lint (F37).**
  Write the six-field grammar (`references/plan-format.md`) or leave the label off.
- **The failure streak counts failed phases, not endings.** The same phase failing twice is one
  failure, and a refused credential or a lost network never counts.
- **The decision manifest has nineteen keys** — `issues` and `plan-approval` joined the seventeen.
  A plan that answers neither keeps the shipped defaults (`off` and `hold`).
- **Update the console's scripts and the plugin together**, as at 5.1.0: a 5.1.0 `phase-outcome.sh`
  rejects `needs-human --step`, and a 5.1.0 `phase-graph.sh` has no `--human-steps` arm.
- **The console's heap is a number it chooses.** `viewer/run` passes `--max-old-space-size` as a node
  argument — never `NODE_OPTIONS`, which every `claude` child would inherit — from `heapMb` in
  `~/.config/phase-console/fleet.json` (6144 by default), clamped to half of RAM. A console started
  some other way keeps V8's default heap until it is started through `viewer/run` again.
- **For forks of the client:** the 2.x `Chip`, its tones and the `--line-*` / 2.x colour aliases are
  gone; badges are the typed status family under `components/ui/status/`, and ESLint refuses a raw
  `StatusBadge` import outside it.

### Added
- **The guide explains every page, in English and Persian** (control-tower phase 32). The help sheet
  gains four sections — Quick start, Getting around (a card for every page on the rail and every
  overlay), Tower and Halts — and every section now has a Persian twin beside its English body
  (`viewer/client/src/content/guide/<id>.fa.md`), held to the English section for section by
  `docs-parity.test.ts` and required by `guide-coverage.test.ts`, which also fails a page or an overlay
  that has no card.
- **A person's turn has a language** (control-tower phase 41; operator decision 7). An act only a
  person can do — a sign-in that opens a browser, a device code, a token to paste, a password at the
  machine, an approval on somebody else's dashboard — is a HUMAN STEP: one of sixteen typed kinds
  (`viewer/shared/human-step-model.js`, twin `scripts/human-steps.env`), eight states, and `KIND_META`
  as the one place a kind's icon, label, default `where` and proof hint are read. A session declares
  one with `phase-outcome.sh … needs-human --step <kind> --title … [--open-url | --open-command]
  [--where] [--proof] [--step-line]… [--code] [--credential]`; a value shaped like a token, a password,
  a one-time code or a URL query secret is refused with nothing written. A plan declares one with
  `- **Human step:** <kind> · <what> · open: … · proof: … · where: host|any · window: … [· auto-open:
  host]`, read by `phase-graph.sh --human-steps [N]` and its JS twin; the 5.1.0 `<who, what, proof
  ref>` spelling, which nothing ever parsed, is superseded and fails the lint by name (F37), and a step
  with no proof is advised about (F38). The console writes each step to an append-only ledger
  (`human-steps.ndjson`: last state wins, a torn last line dropped, a retention sink), raises ONE
  `human-step` inbox row and ONE `needs-you` push naming *Open* and *I did it* (and a device code),
  and parks the phase on a PERSON — an unbudgeted wait, situation `blocked-declared:human-acts`, no
  rung. No code, token, password or URL query secret reaches the ledger, a journal line, a push
  payload, the log or a transcript; a `secret-entry` secret goes to the credential registry (the
  keychain, else a 0600 file) and is never read back.
- **A person's turn can be acted on** (control-tower phase 43; operator decision 7). Six routes —
  `GET /api/human-steps[?open=1]` and `POST /api/human-steps/:id/{open,check,snooze,cannot,dismiss}`,
  each a move through the ledger's one door, attributed, journalled (`phase.human-step-opened`,
  `-checked`, `-proven`, `-snoozed`, `-cannot`, `-dismissed`, `-expired`, `-reminded`). *Open*
  answers the link for the caller's browser, or opens it on the machine behind `--allow-terminal` /
  `--allow-agent` only once the caller has sent back the full URL it was shown; a command step opens
  the embedded terminal, which prints the command and runs it on the person's Enter, and nothing
  typed there reaches the ticket, a journal or the ledger. Open again is unlimited short of a settled
  step. A step's proof is a WATCH ref, polled off the declaration on the `cmd:` back-off and bounded
  by the step's window (seven days when it names none), never by a wait budget; when it lands — or
  *I did it — check* finds it true, a terminal's exit 0 proves a step with no proof ref, and a person's
  word one with no proof at all — the step reads `proven` and the SAME session is resumed told what
  was proven. An unlanded check says what the proof read, in its own words. Reminders at +15 m, +1 h,
  +6 h, then daily, deferred out of the new `reminderQuiet` hours and past a snooze, replace the
  step's notification; at the window's end the step expires into an errand, and *I can't do this*
  becomes one at once carrying the reason — neither loops. *I did it* is a signed notification button
  (`check` in `PUSH_ACTION_VERBS`), and the step's inbox row offers check, snooze and cannot.
- **The console notices a person's turn** (control-tower phase 44; operator decision 7, its third
  birth channel). **The sign-in guard:** a supervised Bash call that starts an interactive sign-in
  (`SIGN_IN_SHAPES` — `gh auth login`, `az login`, `npx wrangler login`, … through wrappers,
  `sudo`, package runners, env prefixes, groups and chains; never a here-doc's data) is denied
  before it runs on every profile, `phase.tool-denied` rule `sign-in`, with the whole
  `needs-human --step …` declaration to make instead (`SIGN_IN_STEPS`: the kind, and the tool's own
  status verb as the proof only where the console's command judge runs that tool — `gh`, `npm`,
  `pnpm`, `yarn`; a password given with `-p` never reaches the journal); a status verb (`gh auth status`) and a sign-in with a non-interactive
  flag (`--with-token`, `--password-stdin`, `--identity`, …) run, and a call no run token names is
  untouched. **The stall reading:** a `silent` lane whose last output named an http(s) link beside
  waiting words (`SUSPECT_WAIT_WORDS`; "open this link in your browser" counts only for a link that
  is not the machine's loopback) carries `suspectedStep` and journals `phase.human-step-suspected`;
  its inbox row is raised at once, offers *Make it a person's turn*
  (`POST /api/human-steps/suspected`, `phase.human-step-converted`, a step born `console`; a second
  press answers the same step) and never converts or opens anything by itself; the reading is made
  over a result's whole text, and neither its link nor its words ever carry a device code. **The launch door:** probe 9 lists the plan's
  `- **Human step:**` bullets for the phases the run will drive, runs every proof at once through
  the watch clock's own probe, pre-clears the proven and returns the rest with their open actions
  (`Prelude.humanSteps`); a start records the owed ones in the ledger, born `plan`, just before the
  runner starts, and the reminder clock withdraws one once its phase's handoff reads complete. **The folds:**
  every inbox row that asks a person for an act carries one `humanStep` view (`humanStepView`,
  `HUMAN_STEP_FOLDS`) — a sign-in as `claude-login`, an MCP sign-in as `mcp-login`, the verification
  card as `person-check`, a plan to approve, a gate, a relayed question and a QA verdict as
  `decision`, phase 39's protected path as `protected-path` with the act and the path the session
  named (`Errand.step`) — and `os-permission` names its settings pane, `physical` carries a QR for
  its link.
- **Runs is the Tower** (control-tower phase 20; the operator's "a full live management page for
  runs", and #19's fence made visible). `#/runs` answers "does anything need me?" in one look: every
  run sits in exactly one bay, most urgent first — Needs you, Live, Waiting, Queued, Ready to start,
  Settled — read off the status model, so a run's bay is the one its strip computes. One situation
  line under the title counts the bays and the day's spend ("8 need you · tower is running — phase
  3 · 2 queued · $49.50 today", drawn as separate words). An annunciator of the nine halt families
  counts exactly the halt card's own categories; a lamp with nothing behind it is dim, and pressing
  a lit one narrows the bays to that family. What the Now page showed is absorbed rather than
  copied: its inbox rows sit in Needs you under the strips, its lanes ride the Live strips, and its
  Next up is Ready to start — the same set, with a Start that opens the launch dialog through its
  lazy door. Waiting and Queued say on each strip what holds it up: a hold, a scope fence with the
  fencing phase and the refs it waits on, an errand folded over several phases, and a phase queued
  behind a sibling run's branch. `?bay=needs-you` … `?bay=settled` opens the page on a bay; the
  filters (a lamp, a plan name) and Settled's fold are remembered. On a phone the bays stack and
  each strip's one action is the width of the strip, at its foot.
- **A run is a flight strip** (control-tower phase 19; the operator's "plan cards … make them
  better", the UI of #25 and #28, and #163's lane card). Each run on the Runs board is one strip:
  a left edge in the run's paint, its precise word and icon, whether it needs you, the name, the
  phase track, ONE clock that says what it measured ("running 12m 03s", "halted 4m ago", "ran
  1h 04m"), the cost with the session in flight counted, and exactly one action chosen by where
  the run stands — the halt card's own recommended verb for a stop, Pause for a live run, Thaw for
  a frozen one, Hold or Release in the queue, Open run on a console that cannot drive runs.
  Everything the old card showed is one press away, in place: the halt card, the lanes with their
  labelled clocks and last activity, the Now panel of each live lane, every clock of the phase,
  the cost meter, every other verb, Inspect and its raw record. A `run:progress` frame moves the
  strip with no refetch; the badge breathes only while a lane is observed working; the name's
  peek rides the link itself. Expanding opens with a `grid-rows` transition (no motion library)
  and is remembered per strip.
- **Starting a run is one screen.** The launch form is no longer five stages: it opens on what will
  run, the findings that need an answer (each with its own button), a preset row — Careful, Balanced,
  Hands-off, or your last launch — and nine tiles (Scope, Engine, Safety, Git, Money and stops,
  Review and QA, Tools, Accounts, Decisions) that each say what they are set to and open in place.
  How many values differ from a fresh console is one line above Launch. On a phone a tile opens as a
  page inside the same sheet, under the same fixed buttons. A value a preset set says *from preset*.
  When the plan's git lines disagree with the launch, the Git tile asks for honour or override
  before Launch, and each phase's permission mode says where it comes from. A run's launch also says
  how a QA recovery's fix session starts and what one QA round may spend.
- **Every status says what it is, not only what colour it is.** A status badge now always carries
  an icon and a word, so it reads without colour, and a word the console does not recognise says
  "Unknown" instead of borrowing another's look. A run whose plan was closed reads as superseded
  rather than waiting, and a finished run that had failures reads as partly done rather than green.
  Amber means one thing — a person is needed — so primary buttons and the keyboard focus ring are
  drawn in ink, and the only amber button is the one that asks you to allow something.
- **Figures you can read closer.** Every chart with an axis — weekly completions, the calendar of
  completions, the ranked lists and the stacked bars under Insights, and a run's timeline — now has
  a crosshair: hover, tap, or Tab to it and use the arrow keys, and the line under the figure says
  what it is on. ⌃ or ⌘ with the scroll wheel, or a pinch, zooms in; a plain scroll and a swipe
  still move the page. A live run's timeline follows its lanes as they report progress, with a
  "now" line and no reload, and a cost strip underneath shows what each attempt spent. Debug ▸
  Health opens on the console's own heap, event-loop delay and stream count. First paint is
  unchanged: the charts load when a page with one opens.
- **One data grid: filters, grouping, picks, a kept view and a window, on any table.** A table can
  now offer a filter per column (text, a list of values with their counts, or a number range),
  group its rows under a column's values, let rows be picked for a bulk action, remember how you
  left it, and draw only the rows in view once it holds more than 150. On a phone every setting is
  in one View sheet above the cards. A column you hide is still in each row's detail — nothing is
  removed from the page — and a table that asks for none of this looks exactly as it did. The
  delivery ledger under Debug is the first to use it. First paint went down by 8 KB.
- **A plan can say which permission mode its phases need, and a plan-mode phase waits for you.**
  `**Permission mode:** plan` (plan-wide) and `- **Permission mode:** acceptEdits` (one phase) set
  the mode a phase's session starts in; a run can set a default. A phase in plan mode now hands its
  plan to you: the run parks it, the inbox shows it with Approve and Reject, and Approve resumes
  the same session to carry the plan out.
- **A launch tells you which of the plan's git lines it will not honour, before anything runs** — a
  named branch it will not create, `Worktrees: on` or `Checkout: main` it cannot grant — and asks
  whether to honour them or run over them. Sessions are then told the branch they are really on.
- **The route map at seventy stations and more** (control-tower phase 30, #32 gap 3). A plan too
  big to show whole at the map's 0.45 zoom floor no longer opens as a field of specks (a 71-phase
  plan opened at 6 % on a phone, 1.9 px stations): it opens fit-to-width, every row across the
  frame at a tappable size, looking at the station that wants a person. Only what the window shows
  is drawn, so the DOM stays the size of the frame however long the plan grows (1,107 SVG nodes for
  71 stations before). A minimap under the frame shows the whole plan and the window's place on it,
  with the waves in view in words ("Waves 4–18 of 30"); a press on it moves the window. A station
  search (from twenty stations) moves the window to a phase by number or name and rings it; Enter
  walks the matches. The stations are one tab stop, and the arrow keys walk them — every station
  reachable, the window following. A phase the console is verifying now wears its own mark on the
  map. The spike that chose this over React Flow measured both engines on the same plan (React
  Flow's pane took a phone's vertical swipe); `check-dist` now asserts the plan route's static
  graph carries no map library, in either tree. `viewer/e2e/route-map.spec.ts` proves it in a real
  browser at all four viewports.
- **The console is now measured in a real browser before a release.** A tour of every page at
  phone, tablet and desk widths checks for rows that run off the screen, controls a thumb cannot
  reach, text too faint to read in either theme and keyboard focus you cannot see, against a
  recorded baseline that may only shrink (`npm run test:e2e` in `viewer/`, for contributors).
- **Clear the failure count** from a stopped run's card, without retrying a phase. The card also shows
  the count as *n of max*, and says plainly when every account you have registered is unusable — so
  "switch to another account" is never advice you cannot take.
- **Clocks that say what they measure.** A phase reports how long since it first started, how long
  its current attempt has run, how long it actually worked, how long it queued and how soon it made
  its first tool call — and its recorded duration is the worked figure, so two pages showing one
  phase show one number. A plan reports when work on it began, to the minute, and for how long.
  Every interval is written with one rounding rule: 119 seconds reads `1:59` on a clock and `1m 59s`
  in prose and tables, never `2m`. A quiet session says which silence it is in — no output at all,
  output but nothing produced, a tool call out, waiting on its own job, or waiting on somebody else's
  clock — and the threshold it is measured against.
- **A page for locks.** Sessions ▸ Locks lists every phase claim the console can see — who holds it
  and on which host, its session and whether that session is still alive, the branch and working
  tree it claimed, when its lease ends, whether it has lapsed, and which queued phases it is holding
  up — worst first, with the Release button beside each. The same rows are `GET /api/locks`, which
  can be narrowed to the live claims, the lapsed ones, or the claims on one repository.

### Changed
- **The record band says its status in words** (control-tower phase 26). In Repo, a working tree's
  role (Root, Run, Lane, Staging, By hand, Debris), whether its run is live, and each settle event
  (Settled, Landed, Pushed, Pending, Not supported here, Failed, Released, Pruned) are badges with an
  icon and a word, read off the status model like every other status, where they were a raw word on
  a hue; the words are owned once, in `shared/worktree-model.js`. In Insights a health issue's
  severity is a badge of its own beside the issue's kind, the orphan-folder count no longer paints
  amber, and the per-phase spend and each run against its budget sit under a fold named for their
  rows, one press away, the way a chart's numbers do.
- **Runs is the home, and Now is gone** (control-tower phase 21; the operator's "redesign the pages
  and integrate them"). `#/` and every address Now answered land on the Tower in one hop: `#/now` →
  `#/runs`, `#/now?focus=inbox|lanes|next` → `#/runs?bay=needs-you|live|ready`, `#/now?focus=plans`
  → `#/plans`, `#/dashboard` → `#/runs`, `#/ready` → `#/runs?bay=ready`, `#/pulse` →
  `#/runs?bay=live`; `#/search`, `#/guide` and `#/notifications` open their overlays over Runs. The
  rail is slim — 80 px, a glyph over each name, Runs first with the needs-you count — and the
  situation line moved from the Runs page into the shell header, on every page: on a desk each figure
  links to its bay, on a phone it is a plain row. The phone's tab bar is Runs · Plans · Sessions ·
  Insights · More. An empty Needs-you bay says when the convergence loop next looks, as Now's empty
  inbox did. The destinations are Runs, Plans, Sessions, Repo, Insights, Debug and Settings.
- **The license stays MIT.** Phase Console's source is now also offered under separate terms, and
  this free edition is unaffected: `LICENSE` is the same MIT text every earlier release carried, and
  `package.json` still says `MIT`. README and USAGE say so in a short Licensing section.

### Fixed
- **Unlocked, the route map lets a vertical swipe scroll the page again** (control-tower phase 30).
  `overscroll-behavior: contain` on the interactive frame — a scroll container that never scrolls —
  stopped the swipe `touch-action: pan-y` hands the browser from reaching the page.
- **A resumed phase keeps working, and its cost is counted once.** A phase the console resumed —
  after a wait, a limit or your instruction — used to run under a 60-turn cap meant for paperwork,
  and a resumed conversation's earlier spend was counted again on every resume. A resume now gets
  what is left of the phase's own turns (never fewer than 120), a resume that runs out is continued
  rather than stopped, one the console shut down waits to be resumed instead of failing, and each
  session's dollars are counted once; runs stored before this are corrected once, when the console
  starts. A "wrap up soon" notice that did not reach the session is sent again.
- **A run that was asked for some phases finishes only when those phases are really done.** Before,
  a run limited to a few phases could say "finished" while one of them was still waiting for you.
  Now it stops and says which phases are not done and what each is waiting on. A phase you skipped
  counts as settled; one with a request still open for you does not. Runs an older console called
  finished show the honest sentence when you open them.
- **A request for you goes away when its phase is done.** Finishing or skipping a phase now
  withdraws what it was asking you for, so the inbox stops showing work that no longer needs you.
- **An edit only you can make is named as one.** Claude Code does not let an unattended session edit
  files under `.claude/`. A session that runs into this now leaves you a request naming the edit and
  the path, instead of a permission card no setting can answer.
- **A phase can no longer wait on its own lock.** `phase-outcome.sh … --watch lock:<slug>/<N>` that
  names the declaring phase is refused, with a sentence saying what to write instead: that lock is
  released by the phase's own closeout, so the wait would end the moment the phase did. Name the lock
  that `phase-lock.sh conflicts` reported. A phase blocked on a decision for you keeps no timer.
- **A phase no longer builds or verifies against a tree another run left on its branch.** A run
  that checks a shared repository onto its branch now holds it until the run is over, not just while
  one phase works in it, and puts it back on the branch it found when it can. Another run's phase
  that needs that repository waits for it — the queue names the repository, the branch and the run —
  and `phase-lock.sh conflicts` says the same to a session started by hand. Every verification now
  records which branch and commit it compared against, and a failed one says so in its first line.
- **A problem outside the console no longer pulls more sessions into it.** When a phase stops on
  something outside the console — the repository refusing every check, say — the phases working in
  the same repository now wait behind it instead of starting and running into the same problem.
  Phases in other repositories carry on.
  - They start again when the problem clears, when you retry the phase that reported it or release
    its lock, or when its waiting time runs out.
  - A second phase reporting the same problem joins the first request for help instead of opening
    another one, and you are not notified twice.
  - A check the console runs for a waiting phase now slows down over time — after 5 minutes, then
    15, then an hour, then every 6 hours — and keeps going until the phase's waiting time runs out,
    instead of giving up after an hour.
  - When the thing a phase was waiting for arrives while its run is still going, the phase continues
    in that run, ahead of the queue, instead of being counted as a failed attempt.
  - A phase whose wait ended while another phase was using its repository now continues its own
    session when its turn comes, instead of starting over.
  - The console's messages say which checks it is still watching and which it has stopped running.
- **Recovery comes back when the machine does.** An outage could leave a phase waiting for a person
  long after the outage had passed.
  - A recovery step that failed because the machine could not reach the API, or had no account to
    use, is no longer counted as tried: it is offered again once things are working, a few times at
    most, and what it cost still counts against the spending limits.
  - Clearing or signing in an account now wakes the recovery up by itself, and a waiting "sign in an
    account" request is withdrawn as soon as one is usable.
  - The limit on recovery attempts per run counts only the phases still open, and an operator's Retry
    gives a phase back the attempts that restarts and outages used up.
  - When Claude Code is asked to hand off because its context is filling up, the fresh session that
    follows is no longer counted as a recovery attempt.
  - A run stopped by a recovery limit now says which limit, the numbers, and the setting that raises
    it — and a run can carry its own limits (*Recovery rungs* in the launch dialog), set when it
    starts or continues, or changed while it runs.
- **An outage is not a credential fault.** A network failure — or even a phase *writing about* one —
  could take every Claude account on the machine offline until somebody cleared them by hand.
  - A phase that finished its work and mentioned a TLS error code in its handoff had its account
    retired for saying so. Error patterns now demand the framing Claude Code actually prints, and a
    session that booked real turns or real spend is not overruled by what its output quotes.
  - "This machine cannot reach the API" is now a condition the console can name. It waits the outage
    out — a minute, two, five, ten, then a quarter of an hour — and charges it to nothing: no attempt,
    no failure count.
  - A certificate error takes several sightings, from several sessions, over several minutes before the
    console believes it, and then pauses one account rather than retiring it. A successful call
    afterwards reopens it by itself.
  - One account's refusal no longer retires every account in its organisation unless the API actually
    said the organisation was the problem — so switching accounts still works when one login cannot.
- **A refused credential no longer counts against the run's failure budget.** That count means "this
  plan keeps failing"; one network event spent a whole run's allowance in 39 seconds and left it stuck
  past its own ceiling.

## [5.1.0] - 2026-09-21

**Many plans, one repository.** Several plans can now work one repository at the same time without
treading on each other: each run in a checkout of its own, locks two processes cannot both win, one
trace id through everything a run does, and notes that reach a phase before it starts. It is a minor
version because it is additive — a 5.0.0 plan lints and runs unchanged, and every new door stays
closed until a plan directive or a capability flag opens it. `docs/releasing.md`, §Upgrading to 5.1.0,
is the list of what an older copy will notice.

### Migration
- **None.** Five lint ids are new — F26 `note-target-unknown`, F27 `land-word-unknown` and F29
  `landed-gate-unknown-phase` fail a plan, F28 `land-needs-lane` and F30 `note-target-done` advise —
  and each fires only on a directive 5.0.0 did not have. Update the console's scripts and the plugin
  together, as at 5.0.0: a 5.0.0 `phase-graph.sh` has no `--notes` arm and a 5.0.0 `phase-outcome.sh`
  rejects `--for`.
- **One tightening.** Nine shared-`.git` verbs (`git stash`, `config`, `worktree`, `submodule`,
  `checkout`, `switch`, and `gh issue create`/`comment`/`close`) now raise a permission card on every
  profile: one of them in a shared checkout is another lane's problem.

### Added
- **A checkout of its own, per repository.** A run's branch forks from the trunk at a pinned sha and
  records who chose the base; the console's worktrees are `git worktree lock`ed with a reason naming the
  console, the plan, the phase and the time, and sweeps unlock only the console's own stale locks. A
  retention word — `keep-on-failure` (the default) · `prune` · `keep` · `ttl:<h>` — says what becomes of
  a checkout when the run settles, and a dirty tree is never removed. A per-repository cap bounds how
  many isolated runs stand beside each other, `.worktreeinclude` copies ignored-but-needed files into a
  fresh worktree, and `- **Isolation:** shared|worktree` lets one phase carve itself out.
- **Locks two processes cannot both win.** A claim is made with `ln`, which the filesystem makes
  atomic; a lock with no `scope=` line reads as `all` everywhere; the runner claims provisionally at
  grant and stops the lane on losing the lock rather than editing on; the unsupervised outcome inbox
  stamps its filenames so a second declaration never destroys an unread first; run ids are twelve hex
  characters.
- **Worktrees, lanes and settles that tell the truth.** The run pruner reads the phase list from disk;
  merges into one tree are serialised per directory; a vanished lane directory is rebuilt and a drifted
  mirror mount is named and reattached; a settle that ends on a usage wall no longer claims the branch
  was published.
- **One trace id, one seam under every child process.** A run's trace id rides the HTTP request, the
  drive, every phase attempt, the spawned session, the scripts, the presence hook and every git command;
  one module is the seam under every child and logs its `argv`, `cwd`, `ms` and `code`. The log
  envelope is v2 with a `debug` level, `PHASE_CONSOLE_DEBUG=<channel>` admits one channel at `debug`,
  `/api/debug/level` flips it on a deadline, and a journal at its cap writes an in-band `journal.full`
  marker and keeps a reserve so `run.finished` is always reachable.
- **Nothing grows without a bound, and one run exports as one file.** A retention planner sweeps
  transcripts, task ledgers, outcomes, git traces and the supervisor's stdio by a table Settings ▸ This
  instance ▸ Logs and retention can preview before it acts; rulings are never pruned. Each session's raw
  hook payloads are kept beside its record, capped at 1 MB with one marker line. `GET
  /api/debug/bundle?slug=&run=` answers one run as a redacted tarball, and `phase-console diagnostics
  --run <id>` builds the same thing with no console up.
- **`--allow-publish`, the eighth capability flag.** Off by default like the other seven, it is what
  lets the console push a finished phase's `pe/*` branch — never a trunk, never with force — and file
  issues on the repository's behalf, where a plan's `permission.destructive` row allows the act.
  `phase-console doctor` gains a non-blocking `publish` row.
- **Notes reach the phase that needs them.** A handoff bullet addressed forward and a deferral ruling
  (`phase-outcome.sh … ruling --kind deferral --for <M|next|all>`) are collected by
  `phase-graph.sh <slug> --notes N` into that phase's boot prompt, shown on the plan page, and linted
  (F30) when addressed to a phase that has already finished.
- **The contracts.** Three new vocabularies with bash twins (landing, messages, issues); the plan
  directives `--land`, `--landing`, `--base-branch`, `--gitlink`, `--conflict-policy`, `--isolation`,
  `--clash-zones`, `--issues`, `--messaging` and `--notes`, each answering `word · phase|plan|default`;
  two self-evaluating gate kinds, `landed N` and `pr-merged N`, that read a ledger and run nothing;
  `scripts/phase-landing.sh`, the ledger's writer; and an eighteenth decision key, `issues`.
- **The verification launch door.** Every §Verification command a run would stop on is answered
  once, at the start door: the prelude's fifth probe, `verification`, lists each by exact text, phase
  and reason, to approve (bound to a hash of its whole text) or waive for the run; one verification
  review answers boarding, the start response, the plan page, plan health and the repair gate alike.
  The launch form says what each phase will run as and where the plan and the run differ; context is
  counted per call (`412K ctx · peak 455K · 2 rebuilds · 17 polls`) and a session is told to wrap up
  at 0.6 × its window; live spend shows beside booked spend.
- **`doctor` probes git** under the console's own `PATH`, blocking — under launchd that path led to
  Apple's `git` shim, which exits 69 until the Xcode licence is accepted.
- **`bootedAt` on `/api/state`** — the process's identity, so the page that pressed Restart reloads
  once a different one answers.
- **Smaller things.** Base branch, "Runs beside it in the repository" and "When the run settles, its
  checkouts" on the launch form and in Settings ▸ Automation; a `Land:` chip and a locked chip on the
  run and Now pages; a per-action words box on inbox rows; `refusalReasons` on `GET /api/state`;
  "Serialise conflicted branches" and "Call it looping after" among the automation preferences.

### Changed
- **One wait procedure, in every place a session meets it**, and a runaway run of status checks
  (six inside two minutes with nothing else between) is refused at the hook with the procedure.
- **A session is resumed only while it is worth resuming** — one that ended at ≥ 250k tokens and is
  cold, that declared `partial --reason budget|context`, or that the console checkpointed is boarded
  fresh with the resume brief.
- **A nearly spent account stops taking on lanes**, and a usage wall that cannot clear soon is waited
  out at the first burst rather than after twenty minutes of retries.

### Fixed
- **A fresh run carries the start door's `maxParallel`** — it reached a continued run and never a new one.
- **`bats` is a command**, `git merge-base`/`merge-tree` are reads, `2>&1` is not a separator, and
  `! grep …` is judged as the command it negates; a `$(…)` inside double quotes is judged too, and a
  backgrounded `cmd &` no longer reports green without waiting.
- **The self-heal no longer dead-ends or buys a session for an approval**, and a `Person-check: halt`
  park names the refused command and the remedy that exists.
- **Every turn of a multi-turn session is booked**; a phase this run worked is no longer called
  "closed outside this run"; `phase-console stop` reports a console stopped when its process has left;
  a hung server test fails by name; a terminal left open no longer holds the autopilot.
- **The findings 5.0.0 left open**, each ended in one state: a generated prompt names the docs root it
  was read from; the recovery panel stops offering a resume the policy refuses; a wait-resume onto a
  lost session boards with the resume brief; a pull request is no longer cancelled by a declined
  resume; the local-job nudge waits out the window the procedure grants; paging a file is not a poll;
  a closeout that could not resume says why in English; `preFirstTurn` asks what this session spent.

## [5.0.0] - 2026-09-15

**Zero-touch: what a run would stop to ask is asked before it starts.** This is a major version
because a plan, a session and a script that starts runs each meet something that now refuses.
`docs/releasing.md`, §Upgrading to 5.0.0, is the full list.

### Migration
- **Three lint ids now fail a plan.** F14 `verification-empty-open`: give every open phase's
  §Verification a runnable command. F24 `gate-directive-missing`: put a `- **Gate-check:**` line under
  every `*(GATED)*` heading. F25: every `outstanding` row in `## Decisions` names an owner, a known key
  and a known state. Lint every live plan with the 5.0.0 scripts before a console runs it.
- **`phase-outcome.sh … blocked|needs-human` requires `--needs <key|class>`.** A 4.1.0 copy of the
  script rejects the flag, so update the console and the plugin together.
- **A run started over HTTP must carry `resumeOnRestart`, `relay` and `accounts`** (400 without them).
  It is refused with 409 while a blocking decision is still open, a waiver is unacknowledged or a
  probe fails.
- **Defaults and names moved.** `delegateHumanGates` now ships on and `qa.exhausted` answers `waive`.
  `phase.tool-auto-granted` is now `phase.approval-auto-granted`, and `phase.resume-at-boot` is now
  `phase.resume-automatic`.
- **The relay needs `claude` 2.1.268 or later.** Sessions that are not relayed run with
  `--permission-prompts none` from 2.1.259.

### Added
- **The decision manifest.** `## Decisions` has seventeen keys; read it with
  `phase-graph.sh --decisions` and answer it with `scripts/decisions.sh`.
- **The run-start prelude.** Four probes run before anything spawns: accounts, MCP servers,
  credentials and a delivery channel. `phase-console doctor` runs the same probes by hand.
- **The policy table and ruling memory.** Eighteen kinds of interruption are answered by default and
  journalled. `--remember` promotes a ruling into the next plan, and the table is edited under
  Settings ▸ Automation ▸ Policy.
- **The relay.** A question a session asks is held for sixty seconds, then answered by rule, else the
  recommended option, else the first. It is never answered on a deny-list match.
- **Honest sessions.** Every stop sends SIGINT first, so turns and cost are booked. Every session
  carries a turn cap and a dollar cap, and every automatic start names its door and counts against a
  ceiling.
- **Honest waits.** A declared wait longer than the console's budget is refused with the arithmetic
  instead of being cut. Every resume checks that the session is not live, and an overdue clock at boot
  is ruled on rather than fired.
- **Accounts at the wall.** A credential an organisation refuses is retired for every console on the
  machine. The run climbs to the next account, or parks the phase with one errand.
- **An off switch that stays off.** Shut down lists what is running first, and Stay off holds every
  later boot until it is cleared. `phase-console sessions ingest` records session presence with no
  console up.
- **Delivery.** A console with no device to notify says so, and an unattended start with no channel
  asks for an acknowledgement.
- **Why a run started and what it cost,** on every run and session page, reconciled against the run's
  spend.

### Changed
- **The documentation describes all of the above** — `docs/`, the references, `SKILL.md` and the
  in-app guide, in English and Persian.

## [4.1.0] - 2026-09-08

### Added
- **Tagged releases.** Alongside the plugin channel — which is unchanged, and is still every push to
  `main` — each version now also gets a `vX.Y.Z` tag here and a GitHub Release carrying the packed
  tarball, so a machine without git can be handed exactly what a tag holds, and so an install can be
  pinned to a version rather than tracking `main`. The Releases page carries these notes per tag.

### Changed
- **This repository is published, not developed in.** `main` is replaced wholesale by each release
  rather than committed to by hand, which is why its history says when a version was published and
  nothing about how it got there. Issues and discussions are the way to reach the maintainers;
  pull requests against a generated tree cannot be merged.
