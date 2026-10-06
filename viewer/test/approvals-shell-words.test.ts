/**
 * AJ-1..3 (control-tower phase 107, #189) — the approval judge reads shell as
 * a shell does: a rule matches only the words a line would EXECUTE.
 *
 * A release phase ran a `python3 - <<'EOF' … EOF` that rewrote its own
 * handoff. The handoff's TEXT carried a resume step — "`git fetch origin &&
 * git merge --no-edit origin/main && git push -u origin pe/ai-builder-v7`" —
 * and the matcher, splitting the raw line at the `&&` inside that text, found a
 * `git push`, could not vouch for it ("the command carries a substitution the
 * row cannot vouch for", for markdown backticks), and parked the phase on a
 * person's card. Nothing in the command pushed anything.
 *
 * AJ-1  A quoted here-doc's body is data: the #189 command, verbatim in shape,
 *       raises no card under a deny-by-default `permission.destructive` row,
 *       and no publishing rule matches it — whichever way the delimiter is
 *       quoted.
 * AJ-2  A `python3 -c` / `node -e` payload and a quoted argument are data too,
 *       and match no `Bash(<cmd>:*)` rule — the wall included. A SHELL's `-c`
 *       payload is code (a recorded deviation from the plan's wording: reading
 *       `bash -c 'git push --force …'` as data would open the wall).
 * AJ-3  What the shell DOES run inside a here-doc or an `eval` is seen, and a
 *       push there is said to be one — "a push may be hidden in a heredoc",
 *       "… in an `eval`" — never "a substitution the row cannot vouch for"
 *       for text that is not one.
 */

import '../e2e/fixture/steady-load.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CONFIG_HOME = mkdtempSync(join(tmpdir(), 'pc-shell-words-config-'));
const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-shell-words-state-'));
process.env.XDG_CONFIG_HOME = CONFIG_HOME;
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.PHASE_CONSOLE_LOG = '';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const {
  POLICY_PATH, DEFAULT_ASK, DEFAULT_DENY, bashSubjects, carvedPolicy, classifyTool, matchedAskRule, publishingRule,
} = await import('../server/runner/approvals.ts');
const { readShell, executedTexts } = await import('../server/runner/shell-reading.ts');

const flags = {
  port: 0, host: '127.0.0.1', open: false, allowWrites: false,
  scriptsDir: join(SKILL_DIR, 'scripts'),
  logFile: null,
};

/** ai-builder-v7's row (#205): the run branch is pushed "as a backup" in every phase. */
const AB7_ROW = 'deny, with these allow rows: Phase 1 — `gh label create`, `gh issue create`; Phases 4/17/22 — `gh pr create`, `gh pr merge --squash --delete-branch`, `gh issue close`, `gh issue comment`, the direct pathspec pushes …; every phase — `git push` of `pe/ai-builder-v7` as a backup …';
/** The shipped default when a plan publishes nothing — deny by default, no exception. */
const DENY_ROW = 'deny — no phase publishes';

const manifestOf = (value: string) => ({
  decisions: [{ key: 'permission.destructive', state: 'answered', source: 'plan', value }],
});

type Noted = { event: string; data: Record<string, unknown>; phase?: number };

/** A new-branch run with Open a PR on: `git push` is a person's tap unless the row answers it (#112). */
const CARVED = { gitMode: 'new-branch', openPr: true };

function serviceOn(run: Record<string, unknown>) {
  const service = new Service(flags as never);
  const noted: Noted[] = [];
  const parked: string[] = [];
  const state = { id: 'r1', slug: 'ai-builder-v7', activePhase: 4, permissionProfile: 'trusted', ...run };
  (service as unknown as { runners: Map<string, unknown> }).runners.set('ai-builder-v7', {
    isSpending: () => false,
    busy: () => true,
    current: () => state,
    note: (event: string, data: Record<string, unknown>, phase?: number) => noted.push({ event, data, phase }),
    park: (reason: string) => { parked.push(reason); },
    enterPersonWait: () => {},
    leavePersonWait: () => {},
  });
  return { service, noted, parked, state };
}

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });

function reply(out: Record<string, unknown>): { permissionDecision: string; permissionDecisionReason: string } {
  return (out as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput;
}

async function stillAsking(service: InstanceType<typeof Service>, command: string): Promise<boolean> {
  const pending = Symbol('still asking');
  const outcome = await Promise.race([
    service.decideToolUse(bash(command), 'r1'),
    new Promise((resolve) => { setTimeout(() => resolve(pending), 150).unref(); }),
  ]);
  return outcome === pending;
}

function autoGrantOff(): () => void {
  mkdirSync(join(POLICY_PATH, '..'), { recursive: true });
  writeFileSync(POLICY_PATH, `${JSON.stringify({ autoApprove: false })}\n`, 'utf8');
  return () => rmSync(POLICY_PATH, { force: true });
}

/** The default wall and ask list, as a run with no carve-out holds them. */
const WALL = { deny: [...DEFAULT_DENY], ask: [...DEFAULT_ASK], allow: [] };

/** #189's command, in its shape: a handoff rewritten by a quoted python here-doc whose TEXT documents a push. */
const HANDOFF_HEREDOC = [
  "python3 - <<'EOF'",
  'import re',
  "p = 'docs/handoffs/ai-builder-v7/phase-04-release-0.md'",
  's = open(p).read()',
  "step = '4. Sync both run branches: `git fetch origin && git merge --no-edit origin/main && git push -u origin pe/ai-builder-v7`.'",
  "s = re.sub(r'## Outstanding\\n', '## Outstanding\\n' + step + '\\n', s)",
  "open(p, 'w').write(s)",
  'EOF',
].join('\n');

test('AJ-1 (#189): a quoted here-doc\'s body is data — the handoff-writing python here-doc raises no card under a deny-by-default row, and matches no publishing rule', async () => {
  for (const command of [
    HANDOFF_HEREDOC,
    HANDOFF_HEREDOC.replace("<<'EOF'", '<<"EOF"'),
    HANDOFF_HEREDOC.replace("<<'EOF'", '<<\\EOF'),
    "cat > docs/handoffs/x/phase-04.md <<'MD'\nResume: `git add -A && git commit -m wip && git push -u origin pe/x`; then `gh pr create --fill`.\nMD",
  ]) {
    assert.equal(publishingRule('Bash', { command }), null, `no publishing verb is RUN: ${command.slice(0, 40)}`);
    assert.ok(!bashSubjects(command).some((text) => /\bgit\s+push\b|\bgh\s+pr\b/.test(text)),
      `the body is not among the words a rule sees: ${JSON.stringify(bashSubjects(command))}`);
    assert.notEqual(classifyTool('Bash', { command }, WALL, 'trusted'), 'deny', 'the wall does not read data');
  }
  assert.deepEqual(executedTexts(readShell(HANDOFF_HEREDOC)), ['python3 -'], 'one command runs: the interpreter');

  // Through the hook, on the run #189 was raised under: no card, no wait.
  const restore = autoGrantOff();
  const { service, noted } = serviceOn({ ...CARVED, manifest: manifestOf(DENY_ROW) });
  try {
    const answer = reply(await service.decideToolUse(bash(HANDOFF_HEREDOC), 'r1'));
    assert.equal(answer.permissionDecision, 'allow', `answered at once: ${answer.permissionDecisionReason}`);
    assert.equal(service.approvals.pending().length, 0, 'no person\'s card for text inside a string');
    assert.equal(noted.filter((n) => n.event === 'phase.approval-reshaped').length, 0);
  } finally {
    service.approvals.disarm();
    service.close();
    restore();
  }
});

test('AJ-2 (#189): a -c/-e payload and a quoted argument are data and match no rule; a SHELL\'s -c payload is code, and the wall still sees it', () => {
  for (const command of [
    'python3 -c \'import subprocess; print("git push --force origin main && gh pr create --fill")\'',
    'node -e \'console.log("git push --force origin main; gh pr merge 3 --merge")\'',
    'echo "build && git push --force origin main"',
    "printf '%s\\n' 'git push -u origin pe/x' >> notes.md",
    'grep -n "git push --force" docs/handoffs/x/phase-04.md',
    'jq -r \'.steps[] | select(.cmd | test("git push"))\' plan.json',
  ]) {
    assert.equal(publishingRule('Bash', { command }), null, `data, not a command: ${command}`);
    assert.equal(matchedAskRule('Bash', { command }, WALL), null, `no ask rule matches data: ${command}`);
    assert.notEqual(classifyTool('Bash', { command }, WALL, 'trusted'), 'deny', `the wall does not read data: ${command}`);
  }
  // A shell's payload, an eval's words and a substitution are what the shell
  // runs — read as commands, so the wall is never weaker than the raw reading.
  for (const command of [
    "bash -c 'git push --force origin main'",
    'sh -c "cd sub && git push --force origin main"',
    'eval "git push --force origin main"',
    'echo "$(git push --force origin main)"',
    'FOO=1 git push --force origin main',
    'git -C sub -c core.x=1 push --force origin main',
    'sudo -u ops git push --force origin main',
  ]) {
    const carved = carvedPolicy(WALL as never, 'trusted', true);
    assert.equal(classifyTool('Bash', { command }, carved, 'trusted'), 'deny', `the force push is walled: ${command}`);
    assert.equal(publishingRule('Bash', { command }), 'Bash(git push:*)', `and it is a push: ${command}`);
  }
});

test('AJ-3 (#189): a push the shell runs inside a here-doc or an eval is said to be one — never "a substitution the row cannot vouch for"', async () => {
  const restore = autoGrantOff();
  const { service, noted, parked } = serviceOn({ ...CARVED, manifest: manifestOf(AB7_ROW) });
  try {
    // The row would answer the push bare: answered AT ONCE, saying where it hid.
    const atOnce: [string, RegExp][] = [
      ['cat <<EOF > notes.md\nrun $(git push -u origin pe/ai-builder-v7)\nEOF', /a push may be hidden in a heredoc/],
      ['python3 - <<EOF\nprint("`git push origin pe/ai-builder-v7`")\nEOF', /a push may be hidden in a heredoc/],
      ['bash <<EOF\ngit push origin $BRANCH\nEOF', /a push may be hidden in a heredoc/],
      ['eval "git push -u origin pe/ai-builder-v7"', /a push may be hidden in an `eval`/],
    ];
    for (const [command, why] of atOnce) {
      const answer = reply(await service.decideToolUse(bash(command), 'r1'));
      assert.equal(answer.permissionDecision, 'deny', `answered at once: ${command}`);
      assert.match(answer.permissionDecisionReason, why, command);
      assert.doesNotMatch(answer.permissionDecisionReason, /substitution the row cannot vouch for/);
      assert.match(answer.permissionDecisionReason, /Re-run `git push (?:-u )?origin pe\/ai-builder-v7` alone/, command);
    }
    assert.equal(noted.filter((n) => n.event === 'phase.approval-reshaped').length, atOnce.length);

    // What the judge cannot read at all — an `eval` of a value — is a card
    // that says so, because only a person can look inside the value.
    const hidden = 'PUSH="git push -u origin pe/ai-builder-v7"; eval "$PUSH"';
    assert.ok(await stillAsking(service, hidden), 'a push the judge cannot place is a person\'s card');
    const card = service.approvals.pending().find((a) => (a.tool?.input as { command?: string }).command === hidden);
    assert.ok(card, 'the card is up');
    assert.equal(card.manifest?.answer, null);
    assert.match(card.manifest?.why ?? '', /a push may be hidden in an `eval`/, `the card says where: ${card.manifest?.why}`);
    assert.deepEqual(parked, []);

    // An escaped substitution in an unquoted body is text; a variable in one
    // is text to `cat` — neither is a push.
    for (const command of [
      'cat <<EOF > notes.md\nrun \\$(git push -u origin pe/ai-builder-v7) later\nEOF',
      'cat <<EOF > notes.md\nthen git push origin $BRANCH\nEOF',
    ]) {
      assert.equal(publishingRule('Bash', { command }), null, `text, not a push: ${command}`);
    }
  } finally {
    service.approvals.disarm();
    service.close();
    restore();
  }
});

test('AJ-7 (#189): a here-doc OWNER that is a shell in a quoted or escaped spelling is still a shell — its body is code, and the wall sees the push', () => {
  // `"sh" <<EOF … EOF` runs the body as a script exactly as `sh <<EOF` does:
  // bash removes the quotes before it looks the command up. The code that
  // decides whether a body is CODE read the raw line with a regex, which a
  // quote or a backslash in the shell word defeated — so the body was called
  // data and a `git push --force` inside it sailed past the wall.
  const body = 'git push --force origin main';
  for (const owner of ['"sh"', "'sh'", '"bash"', 'b\\ash', 's""h', '/bin/"sh"', 'command "sh"', 'exec \\bash']) {
    const command = `${owner} <<EOF\n${body}\nEOF`;
    assert.ok(bashSubjects(command).some((text) => /\bgit\s+push\b/.test(text)),
      `the body is read as code: ${JSON.stringify(bashSubjects(command))}`);
    assert.equal(publishingRule('Bash', { command }), 'Bash(git push:*)', `and it is a push: ${owner}`);
    const carved = carvedPolicy(WALL as never, 'trusted', true);
    assert.equal(classifyTool('Bash', { command }, carved, 'trusted'), 'deny', `the force push is walled: ${owner}`);
  }
  // The far end of a quoted pipe is a shell too (`cat <<EOF | "sh"`).
  const piped = 'cat <<EOF | "sh"\ngit push --force origin main\nEOF';
  assert.equal(classifyTool('Bash', { command: piped }, carvedPolicy(WALL as never, 'trusted', true), 'trusted'), 'deny',
    'a push piped into a quoted shell is walled');

  // And the safe direction is unchanged: a DATA owner's body is still data.
  const data = 'cat <<EOF\ngit push --force origin main\nEOF';
  assert.ok(!bashSubjects(data).some((text) => /\bgit\s+push\b/.test(text)),
    `a cat here-doc body stays data: ${JSON.stringify(bashSubjects(data))}`);
});

test('AJ-8 (#189): a GLUED here-doc owner (no space before `<<`) never lets a push through — the boundary a later parity fix must keep', () => {
  // `cat<<EOF` is a here-doc in bash, but `splitStatements` detects a `<<`
  // only when a separator precedes it, so the glued body is read as top-level
  // COMMANDS instead of data. That is a parser-differential, but in the SAFE
  // direction: a push in the "body" is NAMED, not hidden. The dangerous case —
  // a glued SHELL owner (`sh<<EOF`) whose body bash really runs — must stay
  // walled too, and would NOT be if a future fix taught the splitter the glued
  // operator without also teaching `shellWords` to split it (today it does
  // not, so the quote-aware code check cannot see the `sh` in `sh<<EOF`). This
  // pins that boundary: whatever the parity fix, these never become `allow`.
  const carved = carvedPolicy(WALL as never, 'trusted', true);
  for (const command of [
    'sh<<EOF\ngit push --force origin main\nEOF',
    'bash<<EOF\ngit push --force origin main\nEOF',
    'cat<<EOF\ngit push --force origin main\nEOF',
  ]) {
    assert.equal(classifyTool('Bash', { command }, carved, 'trusted'), 'deny', `a glued here-doc push is walled: ${command}`);
  }
});
