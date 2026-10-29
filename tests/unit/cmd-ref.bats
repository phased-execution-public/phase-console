#!/usr/bin/env bats
# cmd-ref.sh — how a `cmd:` ref reads, in bash. The JS twins (watch-refs.ts
# `relativePathIn`, proof-words.js `cmdOfRef`) are held to the same table by
# viewer/test/watch-refs.test.ts; this file pins the bash half's own words.
load ../helpers/test_helper

# The relative path <command> names, or nothing — through the system bash.
rel() { "$SYS_BASH" -c '. "$1"; _relative_path_in "$2"' _ "$PE_SCRIPTS/cmd-ref.sh" "$1"; }

@test "cmd-ref: after gh api the first non-flag word is an endpoint, never a path" {
  [ -z "$(rel 'gh api repos/o/r/releases/latest')" ]
  [ -z "$(rel 'gh api marketplace_listing/plans/x')" ]
  [ -z "$(rel 'gh api licenses/mit/x')" ]
  [ -z "$(rel 'gh api rate_limit')" ]
  [ -z "$(rel 'gh api networks/o/r/events')" ]
}

@test "cmd-ref: a gh api endpoint after flags and their values is still an endpoint" {
  [ -z "$(rel "gh api -H 'Accept: x' marketplace_listing/plans/x")" ]
  [ -z "$(rel 'gh api -H Accept:application/vnd.github.v3.raw licenses/mit/x')" ]
  [ -z "$(rel 'gh api -X GET --jq .name codes_of_conduct/x/y')" ]
  [ -z "$(rel 'gh api --paginate -f per_page=100 meta/octo/cat')" ]
  [ -z "$(rel 'gh api marketplace_listing/plans/x --jq .a/b/c; true')" ]
}

@test "cmd-ref: a header value with a space is a value, not a path" {
  [ -z "$(rel "gh api -H 'Accept: application/vnd.github.v3.raw' user/repos")" ]
}

@test "cmd-ref: only the endpoint is spared — a later path and the next command are still read" {
  [ "$(rel 'gh api meta/o/c --input out/body.json')" = 'out/body.json' ]
  [ "$(rel 'gh api marketplace_listing/plans/x; cat docs/x/y.md')" = 'docs/x/y.md' ]
  [ "$(rel 'gh api marketplace_listing/plans/x | tee out/a/b.json')" = 'out/a/b.json' ]
}

@test "cmd-ref: other gh commands and other leads are read as before" {
  [ "$(rel 'gh pr diff docs/a/b.md')" = 'docs/a/b.md' ]
  [ "$(rel 'echo api marketplace_listing/plans/x')" = 'marketplace_listing/plans/x' ]
  [ "$(rel 'bash scripts/vpn/status.sh')" = 'scripts/vpn/status.sh' ]
}
