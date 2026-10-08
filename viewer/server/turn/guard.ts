/**
 * The guard at the door of Your turn (control-tower phase 130, §Architecture
 * 19, #207) — RULES, never a judgement call, run twice: at the declaration's
 * pre-check (`POST /hooks/declaration`, while the session is still there to
 * hear it) and again at ingest, when the runner turns the declaration into a
 * ledger item.
 *
 *   G1  a reason from `WHY_PERSON` the kind allows (`KIND_REASONS`); none named
 *       → the kind's default, marked `inferred`.
 *   G2  a proof — a ref or words — unless the answer is the result; `attest`
 *       only when asked for by name.
 *   G3  a proof already true raises nothing — the pre-check's probe (exit 3),
 *       not this module.
 *   G4  the AI can do it — judged ONLY for a DECLARED reason that claims the AI
 *       cannot (`permission`, `reserved`, `reach`): every command the guide asks
 *       for allowed by the declaring run's own policy → refused (exit 4, the
 *       commands named); a command a RULE stops → re-shaped as a `permission`
 *       item naming the wall; `reach` with no `--tried` → refused (exit 4). A
 *       guide with no command is never refused, and a refusal raised again with
 *       `--tried` is accepted and marked `overruled`.
 *   G5  a permission item cites a wall the console RECORDED for the declaring
 *       lane (`permissions/walls.ts` `citedWall`) — a deny rule, a tool outside
 *       the allow list, an MCP tool, a guard — else it is refused: "nothing
 *       refused this — run it" (exit 4, control-tower phase 135).
 *   G6  the secret screen — refused at the door, redacted at ingest.
 *   G7  the same wall met twice is ONE item with another waiter — the ledger's
 *       (`declareHumanStep`), because only the ledger knows what is open.
 *
 * Pure: the run's policy arrives as a `CommandJudge`; nothing here reads a file.
 */

import {
  G4_REASONS, G5_SENTENCE, GUARD_REFUSAL_EXIT, PROOF_TYPES, PROOF_TYPES_SELF, WHY_PERSON,
  defaultReason, inferProofType, reasonAllowed,
  type ProofType, type Wall, type WhyPerson,
} from '../../shared/turn-model.js';
import { guideCommands, type Guide } from '../../shared/guide-grammar.js';
import { KIND_META, SIGN_IN_SHAPES, humanStepKindOf, looksLikeSecret, redactSecrets } from '../../shared/human-step-model.js';
import { citedWall, type RecordedWall } from '../permissions/walls.ts';

/** What the declaring run's policy says of one command — `classifyTool`'s words. */
export type CommandVerdict = 'allow' | 'ask' | 'deny' | 'hold';

/** The run's own policy, asked one command at a time; `rule` names the deny rule that decided, if one did. */
export type CommandJudge = (command: string) => { verdict: CommandVerdict; rule?: string | null };

/** Where the guard is standing: the declaration's pre-check, or the runner's ingest. */
export type GuardStage = 'door' | 'ingest';

/** What the guard reads of one declared item. */
export type GuardInput = {
  kind: string;
  title?: string;
  why?: string;
  proofType?: string;
  proof?: string;
  proofWords?: string;
  guide?: Guide | null;
  openCommand?: string;
  tried?: string;
};

/** The rules that can refuse, and the exit each ends a declaration with. */
export type GuardRefusal = {
  ok: false;
  rule: 'G1' | 'G2' | 'G4' | 'G5' | 'G6';
  exit: 2 | typeof GUARD_REFUSAL_EXIT;
  sentence: string;
  commands?: string[];
};

/** A permission item the guard re-shaped an act into — the wall a rule put in the way. */
export type GuardReshape = { kind: 'permission'; why: 'permission'; wall: Wall; rule?: string; command: string };

export type GuardPass = {
  ok: true;
  why: WhyPerson;
  whySource: 'declared' | 'inferred';
  proofType: ProofType;
  proofTypeSource: 'declared' | 'inferred';
  /** A G4 refusal raised again with `--tried`: accepted, marked *the guard was overruled by evidence*. */
  overruled?: true;
  reshape?: GuardReshape;
};

export type GuardVerdict = GuardPass | GuardRefusal;

/** Quote-free, so the script can lift it from JSON as it is. */
function refuse(rule: GuardRefusal['rule'], exit: GuardRefusal['exit'], sentence: string, commands?: string[]): GuardRefusal {
  return { ok: false, rule, exit, sentence: sentence.replace(/["\\]/g, "'"), ...(commands?.length ? { commands } : {}) };
}

/** Is a command one of the interactive sign-ins — never the AI's to run, whatever the policy says? */
function isSignIn(command: string): boolean {
  const bare = command.trim().replace(/\s+/g, ' ');
  return SIGN_IN_SHAPES.some((shape) => bare === shape || bare.startsWith(`${shape} `));
}

/**
 * The words a refusal shows of a command: short, one line, and redacted — a
 * refusal is journalled, logged and printed, so it is a sink like any other
 * (the door screens a guide's lines first; this holds even where it did not).
 */
function shown(command: string): string {
  const one = redactSecrets(command.replace(/\s+/g, ' ').trim());
  return one.length > 120 ? `${one.slice(0, 117)}…` : one;
}

/**
 * Hold one declared item to the rules. A refusal names its rule, its exit and
 * what to do instead; a pass carries the reason and proof type the item is
 * recorded with — declared, or inferred and marked so.
 */
export function guardStep(input: GuardInput, ctx: { stage: GuardStage; judge?: CommandJudge | null }): GuardVerdict {
  const kind = humanStepKindOf(input.kind) ?? 'decision';

  // G6 — at the door a secret-shaped value is refused before anything is read;
  // at ingest the ledger's redaction floor has already taken it.
  if (ctx.stage === 'door') {
    const fields: [string, string | undefined][] = [
      ['--title', input.title], ['--proof-words', input.proofWords], ['--tried', input.tried],
      ['--open-command', input.openCommand], ['--why', input.why],
    ];
    for (const [flag, value] of fields) {
      if (value && looksLikeSecret(value)) {
        return refuse('G6', 2, `${flag} carries a secret-shaped value — the person types a secret where the step opens, never into a declaration. Nothing was written.`);
      }
    }
  }

  // G1 — a reason, legal for the kind; none named is the kind's default.
  const named = String(input.why ?? '').trim().toLowerCase();
  let why: WhyPerson;
  let whySource: GuardPass['whySource'];
  if (named) {
    if (!(WHY_PERSON as readonly string[]).includes(named)) {
      return refuse('G1', 2, `unknown --why ${named} (want one of: ${WHY_PERSON.join(' ')})`);
    }
    if (!reasonAllowed(kind, named)) {
      return refuse('G1', 2, `a ${kind} step is not asked for because of ${named} — its reasons are: ${allowedOf(kind)}`);
    }
    why = named as WhyPerson;
    whySource = 'declared';
  } else {
    why = defaultReason(kind);
    whySource = 'inferred';
  }

  // G2 — a proof, unless the answer is the result; attest only by name.
  const typeNamed = String(input.proofType ?? '').trim().toLowerCase();
  let proofType: ProofType;
  let proofTypeSource: GuardPass['proofTypeSource'];
  const hasRef = Boolean(input.proof?.trim());
  const hasWords = Boolean(input.proofWords?.trim());
  if (typeNamed) {
    if (!(PROOF_TYPES as readonly string[]).includes(typeNamed)) {
      return refuse('G2', 2, `unknown --proof-type ${typeNamed} (want one of: ${PROOF_TYPES.join(' ')})`);
    }
    proofType = typeNamed as ProofType;
    proofTypeSource = 'declared';
    if (proofType === 'probe' && !hasRef) return refuse('G2', 2, '--proof-type probe needs --proof <ref>: the console reads a ref to prove it');
    if (proofType === 'judgement' && !hasWords && !hasRef) {
      return refuse('G2', 2, '--proof-type judgement needs --proof-words: what a checker reads the evidence against');
    }
    if (proofType === 'grant' && kind !== 'permission') {
      return refuse('G2', 2, `--proof-type grant belongs to a permission item, not ${kind}: a grant or a denial ends only that`);
    }
  } else {
    const inferred = inferProofType({ kind, proof: input.proof, proofWords: input.proofWords });
    if (inferred) proofType = inferred;
    else if (ctx.stage === 'door') {
      return refuse('G2', 2, `a ${kind} step needs a proof: --proof <ref> the console can read, or --proof-words saying what proves it — `
        + `or --proof-type attest to take the person's word, by name (${KIND_META[kind].proof})`);
    } else proofType = 'attest';
    proofTypeSource = 'inferred';
  }
  if (!(PROOF_TYPES_SELF as readonly string[]).includes(proofType) && !hasRef && !hasWords) {
    return refuse('G2', 2, `a ${proofType} proof needs a ref or words to read`);
  }

  const pass: GuardPass = { ok: true, why, whySource, proofType, proofTypeSource };
  if (whySource !== 'declared' || !(G4_REASONS as readonly string[]).includes(why)) return pass;

  // G4 — the AI could do it itself.
  const tried = Boolean(input.tried?.trim());
  if (why === 'reach') {
    if (tried) return pass;
    return refuse('G4', GUARD_REFUSAL_EXIT,
      'try it, then say what happened: a reach reason says the AI cannot reach the system, so run what you can first and declare '
      + 'again with --tried saying what you ran and how it failed.');
  }
  const commands = [...guideCommands(input.guide ?? null), ...(input.openCommand?.trim() ? [input.openCommand.trim()] : [])];
  if (!commands.length || !ctx.judge) return pass;
  const verdicts = commands.map((command) => ({
    command,
    ...(isSignIn(command) ? { verdict: 'person' as const, rule: null } : ctx.judge!(command)),
  }));
  const stopped = verdicts.find((v) => v.verdict === 'deny' || v.verdict === 'ask' || v.verdict === 'hold');
  if (stopped) {
    const wall: Wall = stopped.verdict === 'deny' ? 'deny' : 'ask';
    return {
      ...pass,
      ...(tried ? { overruled: true as const } : {}),
      reshape: {
        kind: 'permission', why: 'permission', wall, command: shown(stopped.command),
        ...(stopped.rule ? { rule: stopped.rule } : {}),
      },
    };
  }
  if (verdicts.every((v) => v.verdict === 'allow')) {
    if (tried) return { ...pass, overruled: true };
    const named = commands.map((c) => `\`${shown(c)}\``).join(', ');
    return refuse('G4', GUARD_REFUSAL_EXIT,
      `the AI can do this itself: this run's own policy allows every command the guide asks for (${named}) — run them, then carry on. `
      + 'If one fails, declare again with --tried saying what you ran and how it failed.',
      commands.map(shown));
  }
  return pass;
}

/**
 * G5 (control-tower phase 135): a `blocked --needs permission` declaration —
 * or anything else that would raise a `permission` item for a lane — must cite
 * a wall this console recorded for THAT lane. The cited wall comes back to be
 * raised; with none, the declaration is refused: nothing refused this — run it.
 * A lane the console recorded nothing for, because it does not drive it (an
 * interactive session), is not this rule's: its caller says so with `walls:
 * null`, and the declaration is explained instead (`wallTurnInput`).
 */
export function guardWall(
  declared: { rule?: string | null; command?: string | null },
  walls: readonly RecordedWall[] | null | undefined,
): { ok: true; wall: RecordedWall } | GuardRefusal {
  const wall = citedWall(walls ?? [], declared);
  if (wall) return { ok: true, wall };
  return refuse('G5', GUARD_REFUSAL_EXIT, G5_SENTENCE, declared.command ? [shown(declared.command)] : undefined);
}

/** The reasons a kind allows, for a refusal's words. */
function allowedOf(kind: string): string {
  const ok = WHY_PERSON.filter((word) => reasonAllowed(kind, word));
  return ok.join(' ');
}

/** The journal fields of a refusal — its rule and exit, the commands; never a value from the declaration. */
export function refusalFields(refusal: GuardRefusal): Record<string, unknown> {
  return {
    rule: refusal.rule, exit: refusal.exit, sentence: redactSecrets(refusal.sentence),
    ...(refusal.commands ? { commands: refusal.commands.map((command) => redactSecrets(command)) } : {}),
  };
}
