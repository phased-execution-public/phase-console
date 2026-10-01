#!/usr/bin/env bats
# `phase-console run <verb>` (control-tower phase 98, EC6, #144) — the bats
# half of `viewer/test/cli-run.test.ts`: the same mechanism, proved from a
# plain shell instead of node:test — a tiny `node -e` HTTP server on an
# ephemeral loopback port stands in for a console, and every test runs in a
# sandboxed HOME/XDG_STATE_HOME so a miss can never reach a real one (ports
# 4123, 4130, 4100 are never named here).
#
# `run-verb.mjs` is plain JS, not a bash script, so this file does not use
# `tests/helpers/test_helper.bash`'s `$SYS_BASH`-forcing runners (those exist
# to catch bash-3.2 regressions in the shell scripts, which this CLI is not);
# it keeps only the assertion helpers.

load ../helpers/test_helper

# In the FREE tree `free/` is a proPath and gone, but the override has been
# applied — `bin/phase-console.mjs` IS the free CLI there — so the free cases
# run against the real free bin in both trees, and every case that needs the
# Pro bin (an act, `wait`, the license gate) is inside a `!pro:` region.
CLI="$PE_DIR/bin/phase-console.mjs"
FREE_CLI="$PE_DIR/bin/phase-console.mjs"

setup() {
  scrub_pe_env
  export HOME="$BATS_TEST_TMPDIR/home"
  export XDG_STATE_HOME="$BATS_TEST_TMPDIR/state"
  export XDG_CONFIG_HOME="$BATS_TEST_TMPDIR/config"
  export PHASE_CONSOLE_HOME="$PE_DIR"
  mkdir -p "$HOME" "$XDG_STATE_HOME" "$XDG_CONFIG_HOME"
  start_stub
}

teardown() {
  [ -n "${STUB_PID:-}" ] && kill "$STUB_PID" >/dev/null 2>&1
  wait "$STUB_PID" 2>/dev/null || true
}

# A stub console: one node http.Server on an ephemeral port. Every request is
# appended as one JSON line to $STUB_REQUESTS; the answer is read FRESH off
# $REPLY_FILE on every request — a background process's environment is a
# snapshot from when it was spawned, so a later `export` in this shell would
# never reach it, but a re-read file does. `reply <status> <body-json>`
# rewrites it for the NEXT request only.
start_stub() {
  export STUB_REQUESTS="$BATS_TEST_TMPDIR/requests.ndjson"
  export REPLY_FILE="$BATS_TEST_TMPDIR/reply.json"
  : > "$STUB_REQUESTS"
  reply 200 '{}'
  export PORT_FILE="$BATS_TEST_TMPDIR/port"
  : > "$PORT_FILE"
  node -e '
    const http = require("node:http");
    const fs = require("node:fs");
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const line = JSON.stringify({
          method: req.method, url: req.url, headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        fs.appendFileSync(process.env.STUB_REQUESTS, line + "\n");
        const scripted = JSON.parse(fs.readFileSync(process.env.REPLY_FILE, "utf8"));
        res.writeHead(scripted.status, { "content-type": "application/json" });
        res.end(scripted.body);
      });
    });
    server.listen(0, "127.0.0.1", () => fs.writeFileSync(process.env.PORT_FILE, String(server.address().port)));
  ' >"$BATS_TEST_TMPDIR/stub.log" 2>&1 &
  STUB_PID=$!
  for _ in $(seq 1 50); do [ -s "$PORT_FILE" ] && break; sleep 0.1; done
  STUB_PORT="$(cat "$PORT_FILE")"
  [ -n "$STUB_PORT" ] || { echo "stub server never reported a port" >&2; cat "$BATS_TEST_TMPDIR/stub.log" >&2; return 1; }
}

# reply <status> <json-body> — what the stub answers from its NEXT request on.
reply() { node -e "require('node:fs').writeFileSync(process.env.REPLY_FILE, JSON.stringify({status: Number(process.argv[1]), body: process.argv[2]}))" "$1" "$2"; }

run_cli() { run node "$CLI" "$@"; }
run_free() { run node "$FREE_CLI" "$@"; }

# One field of the LAST request line, by a tiny node expression (no jq dependency, matching the stub's own runtime).
last_field() {  # last_field '<js expr on r>'
  node -e "const r = JSON.parse(require('node:fs').readFileSync(process.env.STUB_REQUESTS, 'utf8').trim().split('\n').pop()); process.stdout.write(String($1))"
}


@test "a GET row's flags land on the query string, not a body" {
  run_cli run journal alpha --limit 7 --console "$STUB_PORT"
  [ "$status" -eq 0 ]
  [ "$(last_field "r.method")" = "GET" ]
  [ "$(last_field "r.url")" = "/api/run/alpha/journal?limit=7" ]
  [ "$(last_field "r.body")" = "" ]
}


@test "--json prints exactly the raw answer" {
  reply 200 '{"run":{"id":"r1","slug":"alpha","status":"running","activePhase":1,"phases":{"1":"running"}}}'
  run_cli run status alpha --json --console "$STUB_PORT"
  [ "$status" -eq 0 ]
  [ "$output" = '{"run":{"id":"r1","slug":"alpha","status":"running","activePhase":1,"phases":{"1":"running"}}}' ]
}

@test "exit 3 on a 404, exit 1 on a 409, exit 4 with nothing listening, exit 2 on an unknown verb" {

  run_cli run status alpha --console 1
  [ "$status" -eq 4 ]

  run_cli run not-a-verb --console 1
  [ "$status" -eq 2 ]
  assert_contains "$output" "unknown verb"
}


@test "phase-console run and run --help both list the table's verbs; only the bare form is exit 2" {
  run_cli run
  [ "$status" -eq 2 ]
  assert_contains "$output" "status <slug>"
  run_cli run --help
  [ "$status" -eq 0 ]
  assert_contains "$output" "status <slug>"
  assert_contains "$output" "acts"
}

@test "the free CLI refuses an act by edition, exit 2, naming Pro — no request ever left this machine" {
  run_free run pause alpha --console "$STUB_PORT"
  [ "$status" -eq 2 ]
  assert_contains "$output" "Phase Console Pro"
  [ ! -s "$STUB_REQUESTS" ]
}

@test "the free CLI still reads: status reaches the stub and answers normally" {
  reply 200 '{"run":null}'
  run_free run status alpha --console "$STUB_PORT"
  [ "$status" -eq 0 ]
  [ "$(wc -l < "$STUB_REQUESTS" | tr -d ' ')" -eq 1 ]
}

@test "the free CLI refuses wait too — the one read the table marks Pro" {
  run_free run wait alpha --for status:paused --console "$STUB_PORT"
  [ "$status" -eq 2 ]
  assert_contains "$output" "Phase Console Pro"
  [ ! -s "$STUB_REQUESTS" ]
}

