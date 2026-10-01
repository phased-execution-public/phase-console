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
