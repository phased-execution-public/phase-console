/**
 * GS-1..6 (control-tower phase 149, #212, §Architecture 19) — the five scopes,
 * applied by the server, and what ending each restores.
 *
 * GS-1  `call` — one use, a row in the ledger (never memory): the hook covers
 *       that one call and the run's settings carry the rule lowered for that
 *       run only; spent, the settings are raised again.
 * GS-2  `phase` — the same lane, until the phase settles and 24 hours at most.
 * GS-3  `plan` — the plan's policy file: a shipped deny struck, an allow added;
 *       this plan only.
 * GS-4  `repository` — a layer between the plan's file and the machine's, for
 *       every plan of this console.
 * GS-5  `always` — the machine's file.
 * GS-6  THE TABLE: for every wall × scope, what the grant changes and what its
 *       end restores — and a never rule is never lowered, whatever is asked.
 */

import './state-sandbox.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Grants } = await import('../server/permissions/grants.ts');
type GrantRow = import('../server/permissions/grants.ts').GrantRow;
const {
  DEFAULT_DENY, POLICY_PATH, PUSH_DENY_CARVED, buildSettings, loadPolicyFor, planPolicyPath, policyExtras, repositoryPolicyPath,
} = await import('../server/runner/approvals.ts');
const { GRANT_SCOPES, GRANT_PHASE_MAX_MS } = await import('../shared/turn-model.js');

const NOW = Date.parse('2026-10-07T12:00:00.000Z');

function engine(now = () => NOW) {
  const dir = mkdtempSync(join(tmpdir(), 'pc-grant-scopes-'));
  const file = join(dir, 'grants.ndjson');
  const unit: { flag: string; on: boolean }[] = [];
  const restarts: string[] = [];
  const grants = new Grants({
    file, now,
    capability: (flag, on) => { unit.push({ flag, on }); return { ok: true, unit: join(dir, 'unit.plist') }; },
    restartWhenIdle: (by) => { restarts.push(by); },
  });
  return { grants, file, unit, restarts };
}

/** The settings a run's next child would load, from what holds now. */
function settingsOf(grants: InstanceType<typeof Grants>, slug: string, runId: string) {
  const built = buildSettings({ runId, token: 't'.repeat(43), origin: 'http://127.0.0.1:4130', policy: loadPolicyFor(slug), profile: 'guarded', lowered: grants.lowered(runId) });
  return built.permissions as { deny: string[]; allow: string[] };
}

const lane = (n: string) => ({ slug: `gs-${n}`, phase: 3, runId: `run-${n}` });

test('GS-1: a call grant is one use, kept in the ledger — the hook covers that call, the settings lower the rule for that run only, spent raises it', () => {
  const { grants, file } = engine();
  const at = lane('call');
  const applied = grants.apply({
    scope: 'call', wall: 'deny', tool: 'Bash', rule: 'Bash(git push:*)', command: 'git push origin pe/gs-call',
    ...at, by: 'me', door: 'local', typed: 'Bash(git push:*)',
  });
  assert.ok(applied.ok, JSON.stringify(applied));
  const row = applied.row;
  assert.deepEqual(row.changed.map((change) => change.kind), ['hook', 'settings']);
  assert.equal(row.until, new Date(NOW + GRANT_PHASE_MAX_MS).toISOString(), 'unspent, a call grant still ends within a day');
  assert.match(readFileSync(file, 'utf8'), new RegExp(row.id), 'the row is in the ledger, not in memory');
  assert.equal(new Grants({ file, now: () => NOW }).get(row.id)?.state, 'live', 'a second engine over the same file reads it — a restart loses nothing');

  assert.ok(!settingsOf(grants, at.slug, at.runId).deny.includes('Bash(git push:*)'), 'lowered for THIS run');
  assert.ok(settingsOf(grants, at.slug, 'another-run').deny.includes('Bash(git push:*)'), 'never for another run');

  const spent = grants.spend(row);
  assert.equal(spent?.state, 'spent');
  assert.ok(settingsOf(grants, at.slug, at.runId).deny.includes('Bash(git push:*)'), 'spent, the rule is raised again');
  assert.equal(grants.spend(row), null, 'a spent grant is not spent twice');
});

test('GS-2: a phase grant lives for its lane until the phase settles — 24 hours at most', () => {
  let clock = NOW;
  const { grants } = engine(() => clock);
  const at = lane('phase');
  const applied = grants.apply({ scope: 'phase', wall: 'ask', tool: 'Bash', rule: 'Bash(make deploy:*)', ...at, by: 'me', door: 'local' });
  assert.ok(applied.ok, JSON.stringify(applied));
  assert.deepEqual(applied.row.changed, [{ kind: 'hook', rule: 'Bash(make deploy:*)', runId: at.runId, phase: 3 }], 'an ask is never in the CLI\'s settings: the hook alone');
  assert.deepEqual(grants.sweep(() => false), [], 'nothing ends while the phase works and the clock runs');
  const settled = grants.sweep((row) => row.id === applied.row.id);
  assert.equal(settled[0]?.state, 'expired');
  assert.equal(settled[0]?.endReason, 'its phase settled');

  const again = grants.apply({ scope: 'phase', wall: 'ask', tool: 'Bash', rule: 'Bash(make deploy:*)', ...at, by: 'me', door: 'local' });
  assert.ok(again.ok);
  clock = NOW + GRANT_PHASE_MAX_MS + 1;
  assert.equal(grants.live().length, 0, 'past its clock it is over before the sweep says so');
  assert.equal(grants.sweep(() => false)[0]?.endReason, 'its clock ran out');
});

test('GS-3: a plan grant is the plan\'s policy file — a shipped deny struck for this plan only, an allow added; revoked, both restored', () => {
  const { grants } = engine();
  const deny = grants.apply({ scope: 'plan', wall: 'deny', tool: 'Bash', rule: 'Bash(git push:*)', slug: 'gs-plan', phase: 3, runId: 'r', by: 'me', door: 'local', typed: 'Bash(git push:*)' });
  assert.ok(deny.ok, JSON.stringify(deny));
  const base = { kind: 'policy', layer: 'plan', file: planPolicyPath('gs-plan'), slug: 'gs-plan' };
  assert.deepEqual(deny.row.changed, [
    { ...base, op: 'strike', list: 'deny', rule: 'Bash(git push:*)' },
    ...PUSH_DENY_CARVED.map((rule) => ({ ...base, op: 'add', list: 'deny', rule })),
  ], 'the push wall lifted, the carved never rules written in its place — in the same row');
  assert.ok(!loadPolicyFor('gs-plan').deny.includes('Bash(git push:*)'), 'struck for this plan');
  assert.ok(loadPolicyFor('gs-plan').deny.includes('Bash(git push --force:*)'), 'a forced push stays walled');
  assert.ok(loadPolicyFor('gs-other').deny.includes('Bash(git push:*)'), 'every other plan keeps the wall');
  const allow = grants.apply({ scope: 'plan', wall: 'ask', tool: 'Bash', rule: 'Bash(make release:*)', slug: 'gs-plan', phase: 3, runId: 'r', by: 'me', door: 'local' });
  assert.ok(allow.ok);
  assert.ok(loadPolicyFor('gs-plan').always!.includes('Bash(make release:*)'));

  grants.end(deny.row.id, 'revoked', 'me');
  grants.end(allow.row.id, 'revoked', 'me');
  assert.ok(loadPolicyFor('gs-plan').deny.includes('Bash(git push:*)'), 'the strike is undone');
  assert.deepEqual(policyExtras(planPolicyPath('gs-plan')).deny, [], 'and the carved rules it wrote are gone');
  assert.ok(!loadPolicyFor('gs-plan').always!.includes('Bash(make release:*)'), 'the allow is removed');
  assert.deepEqual(policyExtras(planPolicyPath('gs-plan')).removed.deny, []);
});

test('GS-4: a repository grant is a layer between the plan\'s file and the machine\'s — every plan of this console', () => {
  const { grants } = engine();
  const applied = grants.apply({ scope: 'repository', wall: 'mcp', tool: 'mcp__github__create_issue', rule: 'mcp__github', slug: 'gs-repo', phase: 3, runId: 'r', by: 'me', door: 'local' });
  assert.ok(applied.ok, JSON.stringify(applied));
  assert.deepEqual(applied.row.changed, [{ kind: 'policy', layer: 'repository', file: repositoryPolicyPath(), op: 'add', list: 'allow', rule: 'mcp__github' }]);
  for (const slug of ['gs-repo', 'gs-any', null]) assert.ok(loadPolicyFor(slug).allow.includes('mcp__github'), `every plan: ${slug}`);
  assert.ok(!policyExtras(POLICY_PATH).allow.includes('mcp__github'), 'not the machine\'s file');
  grants.end(applied.row.id, 'revoked', 'me');
  assert.ok(!loadPolicyFor('gs-repo').allow.includes('mcp__github'));
});

test('GS-5: an always grant is the machine\'s file', () => {
  const { grants } = engine();
  const applied = grants.apply({ scope: 'always', wall: 'allow-list', tool: 'WebSearch', rule: 'WebSearch', slug: 'gs-always', phase: 3, runId: 'r', by: 'me', door: 'local', typed: 'WebSearch' });
  assert.ok(applied.ok, JSON.stringify(applied));
  assert.equal((applied.row.changed[0] as { file: string }).file, POLICY_PATH);
  assert.ok(policyExtras(POLICY_PATH).allow.includes('WebSearch'));
  grants.end(applied.row.id, 'revoked', 'me');
  assert.ok(!policyExtras(POLICY_PATH).allow.includes('WebSearch'));
});

/** What each wall × scope grant changes, by kind — the table the engine is held to. */
const WALL_CELLS = [
  { wall: 'deny', tool: 'Bash', rule: 'Bash(git push:*)', command: 'git push origin pe/gs-table', below: ['hook', 'settings'], list: 'deny' },
  { wall: 'ask', tool: 'Bash', rule: 'Bash(make ship:*)', command: 'make ship', below: ['hook'], list: 'allow' },
  { wall: 'allow-list', tool: 'WebSearch', rule: 'WebSearch', command: undefined, below: ['hook', 'settings'], list: 'allow' },
  { wall: 'mcp', tool: 'mcp__linear__create', rule: 'mcp__linear', command: undefined, below: null, list: 'allow' },
] as const;

test('GS-6: THE TABLE — for every wall × scope, what the grant changes and what ending it restores', () => {
  const { grants } = engine();
  for (const cell of WALL_CELLS) {
    for (const scope of GRANT_SCOPES) {
      const at = lane(`t-${cell.wall}-${scope}`);
      const name = `${cell.wall} × ${scope}`;
      const before = { deny: loadPolicyFor(at.slug).deny.includes(cell.rule), allow: loadPolicyFor(at.slug).allow.includes(cell.rule) };
      const applied = grants.apply({
        scope, wall: cell.wall, tool: cell.tool, rule: cell.rule, ...(cell.command ? { command: cell.command } : {}),
        ...at, by: 'me', door: 'local', typed: cell.rule,
      });
      if (cell.below === null && (scope === 'call' || scope === 'phase')) {
        // The hook never sees an MCP tool: a lane grant could not be held to its lane.
        assert.equal(!applied.ok && applied.status, 400, `${name} is refused — the hook never sees ${cell.tool}`);
        continue;
      }
      assert.ok(applied.ok, `${name}: ${JSON.stringify(applied)}`);
      const row: GrantRow = applied.row;
      const kinds = row.changed.map((change) => change.kind);
      if (scope === 'call' || scope === 'phase') {
        assert.deepEqual(kinds, [...cell.below!], `${name} changes the hook and/or this run's settings`);
        const settings = settingsOf(grants, at.slug, at.runId);
        if (cell.wall === 'deny') assert.ok(!settings.deny.includes(cell.rule), `${name} lowers the deny for this run`);
        if (cell.wall === 'allow-list' || cell.wall === 'mcp') assert.ok(settings.allow.includes(cell.rule), `${name} adds the allow for this run`);
        assert.equal(row.until !== null, true, `${name} ends by itself`);
      } else {
        assert.ok(kinds.every((kind) => kind === 'policy'), `${name} edits one policy file`);
        assert.equal(new Set(row.changed.map((change) => (change as { file: string }).file)).size, 1, `${name}: one file`);
        const change = row.changed[0] as { op: string; list: string; layer: string };
        assert.equal(change.list, cell.list, name);
        assert.equal(change.op, cell.wall === 'deny' ? 'strike' : 'add', name);
        assert.equal(change.layer, scope === 'plan' ? 'plan' : scope === 'repository' ? 'repository' : 'machine', name);
        assert.equal(row.until, null, `${name} lives until revoked`);
      }
      const ended = grants.end(row.id, 'revoked', 'me', 'the table');
      assert.equal(ended?.state, 'revoked', name);
      const after = { deny: loadPolicyFor(at.slug).deny.includes(cell.rule), allow: loadPolicyFor(at.slug).allow.includes(cell.rule) };
      assert.deepEqual(after, before, `${name}: its end restores the policy exactly`);
      const settings = settingsOf(grants, at.slug, at.runId);
      assert.equal(settings.deny.includes(cell.rule), DEFAULT_DENY.includes(cell.rule), `${name}: the settings are raised again`);
    }
  }
  // A capability: the machine only — the unit verb and a restart when idle.
  const { grants: g2, unit, restarts } = engine();
  const cap = g2.apply({ scope: 'always', wall: 'capability', tool: 'Bash', rule: '--allow-publish', slug: 'gs-cap', phase: 3, runId: 'r', by: 'me', door: 'local', typed: '--allow-publish' });
  assert.ok(cap.ok, JSON.stringify(cap));
  assert.deepEqual(cap.row.changed.map((change) => change.kind), ['capability']);
  assert.deepEqual(unit, [{ flag: '--allow-publish', on: true }]);
  assert.deepEqual(restarts, ['me'], 'and a restart when idle is asked for');
  g2.end(cap.row.id, 'revoked', 'me');
  assert.deepEqual(unit.at(-1), { flag: '--allow-publish', on: false }, 'revoked, the switch leaves the unit');
  // A revoke that cannot undo what the grant changed leaves it live, and says so.
  const stuck = new Grants({ file: join(mkdtempSync(join(tmpdir(), 'pc-grant-stuck-')), 'grants.ndjson'), capability: (_flag, on) => (on ? { ok: true } : { ok: false, why: 'the unit is unreadable' }) });
  const held = stuck.apply({ scope: 'always', wall: 'capability', tool: 'Bash', rule: '--allow-publish', slug: 'gs-cap', phase: 3, runId: 'r', by: 'me', door: 'local', typed: '--allow-publish' });
  assert.ok(held.ok);
  assert.equal(stuck.end(held.row.id, 'revoked', 'me'), null, 'the revoke is refused');
  assert.equal(stuck.get(held.row.id)?.state, 'live', 'so the row stays live — it never claims an undo it did not make');
});

test('GS-6: a never rule is never lowered in a run\'s settings, whatever a grant asks', () => {
  const built = buildSettings({
    runId: 'r', token: 't'.repeat(43), origin: 'http://127.0.0.1:4130', policy: loadPolicyFor('gs-never'), profile: 'guarded',
    lowered: { deny: ['Bash(git push --force:*)', 'Bash(sudo:*)', 'Bash(git push:*)'], allow: [] },
  }).permissions as { deny: string[] };
  assert.ok(built.deny.includes('Bash(sudo:*)'), 'the host family stands');
  assert.ok(!built.deny.includes('Bash(git push:*)'), 'a grantable rule is lowered');
  for (const rule of PUSH_DENY_CARVED) assert.ok(built.deny.includes(rule), `the push wall lowered, ${rule} stands in its place`);
});
