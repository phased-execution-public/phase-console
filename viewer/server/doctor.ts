/**
 * `phase-console doctor` (phase 11 — sep-review chapter 13 §1.2's last line,
 * errand E6's proof, phase 23's exit criterion): the run-start prelude's four
 * probes with no plan in front of them, plus the machine facts a console needs
 * to be worth starting — one report, by hand or over `GET /api/doctor`, exit
 * non-zero naming the FIRST failing row that blocks.
 *
 * A leaf on purpose. Everything here is a pure function over `DoctorDeps`;
 * the two builders of those deps live where their facts live —
 * `Service.doctorDeps()` (the live facades, behind the route) and
 * `bin/doctor-verb.mjs` (the state directory and the machine, when no
 * console answers). This file imports nothing that resolves an instance at
 * module load, so the CLI can import it from a process that is not a console
 * and ask about any instance on the machine.
 *
 * The rows, in the order they print:
 *
 *   accounts     the machine login and every registered account — entitlement,
 *                sign-in, headroom (the prelude's probe, minimum 0)        BLOCKING
 *   mcp          the registry's servers, probed as the boarding preflight does
 *   credentials  the machine `claude` login (E7: the one credential every
 *                plan needs)                                                BLOCKING
 *   delivery     a channel for announcements: device, notify command, webhook;
 *                under --remote, Tailscale up and Serve on this port
 *   hooks        the session-presence hooks installed and pointing at THIS copy BLOCKING
 *   unit         the instance's launchd unit: present, enabled, RunAtLoad,
 *                and no stopped-by-console marker                          (Pro)
 *   cli          the Claude CLI version against the relay floor
 *   gh           `gh auth status`
 *   publish      `--allow-publish`: may this console push `pe/*` branches and
 *                file issues at all (advisory — off is a fine console)
 *   environment  the environment doctor's issues (PATH, a foreign home, push) BLOCKING
 *   console      a console answering on the instance's port, and healthy     BLOCKING when unhealthy
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ProbeStatus } from '../shared/ops-vocab.js';
import { RELAY_CLI_FLOOR, versionAtLeast } from '../shared/run-settings.js';
import { DELIVERY_ISSUE_ID, type EnvIssue } from './env-doctor.ts';
import type { HooksStatus } from './hooks-install.ts';
import type { ProbeVerdict } from './prelude.ts';

export type DoctorRowId =
  | 'accounts' | 'mcp' | 'credentials' | 'delivery' | 'hooks' | 'unit' | 'cli' | 'gh' | 'publish' | 'git' | 'environment' | 'console';

export type DoctorRow = {
  id: DoctorRowId;
  label: string;
  status: ProbeStatus;
  /** Does a `fail` on this row make the report fail (exit 1)? */
  blocking: boolean;
  reason: string;
  warnings?: string[];
  detail?: unknown;
};

export type DoctorInstance = { id: string; name: string; root: string | null; port: number; default: boolean };

export type DoctorReport = {
  instance: DoctorInstance | null;
  /** `console` — a running console answered; `offline` — read from the state directory and the machine. */
  mode: 'console' | 'offline';
  rows: DoctorRow[];
  ok: boolean;
  firstFailing: DoctorRow | null;
  cliFloor: string;
  at: string;
};

/** The facts a doctor row reads — every one a function, so a caller supplies what it has. */
export type DoctorDeps = {
  instance: DoctorInstance | null;
  mode: DoctorReport['mode'];
  accounts: () => Promise<ProbeVerdict>;
  mcp: () => Promise<ProbeVerdict>;
  credentials: () => Promise<ProbeVerdict>;
  delivery: () => Promise<ProbeVerdict>;
  hooks: () => Promise<HooksStatus | null>;
  /**
   * The launchd unit's state, or `null` when the platform has none / the
   * caller cannot read it (`skip`). Pro-only in the free tree, where no unit
   * exists.
   */
  unit: () => Promise<UnitFacts | null>;
  cliVersion: () => Promise<string | undefined>;
  gh: () => Promise<ProbeVerdict>;
  /**
   * Is `--allow-publish` on — may this console push a `pe/*` branch or file an
   * issue at all? A flag read, so it is synchronous and never throws; absent
   * (an older deps builder) reads as off, which is the truthful default.
   */
  publish?: () => boolean;
  /**
   * `git --version` and `rev-parse --is-inside-work-tree` at the root, run
   * under the CONSOLE's own `process.env.PATH`. `null` = the probe could not
   * run at all, which is not the same as git being broken.
   */
  git: () => Promise<GitFacts | null>;
  environment: () => EnvIssue[];
  /** A console on the instance's port: reachable, healthy, and whether its dist is stale. `null` = nothing answered. */
  console: () => Promise<{ healthy: boolean; serverStale?: boolean; version?: string } | null>;
  now?: () => string;
};

export type UnitFacts = {
  /** The unit file exists. */
  installed: boolean;
  /** `launchctl print-disabled` names it disabled (a deliberate off switch, E1). */
  disabled: boolean | null;
  /** The plist's RunAtLoad key. */
  runAtLoad: boolean | null;
  /** The `stopped-by-console.json` marker (phase 16) is present. */
  stoppedMarker: boolean;
  label: string;
};

/** A verdict that says the probe could not be asked here. */
export function skipped(reason: string): ProbeVerdict {
  return { status: 'skip', ok: true, reason };
}

/* ------------------------------------------------------------------ *
 * The rows
 * ------------------------------------------------------------------ */

function row(id: DoctorRowId, label: string, blocking: boolean, verdict: ProbeVerdict): DoctorRow {
  return {
    id, label, blocking, status: verdict.status, reason: verdict.reason,
    ...(verdict.warnings?.length ? { warnings: verdict.warnings } : {}),
    ...(verdict.detail !== undefined ? { detail: verdict.detail } : {}),
  };
}

async function settle(fn: () => Promise<ProbeVerdict>, what: string): Promise<ProbeVerdict> {
  try { return await fn(); } catch (error) {
    return skipped(`${what} could not be asked — ${String((error as Error)?.message ?? error)}`);
  }
}

/**
 * Is `version` at or above `floor` — the shared comparison
 * (`shared/run-settings.js` `versionAtLeast`), which the floor flag reads too.
 */
export function atLeast(version: string | undefined, floor: string): boolean | null {
  return versionAtLeast(version, floor);
}

export function hooksVerdict(status: HooksStatus | null): ProbeVerdict {
  if (!status) return skipped('the hook installer could not read the settings file');
  if (status.parseError) return { status: 'fail', ok: false, reason: `${status.path} does not parse — ${status.parseError}` };
  if (!status.installed) {
    return {
      status: 'fail', ok: false,
      reason: `${status.partial ? 'partially installed' : 'not installed'} in ${status.path} — run phase-console install-hooks`,
    };
  }
  if (status.stale) {
    return { status: 'fail', ok: false, reason: `${status.path} points at another checkout's session-hook.sh — run phase-console install-hooks from this one` };
  }
  return { status: 'ok', ok: true, reason: `installed in ${status.path}, pointing at this copy` };
}


export type GitFacts = {
  /** `git --version`'s first line, or `null` when it printed none. */
  version: string | null;
  /** Its exit code. `null` means git was not on this process's `PATH` at all. */
  code: number | null;
  /** stderr's first line — where Apple's licence notice lands. */
  stderr?: string;
  /** `rev-parse --is-inside-work-tree` at the root; `null` = no root open to ask about. */
  insideWorkTree: boolean | null;
  /** WHICH git answered. Two are usually installed and they behave differently. */
  path?: string;
  root?: string | null;
};

/** Apple's shim's exit code for an unaccepted licence, and the sentence it prints. */
const XCODE_LICENCE_CODE = 69;
const XCODE_LICENCE = /xcode license|xcodebuild -license/i;

/**
 * Is git usable by THIS process?
 *
 * The row exists because of one measured incident (errand E7). Under launchd
 * the console's `PATH` leads with `/usr/bin`, where macOS keeps Apple's `git`
 * SHIM — and until `xcodebuild -license` has been accepted that shim exits 69
 * with a licence notice, for every subcommand, forever. On 2026-09-16 this
 * console's own run read its repository as `not-a-repo`, was refused isolation
 * and degraded to the shared root, while `doctor` reported the environment
 * healthy the whole time: nothing it probed ran git.
 *
 * Blocking, because a console that cannot run git cannot make a worktree, read
 * a branch, or land anything — every capability it has is downstream of this.
 * And "git works in my terminal" is not the question: the probe runs under the
 * console's own environment, which under a launch agent is a different `PATH`
 * from the one a person sees.
 */
export function gitVerdict(facts: GitFacts | null): ProbeVerdict {
  if (!facts) return skipped('the git probe could not run');
  const where = facts.path ? ` (${facts.path})` : '';
  if (facts.code === null) {
    return {
      status: 'fail',
      ok: false,
      reason: 'git is not on this console’s PATH — every worktree, branch read and landing needs it',
    };
  }
  if (facts.code === XCODE_LICENCE_CODE || XCODE_LICENCE.test(facts.stderr ?? '')) {
    return {
      status: 'fail',
      ok: false,
      reason: `git${where} exits ${facts.code}: the Xcode license has not been accepted. `
        + 'Run `sudo xcodebuild -license accept` once — until then every git this console runs fails silently.',
    };
  }
  if (facts.code !== 0) {
    return {
      status: 'fail',
      ok: false,
      reason: `git${where} exited ${facts.code}${facts.stderr ? ` — ${facts.stderr}` : ''}`,
    };
  }
  const version = facts.version ?? 'git';
  if (facts.insideWorkTree === false) {
    return {
      status: 'fail',
      ok: false,
      reason: `${version}${where} runs, but ${facts.root ?? 'the source directory'} is not a git repository`,
    };
  }
  return {
    status: 'ok',
    ok: true,
    reason: facts.insideWorkTree === true
      ? `${version}${where}, and the source directory is a git repository`
      : `${version}${where}`,
  };
}

/**
 * The publish row: advisory in both directions. Off is the shipped default and
 * a perfectly good console — every landing policy but `pr` and `trunk` needs
 * no push, and those two park with the reason when the flag is off. On says
 * what the flag licenses and what still narrows it, so an operator reading
 * `doctor` is never surprised by a push they did not know was possible.
 */
export function publishVerdict(on: boolean): ProbeVerdict {
  return on
    ? {
      status: 'ok', ok: true,
      reason: 'on — the console may push pe/* branches (never a trunk, never with force) and file issues, '
        + 'only where a plan\'s permission.destructive row and Issues: line allow it',
    }
    : {
      status: 'skip', ok: true,
      reason: 'off — the console pushes nothing and files nothing; a `Land: pr|trunk` phase parks with the reason '
        + '(start with --allow-publish to let a landing push its pe/* branch)',
    };
}

export function cliVerdict(version: string | undefined): ProbeVerdict {
  const ok = atLeast(version, RELAY_CLI_FLOOR);
  if (ok === null) return skipped('the claude CLI did not answer --version');
  return ok
    ? { status: 'ok', ok: true, reason: `claude ${version} ≥ ${RELAY_CLI_FLOOR} (the relay can arm)` }
    : { status: 'fail', ok: false, reason: `claude ${version} is below ${RELAY_CLI_FLOOR} — the relay will not arm; update the CLI` };
}

/**
 * The environment doctor's own words: a thin or foreign PATH "is not fatal" —
 * `hardenedPath` rescues the standard directories at verify time — so the PATH
 * kinds are warnings, folded per kind with their count (a shell launched by
 * an IDE carries a dozen dead plugin `bin` entries). `push-broken` is a real
 * defect and fails the row.
 */
export function environmentVerdict(issues: EnvIssue[]): ProbeVerdict {
  if (!issues.length) return { status: 'ok', ok: true, reason: 'no environment issue' };
  // The delivery-channel issue is the `delivery` row's own fact (phase 11,
  // non-blocking): counted there, never a second time here as a blocking one.
  const own = issues.filter((i) => i.id !== DELIVERY_ISSUE_ID);
  if (!own.length) return { status: 'ok', ok: true, reason: 'no environment issue beyond the delivery row' };
  const broken = own.filter((i) => i.kind === 'push-broken');
  const advisories = own.filter((i) => i.kind !== 'push-broken');
  const counts = new Map<string, EnvIssue[]>();
  for (const issue of advisories) counts.set(issue.kind, [...(counts.get(issue.kind) ?? []), issue]);
  const warnings = [...counts].map(([kind, list]) =>
    `${kind} ×${list.length}: ${list.map((i) => i.detail.replace(/^PATH entry [^:]*: /, '')).join(', ')} — ${list[0]!.fix}`);
  if (broken.length) {
    return {
      status: 'fail', ok: false,
      reason: `${broken.length} issue${broken.length === 1 ? '' : 's'}: ${broken.map((i) => `${i.kind} — ${i.detail}`).join('; ')}`,
      ...(warnings.length ? { warnings } : {}),
      detail: issues,
    };
  }
  return {
    status: 'ok', ok: true,
    reason: `${advisories.length} PATH advisor${advisories.length === 1 ? 'y' : 'ies'} (not fatal — verification hardens the PATH itself)`,
    warnings,
    detail: issues,
  };
}

export function consoleVerdict(
  state: { healthy: boolean; serverStale?: boolean; version?: string } | null, port: number | undefined,
): ProbeVerdict {
  if (!state) return skipped(`no console is answering on :${port ?? '?'} — the machine rows above were read from disk`);
  if (!state.healthy) return { status: 'fail', ok: false, reason: `the console on :${port} reports itself degraded` };
  return {
    status: 'ok', ok: true,
    reason: `answering on :${port}${state.version ? `, ${state.version}` : ''}${state.serverStale ? ' — its server code is older than its checkout (restart to pick it up)' : ''}`,
    ...(state.serverStale ? { warnings: ['server code is stale — restart the console'] } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * The report
 * ------------------------------------------------------------------ */

export async function doctorReport(deps: DoctorDeps): Promise<DoctorReport> {
  const at = (deps.now ?? (() => new Date().toISOString()))();
  const rows: DoctorRow[] = [];
  rows.push(row('accounts', 'Accounts', true, await settle(deps.accounts, 'the accounts probe')));
  rows.push(row('mcp', 'MCP servers', false, await settle(deps.mcp, 'the MCP preflight')));
  rows.push(row('credentials', 'Credentials (machine login)', true, await settle(deps.credentials, 'the credential probe')));
  rows.push(row('delivery', 'Delivery channel', false, await settle(deps.delivery, 'the delivery probe')));
  rows.push(row('hooks', 'Session-presence hooks', true, hooksVerdict(await deps.hooks().catch(() => null))));
  rows.push(row('cli', 'Claude CLI', false, cliVerdict(await deps.cliVersion().catch(() => undefined))));
  rows.push(row('gh', 'GitHub CLI', false, await settle(deps.gh, 'gh auth status')));
  rows.push(row('publish', 'Outward writes (--allow-publish)', false, publishVerdict(safePublish(deps))));
  // BLOCKING, unlike `gh` and `cli`: a console whose git does not run cannot
  // make a worktree, read a branch, or land anything — see `gitVerdict`.
  rows.push(row('git', 'git', true, gitVerdict(await deps.git().catch(() => null))));
  rows.push(row('environment', 'Environment', true, environmentVerdict(safeIssues(deps))));
  const consoleState = await deps.console().catch(() => null);
  rows.push(row('console', 'Console', true, consoleVerdict(consoleState, deps.instance?.port)));
  const firstFailing = rows.find((r) => r.blocking && r.status === 'fail') ?? null;
  return {
    instance: deps.instance,
    mode: deps.mode,
    rows,
    ok: firstFailing === null,
    firstFailing,
    cliFloor: RELAY_CLI_FLOOR,
    at,
  };
}

function safeIssues(deps: DoctorDeps): EnvIssue[] {
  try { return deps.environment(); } catch { return []; }
}

function safePublish(deps: DoctorDeps): boolean {
  try { return deps.publish?.() === true; } catch { return false; }
}

/** The CLI's exit code: 1 when a blocking row failed, else 0. */
export function doctorExitCode(report: DoctorReport): 0 | 1 {
  return report.ok ? 0 : 1;
}

const MARK: Record<ProbeStatus, string> = { ok: '✓', fail: '✗', skip: '–' };

/** One line per row, the way the CLI prints it; the last line names the verdict. */
export function formatDoctor(report: DoctorReport): string {
  const head = report.instance
    ? `phase-console doctor — ${report.instance.name} (${report.instance.id}, :${report.instance.port})`
      + ` — ${report.mode === 'console' ? 'answered by the running console' : 'read from disk and the machine; no console answered'}`
    : `phase-console doctor — ${report.mode === 'console' ? 'answered by the running console' : 'no instance resolved; machine rows only'}`;
  const width = Math.max(...report.rows.map((r) => r.label.length));
  const lines = report.rows.map((r) => {
    const tail = r.warnings?.length ? `\n${' '.repeat(width + 6)}↳ ${r.warnings.join('\n' + ' '.repeat(width + 8) + '↳ ')}` : '';
    return `  ${MARK[r.status]} ${r.label.padEnd(width)}  ${r.reason}${r.blocking && r.status === 'fail' ? '  [blocking]' : ''}${tail}`;
  });
  const verdict = report.ok
    ? 'doctor: ok'
    : `doctor: ${report.firstFailing!.id} — ${report.firstFailing!.reason}`;
  return [head, ...lines, verdict].join('\n');
}
