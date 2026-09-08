#!/usr/bin/env bats
# The `- **Checkout:** <branch>` bullet and its flag, `--checkout N` — which
# branch a phase's session works ON. The console acts on exactly one family of
# values (`main` / `master` / `default`: board the phase DETACHED at the
# trunk's head); every other value is emitted verbatim and acted on by nobody.
# The emit contract: the bullet's value with bold and backticks stripped, an
# empty line for a phase without one, and an empty line — status 0 — with no
# phase argument, all safe under `set -euo pipefail` (the no-match grep trap).
load ../helpers/test_helper

@test "--checkout N: the bullet's value, verbatim" {
  setup_docs checkout checkout
  run pg checkout --checkout 1
  [ "$status" -eq 0 ]
  [ "$output" = "main" ]
}

@test "--checkout N: a phase without the bullet emits nothing, status 0" {
  setup_docs checkout checkout
  run pg checkout --checkout 2
  [ "$status" -eq 0 ]
  [ "$output" = "" ]
}

@test "--checkout N: bold and backticks are stripped from the value" {
  setup_docs checkout checkout
  run pg checkout --checkout 3
  [ "$status" -eq 0 ]
  [ "$output" = "release/2.0" ]
}

@test "--checkout N: the bullet is bold-optional and case-insensitive" {
  setup_docs checkout checkout
  run pg checkout --checkout 4
  [ "$status" -eq 0 ]
  [ "$output" = "master" ]
}

@test "--checkout: no phase argument emits nothing, status 0" {
  setup_docs checkout checkout
  run pg checkout --checkout
  [ "$status" -eq 0 ]
  [ "$output" = "" ]
}

@test "--checkout N: a zero-padded phase answers about the same phase" {
  setup_docs checkout checkout
  run pg checkout --checkout 01
  [ "$status" -eq 0 ]
  [ "$output" = "main" ]
}
