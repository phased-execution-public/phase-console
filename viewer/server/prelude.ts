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
 *   2. Four PROBES run, each over the console's own facts and never over a
 *      secret's value: the accounts the run may spend (entitlement, sign-in,
 *      headroom against the declared minimum), the MCP servers the plan names
 *      (the boarding preflight, one pass), the credentials it names (presence
 *      by id — `credentials-probe.ts`), and a delivery channel for the
 *      announcements nobody will otherwise hear (a subscribed device,
 *      `PHASE_CONSOLE_NOTIFY`, a webhook; under `--remote` also Tailscale up
 *      and Serve pointing at this port). A probe that could not RUN answers
 *      `skip` and refuses nothing — the MCP preflight's rule.
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
import type { RelayMode } from '../shared/run-settings.js';
import type { HeadroomVerdict } from './accounts/index.ts';
import type { CredentialVerdict } from './credentials-probe.ts';
import type { PolicyPrefs } from './runner/policy.ts';
import type { AccountRequirement, ManifestDecision, ResolvedManifest } from './runner/state.ts';

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

export type PreludeProbeId = 'accounts' | 'mcp' | 'credentials' | 'delivery';

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
  prefs: PolicyPrefs;
  now?: () => string;
};

export type DeliveryFacts = {
  devices: number;
  notifyCommand: boolean;
  webhooks: number;
  remote: boolean;
  tailscale?: { running: boolean; forOurPort: boolean } | null;
};

const UNUSABLE_AUTH = new Set(['expired', 'signed-out', 'unusable']);

/* ------------------------------------------------------------------ *
 * The four probes — pure over facts
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

/* ------------------------------------------------------------------ *
 * The prelude
 * ------------------------------------------------------------------ */

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

  const probes: Record<PreludeProbeId, ProbeVerdict> = {
    accounts: accountsVerdict, mcp: mcpVerdict, credentials: credentialsVerdict,
    delivery: { status: delivery.status, ok: delivery.ok, reason: delivery.reason, ...(delivery.warnings ? { warnings: delivery.warnings } : {}) },
  };
  for (const row of rows) {
    if (row.key === 'accounts') row.probe = 'accounts';
    if (row.key === 'mcp') row.probe = 'mcp';
    if (row.key === 'credentials') row.probe = 'credentials';
    if (row.key === 'announce') row.probe = 'delivery';
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
