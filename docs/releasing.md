# 🏷️ Versioning and releasing

Releases are cut by hand, on a maintainer's machine. Nothing here runs on a server, nothing
publishes on its own, and there is no registry of any kind — npm, GitHub Packages and the Homebrew
tap were all withdrawn on 2026-09-03. GitHub holds the repositories, the tags and the Release
assets, and that is the whole distribution story. `viewer/test/release-split.test.ts` greps for the
withdrawn channels in `scripts/`, `.github/scripts/` and `package.json`, so the claim in this
paragraph is a check rather than a promise.

| Channel | Name | Cadence | Made by |
|---|---|---|---|
| Claude Code plugin | `phased-execution@phased-execution-public` | **every push to `main`** | the push itself — this repo *is* the marketplace |

A clone is the other way in.
There is no npm package and no Homebrew formula any more — both were
withdrawn on 2026-09-03 — and the tarball a Release carries exists so that a machine without git can
still be handed exactly what a tag holds.

## How a change becomes an update

**Every merge to `main` IS a plugin release.** There is no version number on that channel by
design — Claude Code refreshes installed plugins from `main` in the background. So the bar for
pushing `main` is "this is releasable", always; `scripts/gates.sh` exists to hold that bar, and the
pre-push hook runs it for you.

**The gates — `scripts/gates.sh`.** In this order: `tests/run-tests.sh` (shellcheck + bats), the
engine-parity test, the server suite serially, the three timing-sensitive files with one retry
each, the client suite, both typechecks, lint, the format check, the build gate (`verify:dist`, a
scratch build — `--build` builds `client/dist` for real), the scrub, and the tarball assertions.
`--quick` is typechecks + lint + format + scrub, under a minute; `--list` prints what a call would
run; `--ci` reinstalls `viewer/node_modules` first; `--keep-going` runs past a failure. A green full
run records the sha it verified in `.git/phase-console-gates-ok`.


**The hook — `scripts/git-hooks/pre-push`.** Once per clone, `scripts/gates.sh --install-hook`
sets `core.hooksPath` to `scripts/git-hooks/`. A push that touches `main` or a tag runs the full
gates (a recorded green run for the same sha on a clean tree stands in for it); any other ref runs
`--quick`. `PHASE_CONSOLE_SKIP_GATES=1 git push …` skips them and says so on stderr — the
emergency door, not a habit.


## What a change must carry with it

| If you change… | You must also update, in the same commit |
|---|---|
| Anything the server needs at runtime (a new `server/` import, a new `scripts/*.sh` it shells, a new `templates/`/`references/` file a prompt names) | the root `package.json` `files` allowlist **and** `.github/scripts/assert-tarball.sh` — the tarball assertions are the backstop, never trust the allowlist alone |
| A setup prompt in `viewer/shared/setup-prompts.js` | its verbatim carriers (README.md, docs/install.md, the in-app guide) — `viewer/test/setup-prompts.test.ts` fails otherwise |
| The Node floor | every gate: root + viewer `package.json` engines, `viewer/run`, `bin/phase-console.mjs` — plus the docs that state it. `viewer/test/node-floor.test.ts` lifts each gate's own predicate and RUNS it either side of every boundary, so they can no longer disagree silently, and it asserts the SIZE of that set so a gate cannot be dropped from the list quietly |
| English docs | the Persian mirror (`README.fa.md`, `USAGE.fa.md`, `viewer/README.fa.md`) — **gated** since 3.1 by `viewer/test/docs-parity.test.ts`: heading counts per level, the flag set, and the images must match. Titles are translated, so it asserts structure and the tokens that survive translation, never prose |
| A push category, a settings section, an engine mode, or a repo path a doc cites | the docs that name them — the same `docs-parity.test.ts` holds `docs/phone.md`'s table to `CATEGORIES`, every `Settings ▸ X` to the eight real sections, and every backticked repo path and bare script name in `docs/` + `references/` to a file that exists |
| A message a **user** reads at runtime that points at a doc — `--help`, a refusal, the in-app guide, `USAGE.md` | a link built from `DOCS_URL` (`viewer/server/config.ts`), never a repo-relative path. `docs/` is on the never-ship list, so the packed tarball has no `docs/` directory and a bare `docs/webhooks.md` is a pointer to a file that install does not have. Repo-relative paths stay right inside `docs/`, `references/` and `viewer/README.md`, which are read from a clone and gated on resolving |
| Anything user-visible | a `CHANGELOG.md` line (open an `## [Unreleased]` section if none exists) |
| Behaviour the **plugin listing** describes | `.claude-plugin/marketplace.json`'s `description` — the largest user-facing prose surface here. Since 3.1 `viewer/test/packaging.test.ts` carries a **version-staleness gate**: the newest version the description names must be at least the tree's MAJOR.MINOR. A patch may ship without touching it; a minor may not, because a minor is where the behaviour a listing describes changed |

Before **every** commit: `bash .github/scripts/scrub.sh` — run it bare, not piped (failures are on
stderr and a pipe eats the exit code). It scans tracked ∪ staged files, so another workstream's
untracked files never block you.

To check the **tarball** locally, use `bash .github/scripts/pack-and-assert.sh`, not
`assert-tarball.sh` directly: the latter exits 2 without a tarball path, and a plain `npm pack` runs
`prepack`, which rebuilds `viewer/client/dist` — the build the live console serves per request. The
wrapper does the two things `prepack` does that the assertions need (the pack `tsc` emit, then
`npm pack --ignore-scripts`), asserts, and cleans up precisely: only untracked `.js` with a matching
`.ts` sibling, because `viewer/server/fallback-sw.js` is real tracked source sitting among the ~86
emitted files. `--keep` leaves the tarball in place and prints its path, and `--tree DIR` packs
another checkout of this repository, which is how a tag behind `HEAD` is released.
The tarball is **4.7 MB** — 503 entries, 13.3 MB unpacked, measured at **4.0.0** with the pack `tsc`
emit in place, which is what a release actually packs. `assert-tarball.sh` prints the same 503: this
tarball carries no directory entries, so the older note about `tar -tzf` counting them no longer
applies, and the two numbers agreeing is now the expected answer rather than a discrepancy to
explain. It was ~36 MB until 3.1 shipped the screencast from a
hosted URL instead of `assets/console.gif`, which is now on the never-ship list so the regression
cannot come back quietly. It grew from 2.2 MB at 3.1 because 3.2's `precompress` step writes a
`.br`/`.gz` sibling beside every compressible file in `client/dist` — those are load-bearing, not
slack: `server/http/static.ts` serves them and never compresses at request time, and
`check-dist.mjs` gates first paint on the bytes that would actually be **served**. Re-measure with
`bash .github/scripts/pack-and-assert.sh --keep` and read the file it names, rather than trusting
this line — a bare `npm pack --dry-run` skips the emit and undercounts by the ~86 files it adds.

## Secrets

None. No token exists for any registry, and the release script acts as the person running it
(`gh auth status`). `.secrets/` stays gitignored for whatever a machine keeps locally, and nothing
in this repository reads it.
