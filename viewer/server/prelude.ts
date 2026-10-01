/**
 * The run-start PRELUDE (phase 11 — sep-review chapter 13 §1.2; ZTD-2, QRL-2,
 * ACT-9, the delivery clause of ACC-10.1): everything a run could ask a person
 * mid-run, asked at the door instead — and refused there.
 *
 * Three things happen before a token is spent:
 *
 *   1. The decision MANIFEST is rendered: the plan's `## Decisions` rows with
 *      the twin merged over them, and every key the plan did not write
 *      SYNTHESISED — from the launch form's own answers (`resume.on-restart`,
 *      `relay`, `accounts`, `permission.policy`), from the plan's other lines
 *      (`credentials`, `mcp`), or from the policy table's shipped default.
 *      A synthesised row is never `outstanding`: a plan with no section at all
 *      starts once the form's answers are given (`docs/decisions.md` — the
 *      manifest is opt-in until a run asks for it). Only a row somebody WROTE
 *      can block.
 *   2. Five PROBES run, each over the console's own facts and never over a
 *      secret's value: the accounts the run may spend (entitlement, sign-in,
 *      headroom against the declared minimum), the MCP servers the plan names
 *      (the boarding preflight, one pass), the credentials it names (presence
 *      by id — `credentials-probe.ts`), and a delivery channel for the
 *      announcements nobody will otherwise hear (a subscribed device,
 *      `PHASE_CONSOLE_NOTIFY`, a webhook; under `--remote` also Tailscale up
 *      and Serve pointing at this port), and — since 2026-09-18 — every
 *      §Verification command the run would stop on for a person
 *      (`probeVerification`). A probe that could not RUN answers `skip` and
 *      refuses nothing — the MCP preflight's rule.
 *   3. The BLOCKING list is computed: an `outstanding` row marked `blocking:
 *      yes`, a `waived` row the start did not acknowledge, and a failed probe
 *      whose stated condition holds (`credential policy: require`, `MCP policy:
 *      require`, every declared account unusable, no channel and no
 *      acknowledgement). Non-empty → `Service.startRun` throws
 *      `PreludeRefusal` and the route answers 409 listing every entry. One
 *      way past it exists and is recorded: `manifestOverride {rows, by}` →
 *      `run.manifest-override`.
 *
 * Pure over its `PreludeDeps`, so `Service.prelude` (the live facades),
 * `phase-console doctor` (a state directory and the machine) and the tests
 * feed the same function. What it returns is echoed whole on `run.start`
 * (`resolvedManifest`) and stored on the run, so a person reading a halted
 * run later sees what was asked and answered before it began.
 */

import { DECISION_KEYS, type DecisionKey, type DecisionRow } from '../shared/decisions-model.js';
import { MANIFEST_BLOCKING, POLICY_DEFAULTS, resolvePolicy } from '../shared/policy-model.js';
import { MCP_POLICIES } from '../shared/run-lifecycle.js';
import type { ProbeStatus } from '../shared/ops-vocab.js';
import { GIT_STRATEGY_ACKS, type RelayMode } from '../shared/run-settings.js';
import type { HeadroomVerdict } from './accounts/index.ts';
import type { CredentialVerdict } from './credentials-probe.ts';
import type { PolicyPrefs } from './runner/policy.ts';
import type { AccountRequirement, ManifestDecision, ResolvedManifest, RunVerifyApprovals } from './runner/state.ts';
import type { SkillApi, SkillApiMismatch } from './skill-copy.ts';
import type { HumanStepDirective } from './parse/plan.ts';
import { isOpenableUrl, type HumanStepKind, type HumanStepWhere } from '../shared/human-step-model.js';

/** One probe's answer: the word, the reason, and (when some but not all failed) the warnings. */
export type ProbeVerdict = {
  status: ProbeStatus;
  ok: boolean;
  reason: string;
  warnings?: string[];
  detail?: unknown;
};

/** A manifest row as the prelude rendered it, plus the probe that judged it. */
export type PreludeRow = ManifestDecision & { probe?: PreludeProbeId };

export type PreludeProbeId = 'accounts' | 'mcp' | 'credentials' | 'delivery' | 'verification' | 'trees' | 'git-strategy' | 'skill'
  | 'human-steps';

/**
 * Where a plan-declared step stands at the launch door (control-tower phase
 * 44): `pre-cleared` — its proof ran at the door and already holds, so the
 * run will not need anyone for it; `needed` — it ran and does not, so a
 * person is asked NOW, before anything spawns; `unchecked` — it names no
 * proof, or the proof could not run here, so only a person can say.
 */
export type PreludeStepState = 'pre-cleared' | 'needed' | 'unchecked';

/** One plan-declared step as the launch door lists it — the directive, its open action, and what its proof said. */
export type PreludeStep = {
  phase: number;
  kind: HumanStepKind;
  what: string;
  where: HumanStepWhere;
  state: PreludeStepState;
  /** What a person opens to do it: a link, or a command for the embedded terminal. */
  open?: { url: string } | { command: string };
  proof?: string;
  /** What the proof answered at the door, in its own words. */
  read?: string;
  windowMinutes?: number;
  autoOpen?: 'host';
  credential?: string;
};

export type Prelude = {
  slug: string;
  rows: PreludeRow[];
  probes: Record<PreludeProbeId, ProbeVerdict>;
  /** Everything that refuses the start, in the order a person should read it. */
  blocking: { key: string; why: string }[];
  /** The `waived` rows' keys, and which of them the start acknowledged. */
  waived: string[];
  acknowledged: string[];
  /** Did the plan (or its twin) write a `## Decisions` section at all? */
  manifestPresent: boolean;
  accounts: AccountRequirement[];
  credentials: ResolvedManifest['credentials'];
  delivery: ResolvedManifest['delivery'];
  /** The draft's §Verification answers, resolved to exact texts — what `startRun` stores on the run. */
  verifyApprovals?: RunVerifyApprovals;
  /**
   * The plan-declared human steps of the phases this run will drive, each
   * proof run at the door (control-tower phase 44) — "this run will need you N
   * times", asked before anything spawns rather than at three in the morning.
   */
  humanSteps: PreludeStep[];
  at: string;
};

/** What the launch form (or a scripted start) answered. */
export type PreludeOptions = {
  resumeOnRestart?: boolean;
  relay?: RelayMode | string;
  accounts?: AccountRequirement[];
  acknowledgedWaivers?: string[];
  model?: string;
  mcpServers?: string[];
  mcpPolicy?: string;
  permissionProfile?: string;
  /** The phases the run will drive — probe 5 blocks only on these; empty is every open phase. */
  onlyPhases?: number[];
  autonomy?: string;
  /**
   * The draft's answers to probe 5, by fingerprint: `approve` exact commands
   * the built-in tier would not run, `waive` fragments as `<phase>:<fp>`. The
   * service resolves them against the reviews into exact texts — an fp that
   * names no approvable command answers nothing.
   */
  verifyAnswers?: { approve?: string[]; waive?: string[] };
  /** The draft's git mode and isolation — whether this run would stand in trees of its own (probe 6). */
  gitMode?: string;
  isolation?: string;
};

/**
 * One phase's verification review, as probe 5 reads it — the shape
 * `runner/verify-review.ts` returns, spelled here so this file stays a leaf
 * (the offline doctor imports it).
 */
export type VerificationReviewFact = {
  phase: number;
  verdict: string;
  park?: string;
  runs: string[];
  items: { text: string; reason: string; fp?: string; approvable?: boolean }[];
  waived: { text: string; reason: string }[];
  setup: { text: string; reason: string; fp?: string; approvable?: boolean }[];
  missing: string[];
};

export type VerificationFacts = {
  reviews: readonly VerificationReviewFact[];
  /** The run's `onlyPhases` when it is scoped; null for every open phase. */
  scope: readonly number[] | null;
  /** The draft's answers, resolved to exact texts. */
  answers?: RunVerifyApprovals;
};

/** The facts the prelude reads. Every field is a function so a caller supplies only what it has. */
export type PreludeDeps = {
  /** The manifest as it holds: plan rows with the twin merged over them. */
  decisions: () => { rows: DecisionRow[]; present: boolean; error?: string };
  /** The plan's `**Accounts:**` clause. */
  planAccounts: () => AccountRequirement[];
  /** Every credential id the plan or any phase names, and the plan's policy. */
  planCredentials: () => { ids: string[]; policy: string | null };
  /** Every MCP server the plan or any phase names, and the plan's policy. */
  planMcp: () => { ids: string[]; policy: string | null };
  accounts: {
    defaultId: string;
    has: (id: string) => boolean;
    authStateFor: (id: string) => string | undefined;
    entitlementOf: (id: string) => { state: string; reason?: string };
    headroom: (id: string, model?: string) => HeadroomVerdict;
    labelFor: (id: string) => string;
  };
  mcp: {
    preflight: (ids: readonly string[]) => Promise<{
      ok: boolean;
      blocking: { id: string; status: string }[];
      unknown: string[];
      probeError?: string;
    }>;
  };
  credentials: { held: (ids: readonly string[]) => Promise<CredentialVerdict[]> };
  delivery: () => Promise<DeliveryFacts>;
  /**
   * Probe 5's facts — the verification review of every open phase. Optional:
   * with no plan in front of it (the doctor) there is nothing to review, and
   * the probe answers `skip`.
   */
  verification?: () => Promise<VerificationFacts | null>;
  /**
   * Probe 6's facts — which repository of the plan's scope stands on another
   * open run's branch in the shared checkout, and whether this run would be
   * isolated from it (control-tower phase 40, #41). Optional, like probe 5.
   */
  trees?: () => Promise<TreeFacts | null>;
  /**
   * Probe 7's facts — the plan's git lines and the strategy this launch would
   * run under (control-tower phase 11, #18). Optional, like probe 6.
   */
  gitStrategy?: () => Promise<GitStrategyFacts | null>;
  /**
   * Probe 8's facts — this console's `skill-api.env` and the plugin copy the
   * run's accounts' sessions load, with theirs (control-tower phase 98, #151).
   * Optional, like probe 6: absent answers `skip` and refuses nothing.
   */
  skillApi?: (accountIds: string[]) => SkillApiFacts | null;
  /**
   * Probe 9's facts (control-tower phase 44): the plan-declared human steps of
   * the phases this run will drive — `onlyPhases`, else every phase not done —
   * and the one-ref probe their proofs are run with (the watch clock's own,
   * `WatchScheduler.probeNow`, so a `cmd:` proof is judged exactly as the check
   * verb and the watch judge it). Optional, like probe 6: absent lists nothing.
   */
  humanSteps?: () => Promise<readonly { phase: number; step: HumanStepDirective }[]>;
  probeStep?: (ref: string) => Promise<{ landed: boolean; read: string }>;
  prefs: PolicyPrefs;
  now?: () => string;
};

/**
 * The plan-declared steps of the phases a run will drive: its `onlyPhases`
 * when it is scoped, else every phase the board does not read done — in the
 * plan's phase order, each phase's steps in the order the plan writes them.
 */
export function scopedSteps(
  stepsOf: (phase: number) => readonly HumanStepDirective[],
  phases: readonly number[],
  scope: { onlyPhases?: readonly number[] | undefined; done?: readonly number[] | undefined } = {},
): { phase: number; step: HumanStepDirective }[] {
  const only = scope.onlyPhases?.length ? new Set(scope.onlyPhases) : null;
  const done = new Set(scope.done ?? []);
  return phases
    .filter((phase) => (only ? only.has(phase) : !done.has(phase)))
    .flatMap((phase) => stepsOf(phase).map((step) => ({ phase, step })));
}

/**
 * Run every listed step's proof AT ONCE and say where each stands: a proof
 * that lands pre-clears its step; one that does not leaves it `needed`; no
 * proof — or a probe that threw — leaves it `unchecked`. The open action is
 * the step's `open:` value, read as a link when it is http(s) and as a command
 * otherwise.
 */
export async function doorSteps(
  listed: readonly { phase: number; step: HumanStepDirective }[],
  probe: ((ref: string) => Promise<{ landed: boolean; read: string }>) | undefined,
): Promise<PreludeStep[]> {
  return Promise.all(listed.map(async ({ phase, step }): Promise<PreludeStep> => {
    const base: PreludeStep = {
      phase, kind: step.kind, what: step.what, where: step.where, state: 'unchecked',
      ...(step.open ? { open: isOpenableUrl(step.open) ? { url: step.open.trim() } : { command: step.open.trim() } } : {}),
      ...(step.proof ? { proof: step.proof } : {}),
      ...(step.windowMinutes !== undefined ? { windowMinutes: step.windowMinutes } : {}),
      ...(step.autoOpen ? { autoOpen: step.autoOpen } : {}),
      ...(step.credential ? { credential: step.credential } : {}),
    };
    if (!step.proof || !probe) return base;
    try {
      const answer = await probe(step.proof);
      return { ...base, state: answer.landed ? 'pre-cleared' : 'needed', read: answer.read.slice(0, 280) };
    } catch (error) {
      return { ...base, read: `the proof could not run: ${String((error as Error)?.message ?? error).slice(0, 200)}` };
    }
  }));
}

/**
 * Probe 9 — a person's turns the run will need. It never refuses a start: a
 * step still owed is an ASK, answered at the door or later, so the verdict is
 * `ok` either way and names what is owed as warnings. `skip` when the plan
 * declares no step for these phases.
 */
export function probeHumanSteps(steps: readonly PreludeStep[]): ProbeVerdict {
  if (!steps.length) return { status: 'skip', ok: true, reason: 'the plan declares no human step for these phases' };
  const owed = steps.filter((step) => step.state !== 'pre-cleared');
  const cleared = steps.length - owed.length;
  if (!owed.length) {
    return { status: 'ok', ok: true, reason: `every step the plan declares for these phases is already done (${cleared} pre-cleared at the door)`, detail: { steps } };
  }
  return {
    status: 'ok',
    ok: true,
    reason: `this run will need you ${owed.length} time${owed.length === 1 ? '' : 's'}`
      + (cleared ? ` (${cleared} more pre-cleared at the door)` : ''),
    warnings: owed.map((step) => `phase ${step.phase}: ${step.what}${step.state === 'needed' && step.read ? ` — its proof read ${step.read}` : ''}`),
    detail: { steps },
  };
}

export type DeliveryFacts = {
  devices: number;
  notifyCommand: boolean;
  webhooks: number;
  remote: boolean;
  tailscale?: { running: boolean; forOurPort: boolean } | null;
};

const UNUSABLE_AUTH = new Set(['expired', 'signed-out', 'unusable']);

/* ------------------------------------------------------------------ *
 * The probes — pure over facts
 * ------------------------------------------------------------------ */

export type AccountFacts = {
  id: string;
  minHeadroomPct: number;
  registered: boolean;
  authState: string | undefined;
  entitlement: { state: string; reason?: string };
  headroom: HeadroomVerdict;
  label: string;
};

/**
 * The accounts probe: refuses when EVERY declared account is unusable —
 * unregistered, signed out, retired by the breaker, past the preflight wall,
 * or under the headroom it was declared to need. One usable account is
 * enough to start; the rest are warnings.
 */
export function probeAccounts(facts: readonly AccountFacts[]): ProbeVerdict {
  if (!facts.length) return { status: 'skip', ok: true, reason: 'no account declared and no machine login to judge' };
  const failures: string[] = [];
  const usable: string[] = [];
  for (const f of facts) {
    const why = accountFailure(f);
    if (why) failures.push(`${f.label} — ${why}`);
    else usable.push(f.label);
  }
  if (!usable.length) {
    return { status: 'fail', ok: false, reason: `every declared account is unusable: ${failures.join('; ')}`, detail: { failures } };
  }
  return {
    status: 'ok', ok: true,
    reason: `${usable.length} of ${facts.length} declared account${facts.length === 1 ? '' : 's'} usable: ${usable.join(', ')}`,
    ...(failures.length ? { warnings: failures } : {}),
  };
}

function accountFailure(f: AccountFacts): string | null {
  if (!f.registered) return 'not registered on this console';
  if (f.authState && UNUSABLE_AUTH.has(f.authState)) return `login ${f.authState}`;
  if (f.entitlement.state === 'retired') return `retired by the breaker${f.entitlement.reason ? ` (${f.entitlement.reason})` : ''}`;
  if (!f.headroom.ok) return f.headroom.reason;
  if (typeof f.headroom.fiveHourPct === 'number') {
    const left = Math.max(0, 100 - f.headroom.fiveHourPct);
    if (left < f.minHeadroomPct) return `${left} % five-hour headroom left, ${f.minHeadroomPct} % required`;
  }
  return null;
}

/** The MCP probe: `require` and a server down refuses; `continue` warns; a probe that could not run skips. */
export function probeMcp(
  ids: readonly string[], policy: string,
  result: { ok: boolean; blocking: { id: string; status: string }[]; unknown: string[]; probeError?: string } | null,
): ProbeVerdict {
  if (!ids.length) return { status: 'skip', ok: true, reason: 'no MCP server named' };
  if (!result) return { status: 'skip', ok: true, reason: 'the MCP preflight could not run' };
  if (result.probeError && !result.blocking.length) {
    return { status: 'skip', ok: true, reason: `the MCP preflight could not probe: ${result.probeError}` };
  }
  const down = [...result.blocking.map((b) => `${b.id} (${b.status})`), ...result.unknown.map((id) => `${id} (unknown to this console)`)];
  if (!down.length) return { status: 'ok', ok: true, reason: `${ids.length} server${ids.length === 1 ? '' : 's'} reachable` };
  if (policy === 'require') {
    return { status: 'fail', ok: false, reason: `MCP policy is require and ${down.join(', ')} will not connect`, detail: { down } };
  }
  return { status: 'ok', ok: true, reason: `${down.length} of ${ids.length} server(s) unreachable; policy ${policy} runs without them`, warnings: down };
}

/** The credentials probe: `require` and an id absent refuses; `continue` warns; an id with no probe skips. */
export function probeCredentials(ids: readonly string[], policy: string, verdicts: readonly CredentialVerdict[]): ProbeVerdict {
  if (!ids.length) return { status: 'skip', ok: true, reason: 'no credential named' };
  const missing = verdicts.filter((v) => v.status === 'fail');
  const unknown = verdicts.filter((v) => v.status === 'skip');
  const warnings = unknown.map((v) => `${v.id} — ${v.reason}`);
  if (missing.length && policy === 'require') {
    return {
      status: 'fail', ok: false,
      reason: `credential policy is require and ${missing.map((v) => v.id).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not held: ${missing.map((v) => v.reason).join('; ')}`,
      detail: { missing: missing.map((v) => v.id) },
      ...(warnings.length ? { warnings } : {}),
    };
  }
  if (missing.length) {
    return {
      status: 'ok', ok: true,
      reason: `${missing.map((v) => v.id).join(', ')} not held; policy ${policy} runs and reports the gap`,
      warnings: [...missing.map((v) => `${v.id} — ${v.reason}`), ...warnings],
    };
  }
  const held = verdicts.filter((v) => v.status === 'ok').length;
  return {
    status: 'ok', ok: true,
    reason: `${held} of ${ids.length} credential${ids.length === 1 ? '' : 's'} held`,
    ...(warnings.length ? { warnings } : {}),
  };
}

/** The delivery probe: some channel must exist, and under `--remote` Tailscale must serve this port. */
export function probeDelivery(facts: DeliveryFacts): ProbeVerdict & { channels: string[] } {
  const channels: string[] = [];
  if (facts.devices > 0) channels.push(`${facts.devices} subscribed device${facts.devices === 1 ? '' : 's'}`);
  if (facts.notifyCommand) channels.push('PHASE_CONSOLE_NOTIFY');
  if (facts.webhooks > 0) channels.push(`${facts.webhooks} webhook${facts.webhooks === 1 ? '' : 's'}`);
  if (!channels.length) {
    return {
      status: 'fail', ok: false, channels,
      reason: 'no delivery channel: no subscribed device, no PHASE_CONSOLE_NOTIFY command, no webhook — an unattended run would announce to nobody',
    };
  }
  if (facts.remote) {
    const ts = facts.tailscale;
    if (!ts?.running) {
      return { status: 'fail', ok: false, channels, reason: `${channels.join(', ')}; but --remote is set and Tailscale is not running` };
    }
    if (!ts.forOurPort) {
      return { status: 'fail', ok: false, channels, reason: `${channels.join(', ')}; but --remote is set and Tailscale Serve does not point at this port` };
    }
  }
  return { status: 'ok', ok: true, channels, reason: channels.join(', ') };
}

/* ------------------------------------------------------------------ *
 * The manifest rows
 * ------------------------------------------------------------------ */

const plain = (s: string) => s.replace(/[*`]/g, '').trim();

function synthesised(key: DecisionKey, value: string, origin: string, source: string): PreludeRow {
  return {
    key, value, owner: 'console', state: 'answered', source, origin,
    blocking: (MANIFEST_BLOCKING as readonly string[]).includes(key) ? 'yes' : 'no',
  };
}

function accountsValue(list: readonly AccountRequirement[]): string {
  return list.map((a) => `${a.id}:${a.minHeadroomPct}`).join(', ');
}

/**
 * Every key of the vocabulary as a row: the written row where there is one,
 * else a synthesised one naming where its answer came from.
 */
export function manifestRows(
  written: readonly DecisionRow[], options: PreludeOptions, deps: Pick<PreludeDeps, 'planAccounts' | 'planCredentials' | 'planMcp' | 'prefs' | 'accounts'>,
  accounts: readonly AccountRequirement[],
): PreludeRow[] {
  const byKey = new Map<string, DecisionRow>();
  for (const row of written) byKey.set(row.key, row);
  const rows: PreludeRow[] = [];
  const policy = (key: DecisionKey) => resolvePolicy(key, {
    plan: written, prefs: deps.prefs,
    run: { resumeOnRestart: options.resumeOnRestart ?? null, relay: options.relay ?? null },
  });
  const consoleOr = (key: DecisionKey, fallback: string): PreludeRow => {
    const p = policy(key);
    return p?.source === 'console'
      ? synthesised(key, p.answer, 'console', 'console')
      : synthesised(key, fallback, 'default', 'default');
  };
  for (const key of DECISION_KEYS) {
    const have = byKey.get(key);
    if (have) {
      rows.push({
        key: have.key, value: have.value, owner: have.owner, state: plain(have.state) || 'answered',
        source: have.source || 'plan', blocking: have.blocking, origin: 'plan',
      });
      continue;
    }
    switch (key) {
      case 'resume.on-restart': {
        const p = policy(key);
        rows.push(synthesised(key, p?.answer ?? POLICY_DEFAULTS[key]!, p?.source ?? 'default', p?.source === 'run' ? 'run' : 'default'));
        break;
      }
      case 'relay': {
        const p = policy(key);
        rows.push(synthesised(key, p?.answer ?? POLICY_DEFAULTS[key]!, p?.source ?? 'default', p?.source === 'run' ? 'run' : 'default'));
        break;
      }
      case 'accounts': {
        const fromRun = options.accounts?.length ? 'run' : deps.planAccounts().length ? 'plan' : 'default';
        rows.push(synthesised(key, `${accountsValue(accounts)} (id:minimum five-hour headroom %)`, fromRun, fromRun === 'plan' ? 'plan' : fromRun));
        break;
      }
      case 'credentials': {
        const { ids, policy: pol } = deps.planCredentials();
        const word = pol ?? POLICY_DEFAULTS.credentials!;
        rows.push(ids.length
          ? synthesised(key, `${ids.map((id) => `\`${id}\``).join(', ')}; credential policy: ${word}`, 'plan', 'plan')
          : synthesised(key, `none named; credential policy: ${word}`, 'default', 'default'));
        break;
      }
      case 'mcp': {
        const { ids, policy: pol } = deps.planMcp();
        const word = options.mcpPolicy && (MCP_POLICIES as readonly string[]).includes(options.mcpPolicy)
          ? options.mcpPolicy : pol ?? POLICY_DEFAULTS.mcp!;
        rows.push(ids.length
          ? synthesised(key, `${ids.map((id) => `\`${id}\``).join(', ')}; MCP policy: ${word}`, 'plan', 'plan')
          : synthesised(key, `none named; MCP policy: ${word}`, 'default', 'default'));
        break;
      }
      case 'permission.policy':
        rows.push(options.permissionProfile
          ? synthesised(key, `the run's ${options.permissionProfile} profile; no plan overlay`, 'run', 'run')
          : synthesised(key, "the console's default profile; no plan overlay", 'default', 'default'));
        break;
      // The free-text keys: this console's own line when the operator wrote
      // one in the policy editor (phase 12), else what the console does.
      case 'permission.destructive':
        rows.push(consoleOr(key, 'deny — the deny wall holds on every profile; no phase publishes'));
        break;
      case 'human-acts':
        rows.push(consoleOr(key, 'none declared'));
        break;
      case 'budgets':
        rows.push(consoleOr(key, "the run's own ceilings and the console's ladder caps"));
        break;
      case 'plan-health':
        rows.push(consoleOr(key, 'the F1 lints gate boarding; the advisory family reports'));
        break;
      case 'stop':
        rows.push(consoleOr(key, "the run's autonomy; a halt announces"));
        break;
      case 'announce':
        rows.push(consoleOr(key, "the console's notification categories, to its channels"));
        break;
      default: {
        // gates · verification.person-check · qa.exhausted · waits · ambiguity —
        // the policy table's words.
        const p = policy(key);
        rows.push(synthesised(key, p?.answer ?? 'unstated', p?.source ?? 'default', p?.source === 'console' ? 'console' : 'default'));
      }
    }
  }
  // A written row for a key outside the vocabulary is kept, so the lint's
  // F25 word and the prelude's table say the same thing.
  for (const row of written) {
    if (!(DECISION_KEYS as readonly string[]).includes(row.key)) {
      rows.push({ ...row, origin: 'plan', state: plain(row.state) });
    }
  }
  return rows;
}

/**
 * Probe 5 — verification (2026-09-18, run f0da619a): everything a run's
 * §Verification would stop for a person, asked at the door. A phase in scope
 * that would PARK — `Person-check: halt` with a fragment the runner will not
 * run, nothing runnable, every lead missing — or that would ALWAYS ask
 * (`halt-on-everything`) refuses the start until each is answered: approve the
 * exact command, waive it for this run, or fix the plan. What only MIGHT ask,
 * a Setup command that will not run, a missing binary and a phase outside the
 * scope are warnings. The detail carries every review, for the Decisions stage.
 */
export function probeVerification(facts: VerificationFacts | null): ProbeVerdict {
  if (!facts) return { status: 'skip', ok: true, reason: 'no plan in front of the probe' };
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const inScope = (phase: number) => !facts.scope?.length || facts.scope.includes(phase);
  // What the door can ANSWER stops the start: a named command or fragment it
  // would park on (approve it or waive it), and anything it would always ask.
  // A park with nothing to name — no bullet, a bullet the parser lost, every
  // lead missing — is lint F14's and boarding's, as it was before this probe:
  // shown here, never a reason to refuse a run whose first hours are fine.
  const stops = (review: VerificationReviewFact) =>
    (review.verdict === 'parks' && review.items.length > 0) || review.verdict === 'asks';
  const blocking = facts.reviews.filter((review) => inScope(review.phase) && stops(review));
  const warnings: string[] = [];
  for (const review of facts.reviews) {
    if (!inScope(review.phase) && stops(review)) {
      warnings.push(`phase ${review.phase} (outside this run's phases) would stop for a person — ${review.park ?? 'answer it before widening the run'}`);
    }
    if (review.verdict === 'parks' && !review.items.length && review.park) {
      warnings.push(`phase ${review.phase} will park at boarding: ${review.park}`);
    }
    if (review.verdict === 'may-ask') {
      for (const item of review.items) {
        warnings.push(`phase ${review.phase}: a person may be asked on a red — ${item.text} — ${item.reason}`);
      }
    }
    for (const item of review.setup) {
      warnings.push(`phase ${review.phase}: its Setup will not run ${item.text} — ${item.reason}`);
    }
    if (review.verdict !== 'parks') {
      for (const lead of review.missing) {
        warnings.push(`phase ${review.phase}: \`${lead}\` is not installed here — its command will be skipped`);
      }
    }
  }
  const detail = { reviews: facts.reviews, scope: facts.scope, ...(facts.answers ? { answers: facts.answers } : {}) };
  const withWarnings = warnings.length ? { warnings } : {};
  if (blocking.length) {
    const [first, ...rest] = blocking;
    const why = first.items[0] ? `${first.items[0].text} — ${first.items[0].reason}` : (first.park ?? 'it would stop');
    return {
      status: 'fail',
      ok: false,
      reason: `${plural(blocking.length, 'phase')} would stop for a person — phase ${first.phase}: ${why}`
        + (rest.length ? ` (and ${rest.map((review) => `phase ${review.phase}`).join(', ')})` : '')
        + ' — approve the exact command, waive it for this run, or fix the plan',
      ...withWarnings,
      detail,
    };
  }
  const counted = facts.reviews.filter((review) => inScope(review.phase));
  const commands = counted.reduce((sum, review) => sum + review.runs.length, 0);
  const approved = facts.answers?.approve.length ?? 0;
  const waived = counted.reduce((sum, review) => sum + review.waived.length, 0);
  return {
    status: 'ok',
    ok: true,
    reason: `${plural(commands, 'command')} in ${plural(counted.length, 'open phase')} run on their own`
      + (approved ? `, ${approved} by your approval` : '')
      + (waived ? `, ${waived} set aside` : ''),
    ...withWarnings,
    detail,
  };
}

/* ------------------------------------------------------------------ *
 * The prelude
 * ------------------------------------------------------------------ */

/** Probe 6's facts: the shared trees another run holds, and this run's isolation. */
export type TreeFacts = {
  held: { repo: string; branch: string; run: string; slug: string }[];
  /** This run would stand in trees of its own (a mirror, an isolated checkout). */
  isolated: boolean;
  /** Could the console isolate this plan? `null` when that could not be asked. */
  grantable: boolean | null;
  /** Why it could not, in the isolation preflight's words. */
  refusal?: string;
};

/**
 * Probe 6 — the shared trees (control-tower phase 40, #41). Names every
 * repository of the plan's scope that stands on another open run's branch,
 * and says what that means for THIS run: an isolated run is not held by it;
 * a shared one will queue its phases in that scope until the tree leaves the
 * branch or the holder settles — so it recommends isolation, but only when
 * the console can grant it. Never a block: a held tree queues, it does not
 * refuse a start.
 */
export function probeTrees(facts: TreeFacts | null): ProbeVerdict {
  if (!facts) return { status: 'skip', ok: true, reason: 'the shared checkout was not read' };
  if (!facts.held.length) return { status: 'ok', ok: true, reason: "no scoped repository stands on another run's branch" };
  const named = facts.held.map((hold) => `\`${hold.repo}\` on \`${hold.branch}\` (run ${hold.run} of ${hold.slug})`);
  const holds = `another run holds ${named.join(', ')}`;
  if (facts.isolated) {
    return { status: 'ok', ok: true, reason: `${holds} — this run is isolated — it stands in trees of its own and is not held by it`, detail: facts };
  }
  const advice = facts.grantable === false
    ? ` — this run's phases in that scope will queue until the tree leaves that branch or that run settles; `
      + `isolation is not available here${facts.refusal ? ` (${facts.refusal})` : ''}`
    : ' — start this run isolated so it works in trees of its own; in the shared checkout its phases in that '
      + 'scope will queue until that run settles';
  return { status: 'ok', ok: true, reason: holds + advice, warnings: named, detail: facts };
}

/* ------------------------------------------------------------------ *
 * Probe 7 — the plan's git lines against the chosen strategy (#18)
 * ------------------------------------------------------------------ */

/** Probe 7's facts: what the plan's git lines ask and what this launch would do. */
export type GitStrategyFacts = {
  /** The launch's git mode — only `new-branch` imposes a branch of the console's. */
  gitMode?: string;
  /** The branch the console's new-branch strategy puts every phase on (`pe/<slug>`). */
  runBranch: string;
  /** This run would stand in a checkout of its own (a run tree, or a superproject's mirror). */
  isolated: boolean;
  /** The plan's root has submodules — per-lane worktrees are refused `has-submodules`. */
  superproject: boolean;
  /** §Session budget's `**Branch:**` prose, verbatim. */
  planBranch?: string;
  /** §Session budget says `Worktrees: on`. */
  planWorktrees: boolean;
  /** The phases whose `- **Checkout:**` asks to board detached at the trunk. */
  checkoutPhases: number[];
};

/** One plan git line the chosen strategy will not honour. */
export type GitStrategyLine = {
  kind: 'branch' | 'worktrees' | 'checkout';
  /** What the plan says. */
  plan: string;
  /** What this run does instead. */
  run: string;
  /** Whether `honour` can make the plan's line hold (by giving the run a checkout of its own). */
  honourable: boolean;
  /** The phases a `checkout` line names. */
  phases?: number[];
};

/** A person's answer to probe 7's rows at launch — `shared/run-settings.js` owns the words. */
export { GIT_STRATEGY_ACKS };
export type GitStrategyAck = (typeof GIT_STRATEGY_ACKS)[number];

/**
 * Every git line of the plan the chosen strategy will not honour (#18) — the
 * three a plan author could not learn from the format until now:
 *
 * - `branch` — the console's new-branch strategy puts every phase on
 *   `pe/<slug>`, so §Session budget's `**Branch:**` naming another branch is
 *   never created. The default idioms ("current branch", "no new branch",
 *   "default") name none, and prose that names the run branch itself agrees.
 *   No launch setting honours it.
 * - `worktrees` — `Worktrees: on` is a per-LANE ask: a shared checkout cannot
 *   grant it, and a superproject never grants it (the run-level mirror is its
 *   answer, refused per lane `has-submodules`). Honourable only by isolating a
 *   plain repository.
 * - `checkout` — `- **Checkout:** main` means "board detached at the trunk"
 *   only in a checkout the run owns; in the shared one it is inert and the
 *   phase stands on the run branch. Honoured by isolating the run.
 */
export function gitStrategyLines(facts: GitStrategyFacts | null): GitStrategyLine[] {
  if (!facts) return [];
  const lines: GitStrategyLine[] = [];
  const newBranch = facts.gitMode === 'new-branch';
  const prose = facts.planBranch?.replace(/\s+/g, ' ').trim();
  if (newBranch && prose && !/current|no new branch|default/i.test(prose) && !prose.includes(facts.runBranch)) {
    lines.push({
      kind: 'branch', plan: prose.slice(0, 240), honourable: false,
      run: `every phase works on \`${facts.runBranch}\`; the plan's branch is never created`,
    });
  }
  if (facts.planWorktrees && (facts.superproject || !facts.isolated)) {
    lines.push({
      kind: 'worktrees', plan: 'Worktrees: on',
      honourable: newBranch && !facts.superproject,
      run: facts.superproject
        ? 'a superproject never grants a worktree per lane — its phases share the run\'s mirror'
        : 'the phases share one checkout — a shared-checkout run cannot grant a worktree per lane',
    });
  }
  if (facts.checkoutPhases.length && !facts.isolated) {
    const list = facts.checkoutPhases.join(', ');
    lines.push({
      kind: 'checkout', plan: `Checkout: main on phase${facts.checkoutPhases.length === 1 ? '' : 's'} ${list}`,
      honourable: newBranch, phases: [...facts.checkoutPhases],
      run: newBranch
        ? `inert in the shared checkout — the phase${facts.checkoutPhases.length === 1 ? ' stands' : 's stand'} on \`${facts.runBranch}\``
        : 'inert in the shared checkout — the phases stand on whatever it has checked out',
    });
  }
  return lines;
}

/** One line as a sentence — the prelude's warning and the refusal's list. */
export function gitStrategySentence(line: GitStrategyLine): string {
  return `the plan's \`${line.plan}\` is not honoured: ${line.run}`;
}

/**
 * Probe 7 — the plan's git lines (control-tower phase 11, #18). Names each
 * line the chosen strategy will not honour, BEFORE anything spawns — a
 * journal line nobody is watching is not a decision. Never blocks here: the
 * start door asks for `gitStrategyAck` while a line stands
 * (`GitStrategyRefusal`), and an automatic door answers `override` for itself.
 */
export function probeGitStrategy(facts: GitStrategyFacts | null): ProbeVerdict {
  if (!facts) return { status: 'skip', ok: true, reason: "the plan's git lines were not read" };
  const lines = gitStrategyLines(facts);
  if (!lines.length) return { status: 'ok', ok: true, reason: "the chosen git strategy honours every git line the plan states", detail: { lines } };
  return {
    status: 'ok', ok: true,
    reason: `${lines.length} of the plan's git line${lines.length === 1 ? ' is' : 's are'} not honoured by this launch — `
      + 'answer honour (make the plan hold where the console can) or override (run over it, and tell the sessions)',
    warnings: lines.map(gitStrategySentence),
    detail: { lines },
  };
}

/**
 * What a session is told about each plan git line its run was launched over
 * (control-tower phase 11, #18) — the concrete instruction, never "record the
 * discrepancy in your handoff", which in a zero-touch run nobody reads: four
 * sessions each rediscovered that the plan's per-phase branches did not exist
 * and repaired their own `gh pr checks` line while eighty stayed wrong.
 * Empty when nothing was overridden, so the boot prompt says what it always said.
 */
export function gitOverrideInstruction(
  lines: readonly { kind: string; plan: string; run: string; phases?: number[] }[] | undefined,
  branch: string, phase: number,
): string {
  const out: string[] = [];
  for (const line of lines ?? []) {
    if (line.kind === 'branch') {
      out.push(`- The plan's §Session budget names the branch \`${line.plan}\`, and this run was launched\n`
        + `  OVER it: \`${branch}\` IS this plan's branch for the whole run. Every branch the plan names\n`
        + `  instead — that one, a per-phase \`${branch}-pN\`, the branch in a \`gh pr checks …\` line —\n`
        + `  does not exist here: read each as \`${branch}\` and carry on. There is no discrepancy to record.`);
    } else if (line.kind === 'worktrees') {
      out.push(`- The plan asks for \`Worktrees: on\`; this run was launched over it (${line.run}). Work in the\n`
        + '  checkout named above and nowhere else — no worktree of your own exists or will be made.');
    } else if (line.kind === 'checkout' && (!line.phases?.length || line.phases.includes(phase))) {
      out.push(`- This phase's \`Checkout: main\` is inert in this run: it stands on \`${branch}\` like every\n`
        + '  other phase, and commits there. Do not switch to the trunk.');
    }
  }
  return out.length ? `\n${out.join('\n')}` : '';
}

/**
 * A start refused on probe 7 (→ 409): a line stands and the launch did not
 * answer it, or answered `honour` where a line cannot be honoured.
 */
export class GitStrategyRefusal extends Error {
  lines: GitStrategyLine[];
  ack: GitStrategyAck | null;

  constructor(lines: GitStrategyLine[], ack: GitStrategyAck | null) {
    super(ack === 'honour'
      ? `The run cannot honour ${lines.length === 1 ? 'this plan git line' : 'these plan git lines'}: `
        + `${lines.map(gitStrategySentence).join('; ')}. Start with gitStrategyAck "override", or change the launch.`
      : `The chosen git strategy does not honour ${lines.length === 1 ? 'a git line' : `${lines.length} git lines`} the plan states: `
        + `${lines.map(gitStrategySentence).join('; ')}. Answer gitStrategyAck "honour" or "override" to start.`);
    this.name = 'GitStrategyRefusal';
    this.lines = lines;
    this.ack = ack;
  }
}

/* ------------------------------------------------------------------ *
 * Probe 8 — the skill's interface against the console's (#151)
 * ------------------------------------------------------------------ */

/**
 * Probe 8's facts: this console's interface pair, and each copy a session of
 * the run would load — with `skill-copy.ts`'s verdict on the two already
 * reached, so this file stays a runtime leaf and the comparison lives once.
 */
export type SkillApiFacts = {
  console: SkillApi | null;
  copies: { configDir: string; installPath: string | null; api: SkillApi | null; mismatch: SkillApiMismatch | null }[];
};

/**
 * Probe 8 — the skill against the console (control-tower phase 98, #151). The
 * console runs its own scripts and tells every session to; the session reads
 * SKILL.md from the plugin copy its config dir carries. When that copy's
 * scripts reject flags the console uses — or the console's reject what the
 * skill tells a session to use — the run goes wrong in the middle, so the
 * start is refused here, naming the half to update. Chosen over a refusal at
 * boarding because a boarding refusal would need a halt kind of its own, and
 * the door is where the prelude's other preconditions already stop a run.
 * A copy or a console carrying no `skill-api.env` is no verdict, never a pass
 * dressed as one: the probe answers `skip`.
 */
export function probeSkillApi(facts: SkillApiFacts | null): ProbeVerdict {
  if (!facts) return { status: 'skip', ok: true, reason: 'the skill copies were not read' };
  const installed = facts.copies.filter((copy) => copy.installPath);
  if (!installed.length) {
    return { status: 'skip', ok: true, reason: "no plugin copy of the skill is installed for this run's accounts — nothing to compare" };
  }
  if (!facts.console) return { status: 'skip', ok: true, reason: "this console's scripts carry no skill-api.env — no verdict" };
  const refused = installed.find((copy) => copy.mismatch);
  if (refused?.mismatch) {
    return {
      status: 'fail', ok: false, reason: `${refused.configDir}: ${refused.mismatch.reason}`,
      detail: { ...facts, update: refused.mismatch.update },
    };
  }
  const unstamped = installed.filter((copy) => !copy.api);
  if (unstamped.length === installed.length) {
    return { status: 'skip', ok: true, reason: `the skill copy carries no skill-api.env (${unstamped[0]!.installPath}) — no verdict` };
  }
  return {
    status: 'ok', ok: true,
    reason: `this console's interface ${facts.console.api} and the skill's meet in ${installed.map((copy) => copy.configDir).join(', ')}`,
    ...(unstamped.length ? { warnings: unstamped.map((copy) => `${copy.configDir}: its copy carries no skill-api.env — no verdict`) } : {}),
  };
}

export async function preludeFor(slug: string, options: PreludeOptions, deps: PreludeDeps): Promise<Prelude> {
  const at = (deps.now ?? (() => new Date().toISOString()))();
  const manifest = deps.decisions();
  const written = manifest.rows;
  const acknowledged = [...new Set(options.acknowledgedWaivers ?? [])];

  // The accounts the run may spend: the form's list, else the plan's clause,
  // else the machine login with no minimum (the headroom verdict's own wall
  // still applies).
  const accounts: AccountRequirement[] = options.accounts?.length
    ? options.accounts.map((a) => ({ id: a.id, minHeadroomPct: clampPct(a.minHeadroomPct) }))
    : deps.planAccounts().length
      ? deps.planAccounts().map((a) => ({ id: a.id, minHeadroomPct: clampPct(a.minHeadroomPct) }))
      : [{ id: deps.accounts.defaultId, minHeadroomPct: 0 }];

  const rows = manifestRows(written, options, deps, accounts);

  // Probe 1 — accounts.
  const accountFacts: AccountFacts[] = accounts.map((a) => ({
    id: a.id,
    minHeadroomPct: a.minHeadroomPct,
    registered: a.id === deps.accounts.defaultId || deps.accounts.has(a.id),
    authState: deps.accounts.authStateFor(a.id),
    entitlement: deps.accounts.entitlementOf(a.id),
    headroom: deps.accounts.headroom(a.id, options.model),
    label: deps.accounts.labelFor(a.id),
  }));
  const accountsVerdict = probeAccounts(accountFacts);

  // Probe 2 — MCP.
  const mcp = deps.planMcp();
  const mcpIds = [...new Set([...mcp.ids, ...(options.mcpServers ?? [])])];
  const mcpPolicy = options.mcpPolicy && (MCP_POLICIES as readonly string[]).includes(options.mcpPolicy)
    ? options.mcpPolicy
    : mcp.policy ?? resolvePolicy('mcp', { plan: written, prefs: deps.prefs })?.answer ?? 'continue';
  let mcpResult: Awaited<ReturnType<PreludeDeps['mcp']['preflight']>> | null = null;
  if (mcpIds.length) {
    try { mcpResult = await deps.mcp.preflight(mcpIds); } catch (error) {
      mcpResult = { ok: false, blocking: [], unknown: [], probeError: String((error as Error)?.message ?? error) };
    }
  }
  const mcpVerdict = probeMcp(mcpIds, mcpPolicy, mcpResult);

  // Probe 3 — credentials.
  const creds = deps.planCredentials();
  const credentialPolicy = creds.policy ?? resolvePolicy('credentials', { plan: written, prefs: deps.prefs })?.answer ?? 'continue';
  const verdicts = creds.ids.length ? await deps.credentials.held(creds.ids) : [];
  const credentialsVerdict = probeCredentials(creds.ids, credentialPolicy, verdicts);

  // Probe 4 — delivery.
  const deliveryFacts = await deps.delivery();
  const delivery = probeDelivery(deliveryFacts);

  // Probe 5 — verification. A review that could not RUN refuses nothing (the
  // MCP preflight's rule): "I could not check" is not "it will stop".
  let verificationFacts: VerificationFacts | null = null;
  let verificationError: string | null = null;
  if (deps.verification) {
    try { verificationFacts = await deps.verification(); } catch (error) {
      verificationError = String((error as Error)?.message ?? error);
    }
  }
  const verificationVerdict: ProbeVerdict = verificationError
    ? { status: 'skip', ok: true, reason: `the verification review could not run: ${verificationError}` }
    : probeVerification(verificationFacts);

  // Probe 6 — the shared trees. Like probe 5, a read that could not RUN
  // refuses nothing; and unlike every other probe, this one never blocks.
  let treesVerdict: ProbeVerdict = { status: 'skip', ok: true, reason: 'the shared checkout was not read' };
  if (deps.trees) {
    try {
      treesVerdict = probeTrees(await deps.trees());
    } catch (error) {
      treesVerdict = { status: 'skip', ok: true, reason: `the shared checkout could not be read: ${String((error as Error)?.message ?? error)}` };
    }
  }

  // Probe 7 — the plan's git lines (#18). Never blocks: the start door asks
  // for the acknowledgement, which a probe cannot do.
  let gitVerdict: ProbeVerdict = { status: 'skip', ok: true, reason: "the plan's git lines were not read" };
  if (deps.gitStrategy) {
    try {
      gitVerdict = probeGitStrategy(await deps.gitStrategy());
    } catch (error) {
      gitVerdict = { status: 'skip', ok: true, reason: `the plan's git lines could not be read: ${String((error as Error)?.message ?? error)}` };
    }
  }

  // Probe 8 — the skill's interface against this console's (#151): the copies
  // the run's accounts would load. A read that could not RUN refuses nothing.
  let skillVerdict: ProbeVerdict = { status: 'skip', ok: true, reason: 'the skill copies were not read' };
  if (deps.skillApi) {
    try {
      skillVerdict = probeSkillApi(deps.skillApi(accounts.map((a) => a.id)));
    } catch (error) {
      skillVerdict = { status: 'skip', ok: true, reason: `the skill copies could not be read: ${String((error as Error)?.message ?? error)}` };
    }
  }

  // Probe 9 (control-tower phase 44): the plan's own human steps, each proof
  // run now. Like probe 6 it never blocks — a step still owed is an ask.
  let humanSteps: PreludeStep[] = [];
  let stepsVerdict: ProbeVerdict = { status: 'skip', ok: true, reason: "the plan's human steps were not read" };
  if (deps.humanSteps) {
    try {
      humanSteps = await doorSteps(await deps.humanSteps(), deps.probeStep);
      stepsVerdict = probeHumanSteps(humanSteps);
    } catch (error) {
      stepsVerdict = { status: 'skip', ok: true, reason: `the plan's human steps could not be read: ${String((error as Error)?.message ?? error)}` };
    }
  }

  const probes: Record<PreludeProbeId, ProbeVerdict> = {
    accounts: accountsVerdict, mcp: mcpVerdict, credentials: credentialsVerdict,
    delivery: { status: delivery.status, ok: delivery.ok, reason: delivery.reason, ...(delivery.warnings ? { warnings: delivery.warnings } : {}) },
    verification: verificationVerdict,
    trees: treesVerdict,
    'git-strategy': gitVerdict,
    skill: skillVerdict,
    'human-steps': stepsVerdict,
  };
  for (const row of rows) {
    if (row.key === 'accounts') row.probe = 'accounts';
    if (row.key === 'mcp') row.probe = 'mcp';
    if (row.key === 'credentials') row.probe = 'credentials';
    if (row.key === 'announce') row.probe = 'delivery';
    if (row.key === 'verification.person-check') row.probe = 'verification';
  }

  // The blocking list, in reading order.
  const blocking: { key: string; why: string }[] = [];
  if (manifest.error) {
    blocking.push({ key: 'plan-health', why: `the manifest could not be read: ${manifest.error}` });
  }
  for (const row of rows) {
    if (row.state === 'outstanding' && row.blocking === 'yes') {
      blocking.push({ key: row.key, why: `outstanding — owed by ${row.owner || 'nobody named'}` });
    }
  }
  const waived = rows.filter((row) => row.state === 'waived').map((row) => row.key);
  for (const key of waived) {
    if (!acknowledged.includes(key)) {
      const row = rows.find((r) => r.key === key)!;
      blocking.push({ key, why: `waived row not acknowledged${row.value ? ` — ${plain(row.value).slice(0, 120)}` : ''}` });
    }
  }
  if (!accountsVerdict.ok) blocking.push({ key: 'accounts', why: accountsVerdict.reason });
  if (!mcpVerdict.ok) blocking.push({ key: 'mcp', why: mcpVerdict.reason });
  if (!credentialsVerdict.ok) blocking.push({ key: 'credentials', why: credentialsVerdict.reason });
  // Under the manifest row that owns the class — a new key would be a decision
  // key the plan format does not have.
  if (!verificationVerdict.ok) blocking.push({ key: 'verification.person-check', why: verificationVerdict.reason });
  // Under its own key: no decision row owns "the two halves of the install
  // disagree" — the answer is an update, never a word in the plan.
  if (!skillVerdict.ok) blocking.push({ key: 'skill', why: skillVerdict.reason });
  const deliveryAcknowledged = acknowledged.includes('announce');
  if (!delivery.ok) {
    const announce = rows.find((r) => r.key === 'announce');
    if (deliveryAcknowledged) {
      if (announce) { announce.state = 'waived'; announce.value = `acknowledged without a channel — ${delivery.reason}`; announce.source = 'run'; announce.origin = 'run'; }
    } else {
      if (announce && announce.origin !== 'plan') { announce.state = 'outstanding'; announce.owner = 'operator'; announce.blocking = 'yes'; announce.value = delivery.reason; }
      blocking.push({ key: 'announce', why: `${delivery.reason} — acknowledge to start anyway` });
    }
  }

  return {
    slug,
    rows,
    probes,
    blocking,
    waived,
    acknowledged,
    manifestPresent: manifest.present,
    accounts,
    credentials: {
      policy: credentialPolicy,
      ids: creds.ids,
      held: verdicts.filter((v) => v.status === 'ok').map((v) => v.id),
      missing: verdicts.filter((v) => v.status === 'fail').map((v) => v.id),
    },
    delivery: { ok: delivery.ok, channels: delivery.channels, acknowledged: deliveryAcknowledged },
    ...(verificationFacts?.answers ? { verifyApprovals: verificationFacts.answers } : {}),
    humanSteps,
    at,
  };
}

function clampPct(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/** The manifest as `run.start` carries it and the run stores it. */
export function resolvedManifest(prelude: Prelude, override?: { rows: string[]; by: string } | null): ResolvedManifest {
  return {
    decisions: prelude.rows.map(({ probe: _probe, ...row }) => row),
    accounts: prelude.accounts,
    credentials: prelude.credentials,
    delivery: prelude.delivery,
    probes: Object.fromEntries(
      Object.entries(prelude.probes).map(([id, v]) => [id, { status: v.status, reason: v.reason }]),
    ),
    ...(override ? { overridden: { rows: override.rows, by: override.by, at: prelude.at } } : {}),
    at: prelude.at,
  };
}

/**
 * The start door's refusal (409): the request was well formed and the console
 * is fine — the manifest still owes an answer, or a probe found what the
 * plan said it needed is not here.
 */
export class PreludeRefusal extends Error {
  prelude: Prelude;
  unanswered: { key: string; why: string }[];

  constructor(prelude: Prelude) {
    const first = prelude.blocking[0];
    super(
      `The run cannot start: ${prelude.blocking.length} decision${prelude.blocking.length === 1 ? '' : 's'} still open — `
      + `${first ? `${first.key}: ${first.why}` : 'see the prelude'}`
      + (prelude.blocking.length > 1 ? ` (and ${prelude.blocking.length - 1} more)` : '')
      + '. Answer them in the plan\'s ## Decisions (or the Decisions stage), acknowledge a waived row, or start anyway with a recorded override.',
    );
    this.name = 'PreludeRefusal';
    this.prelude = prelude;
    this.unanswered = prelude.blocking;
  }
}
