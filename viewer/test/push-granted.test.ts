/**
 * The `granted` push (control-tower phase 149, #212) — the twentieth category:
 * one push per grant applied, not urgent, on by default, landing where every
 * grant is listed and revoked.
 */

import './state-sandbox.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SLUG, harness } from './turn-harness.ts';

const { CATEGORIES, categoryOf, defaultCategories, grantedPush, routeFor } = await import('../server/push/catalogue.ts');

test('the twentieth category is `granted`: not urgent, on by default, landing on Settings ▸ Permissions', () => {
  assert.equal(CATEGORIES.length, 20);
  const granted = categoryOf('granted');
  assert.equal(granted.label, 'Permission granted');
  assert.equal(granted.urgent, false, 'a record of authority given, never a wall');
  assert.equal(granted.byDefault, true);
  assert.equal(defaultCategories().granted, true);
  assert.equal(routeFor('granted', { slug: SLUG, phase: 3 }), '/#/settings/permissions');
});

test('its payload: who, the rule, the reach, the end, what it changed — tagged by the grant', () => {
  const push = grantedPush({
    id: 'g-0123456789ab', by: 'operator', rule: 'Bash(git push:*)', scope: 'phase', until: '2026-10-08T10:00:00.000Z', door: 'local',
    changed: [{ kind: 'hook' }, { kind: 'settings' }], slug: SLUG, phase: 3,
  });
  assert.equal(push.title, 'Granted: Bash(git push:*)');
  assert.equal(push.tag, 'granted:g-0123456789ab');
  assert.equal(push.body, 'operator (local) granted Bash(git push:*) for this phase, until 2026-10-08T10:00Z at the latest — alpha · phase 3. Changed: hook, settings.');
  const wide = grantedPush({ id: 'g-1', by: 'me', rule: 'WebSearch', scope: 'always', until: null, door: null, changed: [], slug: null, phase: null });
  assert.match(wide.body, /for every plan on this machine, until revoked — this console\. Changed: nothing — it was already so\./);
});

test('a grant applied is announced once, in `granted`', () => {
  const h = harness();
  try {
    const applied = h.svc.grantsNow().apply({ scope: 'plan', wall: 'ask', tool: 'Bash', rule: 'Bash(make push:*)', slug: SLUG, phase: 3, runId: 'r', by: 'me', door: 'local' });
    assert.ok(applied.ok);
    const announced = (h.pushes as unknown[][]).filter((args) => args[0] === 'granted');
    assert.equal(announced.length, 1);
    const message = announced[0]![1] as { title: string; body: string; tag: string };
    assert.equal(message.title, 'Granted: Bash(make push:*)');
    assert.equal(message.tag, `granted:${applied.row.id}`);
    h.svc.grantsNow().end(applied.row.id, 'revoked', 'me');
    assert.equal((h.pushes as unknown[][]).filter((args) => args[0] === 'granted').length, 1, 'an end is journalled, never pushed');
  } finally { h.cleanup(); }
});
