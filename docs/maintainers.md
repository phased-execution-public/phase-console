# For maintainers of this repository

The release gate, the publishing scripts and the rehearsals. They belong to whoever maintains this
tree; a session working a plan meets them only in `references/scripts.md` §For maintainers, which points
here. The release contract is `docs/releasing.md`.

- `scripts/gates.sh
  [--quick] [--list] [--ci] [--build] [--drain] [--keep-going] [--verbose] [--install-hook] [--help]` — the
  release gate, on this machine (there is no CI), every suite once: the one client build per commit,
  bash engine, engine parity, the server and client suites, both typechecks, lint, format, the
  real-browser tour (`viewer/e2e`), the scrub and the tarball assertions, in that order;
  `--quick` is the cheap subset, `--list` prints the plan; the full matrix refuses a dirty tree, and a
  green run on a HEAD that did not move records the sha and a JSON of what it ran in the common gitdir
  (`scripts/gates-marker.sh`, sourced, is where and the one reader the hook and the release script share);
  `--drain` holds every console's automatic starts and waits up to 60 minutes for live lanes to settle,
  releasing on every exit (`docs/releasing.md` §How a change becomes an update); each stage prints at most three lines — green
  its name and seconds, red its failing ids and its log's path — and `--verbose` adds a red stage's last
  40 log lines; `tests/run-tests.sh` likewise prints counts and failing names, its full TAP in a log
  under `$TMPDIR`; `--install-hook` points the clone's
  `core.hooksPath` at `scripts/git-hooks/` so a push to `main` or a tag runs the full matrix and any
  other ref the quick one (`PHASE_CONSOLE_SKIP_GATES=1` skips, and says so).
  `docs/releasing.md` is the contract.
