# The journal fixture

A bounded, redacted slice of the hub console's own run corpus — the runs the sep-review audit's
chapter 03 measured — so the gates whose numbers were taken on that corpus can be re-read against
real records rather than only against synthetic ones. The hub console is down with its plist armed
and the audit's standing advice is to leave it alone, so "re-run the measurement after the fix" is
otherwise unavailable (chapter 14, "Build a journal fixture before you start").

**Read it through `viewer/test/journal-fixture.ts`** (`fixtureRuns()`, `fixtureJournals()`,
`fixtureSlugs()`), never by path from a test, so the layout can change in one place.

## What is in it

Six plans, 9 journals (`run-<id>.jsonl`, one JSON object per line) and 9 run state files
(`run-<id>.json`, the shape `loadRun` reads), copied verbatim apart from the scrub below. Not
copied: the console logs (`*.log.jsonl` — megabytes of raw stream per run), the task lists
(`*-tasks.ndjson`), the outcome declarations and the rulings ledgers. Run ids (the 8-hex in each
file name) are kept: they are not identity, and the audit's chapters cite them.

| journal | lines | distinct events | sessions | session cost (USD) | `phase.live-wall` | `run.usage-window` | `phase.waiting` |
|---|---:|---:|---:|---:|---:|---:|---:|
| `ai-builder-v3/run-4cc22182.jsonl` | 357 | 52 | 3 | 104.59 | 1 | 89 | 3 |
| `ai-builder-v3/run-6784b222.jsonl` | 485 | 47 | 6 | 99.61 | 7 | 61 | 0 |
| `ci-cd-hardening/run-ea11c10d.jsonl` | 2947 | 67 | 20 | 270.69 | 11 | 428 | 0 |
| `customer-app-ios-release/run-31285928.jsonl` | 595 | 48 | 4 | 385.56 | 0 | 106 | 1 |
| `customer-app-ios-release/run-977825da.jsonl` | 103 | 32 | 2 | 29.02 | 0 | 0 | 1 |
| `mql-build-lane-hardening/run-ce8311fa.jsonl` | 169 | 19 | 1 | 0.00 | 0 | 2 | 0 |
| `mql-build-lane-hardening/run-e42cee9d.jsonl` | 2546 | 71 | 17 | 389.67 | 1 | 342 | 1 |
| `mql-lane-followups/run-a968152f.jsonl` | 74 | 21 | 0 | 19.96 | 0 | 9 | 2 |
| `scroll-world-focus-cut/run-e535b570.jsonl` | 280 | 41 | 5 | 32.26 | 0 | 25 | 0 |
| **total** | **7556** | | **58** | **1331.36** | **20** | **1062** | **8** |

| run file | status | phases | `halt.kind` as written by 4.1.0 |
|---|---|---:|---|
| `ai-builder-v3/run-4cc22182.json` | `finished` | 4 | — |
| `ai-builder-v3/run-6784b222.json` | `paused` | 6 | — |
| `ci-cd-hardening/run-ea11c10d.json` | `parked` | 19 | **none** — nothing left to run on its own — phase 19 is gated (gate not… |
| `customer-app-ios-release/run-31285928.json` | `parked` | 5 | **none** — nothing left to run on its own — phase 4 needs you — Ship-ga… |
| `customer-app-ios-release/run-977825da.json` | `paused` | 3 | — |
| `mql-build-lane-hardening/run-ce8311fa.json` | `paused` | 1 | — |
| `mql-build-lane-hardening/run-e42cee9d.json` | `finished` | 20 | — |
| `mql-lane-followups/run-a968152f.json` | `paused` | 2 | — |
| `scroll-world-focus-cut/run-e535b570.json` | `paused` | 2 | — |

The two `parked` files carry a `halt` with **no kind** — two of the four kindless halts the audit
found in 53 files (LFC-1), all four from the drive loop's "nothing left to run" park. They are kept
raw on purpose: `viewer/test/waiting-is-a-state.test.ts` walks every run file here through the real
loader and proves `settle()` gives each a kind from `HALT_KINDS` (`healLegacyHalt`). Rebuilding the
fixture from a corpus a newer console has already healed would take that evidence away — the test
says so if it happens.

`inventory.json` beside this file is the builder's own account of what it wrote; the table above
is generated from it.

## How it was scrubbed

`build.mjs` rewrites every file so that nothing in it points at a person, a machine or a customer,
and `.github/scripts/scrub.sh --dir viewer/test/fixtures/journals` — strict artifact mode — is the
gate (a §Verification line of zero-touch-console phase 2, and of every phase that touches this
directory):

- every UUID (session ids above all) → a stable pseudonym of the same shape, in first-seen order, so a
  record's `sessionId` still equals its `sessionGone.sessionId` and a journal's `--session-id` still
  matches its state file (113 distinct ids);
- every email address → `operator@example.com` (the CLI's own co-author trailer → `bot@example.com`);
- every home-directory path → `/home/operator/…`, the account name, the git user name and the GitHub
  handles → `operator`, the hostname → `operator-host`;
- the organisation → `example-org`, the private repositories' prefix → `acme-`, the admin app →
  `web-admin`, a private tool's name → `graph-tool`.

The replacements never change a string's JSON shape, and every line is re-parsed before it is
written. `viewer/test/state-isolation.test.ts` holds the whole fixture root to "nothing that points at
a real machine" on every run.

## Rebuilding

    node viewer/test/fixtures/journals/build.mjs --from <the console's runs/<instance> directory>

The source is the hub instance's `runs/4557c636-hub/` under the console's state home. The build is
deterministic — the same corpus gives the same bytes — but the corpus is live: a journal the hub
console is still appending to (`mql-lane-followups`, at the time of writing) grows between builds,
so a rebuild is a deliberate act that the numbers above should be re-derived from (`inventory.json`).

## Which gate reads which fixture

The audit's acceptance gates (`docs/audits/sep-review/14-acceptance-and-verification.md` in the
superproject) that exist to fix a runtime number measured on this corpus, and where their evidence
is. A gate is written first as an assertion over synthetic records — that proves the SHAPE is fixed;
the fixture is what lets it also say the corpus re-reads clean.

| gate | reads | in the fixture |
|---|---|---|
| **ACC-11.1** (LFC-1) — no run file carries a halt without a kind | every `run-*.json` through `loadRun` | the two kindless parks: `ci-cd-hardening/run-ea11c10d.json`, `customer-app-ios-release/run-31285928.json` — **wired in phase 2** |
| **ACC-3.1** (SES-1, SES-7) — a session ended by a signal resolves with `turns ≥ 1`, a cost and an `endedBy`; no `phase.session` carries `turns: 0` with `ms > 60 000` | `phase.session` rows (`data.turns`, `data.ms`, `data.costUsd`, `data.argv`) | 58 sessions across the 9 journals; the "18.99 h booked as 0 turns" shape is in `ci-cd-hardening` and `mql-build-lane-hardening` |
| **ACC-3.2** (SES-2, RCV-1) — the $223.69 spent on one refused credential classifies `resource-wall:auth` and stops after one heal | `phase.session` + `phase.situation` + `phase.rung` in the journals | `mql-build-lane-hardening/run-e42cee9d.jsonl`, `customer-app-ios-release/run-31285928.jsonl` |
| **ACC-2.5 / ACC-4.3** (SLF-5, WAI-3) — a run resumed from a past `waitUntil` journals `lateByMs`; a `parkedMs` beyond `WAIT_BUDGET_MS` halts rather than boards | `phase.waiting`, `phase.wait-resume`, the run file's `waitUntil` | `mql-lane-followups/run-a968152f` — the 11.76 h resume 13.2 s after boot |
| **ACC-4.5** (WAI-6) — no run file holds a `waiting` record with a past `parkedUntil` while `state.waitUntil` is null | every `run-*.json`'s `phases` and `waitUntil` | all 9 run files |
| **ACC-9.5** (ACT-6, ACT-7) — a rate-limit burst produces an errand and a wait, not a third `phase.live-wall {action:'none'}` | `phase.live-wall` and `run.usage-window` rows | 20 live walls and 1062 usage-window rows here (85 of 102 walls at `none` and 3 150 rows at one status across the full 53) |
| **ACC-3.8** (SES-8, LFC-8) — `allowed_warning` at `0.99` produces a decision, not only a `run.usage-window` row | `run.usage-window` rows | `ci-cd-hardening/run-ea11c10d.jsonl` holds most of the 1062 |
| **ACC-2.1** (SLF-1, LFC-7) — every automatic `run.start` carries a non-null `by` from `START_DOORS` | `run.start` rows | the 60 `run.start` lines here, 59 with no `by` — the "324 of 326" shape (phase 7 wires the doors; the fixture is the before-picture) |
| **G3 · the money** — chapter 14's dollar totals per plan | `phase.session.data.costUsd` | the session-cost column above (USD 1331.36 across the six plans) |

Phases 3–19 of zero-touch-console add their own rows here as they wire each gate.
