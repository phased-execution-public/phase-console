/**
 * Approvals.
 *
 * The load-bearing fact here was measured, not read: Claude Code's `http`
 * PreToolUse hook **fails open**. A live session with nothing listening on the
 * hook URL ran its Bash call and created a file; the same session with a
 * `permissions.deny` rule was blocked twice and gave up. So these tests hold
 * the line between the two layers — the deny list is safety, the hook is
 * workflow — and fail loudly if anything dangerous drifts from one to the other.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-approvals-'));
process.env.XDG_STATE_HOME = STATE_HOME;
// Both, before anything is imported: the policy defaults resolve from
// XDG_CONFIG_HOME at module load, and a test that writes rules must never be
// able to reach the operator's own `~/.config/phase-console/autopilot.json`.
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');
process.env.PHASE_CONSOLE_LOG = '';

const {
  Approvals, buildSettings, writeSettingsFile, loadPolicy, classifyTool, ruleMatches,
  DEFAULT_DENY, DEFAULT_ASK, HOOK_TIMEOUT_SECONDS, RECOVERED_NOTE, TIMEOUT_REASON, UNANSWERABLE_REASONS,
  tokenFromSettingsFile,
} = await import('../server/runner/approvals.ts');
const { recent: recentLog } = await import('../server/log.ts');

/* ------------------------------------------------------------------ *
 * The two layers
 * ------------------------------------------------------------------ */

test('everything irreversible sits in deny, where it holds without the console', () => {
  const settings = buildSettings({ runId: 'r1', token: 't', origin: 'http://127.0.0.1:4123' });
  const deny = (settings.permissions as { deny: string[] }).deny;

  // These reach a remote or destroy something. The hook cannot be trusted to
  // stop them, because with the console down the hook does not run at all.
  for (const rule of ['Bash(git push:*)', 'Bash(terraform apply:*)', 'Bash(terraform destroy:*)', 'Bash(sudo:*)']) {
    assert.ok(deny.includes(rule), `${rule} must be denied outright, never merely asked`);
    assert.ok(!DEFAULT_ASK.includes(rule), `${rule} must not be approvable from a phone`);
  }
});

test('the ask list is never handed to the CLI — headless has nobody to ask', () => {
  // An `ask` rule in `-p` mode is a refusal with extra steps: there is no
  // terminal to prompt. A real run wrote its file, had the commit refused, and
  // sat waiting for a prompt that could never appear. Asking is the hook's job.
  const permissions = buildSettings({ runId: 'r1', token: 't', origin: 'http://x' }).permissions as Record<string, unknown>;
  assert.equal(permissions.ask, undefined);
  // allow does go, because it merges with the repository's rules rather than
  // replacing them — and a session that lost them to an untrusted workspace
  // still has to be able to read the files it was sent to work on.
  assert.ok(Array.isArray(permissions.allow) && permissions.allow.includes('Read'));
  assert.ok(Array.isArray(permissions.deny) && permissions.deny.length > 0);
  // The patterns still exist — they decide what becomes a card.
  assert.equal(classifyTool('Bash', { command: 'git commit -m x' }, loadPolicy('/nonexistent')), 'ask');
});

test('the hook is pointed at this console and given a bearer token', () => {
  const settings = buildSettings({ runId: 'r1', token: 'secret-token', origin: 'http://127.0.0.1:4123' });
  const entry = (settings.hooks as { PreToolUse: { matcher: string; hooks: Record<string, unknown>[] }[] }).PreToolUse[0];
  const hook = entry.hooks[0];
  assert.equal(hook.type, 'http');
  assert.equal(hook.url, 'http://127.0.0.1:4123/hooks/pre-tool-use');
  assert.deepEqual(hook.headers, { Authorization: 'Bearer secret-token' });
  assert.equal(hook.timeout, HOOK_TIMEOUT_SECONDS);
  // Matching every tool would put a network round trip in front of every Read.
  assert.match(entry.matcher, /Bash/);
  assert.ok(!/\bRead\b/.test(entry.matcher));
});

test('an operator policy adds rules but can never remove a default', () => {
  const file = join(STATE_HOME, 'autopilot.json');
  writeFileSync(file, JSON.stringify({ deny: ['Bash(task deploy:*)'], ask: ['Bash(make release:*)'] }));
  const policy = loadPolicy(file);
  assert.ok(policy.deny.includes('Bash(task deploy:*)'), 'a repo can add its own dangerous verbs');
  for (const rule of DEFAULT_DENY) assert.ok(policy.deny.includes(rule), `${rule} survived the merge`);
  for (const rule of DEFAULT_ASK) assert.ok(policy.ask.includes(rule), `${rule} survived the merge`);
});

test('a malformed policy file falls back to the defaults rather than to nothing', () => {
  const file = join(STATE_HOME, 'broken.json');
  writeFileSync(file, '{ not json');
  assert.deepEqual(loadPolicy(file).deny, DEFAULT_DENY);
  // A policy of `{"deny": "everything"}` is a string, not a list — ignoring the
  // whole file here would be safe; silently accepting it would not.
  writeFileSync(file, JSON.stringify({ deny: 'everything' }));
  assert.deepEqual(loadPolicy(file).deny, DEFAULT_DENY);
});

test('the settings file is not world-readable — it holds the run token', () => {
  const path = writeSettingsFile('r2', buildSettings({ runId: 'r2', token: 'shh', origin: 'http://x' }));
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  assert.match(readFileSync(path, 'utf8'), /shh/);
  // Rewriting an existing file must not leave a looser mode behind.
  writeSettingsFile('r2', buildSettings({ runId: 'r2', token: 'shh2', origin: 'http://x' }));
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

/* ------------------------------------------------------------------ *
 * Which calls are worth asking about
 * ------------------------------------------------------------------ */

const policy = { deny: DEFAULT_DENY, ask: DEFAULT_ASK, allow: [] };
const bash = (command: string) => classifyTool('Bash', { command }, policy);

test('ordinary work is allowed without troubling anyone', () => {
  // The first real run parked on `find docs -type f` and sat there. A queue
  // that fills with read-only listings is a queue nobody reads, and one nobody
  // reads trains the answer "yes".
  for (const command of [
    'find docs -type f',
    'grep -rn TODO src',
    'npm test',
    'pytest tests/unit -q',
    'git status --short',
    'git diff --stat',
    'cat README.md',
  ]) {
    assert.equal(bash(command), 'allow', command);
  }
  assert.equal(classifyTool('Read', { file_path: '/tmp/x' }, policy), 'allow');
});

test('the irreversible is denied outright, with no card offered', () => {
  for (const command of ['git push origin main', 'sudo rm -rf /x', 'terraform apply', 'npm publish']) {
    assert.equal(bash(command), 'deny', command);
  }
});

test('the in-between asks a person', () => {
  for (const command of ['git commit -m "wip"', 'npm install left-pad', 'ssh box uptime']) {
    assert.equal(bash(command), 'ask', command);
  }
  assert.equal(classifyTool('WebFetch', { url: 'https://example.com' }, policy), 'ask',
    'a bare tool name in the rules covers every use of it');
});

test('chaining does not smuggle a command past its rule', () => {
  // The hole a real run walked through: `git add x && git commit -m y` starts
  // with `git add`, so a prefix rule never sees the commit. The same shape
  // applies to the deny list, which is the part that actually matters.
  assert.equal(bash('git add notes/two.md && git commit -m "phase 2"'), 'ask');
  assert.equal(bash('cd /tmp && git push origin main'), 'deny');
  assert.equal(bash('npm test; sudo rm -rf /x'), 'deny');
  assert.equal(bash('echo hi | terraform apply'), 'deny');
  assert.equal(bash('(cd sub && npm publish)'), 'deny');
  // And a chain of harmless things is still harmless.
  assert.equal(bash('npm ci && npm test && npm run lint'), 'allow');
});

test('a rule matches on a prefix, not on the word appearing anywhere', () => {
  assert.equal(ruleMatches('Bash(git push:*)', 'Bash', { command: 'git push origin main' }), true);
  assert.equal(ruleMatches('Bash(git push:*)', 'Bash', { command: 'echo "git push" >> notes.md' }), false,
    'mentioning a command is not running it');
  assert.equal(ruleMatches('Bash(git push:*)', 'Write', { command: 'git push' }), false,
    'a Bash rule must not govern a Write');
});

/* ------------------------------------------------------------------ *
 * The token
 * ------------------------------------------------------------------ */

test('the hook endpoint rejects anything but this run\'s token', () => {
  const approvals = new Approvals();
  assert.equal(approvals.armed(), false);
  assert.equal(approvals.verify('Bearer anything'), false, 'nothing is accepted before a run arms one');

  const token = approvals.arm('run-1');
  assert.equal(approvals.verify(`Bearer ${token}`), true);
  assert.equal(approvals.verify(token), true, 'the scheme prefix is optional');
  assert.equal(approvals.verify('Bearer wrong'), false);
  assert.equal(approvals.verify(`Bearer ${token}x`), false);
  assert.equal(approvals.verify(undefined), false);

  approvals.disarm();
  assert.equal(approvals.verify(`Bearer ${token}`), false, 'the token dies with the run');
});

test('two runs never share a token, and each is only ever itself', () => {
  const approvals = new Approvals();
  const first = approvals.arm('run-1');
  const second = approvals.arm('run-2');
  assert.notEqual(first, second);

  // This used to assert that arming run-2 INVALIDATED run-1's token, which was
  // the right property while only one run could exist — a second `arm` then
  // always meant the first run was over. With a runner pool it means the
  // opposite: two runs are live, and retiring one of their tokens because the
  // other started would leave a working session's hook calls unauthorised —
  // which this hook reads as silence, and silence fails open.
  //
  // The property that actually mattered survives, and is stronger: a token
  // identifies exactly one run, and can never be mistaken for another's.
  assert.equal(approvals.runIdFor(`Bearer ${first}`), 'run-1');
  assert.equal(approvals.runIdFor(`Bearer ${second}`), 'run-2');
  approvals.disarm('run-1');
  assert.equal(approvals.verify(`Bearer ${first}`), false, "a retired run's token is dead");
  assert.equal(approvals.verify(`Bearer ${second}`), true, 'and its neighbour is untouched');
});

/* ------------------------------------------------------------------ *
 * Deciding
 * ------------------------------------------------------------------ */

function ask(approvals: InstanceType<typeof Approvals>, title = 'Bash: git commit -m wip') {
  return approvals.request({
    runId: 'run-1', slug: 'demo', phase: 2, kind: 'tool',
    title, detail: 'phase 2 wants to commit',
    evidence: [{ label: 'Working tree', body: ' M src/app.ts' }],
    tool: { name: 'Bash', input: { command: 'git commit -m wip' } },
  });
}

test('an approval waits for a person and reports who decided', async () => {
  const seen: string[] = [];
  const approvals = new Approvals((a) => seen.push(a.title));
  approvals.arm('run-1');

  const { approval, decided } = ask(approvals);
  assert.deepEqual(seen, ['Bash: git commit -m wip'], 'the notifier fires immediately, not after the decision');
  assert.equal(approvals.pending().length, 1);

  assert.equal(approvals.settle(approval.id, 'allow', 'phone'), true);
  const outcome = await decided;
  assert.equal(outcome.decision, 'allow');
  assert.equal(outcome.by, 'phone');
  assert.equal(approvals.pending().length, 0);
  assert.equal(approvals.recent().at(-1)?.status, 'allow');
});

test('deciding the same approval twice changes nothing', async () => {
  const approvals = new Approvals();
  approvals.arm('run-1');
  const { approval, decided } = ask(approvals);
  approvals.settle(approval.id, 'deny', 'console');
  assert.equal(approvals.settle(approval.id, 'allow', 'attacker'), false, 'a settled approval cannot be reopened');
  assert.equal((await decided).decision, 'deny');
});

test('ending a run denies whatever was still waiting, rather than hanging it', async () => {
  const approvals = new Approvals();
  approvals.arm('run-1');
  const { decided } = ask(approvals);
  approvals.disarm();
  const outcome = await decided;
  assert.equal(outcome.decision, 'deny');
  assert.match(outcome.reason!, /run ended/);
});

test('the card carries evidence, not just a yes/no', () => {
  const approvals = new Approvals();
  approvals.arm('run-1');
  const { approval } = ask(approvals);
  assert.ok(approval.evidence.length, 'a bare "allow this?" deletes the substance of approving');
  assert.equal(approval.tool!.name, 'Bash');
  assert.equal(approval.phase, 2);
  assert.ok(Date.parse(approval.expiresAt) > Date.parse(approval.createdAt));
});

test('the answer deadline lands before the hook gives up, not after', () => {
  // Our timeout must fire first. If the hook's own timeout wins, the call is
  // not denied — it falls through, because this hook fails open.
  const approvals = new Approvals();
  approvals.arm('run-1');
  const { approval } = ask(approvals);
  const ourDeadlineMs = Date.parse(approval.expiresAt) - Date.parse(approval.createdAt);
  assert.ok(
    ourDeadlineMs < HOOK_TIMEOUT_SECONDS * 1000,
    'answering after the hook has already given up is the same as not answering',
  );
});

/* ------------------------------------------------------------------ *
 * Surviving a restart
 * ------------------------------------------------------------------ */

test('a question nobody answered survives the console that was asking it — unanswerable with a reason, never expired (TRS-11)', () => {
  const dir = mkdtempSync(join(STATE_HOME, 'pending-a-'));
  const file = join(dir, 'pending.json');

  const first = new Approvals(() => {}, file);
  first.arm('run-1');
  ask(first);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 1, 'written while it is outstanding');

  // The console dies here. A new one starts and reads what was left.
  const second = new Approvals(() => {}, file);
  const recovered = second.all();
  assert.equal(recovered.length, 1, 'the question and its evidence are still here');
  assert.ok(recovered[0].evidence.length, 'including what a person would have needed to answer it');

  // Filed as a record until somebody can say which sessions survived: the
  // promise a decision would have resolved died with the process, and so did
  // the hook socket on the far end — an Allow button here would answer a void.
  assert.equal(recovered[0].status, 'unanswerable');
  assert.notEqual(recovered[0].status, 'expired');
  assert.equal(recovered[0].unanswerable?.reason, 'session-gone');
  assert.ok((UNANSWERABLE_REASONS as readonly string[]).includes(recovered[0].unanswerable!.reason), 'a machine-readable reason');
  assert.match(recovered[0].reason!, /console restarted/);
  assert.equal(second.pending().length, 0);
  assert.equal(second.settle(recovered[0].id, 'allow', 'me'), false);

  // A verdict names the truer reason; nothing it says makes the card answerable by accident.
  const tally = second.recover((cardSeen) => ({ unanswerable: cardSeen.kind === 'tool' ? 'token-lost' : 'asker-gone' }));
  assert.deepEqual(tally, { answerable: 0, unanswerable: { 'token-lost': 1 } });
  assert.equal(second.all()[0].unanswerable?.reason, 'token-lost');
  assert.equal(second.recover(() => ({ answerable: true })).answerable, 0, 'a card is judged once');

  // And it is not recovered a second time, forever.
  assert.equal(new Approvals(() => {}, file).all().length, 0);
});

test('ACC-8.10 (TRS-11): a recovered card whose run kept its token is answerable again — and the answer lands on the session\'s next identical call, once', async () => {
  const dir = mkdtempSync(join(STATE_HOME, 'pending-r-'));
  const file = join(dir, 'pending.json');
  const first = new Approvals(() => {}, file);
  first.arm('run-1');
  const { approval: original } = ask(first);

  const decided: { event: string; status: string; by?: string; recovered?: boolean }[] = [];
  const second = new Approvals({
    record: (event, approval) => decided.push({ event, status: approval.status, by: approval.decidedBy, recovered: Boolean(approval.recovered) }),
  }, file);
  const token = 'A'.repeat(43);
  assert.equal(second.adoptToken('run-1', 'not a token'), false, 'a malformed token is never armed');
  assert.equal(second.adoptToken('run-1', token), true);
  assert.equal(second.liveToken('run-1'), token, 'adopted, not minted');
  assert.equal(second.adoptToken('run-1', 'B'.repeat(43)), false, 'a different token never replaces one already armed');

  const tally = second.recover((cardSeen) => (second.liveToken(cardSeen.runId) ? { answerable: true } : { unanswerable: 'session-gone' }));
  assert.deepEqual(tally, { answerable: 1, unanswerable: {} });
  const restored = second.pending()[0];
  assert.equal(restored?.id, original.id);
  assert.equal(restored?.status, 'pending');
  assert.equal(restored?.recovered?.from, original.createdAt);
  assert.ok(restored?.detail.includes(RECOVERED_NOTE), 'it says what became of the call that raised it');
  assert.ok(Date.parse(restored!.expiresAt) > Date.now(), 'with a fresh answer window');

  assert.equal(second.settle(restored!.id, 'allow', 'phone'), true);
  assert.deepEqual(decided, [{ event: 'decided', status: 'allow', by: 'phone', recovered: true }], 'the ending is recorded like any other');
  const kept = second.takeRecoveredAnswer('run-1', 2, 'Bash', { command: 'git commit -m wip' });
  assert.equal(kept?.decision, 'allow');
  assert.equal(kept?.by, 'phone');
  assert.equal(second.takeRecoveredAnswer('run-1', 2, 'Bash', { command: 'git commit -m wip' }), null, 'one-shot — never a standing rule');
  assert.equal(second.takeRecoveredAnswer('run-1', 2, 'Bash', { command: 'git commit -m other' }), null, 'only for the exact call');
});

test('ACC-8.10 (TRS-7): a card that times out writes the SAME decision record a clicked one does — by timeout', async () => {
  const dir = mkdtempSync(join(STATE_HOME, 'pending-t-'));
  const file = join(dir, 'pending.json');
  const events: { event: string; id: string; status: string; by?: string }[] = [];
  const approvals = new Approvals({
    record: (event, approval) => events.push({ event, id: approval.id, status: approval.status, by: approval.decidedBy }),
  }, file);
  approvals.arm('run-1');
  const request = {
    runId: 'run-1', slug: 'demo', phase: 2, kind: 'tool' as const, title: 'Bash: psql', detail: 'd', evidence: [],
    tool: { name: 'Bash', input: { command: 'psql -c "select 1"' } },
  };
  // Each decision line is read the moment it is written: the log ring is shared
  // with every other test in this process, and an async neighbour can push an
  // older line out of it.
  // The NEWEST match: card ids are `<ms>-<counter>` per broker, and this file
  // builds many brokers, so an older test's card can share an id.
  const decisionLine = (id: string) =>
    recentLog(50).filter((entry) => entry.event === 'approval.decided' && entry.data?.id === id).at(-1);
  const clicked = approvals.request(request);
  approvals.settle(clicked.approval.id, 'deny', 'someone@desk', 'not now');
  const clickedLine = decisionLine(clicked.approval.id);
  assert.equal(clickedLine?.data?.by, 'someone@desk');
  const expired = approvals.request(request, 20);
  const outcome = await expired.decided;
  const expiredLine = decisionLine(expired.approval.id);
  assert.equal(outcome.by, 'timeout');
  assert.equal(outcome.reason, TIMEOUT_REASON);
  assert.doesNotMatch(TIMEOUT_REASON, /answer the card/, 'a settled card has no button left to press');

  assert.equal(expiredLine?.data?.by, 'timeout', 'the timeout writes its decision (it used to write nothing)');
  assert.equal(expiredLine?.data?.decision, 'deny');
  assert.deepEqual(Object.keys(expiredLine?.data ?? {}).sort(), Object.keys(clickedLine?.data ?? {}).sort(), 'one record shape for every ending');
  assert.deepEqual(
    events.map((e) => `${e.event}:${e.id === clicked.approval.id ? 'clicked' : 'expired'}:${e.status}:${e.by ?? ''}`),
    ['raised:clicked:pending:', 'decided:clicked:deny:someone@desk', 'raised:expired:pending:', 'decided:expired:deny:timeout'],
  );
});

test('ACC-8.7 (TRS-5): cards raised and auto-granted are counted per instance, since a date, across a restart', () => {
  const dir = mkdtempSync(join(STATE_HOME, 'counter-'));
  const file = join(dir, 'pending.json');
  const first = new Approvals(() => {}, file);
  const start = first.counts();
  assert.deepEqual({ raised: start.raised, autoGranted: start.autoGranted, lastRaisedAt: start.lastRaisedAt }, { raised: 0, autoGranted: 0, lastRaisedAt: null });
  first.arm('run-1');
  const { approval } = ask(first);
  first.settle(approval.id, 'allow', 'me');
  first.grant({ runId: 'run-1', slug: 'demo', phase: 2, kind: 'tool', title: 't', detail: 'd', evidence: [] }, 'auto-grant', 'auto-granted');
  const after = new Approvals(() => {}, file).counts();
  assert.equal(after.raised, 1);
  assert.equal(after.autoGranted, 1);
  assert.equal(after.since, start.since, 'the start date is kept, so "0 cards in N days" means N days');
  assert.equal(after.lastRaisedAt, approval.createdAt);
  assert.equal((statSync(join(dir, 'counter.json')).mode & 0o777).toString(8), '600');
});

test('TRS-11: the run token a settings file carries reads back exactly — what a restart adopts instead of minting', () => {
  const approvals = new Approvals();
  const token = approvals.arm('run-tok');
  const dir = mkdtempSync(join(STATE_HOME, 'settings-'));
  const path = join(dir, 'run-run-tok.json');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(buildSettings({ runId: 'run-tok', token, origin: 'http://127.0.0.1:1' })));
  assert.equal(tokenFromSettingsFile('run-tok', dir), token);
  assert.equal(tokenFromSettingsFile('no-such-run', dir), null);
  writeFileSync(join(dir, 'run-junk.json'), '{"hooks":{"PreToolUse":[{"hooks":[{"headers":{"Authorization":"Bearer short"}}]}]}}');
  assert.equal(tokenFromSettingsFile('junk', dir), null, 'only a token this console could have minted');
});

test('ACC-8.7 (TRS-5): through Service.announce, a raised tool card produces exactly ONE approval notification carrying Allow and Deny', async () => {
  const svc = await service();
  const notes: { category?: string }[] = [];
  svc.onEvent((name: string, data: unknown) => {
    if (name === 'notification') notes.push(data as { category?: string });
  });
  // The push itself, where the answer rides: `approvalId`, and the Allow/Deny
  // buttons with the token that makes them spendable.
  const pushed: { category: string; message: { approvalId?: string; actions?: { action: string }[]; callback?: unknown } }[] = [];
  (svc as unknown as { push: { announce: (...args: unknown[]) => void } }).push.announce = (category: unknown, message: unknown) => {
    pushed.push({ category: category as string, message: message as { approvalId?: string; actions?: { action: string }[] } });
  };
  const approval = card(svc, 'counted');
  assert.equal(notes.filter((note) => note.category === 'approval').length, 1, 'one raise, one notification record');
  const approvalPushes = pushed.filter((p) => p.category === 'approval');
  assert.equal(approvalPushes.length, 1, 'and one push');
  assert.equal(approvalPushes[0].message.approvalId, approval.id, 'the notification is the card\'s');
  assert.equal(approvalPushes[0].message.actions?.length, 2, 'Allow and Deny ride the notification itself');
  assert.ok(approvalPushes[0].message.callback, 'with the token that makes them spendable');
  assert.equal(svc.state().approvals?.raised, svc.approvals.counts().raised, '/api/state carries the counter');
  assert.equal(svc.state().approvals?.pending, 1);
  svc.approvals.settle(approval.id, 'deny', 'test');
  assert.equal(notes.filter((note) => note.category === 'approval').length, 1, 'answering it announces nothing more');
  svc.close();
});

test('an answered question leaves nothing outstanding on disk', () => {
  const file = join(STATE_HOME, 'pending-b.json');
  const approvals = new Approvals(() => {}, file);
  approvals.arm('run-1');
  const { approval } = ask(approvals);
  approvals.settle(approval.id, 'allow', 'me');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), []);
  assert.equal(new Approvals(() => {}, file).all().length, 0);
});

/* ------------------------------------------------------------------ *
 * The operator's own rules
 * ------------------------------------------------------------------ */

test('the policy file adds to the defaults and can never subtract from them', async () => {
  const { policyExtras, addPolicyRules } = await import('../server/runner/approvals.ts');
  const file = join(STATE_HOME, 'autopilot.json');

  // A policy file that forgot `git push` must not quietly become one that
  // permits it, so the merge is one-way by construction.
  writeFileSync(file, JSON.stringify({ deny: [], ask: [], allow: [] }));
  assert.ok(loadPolicy(file).deny.includes('Bash(git push:*)'));

  addPolicyRules({ deny: ['Bash(task deploy:*)'], ask: ['Bash(make release:*)'] }, file);
  const merged = loadPolicy(file);
  assert.ok(merged.deny.includes('Bash(task deploy:*)'), 'the operator rule is in force');
  assert.ok(merged.deny.includes('Bash(git push:*)'), 'and every default still is');
  assert.ok(merged.ask.includes('Bash(make release:*)'));

  // Added to, never replaced — a second call keeps the first.
  addPolicyRules({ deny: ['Bash(kubectl drain:*)'] }, file);
  const extras = policyExtras(file);
  assert.deepEqual(extras.deny, ['Bash(task deploy:*)', 'Bash(kubectl drain:*)']);
  assert.deepEqual(extras.ask, ['Bash(make release:*)']);
  assert.deepEqual(extras.allow, [], 'nothing widened what a session may do');
});

test('a malformed rule is dropped rather than written into the policy', async () => {
  const { addPolicyRules } = await import('../server/runner/approvals.ts');
  const file = join(STATE_HOME, 'autopilot-junk.json');
  const written = addPolicyRules({
    deny: ['Bash(ok:*)', '', '   ', 'not a rule at all', '../../etc/passwd', 'x'.repeat(300)],
  }, file);
  assert.deepEqual(written.deny, ['Bash(ok:*)']);
});

test('WebSearch is asked about, like the sibling it was always shown beside', () => {
  // The PreToolUse matcher has always covered WebSearch. The ask list did not,
  // so it was silently auto-allowed while WebFetch raised a card.
  const settings = buildSettings({ runId: 'r', token: 't', origin: 'http://127.0.0.1:4123' });
  const matcher = ((settings.hooks as { PreToolUse: { matcher: string }[] }).PreToolUse)[0].matcher;
  assert.match(matcher, /WebSearch/);
  assert.ok(DEFAULT_ASK.includes('WebSearch'));
  assert.equal(classifyTool('WebSearch', { query: 'anything' }, loadPolicy('/nowhere')), 'ask');
});

/* ------------------------------------------------------------------ *
 * The rule taxonomy
 *
 * One example of every documented form, because a rule that parses and does
 * not match is indistinguishable from a rule that was never written — and the
 * whole point of the editor is that people can trust what they typed.
 * ------------------------------------------------------------------ */

test('every documented rule form returns the documented verdict', async () => {
  const { ruleMatches: matches } = await import('../server/runner/approvals.ts');
  const home = '/home/tester';
  const hit = (rule: string, tool: string, input: unknown) =>
    assert.equal(matches(rule, tool, input, home), true, `${rule} should match`);
  const miss = (rule: string, tool: string, input: unknown) =>
    assert.equal(matches(rule, tool, input, home), false, `${rule} should NOT match`);

  // Bare tool / Tool(*)
  hit('Bash', 'Bash', { command: 'anything at all' });
  hit('WebFetch(*)', 'WebFetch', { url: 'https://example.com' });
  miss('Bash', 'Write', { file_path: '/tmp/x' });

  // Bash globs. The space is load-bearing: `ls *` is not `ls*`.
  hit('Bash(npm run build)', 'Bash', { command: 'npm run build' });
  hit('Bash(npm run test *)', 'Bash', { command: 'npm run test --watch' });
  hit('Bash(* install)', 'Bash', { command: 'npm install' });
  hit('Bash(git * main)', 'Bash', { command: 'git rebase main' });
  hit('Bash(ls:*)', 'Bash', { command: 'ls -la' });
  hit('Bash(ls *)', 'Bash', { command: 'ls -la' });
  miss('Bash(ls:*)', 'Bash', { command: 'lsof -i' });
  miss('Bash(ls *)', 'Bash', { command: 'lsof -i' });
  hit('Bash(ls*)', 'Bash', { command: 'lsof -i' });

  // Parameter match — one parameter, `*` allowed in the value.
  hit('Agent(model:opus)', 'Agent', { model: 'opus', subagent_type: 'Explore' });
  hit('Agent(isolation:worktree)', 'Agent', { isolation: 'worktree' });
  hit('Bash(run_in_background:true)', 'Bash', { command: 'sleep 1', run_in_background: true });
  miss('Bash(run_in_background:true)', 'Bash', { command: 'sleep 1' });

  // Tool-name globs.
  hit('*', 'Bash', { command: 'anything' });
  hit('mcp__*', 'mcp__github__create_issue', {});

  // Read/Edit paths. A bare name means anywhere, which is what protects .env.
  hit('Read(.env)', 'Read', { file_path: '/srv/app/.env' });
  hit('Read(//etc/passwd)', 'Read', { file_path: '/etc/passwd' });
  hit('Read(~/notes/today.md)', 'Read', { file_path: `${home}/notes/today.md` });
  hit('Edit(./src/index.ts)', 'Edit', { file_path: '/repo/src/index.ts' });
  miss('Read(~/notes/*)', 'Read', { file_path: `${home}/notes/deep/one.md` });
  hit('Read(~/notes/**)', 'Read', { file_path: `${home}/notes/deep/one.md` });

  // WebFetch domains.
  hit('WebFetch(domain:example.com)', 'WebFetch', { url: 'https://example.com/a' });
  hit('WebFetch(domain:*.example.com)', 'WebFetch', { url: 'https://api.example.com/a' });
  hit('WebFetch(domain:*)', 'WebFetch', { url: 'https://anywhere.test/a' });
  miss('WebFetch(domain:example.com)', 'WebFetch', { url: 'https://evil.test/a' });

  // MCP.
  hit('mcp__server', 'mcp__server__tool', {});
  hit('mcp__server__*', 'mcp__server__tool', {});
  hit('mcp__server__tool', 'mcp__server__tool', {});
  miss('mcp__server', 'mcp__other__tool', {});

  // Agent types and Cd.
  hit('Agent(Explore)', 'Agent', { subagent_type: 'Explore' });
  hit('Agent(my-custom-agent)', 'Agent', { subagent_type: 'my-custom-agent' });
  miss('Agent(Explore)', 'Agent', { subagent_type: 'Plan' });
  hit('Cd(~/code/*)', 'Cd', { path: `${home}/code/app` });
  miss('Cd(~/code/*)', 'Cd', { path: `${home}/code/app/src` });
  hit('Cd(~/code/**)', 'Cd', { path: `${home}/code/app/src` });
  hit('Cd(**/node_modules)', 'Cd', { path: '/repo/a/node_modules' });
});

test('the rules that parse and do nothing are named, not silently dropped', async () => {
  const { parseRule, inertRules, ruleMatches: matches } = await import('../server/runner/approvals.ts');

  // The documented trap: it reads like a parameter rule and Claude Code drops it.
  assert.equal(parseRule('Bash(command:rm *)')?.support, 'ignored');
  assert.equal(matches('Bash(command:rm *)', 'Bash', { command: 'rm -rf /' }), false);

  // Only Read(…) and Edit(…) path rules are consulted.
  for (const rule of ['Write(/etc/*)', 'NotebookEdit(~/nb.ipynb)', 'Glob(src/**)']) {
    assert.equal(parseRule(rule)?.support, 'ignored', `${rule} is not consulted`);
  }
  assert.equal(parseRule('Edit(src/**)')?.support, 'hook');

  const inert = inertRules({ deny: ['Bash(command:rm *)'], ask: ['Write(/etc/*)'], allow: ['Bash(ok:*)'] });
  assert.deepEqual(inert.map((r) => r.raw), ['Bash(command:rm *)', 'Write(/etc/*)']);
  for (const rule of inert) assert.ok(rule.note, 'each says why it does nothing');
});

test('a rule about a tool the hook never sees is labelled, not pretended about', async () => {
  const { parseRule, HOOK_TOOLS } = await import('../server/runner/approvals.ts');
  // The PreToolUse matcher covers these, so a rule about them is enforced here.
  for (const tool of HOOK_TOOLS) assert.equal(parseRule(tool)?.support, 'hook', tool);
  // These are real rules the CLI enforces — this console just never sees them,
  // and claiming otherwise would be the lie that costs someone an afternoon.
  for (const rule of ['Read', 'Agent(Explore)', 'Cd(~/code/**)', 'mcp__server']) {
    assert.equal(parseRule(rule)?.support, 'cli-only', rule);
  }
});

test('TRS-12: an empty prefix and a tool the CLI does not provide are inert, and the editor refuses them', async () => {
  const { parseRule, inertRules, editPolicy, PolicyRuleError, loadPolicyFor, ruleMatches: matches } =
    await import('../server/runner/approvals.ts');
  // `Bash(:*)` tests `subject === '' || subject.startsWith(' ')` — no real
  // command satisfies it — and `git(:*)` names a COMMAND where a tool goes.
  // Both parsed as `hook`/`cli-only` and the live policy showed `inert: []`
  // with both under `always`.
  assert.equal(parseRule('Bash(:*)')?.support, 'ignored');
  assert.match(parseRule('Bash(:*)')?.note ?? '', /empty prefix/);
  assert.equal(parseRule('git(:*)')?.support, 'ignored');
  assert.match(parseRule('git(:*)')?.note ?? '', /not a tool Claude Code provides/);
  assert.equal(parseRule('npm')?.support, 'ignored', 'a bare command name is not a tool either');
  assert.equal(matches('Bash(:*)', 'Bash', { command: 'git status' }), false);
  const inert = inertRules({ deny: [], ask: [], allow: ['Bash(:*)', 'git(:*)'] });
  assert.deepEqual(inert.map((r) => r.raw), ['Bash(:*)', 'git(:*)']);

  // A tool this console has SEEN a session offer is real whatever the shipped
  // list says; an unseen Pascal-case name is the CLI's to judge, marked as
  // unseen rather than refused — a newer CLI must not be un-rulable.
  assert.equal(parseRule('Frobnicate(run:*)')?.support, 'cli-only');
  assert.match(parseRule('Frobnicate(run:*)')?.note ?? '', /no session on this console has offered/);
  assert.doesNotMatch(parseRule('Frobnicate(run:*)', new Set(['Frobnicate']))?.note ?? '', /no session/);
  assert.deepEqual(inertRules({ deny: ['Frobnicate(run:*)'], ask: [], allow: [] }), []);

  // The editor refuses what would never match, naming each; nothing is written.
  const dir = mkdtempSync(join(tmpdir(), 'pc-inert-edit-'));
  const globalFile = join(dir, 'autopilot.json');
  assert.throws(
    () => editPolicy({ add: { allow: ['Bash(:*)', 'git(:*)'] }, by: 'tester' }, globalFile),
    (error: unknown) => error instanceof PolicyRuleError
      && error.rules.map((r) => r.raw).join(',') === 'Bash(:*),git(:*)'
      && /would never match/.test(error.message),
  );
  assert.ok(!loadPolicyFor(null, globalFile, dir).allow.includes('Bash(:*)'));
  // …while junk the syntax rejects is still dropped, as the earlier case pins.
  editPolicy({ add: { deny: ['Bash(git push:*)', 'not a rule ('] }, by: 'tester' }, globalFile);
  assert.ok(loadPolicyFor(null, globalFile, dir).deny.includes('Bash(git push:*)'));
  rmSync(dir, { recursive: true, force: true });
});

test('TRS-9: an empty ask list and a struck deny rule each raise a named advisory over the merge', async () => {
  const { editPolicy, loadPolicyFor, struckFor, policyAdvisory, DEFAULT_ASK: ASK, DEFAULT_DENY: DENY } =
    await import('../server/runner/approvals.ts');
  const dir = mkdtempSync(join(tmpdir(), 'pc-advisory-'));
  const globalFile = join(dir, 'autopilot.json');

  // Stock: nothing to say.
  assert.deepEqual(policyAdvisory(loadPolicyFor(null, globalFile, dir), struckFor(null, globalFile, dir)), []);

  // Every shipped ask rule struck: the merged ask list is empty, and no
  // profile asks about anything — the live state on 4130 the audit measured.
  editPolicy({ remove: { ask: [...ASK] }, by: 'tester' }, globalFile);
  let advisory = policyAdvisory(loadPolicyFor(null, globalFile, dir), struckFor(null, globalFile, dir));
  assert.deepEqual(advisory.map((a) => a.kind), ['ask-empty']);
  assert.deepEqual(advisory[0].rules, [...ASK]);
  assert.match(advisory[0].message, /Guarded and Trusted are the same posture/);

  // One shipped deny rule struck: the wall that holds with the console dead moved.
  editPolicy({ remove: { deny: [DENY[0]] }, by: 'tester' }, globalFile);
  advisory = policyAdvisory(loadPolicyFor(null, globalFile, dir), struckFor(null, globalFile, dir));
  assert.deepEqual(advisory.map((a) => a.kind), ['ask-empty', 'deny-struck']);
  assert.deepEqual(advisory[1].rules, [DENY[0]]);
  assert.ok(advisory[1].message.includes(DENY[0]));

  // An operator's own ask rule refills the list; the struck deny still stands.
  editPolicy({ add: { ask: ['Bash(terraform plan:*)'] }, by: 'tester' }, globalFile);
  advisory = policyAdvisory(loadPolicyFor(null, globalFile, dir), struckFor(null, globalFile, dir));
  assert.deepEqual(advisory.map((a) => a.kind), ['deny-struck']);
  rmSync(dir, { recursive: true, force: true });
});

test('a wrapped command is still the command it wraps', async () => {
  const { commandSegments, stripWrappers } = await import('../server/runner/approvals.ts');
  const policyNow = { deny: DEFAULT_DENY, ask: DEFAULT_ASK, allow: [] };
  const bashNow = (command: string) => classifyTool('Bash', { command }, policyNow);

  // `nohup git push` reaches a remote exactly as `git push` does.
  assert.equal(bashNow('nohup git push origin main'), 'deny');
  assert.equal(bashNow('timeout 30s git push origin main'), 'deny');
  assert.equal(bashNow('nice -n 5 npm publish'), 'deny');
  assert.equal(bashNow('xargs rm'), 'allow', 'bare xargs is seen through, and rm is on no list here');
  assert.ok(commandSegments('nohup git push').includes('git push'));
  assert.equal(stripWrappers('git push'), null, 'nothing to peel is not an empty command');

  // And the documented edges, which nothing here can see through: a rule about
  // what these run will not fire, so the console says so rather than implying
  // a protection it does not have.
  assert.equal(stripWrappers('npx some-publisher'), null);
  assert.equal(stripWrappers('docker exec box git push'), null);
});

test('what a wrapper hides never auto-approves', async () => {
  const { neverAutoApproves } = await import('../server/runner/approvals.ts');
  const policyNow = { deny: DEFAULT_DENY, ask: DEFAULT_ASK, allow: [] };
  const bashNow = (command: string) => classifyTool('Bash', { command }, policyNow);

  for (const command of [
    'watch -n5 ./collect.sh',
    'setsid ./daemon.sh',
    'flock /tmp/l ./job.sh',
    'find . -name "*.tmp" -exec ./clean.sh {} ;',
  ]) {
    assert.ok(neverAutoApproves(command), command);
    assert.equal(bashNow(command), 'ask', `${command} gets a person, not a default yes`);
  }
  assert.equal(neverAutoApproves('git status'), false);
});

test('a wrapper asks under guarded and runs under the profiles that said stop asking', async () => {
  // The "The user doesn't want to proceed with this tool use" reports, at their
  // cause. `profilePolicy` empties the ask list for trusted and bypass, and
  // this fallback sat below it answering 'ask' in every profile — so a bypass
  // run, where by definition nobody is watching, raised a card, waited out the
  // hook's full hour, and timed out into a deny. The CLI renders that deny with
  // its own canned human-rejection wording, so standing configuration read as a
  // person refusing the work, and the run parked.
  const { profilePolicy } = await import('../server/runner/approvals.ts');
  const base = loadPolicy('/nowhere');
  const wrapped = 'flock /tmp/l ./job.sh';

  assert.equal(
    classifyTool('Bash', { command: wrapped }, profilePolicy(base, 'guarded'), 'guarded'), 'ask',
    'guarded still gets a person for a command whose real payload is hidden',
  );
  for (const profile of ['trusted', 'bypass'] as const) {
    assert.equal(
      classifyTool('Bash', { command: wrapped }, profilePolicy(base, profile), profile), 'allow',
      `${profile} asked this console to stop asking, and that has to reach here too`,
    );
    // The wall is not a preference, and no profile moves it — a wrapper around
    // something on the deny list is still denied.
    assert.equal(
      classifyTool('Bash', { command: 'flock /tmp/l git push origin main' },
        profilePolicy(base, profile), profile), 'deny',
      `${profile} must not reach a remote by hiding it inside a wrapper`,
    );
  }

  // Unstated means guarded: every caller that predates the profile argument
  // keeps the behaviour it had, which is the conservative one.
  assert.equal(classifyTool('Bash', { command: wrapped }, base), 'ask');
});

test('a denial names the rule that made it, so it can be argued with', async () => {
  const { matchedDenyRule } = await import('../server/runner/approvals.ts');
  const base = loadPolicy('/nowhere');

  const rule = matchedDenyRule('Bash', { command: 'git push origin main' }, base);
  assert.ok(rule, 'a denied command must be able to say which line stopped it');
  assert.match(String(rule), /push/, 'and the rule it names is the one about pushing');
  assert.equal(matchedDenyRule('Bash', { command: 'git status' }, base), null,
    'nothing to name when nothing denied it');
});

/* ------------------------------------------------------------------ *
 * Profiles
 * ------------------------------------------------------------------ */

test('only the bypass profile keeps bypassPermissions in the child argv', async () => {
  const { buildArgv, sanitize } = await import('../server/runner/spawn.ts');
  const mode = (argv: string[]) => argv[argv.indexOf('--permission-mode') + 1];

  assert.equal(mode(buildArgv({ prompt: 'p', cwd: '/tmp' })), 'acceptEdits', 'the default is unchanged');
  assert.equal(mode(buildArgv({ prompt: 'p', cwd: '/tmp', permissionProfile: 'guarded' })), 'acceptEdits');
  assert.equal(mode(buildArgv({ prompt: 'p', cwd: '/tmp', permissionProfile: 'trusted' })), 'acceptEdits',
    'trusted empties the ask list — it does not take the CLI’s own guard off');
  assert.equal(mode(buildArgv({ prompt: 'p', cwd: '/tmp', permissionProfile: 'bypass' })), 'bypassPermissions');

  // The rewrite still fires for anyone who simply asks for it. Choosing the
  // profile is the only way through, which is what makes it auditable.
  assert.deepEqual(
    sanitize(['--permission-mode', 'bypassPermissions']),
    ['--permission-mode', 'acceptEdits'],
  );
  assert.deepEqual(
    sanitize(['--permission-mode', 'bypassPermissions'], { allowBypass: true }),
    ['--permission-mode', 'bypassPermissions'],
  );
  // And the flags that disable the repository's own hooks are not unlockable
  // by any profile — those are not a preference anyone gets.
  assert.deepEqual(sanitize(['--bare', '--safe-mode', '--model', 'x'], { allowBypass: true }), ['--model', 'x']);
});

test('trusted skips the ask list and keeps the wall', async () => {
  const { profilePolicy } = await import('../server/runner/approvals.ts');
  const base = loadPolicy('/nowhere');

  for (const profile of ['trusted', 'bypass'] as const) {
    const policyNow = profilePolicy(base, profile);
    assert.equal(classifyTool('Bash', { command: 'git commit -m x' }, policyNow), 'allow',
      `${profile} commits without a card — the interrogation this phase exists to end`);
    assert.equal(classifyTool('Bash', { command: 'npm install left-pad' }, policyNow), 'allow');
    assert.equal(classifyTool('Bash', { command: 'git push origin main' }, policyNow), 'deny',
      `${profile} must not be able to reach a remote`);
    assert.equal(classifyTool('Bash', { command: 'sudo rm -rf /x' }, policyNow), 'deny');
    assert.deepEqual(policyNow.deny, base.deny, 'the wall is identical in every profile');
  }

  // Guarded is exactly what it always was.
  assert.equal(classifyTool('Bash', { command: 'git commit -m x' }, profilePolicy(base, 'guarded')), 'ask');
});

test('the settings a trusted run is given still carry the whole deny list', async () => {
  const settings = buildSettings({
    runId: 'r', token: 't', origin: 'http://127.0.0.1:4123', profile: 'trusted',
  });
  const permissions = settings.permissions as { deny: string[]; ask?: string[] };
  assert.equal(permissions.ask, undefined);
  for (const rule of DEFAULT_DENY) assert.ok(permissions.deny.includes(rule), rule);
});

/* ------------------------------------------------------------------ *
 * Scopes: one plan, or everywhere
 * ------------------------------------------------------------------ */

test('a plan-scoped rule applies to that plan and to nothing else', async () => {
  const { editPolicy, loadPolicyFor, planPolicyPath } = await import('../server/runner/approvals.ts');
  const dir = mkdtempSync(join(tmpdir(), 'pc-scope-'));
  const globalFile = join(dir, 'autopilot.json');

  editPolicy({ add: { allow: ['Bash(task deploy:*)'] }, by: 'tester' }, planPolicyPath('alpha', dir));

  const alpha = loadPolicyFor('alpha', globalFile, dir);
  const beta = loadPolicyFor('beta', globalFile, dir);
  assert.ok(alpha.allow.includes('Bash(task deploy:*)'));
  assert.ok(!beta.allow.includes('Bash(task deploy:*)'), 'another plan is untouched');
  assert.ok(!loadPolicyFor(null, globalFile, dir).allow.includes('Bash(task deploy:*)'));

  // And it survives a reload, because it is a file and not a session's memory.
  assert.ok(loadPolicyFor('alpha', globalFile, dir).allow.includes('Bash(task deploy:*)'));

  // A slug decides a filename and nothing else.
  assert.ok(!planPolicyPath('../../etc/passwd', dir).includes('..'));
  rmSync(dir, { recursive: true, force: true });
});

test('a rule you wrote outranks the ask list; a shipped allow does not', async () => {
  const { editPolicy, loadPolicyFor } = await import('../server/runner/approvals.ts');
  const dir = mkdtempSync(join(tmpdir(), 'pc-always-'));
  const globalFile = join(dir, 'autopilot.json');

  // Before: `git commit` is on the ask list and stops the run.
  assert.equal(
    classifyTool('Bash', { command: 'git commit -m x' }, loadPolicyFor(null, globalFile, dir)),
    'ask',
  );

  // "Always allow this" writes the rule the card derived from the ask rule that
  // stopped it. Evaluation is deny → ask → allow with first match winning, so
  // an ordinary allow rule could never cancel it — which would make the button
  // write a rule and change nothing.
  editPolicy({ add: { allow: ['Bash(git commit:*)'] }, by: 'tester' }, globalFile);
  const after = loadPolicyFor(null, globalFile, dir);
  assert.deepEqual(after.always, ['Bash(git commit:*)']);
  assert.equal(classifyTool('Bash', { command: 'git commit -m x' }, after), 'allow');

  // The wall is still the wall.
  editPolicy({ add: { allow: ['Bash(git push:*)'] }, by: 'tester' }, globalFile);
  assert.equal(
    classifyTool('Bash', { command: 'git push origin main' }, loadPolicyFor(null, globalFile, dir)),
    'deny',
    'no rule anyone can write from a browser gets past deny',
  );
  rmSync(dir, { recursive: true, force: true });
});

test('a rule can be removed again, and only the ones you added', async () => {
  const { editPolicy, policyExtras, loadPolicy: load } = await import('../server/runner/approvals.ts');
  const file = join(STATE_HOME, 'autopilot-remove.json');

  editPolicy({ add: { ask: ['Bash(make release:*)', 'Bash(task ship:*)'] }, by: 'tester' }, file);
  assert.deepEqual(policyExtras(file).ask, ['Bash(make release:*)', 'Bash(task ship:*)']);

  editPolicy({ remove: { ask: ['Bash(make release:*)'] }, by: 'tester' }, file);
  assert.deepEqual(policyExtras(file).ask, ['Bash(task ship:*)'], 'and it survives the reload');

  // A shipped default has no file line to delete, so the same gesture records
  // a STRIKE — the wall is edited by name now, exactly like ask and allow.
  editPolicy({ remove: { deny: ['Bash(git push:*)'] }, by: 'tester' }, file);
  assert.ok(!load(file).deny.includes('Bash(git push:*)'), 'the struck rule left the wall');
  assert.deepEqual(policyExtras(file).removed.deny, ['Bash(git push:*)'],
    'recorded by name, so every default it does not name keeps applying');
});

test('the rule a card offers is the one that stopped the call', async () => {
  const { suggestedRule } = await import('../server/runner/approvals.ts');
  const policyNow = loadPolicy('/nowhere');

  // Derived from the matched ask rule, so accepting it cancels exactly the
  // thing that interrupted — not a guess that happens to look similar.
  assert.equal(suggestedRule('Bash', { command: 'git commit -m "wip"' }, policyNow), 'Bash(git commit:*)');
  assert.equal(suggestedRule('Bash', { command: 'git add x && git commit -m y' }, policyNow), 'Bash(git commit:*)');
  assert.equal(suggestedRule('WebFetch', { url: 'https://example.com' }, policyNow), 'WebFetch');
  // Nothing matched: the narrowest honest guess, never a bare `Bash`.
  assert.equal(suggestedRule('Bash', { command: 'task deploy --now' }, { deny: [], ask: [], allow: [] }),
    'Bash(task deploy:*)');
});

/* ------------------------------------------------------------------ *
 * Answering a card, and remembering the answer
 * ------------------------------------------------------------------ */

/** A Service with nowhere to write but the redirected config home. */
async function service() {
  const { Service } = await import('../server/service.ts');
  const { SKILL_DIR } = await import('../server/config.ts');
  return new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
}

function card(svc: Awaited<ReturnType<typeof service>>, slug: string) {
  const { approval } = svc.approvals.request({
    runId: 'r1', slug, phase: 2, kind: 'tool',
    title: 'Bash: git commit -m x', detail: 'wants to commit', evidence: [],
    tool: { name: 'Bash', input: { command: 'git commit -m x' } },
    suggestedRule: 'Bash(git commit:*)',
  });
  return approval;
}

test('"Always for this plan" writes a rule that plan only, and answers the card', async () => {
  const { loadPolicyFor, policyExtras, planPolicyPath } = await import('../server/runner/approvals.ts');
  const svc = await service();
  const approval = card(svc, 'alpha');

  const result = svc.decideApproval(approval.id, 'allow', 'someone@desk', undefined, {
    scope: 'plan', rule: 'Bash(git commit:*)',
  });

  assert.equal(result.ok, true);
  assert.equal(result.wrote, 'Bash(git commit:*)', 'the exact rule is reported back, not assumed');
  assert.equal(result.scope, 'plan');
  assert.equal(approval.status, 'allow', 'the card is answered, not merely remembered');
  assert.equal(approval.decidedBy, 'someone@desk');

  assert.deepEqual(policyExtras(planPolicyPath('alpha')).allow, ['Bash(git commit:*)']);
  assert.equal(classifyTool('Bash', { command: 'git commit -m y' }, loadPolicyFor('alpha')), 'allow');
  assert.equal(classifyTool('Bash', { command: 'git commit -m y' }, loadPolicyFor('beta')), 'ask',
    'another plan still asks — that is what "for this plan" has to mean');
});

test('"Always everywhere" writes to the global policy', async () => {
  const { loadPolicyFor, policyExtras, POLICY_PATH } = await import('../server/runner/approvals.ts');
  const svc = await service();
  const approval = card(svc, 'gamma');

  const result = svc.decideApproval(approval.id, 'allow', 'someone@desk', undefined, {
    scope: 'global', rule: 'Bash(npm install:*)',
  });

  assert.equal(result.scope, 'global');
  assert.ok(policyExtras(POLICY_PATH).allow.includes('Bash(npm install:*)'));
  // Every plan, including ones that have no file of their own.
  for (const slug of ['gamma', 'delta', null]) {
    assert.equal(classifyTool('Bash', { command: 'npm install left-pad' }, loadPolicyFor(slug)), 'allow', String(slug));
  }
});

test('a rule that will not parse is refused, and the card is still answered', async () => {
  const svc = await service();
  const approval = card(svc, 'alpha');

  // The decision about *this* call stands on its own. Swallowing it because
  // the remembering failed would lose the half that unblocks the session.
  const result = svc.decideApproval(approval.id, 'allow', 'someone@desk', undefined, {
    scope: 'global', rule: 'not a rule at all',
  });

  assert.equal(result.ok, true);
  assert.equal(approval.status, 'allow');
  assert.equal(result.wrote, undefined, 'nothing was written');
  assert.match(result.error!, /not a rule/);
});

test('a card decided without remembering writes no rule at all', async () => {
  const { policyExtras, POLICY_PATH } = await import('../server/runner/approvals.ts');
  const svc = await service();
  const before = policyExtras(POLICY_PATH).allow.length;
  const approval = card(svc, 'alpha');

  const result = svc.decideApproval(approval.id, 'deny', 'someone@desk', 'not now');
  assert.equal(result.ok, true);
  assert.equal(result.wrote, undefined);
  assert.equal(approval.status, 'deny');
  assert.equal(policyExtras(POLICY_PATH).allow.length, before);
});

/* ------------------------------------------------------------------ *
 * Reaching someone who is not looking at a tab
 * ------------------------------------------------------------------ */

test('the out-of-band notifier is environment-only, and never breaks a run', async () => {
  const { notifyOutOfBand } = await import('../server/runner/approvals.ts');
  // No command configured is the normal case and must be silent.
  assert.doesNotThrow(() => notifyOutOfBand('t', 'b', {} as NodeJS.ProcessEnv));
  // A command that does not exist must not propagate — a broken notifier
  // stopping a run would be worse than no notifier at all.
  assert.doesNotThrow(() =>
    notifyOutOfBand('t', 'b', { PHASE_CONSOLE_NOTIFY: '/nonexistent/notifier' } as NodeJS.ProcessEnv));
});

/* ------------------------------------------------------------------ *
 * Two runs, one hook endpoint
 * ------------------------------------------------------------------ */

test('two armed runs each verify as themselves, and neither is mistaken for the other', () => {
  const broker = new Approvals({}, join(STATE_HOME, 'two-runs.json'));
  const a = broker.arm('run-a');
  const b = broker.arm('run-b');

  assert.notEqual(a, b, 'a shared token would make the runs indistinguishable');
  assert.equal(broker.runIdFor(`Bearer ${a}`), 'run-a');
  assert.equal(broker.runIdFor(`Bearer ${b}`), 'run-b');
  assert.equal(broker.runIdFor('Bearer not-a-token'), null);
  assert.equal(broker.runIdFor(undefined), null);
  // Each run's own settings file must keep getting its OWN token: the child
  // loaded its `Authorization` header at startup and cannot reload it, so
  // handing it a neighbour's would make its next hook call unauthorised.
  assert.equal(broker.liveToken('run-a'), a);
  assert.equal(broker.liveToken('run-b'), b);
});

test('disarming one run leaves the other verifying — the fail-open hole a pool would open', () => {
  const broker = new Approvals({}, join(STATE_HOME, 'disarm-one.json'));
  const a = broker.arm('run-a');
  const b = broker.arm('run-b');

  broker.disarm('run-a');

  assert.equal(broker.runIdFor(`Bearer ${a}`), null, 'the finished run is retired');
  // The one that matters. With a single token, run A finishing cleared the only
  // token there was — and an unauthorised hook call is a FAILED hook call,
  // which this hook treats as silence, and silence fails open. Run B would have
  // carried on unsupervised with nothing anywhere saying so.
  assert.equal(broker.runIdFor(`Bearer ${b}`), 'run-b', 'the live run still has a supervisor');
  assert.equal(broker.armed(), true);
  assert.deepEqual(broker.armedRuns(), ['run-b']);
});

test('disarming a run answers only its OWN cards', async () => {
  const broker = new Approvals({}, join(STATE_HOME, 'disarm-cards.json'));
  broker.arm('run-a');
  broker.arm('run-b');

  const mine = broker.request({
    runId: 'run-a', slug: 'alpha', phase: 1, kind: 'tool', title: 'a', detail: '', evidence: [],
  });
  const theirs = broker.request({
    runId: 'run-b', slug: 'beta', phase: 1, kind: 'tool', title: 'b', detail: '', evidence: [],
  });

  broker.disarm('run-a');

  assert.equal((await mine.decided).decision, 'deny', "the ending run's card is answered");
  // Settling a neighbour's card would deny a live session's work on behalf of a
  // run that has nothing to do with it.
  assert.equal(broker.pending().length, 1);
  assert.equal(broker.pending()[0].runId, 'run-b');

  broker.disarm();
  assert.equal((await theirs.decided).decision, 'deny', 'and a bare disarm still means everything');
});

test.after(() => rmSync(STATE_HOME, { recursive: true, force: true }));

/* ------------------------------------------------------------------ *
 * The openPr carve-out
 * ------------------------------------------------------------------ */

test('without the carve-out nothing about the wall moves — most runs never see it', async () => {
  const { carvedPolicy } = await import('../server/runner/approvals.ts');
  const base = loadPolicy('/nonexistent');
  const trusted = carvedPolicy(base, 'trusted', false);
  assert.deepEqual(trusted.deny, base.deny, 'the wall is the wall');
  assert.deepEqual(trusted.ask, [], 'trusted still empties the ask list');
});

test('the carve-out moves exactly bare push to ask, and walls the destructive shapes', async () => {
  const { carvedPolicy, PUSH_DENY, PUSH_DENY_CARVED } = await import('../server/runner/approvals.ts');
  const carved = carvedPolicy(loadPolicy('/nonexistent'), 'guarded', true);
  assert.ok(!carved.deny.includes(PUSH_DENY), 'bare git push is no longer denied outright');
  for (const rule of PUSH_DENY_CARVED) {
    assert.ok(carved.deny.includes(rule), `${rule} stays walled — the carve-out publishes, never rewrites`);
  }
  assert.ok(carved.ask.includes('Bash(git push:*)'));
  assert.ok(carved.ask.includes('Bash(gh pr create:*)'));
  // Nothing else came off the wall.
  for (const rule of DEFAULT_DENY) {
    if (rule === PUSH_DENY) continue;
    assert.ok(carved.deny.includes(rule), `${rule} must survive the carve-out untouched`);
  }
});

test('under trusted, the carve-out asks survive — the push and the PR still get a card', async () => {
  const { carvedPolicy, OPEN_PR_ASK } = await import('../server/runner/approvals.ts');
  const carved = carvedPolicy(loadPolicy('/nonexistent'), 'trusted', true);
  assert.deepEqual([...carved.ask].sort(), [...OPEN_PR_ASK].sort(),
    'exactly the two world-visible acts keep asking; everything else trusts');
  assert.equal(classifyTool('Bash', { command: 'git push -u origin pe/demo' }, carved, 'trusted'), 'ask');
  assert.equal(classifyTool('Bash', { command: 'gh pr create --title x' }, carved, 'trusted'), 'ask');
  assert.equal(classifyTool('Bash', { command: 'git push --force origin pe/demo' }, carved, 'trusted'), 'deny');
  assert.equal(classifyTool('Bash', { command: 'git commit -m x' }, carved, 'trusted'), 'allow');
});

test('the settings file a carve-out run hands its child reflects the carved wall', () => {
  const settings = buildSettings({
    runId: 'r9', token: 't', origin: 'http://127.0.0.1:4123',
    profile: 'trusted', openPrCarveOut: true,
  });
  const deny = (settings.permissions as { deny: string[] }).deny;
  assert.ok(!deny.includes('Bash(git push:*)'), 'the CLI-side wall lets the one push through');
  assert.ok(deny.includes('Bash(git push --force:*)'), 'and still refuses a rewrite outright');
  assert.ok(deny.includes('Bash(terraform apply:*)'), 'the rest of the wall is untouched');
});

/* ------------------------------------------------------------------ *
 * Striking shipped defaults, and the way back
 * ------------------------------------------------------------------ */

test('a shipped ask default can be struck by name, and the strike is scoped', async () => {
  const { editPolicy, loadPolicyFor, planPolicyPath, DEFAULT_ASK: ASK } =
    await import('../server/runner/approvals.ts');
  const dir = mkdtempSync(join(tmpdir(), 'pc-strike-'));
  const globalFile = join(dir, 'autopilot.json');
  const rule = ASK[0];

  // The × on a default chip is the same remove gesture a file rule takes; the
  // editor records it as a strike because there is no file line to delete.
  editPolicy({ remove: { ask: [rule] }, by: 'tester' }, planPolicyPath('alpha', dir));

  assert.ok(!loadPolicyFor('alpha', globalFile, dir).ask.includes(rule), 'struck for this plan');
  assert.ok(loadPolicyFor('beta', globalFile, dir).ask.includes(rule), 'untouched elsewhere');
  assert.ok(loadPolicyFor(null, globalFile, dir).ask.includes(rule), 'and globally');
  rmSync(dir, { recursive: true, force: true });
});

test('restore forgives one strike without making the default look like yours', async () => {
  const { editPolicy, loadPolicyFor, policyExtras, DEFAULT_ALLOW: ALLOW } =
    await import('../server/runner/approvals.ts');
  const dir = mkdtempSync(join(tmpdir(), 'pc-restore-'));
  const globalFile = join(dir, 'autopilot.json');
  const rule = ALLOW[0];

  editPolicy({ remove: { allow: [rule] }, by: 'tester' }, globalFile);
  assert.ok(!loadPolicyFor(null, globalFile, dir).allow.includes(rule));

  editPolicy({ restore: { allow: [rule] }, by: 'tester' }, globalFile);
  const after = loadPolicyFor(null, globalFile, dir);
  assert.ok(after.allow.includes(rule), 'the default applies again');
  assert.ok(!policyExtras(globalFile).allow.includes(rule),
    'as a DEFAULT — a restored rule is nobody\'s edit, so it must not render as yours');
  assert.ok(!after.always?.includes(rule), 'and it must not gain outrank-the-ask-list power');
  rmSync(dir, { recursive: true, force: true });
});

test('reset returns one part to stock: your rules out, strikes forgiven, the others untouched', async () => {
  const { editPolicy, loadPolicyFor, policyExtras, DEFAULT_ASK: ASK } =
    await import('../server/runner/approvals.ts');
  const dir = mkdtempSync(join(tmpdir(), 'pc-reset-'));
  const globalFile = join(dir, 'autopilot.json');

  editPolicy({
    add: { ask: ['Bash(task migrate:*)'], allow: ['Bash(task deploy:*)'] },
    remove: { ask: [ASK[0]] },
    by: 'tester',
  }, globalFile);

  editPolicy({ reset: ['ask'], by: 'tester' }, globalFile);
  const after = loadPolicyFor(null, globalFile, dir);
  assert.ok(after.ask.includes(ASK[0]), 'the struck default is back');
  assert.ok(!after.ask.includes('Bash(task migrate:*)'), 'the added rule is gone');
  assert.ok(after.allow.includes('Bash(task deploy:*)'), 'the OTHER part kept its rule');
  assert.deepEqual(policyExtras(globalFile).removed, { deny: [], ask: [], allow: [] });
  rmSync(dir, { recursive: true, force: true });
});

test('a shipped deny rule strikes like any other default — applied, recorded, reversible', async () => {
  // The deliberate reversal (2026-08-06): the wall used to be unstrikeable
  // from a browser, and what that produced in practice was a parked plan
  // behind a push the operator wanted made. A strike is still named,
  // attributed, journaled and reversible — and the CLI-side settings are the
  // teeth, so the strike must reach them or it is only a UI opinion.
  const { editPolicy, loadPolicyFor, policyExtras, buildSettings: build, DEFAULT_DENY: DENY } =
    await import('../server/runner/approvals.ts');
  const dir = mkdtempSync(join(tmpdir(), 'pc-wall-'));
  const globalFile = join(dir, 'autopilot.json');
  const rule = 'Bash(git push:*)';

  editPolicy({ remove: { deny: [rule] }, by: 'tester' }, globalFile);
  const after = loadPolicyFor(null, globalFile, dir);
  assert.ok(!after.deny.includes(rule), 'the struck rule left the wall');
  for (const kept of DENY) {
    if (kept === rule) continue;
    assert.ok(after.deny.includes(kept), `${kept} was not named, so it still applies`);
  }
  const file = policyExtras(globalFile);
  assert.deepEqual(file.deny, [], 'a strike is not an operator rule');
  assert.deepEqual(file.removed.deny, [rule]);

  // The teeth: the settings handed to every child no longer carry the rule.
  const settings = build({
    runId: 'r1', token: 't', origin: 'http://127.0.0.1:4123', policy: after, profile: 'trusted',
  });
  const deny = (settings.permissions as { deny: string[] }).deny;
  assert.ok(!deny.includes(rule), 'the CLI-side wall moved with the strike');
  assert.ok(deny.includes('Bash(sudo:*)'), 'and only where the strike named');
  assert.equal(classifyTool('Bash', { command: 'git push origin main' }, after), 'allow',
    'the shipped allow list already covers git, so an unwalled push classifies by the remaining lists');

  // Restore forgives the strike without making the default look like yours.
  editPolicy({ restore: { deny: [rule] }, by: 'tester' }, globalFile);
  const restored = loadPolicyFor(null, globalFile, dir);
  assert.ok(restored.deny.includes(rule), 'the wall is whole again');
  assert.deepEqual(policyExtras(globalFile).deny, [], 'and the restored rule is nobody\'s edit');

  // Reset forgives every strike and drops added rules, like the other lists.
  editPolicy({ remove: { deny: [rule] }, add: { deny: ['Bash(task nuke:*)'] }, by: 'tester' }, globalFile);
  editPolicy({ reset: ['deny'], by: 'tester' }, globalFile);
  const stock = loadPolicyFor(null, globalFile, dir);
  assert.ok(stock.deny.includes(rule), 'reset brought the wall back');
  assert.ok(!stock.deny.includes('Bash(task nuke:*)'), 'and dropped the added rule');

  // An operator-ADDED deny rule stays one-step removable, as it always was.
  editPolicy({ add: { deny: ['Bash(task nuke:*)'] }, by: 'tester' }, globalFile);
  assert.ok(loadPolicyFor(null, globalFile, dir).deny.includes('Bash(task nuke:*)'));
  editPolicy({ remove: { deny: ['Bash(task nuke:*)'] }, by: 'tester' }, globalFile);
  assert.ok(!loadPolicyFor(null, globalFile, dir).deny.includes('Bash(task nuke:*)'));
  rmSync(dir, { recursive: true, force: true });
});

test('a deny strike is scoped exactly like an ask strike', async () => {
  const { editPolicy, loadPolicyFor, planPolicyPath } = await import('../server/runner/approvals.ts');
  const dir = mkdtempSync(join(tmpdir(), 'pc-wall-scope-'));
  const globalFile = join(dir, 'autopilot.json');
  const rule = 'Bash(git push:*)';

  editPolicy({ remove: { deny: [rule] }, by: 'tester' }, planPolicyPath('alpha', dir));
  assert.ok(!loadPolicyFor('alpha', globalFile, dir).deny.includes(rule), 'struck for this plan');
  assert.ok(loadPolicyFor('beta', globalFile, dir).deny.includes(rule), 'walled elsewhere');
  assert.ok(loadPolicyFor(null, globalFile, dir).deny.includes(rule), 'and globally');
  rmSync(dir, { recursive: true, force: true });
});

test('the carve-out never resurrects a struck wall', async () => {
  const { carvedPolicy, editPolicy, loadPolicyFor, PUSH_DENY, PUSH_DENY_CARVED, OPEN_PR_ASK } =
    await import('../server/runner/approvals.ts');
  const dir = mkdtempSync(join(tmpdir(), 'pc-wall-carve-'));
  const globalFile = join(dir, 'autopilot.json');

  editPolicy({ remove: { deny: [PUSH_DENY] }, by: 'tester' }, globalFile);
  const carved = carvedPolicy(loadPolicyFor(null, globalFile, dir), 'trusted', true);
  // The operator's standing policy holds no push wall; a per-run narrowing of
  // a wall that is not there must not quietly re-add the force-push denials.
  for (const shape of PUSH_DENY_CARVED) {
    assert.ok(!carved.deny.includes(shape), `${shape} must not come back from a carve-out`);
  }
  // The "one human tap to publish" asks are about the run shape, not the wall
  // — they stay pinned either way.
  for (const ask of OPEN_PR_ASK) assert.ok(carved.ask.includes(ask), ask);
  rmSync(dir, { recursive: true, force: true });
});

test('profiles still move only the ask list, whatever the operator struck', async () => {
  const { editPolicy, loadPolicyFor, profilePolicy, PERMISSION_PROFILES } =
    await import('../server/runner/approvals.ts');
  const dir = mkdtempSync(join(tmpdir(), 'pc-wall-profiles-'));
  const globalFile = join(dir, 'autopilot.json');

  editPolicy({ remove: { deny: ['Bash(git push:*)'] }, by: 'tester' }, globalFile);
  const struck = loadPolicyFor(null, globalFile, dir);
  for (const profile of PERMISSION_PROFILES) {
    assert.deepEqual(profilePolicy(struck, profile).deny, struck.deny,
      `${profile}: deny is identical across all three profiles — the edited wall included`);
  }
  rmSync(dir, { recursive: true, force: true });
});

test('an upgrade that ships a new default still applies it to a file with strikes', async () => {
  const { editPolicy, policyExtras, DEFAULT_ASK: ASK } = await import('../server/runner/approvals.ts');
  const dir = mkdtempSync(join(tmpdir(), 'pc-upgrade-'));
  const globalFile = join(dir, 'autopilot.json');

  editPolicy({ remove: { ask: [ASK[0]] }, by: 'tester' }, globalFile);
  // The file records the strike BY NAME and nothing else about the defaults —
  // which is what keeps every default it does not name, including ones that
  // ship after this file was written.
  const raw = JSON.parse(readFileSync(globalFile, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(raw.removed, { deny: [], ask: [ASK[0]], allow: [] });
  assert.deepEqual(raw.ask, []);
  assert.deepEqual(policyExtras(globalFile).removed.ask, [ASK[0]]);
  rmSync(dir, { recursive: true, force: true });
});

test('the Stop hook rides beside PreToolUse — same origin, same token, and profiles never change it', () => {
  const settings = buildSettings({ runId: 'r1', token: 'secret-token', origin: 'http://127.0.0.1:4123' });
  const stop = (settings.hooks as {
    Stop: { hooks: { type: string; url: string; headers: Record<string, string>; timeout: number }[] }[];
  }).Stop[0].hooks[0];
  assert.equal(stop.type, 'http');
  assert.equal(stop.url, 'http://127.0.0.1:4123/hooks/stop');
  assert.equal(stop.headers.Authorization, 'Bearer secret-token');
  assert.ok(stop.timeout > 0, 'a hook with no timeout is a session that can hang on a dead console');

  // Profiles move only the ask list. The hook set — like deny — is identical
  // across all three: a profile must never change what a session may end with,
  // only what it must ask about along the way.
  const byProfile = (['guarded', 'trusted', 'bypass'] as const).map((profile) =>
    JSON.stringify(buildSettings({ runId: 'r1', token: 't', origin: 'http://x', profile }).hooks));
  assert.equal(byProfile[0], byProfile[1]);
  assert.equal(byProfile[1], byProfile[2]);
});

/* ------------------------------------------------------------------ *
 * A restart, end to end (TRS-11)
 * ------------------------------------------------------------------ */

test('ACC-8.10 (TRS-11): a console that boots over a surviving child ADOPTS its token, keeps its card answerable, keeps its settings file — and files every other card unanswerable with its reason', async () => {
  const { spawn } = await import('node:child_process');
  const { INSTANCE_STATE_DIR } = await import('../server/config.ts');
  const { newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
  const { Service } = await import('../server/service.ts');
  const { SKILL_DIR } = await import('../server/config.ts');

  const root = mkdtempSync(join(STATE_HOME, 'restart-root-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), [
    '---', 'slug: alpha', 'status: active', '---', '', '# alpha', '', '## Phase graph', '',
    '| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |',
    '|------:|-------|-----------|--------------------|-------|---------------|',
    '| 1 | one | — | — | app | done |', '| 2 | two | 1 | — | app | done |', '',
    '## Phases', '', '### Phase 1 — one', '- **Size:** S', '', '### Phase 2 — two', '- **Size:** S', '',
  ].join('\n'), 'utf8');

  // A child that outlived its console: a real process, so the probe answers the truth.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  try {
    const surviving = newRun({ slug: 'alpha', root } as never);
    surviving.status = 'running';
    const record = phaseRecord(surviving, 2);
    record.status = 'running';
    record.sessionId = 'sess-alive';
    surviving.children = { 2: { pid: child.pid!, phase: 2, sessionId: 'sess-alive', startedAt: new Date().toISOString() } } as never;
    saveRun(surviving);
    const token = new Approvals().arm(surviving.id);
    writeSettingsFile(surviving.id, buildSettings({ runId: surviving.id, token, origin: 'http://127.0.0.1:1' }));

    const at = new Date().toISOString();
    const until = new Date(Date.now() + 3_000_000).toISOString();
    const base = { slug: 'alpha', phase: 2, detail: 'wants to run it', evidence: [], createdAt: at, expiresAt: until, status: 'pending' };
    const pendingFile = join(INSTANCE_STATE_DIR, 'approvals', 'pending.json');
    mkdirSync(join(INSTANCE_STATE_DIR, 'approvals'), { recursive: true });
    writeFileSync(pendingFile, JSON.stringify([
      { ...base, id: 'live-card', runId: surviving.id, kind: 'tool', title: 'Bash: psql', tool: { name: 'Bash', input: { command: 'psql -c "select 1"' } } },
      { ...base, id: 'gone-card', runId: 'deadbeef', kind: 'tool', title: 'Bash: psql', tool: { name: 'Bash', input: { command: 'psql' } } },
      { ...base, id: 'verify-card', runId: surviving.id, kind: 'verify', title: 'A check only you can make' },
      { ...base, id: 'offer-card', runId: surviving.id, kind: 'tool', title: 'Widen a rule', standing: true },
    ]), 'utf8');

    const svc = new Service({
      port: 0, host: '127.0.0.1', open: false, allowWrites: true, converge: false,
      scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null, remoteHosts: [], remoteUsers: [],
    } as never);
    try {
      assert.equal(svc.open(root).ok, true);
      assert.equal(svc.approvals.liveToken(surviving.id), token, 'the surviving child\'s own token — never a fresh one');
      assert.ok(recentLog(200).some((entry) => entry.event === 'approvals.token-adopted' && entry.data?.runId === surviving.id));
      assert.ok(statSync(join(INSTANCE_STATE_DIR, 'settings', `run-${surviving.id}.json`)).isFile(),
        'the secrets sweep kept the file a surviving child is holding');

      const byId = new Map(svc.approvals.all().map((approval) => [approval.id, approval]));
      assert.equal(byId.get('live-card')?.status, 'pending', 'answerable: its session survived with its token');
      assert.ok(byId.get('live-card')?.recovered);
      assert.equal(byId.get('gone-card')?.unanswerable?.reason, 'session-gone');
      assert.equal(byId.get('verify-card')?.unanswerable?.reason, 'asker-gone');
      assert.equal(byId.get('offer-card')?.unanswerable?.reason, 'reoffered');
      for (const approval of svc.approvals.all()) assert.notEqual(approval.status, 'expired', `${approval.id} never reads expired`);

      // A person answers it; the answer is kept for that session's identical call (the hook half is `hook-decisions.test.ts`).
      assert.equal(svc.approvals.settle('live-card', 'deny', 'phone'), true);
      assert.equal(svc.approvals.takeRecoveredAnswer(surviving.id, 2, 'Bash', { command: 'psql -c "select 1"' })?.decision, 'deny');
    } finally {
      svc.approvals.disarm();
      svc.close();
    }
  } finally {
    child.kill();
  }
});

/* ------------------------------------------------------------------ *
 * The relay (zero-touch-console phase 14) — the 60-second window
 * ------------------------------------------------------------------ */

type RelayNote = { event: string; data: Record<string, unknown>; phase?: number };

/**
 * A relay over a real broker and a sandboxed state file, with a runner that
 * records what it was told. The answer clock is the test's (`answerMs`); the
 * window the card shows stays the shipped 60 s, so `waitedMs` is what the
 * relay really waited.
 */
async function relayBench(opts: { answerMs?: number; rules?: import('../shared/relay-model.js').RelayRule[]; dir?: string } = {}) {
  const { Relay } = await import('../server/relay.ts');
  const dir = opts.dir ?? mkdtempSync(join(STATE_HOME, 'relay-'));
  const notes: RelayNote[] = [];
  const journalled: RelayNote[] = [];
  const parks: { reason: string; phase: number | null; kind: string }[] = [];
  const pushes: { category: string; title: string; body: string }[] = [];
  const rulings: { slug: string; what: string; by: string; relay: Record<string, unknown> }[] = [];
  const told: { phase: number; answers: readonly Record<string, unknown>[] }[] = [];
  const approvals = new Approvals(() => {}, join(dir, 'pending.json'));
  const runner = {
    note: (event: string, data: Record<string, unknown> = {}, phase?: number) => { notes.push({ event, data, phase }); },
    park: (reason: string, phase: number | null, kind: string) => { parks.push({ reason, phase, kind }); return true; },
    tellRelayAnswer: (phase: number, answers: readonly Record<string, unknown>[]) => { told.push({ phase, answers }); return { ok: true }; },
  };
  const relay = new Relay({
    approvals,
    runner: () => runner as never,
    journal: (_slug, _runId, event, data, phase) => { journalled.push({ event, data, phase }); },
    announce: (category, message) => { pushes.push({ category, title: message.title, body: message.body }); },
    tagFor: (...parts) => parts.join(':'),
    appendRuling: (slug, ruling) => { rulings.push({ slug, what: ruling.what, by: ruling.by, relay: ruling.relay as never }); },
    rules: () => opts.rules ?? [],
    scriptsDir: '/skill/scripts',
    answerMs: opts.answerMs ?? 30,
    stateFile: join(dir, 'relay-state.json'),
  });
  return { dir, relay, approvals, notes, journalled, parks, pushes, rulings, told };
}

const relayRun = (over: Record<string, unknown> = {}) => ({
  id: 'r1', slug: 'demo', status: 'running', phases: {}, relay: 'last-resort',
  relayArming: { armed: true, version: '2.1.270', floor: '2.1.268', at: new Date().toISOString() },
  ...over,
}) as never;

const question = (text: string, labels: string[], extra: Record<string, unknown> = {}) => ({
  question: text, header: 'Choice', multiSelect: false,
  options: labels.map((label) => ({ label, description: `${label} it is` })),
  ...extra,
});

const envelope = (questions: unknown[], extra: Record<string, unknown> = {}) => ({
  mechanism: 'pre-tool-use' as const,
  tool: 'AskUserQuestion',
  input: { questions },
  toolUseId: 'toolu_relay_1',
  sessionId: 'sess-relay',
  policy: loadPolicy('/nonexistent'),
  profile: 'guarded' as const,
  ...extra,
});

test('ACC-8.16 (AC-4): a relayed question is raised, then answered by rule, by its (Recommended) option, else by the first — one entry per question over a call carrying 4, within the window, with a ruling each', async () => {
  const { frameRelayAnswer } = await import('../server/runner/runner-core.ts');
  const { questionKey, RELAY_ANSWER_MS, RELAY_WINDOW_MS } = await import('../shared/relay-model.js');
  assert.equal(RELAY_WINDOW_MS, 60_000);
  assert.equal(RELAY_ANSWER_MS, 55_000, 'answered 5 s before the window closes');
  const q1 = question('Which colour should the banner be?', ['Red', 'Blue']);
  const q2 = question('Which region should the bucket live in?', ['us-east', 'eu-west (Recommended)']);
  const q3 = question('Which log level for the worker?', ['info', 'debug']);
  const q4 = question('Which queue backend?', ['sqs (Recommended)', 'redis (Recommended)']);
  const bench = await relayBench({
    rules: [{ id: 'banner-red', tool: 'AskUserQuestion', key: `${questionKey(q1)}`, profile: '*', answer: 'red' }],
  });
  const before = Date.now();
  const reply = await bench.relay.relayQuestion(relayRun(), 2, envelope([q1, q2, q3, q4]));
  assert.equal(reply.kind, 'answered', 'every question answered — an allow, never a denial');
  if (reply.kind !== 'answered') return;
  // The shape spike S1 measured honoured: `questions` echoed, `answers` keyed by question TEXT.
  assert.deepEqual(reply.updatedInput.questions, [q1, q2, q3, q4]);
  assert.deepEqual(reply.updatedInput.answers, {
    'Which colour should the banner be?': 'Red',
    'Which region should the bucket live in?': 'eu-west (Recommended)',
    'Which log level for the worker?': 'info',
    'Which queue backend?': 'sqs (Recommended)',
  });

  const raised = bench.notes.filter((n) => n.event === 'phase.question-raised');
  assert.equal(raised.length, 1, 'one raise for the call');
  assert.equal(raised[0].phase, 2);
  assert.equal(raised[0].data.tool, 'AskUserQuestion');
  assert.equal(raised[0].data.mechanism, 'pre-tool-use');
  assert.equal(raised[0].data.source, 'run');
  assert.equal(raised[0].data.key, questionKey(q1));
  assert.deepEqual((raised[0].data.questions as { key: string; options: string[]; multiSelect: boolean }[]).map((entry) => entry.key),
    [q1, q2, q3, q4].map((q) => questionKey(q)), 'one entry per question');
  assert.deepEqual((raised[0].data.questions as { options: string[] }[])[1].options, ['us-east', 'eu-west (Recommended)']);

  const answered = bench.notes.filter((n) => n.event === 'phase.question-answered');
  assert.deepEqual(answered.map((n) => n.data.by), ['rule', 'recommended', 'first-option', 'first-option'],
    'the order: a rule, the sole (Recommended), else the first — two recommendations recommend nothing');
  assert.equal(answered[0].data.ruleId, 'banner-red');
  for (const line of answered) {
    assert.ok(typeof line.data.waitedMs === 'number' && line.data.waitedMs <= 61_000, `waited ${line.data.waitedMs} ms`);
    assert.ok((line.data.waitedMs as number) <= Date.now() - before + 5);
  }
  assert.equal(bench.rulings.length, 4, 'a ruling row per answer');
  assert.deepEqual(bench.rulings.map((r) => r.relay.answeredBy), ['rule', 'recommended', 'first-option', 'first-option']);
  assert.ok(bench.rulings.every((r) => r.by === 'relay' && r.slug === 'demo'));
  assert.equal(bench.approvals.pending().length, 0, 'the card came down');
  assert.equal(bench.pushes.length, 0, 'the relay itself pushes nothing for a raise — the broker\'s notify does (the service\'s session-ask)');

  // The session is told, in the words the plan fixed, once the reply is on its way.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bench.told.length, 1);
  assert.equal(bench.told[0].answers.length, 4, 'every machine answer, none of them a person\'s');
  assert.equal(
    frameRelayAnswer('Red', 'relay rule banner-red', 'ambiguity'),
    'No operator answered within 60 s. The console answered `Red` by `relay rule banner-red`. This is NOT a change '
      + 'to the phase. If that answer is wrong, declare `blocked --needs ambiguity` rather than asking again.',
  );
});

test('ACC-8.16 (AC-4): a person answering inside the window wins — by human, and the console answers nothing', async () => {
  const bench = await relayBench({ answerMs: 5_000 });
  const q = question('Should the migration run now?', ['Now', 'Tonight (Recommended)']);
  const pending = bench.relay.relayQuestion(relayRun(), 2, envelope([q]));
  await new Promise((resolve) => setImmediate(resolve));
  const card = bench.approvals.pending()[0];
  assert.equal(card?.kind, 'question');
  assert.equal(Date.parse(card!.expiresAt) - Date.parse(card!.createdAt), 60_000, 'the card shows the 60 s window');
  assert.deepEqual(bench.relay.answer(card!.id, [{ key: card!.question!.items[0].key, label: 'nope' }], 'phone'),
    { ok: false, status: 400, error: '"nope" is not one of that question\'s options' });
  const taken = bench.relay.answer(card!.id, [{ key: card!.question!.items[0].key, label: 'now' }], 'phone@me');
  assert.deepEqual(taken, { ok: true, answered: [card!.question!.items[0].key], remaining: 0 });
  const reply = await pending;
  assert.equal(reply.kind, 'answered');
  if (reply.kind !== 'answered') return;
  assert.deepEqual(reply.updatedInput.answers, { 'Should the migration run now?': 'Now' }, 'the person, not the recommendation');
  const answered = bench.notes.filter((n) => n.event === 'phase.question-answered');
  assert.equal(answered.length, 1);
  assert.equal(answered[0].data.by, 'human');
  assert.equal(answered[0].data.who, 'phone@me');
  assert.ok((answered[0].data.waitedMs as number) < 60_000);
  assert.equal(bench.rulings[0].by, 'phone@me');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bench.told.length, 0, 'a person\'s answer needs no notice');
});

test('ACC-8.16 (AC-14): the deny list is consulted FIRST — a denied tool or a denied command in an option never opens a window', async () => {
  const bench = await relayBench({ answerMs: 5_000 });
  const raisedBefore = bench.approvals.counts().raised;
  const pushOption = question('How should the branch land?', ['Rebase and merge', 'Run `git push --force origin main`']);
  const reply = await bench.relay.relayQuestion(relayRun(), 2, envelope([pushOption]));
  assert.equal(reply.kind, 'unanswerable');
  if (reply.kind !== 'unanswerable') return;
  assert.equal(reply.reason, 'deny-list');
  assert.equal(reply.rule, 'Bash(git push:*)', 'the wall names the line');
  const walled = { ...loadPolicy('/nonexistent'), deny: [...DEFAULT_DENY, 'AskUserQuestion'] };
  const second = await bench.relay.relayQuestion(relayRun(), 3, envelope([question('Anything?', ['Yes', 'No'])], { policy: walled }));
  assert.equal(second.kind, 'unanswerable');
  assert.equal(bench.approvals.counts().raised, raisedBefore, 'no card was raised — no window was ever started');
  assert.equal(bench.approvals.pending().length, 0);
  assert.equal((bench.relay as unknown as { held: Map<string, unknown> }).held.size, 0, 'and no timer is holding anything');
  assert.ok(!bench.notes.some((n) => n.event === 'phase.question-raised'));
  assert.equal(bench.notes.filter((n) => n.event === 'phase.question-unanswerable').length, 2);
});

test('ACC-8.10 (AC-6, S3): a question open across a console death is answered at BOOT by rule, waitedMs spanning the outage — deferred, it is answerable and meets the resume; not deferred, it is hook-closed — and no card reads expired', async () => {
  const dir = mkdtempSync(join(STATE_HOME, 'relay-restart-'));
  const first = await relayBench({ answerMs: 600_000, dir });
  const deferredQ = question('Which colour should the banner be?', ['Red', 'Blue (Recommended)']);
  const closedQ = question('Which port should the worker take?', ['8080', '9090']);
  // Run r1 asks through PreToolUse (it carries a tool_use_id and can defer); run r2 through PermissionRequest.
  const deferredReply = first.relay.relayQuestion(relayRun(), 2, envelope([deferredQ]));
  const closedReply = first.relay.relayQuestion(relayRun({ id: 'r2' }), 4, envelope([closedQ], {
    mechanism: 'permission-request', toolUseId: undefined,
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(first.approvals.pending().length, 2);
  // The console goes away gracefully for r1 only: its question is deferred…
  assert.equal(first.relay.deferOpen('r1', 'shutdown'), 1);
  const deferred = await deferredReply;
  assert.equal(deferred.kind, 'deferred', 'the PreToolUse hook is told defer');
  assert.ok(first.notes.some((n) => n.event === 'phase.question-deferred' && n.data.toolUseId === 'toolu_relay_1'));
  // …and then it dies with r2's question still open. Both cards are on disk.
  const pendingFile = join(dir, 'pending.json');
  const onDisk = JSON.parse(readFileSync(pendingFile, 'utf8')) as Record<string, unknown>[];
  assert.equal(onDisk.length, 2);
  // Ninety minutes of outage, in the record's own clock.
  const outageMs = 90 * 60_000;
  for (const card of onDisk) card.createdAt = new Date(Date.parse(card.createdAt as string) - outageMs).toISOString();
  writeFileSync(pendingFile, JSON.stringify(onDisk), 'utf8');
  void closedReply;

  const second = await relayBench({ dir });
  const tally = second.approvals.recover((card) => second.relay.recoverCard(card));
  assert.deepEqual(tally, { answerable: 1, unanswerable: { 'hook-closed': 1 } });
  const cards = second.approvals.all();
  for (const card of cards) assert.notEqual(card.status, 'expired', `${card.id} never reads expired`);
  const kept = cards.find((card) => card.runId === 'r1')!;
  assert.equal(kept.status, 'allow', 'deferred: answered at boot, and still answerable');
  assert.equal(kept.decidedBy, 'relay');
  assert.ok(kept.recovered);
  const closed = cards.find((card) => card.runId === 'r2')!;
  assert.equal(closed.status, 'unanswerable');
  assert.equal(closed.unanswerable?.reason, 'hook-closed');
  assert.equal(closed.question?.answers[closed.question.items[0].key]?.label, '8080', 'the rule answer is recorded as the substitute');

  const boot = second.journalled.filter((n) => n.event === 'phase.question-answered');
  assert.equal(boot.length, 2, 'both answered at boot, on the runs\' journals');
  for (const line of boot) {
    assert.equal(line.data.recovered, true);
    assert.ok((line.data.waitedMs as number) >= outageMs, `waitedMs ${line.data.waitedMs} spans the outage`);
  }
  assert.equal(boot.find((n) => n.data.approvalId === kept.id)?.data.by, 'recommended');

  // The resume: the session's PreToolUse fires again for the same tool_use_id — answered at once, no second card.
  const resumed = await second.relay.relayQuestion(relayRun(), 2, envelope([deferredQ]));
  assert.equal(resumed.kind, 'answered');
  if (resumed.kind === 'answered') assert.deepEqual(resumed.updatedInput.answers, { 'Which colour should the banner be?': 'Blue (Recommended)' });
  assert.equal(second.approvals.pending().length, 0);
  // The hook-closed question asked again gets the substitute — not a repeated-key refusal.
  const again = await second.relay.relayQuestion(relayRun({ id: 'r2' }), 4, envelope([closedQ], { mechanism: 'permission-request', toolUseId: undefined }));
  assert.equal(again.kind, 'answered');
  // One-shot: the same question once more is a repeated key.
  const thrice = await second.relay.relayQuestion(relayRun({ id: 'r2' }), 4, envelope([closedQ], { mechanism: 'permission-request', toolUseId: undefined }));
  assert.equal(thrice.kind, 'unanswerable');
  if (thrice.kind === 'unanswerable') assert.equal(thrice.reason, 'repeated-key');
});

test('the relay host never answers first: presence only, a deny after the hook\'s hour, and a notification that cancels it', async () => {
  const { RELAY_HOST_BACKSTOP_MS, RELAY_HOST_TOOL, answerMessage, relayHostConfig } = await import('../server/relay-host.ts');
  assert.ok(RELAY_HOST_BACKSTOP_MS > HOOK_TIMEOUT_SECONDS * 1000, 'the host outwaits the hook it must never beat');
  assert.equal(RELAY_HOST_TOOL, 'mcp__pcrelay__hold');
  assert.match(relayHostConfig('/node').args[0], /relay-host\.(ts|js)$/);
  const held: unknown[] = [];
  const init = answerMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, () => {}) as { result: { capabilities: unknown } };
  assert.deepEqual(init.result.capabilities, { tools: {} });
  const list = answerMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, () => {}) as { result: { tools: { name: string }[] } };
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ['hold']);
  const call = answerMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hold', arguments: {} } }, (id, later) => held.push({ id, later }));
  assert.equal(call, null, 'a tools/call is never answered on arrival');
  assert.equal(held.length, 1);
  const late = (held[0] as { later: () => { result: { content: { text: string }[] } } }).later();
  assert.equal(JSON.parse(late.result.content[0].text).behavior, 'deny', 'and only ever denies, late');
});

test('ACC-8.11 (S2): an ARMED run\'s settings register the PermissionRequest hook beside PreToolUse — same origin, same token, every tool — and a run on the floor registers none, because --permission-prompts none does not switch it off', () => {
  const armed = buildSettings({ runId: 'r1', token: 'tok', origin: 'http://127.0.0.1:4130', relay: true }) as {
    hooks: Record<string, { matcher?: string; hooks: { type: string; url: string; headers: Record<string, string>; timeout: number }[] }[]>;
  };
  const request = armed.hooks.PermissionRequest;
  assert.equal(request.length, 1);
  assert.equal(request[0].matcher, '*', 'the host never answers, so this hook must answer every call that reaches the permission step');
  assert.equal(request[0].hooks[0].type, 'http');
  assert.equal(request[0].hooks[0].url, 'http://127.0.0.1:4130/hooks/permission-request');
  assert.equal(request[0].hooks[0].headers.Authorization, 'Bearer tok');
  assert.equal(request[0].hooks[0].timeout, HOOK_TIMEOUT_SECONDS, 'the socket outlives the 60 s window');
  // The question class reaches the PreToolUse hook too — where the relay answers it.
  assert.match(armed.hooks.PreToolUse[0].matcher!, /(^|\|)AskUserQuestion(\||$)/);

  for (const settings of [
    buildSettings({ runId: 'r1', token: 'tok', origin: 'http://127.0.0.1:4130' }),
    buildSettings({ runId: 'r1', token: 'tok', origin: 'http://127.0.0.1:4130', relay: false }),
  ] as { hooks: Record<string, unknown> }[]) {
    assert.equal(settings.hooks.PermissionRequest, undefined, 'a relay-off run registers no PermissionRequest hook');
  }

  // The token a restart adopts reads back from any of the hooks that carry it.
  const token = 'C'.repeat(43);
  writeSettingsFile('relay-run', buildSettings({ runId: 'relay-run', token, origin: 'http://127.0.0.1:1', relay: true }));
  assert.equal(tokenFromSettingsFile('relay-run'), token);
});

test('the streaming-mode smoke replays: the resumed session\'s hook re-fires for the SAME tool_use_id, and the relay answers it in the shape the CLI honoured', async () => {
  const text = readFileSync(new URL('./fixtures/spikes/relay-stream.md', import.meta.url), 'utf8');
  assert.match(text, /^verdict: honoured$/m);
  const block = /### The hook listener \(both calls, verbatim\)\n```jsonl\n([\s\S]*?)\n```/.exec(text)?.[1] ?? '';
  const calls = block.split('\n').filter(Boolean).map((line) => JSON.parse(line) as {
    tool_use_id: string; reply: { hookSpecificOutput: { permissionDecision: string; updatedInput?: { questions: { question: string }[]; answers: Record<string, string> } } };
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].tool_use_id, calls[1].tool_use_id, 'the resume re-fired the hook for the deferred call itself');
  assert.equal(calls[0].reply.hookSpecificOutput.permissionDecision, 'defer');
  const honoured = calls[1].reply.hookSpecificOutput.updatedInput!;

  // The relay, over the same call: deferred as the console goes away, answered at boot, delivered on the re-fire.
  const dir = mkdtempSync(join(STATE_HOME, 'relay-replay-'));
  const first = await relayBench({ answerMs: 600_000, dir });
  const input = { questions: honoured.questions };
  const pending = first.relay.relayQuestion(relayRun(), 2, envelope(honoured.questions, { input, toolUseId: calls[0].tool_use_id }));
  await new Promise((resolve) => setImmediate(resolve));
  first.relay.deferOpen(null, 'shutdown');
  assert.equal((await pending).kind, 'deferred');
  const second = await relayBench({ dir });
  second.approvals.recover((card) => second.relay.recoverCard(card));
  const resumed = await second.relay.relayQuestion(relayRun(), 2, envelope(honoured.questions, { input, toolUseId: calls[1].tool_use_id }));
  assert.equal(resumed.kind, 'answered');
  if (resumed.kind !== 'answered') return;
  assert.deepEqual(Object.keys(resumed.updatedInput).sort(), Object.keys(honoured).sort(), 'questions and answers, as honoured');
  assert.deepEqual(resumed.updatedInput.questions, honoured.questions);
  assert.deepEqual(Object.keys(resumed.updatedInput.answers as object), Object.keys(honoured.answers), 'answers keyed by question text');
});
