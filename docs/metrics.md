# 📊 Metrics — `GET /api/metrics`

> *What the console spent, what it is driving, and how far along it is — in Prometheus text.*

```bash
curl -s 127.0.0.1:4620/api/metrics | head -20
```

Everything the cost and progress pages show is on this endpoint too, so a figure can be alerted on
rather than watched. It is a plain read like every other GET: no flag turns it on, no token guards
it, and the console binds to loopback.

**20 families.** The list below comes from `viewer/server/analysis/metrics.ts` `METRIC_FAMILIES`,
and `viewer/test/docs-parity.test.ts` holds this document to it — a family added to one and not the
other fails the suite, as does calling a counter a gauge.

## Scraping it

```yaml
# prometheus.yml
scrape_configs:
  - job_name: phase-console
    static_configs:
      - targets: ['127.0.0.1:4620']
    metrics_path: /api/metrics
```

The port is whichever this console is on; `phase_console_build_info` carries the instance name.

**Raise `scrape_timeout` above your first scrape.** The endpoint reads every plan's board, so the
first request after a console restart pays the cold read for all of them and everything after it is
served from cache — measured on a 119-plan library: **20 s cold, 10–13 ms warm.** That is the same
cost the Plans page pays, not something this endpoint adds, but Prometheus's 10 s default will time
the first one out and retry. `phase_console_scrape_duration_seconds` reports it, so you can see
which kind of scrape you got.

## The families

| Metric | Type | What it answers |
|---|---|---|
| `phase_console_build_info` | gauge | Console version and instance, always 1. |
| `phase_console_scrape_duration_seconds` | gauge | Seconds spent assembling this response. |
| `phase_console_plans` | gauge | Plans, by plan status and whether the operator has closed them. |
| `phase_console_phases` | gauge | Phases per plan, by board state. |
| `phase_console_plan_progress_ratio` | gauge | Done phases over total phases, 0 to 1. |
| `phase_console_plan_remaining_weight` | gauge | Unfinished phase weight, in the plan sizing units. |
| `phase_console_runs` | gauge | Autopilot runs per plan, by run status. |
| `phase_console_phase_attempts_total` | counter | Sessions the console has launched for a plan. |
| `phase_console_phase_seconds_total` | counter | Wall-clock seconds phases of a plan have run for. |
| `phase_console_spend_usd_total` | counter | USD every session of a plan has cost (the run total). |
| `phase_console_phase_spend_usd_total` | counter | USD attributed to a numbered phase of a plan. |
| `phase_console_spend_residual_usd` | gauge | Run total minus what is attributed to phases. Non-zero means a run file disagrees with itself. |
| `phase_console_ladder_spend_usd_total` | counter | USD the remediation ladder was charged on a plan. A SUBSET of the run total. |
| `phase_console_ladder_rungs_total` | counter | Ladder rungs climbed, by rung and how each ended. |
| `phase_console_settled_usd_today` | gauge | USD settled by phases that ended today, in the operator's zone. |
| `phase_console_ladder_usd_today` | gauge | USD the ladder was charged today - the figure the day cap refuses a rung against. |
| `phase_console_day_cap_usd` | gauge | The ladder's per-day USD cap. Absent when no cap is set. |
| `phase_console_worktrees` | gauge | Console-managed checkouts a plan's isolated run holds. Absent when no isolated run exists. |
| `phase_console_worktree_disk_bytes` | gauge | Bytes those checkouts occupy. Absent where du could not answer. |
| `phase_console_branch_conflicted_files` | gauge | Files a plan's run branch already conflicts on with another live branch. |

**Labels.** `slug` on everything per-plan; `state` on `phase_console_phases`
(`done` · `ready` · `in-progress` · `waiting` · `stuck`); `status` and `closed` on
`phase_console_plans`; `slug` and `status` on `phase_console_runs`; `rung` and `outcome` on
`phase_console_ladder_rungs_total`; `version` and `instance` on `phase_console_build_info`.

Never a **run id** — a run id is minted per boarding, so labelling by one would mint a dead series
every time the autopilot starts a run, and a scraper keeps those forever. Per-plan is the
granularity the questions are asked at.

## Three things to know before you alert on these

**The names are a contract.** Once you scrape this, a rename breaks your dashboard silently, weeks
later. So a family is never renamed or repurposed and a label is never added to an existing family
— new facts arrive as new families. `_total` is a counter and everything else is a gauge, with no
exceptions: `rate()` over a mislabelled family is wrong in a way nothing reports.

**The money adds up in one direction only.** Every session books the same dollars to its run total
*and* to its phase record, and again to the ladder rung that caused it when one did. So:

- `phase_console_spend_usd_total` is the money. It is the one to sum.
- `phase_console_phase_spend_usd_total` is the same money, seen per phase — equal in a healthy run.
- `phase_console_ladder_spend_usd_total` is a **subset** of both. Adding it double-counts repair.
- `phase_console_spend_residual_usd` should be `0`. A non-zero value is a run file disagreeing with
  itself, which is worth an alert of its own.

**The three worktree families are ABSENT, not zero, until a run isolates.** `phase_console_worktrees`,
`phase_console_worktree_disk_bytes` and `phase_console_branch_conflicted_files` report only on runs
working in a checkout of their own (*Give this run its own checkout*, on the launch form — see
[what you control](controls.md)), so on a console that has never isolated
anything the families do not appear at all — `absent()` is the alert to write, not `== 0`. Once a run
does isolate, `phase_console_branch_conflicted_files` **is** `0` while its branch is clean, which is a
different fact and the one worth alerting on: a non-zero value means a merge conflict is already
sitting between two live branches, and the console raises the same fact as a `conflict` inbox item
with a one-press remedy. `phase_console_worktree_disk_bytes` goes absent for one slug where `du`
could not answer, without taking the other slugs' samples with it.

**A counter resets if you delete a run file.** That is the only way these go backwards, and
`rate()`/`increase()` already handle it. Nothing here is reset by restarting the console: the
numbers are read from the run files on disk, not from process memory.

## What is NOT here

No note, no title, no path, no owner, no session id, no prompt — a scrape is counts, slugs and
money. That is what makes it safe to leave open on a laptop, and it is deliberate rather than
incidental: if you need the words, the pages have them.

Nothing about **cost per model** either. It exists per plan (Insights ▸ *What this plan cost* ▸ *By
model*, and the CSV) but a phase books to the model it *ended* on, so a fallback mid-run makes the
per-model split a summary rather than an accounting — not a number to alert on.
