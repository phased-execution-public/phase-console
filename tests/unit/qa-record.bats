#!/usr/bin/env bats
# qa-record.sh writes test-status.md that the phased-execution engine reads back.
load ../helpers/test_helper

@test "qa-record creates test-status and records a pass the engine can read" {
  setup_docs diamond demo
  qa_record demo 1 pass --report reports/phase-01-qa.md
  [ -f "$DOCS_ROOT/docs/handoffs/demo/test-status.md" ]
  run pg demo --qa-result 1
  [ "$output" = "pass" ]
}

@test "qa-record upserts in place (no duplicate rows) when the result changes" {
  setup_docs diamond demo
  qa_record demo 1 pending
  qa_record demo 1 pass
  run pg demo --qa-result 1; [ "$output" = "pass" ]
  n=$(qa_status_rows "$DOCS_ROOT/docs/handoffs/demo/test-status.md" 1)
  [ "$n" -eq 1 ]
}

@test "qa-record fail gates dependents; pass releases them (engine end-to-end)" {
  setup_docs diamond demo
  write_handoff demo 1 root complete
  qa_record demo 1 fail
  run pg demo --ready; [ "$output" = "" ]
  qa_record demo 1 pass
  run pg demo --ready; [ "$output" = "2 3" ]
}

@test "qa-record rejects an invalid result" {
  setup_docs diamond demo
  run qa_record demo 1 maybe
  [ "$status" -ne 0 ]
}

@test "qa-record records the report path in the table" {
  setup_docs diamond demo
  qa_record demo 2 pass --report reports/phase-02-qa.md
  grep -q 'reports/phase-02-qa.md' "$DOCS_ROOT/docs/handoffs/demo/test-status.md"
}

# --- creating test-status.md must not retroactively un-verify (B1) ------------
# `new-handoff.sh` backfills already-complete phases as `waived` when it creates
# the file; `qa-record.sh` did not — and `Service.activateQa` reaches THIS path.
# Turning QA on mid-plan therefore flipped every finished phase's dependents
# from ready back to waiting, with no verdict recorded anywhere.

@test "qa-record: creating the file backfills completed phases as waived" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  run qa_record diamond 2 pending --report reports/phase-02-qa.md
  [ "$status" -eq 0 ]
  run cat "$DOCS_ROOT/docs/handoffs/diamond/test-status.md"
  assert_contains "$output" "| 1 | waived |"
}

@test "qa-record: the backfill leaves the ready set where it was" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  run pg diamond --ready
  [ "$output" = "2 3" ]
  qa_record diamond 2 pending --report reports/phase-02-qa.md
  run pg diamond --ready
  [ "$output" = "2 3" ]          # was "" before the backfill existed
}

@test "qa-record: an existing file is never re-backfilled" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  qa_record diamond 1 fail --report reports/phase-01-qa.md
  qa_record diamond 2 pending --report reports/phase-02-qa.md
  run cat "$DOCS_ROOT/docs/handoffs/diamond/test-status.md"
  assert_contains "$output" "| 1 | fail |"
  refute_contains "$output" "| 1 | waived |"
}

# --- engine-14 / xcut-13 -----------------------------------------------------

@test "qa-record: the activation backfill never writes a phase twice" {
  # engine-14. new-handoff.sh's equivalent backfill wraps its append in an
  # already-present guard; this one appended once per handoff FILE, and a phase
  # re-handed-off under a second kebab title has two. The upsert below only ever
  # replaced the FIRST matching row, so the duplicate outlived every later
  # verdict — a stale `waived` sitting under a recorded `fail`.
  setup_docs linear linear
  write_handoff linear 1 alpha complete
  write_handoff linear 1 rework-alpha complete
  qa_record linear 2 pass --report reports/p2.md
  f="$DOCS_ROOT/docs/handoffs/linear/test-status.md"
  [ "$(grep -cE '^\|[[:space:]]*1[[:space:]]*\|' "$f")" -eq 1 ]
}

@test "qa-record: an existing duplicate row self-heals on the next record" {
  setup_docs linear linear
  write_handoff linear 1 alpha complete
  qa_record linear 1 waived
  # Simulate a table written by a copy of this script from before the guard.
  printf '| 1 | waived | - |\n' >> "$DOCS_ROOT/docs/handoffs/linear/test-status.md"
  qa_record linear 1 fail --report reports/p1.md
  f="$DOCS_ROOT/docs/handoffs/linear/test-status.md"
  [ "$(qa_status_rows "$f" 1)" -eq 1 ]
  assert_contains "$(cat "$f")" "| 1 | fail | reports/p1.md |"
}

@test "qa-record: a zero-padded phase records the same row as the plain number" {
  setup_docs linear linear
  qa_record linear 08 pass --report reports/p8.md
  f="$DOCS_ROOT/docs/handoffs/linear/test-status.md"
  assert_contains "$(cat "$f")" "| 8 | pass | reports/p8.md |"
  qa_record linear 8 fail
  [ "$(qa_status_rows "$f" 8)" -eq 1 ]
  assert_contains "$(cat "$f")" "| 8 | fail | - |"
}

@test "qa-record: --note is gone rather than silently discarded" {
  # xcut-13. It was declared, parsed, validated — and then echoed to stdout and
  # thrown away: test-status.md has three columns and no reader could have seen
  # a fourth. A flag that looks like it records something and does not is worse
  # than no flag; the place for a QA note is the report --report points at.
  setup_docs linear linear
  run qa_record linear 1 pass --note "some prose"
  [ "$status" -eq 2 ]
  assert_contains "$output" "unknown option: --note"
}

# --- rounds (issue #7) --------------------------------------------------------
# A verdict and a history are different questions. `## QA status` keeps ONE row
# per phase — the verdict that gates — now carrying the round that produced it;
# `## QA rounds` is the append-only ledger `--qa-history` lists. Before this,
# re-recording overwrote the row and the earlier reports were invisible to the
# engine, the API and every screen: 22 report files across 12 phases on the run
# issue #7 was written from, one of them five rounds deep.

@test "qa-record: --round writes the round into the status row and the ledger" {
  setup_docs linear linear
  qa_record linear 1 fail --report reports/phase-01-qa.md --round 1
  f="$DOCS_ROOT/docs/handoffs/linear/test-status.md"
  assert_contains "$(cat "$f")" "| 1 | fail | reports/phase-01-qa.md | 1 |"
  assert_contains "$(cat "$f")" "## QA rounds"
  run pg linear --qa-result 1; [ "$output" = "fail" ]
}

@test "qa-record: fail round 1 then pass round 2 — one gating row, two rounds" {
  setup_docs linear linear
  qa_record linear 1 fail --report reports/phase-01-qa.md --round 1
  qa_record linear 1 pass --report reports/phase-01-qa-round2.md --round 2
  f="$DOCS_ROOT/docs/handoffs/linear/test-status.md"
  # The verdict that gates is the LAST one, and there is exactly one of it.
  [ "$(qa_status_rows "$f" 1)" -eq 1 ]
  run pg linear --qa-result 1; [ "$output" = "pass" ]
  # Both rounds survive, oldest first, each still pointing at its own report.
  run pg linear --qa-history 1
  [ "${lines[0]}" = "$(printf '1\tfail\treports/phase-01-qa.md\t%s' "$(date +%Y-%m-%d)")" ]
  [ "${lines[1]}" = "$(printf '2\tpass\treports/phase-01-qa-round2.md\t%s' "$(date +%Y-%m-%d)")" ]
  [ "${#lines[@]}" -eq 2 ]
}

@test "qa-record: the round defaults to previous + 1" {
  setup_docs linear linear
  qa_record linear 1 fail
  qa_record linear 1 fail
  qa_record linear 1 pass
  run pg linear --qa-history 1
  [ "${#lines[@]}" -eq 3 ]
  assert_contains "${lines[2]}" "3	pass"
}

@test "qa-record: re-recording the SAME round replaces it rather than duplicating" {
  # The script's whole contract is that running it twice is running it once.
  setup_docs linear linear
  qa_record linear 1 fail --round 2
  qa_record linear 1 pass --round 2
  run pg linear --qa-history 1
  [ "${#lines[@]}" -eq 1 ]
  assert_contains "${lines[0]}" "2	pass"
}

@test "qa-record: --round is refused with pending, not silently dropped" {
  # `pending` is the ABSENCE of a review, so there is no round it could be the
  # Nth of — and this file already carries one lesson (--note) about a flag that
  # looks like it records something and does not.
  setup_docs linear linear
  run qa_record linear 1 pending --round 1
  [ "$status" -eq 2 ]
  assert_contains "$output" "a round is a review that happened"
}

@test "qa-record: a pending verdict is recorded roundless" {
  setup_docs linear linear
  qa_record linear 1 pending
  run pg linear --qa-history 1
  [ "$output" = "" ]
  run pg linear --qa-result 1; [ "$output" = "pending" ]
}

@test "qa-record: --round rejects zero and non-numbers" {
  setup_docs linear linear
  run qa_record linear 1 pass --round 0;   [ "$status" -eq 2 ]
  run qa_record linear 1 pass --round two; [ "$status" -eq 2 ]
}

# --- the legacy three-column table --------------------------------------------
# Every table written before rounds existed has three columns, and the engine
# must go on reading it identically — `Result` is the third cell either way.

@test "qa-record: a legacy three-column table keeps its verdicts and gains a Round header" {
  setup_docs linear linear
  f="$DOCS_ROOT/docs/handoffs/linear/test-status.md"
  cat > "$f" <<'EOF'
# QA / test status — linear

## QA status

| Phase | Result | Report |
|------:|--------|--------|
| 1 | pass | reports/phase-01-qa.md |
| 2 | fail | reports/phase-02-qa.md |
| 3 | waived | - |
EOF
  run pg linear --qa-result 1; [ "$output" = "pass" ]
  run pg linear --qa-result 2; [ "$output" = "fail" ]
  run pg linear --qa-result 3; [ "$output" = "waived" ]
  # Recording anything upgrades the header in place; the untouched rows keep
  # their verdicts and simply have no round, which is what they genuinely are.
  qa_record linear 2 pass --report reports/phase-02-qa-round2.md
  assert_contains "$(cat "$f")" "| Phase | Result | Report | Round |"
  run pg linear --qa-result 1; [ "$output" = "pass" ]
  run pg linear --qa-result 2; [ "$output" = "pass" ]
  run pg linear --qa-result 3; [ "$output" = "waived" ]
}

@test "qa-record: a legacy fail counts as round 1, so the pass answering it is round 2" {
  setup_docs linear linear
  f="$DOCS_ROOT/docs/handoffs/linear/test-status.md"
  printf '# QA\n\n## QA status\n\n| Phase | Result | Report |\n|------:|--------|--------|\n| 1 | fail | reports/phase-01-qa.md |\n' > "$f"
  qa_record linear 1 pass
  run pg linear --qa-history 1
  # Oldest first — the legacy row is backfilled into the ledger as the round it
  # was, so the history reads 1 then 2 rather than starting at 2 (QA F2).
  assert_contains "${lines[0]}" "1	fail"
  assert_contains "${lines[1]}" "2	pass"
}

@test "qa-history: a legacy row with no ledger still reports the round that happened" {
  setup_docs linear linear
  f="$DOCS_ROOT/docs/handoffs/linear/test-status.md"
  printf '# QA\n\n## QA status\n\n| Phase | Result | Report |\n|------:|--------|--------|\n| 1 | fail | reports/phase-01-qa.md |\n' > "$f"
  run pg linear --qa-history 1
  [ "${lines[0]}" = "$(printf '1\tfail\treports/phase-01-qa.md\t-')" ]
}

@test "qa-history: a phase nobody reviewed reports nothing, and succeeds" {
  setup_docs linear linear
  qa_record linear 1 pass
  run pg linear --qa-history 2
  [ "$status" -eq 0 ]
  [ "$output" = "" ]
}

@test "qa-history: refuses a missing or non-numeric phase" {
  setup_docs linear linear
  run pg linear --qa-history;     [ "$status" -eq 2 ]
  run pg linear --qa-history four; [ "$status" -eq 2 ]
}

@test "qa-prompt: round 2 briefs a new report name, the --round flag, and the earlier rounds" {
  setup_docs linear linear
  qa_record linear 1 fail --report reports/phase-01-qa.md --round 1
  run pg linear --qa-prompt 1
  assert_contains "$output" "This is QA ROUND 2 for this phase"
  assert_contains "$output" "round 1: fail — docs/handoffs/linear/reports/phase-01-qa.md"
  assert_contains "$output" "reports/phase-01-qa-round2.md --round 2"
  # …and never the name that would overwrite round 1's report.
  refute_contains "$output" "--report reports/phase-01-qa.md"
}

@test "qa-prompt: round 1 keeps the plain report name and says nothing about rounds" {
  setup_docs linear linear
  run pg linear --qa-prompt 1
  refute_contains "$output" "QA ROUND"
  assert_contains "$output" "reports/phase-01-qa.md --round 1"
}

# --- what QA round 1 of this phase found (F1, F2, F5) -------------------------
# Every one of these is a legacy three-column table, which is the shape of every
# `test-status.md` written before rounds existed — including the plan's own. The
# fix these tests pin is that the round convention is readable from the FILENAME,
# because that is the only record those rows have.

legacy_status() {  # legacy_status <slug> <row>…  — a three-column table, no Round cell
  local slug="$1"; shift
  local f="$DOCS_ROOT/docs/handoffs/$slug/test-status.md"
  mkdir -p "$(dirname "$f")"
  { printf '# QA / test status — %s\n\n## QA status\n\n' "$slug"
    printf '| Phase | Result | Report |\n|------:|--------|--------|\n'
    for row in "$@"; do printf '%s\n' "$row"; done
  } > "$f"
}

@test "QA-F1: a legacy row is the round its REPORT FILENAME says, not round 1" {
  setup_docs linear linear
  legacy_status linear '| 1 | pass | reports/phase-01-qa-round3.md |'
  run pg linear --qa-history 1
  assert_contains "${lines[0]}" "3	pass"
}

@test "QA-F1: so the next brief names a report that does not already exist" {
  # The measured symptom: `--qa-prompt 17` on the live plan offered
  # `phase-17-qa-round2.md`, which was already on disk beside round 3's.
  setup_docs linear linear
  legacy_status linear '| 1 | pass | reports/phase-01-qa-round3.md |'
  run pg linear --qa-prompt 1
  assert_contains "$output" "This is QA ROUND 4"
  assert_contains "$output" "reports/phase-01-qa-round4.md --round 4"
  refute_contains "$output" "phase-01-qa-round2.md"
}

@test "QA-F1: and the next recorded verdict is numbered past it, never over it" {
  setup_docs linear linear
  legacy_status linear '| 1 | fail | reports/phase-01-qa-round3.md |'
  qa_record linear 1 pass
  run pg linear --qa-result 1; [ "$output" = "pass" ]
  run pg linear --qa-history 1
  assert_contains "${lines[1]}" "4	pass"
}

@test "QA-F1: a legacy row with a plain report name is still round 1" {
  setup_docs linear linear
  legacy_status linear '| 1 | fail | reports/phase-01-qa.md |' '| 2 | waived | - |'
  run pg linear --qa-history 1; assert_contains "${lines[0]}" "1	fail"
  # …but a waiver with no report is the ACTIVATION backfill — a phase nobody
  # reviewed — so it is no round at all (QA round 3, F4).
  run pg linear --qa-history 2; [ "$output" = "" ]
}

@test "QA-R4-F3: an explicitly numbered waiver with no report is the round its cell says" {
  # QA round 4, F3's second shape: `| N | waived | - | 3 |` with no ledger row was
  # discarded whole by the bash readers (round 1) while the JS parser read its
  # cell (round 4). An explicit Round cell is authoritative in every reader and
  # in the writer; only the ROUNDLESS waiver is the activation backfill.
  setup_docs linear linear
  f="$DOCS_ROOT/docs/handoffs/linear/test-status.md"
  mkdir -p "$(dirname "$f")"
  printf '# QA\n\n## QA status\n\n| Phase | Result | Report | Round |\n|------:|--------|--------|------:|\n| 1 | waived | - | 3 |\n| 2 | waived | - | - |\n' > "$f"
  run pg linear --qa-history 1; assert_contains "${lines[0]}" "3	waived"
  run pg linear --qa-prompt 1
  assert_contains "$output" "reports/phase-01-qa-round4.md --round 4"
  # The writer numbers the next verdict past it, and carries the numbered row
  # into the ledger rather than losing it under the upsert.
  qa_record linear 1 pass
  run pg linear --qa-history 1
  assert_contains "${lines[0]}" "3	waived"
  assert_contains "${lines[1]}" "4	pass"
  # The roundless waiver is still the activation backfill: no round at all.
  run pg linear --qa-history 2; [ "$output" = "" ]
  run pg linear --qa-prompt 2
  assert_contains "$output" "reports/phase-02-qa.md --round 1"
}

@test "QA-R5-F3: a record without --round takes the round its report FILENAME says" {
  # The ledger holds round 1; round 2's report is on disk and nobody recorded
  # it; the brief (correctly) said ROUND 3. A reviewer that writes round 3's
  # report and records without --round — what a pre-rounds console does — used
  # to land as round 2, round 3's report in round 2's slot (QA round 5, F3).
  setup_docs linear linear
  qa_record linear 1 fail --report reports/phase-01-qa.md --round 1
  mkdir -p "$DOCS_ROOT/docs/handoffs/linear/reports"
  : > "$DOCS_ROOT/docs/handoffs/linear/reports/phase-01-qa-round2.md"
  run pg linear --qa-prompt 1; assert_contains "$output" "reports/phase-01-qa-round3.md --round 3"
  # The reviewer writes the report the brief named, then records it bare.
  : > "$DOCS_ROOT/docs/handoffs/linear/reports/phase-01-qa-round3.md"
  qa_record linear 1 pass --report reports/phase-01-qa-round3.md
  run pg linear --qa-history 1
  assert_contains "${lines[0]}" "1	fail"
  assert_contains "${lines[1]}" "3	pass	reports/phase-01-qa-round3.md"
  refute_contains "$output" "2	pass"
}

@test "QA-R5-F3: a BARE record is numbered by the highest report on disk, not into a stale one" {
  # Same disk, no --report at all: the reviewer wrote round 3's file and
  # records bare. The stale round-2 file is stepped past and round 3's is
  # linked — and with nothing on disk the default is still previous + 1.
  setup_docs linear linear
  qa_record linear 1 fail --report reports/phase-01-qa.md --round 1
  mkdir -p "$DOCS_ROOT/docs/handoffs/linear/reports"
  : > "$DOCS_ROOT/docs/handoffs/linear/reports/phase-01-qa-round2.md"
  : > "$DOCS_ROOT/docs/handoffs/linear/reports/phase-01-qa-round3.md"
  qa_record linear 1 pass
  run pg linear --qa-history 1
  assert_contains "${lines[1]}" "3	pass	reports/phase-01-qa-round3.md"
  qa_record linear 1 fail
  run pg linear --qa-history 1
  assert_contains "${lines[2]}" "4	fail	-"
}

@test "QA-R6: a report named -round08.md is round 8, and the brief still answers" {
  # QA round 6: the filename-derived round was written unnormalised, `08` went
  # into both tables, and the bash chooser read it as octal and died — so the
  # brief exited 1 with no report line at all.
  setup_docs linear linear
  qa_record linear 1 fail --report reports/phase-01-qa.md --round 1
  qa_record linear 1 pass --report reports/phase-01-qa-round08.md
  run pg linear --qa-history 1
  assert_contains "${lines[1]}" "8	pass	reports/phase-01-qa-round08.md"
  run pg linear --qa-prompt 1
  [ "$status" -eq 0 ]
  assert_contains "$output" "reports/phase-01-qa-round9.md --round 9"
}

@test "QA-F2: upgrading a legacy table backfills its round into the ledger, oldest first" {
  # Without this the history starts at round 2 and round 1 — a review that
  # demonstrably happened, with a report on disk — is listed nowhere. It is also
  # what made a COUNT and a MAXIMUM disagree for the runner.
  setup_docs linear linear
  legacy_status linear '| 1 | fail | reports/phase-01-qa.md |'
  qa_record linear 1 pass --report reports/phase-01-qa-round2.md
  run pg linear --qa-history 1
  [ "${#lines[@]}" -eq 2 ]
  assert_contains "${lines[0]}" "1	fail	reports/phase-01-qa.md"
  assert_contains "${lines[1]}" "2	pass	reports/phase-01-qa-round2.md"
  # One ledger section, not two, and one gating row.
  f="$DOCS_ROOT/docs/handoffs/linear/test-status.md"
  [ "$(grep -c '^## QA rounds' "$f")" -eq 1 ]
  [ "$(qa_status_rows "$f" 1)" -eq 1 ]
}

@test "QA-F2: the backfill does not fire twice, and never duplicates a round" {
  setup_docs linear linear
  legacy_status linear '| 1 | fail | reports/phase-01-qa.md |'
  qa_record linear 1 pass
  qa_record linear 1 fail
  run pg linear --qa-history 1
  [ "${#lines[@]}" -eq 3 ]
  assert_contains "${lines[0]}" "1	fail"
  assert_contains "${lines[2]}" "3	fail"
}

@test "QA-F2: re-recording the legacy round itself corrects it rather than doubling it" {
  setup_docs linear linear
  legacy_status linear '| 1 | fail | reports/phase-01-qa-round2.md |'
  qa_record linear 1 pass --round 2
  run pg linear --qa-history 1
  [ "${#lines[@]}" -eq 1 ]
  assert_contains "${lines[0]}" "2	pass"
}

@test "QA-F5: a verdict wrapped in markdown reads the same in every reader" {
  # `qa_result` stripped the PHASE cell and not the RESULT cell, so a row written
  # `| 1 | `pass` |` gated its dependents while reading as an unknown word — and
  # once qa_history and the JS parser both stripped it, bash disagreed with
  # itself about one row.
  setup_docs linear linear
  legacy_status linear '| 1 | `pass` | reports/phase-01-qa.md |' '| 2 | **fail** | - |'
  run pg linear --qa-result 1; [ "$output" = "pass" ]
  run pg linear --qa-result 2; [ "$output" = "fail" ]
  run pg linear --qa-history 1; assert_contains "${lines[0]}" "1	pass"
}

# --- what QA round 2 of this phase found --------------------------------------

@test "QA-R2: recording pending over a legacy row keeps the round it represents" {
  # The backfill sat inside the `$round` guard, and `pending` is recorded
  # roundless — so recording one threw the legacy round away with it: the status
  # row lost its Report cell (nothing left to infer from) and the next brief
  # dropped back to round 1, naming a report already on disk.
  setup_docs linear linear
  legacy_status linear '| 1 | fail | reports/phase-01-qa-round3.md |'
  qa_record linear 1 pending
  run pg linear --qa-result 1; [ "$output" = "pending" ]
  run pg linear --qa-history 1
  assert_contains "${lines[0]}" "3	fail	reports/phase-01-qa-round3.md"
  run pg linear --qa-prompt 1
  assert_contains "$output" "reports/phase-01-qa-round4.md --round 4"
}

@test "QA-R2: --report refuses a pipe rather than corrupting the row" {
  setup_docs linear linear
  run qa_record linear 1 pass --report 'reports/a|b.md'
  [ "$status" -eq 2 ]
  assert_contains "$output" "may not contain a pipe"
}

@test "QA-R2: the history reads oldest-first however the file holds it" {
  # A backfilled legacy round is appended AFTER the row it precedes, and a round
  # recorded out of sequence by hand lands wherever the upsert put it. The
  # reader sorts rather than trusting the layout.
  setup_docs linear linear
  legacy_status linear '| 1 | fail | reports/phase-01-qa-round5.md |'
  qa_record linear 1 pass --round 2
  run pg linear --qa-history 1
  assert_contains "${lines[0]}" "2	pass"
  assert_contains "${lines[1]}" "5	fail"
}

# --- what QA round 3 of this phase found --------------------------------------

@test "QA-R3: the brief steps past a report already on disk that no row mentions" {
  # "Recorded nothing" is a first-class outcome, so a reviewer can leave a report
  # with no row anywhere — and numbering from the ledger alone would hand the
  # next reviewer that exact filename.
  setup_docs linear linear
  mkdir -p "$DOCS_ROOT/docs/handoffs/linear/reports"
  : > "$DOCS_ROOT/docs/handoffs/linear/reports/phase-01-qa.md"
  : > "$DOCS_ROOT/docs/handoffs/linear/reports/phase-01-qa-round2.md"
  run pg linear --qa-prompt 1
  assert_contains "$output" "reports/phase-01-qa-round3.md --round 3"
  refute_contains "$output" "--report reports/phase-01-qa.md"
}

@test "QA-R3: the activation backfill's waived row is not fabricated into a round" {
  # `| N | waived | - | - |` is written by the mid-plan activation backfill and
  # means "finished before QA was on, nobody reviewed it". A ledger entry for it
  # would contradict the comment that writes it. No report, no round.
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  qa_record diamond 2 pending
  run cat "$DOCS_ROOT/docs/handoffs/diamond/test-status.md"
  assert_contains "$output" "| 1 | waived |"
  qa_record diamond 1 fail --report reports/phase-01-qa.md
  run pg diamond --qa-history 1
  [ "${#lines[@]}" -eq 1 ]
  assert_contains "${lines[0]}" "1	fail"
}

@test "QA-R3: a markdown-link report cell reads the same round as a bare path" {
  setup_docs linear linear
  legacy_status linear '| 1 | fail | [round 3](reports/phase-01-qa-round3.md) |'
  run pg linear --qa-history 1
  assert_contains "${lines[0]}" "3	fail	reports/phase-01-qa-round3.md"
}

@test "QA-R3: --report refuses a newline as well as a pipe" {
  setup_docs linear linear
  run qa_record linear 1 pass --report "$(printf 'reports/a.md\nreports/b.md')"
  [ "$status" -eq 2 ]
  assert_contains "$output" "may not contain a newline"
}

# ---------------------------------------------------------------------------
# P9 — `--reason`, and the three Lows QA round 7 routed here from Phase 4
# ---------------------------------------------------------------------------

@test "P9: --reason records a waiver's why in its own section, keyed by round" {
  setup_docs linear linear
  qa_record linear 1 fail --report reports/phase-01-qa.md --round 1
  qa_record linear 1 waived --report reports/phase-01-qa-round2.md --round 2 \
    --reason "the finding is phase 3's schema, not this phase's"
  f="$DOCS_ROOT/docs/handoffs/linear/test-status.md"
  # The gate is released and the reason is on file, in a section of its own —
  # never a fifth cell on either counted table.
  run pg linear --qa-result 1
  [ "$output" = "waived" ]
  assert_contains "$(cat "$f")" "## QA waivers"
  assert_contains "$(cat "$f")" "| 1 | 2 | the finding is phase 3's schema, not this phase's |"
  # The two tables it must NOT have disturbed.
  run pg linear --qa-history 1
  assert_contains "${lines[0]}" "1	fail"
  assert_contains "${lines[1]}" "2	waived"
  n=$(qa_status_rows "$f" 1)
  [ "$n" -eq 1 ]
}

@test "P9: a plan that has waived nothing has no waivers table at all" {
  setup_docs linear linear
  qa_record linear 1 pass --report reports/phase-01-qa.md --round 1
  run grep -c "QA waivers" "$DOCS_ROOT/docs/handoffs/linear/test-status.md"
  [ "$status" -ne 0 ]
}

@test "P9: re-recording the same waived round replaces its reason rather than doubling it" {
  setup_docs linear linear
  qa_record linear 1 waived --report reports/phase-01-qa.md --round 1 --reason "first wording"
  qa_record linear 1 waived --report reports/phase-01-qa.md --round 1 --reason "second wording"
  f="$DOCS_ROOT/docs/handoffs/linear/test-status.md"
  n=$(grep -cE '^\|[[:space:]]*1[[:space:]]*\|[[:space:]]*1[[:space:]]*\|[[:space:]]*(first|second) wording' "$f")
  [ "$n" -eq 1 ]
  assert_contains "$(cat "$f")" "second wording"
}

@test "P9: --reason is refused on anything but waived, rather than dropped" {
  setup_docs linear linear
  run qa_record linear 1 pass --report reports/phase-01-qa.md --round 1 --reason "why"
  [ "$status" -eq 2 ]
  assert_contains "$output" "only meaningful with waived"
}

@test "P9: --reason refuses a pipe, a newline and a paste nobody meant to send" {
  setup_docs linear linear
  run qa_record linear 1 waived --report reports/phase-01-qa.md --round 1 --reason "a | b"
  [ "$status" -eq 2 ]
  assert_contains "$output" "may not contain a pipe"
  run qa_record linear 1 waived --report reports/phase-01-qa.md --round 1 --reason "$(printf 'a\nb')"
  [ "$status" -eq 2 ]
  assert_contains "$output" "may not contain a newline"
  long=$(printf 'x%.0s' $(seq 1 281))
  run qa_record linear 1 waived --report reports/phase-01-qa.md --round 1 --reason "$long"
  [ "$status" -eq 2 ]
  assert_contains "$output" "limited to 280 characters"
}

# QA round 7, Low 1 — "QA-R6" above pins the two halves of the `08` fix only
# TOGETHER, so a writer that stopped normalising would still pass it as long as
# the reader kept coping. These two split them: the exact cell the writer emits,
# and a reader fed an `08` cell it did not write.
@test "P9 (QA-R7 L1): the writer normalises an -round08.md filename into the CELL" {
  setup_docs linear linear
  qa_record linear 1 pass --report reports/phase-01-qa-round08.md
  f="$DOCS_ROOT/docs/handoffs/linear/test-status.md"
  assert_contains "$(cat "$f")" "| 1 | pass | reports/phase-01-qa-round08.md | 8 |"
}

@test "P9 (QA-R7 L1): a hand-written 08 Round cell does not take the reader down" {
  # The reader's own `10#` in qa_next_round(), protected against a STALE
  # installed writer — the deployment shape this tree ships in several places.
  setup_docs linear linear
  legacy_status linear '| 1 | fail | reports/phase-01-qa.md | 08 |'
  run pg linear --qa-prompt 1
  [ "$status" -eq 0 ]
  assert_contains "$output" "reports/phase-01-qa-round9.md --round 9"
}

# QA round 7, Low 3 — `--round` itself was unbounded, so `$((10#$round))` on a
# long run of digits overflowed into a negative cell every reader then sorted to
# the front of the ledger. Bounded to six digits like the filename path.
@test "P9 (QA-R7 L3): --round is bounded to six digits" {
  setup_docs linear linear
  run qa_record linear 1 pass --report reports/phase-01-qa.md --round 1234567
  [ "$status" -eq 2 ]
  assert_contains "$output" "limited to six digits"
  run qa_record linear 1 pass --report reports/phase-01-qa.md --round 123456
  [ "$status" -eq 0 ]
}
