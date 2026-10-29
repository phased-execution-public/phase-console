/**
 * Per-phase plugin sets (measured-console phase 27, D5): one owner,
 * `shared/plugin-sets.js`, and its bash twin `scripts/plugin-sets.env`, which
 * `phase-graph.sh --plugins` and F48 read. The failure this holds off: an entry
 * added to the table and not the env — the console would switch a plugin on
 * for a phase while the engine's `--plugins N` and its listing budget never
 * counted it, so F48 would advise on a set that is not the one the session gets.
 *
 * Needs no environment and no plan library: it runs on a bare clone.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { SKILL_DIR } from '../server/config.ts';
import {
  PLUGIN_KINDS, PLUGIN_SETS, PLUGIN_EDITIONS, UNATTENDED_WORDS, PLUGIN_MISSING_REASONS, PLUGIN_LISTING,
  entryIsSkill, entryPlugin, isPluginKind, pluginEntriesFor, pluginKindsOf, pluginListingBudget, pluginWordsOf,
} from '../shared/plugin-sets.js';
import { phasePluginsJournal, resolvePhasePlugins, type SessionLoads } from '../server/runner/loads.ts';

const ENV = join(SKILL_DIR, 'scripts', 'plugin-sets.env');

/** One variable out of the env, exactly as `phase-graph.sh` would read it. */
function fromBash(name: string): string {
  return execFileSync('bash', ['-c', `. "${ENV}"; printf '%s' "$${name}"`], { encoding: 'utf8' });
}

test('the bash twin carries the same kinds and, per kind, the same entries in the same order', () => {
  assert.deepEqual(fromBash('PLUGIN_KINDS').split(' '), [...PLUGIN_KINDS]);
  for (const kind of PLUGIN_KINDS) {
    const words = fromBash(`PLUGIN_SET_${kind}`).split(' ').filter(Boolean);
    assert.deepEqual(words, PLUGIN_SETS[kind].map((entry) => entry.name), `PLUGIN_SET_${kind}`);
  }
  assert.deepEqual(Object.keys(PLUGIN_SETS), [...PLUGIN_KINDS], 'one set per kind, in the kinds\' order');
});

test('the listing budget is the same rule on both sides', () => {
  assert.equal(Number(fromBash('PLUGIN_LISTING_PCT')), PLUGIN_LISTING.pct);
  assert.equal(Number(fromBash('PLUGIN_ENTRY_CHARS')), PLUGIN_LISTING.entryChars);
  assert.equal(Number(fromBash('PLUGIN_CHARS_PER_TOKEN')), PLUGIN_LISTING.charsPerToken);
  assert.equal(Number(fromBash('PLUGIN_WINDOW')), PLUGIN_LISTING.window);
  assert.equal(Number(fromBash('PLUGIN_WINDOW_1M')), PLUGIN_LISTING.window1m);
  assert.deepEqual(pluginListingBudget(5, 'claude-opus-5'), { cost: 7680, budget: 8000, over: false });
  assert.deepEqual(pluginListingBudget(6, 'claude-opus-5'), { cost: 9216, budget: 8000, over: true });
  assert.deepEqual(pluginListingBudget(10, 'claude-opus-5[1m]'), { cost: 15360, budget: 40000, over: false });
  assert.equal(pluginListingBudget(6, undefined).over, true, 'no model reads as the 200 K window');
});

test('every entry is a qualified name with an edition and an unattended word from the owner\'s lists', () => {
  for (const kind of PLUGIN_KINDS) {
    for (const entry of PLUGIN_SETS[kind]) {
      assert.match(entry.name, /^[a-z0-9][\w.-]*(?:[@:][a-z0-9][\w.-]*)?$/i, entry.name);
      assert.ok((PLUGIN_EDITIONS as readonly string[]).includes(entry.edition), `${entry.name} edition`);
      assert.ok((UNATTENDED_WORDS as readonly string[]).includes(entry.unattended), `${entry.name} unattended`);
      if (entry.unattended === 'pinned' || entry.unattended === 'operator-set') {
        assert.ok(entry.env && Object.keys(entry.env).length, `${entry.name}: a ${entry.unattended} entry names its env`);
      }
      if (entry.unattended === 'operator-set') assert.ok(entry.requires, `${entry.name}: names the operator's act`);
    }
  }
});

test('the words of a Plugins line: backticks optional, commas or spaces, case folded, deduped; only kinds bring entries', () => {
  assert.deepEqual(pluginWordsOf('`Review`, ui  review,revew'), ['review', 'ui', 'revew']);
  assert.deepEqual(pluginWordsOf(undefined), []);
  assert.deepEqual(pluginKindsOf(['review', 'revew', 'ui']), ['review', 'ui']);
  assert.ok(isPluginKind('docs') && !isPluginKind('Docs') && !isPluginKind('toString'));
  const names = pluginEntriesFor(['review', 'review', 'nope']).map((e) => e.name);
  assert.deepEqual(names, PLUGIN_SETS.review.map((e) => e.name), 'a kind named twice is one set; a typo brings nothing');
  assert.equal(entryPlugin('code-review@claude-plugins-official'), 'code-review');
  assert.equal(entryPlugin('mattpocock-skills:to-tickets'), 'mattpocock-skills');
  assert.equal(entryPlugin('dataviz'), null);
  assert.ok(entryIsSkill('dataviz') && entryIsSkill('a:b') && !entryIsSkill('a@b'));
});

