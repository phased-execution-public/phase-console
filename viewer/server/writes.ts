/**
 * The guarded write verbs.
 *
 * Writing is off unless the server was started with `--allow-writes`, every
 * argument is validated against a strict shape before it reaches a script, and
 * `--git` is never passed — so the console can scaffold and record, but can
 * never commit, push, or touch a remote. Arguments are passed as an argv array
 * (never a shell string), so nothing here can be turned into shell injection.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

import { openerCandidates } from './platform.ts';
import {
  CLOSED_PLAN_STATUSES,
  HANDOFF_STATUSES,
  QA_RESULTS, QA_DIRECTIVES,
} from '../shared/plan-vocab.js';

export type WriteAction =
  | 'new-plan' | 'new-handoff' | 'qa-record' | 'gate-approve' | 'lock-claim' | 'lock-release'
  | 'close-plan' | 'reopen-plan' | 'open-editor' | 'qa-mode';

export type WriteRequest = {
  action: WriteAction;
  slug?: string;
  phase?: number;
  title?: string;
  status?: string;
  result?: string;
  report?: string;
  /** Which review produced a QA verdict — chosen by the caller, never here. */
  round?: number;
  owner?: string;
  /** Why a plan is being closed — recorded in its front matter, one line. */
  reason?: string;
  /** Who cleared a gate — a name, not the owner's account/session pair. */
  by?: string;
  qa?: boolean;
  force?: boolean;
  /**
   * Optional qualification for a lock-claim: which branch and working tree the
   * claim rides (`--branch`/`--worktree`). Passed through VERBATIM when the
   * caller states them — never invented server-side: a console claim is made
   * on the OPERATOR's behalf, and stamping a run's branch onto it would be one
   * actor asserting another's facts. A bare claim stays unqualified, which
   * collides with everything — the deliberate, conservative default.
   */
  branch?: string;
  worktree?: string;
  /** Un-approve a gate: the row flips to `revoked` and the gate is back in force. */
  revoke?: boolean;
  path?: string;
  /**
   * The QA directive to write (`qa-mode`): `on`/`off` for the plan (no
   * `phase`) or for one phase; `inherit` removes a phase's own bullet. The
   * WRITER's words — what the engine reads back is `QA_MODES`.
   */
  mode?: string;
};

export type WriteOutcome = {
  ok: boolean;
  /** Exactly what ran, for the confirmation dialog and the result panel. */
  command: string;
  code: number;
  stdout: string;
  stderr: string;
};

const SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;
const TITLE = /^[a-z0-9][a-z0-9-]{1,63}$/;
/** A gate approver: a short human name, not the OWNER account/session pair.
 * The first character must not be a dash — an option-shaped name would read
 * as a flag by any hand that later pastes the recorded value into a shell. */
const GATE_BY = /^[\w.@+][\w .@+-]{0,63}$/;
const HANDOFF_STATUS: readonly string[] = HANDOFF_STATUSES;
const QA_RESULT: readonly string[] = QA_RESULTS;
const QA_DIRECTIVE: readonly string[] = QA_DIRECTIVES;
const OWNER = /^[\w.@+-]{1,64}\/[\w.@+-]{1,64}$/;
/** `active` is deliberately absent: reopening is its own action, not a status. */
const CLOSE_STATUS: readonly string[] = CLOSED_PLAN_STATUSES;
const REASON_MAX = 200;

/**
 * One line, no `#`, no runaway length — the same shape `close-plan.sh` enforces
 * before it writes. Duplicated rather than delegated because a validated request
 * is the contract at this boundary: the script is the last guard, not the first.
 */
function cleanReason(raw?: string, max = REASON_MAX): string {
  return (raw ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/#/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * A QA waiver's reason is bounded at 280, not at `REASON_MAX`.
 *
 * The other three layers — the client textarea, the `qa-waive` route and
 * `qa-record.sh` itself — all agree on 280, and this door silently cut at 200
 * first, so an operator's last eighty characters vanished between the box they
 * typed in and the file (QA round 1, L5). `REASON_MAX` stays where it is: it
 * bounds a plan's `closed_reason` and a gate note, which are different fields
 * in different files.
 */
const WAIVER_REASON_MAX = 280;

export class WriteError extends Error {}

function requireSlug(slug?: string): string {
  if (!slug || !SLUG.test(slug)) throw new WriteError('Slug must be kebab-case: lowercase letters, digits and dashes.');
  return slug;
}

function requirePhase(phase?: number): number {
  if (!Number.isInteger(phase) || (phase as number) < 1 || (phase as number) > 999) {
    throw new WriteError('Phase must be a whole number between 1 and 999.');
  }
  return phase as number;
}

export type WritePlan = { script: string; args: string[]; description: string };

/** Translate a request into the exact script invocation, or refuse it. */
export function planWrite(request: WriteRequest, opts: { root: string; docsDir?: string }): WritePlan {
  switch (request.action) {
    case 'new-plan': {
      const slug = requireSlug(request.slug);
      if (opts.docsDir && existsSync(join(opts.docsDir, 'plans', `${slug}.md`))) {
        throw new WriteError(`docs/plans/${slug}.md already exists.`);
      }
      return { script: 'new-plan.sh', args: [slug], description: `Scaffold docs/plans/${slug}.md` };
    }

    case 'new-handoff': {
      const slug = requireSlug(request.slug);
      const phase = requirePhase(request.phase);
      const title = (request.title ?? '').trim();
      if (!TITLE.test(title)) throw new WriteError('Title must be kebab-case, e.g. cart-api-endpoint.');
      const status = request.status ?? 'complete';
      if (!HANDOFF_STATUS.includes(status)) throw new WriteError(`Status must be one of ${HANDOFF_STATUS.join(', ')}.`);
      const args = [slug, String(phase), title, status];
      if (request.qa) args.push('--qa');
      if (request.force) args.push('--force');
      return {
        script: 'new-handoff.sh',
        args,
        description: `Scaffold the phase ${phase} handoff for ${slug} (${status})`,
      };
    }

    case 'qa-record': {
      const slug = requireSlug(request.slug);
      const phase = requirePhase(request.phase);
      const result = request.result ?? '';
      if (!QA_RESULT.includes(result)) throw new WriteError(`QA result must be one of ${QA_RESULT.join(', ')}.`);
      const report = (request.report ?? '').trim();
      if (!report || isAbsolute(report) || normalize(report).startsWith('..')) {
        throw new WriteError('Report must be a relative path inside the handoff folder.');
      }
      const args = [slug, String(phase), result, '--report', report];
      // A round the CALLER chose, because the only caller that passes one is
      // the QA-recovery loop, which has already asked the one chooser. This
      // door never numbers a round itself — a second opinion about which round
      // this is has been the defect four times (Phase 4, QA rounds 1-4).
      if (typeof request.round === 'number' && Number.isInteger(request.round) && request.round >= 1) {
        if (result === 'pending') throw new WriteError('A pending row is roundless — a round is a review that happened.');
        if (request.round > 999_999) throw new WriteError('Round is limited to six digits.');
        args.push('--round', String(request.round));
      }
      // `waived` only, exactly as the script refuses it, so the reason is
      // rejected HERE with a sentence rather than by an exit code the browser
      // would render as "the write failed".
      const why = cleanReason(request.reason, WAIVER_REASON_MAX);
      if (why) {
        if (result !== 'waived') throw new WriteError('A reason is only recorded with a waiver.');
        args.push('--reason', why);
      }
      return {
        script: 'qa-record.sh',
        args,
        description: `Record QA ${result} for ${slug} phase ${phase}`,
      };
    }

    case 'gate-approve': {
      const slug = requireSlug(request.slug);
      const phase = requirePhase(request.phase);
      const by = (request.by ?? '').trim();
      if (by && !GATE_BY.test(by)) {
        throw new WriteError('Who approved must be 1-64 characters: letters, digits, spaces, dots, @, + or dashes.');
      }
      const note = cleanReason(request.reason);
      const args = [slug, String(phase)];
      if (by) args.push('--by', by);
      if (note) args.push('--note', note);
      if (request.revoke) args.push('--revoke');
      return {
        script: 'gate-approve.sh',
        args,
        description: request.revoke
          ? `Revoke the phase ${phase} gate approval on ${slug}`
          : `Approve the phase ${phase} gate on ${slug}${by ? ` as ${by}` : ''}`,
      };
    }

    case 'lock-claim':
    case 'lock-release': {
      const slug = requireSlug(request.slug);
      const phase = requirePhase(request.phase);
      const owner = (request.owner ?? '').trim();
      if (!OWNER.test(owner)) throw new WriteError('Owner must look like "account/session".');
      const verb = request.action === 'lock-claim' ? 'claim' : 'release';
      const args = [slug, verb, String(phase), '--owner', owner];
      if (verb === 'claim') {
        const branch = (request.branch ?? '').trim().slice(0, 256);
        const worktree = (request.worktree ?? '').trim().slice(0, 256);
        if (branch && !branch.includes('\n')) args.push('--branch', branch);
        if (worktree && !worktree.includes('\n')) args.push('--worktree', worktree);
      }
      // `--force` on either verb now. Release used to refuse it, which left a
      // live claim releasable only from a terminal — fine while a claim was
      // decoration, a dead end once it started blocking runs. The console asks
      // for confirmation before it ever sets this.
      if (request.force) args.push('--force');
      return {
        script: 'phase-lock.sh',
        args,
        description: `${verb === 'claim' ? 'Claim' : 'Release'} the phase ${phase} lock on ${slug} as ${owner}`,
      };
    }

    case 'close-plan': {
      const slug = requireSlug(request.slug);
      const status = request.status ?? 'abandoned';
      if (!CLOSE_STATUS.includes(status)) {
        throw new WriteError(`Status must be one of ${CLOSE_STATUS.join(', ')}. Use the reopen action to reopen a plan.`);
      }
      const reason = cleanReason(request.reason);
      // The script refuses a reasonless close unless forced; refuse it here too,
      // where the message can say what to do about it.
      if (!reason && !request.force) {
        throw new WriteError('Say why the plan is being closed — a closed plan with no reason tells the next reader nothing.');
      }
      const args = [slug, '--status', status];
      if (reason) args.push('--reason', reason);
      if (!reason && request.force) args.push('--force');
      return {
        script: 'close-plan.sh',
        args,
        description: `Close ${slug} as ${status}${reason ? ` — ${reason}` : ''}`,
      };
    }

    case 'reopen-plan': {
      const slug = requireSlug(request.slug);
      return {
        script: 'close-plan.sh',
        args: [slug, '--reopen'],
        description: `Reopen ${slug} (status: active)`,
      };
    }

    case 'qa-mode': {
      // The plan file already carries both switches and the engine has read
      // them for months (`**QA gate:** on|off` in §Session budget, `- **QA:**
      // on|off` in a phase's block); until 2026-09-07 the console could only
      // ACTIVATE (`new-handoff --qa`), never turn the gate off and never per
      // phase — the inbox told the operator to hand-edit the file.
      const slug = requireSlug(request.slug);
      const mode = (request.mode ?? '').trim();
      if (!QA_DIRECTIVE.includes(mode)) throw new WriteError(`QA mode must be one of ${QA_DIRECTIVE.join(', ')}.`);
      if (request.phase == null) {
        if (mode === 'inherit') {
          throw new WriteError('`inherit` is a phase\'s word — it removes that phase\'s own directive. A plan has nothing to inherit from.');
        }
        return { script: 'qa-mode.sh', args: [slug, mode], description: `Turn the QA gate ${mode} for ${slug}` };
      }
      const phase = requirePhase(request.phase);
      return {
        script: 'qa-mode.sh',
        args: [slug, '--phase', String(phase), mode],
        description: mode === 'inherit'
          ? `Let phase ${phase} of ${slug} inherit the plan's QA regime`
          : `Turn QA ${mode} for phase ${phase} of ${slug}`,
      };
    }

    case 'open-editor':
      throw new WriteError('Editor launches do not go through planWrite.');

    default:
      throw new WriteError('Unknown action.');
  }
}

export async function runWrite(
  plan: WritePlan,
  opts: { scriptsDir: string; root: string },
): Promise<WriteOutcome> {
  if (plan.args.includes('--git')) throw new WriteError('refusing to run a script with --git');

  const command = `${plan.script} ${plan.args.join(' ')}`;
  return new Promise((resolveOutcome) => {
    execFile(
      'bash',
      [join(opts.scriptsDir, plan.script), ...plan.args],
      {
        timeout: 20_000,
        maxBuffer: 4 * 1024 * 1024,
        cwd: opts.root,
        env: { ...process.env, DOCS_ROOT: opts.root, NO_COLOR: '1', TERM: 'dumb' },
      },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === 'number'
          ? (error as unknown as { code: number }).code
          : error ? 1 : 0;
        resolveOutcome({ ok: code === 0, command, code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/**
 * Is `target` inside `base`? — the containment predicate `openInEditor` keeps,
 * shared so the QA-report reader answers the same question the same way.
 * `relative()` rather than a string prefix (see the note in `openInEditor`);
 * both paths are resolved here, so a caller may hand over either form.
 */
export function insideDir(base: string, target: string): boolean {
  const rel = relative(resolve(base), resolve(target));
  return Boolean(rel) && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

/**
 * Hand a file to the user's editor. It writes nothing itself, but it does
 * spawn a process, so it stays inside the docs tree and behind the same flag.
 */
export async function openInEditor(path: string, docsDir: string): Promise<WriteOutcome> {
  // A relative request is answered against the DOCS directory, never against
  // `process.cwd()`. The console's cwd is wherever the launcher started it —
  // launchd, `viewer/run`, a `phase-console start` — so a path resolved from
  // there is a path nobody asked for, and the guard below would then be
  // comparing against a base that has nothing to do with the request.
  const base = resolve(docsDir);
  const target = resolve(base, path);
  // `target.startsWith(base)` is not containment: with docsDir `/repo/docs`,
  // `/repo/docs-archive/secrets.md` begins with `/repo/docs` and passes. There
  // is no separator in the comparison, so every sibling whose name merely
  // starts with the docs basename is inside. `relative()` answers the real
  // question — target is inside iff the answer is a non-empty, non-absolute
  // path that does not climb out. `..` is checked both bare (target is the
  // parent) and as a leading segment (`../…`), which is why `sep` is here and
  // a raw `startsWith('..')` is not: a file legitimately named `..notes.md`
  // is inside and must stay openable.
  if (!insideDir(base, target)) throw new WriteError('Refusing to open a file outside the docs directory.');
  if (!existsSync(target)) throw new WriteError('No such file.');

  const editor = process.env.VISUAL || process.env.EDITOR;
  const [command, args] = editor
    ? [editor.split(/\s+/)[0], [...editor.split(/\s+/).slice(1), target]]
    // `open` on macOS, `wslview` on WSL (the file's viewer is on the Windows
    // side), `xdg-open` on a Linux desktop. A miss is an honest ok:false.
    : [openerCandidates()[0] ?? 'xdg-open', [target]];

  return new Promise((resolveOutcome) => {
    execFile(command, args, { timeout: 10_000 }, (error, stdout, stderr) => {
      resolveOutcome({
        ok: !error,
        command: `${command} ${args.join(' ')}`,
        code: error ? 1 : 0,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });
}
