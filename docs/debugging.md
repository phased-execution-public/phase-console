# Debugging

Written for whoever is reading this next, which is usually an agent with no
memory of yesterday. It answers three questions in the order they get asked:
**where is the evidence**, **how do I tie it together**, and **what do I hand a
model**.

There is a page for all of it — `#/debug` in the console — and the page is a
reader of the endpoints below rather than a second source of truth. If you are
in a terminal, skip to [One bundle, for a model](#one-bundle-for-a-model).

## The one command

```bash
curl -s localhost:4123/api/debug/bundle | pbcopy
```

One redacted JSON snapshot of the whole surface: versions, capability flags,
health, the watch clock, every metric family, the recent log rows across
every source, and the delivery tally. It is sized to be pasted into a context
window — around 600 rows, a few hundred kilobytes — and it says what it left
out in its own `notes` array. Start here; open a file only when the bundle
points at one.

Add `?slug=<plan>` for one plan in full rather than the five most active.

## Where the evidence is

Seven places, and the log explorer merges all of them onto one time axis. The
names below are the `source` values on every row and in `?source=`.

| source | Where it is | What it holds |
|---|---|---|
| `console` | `~/.local/state/phase-console/console.log` (+ a 200-entry in-memory ring) | The console's own NDJSON log: every degradation, refusal and exit reason. Rotated at 8 MB to a single `.1`. |
| `supervisor` | `~/.local/state/phase-console/console.{out,err}.log` | A supervisor's raw stdout and stderr. **The only place a crash BEFORE the logger opened its file lands.** Present only when something supervises this console; the row says so when there is none. |
| `journal` | `runs/<instance>/<slug>/run-<id>.jsonl` | The run's own journal — every event kind is catalogued in [journal-events.md](journal-events.md). One line per thing a lane did. |
| `outcome` | `runs/<instance>/<slug>/outcomes/phase-NN.json` | What an **unsupervised** session declared about how it ended. A file here that the console will not act on shows up as `outcome.unreadable`, which is worth knowing. A declaration the console set aside — stale, unparseable, or one whose act threw — is kept under `outcomes/ignored/<name>.<reason>`, never deleted, and journalled `phase.outcome-ignored` (WAI-7). |
| `ruling` | `runs/<instance>/<slug>/rulings.ndjson` | What sessions **decided** — ambiguities, deviations, deferrals. Per plan, append-only. |
| `delivery` | `~/.local/state/phase-console/notifications/notifications.jsonl` | One row per device per announcement. Vocabulary below. |
| `health` | in memory, from `env-doctor.ts` | The environment doctor's findings, each carrying its own fix. |

Two more per-run files are not in the index because neither is a log:

- `runs/<instance>/<slug>/run-<id>.json` — the **checkpoint**: one record per
  phase, its status, its session id, its worktree and branch. This is the file
  to read when you want state rather than history.
- `runs/<instance>/<slug>/run-<id>-p<N>-tasks.ndjson` — a phase's published
  task list (`phase-tasks.sh`), which the console renders as *"What it is
  doing"*.

`<instance>` is derived from the source directory's path — ask for it rather
than spelling it: `node -e "import('./viewer/shared/instances.mjs').then(m =>
console.log(m.instanceId('/path/to/repo')))"`, or just read `root` off the
bundle and let the endpoints resolve it.

## Reading the logs

```
GET /api/debug/index?source=journal&level=error&slug=<plan>&q=<text>&since=<ISO>&limit=500
```

Every parameter is optional and repeatable (`?source=a&source=b`). An unknown
word is **dropped, not honoured** — `?source=journals` shows everything rather
than nothing, because a typo that silently selects an empty set looks exactly
like a quiet system. `?slug=` and `?run=` are the exceptions: both name a path
segment, so a value that is not a plan slug / an eight-hex run id is **refused
with a 400** rather than ignored. (They are a pair for a reason — guarding one
of them left the other reading files outside the state directory, and creating a
directory out there on the way, because the journal reader makes its parent.)

The answer is `{ entries, sources, truncated, slugs }`:

- `entries` — newest first. A row with no usable timestamp carries `at: ""` and
  sorts to the **end**, where you can see it is unplaced rather than old.
- `sources` — one status per source, **including the ones that could not be
  read**, each with a `note` saying why. "There is no supervisor log on this
  machine" and "the supervisor log is empty" mean opposite things and this is
  where the difference lives.
- `truncated` — the limit cut the answer. Narrow, or ask with `?since=`.
- `slugs` — which plans this answer covers. An unscoped read walks the 8 most
  recently active, never every plan on disk.

`GET /api/debug/tail?…` is the same query as a Server-Sent Events stream, one
`entries` frame every two seconds. It exists for the page's Follow switch; in a
terminal, `?since=` is cheaper and it does not hold a socket open.

Each frame carries an `id:`, so a browser resends it as `Last-Event-ID` and a
reconnect continues instead of skipping — the gap a sleeping laptop opens is
bridged on the next tick. `?after=<ISO>` is the same thing for a caller that is
not a browser, and the handshake reports `resumed`.

The one loss a tail really has is a gap wider than a single pass's row cap. A
frame that filled it carries `capped: true`, and the page says so. (An earlier
build computed a `behind` flag at the handshake and claimed rows were gone that
the next tick delivered — announcing a loss that did not happen is the same
defect as absorbing one that did.)

### Levels

The journal has no severity column — it was written for a timeline, where every
line is equal — so a level is derived from the event kind's own suffix:
`-failed` / `-refused` / `.halted` / `-broken` are `error`; `.stall` / `.rung` /
`.parked` / `-timeout` / `.wall` / `-red` / `.retry` / `.interrupted` are `warn`;
everything else is `info`. An unrecognised kind reads `info` on purpose — a
false warning trains a reader to filter warnings out, which costs more than a
missed one.

## Tying it together

Six identifiers name the same piece of work, and each file knows only some of
them. This is the walk:

1. **Start with the plan slug.** Everything is under
   `runs/<instance>/<slug>/`, and every log row carries `slug` when it has one.
2. **slug + phase → the lock.** `docs/handoffs/<slug>/.locks/phase-NN.lock` is
   a flat `key=value` file holding `owner`, `scope`, `session`, and — when the
   work rides its own checkout — `branch` and `worktree`. This is the only file
   that ties a session id to a place on disk.
3. **slug → runId.** The run files are `run-<id>.*`; the newest is the live
   one. `GET /api/debug/runs?slug=<plan>` lists every run that has a journal,
   including finished ones.
4. **runId + phase → the session.** The checkpoint (`run-<id>.json`) carries
   `sessionId` per phase record, and the journal's `phase.boarded` line names
   the session an attempt was given.
5. **session → the transcript.** `run-<id>.log.jsonl` is the SSE replay ring
   for that run; a Claude session's own transcript is the CLI's, not the
   console's.
6. **phase → why it is not done.** `GET /api/run/<slug>/diagnosis/<phase>` is
   the richest single payload this console has: the command output, the
   session's closing words, the lint summary, the board-vs-handoff
   disagreement, the lock, the working tree, and what can still be done about
   it. The Debug page's Journal section renders it beside the run's timeline.

A worked example — *"phase 7 says stuck and I do not know why"*:

```bash
# what the board thinks, and what the handoff says
scripts/phase-graph.sh <slug>
curl -s 'localhost:4123/api/run/<slug>/diagnosis/7'

# every error the run wrote, in order
curl -s 'localhost:4123/api/debug/index?source=journal&level=error&slug=<slug>&phase=7'

# did the session declare an outcome nobody acted on?
curl -s 'localhost:4123/api/debug/index?source=outcome&slug=<slug>'

# who holds the lock, on which branch, in which tree
cat docs/handoffs/<slug>/.locks/phase-07.lock
```

## The delivery ledger

One row per device per announcement. The five outcomes, and what each counts as:

| Outcome | Means | Counts as |
|---|---|---|
| `sent` | The push service **accepted** it — not "you saw it". The browser and the OS are two more yeses. | delivered |
| `throttled` | 429 with a retry-after; not resent. | not delivered |
| `failed` | A service rejection. Counts toward the 15-strike device drop. | not delivered |
| `gone` | 404/410 — the subscription is dead; the device row is dropped at once. | not delivered (deliberate) |
| `quiet` | The device was inside its quiet hours; nothing attempted, on purpose. | held — neither |

The bundle's `delivery` block counts an announcement **undelivered** only when
no device took it, which is a different question from how many rows said
`failed`: a fan-out to three devices where one succeeded is delivered. An
announcement every device held as `quiet` is not undelivered either — nothing
was attempted, on purpose.

## One bundle, for a model

`GET /api/debug/bundle` — `?slug=<plan>` to scope it, `?download=1` to save it
as a file.

```
schema        "phase-console/debug-bundle"
version       1
generatedAt   ISO 8601
console       version, instance, generation, platform, node, uptime, the
              capability flags, whether the terminal went away, whether the
              previous process exited cleanly, and the /api/state facts a
              bundle is worth carrying
root          the source directory, home-masked, or null
plans         [{ slug, runs: [runId] }] — 5 plans, 5 runs each, unless scoped
health        { environment: [{ kind, detail, fix }], watches: { passes, asked, open } }
metrics       every family from /api/metrics, parsed: { name, type, help, samples }
delivery      { outcomes: {sent: n, …}, undelivered, announcements, devices }
entries       up to 600 log rows across every source, newest first
sources       the same per-source status the index returns
notes         what was left out, and how to ask for it
```

`version` moves when the SHAPE moves — a key added, removed or retyped — and
not when a key's contents change. A reader keyed on `version: 1` can trust
these keys are there; it cannot assume a fixed set of journal event kinds
inside `entries`, and should not.

### What is redacted, and what that costs you

Everything that leaves the server — **the index as well as the bundle** — goes
through two passes:

1. **Secret shapes**, via the same `redact()` the webhook payloads use: PEM
   blocks, `sk-`/`ghp_`/`xox`/AWS-key/JWT prefixes, `token=` and
   `Authorization: Bearer` assignments, credentials in a URL's userinfo, vendor
   webhook URLs, and any run of 40+ mixed-case-with-digits characters. A git
   sha, a UUID, a slug and an ISO timestamp all survive — none of them has the
   case mix.
2. **The operator's home path**, masked to `~` — the macOS `Users` form and
   the Linux `/home/<name>` one alike, whether or not it is this machine's: a
   journal written on one box and read on another still names somebody.
   (`.github/scripts/scrub.sh` refuses the literal macOS prefix anywhere in a
   committed file, which is why this paragraph spells it out rather than showing
   it.)

This applies to the L3 raw record the page shows you too, which is the one
surprise worth stating: a value in the file on disk can read `[redacted]` here.
The reason is that the console is reachable from a phone over a tailnet, and a
log line is the single most likely place for a token to have been echoed by a
command. One rule for every export path, so there is no surface where a secret
survives.

## Traps

- **`sent` is not "delivered to a human".** See the table above. A ledger read
  as a green tick is the one way this data actively misleads.
- **Metrics are a snapshot, not a series.** `/api/metrics` renders the current
  facts on every scrape and the console stores no history. The Health section
  charts one sample; the thing on the Debug destination that genuinely is a
  timeline is the run journal.
- **The console log and the supervisor log are different failures.** A crash
  before the logger opened its file exists only in `console.err.log`, and that
  file exists only when something supervising the console started it.
- **A restarted console has an empty ring and a full file.** The index reads
  both and de-duplicates, so the newest lines survive a rotation — but
  `log.recent()` alone is per-process.
- **A row beginning `…` is one line longer than the read window.** A crashing
  process printing an unbroken blob is how the supervisor log fills; the tail is
  shown, marked, rather than the file being reported as empty.
- **A `[…N more]` element or a `[…]` key means breadth was cut**, and `[deep]`
  means depth was. All three appear inside an L3 record; none of them is data
  the source had.
- **An unscoped read covers 8 plans, and the bundle 5.** Both say so. If the
  plan you care about is quiet, name it with `?slug=`.
- **`?source=` filters, `?level=` filters, and an unknown word does neither.**
  Check the `sources` block if a read comes back empty: it will say whether the
  source was unreadable or merely had nothing.

## See also

- [Journal events](journal-events.md) — every event kind, what emits it, and
  what it means. Machine-checked in both directions.
- [Metrics](metrics.md) — the exposition `/api/metrics` serves and the contract
  its names are.
- [The loop](loop.md) — how a stopped phase is read, and what the ladder tries
  before it asks a person.
- [Safety rails](safety-rails.md) — what an unattended session may and may not
  do.
