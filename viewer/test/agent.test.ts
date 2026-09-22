/**
 * The agent launch composer.
 *
 * Everything here is pure — `buildAgentLaunch` in, a `LaunchSpec` or a named
 * refusal out — so the whole validation table and the composed plan prompt
 * are asserted without a console, a pty, or the `claude` CLI anywhere near
 * the test. The registry-level behavior (gating, spawn, labels, reaping)
 * lives in terminal.test.ts; this file is about what gets composed.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  buildAgentLaunch, phasedExecutionSkillId, planPrompt, resumedLabel,
  MAX_AGENT_PROMPT_BYTES, MAX_BRIEF_BYTES, type PlanFacts,
} from '../server/agent.ts';
import { MANIFEST_QUESTIONS, PLAN_FIELDS, STATE_FLAGS, accountedFlags } from '../server/plan-fields.ts';
import { DECISION_KEYS } from '../shared/decisions-model.js';
import { POLICY_DEFAULTS } from '../shared/policy-model.js';
import type { SkillInfo } from '../server/skills.ts';
import { scriptFlags } from './script-flags.ts';

const PHASE_GRAPH = fileURLToPath(new URL('../../scripts/phase-graph.sh', import.meta.url));

const CTX = {
  skills: (): SkillInfo[] => [],
  scriptsDir: '/opt/phased-execution/scripts',
  rootOpen: true,
};

function skill(id: string): SkillInfo {
  const name = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
  return { id, name, description: '', source: 'personal', path: `/skills/${name}/SKILL.md` };
}

test('a full request becomes exactly the argv the CLI needs, prompt last', () => {
  const built = buildAgentLaunch({
    kind: 'claude', model: 'opus', effort: 'max', permissionMode: 'acceptEdits',
    prompt: 'Fix the flaky auth tests and commit.', skills: ['design-review'],
  }, CTX);
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const { launch } = built;
  assert.equal(launch.kind, 'claude');
  assert.equal(launch.file, 'claude');
  const id = launch.meta?.claudeSessionId ?? '';
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

  const prompt = launch.args[launch.args.length - 1];
  assert.deepEqual(launch.args.slice(0, -1), [
    '--session-id', id,
    '--permission-mode', 'acceptEdits',
    '--model', 'opus',
    '--effort', 'max',
    '--name', 'Claude: Fix the flaky auth tests and commit.',
  ]);
  assert.match(prompt, /^Fix the flaky auth tests and commit\./);
  assert.match(prompt, /\/design-review/);
  assert.equal(launch.args.filter((a) => a.startsWith('Fix the flaky auth')).length, 1,
    'the prompt appears exactly once, as the positional');
  assert.equal(launch.label, 'Claude: Fix the flaky auth tests and commit.');
  assert.deepEqual(launch.meta, {
    model: 'opus', effort: 'max', permissionMode: 'acceptEdits', claudeSessionId: id,
  });
});

test('empty selections mean the CLI default — no flag at all', () => {
  const built = buildAgentLaunch({ kind: 'claude', model: '', effort: '', permissionMode: '' }, CTX);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.launch.args[0], '--session-id');
  assert.equal(built.launch.args.length, 2, 'a bare TUI: a session id and nothing else');
  assert.equal(built.launch.label, undefined);
  assert.deepEqual(Object.keys(built.launch.meta ?? {}), ['claudeSessionId']);
});

test('every off-list value is refused by name, and nothing is guessed', () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ model: 'gpt-4' }, /model must name a Claude model/],
    [{ effort: 'ultra' }, /effort must be one of/],
    [{ permissionMode: 'bypassPermissions' }, /permission mode must be one of/],
    // `default` is real at the CLI, but the vocabulary is the runner's — the
    // way to ask for the default is to not choose one.
    [{ permissionMode: 'default' }, /permission mode must be one of/],
    [{ prompt: '-p sneaky' }, /may not begin with '-'/],
    [{ prompt: 'x'.repeat(MAX_AGENT_PROMPT_BYTES + 1) }, /too long/],
    [{ resume: 'not-a-uuid' }, /uuid/],
    [{ resume: '00000000-0000-4000-8000-000000000000', prompt: 'hi' }, /mutually exclusive/],
    [{ intent: 'chaos' }, /must be 'plan'/],
    [{ intent: 'plan' }, /needs a brief/],
    [{ intent: 'plan', brief: 'b'.repeat(MAX_BRIEF_BYTES + 1) }, /too long/],
    [{ intent: 'plan', brief: 'x', prompt: 'y' }, /composes its own prompt/],
    [{ intent: 'plan', brief: 'x', resume: '00000000-0000-4000-8000-000000000000' }, /mutually exclusive/],
  ];
  for (const [body, why] of cases) {
    const built = buildAgentLaunch(body, CTX);
    assert.equal(built.ok, false, JSON.stringify(body));
    if (!built.ok) {
      assert.equal(built.status, 400, JSON.stringify(body));
      assert.match(built.error, why);
    }
  }
});

test('every spelling the CLI takes is accepted, not just the four aliases', () => {
  // The launcher used to validate against MODEL_FALLBACK — the escalation
  // ladder — so `claude-opus-5`, the CLI's own documented example, was a 400,
  // and there was no way at all to ask for the 1M window.
  for (const model of ['opus', 'claude-opus-5', 'claude-opus-5[1m]', 'opus[1m]', 'opusplan']) {
    const built = buildAgentLaunch({ kind: 'claude', model, prompt: 'go' }, CTX);
    assert.equal(built.ok, true, `${model} must be accepted`);
    if (!built.ok) continue;
    const argv = built.launch.args;
    const at = argv.indexOf('--model');
    assert.ok(at >= 0, `${model} must reach argv`);
    assert.equal(argv[at + 1], model, 'and reach it byte-for-byte — brackets included');
  }
});

test('a plan brief with no source directory open is a 409, not a 400', () => {
  const built = buildAgentLaunch(
    { kind: 'claude', intent: 'plan', brief: 'ship it' },
    { ...CTX, rootOpen: false },
  );
  assert.equal(built.ok, false);
  if (!built.ok) {
    assert.equal(built.status, 409);
    assert.match(built.error, /No source directory/);
  }
});

test('a forbidden flag as prompt TEXT survives as prose, never as a flag', () => {
  const built = buildAgentLaunch({
    kind: 'claude',
    prompt: 'explain what --dangerously-skip-permissions does',
  }, CTX);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const last = built.launch.args[built.launch.args.length - 1];
  assert.equal(last, 'explain what --dangerously-skip-permissions does');
  assert.ok(!built.launch.args.slice(0, -1).includes('--dangerously-skip-permissions'),
    'never a standalone argv slot — only quoted inside the prompt and the label derived from it');
});

test('the plan prompt invokes the id the child can actually resolve', () => {
  assert.equal(phasedExecutionSkillId([]), 'phased-execution');
  assert.equal(phasedExecutionSkillId([skill('phased-execution')]), 'phased-execution');
  assert.equal(phasedExecutionSkillId([skill('tools:phased-execution')]), 'tools:phased-execution');
  assert.equal(
    phasedExecutionSkillId([skill('tools:phased-execution'), skill('phased-execution')]),
    'phased-execution',
    'an exact bare id wins over a plugin’s namespaced one',
  );
});

test('the composed plan prompt walks Mode 1 end to end and carries the brief', () => {
  const built = buildAgentLaunch({
    kind: 'claude', intent: 'plan', brief: 'Add rate limiting to the public API.',
    skills: ['phased-execution', 'design-review'],
  }, { ...CTX, skills: () => [skill('phased-execution')] });
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const text = built.launch.args[built.launch.args.length - 1];
  for (const needle of [
    'Invoke the phased-execution skill',
    'new-plan.sh', 'phase-graph.sh', 'validate.sh', 'Commit',
    'STOP and summarise',
    'Add rate limiting to the public API.',
  ]) {
    assert.ok(text.includes(needle), needle);
  }
  // The plan skill is the subject of the prompt, not a second, competing
  // directive; the extra skill still gets its line.
  assert.ok(!text.includes('): /phased-execution'), 'no directive re-names the plan skill');
  assert.match(text, /\/design-review/);
  assert.equal(built.launch.label, 'Plan: Add rate limiting to the public API.');
  assert.equal(built.launch.meta?.intent, 'plan');
  // The prompt matches the mode it is launched in: present first, write after
  // approval. Without both halves the session can scaffold and commit a plan
  // nobody has read, which is the decision the wizard exists to put in front
  // of a person.
  assert.match(text, /starts in PLAN MODE/);
  assert.match(text, /write nothing until the operator approves/);
  assert.ok(
    text.indexOf('After the operator approves') < text.indexOf('new-plan.sh'),
    'the scaffold step is on the far side of the approval',
  );
});

/* ------------------------------------------------------------------ *
 * The wizard's questions ↔ the engine's plan fields (zero-touch phase 12,
 * chapter 10 ZTD-11): the console's own front door once asked about none of
 * the fields the skill's Mode 1 elicits. The coupling is the same one
 * `skill-sync.test.ts` holds on the capability flags — read the script's
 * flag list, and hold the prompt to it.
 * ------------------------------------------------------------------ */

test('every phase-graph.sh flag is a plan field the wizard asks, or a state flag with a reason — and nothing stale', () => {
  const flags = scriptFlags(readFileSync(PHASE_GRAPH, 'utf8'));
  assert.ok(flags.size >= 30, `the flag reader found ${flags.size} flags`);
  const accounted = accountedFlags();
  const unaccounted = [...flags].filter((flag) => !accounted.has(flag));
  assert.deepEqual(unaccounted, [],
    'these flags read something back that the wizard never asks — add a PLAN_FIELDS entry, or a STATE_FLAGS reason');
  const stale = [...accounted].filter((flag) => !flags.has(flag));
  assert.deepEqual(stale, [], 'these entries name a flag phase-graph.sh no longer implements');
  // A flag is one or the other, never both.
  for (const field of PLAN_FIELDS) {
    for (const flag of field.flags) assert.ok(!(flag in STATE_FLAGS), `${flag} is listed as both a field and state`);
  }
});

test('planPrompt asks every manifest key and every machine-read plan field, numbered, one at a time, defaults first', () => {
  const text = planPrompt('a brief', 'phased-execution', CTX.scriptsDir);
  assert.match(text, /ONE QUESTION AT A TIME/);
  assert.match(text, /wait for the answer before the next/);
  // Q1…Qn, contiguous, in the manifest's order followed by the fields'.
  const numbers = [...text.matchAll(/^\s+Q(\d+)\. /gm)].map((m) => Number(m[1]));
  assert.equal(numbers.length, DECISION_KEYS.length + PLAN_FIELDS.length);
  assert.deepEqual(numbers, numbers.map((_, i) => i + 1), 'numbered without a gap');
  DECISION_KEYS.forEach((key, i) => {
    assert.ok(text.includes(`Q${i + 1}. \`${key}\` — ${MANIFEST_QUESTIONS[key]}`), `manifest key ${key} is question ${i + 1}`);
    const fallback = POLICY_DEFAULTS[key as keyof typeof POLICY_DEFAULTS];
    if (fallback) assert.ok(text.includes(`\`${key}\` — ${MANIFEST_QUESTIONS[key]} (default ${fallback})`), `${key} names its default`);
  });
  PLAN_FIELDS.forEach((field, i) => {
    assert.ok(text.includes(`Q${DECISION_KEYS.length + i + 1}. ${field.field} — `), `plan field ${field.field} is asked`);
    assert.ok(text.includes(field.home), `${field.field} says where it is written`);
  });
  // The manifest is presented FILLED IN before anything is written, and the
  // questions come before the approval, which comes before the scaffold.
  assert.match(text, /"## Decisions" table with EVERY\s+row answered, waived or owned/);
  assert.ok(text.indexOf('Q1. ') < text.indexOf('After the operator approves'), 'asked before approval');
  assert.ok(text.indexOf('EVERY') < text.indexOf('After the operator approves'), 'shown before approval');
  assert.ok(text.indexOf('After the operator approves') < text.indexOf('new-plan.sh'), 'written after');
  assert.match(text, /phase-graph\.sh <slug> --decisions/, 'and read back');
});

test('planPrompt opens by reading the repository\'s ledgers — outstanding keys, keyed rulings, promoted answers', () => {
  const facts: PlanFacts = {
    plans: 3,
    outstanding: [
      { key: 'credentials', plans: ['shop', 'site', 'hub', 'fleet'] },
      { key: 'human-acts', plans: ['shop'] },
    ],
    rulings: [
      { slug: 'shop', phase: 4, key: 'waits', what: 'the window is the cap', at: '2026-09-14T00:00:00Z' },
      { slug: 'site', phase: 2, key: 'qa.exhausted', what: 'x'.repeat(300), at: '2026-09-13T00:00:00Z' },
    ],
    promoted: 2,
  };
  const text = planPrompt('a brief', 'phased-execution', CTX.scriptsDir, '', facts);
  assert.match(text, /Open by reading this repository's ledgers/);
  assert.match(text, /3 open plans, 2 answers promoted from rulings/);
  assert.match(text, /`credentials` \(4 plans: shop, site, hub, …\)/, 'the plans are named, bounded');
  assert.match(text, /`human-acts` \(1 plan: shop\)/);
  assert.match(text, /ask these first/);
  assert.match(text, /shop phase 4 · `waits`: the window is the cap/);
  assert.ok(!text.includes('x'.repeat(120)), 'a long ruling is cut, never the prompt');
  assert.ok(text.indexOf('Open by reading') < text.indexOf('Q1. '), 'the ledgers come before the questions');
  // The digest is bounded: forty outstanding keys and a hundred rulings add a
  // few hundred bytes, not a kilobyte per row.
  const flood: PlanFacts = {
    plans: 200,
    outstanding: DECISION_KEYS.map((key) => ({ key, plans: Array.from({ length: 50 }, (_, i) => `plan-${i}`) })),
    rulings: Array.from({ length: 100 }, (_, i) => ({ slug: `p${i}`, phase: 1, key: 'waits', what: 'w'.repeat(500), at: '2026-09-14T00:00:00Z' })),
    promoted: 9,
  };
  const wide = planPrompt('a brief', 'phased-execution', CTX.scriptsDir, '', flood);
  assert.ok(Buffer.byteLength(wide) - Buffer.byteLength(text) < 1_500, `the digest grew by ${Buffer.byteLength(wide) - Buffer.byteLength(text)} bytes`);
  assert.match(wide, /and \d+ more/);

  // No root open: the prompt says nothing was read rather than pretending.
  const blind = planPrompt('a brief', 'phased-execution', CTX.scriptsDir);
  assert.match(blind, /nothing could be read for you/);
  assert.match(blind, /docs\/handoffs\/<slug>\/decisions\.md/);
});

test('the wizard prompt fits an 8 KB brief with room for issues at the cap', () => {
  // The cap moved 16 → 32 KB in phase 12 for exactly this arithmetic: the
  // questions and the digest are ~6 KB of fixed text, and the brief is the
  // operator's. `issues.test.ts` pins the twenty-issue case; this pins the
  // template's own size so a future question does not eat the brief.
  const template = Buffer.byteLength(planPrompt('', 'phased-execution', CTX.scriptsDir));
  assert.ok(template < 10 * 1024, `the template is ${template} bytes`);
  assert.ok(template + MAX_BRIEF_BYTES + 4 * 1024 < MAX_AGENT_PROMPT_BYTES, 'template + brief + issues fit');
});

test('a plan session starts in plan mode without anyone asking for it', () => {
  const built = buildAgentLaunch({ kind: 'claude', intent: 'plan', brief: 'ship it' }, CTX);
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const { args } = built.launch;
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(built.launch.meta?.permissionMode, 'plan',
    'meta reports the mode the process actually runs under, so the page can label it');
});

test('an explicit permission mode beats the plan default — the form is a real choice', () => {
  for (const mode of ['acceptEdits', 'manual'] as const) {
    const built = buildAgentLaunch(
      { kind: 'claude', intent: 'plan', brief: 'ship it', permissionMode: mode },
      CTX,
    );
    assert.equal(built.ok, true);
    if (!built.ok) return;
    const { args } = built.launch;
    assert.equal(args[args.indexOf('--permission-mode') + 1], mode);
    assert.equal(built.launch.meta?.permissionMode, mode);
    assert.equal(args.filter((a) => a === '--permission-mode').length, 1,
      'one mode flag, never the default alongside the override');
  }
});

test('the plan default is the plan intent’s alone — a bare session still has none', () => {
  const built = buildAgentLaunch({ kind: 'claude', prompt: 'just talk to me' }, CTX);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.ok(!built.launch.args.includes('--permission-mode'),
    'the CLI’s own default stays an omission for every other session');
  assert.equal(built.launch.meta?.permissionMode, undefined);
});

/**
 * Does `text` name `secret` as a token of its own, rather than by accident?
 *
 * A bare `includes()` reads an identity out of any word that merely contains it,
 * and short hostnames are the trap: this machine answers to `Mac`, which lives
 * inside the ordinary word "machine" — so the neutrality tests failed on the one
 * laptop the console is developed on and passed everywhere else. A real leak
 * names the identity standing alone — a home directory, a `user@host`, a bare
 * hostname — and every delimiter that surrounds one of those is non-alphanumeric.
 */
function namesLocalIdentity(text: string, secret: string): boolean {
  const literal = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9])${literal}(?![A-Za-z0-9])`, 'i').test(text);
}

test('the committed template is neutral — the scrub patterns find nothing', () => {
  // Derived, never spelled out. This file ships in a public repository, and a
  // test that lists the operator's real name and employer in order to forbid
  // them publishes exactly what it is defending.
  const scriptsDir = '/opt/phased-execution/scripts';
  const text = planPrompt('a neutral brief about a cart api', 'phased-execution', scriptsDir);

  for (const secret of [userInfo().username, hostname(), homedir()]) {
    // A single-character username would match everything; nothing real is that short.
    if (secret.length < 3) continue;
    assert.ok(!namesLocalIdentity(text, secret), `template names ${secret.length} chars of local identity`);
  }
  assert.ok(!/\.ts\.net\/[a-z]/i.test(text), 'template names a tailnet');
  // The structural rule the literals were a proxy for: the only absolute path a
  // committed template may carry is the one its caller passed in.
  for (const found of text.match(/(?:\/Users\/|\/home\/|\/opt\/)[\w.\-/]+/g) ?? []) {
    assert.ok(found.startsWith(scriptsDir), `template names ${found}`);
  }
});

test('labels are the operator’s words, shortened honestly', () => {
  const long = 'Rebuild the entire notification pipeline with queues and retries and dashboards';
  const built = buildAgentLaunch({ kind: 'claude', prompt: long }, CTX);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const label = built.launch.label ?? '';
  assert.ok(label.startsWith('Claude: Rebuild the entire notification'), label);
  assert.ok(label.endsWith('…'), label);
  assert.ok(label.length <= 'Claude: '.length + 48, label);
});

test('extra skills are shaped, deduped and capped — bad ids dropped, not fatal', () => {
  const built = buildAgentLaunch({
    kind: 'claude', prompt: 'hi',
    skills: ['design-review', 'design-review', 'bad id!!', 'plug:tool.x', 123],
  }, CTX);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const text = built.launch.args[built.launch.args.length - 1];
  assert.match(text, /\/design-review, \/plug:tool\.x/);
  assert.ok(!text.includes('bad id'));
});

test('resume swaps the session id for --resume and carries no prompt', () => {
  const built = buildAgentLaunch({
    kind: 'claude', resume: '11111111-2222-4333-8444-555555555555', model: 'opus',
  }, CTX);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.deepEqual(built.launch.args, [
    '--resume', '11111111-2222-4333-8444-555555555555',
    '--model', 'opus',
  ]);
  assert.equal(built.launch.meta?.claudeSessionId, '11111111-2222-4333-8444-555555555555',
    'the meta still names the claude session a future resume would target');
});

/**
 * 🔴 Where a resumed session RUNS, which is not where the console does.
 *
 * Measured against the real CLI (2.1.243) rather than assumed, because the
 * assumption was wrong in the safe direction: `--resume <uuid>` resolves the
 * conversation GLOBALLY. Resuming a session that was working in a
 * SUBMODULE from a console rooted at the superproject does not fail — it works, appends its
 * turns to that same transcript, and records the new cwd in them. The session
 * comes up looking correct with different relative paths, a different git
 * repository and a different project `CLAUDE.md` loaded, and nothing says so.
 *
 * Which is exactly why it is pinned here: an error would have announced
 * itself. (The live registry on this machine holds sessions from 5 distinct
 * directories, so this is not hypothetical.)
 */
test('a resume starts in the CONVERSATION’s directory, not the console’s root', () => {
  const built = buildAgentLaunch({
    kind: 'claude', resume: '11111111-2222-4333-8444-555555555555',
  }, { ...CTX, resumeTarget: { cwd: '/w/other-repo' } });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.launch.cwd, '/w/other-repo');
});

test('an id the registry does not know composes exactly what it always did', () => {
  // The ended-session banner resumes a pty this console started and may know
  // nothing else about it. That path must keep landing on the open root.
  const built = buildAgentLaunch({
    kind: 'claude', resume: '11111111-2222-4333-8444-555555555555',
  }, CTX);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.launch.cwd, undefined, 'no cwd ⇒ terminal.ts keeps using the open root');
  assert.equal(built.launch.label, undefined, 'and the terminal registry names it Claude N, as before');
});

test('a cwd is only ever taken from the registry — never from the body', () => {
  // The browser sends ids; the server reads facts. A body field would be a new
  // way to start a process in an arbitrary directory, which is the one thing
  // `LaunchSpec.cwd` says it is not for.
  const built = buildAgentLaunch({
    kind: 'claude', resume: '11111111-2222-4333-8444-555555555555', cwd: '/etc',
  }, CTX);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.launch.cwd, undefined);
});

test('a resumed session is named after what the registry says it is', () => {
  const target = { cwd: '/w/hub', plan: { slug: 'console-speed-and-sync', phase: 8 } };
  const built = buildAgentLaunch({
    kind: 'claude', resume: '11111111-2222-4333-8444-555555555555',
  }, { ...CTX, resumeTarget: target });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.launch.label, 'Resumed: console-speed-and-sync · P8');
  assert.ok(built.launch.args.includes('--name'), 'and the CLI is told, so its own picker agrees');
});

test('resumedLabel falls back plan → owner → nothing', () => {
  assert.equal(resumedLabel({ plan: { slug: 'p', phase: 2 }, owner: 'autopilot/x' }), 'Resumed: p · P2');
  assert.equal(resumedLabel({ owner: 'autopilot/5aa1945c' }), 'Resumed: autopilot/5aa1945c');
  assert.equal(resumedLabel({ kind: 'autopilot' }), 'Resumed: autopilot session');
  assert.equal(resumedLabel({ cwd: '/w' }), undefined, 'a bare cwd names nothing');
  assert.equal(resumedLabel(undefined), undefined);
});

test('a recovery ticket honors model, effort and skills — the dialog depends on it', () => {
  // Pinned because the launch dialog now offers all three on every recovery
  // click: these are generic body fields, and a refactor that special-cased
  // the recovery intent out of them would break the dialog silently.
  const built = buildAgentLaunch({
    kind: 'claude', intent: 'recovery', model: 'sonnet', effort: 'high',
    skills: ['design-review'],
  }, {
    ...CTX,
    recovery: {
      class: 'plan-repair', slug: 'alpha',
      scriptsDir: '/opt/phased-execution/scripts', skillId: 'phased-execution',
      issues: [{ kind: 'index-drift', message: 'INDEX says done, handoff says blocked' }],
    } as never,
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.ok(built.launch.args.includes('--model'), 'the model flag rides');
  assert.equal(built.launch.args[built.launch.args.indexOf('--model') + 1], 'sonnet');
  assert.equal(built.launch.args[built.launch.args.indexOf('--effort') + 1], 'high');
  const prompt = built.launch.args[built.launch.args.length - 1];
  assert.match(prompt, /\/design-review/, 'picked skills reach the recovery prompt');
  assert.match(prompt, /plan-repair|Repair/i, 'and it is still the recovery briefing');
});

test('the wizard asks the launch words as one block, in the order the plan authored them, after the issues key (phase 15)', () => {
  // The nine plan fields many-plans-one-repo phase 2 added (plus the per-phase
  // `Isolation:` phase 7 slotted among them) are what the launch form's seven
  // run fields read through — a run's word speaks only where the plan is
  // silent, so a plan whose wizard never asked the question is a plan whose
  // operator never chose. Contiguous, so a reader of the prompt meets them as
  // one decision; and `issues` is asked as a MANIFEST key before any of them.
  const block = ['Landing', 'Base branch', 'Gitlink', 'On conflict', 'Isolation', 'Clash zones',
    'Repo capacity', 'Worktree retention', 'Messaging', 'Issues'];
  const names = PLAN_FIELDS.map((f) => f.field);
  const start = names.indexOf('Landing');
  assert.ok(start >= 0, 'Landing is a plan field');
  assert.deepEqual(names.slice(start, start + block.length), block, 'the landing family is one contiguous block, in the plan\'s order');
  const text = planPrompt('a brief', 'phased-execution', CTX.scriptsDir);
  const issuesKey = text.indexOf('`issues` —');
  const landingField = text.indexOf('. Landing — ');
  assert.ok(issuesKey >= 0 && landingField > issuesKey, 'the issues manifest key is asked before the Landing field');
  // Every run field has a question: the form's word is never the only place it was ever chosen.
  for (const field of ['Base branch', 'Repo capacity', 'Worktree retention', 'Landing', 'On conflict', 'Messaging', 'Issues']) {
    assert.ok(text.includes(`. ${field} — `), `${field} is asked`);
  }
});
