/**
 * The cards built by hand before a person's turn was a family, folded into it
 * (control-tower phase 44):
 *
 *   HF-1  a sign-in (the machine login, a console account) draws as `claude-login`
 *   HF-2  an MCP sign-in draws as `mcp-login`
 *   HF-3  the verification card draws as `person-check`; a tool's permission card is no step
 *   HF-4  a plan to approve, a gate, a relayed question and a QA verdict draw as `decision`
 *         — and no folded card renders a bespoke shape any more (a source scan)
 *   HF-5  phase 39's protected path is a step of that kind, carrying the act and
 *         the path the session named, offering the patch by hand or an
 *         interactive session here
 *   HF-6  `os-permission` names the settings pane in its step lines
 *   HF-7  `physical` carries a QR where its open value is a URL
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { buildInbox } = await import('../server/inbox.ts');
const { errandFor } = await import('../server/runner/ladder.ts');
const {
  HUMAN_STEP_FOLDS, HUMAN_STEP_KINDS, HUMAN_STEP_OFFERS, KIND_META, OS_PERMISSION_PANE_DEFAULT, humanStepView,
  settingsPaneFor,
} = await import('../shared/human-step-model.js');

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const INBOX = fileURLToPath(new URL('../server/inbox.ts', import.meta.url));

type Item = ReturnType<typeof buildInbox>['items'][number];
const inbox = (facts: Record<string, unknown>): Item[] => buildInbox({ plans: [], runs: [], flags: {}, ...facts } as never, NOW).items;

test('the fold map names every hand-built card once, each as a kind of the family', () => {
  assert.deepEqual(Object.keys(HUMAN_STEP_FOLDS).sort(), [
    'approval', 'conflict', 'errand', 'gate', 'mcp-auth', 'person-check', 'plan-approval', 'protected-path', 'qa',
    'question', 'sign-in', 'stall', 'supervisor',
  ]);
  // Widened by control-tower phase 132 (#209): every row Your turn folds.
  assert.equal(HUMAN_STEP_FOLDS.errand, 'operator-act', 'a person errand is an operator act');
  assert.equal(HUMAN_STEP_FOLDS.approval, 'permission', 'the approval broker\'s ask is a permission item');
  assert.equal(HUMAN_STEP_FOLDS.conflict, 'decision');
  assert.equal(HUMAN_STEP_FOLDS.supervisor, 'operator-act');
  assert.equal(HUMAN_STEP_FOLDS.stall, 'operator-act');
  for (const kind of Object.values(HUMAN_STEP_FOLDS)) assert.ok((HUMAN_STEP_KINDS as readonly string[]).includes(kind));
  // The one view carries the kind's own words — KIND_META is read, never re-spelled.
  const view = humanStepView({ kind: 'mcp-login', title: 'x' });
  assert.equal(view.label, KIND_META['mcp-login'].label);
  assert.equal(view.icon, KIND_META['mcp-login'].icon);
  assert.equal(view.proof, KIND_META['mcp-login'].proof);
  for (const offer of view.offers) assert.ok((HUMAN_STEP_OFFERS as readonly string[]).includes(offer));
});

test('HF-1: a sign-in — the machine login and a console account — draws as claude-login', () => {
  const items = inbox({
    auth: { loggedIn: false },
    accounts: [{ id: 'work', name: 'Work', authState: 'expired' }],
  });
  const rows = items.filter((item) => item.kind === 'sign-in');
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.humanStep?.kind, 'claude-login');
    assert.equal(row.humanStep?.fold, 'sign-in');
    assert.equal(row.humanStep?.where, 'host');
    assert.ok(row.actions.length > 0, 'the card\'s own actions still answer it');
  }
  const machine = rows.find((row) => row.subject === undefined && row.title.includes('machine'))
    ?? rows.find((row) => row.humanStep?.openCommand);
  assert.equal(machine?.humanStep?.openCommand, 'claude auth login');
  assert.ok(machine?.humanStep?.offers.includes('terminal'));
  assert.ok(rows.some((row) => row.humanStep?.title === 'Sign Work in'));
});

test('HF-2: an MCP sign-in draws as mcp-login — a server signed out, and one not finished being registered', () => {
  const rows = inbox({
    mcp: [
      { id: 'ctx7', label: 'Context7', enabled: true, status: 'needs-auth' },
      { id: 'files', label: 'Files', enabled: true, status: 'failed', needsConfig: ['MCP_FS_ROOT'] },
    ],
  }).filter((item) => item.kind === 'mcp-auth');
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.humanStep?.kind, 'mcp-login');
    assert.equal(row.humanStep?.fold, 'mcp-auth');
  }
  assert.ok(rows.some((row) => row.humanStep?.title === 'Sign Context7 in'));
  assert.ok(rows.some((row) => row.humanStep?.lines.some((line) => line.includes('MCP_FS_ROOT'))));
});

test('HF-3: the verification card draws as person-check; a tool\'s permission card is not a person\'s act', () => {
  const rows = inbox({
    approvals: [
      { id: 'v1', runId: 'r1', slug: 'demo', phase: 3, kind: 'verify', title: 'Phase 3: 2 checks only you can make', detail: 'The rest is prose.', createdAt: '2026-09-30T11:00:00.000Z', status: 'pending' },
      { id: 't1', runId: 'r1', slug: 'demo', phase: 3, kind: 'tool', title: 'Run `rm -rf build`?', createdAt: '2026-09-30T11:00:00.000Z', status: 'pending' },
    ],
  }).filter((item) => item.kind === 'approval');
  const verify = rows.find((row) => row.title.startsWith('Phase 3'));
  assert.equal(verify?.humanStep?.kind, 'person-check');
  assert.equal(verify?.humanStep?.fold, 'person-check');
  assert.ok(verify?.humanStep?.offers.includes('answer'));
  assert.deepEqual(verify?.humanStep?.lines, ['The rest is prose.']);
  const tool = rows.find((row) => row.title.startsWith('Run'));
  assert.equal(tool?.humanStep, undefined);
});

test('HF-4: a plan to approve, a gate, a relayed question and a QA verdict each draw as a decision', () => {
  const items = inbox({
    runs: [{
      id: 'r1', slug: 'demo', status: 'parked', updatedAt: '2026-09-30T10:00:00.000Z',
      phases: { 4: { phase: 4, status: 'parked', planApproval: { state: 'pending', sha: 'abc' } } },
      recoveries: { 4: { errand: { phase: 4, situation: 'blocked-declared:plan-approval', tried: [], need: 'A decision on the plan.', how: 'Approve or reject it.', at: '2026-09-30T10:00:00.000Z' } } },
    }],
    approvals: [{
      id: 'q1', runId: 'r1', slug: 'demo', phase: 5, kind: 'question', status: 'pending', createdAt: '2026-09-30T11:00:00.000Z',
      question: { items: [{ key: 'k1', question: 'Which database?', options: [{ label: 'Postgres (Recommended)' }, { label: 'SQLite' }] }] },
    }],
    plans: [{
      slug: 'demo', closed: false, updatedAt: '2026-09-30T07:00:00.000Z', qaMode: { mode: 'on' },
      qa: [{ phase: 2, result: 'fail', report: 'docs/handoffs/demo/reports/p2.md' }],
      phases: [
        { phase: 2, state: 'done' },
        { phase: 6, state: 'ready', gated: true, gateKind: 'human', gateCheck: 'a human look at the screenshots', gate: { clear: false, kind: 'human', detail: 'nobody has signed this off' } },
      ],
    }],
  });
  const plan = items.find((item) => item.kind === 'errand' && item.phase === 4);
  assert.equal(plan?.humanStep?.kind, 'decision');
  assert.equal(plan?.humanStep?.fold, 'plan-approval');
  assert.ok(plan?.actions.some((action) => action.verb === 'approve-plan'), 'the answers are still the card\'s actions');
  const gate = items.find((item) => item.kind === 'gate');
  assert.equal(gate?.humanStep?.kind, 'decision');
  assert.equal(gate?.humanStep?.fold, 'gate');
  assert.ok(gate?.humanStep?.lines.includes('What it checks: a human look at the screenshots'));
  const question = items.find((item) => item.kind === 'question');
  assert.equal(question?.humanStep?.kind, 'decision');
  assert.deepEqual(question?.humanStep?.lines, ['Postgres (Recommended)', 'SQLite']);
  const qa = items.find((item) => item.kind === 'qa');
  assert.equal(qa?.humanStep?.kind, 'decision');
  assert.equal(qa?.humanStep?.fold, 'qa');
  // A ladder's own ask — a red verification — is not a person's act of the family.
  const red = inbox({
    runs: [{
      id: 'r2', slug: 'demo', status: 'parked', updatedAt: '2026-09-30T10:00:00.000Z', phases: {},
      recoveries: { 3: { errand: { phase: 3, situation: 'verify-red', tried: [], need: 'n', how: 'h', at: '2026-09-30T10:00:00.000Z' } } },
    }],
  }).find((item) => item.kind === 'errand');
  assert.equal(red?.humanStep, undefined);
});

test('HF-4: no folded card renders a bespoke shape any more — every draft of a folded kind carries the view', () => {
  const source = readFileSync(INBOX, 'utf8');
  const folded = ['sign-in', 'mcp-auth', 'gate', 'qa', 'question', 'human-step'];
  let seen = 0;
  for (const kind of [...folded, 'approval', 'errand']) {
    const re = new RegExp(`kind: '${kind}'(?: as const)?,\\n`, 'g');
    for (const match of source.matchAll(re)) {
      // The draft literal runs to its `actions:` key; the view is written before it.
      const rest = source.slice(match.index!);
      const body = rest.slice(0, rest.indexOf('actions:'));
      // An errand row is a person's turn when it is the ladder's errand (the
      // plan to approve, the protected path); the console's own stop rows are not.
      if (kind === 'errand' && !body.includes('subject: errand.situation')) continue;
      assert.match(body, /humanStep: /, `a \`kind: '${kind}'\` draft at offset ${match.index} carries no humanStep view`);
      seen += 1;
    }
  }
  assert.ok(seen >= 9, `the scan found ${seen} drafts — it must actually be scanning them`);
  // …and the view is built in one place: nothing in the inbox spells a view's fields out by hand.
  assert.doesNotMatch(source, /humanStep: \{/, 'a view literal written by hand is a bespoke shape');
});

test('HF-5: phase 39\'s protected path is a human step of that kind — the act, the path, and its two offers', () => {
  const declared = { rule: 'Edit(.claude/settings.json)', command: 'add a Stop hook to .claude/settings.json', reason: 'the CLI refused the edit' };
  const errand = errandFor('blocked-declared:protected-path', [], 7, '2026-09-30T10:00:00.000Z', null, null, null, null, null, declared);
  assert.deepEqual(errand.step, {
    kind: 'protected-path', act: 'add a Stop hook to .claude/settings.json', path: '.claude/settings.json',
  });
  // Any other situation's errand is not a step.
  assert.equal(errandFor('verify-red', [], 7).step, undefined);

  const row = inbox({
    runs: [{
      id: 'r1', slug: 'demo', status: 'parked', updatedAt: '2026-09-30T10:00:00.000Z', phases: {},
      recoveries: { 7: { errand } },
    }],
  }).find((item) => item.kind === 'errand');
  const view = row?.humanStep;
  assert.equal(view?.kind, 'protected-path');
  assert.equal(view?.fold, 'protected-path');
  assert.equal(view?.act, 'add a Stop hook to .claude/settings.json');
  assert.equal(view?.path, '.claude/settings.json');
  assert.deepEqual(view?.offers, ['patch', 'interactive-session']);
  assert.equal(view?.title, 'Make the protected edit on .claude/settings.json');
  assert.ok(view?.lines.some((line) => /interactive session here/.test(line)));
});

test('HF-6: an os-permission step names the settings pane in its step lines', () => {
  const screen = humanStepView({ kind: 'os-permission', title: 'Grant screen recording to the terminal' });
  assert.ok(screen.lines.some((line) => line.includes('System Settings › Privacy & Security › Screen & System Audio Recording')), screen.lines.join(' | '));
  const firewall = humanStepView({ kind: 'os-permission', title: 'Allow incoming connections for node' });
  assert.ok(firewall.lines.some((line) => line.includes('System Settings › Network › Firewall')));
  // Words it does not know still name a pane — the one every other grant lives in.
  const other = humanStepView({ kind: 'os-permission', title: 'Grant the thing its permission' });
  assert.ok(other.lines.some((line) => line.includes(OS_PERMISSION_PANE_DEFAULT)));
  assert.equal(settingsPaneFor('Full Disk Access for the runner'), 'System Settings › Privacy & Security › Full Disk Access');
  // A line that already names the pane is not repeated.
  const named = humanStepView({ kind: 'os-permission', title: 'Accessibility', lines: ['Open System Settings › Privacy & Security › Accessibility and tick Terminal.'] });
  assert.equal(named.lines.length, 1);
  // Through the inbox: a ledger step of the kind carries the pane on its row.
  const row = inbox({
    humanSteps: [{
      id: 's1', kind: 'os-permission', title: 'Grant accessibility to the terminal', where: 'host', slug: 'demo', phase: 2,
      declaredAt: '2026-09-30T11:00:00.000Z', state: 'notified',
    }],
  }).find((item) => item.kind === 'human-step');
  assert.ok(row?.humanStep?.lines.some((line) => line.includes('Privacy & Security › Accessibility')));
  assert.equal(row?.humanStep?.stepId, 's1');
  assert.ok(row?.humanStep?.offers.includes('check'));
});

test('HF-7: a physical step carries a QR where its open value is a URL — and only then', () => {
  const pair = humanStepView({ kind: 'physical', title: 'Pair the test phone', openUrl: 'https://pair.example.com/device/42' });
  assert.equal(pair.qr, 'https://pair.example.com/device/42');
  assert.ok(pair.offers.includes('open'));
  const plug = humanStepView({ kind: 'physical', title: 'Plug the phone in', openCommand: 'adb devices' });
  assert.equal(plug.qr, undefined);
  // A link that is not http(s) is never kept, so it never becomes a QR either.
  const bad = humanStepView({ kind: 'physical', title: 'x', openUrl: 'file:///etc/passwd' });
  assert.equal(bad.qr, undefined);
  assert.equal(bad.openUrl, undefined);
  // The QR belongs to `physical`: a sign-in's link opens, it is not scanned.
  assert.equal(humanStepView({ kind: 'browser-login', title: 'x', openUrl: 'https://github.com/login' }).qr, undefined);
});

test('a silent lane\'s suspected turn is raised at once, with the link it saw and a person\'s conversion — never converted', () => {
  const since = new Date(NOW - 11 * 60_000).toISOString();
  const rows = inbox({
    runs: [{
      id: 'r1', slug: 'demo', status: 'running', updatedAt: since,
      phases: {
        3: {
          phase: 3, status: 'running',
          stall: {
            signal: 'silent', since, detail: 'no output for 11 min',
            suspectedStep: { kind: 'browser-login', url: 'https://github.com/login/device', words: 'Open this URL to continue in your web browser', where: 'host', at: since },
          },
        },
      },
    }],
  }).filter((item) => item.kind === 'stall');
  assert.equal(rows.length, 1, 'eleven minutes is under the inbox\'s own silence floor — a suspected turn is raised anyway');
  const row = rows[0]!;
  assert.equal(row.severity, 'needs-you');
  assert.match(row.need, /https:\/\/github\.com\/login\/device/);
  assert.equal(row.humanStep?.suspected, true);
  assert.equal(row.humanStep?.openUrl, 'https://github.com/login/device');
  assert.ok(row.humanStep?.offers.includes('convert'));
  const convert = row.actions.find((action) => action.verb === 'convert-step');
  assert.deepEqual(convert && { endpoint: convert.endpoint, body: convert.body }, {
    endpoint: '/api/human-steps/suspected', body: { slug: 'demo', phase: 3 },
  });

  // Once a person converted it, the step's own row is the ask: the suspicion
  // stands down, and eleven quiet minutes are under the inbox's silence floor.
  const after = inbox({
    runs: [{
      id: 'r1', slug: 'demo', status: 'running', updatedAt: since,
      phases: { 3: { phase: 3, status: 'running', stall: { signal: 'silent', since, detail: 'x', suspectedStep: { kind: 'browser-login', url: 'https://github.com/login/device', words: 'w', where: 'host', at: since } } } },
    }],
    humanSteps: [{
      id: 'c1', kind: 'browser-login', title: "Finish what phase 3's session is waiting on", where: 'host', slug: 'demo', phase: 3,
      runId: 'r1', birth: 'console', declaredAt: since, state: 'notified', openUrl: 'https://github.com/login/device',
    }],
  });
  assert.equal(after.filter((item) => item.kind === 'stall').length, 0);
  assert.equal(after.filter((item) => item.kind === 'human-step').length, 1);
});

test('phase 132: every folded row carries a turn view of the fold\'s kind, and the stall reading draws as its suspected kind', () => {
  const rows = inbox({
    approvals: [
      { id: 't9', runId: 'r1', slug: 'demo', phase: 3, kind: 'tool', title: 'Run `rm -rf build`?', createdAt: '2026-09-30T11:00:00.000Z', status: 'pending' },
    ],
    runs: [{
      id: 'r9', slug: 'demo', status: 'parked', updatedAt: '2026-09-30T10:00:00.000Z', phases: {},
      recoveries: { 3: { errand: { phase: 3, situation: 'verify-red', tried: [], need: 'n', how: 'h', at: '2026-09-30T10:00:00.000Z' } } },
    }],
  });
  const tool = rows.find((row) => row.kind === 'approval');
  assert.equal(tool?.turn?.kind, HUMAN_STEP_FOLDS.approval);
  assert.equal(tool?.turn?.record, 'projected');
  assert.equal(tool?.humanStep, undefined, 'still no person\'s card of its own — that is phase 135\'s');
  const ladder = rows.find((row) => row.kind === 'errand');
  assert.equal(ladder?.turn?.kind, HUMAN_STEP_FOLDS.errand, 'the ladder\'s own ask is an operator act for a person to decide');
  assert.equal(ladder?.turn?.group, 'decide');
});
