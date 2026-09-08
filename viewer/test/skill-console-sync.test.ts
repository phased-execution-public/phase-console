/**
 * The skill and the console, saying the same thing.
 *
 * Four separate holes, one theme: the console had behaviour the skill did not
 * describe, and the skill made claims the console did not implement.
 *
 *  - **R25** Nothing stopped a supervised session waiting inside its own turn.
 *    The only detector was post-hoc, five minutes after the call went out, and
 *    its vocabulary did not know `while true; do sleep 30`, `sleep 60`, or a
 *    loop written across three lines. Now the PreToolUse hook refuses the call
 *    before it runs.
 *  - **R26** And the post-hoc remedy was wrong for the commonest case: a
 *    session watching its OWN 40-minute suite was parked on a clock meant for
 *    somebody else's CI — 26 checkpoint→park→resume cycles at a median of 70
 *    minutes, each one throwing away a suite that was running fine.
 *  - **R27** 19 plans put `docker compose up -d` inside §Verification because
 *    the format had nowhere else to put it, where every one of them is a
 *    command a person is asked to vouch for and a line that can turn a phase
 *    red for a reason unrelated to its work.
 *
 * The fourth — R36, the doc claims — is proved in `docs-parity.test.ts`, where
 * the docs already live.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  externalWaitMatch, foldWhitespace, loadVerifyEnv, VERIFY_ENV_FALLBACK,
} from '../server/runner/verify-env.ts';
import {
  inTurnWait, splitStatements, waitScope, localWatchRef, evaluateStall, stallThresholds,
} from '../server/runner/liveness.ts';
import { DEFAULT_DENY } from '../server/runner/approvals.ts';
import { SKILL_DIR } from '../server/config.ts';
import { verifyPhase } from '../server/runner/verify.ts';
import { parsePlan } from '../server/parse/plan.ts';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const ENV = loadVerifyEnv(SCRIPTS);

/* ------------------------------------------------------------------ *
 * Exit criterion 1 — the vocabulary, and the hook that acts on it
 * ------------------------------------------------------------------ */

test('the shapes the old vocabulary missed are the shapes it now catches', () => {
  // Every one of these was measured in a real session and matched nothing.
  for (const command of [
    'until [ -f /tmp/suite.done ]; do sleep 15; done',
    'while true; do sleep 30; done',
    'sleep 90',
    'sleep 5m',
    'watch -n 10 cat /tmp/x.log',
    'gh run watch 42',
    'docker compose up',
  ]) {
    assert.ok(inTurnWait(command, ENV), `not caught: ${command}`);
  }
});

test('and the shapes that must keep working, keep working', () => {
  for (const command of [
    'sleep 8',                       // the standard bring-up pause
    'sleep 30',                      // still under the minute the list starts at
    'npm test',
    'git push origin main',          // a wall, but a different wall
    'docker compose up -d',          // the carve-out: it RETURNS
    'grep -rn "until" src/',         // the word is not the shape
  ]) {
    assert.equal(inTurnWait(command, ENV), null, `false positive: ${command}`);
  }
});

test('a loop written across three lines is the same loop', () => {
  // The fold is why. The shared alternation spells its spaces literally so one
  // string can drive a POSIX ERE and a JS RegExp, which means a fenced
  // multi-line construct cannot match until it is one line — and the bash lint
  // folds too, or the two would disagree about the same command.
  const multiline = 'until curl -sf localhost:8080/health\ndo\n\tsleep 5\ndone';
  assert.ok(!/until [^`]+ do /.test(multiline), 'unfolded, it genuinely does not match');
  assert.ok(inTurnWait(multiline, ENV), 'folded, it does');
  // Folded to SEPARATORS, not spaces — see the newline test below for why.
  assert.equal(foldWhitespace(multiline), 'until curl -sf localhost:8080/health; do; sleep 5; done');
});

test('the carve-out is applied by REMOVAL, so the other half of the line still matches', () => {
  // `docker compose up -d && docker compose up` is contrived; a line that
  // brings a stack up detached and THEN blocks on something is not. Deleting
  // the allowed span and re-asking is what makes the second half visible; a
  // "does this line also contain an allowed shape" test would have hidden it.
  const both = 'docker compose up -d && tail -f /tmp/app.log';
  assert.equal(externalWaitMatch(ENV, 'docker compose up -d'), null);
  assert.equal(externalWaitMatch(ENV, both), 'tail -f');
});

test('no vocabulary means no rule — a console driving an older scripts dir denies nothing', () => {
  assert.equal(inTurnWait('until true; do sleep 60; done', undefined), null);
});

test('the in-turn-wait rule is NOT a deny rule, and could not be', () => {
  // The distinction is load-bearing. A `Bash(sleep:*)` line in `policy.deny`
  // would take a strike, would appear in the editor's rule list, would be
  // switchable per plan, and would make `sleep 8` — a legitimate bring-up
  // pause every containerised plan writes — impossible. The guard lives
  // outside the policy so all three profiles get it and none of them can
  // configure it away.
  const joined = DEFAULT_DENY.join('\n');
  assert.ok(!/sleep/.test(joined), 'the wall never learned about sleep');
  assert.ok(!/until/.test(joined), 'nor about loops');
  assert.ok(!/in-turn/.test(joined));
});

test('a NEWLINE is a statement separator, and a quoted one is not a separator at all', () => {
  // QA round 3's H1 and M3, which pull in opposite directions and are one bug.
  //
  // TOO FEW: `foldWhitespace` rewrote `\n` to a space before the statement
  // scan ever saw it, so the scan's own `\n` arm was dead code and a two-line
  // command — the most ordinary shape a session writes — read as ONE statement
  // led by `echo`. Five such bypasses, every one denied by this phase's first
  // commit. A single `&` was missing for the same reason.
  for (const command of [
    'echo "waiting for the suite"\nuntil [ -f /tmp/suite.done ]; do sleep 30; done',
    'echo hi\nwhile true; do sleep 30; done',
    'grep -q x /tmp/a\nuntil [ -f /tmp/b ]; do sleep 30; done',
    'printf start\nuntil curl -sf localhost:8080; do sleep 5; done',
    'git status\nuntil [ -f /tmp/x ]; do sleep 30; done',
    'echo x & until [ -f /tmp/x ]; do sleep 30; done',
  ]) {
    assert.ok(inTurnWait(command, ENV), `bypassed: ${JSON.stringify(command)}`);
  }

  // TOO MANY: a separator INSIDE a quoted argument was counted, so a search
  // whose own pattern contains one was denied — a false positive on the exact
  // class the exemption exists for, which is the costly direction.
  for (const command of [
    'grep -rn "foo; while true; do" src/',
    'grep -rn "while true; do" src/',
    "echo 'a; until X; do Y; done'",
    'echo "…until X; do Y; done"',
  ]) {
    assert.equal(inTurnWait(command, ENV), null, `false positive: ${command}`);
  }

  // And the fold that makes both work: a newline folds to a SEPARATOR, which
  // is what it is in shell — so a multi-line loop still matches the `; do` arm.
  assert.equal(
    foldWhitespace('until curl -sf localhost\ndo\n\tsleep 5\ndone'),
    'until curl -sf localhost; do; sleep 5; done',
  );
});

test('an exempt LEAD exempts its own statement, never the whole command', async () => {
  // QA round 2's H1, and a regression a fix created: the exemption was asked of
  // the WHOLE command, so `echo "…" && until …; do sleep 30; done` led with
  // `echo`, read as exempt, and the loop inside it was never looked at. One
  // word bypassed the entire guard — a shape the phase's first commit denied.
  for (const command of [
    'echo "waiting for the suite" && until [ -f /tmp/suite.done ]; do sleep 30; done',
    'printf x && sleep 600',
    'echo start; sleep 600',
    'grep -q x /tmp/a && until [ -f /tmp/b ]; do sleep 30; done',
    'git grep foo && sleep 600',
  ]) {
    assert.ok(inTurnWait(command, ENV), `a prefix bypassed the guard: ${command}`);
  }

  // …while the thing the exemption is FOR still works: the vocabulary as data.
  for (const command of [
    'grep -rn "while true; do" src/',
    'echo "…until X; do Y; done"',
    'git diff --name-only | while read -r f; do wc -l "$f"; done',
    'npm test -- --watchAll=false',
    'docker compose up --detach',
    'tail -f /tmp/x.log > /dev/null &',
  ]) {
    assert.equal(inTurnWait(command, ENV), null, `false positive: ${command}`);
  }
});

test('a statement is a structure, not a spelling — the shapes three rounds of spelling fixes left open', () => {
  // QA rounds 1, 2 and 3 each bypassed this guard, and each fix addressed the
  // SPELLING of a character scan rather than what a statement IS: an exempt
  // lead read off the whole command, then off the whole command again once a
  // newline had folded to a space, then a third time once an escaped quote had
  // swallowed every separator after it. A read-only probe before round 4 found
  // the fourth set. The guard now splits the command the way bash does and
  // judges each statement on its own — these are the shapes that decided it.
  const loop = 'until [ -f /tmp/x ]; do sleep 30; done';

  for (const command of [
    // A trailing `&` backgrounds the LAST statement, never the loop before it.
    `${loop}; echo ok &`,
    `${loop}; echo ok &\n`,
    `${loop} && echo ok &`,
    // An escaped quote is not a quote — it must not open one that swallows
    // every separator after it and hands the loop the lead of an `echo`.
    `echo \\" && ${loop}`,
    `echo "a\\"b" && ${loop}`,
    `grep "a\\"; until X" f; ${loop}`,
    // A backtick substitution inside the condition: the vocabulary's loop arms
    // stop at a backtick because on the plan side a backtick ends a code span.
    'until [ -f `cat /tmp/p` ]; do sleep 30; done',
    'while [ -z `cat /tmp/p` ]; do sleep 30; done',
    // `git` is exempt for the git verbs that SEARCH, not for the ones that run
    // an arbitrary command.
    "git submodule foreach 'sleep 600'",
    "git rebase --exec 'sleep 600' HEAD~3",
    `git pull; ${loop}`,
    `git grep x; ${loop}`,
    // A substitution that waits is a wait, whatever prints it.
    `echo "$(${loop})"`,
    'echo "$(sleep 600)"',
    'printf %s `sleep 600`',
    `X=$(${loop}); echo "$X"`,
    // An exempt lead reached through a wrapper still leaves the loop on a
    // statement of its own.
    `env FOO=1 echo x; ${loop}`,
    `time echo x; ${loop}`,
    `nohup echo x; ${loop}`,
    // Containers are looked INTO, never judged on their bracket.
    `{ echo x; ${loop}; }`,
    `( echo x; ${loop} )`,
    `(echo x; ${loop}) > /tmp/log 2>&1`,
    `if true; then ${loop}; fi`,
    `echo x || ${loop}`,
    `echo x | ${loop}`,
    `f() {\n  ${loop}\n}\nf`,
    `f() { ${loop}; }; f`,
    `time ${loop}`,
    `! ${loop}`,
    `for i in 1 2 3; do sleep 90; done`,
    // A here-doc fed to a SHELL is code, and a loop in it waits.
    `bash <<'EOS'\n${loop}\nEOS`,
    `bash <<EOS\necho x; ${loop}\nEOS`,
    `ssh host <<EOS\n${loop}\nEOS`,
    // A quote that never closes can hide a separator, so it fails CLOSED.
    `echo it's fine; ${loop}`,
    // And what the guard already caught, unchanged.
    'until [ "$(gh run view 1 -q .status)" = completed ]; do sleep 15; done',
    `echo hi\r\n${loop}`,
    `echo x & ${loop}`,
  ]) {
    assert.ok(inTurnWait(command, ENV), `bypassed: ${JSON.stringify(command)}`);
  }

  for (const command of [
    // The deny message's own remedy, with the trailing newline a tool input
    // often carries — refusing it was refusing the remedy.
    'tail -f /tmp/x.log > /dev/null 2>&1 &\n',
    `(${loop}) &\n`,
    `{ ${loop}; } &`,
    // A backgrounded loop followed by foreground work returns at once.
    `${loop} & echo ok`,
    `(${loop}) & echo started`,
    // An exempt lead reached through a wrapper is still that lead.
    'env FOO=1 grep "while true; do" src/',
    'time grep -rn "until x; do" src/',
    'nohup echo "until x; do y; done"',
    'FOO=1 env BAR=2 printf "%s" "while true; do"',
    'sudo -u app grep "sleep 600" /etc/cron.d/x',
    'xargs grep "until x; do"',
    // The vocabulary as DATA, whatever the quoting around it.
    'grep -rn "foo; while true; do" src/',
    "grep -F 'until x; do' -r .",
    'grep "a\\"; until X; do" f',
    'git log --grep "until x; do" --oneline',
    'git -C /tmp/repo grep -n "while true; do"',
    'echo "$(grep -c "while true; do" x)"',
    "echo $'until x; do\\n'",
    // A comment is not a command.
    '# until x; do sleep 30; done',
    `echo x # ${loop}`,
    // A here-doc fed to anything but a shell is data — the way a session on
    // this repository has to write a test file that MENTIONS a poll loop.
    `cat > /tmp/notes.md <<'EOF'\nthe old ${loop} shape\nEOF`,
    `python3 - <<'EOF'\nprint("${loop}")\nEOF`,
    `tee /tmp/x.sh <<EOF\ndon't ${loop}\nEOF\necho written`,
    // Brace expansion is not a group; a subshell that only prints is only printing.
    'echo {a,b}',
    '(echo x; echo y)',
    'echo x | while read -r f; do wc -l "$f"; done',
    'sleep 8',
  ]) {
    assert.equal(inTurnWait(command, ENV), null, `false positive: ${command}`);
  }
});

test('splitStatements reads a command the way bash does', () => {
  const shapes = (command: string) => splitStatements(command).map((s) => `${s.text}${s.backgrounded ? ' &' : ''}`);
  assert.deepEqual(shapes('a; b && c || d | e |& f & g\n'), ['a', 'b', 'c', 'd', 'e', 'f &', 'g']);
  assert.deepEqual(shapes('until x; do y; done; z'), ['until x; do y; done', 'z']);
  assert.deepEqual(shapes('if a; then b; else c; fi\nd'), ['if a; then b; else c; fi', 'd']);
  assert.deepEqual(shapes('echo "a; b" \'c; d\' e\\; f; g'), ['echo "a; b" \'c; d\' e\\; f', 'g']);
  assert.deepEqual(shapes('x=$(a; b); c'), ['x=$(a; b)', 'c']);
  assert.deepEqual(shapes('cmd 2>&1 &> /dev/null; next'), ['cmd 2>&1 &> /dev/null', 'next']);
  assert.deepEqual(shapes('a \\\n  b; c'), ['a \\\n  b', 'c']);
  assert.deepEqual(shapes('cat <<EOF\nnot; a; command\nEOF\nafter'), ['cat <<EOF', 'after']);
  // A group is one statement, and says what is inside it.
  const [group] = splitStatements('( a; b ) > /tmp/log');
  assert.equal(group?.inner, ' a; b ');
  assert.equal(group?.tail, '> /tmp/log');
  const [braces] = splitStatements('{ a; b; }');
  assert.equal(braces?.inner, ' a; b; ');
  // A substitution is recorded with its body, so it can be judged on its own.
  const [subst] = splitStatements('echo "$(a; b)" `c`');
  assert.deepEqual(subst?.substitutions.map((s) => s.body), ['a; b', 'c']);
  // What never closes is malformed, and stays one statement to the end.
  const [open] = splitStatements("echo it's; until x; do y; done");
  assert.equal(open?.malformed, true);
  assert.equal(splitStatements("echo it's; until x; do y; done").length, 1);
});

/* ------------------------------------------------------------------ *
 * QA round 4 — the statement model's own doors
 * ------------------------------------------------------------------ */

const LOOP = 'until [ -f /tmp/x ]; do sleep 30; done';
const OUTCOME = join(SKILL_DIR, 'scripts', 'phase-outcome.sh');

test('round 4 — the deny message\'s own remedy is allowed, in every spelling', () => {
  // H1, present since the phase's first commit and missed by three rounds:
  // `phase-outcome.sh … --watch <ref>` is what the reason text, the Stop hook,
  // SKILL.md and both boot prompts tell a session to run, and the ` --watch`
  // arm denied it. A guard that refuses its own remedy refuses twice.
  for (const command of [
    `bash ${OUTCOME} demo 2 waiting-external --wait-minutes 30 --watch "gh:o/r#run/42"`,
    `bash ${OUTCOME} demo 2 waiting-external --wait-minutes 30 --watch=gh:o/r#run/42`,
    `bash ${OUTCOME} demo 2 waiting-external --reason "CI" --wait-minutes 30 --watch "gh:o/r#run/42" --watch "date:2026-09-01T09:00:00Z"`,
    `bash ${OUTCOME} demo 2 blocked --until 2026-09-01T09:00:00Z --watch lock:demo/3`,
    'bash scripts/phase-outcome.sh demo 2 waiting-external --watch cmd:"test -f /tmp/done"',
  ]) {
    assert.equal(inTurnWait(command, ENV), null, `the remedy was refused: ${command}`);
  }
  // …and the remedy is not a licence for what follows it.
  for (const command of [
    `bash ${OUTCOME} demo 2 waiting-external --watch "gh:o/r#run/42"; ${LOOP}`,
    `bash ${OUTCOME} demo 2 waiting-external --watch "gh:o/r#run/42" && gh run watch 42`,
  ]) {
    assert.ok(inTurnWait(command, ENV), `bypassed: ${command}`);
  }
});

test('round 4 — a line continuation is whitespace, not a word', () => {
  // H2: `\⏎` at a statement's start read as the statement's first word, so the
  // `until` on the next line opened no compound and its own `;` split the loop.
  for (const command of [
    `cd /tmp && \\\n${LOOP}`,
    `echo x; \\\n${LOOP}`,
    `\\\n${LOOP}`,
    `export X=1; \\\n${LOOP}`,
    'echo x && \\\n  while true; do sleep 30; done',
    `echo x; \\\n  ${LOOP}`,
    `echo x; \\\r\n${LOOP}`,
  ]) {
    assert.ok(inTurnWait(command, ENV), `bypassed: ${JSON.stringify(command)}`);
  }
  assert.equal(inTurnWait('echo x; \\\necho "until y; do"', ENV), null, 'the mirror false positive');
});

test('round 4 — data that reaches a shell in the same command is code', () => {
  // H3: an exempt `echo` is exempt because it prints; when what it prints is
  // run by `bash -c`, `eval` or the far side of a pipe, it did not print.
  for (const command of [
    'bash -c "$(echo \'sleep 600\')"',
    'sh -c "$(printf \'sleep 600\')"',
    'eval "$(printf \'sleep 600\')"',
    'eval $(echo sleep 600)',
    'eval `echo sleep 600`',
    `eval "$(echo '${LOOP}')"`,
    "echo 'sleep 600' | bash",
    `echo '${LOOP}' | bash`,
    `printf '%s\\n' '${LOOP}' | sh`,
    "printf 'sleep 600' | sh -s",
    "echo 'sleep 600' | sudo bash",
    "echo 'sleep 600' | env bash",
    "echo 'sleep 600' | source /dev/stdin",
    "echo 'sleep 600' | . /dev/stdin",
    "echo 'sleep 600' | ssh host bash",
    "echo 'sleep 600' | docker exec -i c sh",
    'echo sleep 600 | xargs -I{} sh -c {}',
    "grep -h '^sleep 600' /tmp/s.sh | bash",
    "echo 'sleep 600' | cat | bash",
    'ssh host "until [ -f x ]; do sleep 30; done"',
    'docker exec c sh -c "sleep 600"',
    'find . -name x -exec sleep 600 \\;',
    "git -c core.pager='sleep 600' log",
    'git bisect run sleep 600',
    "git rebase -x 'sleep 600' HEAD~3",
  ]) {
    assert.ok(inTurnWait(command, ENV), `bypassed: ${command}`);
  }
  for (const command of [
    "echo 'sleep 600' | grep -c sleep",
    "echo 'sleep 600' | wc -l",
    'bash -c "echo hi"',
    'echo hi | xargs echo',
  ]) {
    assert.equal(inTurnWait(command, ENV), null, `false positive: ${command}`);
  }
});

test('round 4 — a here-doc body a shell will read is code, wherever the shell stands', () => {
  // H4: the owner's first word is not the reader. `/bin/bash`, `env bash`,
  // `docker exec … bash`, and the shell at the far end of a pipe all read it.
  for (const command of [
    `cat <<'EOF' | bash\n${LOOP}\nEOF`,
    `cat <<EOF | sh -s\n${LOOP}\nEOF`,
    `tee /tmp/s.sh <<'EOF' | bash\n${LOOP}\nEOF`,
    `cat <<'EOF' | ssh host bash\n${LOOP}\nEOF`,
    `docker exec -i c bash <<EOF\n${LOOP}\nEOF`,
    `docker compose exec -T api bash <<EOF\n${LOOP}\nEOF`,
    `docker run -i --rm alpine sh <<EOF\n${LOOP}\nEOF`,
    `kubectl exec -i p -- sh <<EOF\n${LOOP}\nEOF`,
    `/bin/bash <<EOF\n${LOOP}\nEOF`,
    `/usr/bin/env bash <<EOF\n${LOOP}\nEOF`,
    `sudo bash <<EOF\n${LOOP}\nEOF`,
    `for f in a b; do bash <<EOF\n${LOOP}\nEOF\ndone`,
  ]) {
    assert.ok(inTurnWait(command, ENV), `bypassed: ${JSON.stringify(command)}`);
  }
  for (const command of [
    `cat <<'EOF' > /tmp/notes.md\n${LOOP}\nEOF`,
    `tee /tmp/bash-notes.md <<'EOF'\n${LOOP}\nEOF`,
    `python3 - <<'EOF'\nprint("${LOOP}")\nEOF`,
    // L17: a non-shell here-doc inside a compound is data too.
    `for f in a b; do cat > $f <<EOF\n${LOOP}\nEOF\ndone`,
    `if true; then cat <<EOF\n${LOOP}\nEOF\nfi`,
  ]) {
    assert.equal(inTurnWait(command, ENV), null, `false positive: ${JSON.stringify(command)}`);
  }
});

test('round 4 — the natural while shapes match', () => {
  // H5: round 1 narrowed `while` to `(true|:)`, `[` and `!` so `| while read`
  // would stop matching, and `[[`, `test` and `((` fell out with it.
  for (const command of [
    'while [[ ! -f /tmp/x ]]; do sleep 30; done',
    'while [[ -z "$(cat /tmp/x)" ]]; do sleep 5; done',
    'while test ! -f /tmp/x; do sleep 30; done',
    'while (( i < 10 )); do sleep 30; done',
    'while sleep 30; do :; done',
  ]) {
    assert.ok(inTurnWait(command, ENV), `bypassed: ${command}`);
  }
  for (const command of [
    'echo x | while read -r f; do wc -l "$f"; done',
    'while IFS= read -r line; do echo "$line"; done < /tmp/f',
  ]) {
    assert.equal(inTurnWait(command, ENV), null, `false positive: ${command}`);
  }
});

test('round 4 — `& wait` is the foreground wait with two words added', () => {
  for (const command of [
    'sleep 90 & wait',
    'sleep 600 & wait $!',
    'sleep 600 & wait %1',
    'sleep 600 &\nwait',
    'sleep 600 & sleep 600 & wait',
    'sleep 600 & sleep 5; wait',
  ]) {
    assert.ok(inTurnWait(command, ENV), `bypassed: ${JSON.stringify(command)}`);
  }
  // A subshell's child is not waited on; a job with no vocabulary is no wait.
  for (const command of ['(sleep 600 &); wait', 'npm test > /tmp/x.log 2>&1 & wait']) {
    assert.equal(inTurnWait(command, ENV), null, `false positive: ${command}`);
  }
});

test('round 4 — a parameter expansion can hold a substitution', () => {
  for (const command of [
    'echo ${x:-$(sleep 600)}',
    'echo "${x:-$(sleep 600)}"',
    'printf %s ${x:-`sleep 600`}',
    `echo \${x:-$(${LOOP})}`,
  ]) {
    assert.ok(inTurnWait(command, ENV), `bypassed: ${command}`);
  }
  for (const command of ['echo ${x:-default}', 'echo "${x:-until y; do}"']) {
    assert.equal(inTurnWait(command, ENV), null, `false positive: ${command}`);
  }
});

test('round 4 — arithmetic `<<` is not a here-doc', () => {
  for (const command of [
    `x=$((1<<2))\n${LOOP}`,
    'echo $((1<<3))\nsleep 600',
    `[[ $((a<<1)) -gt 0 ]]\n${LOOP}`,
    `(( x = y << 2 ))\n${LOOP}`,
    `x=$(( 1 << 2 ))\n${LOOP}`,
    // A WORD after the shift is what the here-doc rule would take for a
    // terminator; only knowing it is arithmetic keeps the loop in view.
    `x=$(( a << b ))\n${LOOP}`,
    `(( x = y << z ))\n${LOOP}`,
  ]) {
    assert.ok(inTurnWait(command, ENV), `bypassed: ${JSON.stringify(command)}`);
  }
  assert.equal(inTurnWait('x=$((1<<2)); echo $x', ENV), null);
});

test('round 4 — a quoted string is data unless its command runs it', () => {
  // M10 and L18: every supervised session commits, and a message that says
  // "until … do" or "sleep 90" is prose.
  for (const command of [
    'git commit -m "hold until CI is green; do not merge"',
    'git commit -m "wait until the tests do pass"',
    'git commit -m "docs: sleep 90 is the new default"',
    'git stash -m "until x; do"',
    'git tag -a v1 -m "sleep 600 fixed"',
    '[[ "$x" == "until y; do" ]] && echo yes',
    'test "$x" = "until y; do" && echo yes',
    'gh pr comment 1 --body "sleep 90 then retry"',
    'jq -n \'"until x; do"\'',
    // A pager that is a plain word runs nothing of the vocabulary's.
    'git -c core.pager=cat log --grep "until x; do"',
    'GIT_PAGER=cat git log --grep "until x; do"',
  ]) {
    assert.equal(inTurnWait(command, ENV), null, `false positive: ${command}`);
  }
  // …and an env assignment git will RUN — a pager, an editor, an ssh command —
  // is an executor, quoted or not (round 4's probe: b6be657 denied these).
  for (const command of [
    "GIT_PAGER='sleep 600' git log -p",
    "PAGER='sleep 600' git log -p",
    'EDITOR="sleep 600" git commit',
    "GIT_SSH_COMMAND='sleep 600' git fetch",
  ]) {
    assert.ok(inTurnWait(command, ENV), `bypassed: ${command}`);
  }
  // …while the vocabulary's own commands and every compound keep their quotes.
  for (const command of [
    'sleep "90"',
    "sleep '600'",
    'for i in 1 2 3; do sleep "90"; done',
    'until [ "$(gh run view 1 -q .status)" = completed ]; do sleep 15; done',
    'bash -c "sleep 600"',
  ]) {
    assert.ok(inTurnWait(command, ENV), `bypassed: ${command}`);
  }
});

test('round 4 — a case pattern\'s `)` closes nothing', () => {
  for (const command of [
    `( case x in a) ${LOOP};; esac )`,
    `x=$(case y in a) ${LOOP};; esac)`,
    `case x in a) ${LOOP};; esac`,
    `case x in (a) ${LOOP};; esac`,
  ]) {
    assert.ok(inTurnWait(command, ENV), `bypassed: ${command}`);
  }
  assert.equal(inTurnWait('case x in a) echo "a)";; b) echo b;; esac; echo done', ENV), null);
});

test('round 4 — comments are DETECTED, not only blanked', () => {
  // L14: `# until …` alone was rescued by the compound rule and `echo x # …`
  // by the echo exemption, so a detection that never fired stayed green.
  for (const command of ['npm test # sleep 600', '# sleep 600', 'ls # tail -f x']) {
    assert.equal(inTurnWait(command, ENV), null, `false positive: ${command}`);
  }
});

test('round 4 — the guard never throws, and a text it cannot read is refused', () => {
  // L12: a throw reaches the CLI as a failed hook, and a failed hook is
  // fail-OPEN. Sizes no session writes, bounded because "never" means never.
  const nested = `${Array.from({ length: 5000 }, () => "bash <<'E'").join('\n')}\n${LOOP}`;
  assert.ok(inTurnWait(nested, ENV), 'nested here-docs are bounded and fail closed');
  const started = Date.now();
  const many = `echo ${'<<E '.repeat(25_000)}`;
  assert.doesNotThrow(() => inTurnWait(many, ENV));
  const wide = `${'echo x; '.repeat(100_000)}${LOOP}`;
  assert.ok(inTurnWait(wide, ENV), 'a wide command is still read to its end');
  assert.ok(Date.now() - started < 5_000, 'and read in linear time');
});

test('round 4 — the setup lane\'s docker bound reads every spelling, and a verb gate has a host bound', async () => {
  const { extractCommands } = await import('../server/runner/verify.ts');
  // H6: pflag shorthand with no separator, the compose-native env spelling,
  // a project name that attaches to somebody else's stack, and a database
  // created on another host.
  for (const command of [
    'docker compose -f/etc/prod/compose.yml up -d',
    'COMPOSE_FILE=/etc/prod/compose.yml docker compose up -d',
    'COMPOSE_FILE=../prod/compose.yml docker compose up -d',
    'COMPOSE_FILE=infra/a.yml:/etc/prod/b.yml docker compose up -d',
    'COMPOSE_PROJECT_NAME=prod docker compose up -d',
    'DOCKER_CONFIG=/etc/prod/docker docker compose up -d',
    'createdb -h prod-db.internal -U admin app_test',
    'createdb --host=prod-db.internal app',
    'createdb -h 10.0.0.5 app',
    'PGHOST=prod-db.internal createdb app',
    'minikube start --driver=ssh --ssh-ip-address=10.0.0.5',
  ]) {
    const setup = extractCommands(`\`${command}\``, 'setup');
    assert.deepEqual(setup.commands, [], `setup ran: ${command}`);
    assert.equal(setup.notRun.length, 1, `and did not say why: ${command}`);
  }
  // …while bring-up with a pre-subcommand VALUE flag, a compose file inside
  // the tree, and a local database still run.
  for (const command of [
    'docker compose --ansi never up -d',
    'docker compose --parallel 1 up -d',
    'docker compose --progress plain up -d',
    'docker compose -f infra/compose.yml up -d',
    'COMPOSE_FILE=infra/compose.yml docker compose up -d',
    'createdb app_test',
    'createdb -h localhost app_test',
  ]) {
    assert.deepEqual(extractCommands(`\`${command}\``, 'setup').commands, [command], `setup refused: ${command}`);
  }
});

test('round 5 — the remedy survives its own reason, and a script argument is not code', () => {
  // Round 5's H1+H4, one defect: the carve-out stopped at a separator inside a
  // quoted --reason, and `bash <script> <args>` was judged as code, which put
  // the remedy on the RAW path where quotes are not data. A shell executes its
  // ARGUMENTS only with -c (or bare, reading stdin); a script invocation's
  // arguments are the script's business.
  for (const command of [
    `bash ${OUTCOME} demo 2 waiting-external --wait-minutes 30 --reason "build & test on CI" --watch gh:o/r#run/42`,
    `bash ${OUTCOME} demo 2 waiting-external --reason 'build & test; then deploy' --watch gh:o/r#run/42`,
    `${OUTCOME} demo 2 waiting-external --reason "build & test on CI" --watch gh:o/r#run/42`,
    'bash scripts/phase-tasks.sh demo 2 create --subject "p2.task1 — wait until CI is green; do the merge"',
    'bash scripts/run-suite.sh "until x; do y; done"',
    'zsh scripts/phase-lock.sh demo claim 2 --reason "sleep 90 then retry"',
  ]) {
    assert.equal(inTurnWait(command, ENV), null, `the remedy or a script arg was refused: ${command}`);
  }
  for (const command of [
    'bash -c "sleep 600"',
    "bash -c 'until [ -f /tmp/x ]; do sleep 30; done'",
    'sh -c "$(echo \'sleep 600\')"',
    "echo 'sleep 600' | bash",
    "echo 'sleep 600' | bash /dev/stdin",
    "echo 'sleep 600' | bash -",
    'bash x.sh; until [ -f /tmp/x ]; do sleep 30; done',
  ]) {
    assert.ok(inTurnWait(command, ENV), `bypassed: ${command}`);
  }
});

test('round 5 — the lead is read through quotes, variables fail closed, and runners are stepped over', () => {
  // Round 5's H2: `executes`/`leadWords` split raw text on whitespace, so an
  // assignment with a quoted space broke the walk and every unlisted spelling
  // of a shell fell to the masked path, where its quoted payload is data.
  for (const command of [
    "X='a b' bash -c 'sleep 600'",
    'X="a b" Y="c d" sh -c "sleep 600"',
    '"bash" -c \'sleep 600\'',
    "'bash' -c 'sleep 600'",
    "$SHELL -c 'sleep 600'",
    "$(which bash) -c 'sleep 600'",
    "uv run bash -c 'sleep 600'",
    "npx bash -c 'sleep 600'",
    "poetry run bash -c 'sleep 600'",
  ]) {
    assert.ok(inTurnWait(command, ENV), `bypassed: ${command}`);
  }
  for (const command of [
    'X=\'a b\' grep "until y; do" src/',
    'X="a; until y; do" echo ok',
    'uv run pytest -q',
  ]) {
    assert.equal(inTurnWait(command, ENV), null, `false positive: ${command}`);
  }
});

test('round 5 — a pipeline backgrounds as one, and `wait` reaches only what came before it', () => {
  for (const command of [
    'tail -f /tmp/x.log | grep -q PASS &',
    'tail -f /tmp/x.log | grep -q PASS & echo started',
    'wait; sleep 600 &',
  ]) {
    assert.equal(inTurnWait(command, ENV), null, `false positive: ${command}`);
  }
  for (const command of [
    '{ sleep 600 & }; wait',
    'sleep 600 & wait',
    'tail -f /tmp/x.log | grep -q PASS & wait',
  ]) {
    assert.ok(inTurnWait(command, ENV), `bypassed: ${command}`);
  }
  assert.equal(inTurnWait('(sleep 600 &); wait', ENV), null, 'a subshell\'s child is not waited on');
});

test('round 5 — arithmetic anywhere, and a substitution inside it is still judged', () => {
  const LOOP2 = 'until [ -f /tmp/x ]; do sleep 30; done';
  for (const command of [
    `while (( x << 2 )); do sleep 90; done`,
    `if (( x << 2 )); then sleep 90; fi`,
    `while (( i < 3 )); do run_test; (( i++ )); done\n${LOOP2}`,
    'echo $(( $(sleep 600) ))',
    '(( x = $(sleep 600) ))',
  ]) {
    assert.ok(inTurnWait(command, ENV), `bypassed: ${JSON.stringify(command)}`);
  }
});

test('round 5 — the command-valued env list covers the askpass/prompt family', () => {
  for (const command of [
    "GIT_ASKPASS='sleep 600' git fetch origin",
    "SSH_ASKPASS='sleep 600' git fetch origin",
    "PROMPT_COMMAND='sleep 600' bash -i x",
    "GIT_PROXY_COMMAND='sleep 600' git fetch",
  ]) {
    assert.ok(inTurnWait(command, ENV), `bypassed: ${command}`);
  }
  for (const command of ['BASH_ENV=/tmp/env.sh bash x.sh', 'GIT_ASKPASS=/usr/bin/askpass git fetch']) {
    assert.equal(inTurnWait(command, ENV), null, `false positive: ${command}`);
  }
});

test('round 5 — the setup bounds read QUOTED paths, attached hosts, and the project-name flag', async () => {
  const { extractCommands } = await import('../server/runner/verify.ts');
  for (const command of [
    'docker compose -f "/etc/prod/compose.yml" up -d',
    "docker compose --file='/etc/prod/compose.yml' up -d",
    'COMPOSE_FILE="/etc/prod/compose.yml" docker compose up -d',
    'docker compose --project-directory "/etc" up -d',
    'createdb -hprod-db.internal app',
    'docker compose -p prod up -d',
    'docker compose --project-name prod up -d',
  ]) {
    const setup = extractCommands(`\`${command}\``, 'setup');
    assert.deepEqual(setup.commands, [], `setup ran: ${command}`);
  }
  for (const command of [
    'docker compose -f "infra/compose.yml" up -d',
    'createdb -hlocalhost app',
  ]) {
    assert.deepEqual(extractCommands(`\`${command}\``, 'setup').commands, [command], `setup refused: ${command}`);
  }
});

/* ------------------------------------------------------------------ *
 * Exit criterion 2 — whose clock, and the two remedies
 * ------------------------------------------------------------------ */

test('a wait is classified by what it waits ON, not by where its output lands', () => {
  assert.equal(waitScope('until [ -f /tmp/suite.done ]; do sleep 30; done'), 'local');
  assert.equal(waitScope('tail -f tasks/abc123.output'), 'local');
  assert.equal(waitScope('until pgrep -f "pytest" > /dev/null; do sleep 20; done'), 'local');
  assert.equal(waitScope('gh run watch 42'), 'external');
  assert.equal(waitScope('kubectl rollout status deploy/api'), 'external');
  // The overlap that decides the rule: a local path on an external wait.
  assert.equal(waitScope('gh run watch 42 > /tmp/ci.log'), 'external',
    'the output file does not own the clock');
  // And the default, which is the behaviour that existed before the split.
  assert.equal(waitScope('some-unfamiliar-poller --forever'), 'external');
});

test('the scope reaches the stall state, so the runner can route on it', () => {
  const at = 3_600_000;
  const signals = {
    openTools: [{ id: 't', name: 'Bash', since: at - 10 * 60_000, summary: 'until test -f /tmp/done; do sleep 30; done' }],
    lastOutputAt: at, lastProductiveAt: at, turnsSinceLastTool: 0,
    idleAttempts: 0, retriesSinceProgress: 0,
  } as never;
  const stall = evaluateStall(signals, stallThresholds(), at, { verifyEnv: ENV });
  assert.equal(stall?.signal, 'external-wait');
  assert.equal(stall?.scope, 'local');
  assert.match(stall!.detail, /a background job this session started/);
});

test('the watch-ref probe list holds only leads that ASK and that the runner will RUN', async () => {
  // QA round 3's M4, and the finding that stung: the commit that removed
  // `find`, `pgrep`, `nc` and `wget` from this list said "every behaviour
  // claimed above now has an assertion", and QA red-proved otherwise by
  // putting all four back and watching the whole suite stay green.
  //
  // Two properties, and each removal failed exactly one of them.
  const { extractCommands } = await import('../server/runner/verify.ts');
  const { WATCH_REF_PROBES } = await import('../server/runner/liveness.ts');

  for (const lead of WATCH_REF_PROBES) {
    // It must be a lead the runner will actually execute, or a ref built from
    // it is refused on sight — the "worse than no ref" case this list is for.
    assert.ok(
      extractCommands(`\`${lead} x\``).commands.length > 0
        || extractCommands(`\`${lead} --version\``).commands.length > 0,
      `\`${lead}\` is not a verb the runner runs — a ref built from it is refused on sight`,
    );
  }
  // And it must not be able to destroy. `find` was on the list and
  // `until find /tmp -name '*.tmp' -delete` mints a ref the policy RUNS,
  // because ` -delete` is not `delete-` and MUTATION_DENY never sees it.
  for (const lead of ['find', 'pgrep', 'nc', 'wget', 'rm', 'psql']) {
    assert.equal(WATCH_REF_PROBES.has(lead), false, `\`${lead}\` must not mint a timed command`);
  }
  assert.equal(localWatchRef("until find /tmp -name '*.tmp' -delete; do sleep 5; done"), null);
});

test('a poll loop hands over its own landing condition as a `cmd:` ref', () => {
  // The session already wrote, in shell, what "done" means. The park lifts it
  // out so the lane comes back when the job is genuinely finished instead of
  // at the end of a window somebody guessed.
  assert.equal(localWatchRef('until [ -f /tmp/suite.done ]; do sleep 30; done'),
    'cmd:"test -f /tmp/suite.done"');
  assert.equal(localWatchRef('while ! test -f /tmp/x; do sleep 10; done'),
    'cmd:"test -f /tmp/x"');
  // A bare `while` lands when its condition goes FALSE, and the only way to
  // say that is a leading `!` — not a verb the runner's read-only allowlist
  // will execute. A ref certain to be refused is worse than no ref: it spends
  // a journal line and a rotation slot to say nothing.
  assert.equal(localWatchRef('while pgrep -f pytest; do sleep 10; done'), null);
  assert.equal(localWatchRef('gh run watch 42'), null);

  // And the condition's lead must be a PROBE. This ref is different in kind
  // from the others the scheduler runs: those were declared by a session, this
  // one is minted by the console out of text it found — so a poll loop whose
  // condition DOES something yields no ref at all, rather than a command run on
  // a timer twelve times with nobody watching. QA's list, verbatim.
  for (const loop of [
    'until ./scripts/import.sh; do sleep 30; done',
    'until python3 seed.py; do sleep 30; done',
    'until npm run db:wipe; do sleep 30; done',
    'until bash ./drop-and-recreate.sh; do sleep 30; done',
    'until psql -c "DELETE FROM q"; do sleep 30; done',
  ]) {
    assert.equal(localWatchRef(loop), null, `the console would run this on a timer: ${loop}`);
  }
  // The probes it will mint, because they ask and change nothing.
  assert.equal(localWatchRef('until curl -sf localhost:8080/health; do sleep 5; done'),
    'cmd:"curl -sf localhost:8080/health"');
  assert.equal(localWatchRef('while ! grep -q DONE /tmp/run.log; do sleep 5; done'),
    'cmd:"grep -q DONE /tmp/run.log"');
});

/* ------------------------------------------------------------------ *
 * Exit criterion 3 — `- **Setup:**`
 * ------------------------------------------------------------------ */

test('Setup runs BEFORE the verification commands and can never colour the verdict', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pc-setup-'));
  const marker = join(cwd, 'setup-ran');
  const summary = await verifyPhase('- **Verification:** `test -d setup-ran`', {
    cwd,
    setupText: `- **Setup:** \`mkdir -p ${marker}\``,
  });
  assert.equal(summary.ok, true, `${summary.reason}`);
  assert.equal(summary.setup, undefined, 'a Setup that worked says nothing');
  rmSync(cwd, { recursive: true, force: true });
});

test('a Setup command that fails is recorded and is still not a red phase', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pc-setup-red-'));
  const summary = await verifyPhase('- **Verification:** `true`', {
    cwd,
    setupText: '- **Setup:** `false`',
  });
  assert.equal(summary.ok, true, 'the verdict comes from §Verification alone');
  assert.equal(summary.setup?.ok, false);
  assert.match(summary.setup!.command, /false/);
  rmSync(cwd, { recursive: true, force: true });
});

test('a phase with no Setup is byte-identical to one that never heard of it', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pc-setup-none-'));
  const summary = await verifyPhase('- **Verification:** `true`', { cwd });
  assert.equal(summary.ok, true);
  assert.ok(!('setup' in summary), 'no key at all, not a key holding undefined');
  rmSync(cwd, { recursive: true, force: true });
});

test('the setup lane may START things and still may not DESTROY them', async () => {
  const { extractCommands } = await import('../server/runner/verify.ts');
  // What the widening buys: bring-up that the read-only gates refuse by
  // construction. `DOCKER_READ_ONLY` exists to stop exactly this in a
  // §Verification, and stopping it in a Setup bullet would make the bullet
  // pointless.
  for (const command of ['docker compose up -d', 'npm ci', 'sleep 8', 'alembic upgrade head']) {
    const setup = extractCommands(`\`${command}\``, 'setup');
    assert.deepEqual(setup.commands, [command], `setup refused: ${command}`);
  }
  assert.deepEqual(extractCommands('`docker compose up -d`').commands, [],
    'and the verification lane still refuses it, unchanged');

  // What it does NOT buy, and this is the half that matters. `MUTATION_DENY`
  // and `MUTATING_SCRIPT` are untouched by the lane: the widening is "may
  // start things", never "may do anything".
  for (const command of [
    'rm -rf node_modules', 'git push origin main', 'terraform apply',
    'npm publish', 'sudo systemctl restart nginx', './deploy.sh',
  ]) {
    const setup = extractCommands(`\`${command}\``, 'setup');
    assert.deepEqual(setup.commands, [], `the wall let this through in setup: ${command}`);
  }
});

test('the setup lane keeps every reach-outside gate, and QA proved why', async () => {
  const { extractCommands } = await import('../server/runner/verify.ts');
  // THE regression test for this phase's worst defect. The first cut of the
  // setup lane deleted the whole `REACHES_OUT` table on the reasoning that
  // those gates ask "is this demonstrably a READ" and bring-up is not one.
  // That is true of `docker` and false of everything else: QA drove
  // `extractCommands(…, 'setup')` directly and found FIFTEEN commands the
  // verify lane refuses had become runnable — unattended, before every
  // verification attempt, and by design unable to colour the phase red, so
  // nothing would ever have surfaced one.
  //
  // Note `ssh <host> 'rm -rf …'` in particular: the `rm` escapes
  // `MUTATION_DENY` because the character before it is a quote, so the denylist
  // was never the thing protecting this. The `ssh` gate was.
  //
  // The list is QA's, verbatim, because a test written from the same head as
  // the fix tends to prove the thing that was never at risk — which is exactly
  // what the first version of the test above did.
  const MUST_STAY_REFUSED = [
    "ssh main-prod 'systemctl restart api'",
    "ssh main-prod 'rm -rf /opt/app/data'",
    "psql -c 'DROP TABLE users'",
    'curl -X POST https://example.com/hook -d @payload.json',
    'kubectl delete pod api-0',
    'kubectl apply -f prod.yaml',
    'gh release create v1.0.0',
    'gh pr merge 7 --squash --admin',
    'gh api -X POST /repos/o/r/issues',
    'redis-cli FLUSHALL',
    'docker compose down -v',
    'touch /etc/passwd',
  ];
  for (const command of MUST_STAY_REFUSED) {
    const setup = extractCommands(`\`${command}\``, 'setup');
    assert.deepEqual(
      setup.commands, [],
      `the setup lane would RUN this unattended: ${command}`,
    );
    // And it is refused with a REASON, not silently dropped — a Setup bullet
    // whose command vanished without a word is worse than one that was run.
    assert.equal(setup.notRun.length, 1, `no reason recorded for: ${command}`);
  }

  // The carve-out is exactly the bring-up half of docker, and `down` is not in
  // it: `docker compose down -v` destroys named volumes, which on a plan whose
  // database lives in one is a data-loss incident rather than a preamble.
  for (const command of [
    'docker compose up -d', 'docker compose start', 'docker compose build',
    'docker compose create', 'docker-compose up -d',
  ]) {
    assert.deepEqual(
      extractCommands(`\`${command}\``, 'setup').commands, [command],
      `setup refused bring-up it exists for: ${command}`,
    );
  }
});

test('a setup lead is recognised, and still only for its bring-up subcommand', async () => {
  // QA round 2's H2 — H1's class one door over. Restoring `REACHES_OUT` bought
  // nothing for these leads because that table has no entry for them, so
  // `SETUP_VERBS` was admitting them unconditionally: `vagrant destroy -f`,
  // `minikube delete --all --purge` and `kind delete cluster` all ran.
  // `scripts/verify.env` had always specified the widening per SUBCOMMAND;
  // this file had implemented it per LEAD.
  const { extractCommands } = await import('../server/runner/verify.ts');
  const runs = (command: string) => extractCommands(`\`${command}\``, 'setup').commands.length > 0;

  for (const command of [
    'vagrant destroy -f', 'vagrant halt',
    'minikube delete --all --purge', 'minikube stop',
    'kind delete cluster', 'kind delete clusters --all',
    'pip uninstall -y django',
  ]) assert.equal(runs(command), false, `the setup lane would run: ${command}`);

  for (const command of [
    'vagrant up', 'minikube start', 'kind create cluster',
    'bundle install', 'pip install -r requirements.txt',
    'createdb app_test', 'mkdir -p data',
  ]) assert.equal(runs(command), true, `setup refused bring-up it exists for: ${command}`);
});

test('the docker widening is bounded in host, in path, and in what a flag may destroy', async () => {
  // QA round 2's M8. The subcommand allowance said WHAT may run and nothing
  // said WHERE, so the same allowance brought up a stack on another machine or
  // out of a compose file outside the tree — and `--renew-anon-volumes`
  // destroys volumes while starting, which is the harm `down`'s exclusion is
  // justified by, spelled as an option instead of a subcommand.
  const { extractCommands } = await import('../server/runner/verify.ts');
  const runs = (command: string) => extractCommands(`\`${command}\``, 'setup').commands.length > 0;

  for (const command of [
    'docker compose -f /etc/prod/compose.yml up -d',
    'docker compose --project-directory / up -d',
    'DOCKER_HOST=ssh://root@prod docker compose up -d',
    'docker compose up -d --renew-anon-volumes',
    'docker compose up -d --remove-orphans',
  ]) assert.equal(runs(command), false, `unbounded docker bring-up: ${command}`);

  assert.equal(runs('docker compose up -d'), true);
  assert.equal(runs('docker compose -f compose.ci.yml up -d'), true, 'a relative file is this tree');
  // And the verify lane lost nothing: a containerised suite still runs there.
  assert.deepEqual(
    extractCommands('`docker compose run --rm api pytest -q`').commands,
    ['docker compose run --rm api pytest -q'],
  );
});

test('every shape F22 tells an author to MOVE is a shape Setup will run', async () => {
  // QA round 2's M5. F22's whole advice is "move this into `- **Setup:**`", and
  // `runSetup` reports no `notRun` by design — so a lead the bullet silently
  // refuses turns the advice into a way to lose a command. `docker run ` left
  // `SETUP_LEADS` for exactly this reason: the runner judges it by the command
  // it carries, and an image name is not one.
  const { extractCommands } = await import('../server/runner/verify.ts');
  const { loadVerifyEnv } = await import('../server/runner/verify-env.ts');
  const leads = loadVerifyEnv(SCRIPTS).setupLeadsSource.split('|');
  const SAMPLE: Record<string, string> = {
    'docker[ -]compose up': 'docker compose up -d',
    'docker start ': 'docker start pg',
    'npm ci': 'npm ci',
    'npm install': 'npm install',
    'pnpm install': 'pnpm install',
    'yarn install': 'yarn install',
    'bundle install': 'bundle install',
    'pip install': 'pip install -r requirements.txt',
    'uv sync': 'uv sync',
    'poetry install': 'poetry install',
    'terraform init': 'terraform init',
    'alembic upgrade': 'alembic upgrade head',
    'minikube start': 'minikube start',
    'kind create cluster': 'kind create cluster',
    'vagrant up': 'vagrant up',
    'sleep [0-9]': 'sleep 8',
  };
  assert.deepEqual(
    leads.filter((lead) => !(lead in SAMPLE)), [],
    'a SETUP_LEADS entry has no sample here — add one, and check the bullet runs it',
  );
  for (const lead of leads) {
    const command = SAMPLE[lead];
    assert.ok(
      extractCommands(`\`${command}\``, 'setup').commands.length > 0,
      `F22 would advise moving \`${command}\` into a bullet that refuses it`,
    );
  }
});

test('commands come back in SOURCE order, with the old inline pairing intact', async () => {
  // Two properties that pull against each other, and the second is the one QA
  // round 2 caught being traded away.
  //
  // ORDER: a fenced block and inline spans must come back in the order they
  // appear, or a phase whose `- **Setup:**` is a fence, under a plan-wide line
  // of inline spans, runs its own bring-up before the shared stack.
  //
  // PAIRING: fences are still located and MASKED before the inline scan, so a
  // stray unbalanced backtick pairs exactly as it always did. A single
  // alternation walking both shapes paired it against the fence's own
  // backticks instead and produced `npm test then` — a "command" that would
  // RUN and redden the phase.
  const { extractCommands } = await import('../server/runner/verify.ts');
  const lines = (...l: string[]) => l.join('\n');

  assert.deepEqual(
    extractCommands(lines(
      '- **Setup:** `docker compose up -d`, `sleep 8`', '  ```bash', '  npm ci', '  ```',
    ), 'setup').commands,
    ['docker compose up -d', 'sleep 8', 'npm ci'],
  );
  assert.deepEqual(
    extractCommands(lines(
      '- **Setup:**', '  ```bash', '  npm ci', '  ```', '  and then `sleep 8`',
    ), 'setup').commands,
    ['npm ci', 'sleep 8'],
    'the other order, too — this is the half a fenced-first scan got right by luck',
  );
  assert.deepEqual(
    extractCommands(lines(
      '- **Verification:**', '  `npm test then', '  ```bash', '  npm run build', '  ```',
    )).commands,
    ['npm run build'],
    'an unterminated span must not pair against the fence and mint a garbage command',
  );
  // And the shapes that were already handled stay handled.
  assert.deepEqual(extractCommands('~~~sh\nnpm test\n~~~').commands, ['npm test']);
  assert.deepEqual(extractCommands('```bash\r\nnpm test\r\n```').commands, ['npm test']);
  assert.deepEqual(extractCommands('run the suite by hand').commands, []);
});

test('the plan-wide Setup line is unioned into every phase, plan first', () => {
  const plan = parsePlan([
    '---', 'phases: 2', '---', '', '# Demo', '',
    '## Session budget', '',
    '**Target model:** `claude-opus-5` · **Budget:** ~200K',
    '**Setup (every phase):** `docker compose up -d`, `sleep 8`', '',
    '## Phase graph', '',
    '| Phase | Title | Depends on | Repos |',
    '|---|---|---|---|',
    '| 1 | One | — | app |',
    '| 2 | Two | 1 | app |', '',
    '### Phase 1 — One',
    '- **Setup:** `npm ci`',
    '- **Verification:** `npm test`', '',
    '### Phase 2 — Two',
    '- **Verification:** `npm test`', '',
  ].join('\n'), 'demo', '/tmp/demo.md');

  assert.match(plan.phases[1].setup!, /docker compose up -d/);
  assert.match(plan.phases[1].setup!, /npm ci/);
  assert.ok(
    plan.phases[1].setup!.indexOf('docker compose') < plan.phases[1].setup!.indexOf('npm ci'),
    'bring-up is ORDERED: the shared stack before the phase-s own step against it',
  );
  // A phase that declares nothing still gets the plan-wide preamble.
  assert.match(plan.phases[2].setup!, /docker compose up -d/);
  // And Setup never eats Verification, which is what would happen if the reach
  // ran to the end of the block.
  assert.ok(!plan.phases[1].setup!.includes('npm test'));
});

/* ------------------------------------------------------------------ *
 * The vocabulary's third list, and its two readers
 * ------------------------------------------------------------------ */

test('SETUP_LEADS and the carve-out are the SAME strings bash reads', async () => {
  const { execFileSync } = await import('node:child_process');
  const fromBash = (key: string) => execFileSync('bash', [
    '-c', `. "${SCRIPTS}/verify.env"; printf '%s' "\${${key}}"`,
  ], { encoding: 'utf8' });

  assert.equal(fromBash('SETUP_LEADS'), ENV.setupLeadsSource);
  assert.equal(fromBash('EXTERNAL_WAIT_ALLOW'), ENV.externalWaitAllowSource);
  // And the TS fallbacks — what an older scripts dir gets, where drift is
  // invisible — say the same thing.
  assert.equal(ENV.setupLeadsSource, VERIFY_ENV_FALLBACK.setupLeadsSource);
  assert.equal(ENV.externalWaitAllowSource, VERIFY_ENV_FALLBACK.externalWaitAllowSource);
});

test('a scripts dir that predates the two new lists falls back rather than losing them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-verify-old-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'verify.env'), "EXTERNAL_WAIT='gh run watch'\n");
  const old = loadVerifyEnv(dir);
  assert.equal(old.externalWaitSource, 'gh run watch', 'the key it DOES have is read');
  assert.equal(old.setupLeadsSource, VERIFY_ENV_FALLBACK.setupLeadsSource);
  assert.equal(old.externalWaitAllowSource, VERIFY_ENV_FALLBACK.externalWaitAllowSource);
});
