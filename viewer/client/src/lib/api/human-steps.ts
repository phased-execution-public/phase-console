/**
 * A person's turn — the human-step verbs and the ledger's read (control-tower
 * phases 43 and 42).
 *
 * The server owns the step: `server/human-steps.ts` folds the ledger,
 * `service-recovery.ts` answers each verb, and every word here is already
 * redacted there. This file is the typed door to `GET /api/human-steps` and
 * `POST /api/human-steps/:id/<verb>` — one fetcher per verb, the body each
 * route reads, and the shape each answers. The words a card draws (a kind's
 * icon and label) are `shared/human-step-model.js` `KIND_META`'s, never these.
 */

import type { Guide } from '@shared/guide-grammar.js';
import type {
  GRANT_SCOPES,
  ProofType,
  RISK_TIERS,
  RULE_FAMILIES,
  VERDICT_BY,
  VERDICTS,
  WALLS,
  WhyPerson,
} from '@shared/turn-model.js';
import type {
  HumanStepBirth,
  HumanStepKind,
  HumanStepMove,
  HumanStepState,
  HumanStepWhere,
} from '@shared/human-step-model.js';
import { post, q, request } from './client';

/** One move a step made after its declaration — an open, a check and what it read, a reminder. */
export type HumanStepMoveView = {
  state: HumanStepState;
  verb: HumanStepMove;
  at: string;
  by?: string;
  /** Words about the move — what a check read, why a person could not. Never a value. */
  note?: string;
  /** Where an open happened: this browser, the machine, or the embedded terminal. */
  where?: 'here' | 'host' | 'terminal';
  pushed?: boolean;
  snoozeUntil?: string;
};

/** One step as `GET /api/human-steps` answers it (`StepView`): the folded step, its window and its moves. */
export type HumanStepRecord = {
  id: string;
  kind: HumanStepKind;
  title: string;
  where: HumanStepWhere;
  birth: HumanStepBirth;
  slug: string;
  phase: number;
  runId?: string;
  sessionId?: string;
  openUrl?: string;
  openCommand?: string;
  /** The ref that proves it — a `cmd:` or `gh:` watch — when the step names one. */
  proof?: string;
  lines?: string[];
  /** A `device-code` step's code — the one code a step shows on purpose. */
  code?: string;
  credential?: string;
  autoOpen?: 'host';
  until?: string;
  /** The watch ref an `upcoming` step waits on before it is due (control-tower phase 121). */
  dueWhen?: string;
  /** When that ref landed and the step became due — its window starts here, not at the birth. */
  dueAt?: string;
  state: HumanStepState;
  declaredAt: string;
  /** When it reached the state it is in. */
  at: string;
  /** How often a person opened it — *Open again* included. */
  opened: number;
  pushed?: boolean;
  stored?: 'keychain' | 'file';
  note?: string;
  notifiedAt?: string;
  reminders?: number;
  remindedAt?: string;
  openedAt?: string;
  checks?: number;
  checkedAt?: string;
  /** What the proof read at the last check, in its own words. */
  read?: string;
  snoozeUntil?: string;
  actedAt?: string;
  provenBy?: string;
  /** When the window closes — seven days when the step named none. */
  windowEnd?: string;
  nextReminderAt?: string | null;
  moves?: HumanStepMoveView[];
  /* ---- Your turn (control-tower phase 130) — the record's v2 fields, always on a v2 line ---- */
  /** Why only a person fits it — declared by the raiser, or the kind's default (`inferred`). */
  why?: WhyPerson;
  whySource?: 'declared' | 'inferred';
  /** The full guide, as the one grammar parsed it. */
  guide?: Guide;
  /** How many minutes it takes the person. */
  effortMin?: number;
  /** The phases it unblocks. */
  unblocks?: { slug: string; phase: number }[];
  /** How it is proven, and the proof in words a person can read. */
  proofType?: ProofType;
  proofWords?: string;
  /** Every session this one item unblocks (G7). */
  waiters?: { slug: string; phase: number; runId?: string; sessionId?: string }[];
  /** What raised it. */
  source?: { kind: string; ref?: string };
  /** What the session tried before asking (G4's `--tried`), and whether that overruled the guard. */
  tried?: string;
  overruled?: true;
  /* ---- the owner's moves (control-tower phase 133) ---- */
  /** A decision's options, one recommended, and whether the person may decline it. */
  options?: { id: string; label: string; consequence?: string; recommended?: true }[];
  allowDecline?: boolean;
  /** The `## Decisions` key the decision answers — its answer goes to the plan's table first. */
  decisionKey?: string;
  answer?: StepAnswerRecord;
  question?: { at: string; text: string; by?: string; door?: string }[];
  evidence?: StepEvidenceRecord[];
  /** `secret-entry`: where the value goes, in words — the console never takes it. */
  secretWhere?: string;
  /** The check (phase 134): how many checks it had, the last verdict, every verdict, and the escalation. */
  attempts?: number;
  verdict?: StepVerdictRecord;
  verdicts?: StepVerdictRecord[];
  escalatedAt?: string;
  /** A permission item's record (phase 135): what stopped the AI, why it was needed, its risk, what Grant does today. */
  permission?: PermissionRecord;
};

/**
 * A permission item's record (control-tower phase 135, #212) — the server's
 * `PermissionDetail` (`server/permissions/walls.ts`): the wall, the tool, the
 * rule, the command, why the phase needed it, the risk tier, the scopes a
 * grant may be offered at (none for `never`, with why and the manual path) and
 * what Grant does until phase 149 — the broker's Allow or the widen's strike.
 */
type Wall = (typeof WALLS)[number];
type RuleFamily = (typeof RULE_FAMILIES)[number];
type RiskTier = (typeof RISK_TIERS)[number];
type GrantScope = (typeof GRANT_SCOPES)[number];

export type PermissionRecord = {
  wall: Wall;
  tool?: string;
  rule?: string;
  command?: string;
  need?: string;
  family?: RuleFamily;
  risk?: RiskTier;
  scopes?: GrantScope[];
  never?: { why: string; manual: string };
  grant?:
    | { effect: 'broker' | 'strike'; approvalId: string; label: string }
    | { effect: 'capability'; label: string };
  ownRule?: string;
  source?: 'hook' | 'cli' | 'landing' | 'preflight' | 'broker';
  at?: string;
};

/** One verdict (phase 134): passed, rejected with what to redo, or needs-info — and who wrote it. */
export type StepVerdictRecord = {
  state: (typeof VERDICTS)[number];
  note: string;
  redo: string[];
  read: string[];
  at: string;
  by: (typeof VERDICT_BY)[number];
  attempt: number;
  unverified?: true;
};

/** A decision's answer: the option chosen (id and label), the note, and the door it came through. */
export type StepAnswerRecord = {
  option?: string;
  label?: string;
  note?: string;
  at: string;
  by?: string;
  door?: string;
};

/** One piece of evidence, as the ledger keeps it — by content hash; the bytes stay on the machine. */
export type StepEvidenceRecord = {
  attempt: number;
  kind: 'note' | 'image' | 'file';
  ref: string;
  bytes: number;
  mime: string;
  name?: string;
  at: string;
  by?: string;
};

/** What a person attaches: a note's text, or a file or an image as base64. */
export type StepEvidenceInput =
  | { kind: 'note'; text: string; name?: string }
  | { kind: 'image'; data: string; mime: string; name?: string }
  | { kind: 'file'; data?: string; text?: string; name?: string };

/** One waiter an answer or a decline resumed — or why it could not. */
export type StepResume = { slug: string; phase: number; launched: boolean; why?: string };

/** The reminder clock's words, as the list answers them. */
export type ReminderQuiet = { start: string; end: string };

export type HumanStepsList = {
  steps: HumanStepRecord[];
  reminders: { series: number[]; quiet: ReminderQuiet | null };
  /** What this console can do on the machine: open a link there, run a command, resume a session. */
  can: { openHost: boolean; terminal: boolean; resume: boolean };
};

/** A terminal the console minted for a step's command — the sessions pane's lazy door opens it. */
export type StepTerminalTicket = { sessionId: string; token: string; expiresAt: number };

/** What a verb answers: the step as it now reads, and the verb's own fact. */
export type StepVerbAnswer = {
  ok: true;
  step?: HumanStepRecord;
  /** *Open on the machine* first answers the full URL; the second press sends it back as `confirm`. */
  confirm?: { url: string; where: 'host' };
  opened?: {
    n: number;
    where: 'here' | 'host' | 'terminal';
    what: 'url' | 'command';
    url?: string;
    command?: string;
    terminal?: StepTerminalTicket;
    /** Why the embedded terminal did not open — the command then runs in a terminal of the person's own. */
    why?: string;
  };
  /** A check's answer — since phase 134 its verdict's state too, or `checking` while the checker reads. */
  check?: {
    landed?: boolean;
    read?: string;
    ref?: string;
    state?: string;
    by?: string;
    attempt?: number;
    why?: string;
  };
  verdict?: StepVerdictRecord;
  escalated?: true;
  rewrite?: { at: string };
  resumed?: { launched: boolean; why?: string };
  snoozed?: { until: string };
  /** `answer` / `decline` (phase 133): what was recorded, and the ONE resume each waiter got. */
  answered?: StepAnswerRecord;
  declined?: { reason: string; at: string };
  resumes?: StepResume[];
  decision?: { key: string; written: true };
  asked?: { at: string; text: string };
  attached?: { ref: string; kind: StepEvidenceRecord['kind']; bytes: number; attempt: number };
  /** *Make it a person's turn* pressed a second time: the step the first press made. */
  already?: true;
};

const at = (id: string, verb: string) => `/api/human-steps/${q(id)}/${verb}`;

/** The human-step fetchers — merged into `api` by `./index`. */
export const humanStepsApi = {
  /** `open` — only the steps still waiting on a person. */
  humanSteps: (open?: boolean) => request<HumanStepsList>('/api/human-steps' + (open ? '?open=1' : '')),
  /** *Open* and *Open again* — `here` answers the link for this browser; `host` opens it on the machine. */
  humanStepOpen: (
    id: string,
    body: { where?: 'here' | 'host'; what?: 'url' | 'command'; confirm?: string } = {},
  ) => post<StepVerbAnswer>(at(id, 'open'), body),
  /** *I've done this — check*: run the proof now. Never a secret — the server refuses a body that carries one. */
  humanStepCheck: (id: string, note?: string) => post<StepVerbAnswer>(at(id, 'check'), note ? { note } : {}),
  humanStepSnooze: (id: string, minutes?: number) =>
    post<StepVerbAnswer>(at(id, 'snooze'), minutes ? { minutes } : {}),
  humanStepCannot: (id: string, reason: string) => post<StepVerbAnswer>(at(id, 'cannot'), { reason }),
  /** Answer a decision — one of its options, a note, or both (control-tower phase 133). */
  humanStepAnswer: (id: string, body: { option?: string; note?: string }) =>
    post<StepVerbAnswer>(at(id, 'answer'), body),
  /** *Not doing this* — with a reason, on an item that allows it. */
  humanStepDecline: (id: string, reason: string) => post<StepVerbAnswer>(at(id, 'decline'), { reason }),
  /** *Ask about this* — recorded, and handed to the raising session with its next resume. */
  humanStepAsk: (id: string, text: string) => post<StepVerbAnswer>(at(id, 'ask'), { text }),
  /** Attach evidence — a note, an image or a file; bounded and screened by the server. */
  humanStepAttach: (id: string, evidence: StepEvidenceInput) =>
    post<StepVerbAnswer>(at(id, 'evidence'), evidence),
  /**
   * *Accept anyway* (control-tower phase 134) — the owner's verdict, the ONE route
   * that writes one: passed, recorded as the owner's and unverified; every waiter
   * is resumed as on a pass.
   */
  humanStepOverride: (id: string, note?: string) =>
    post<StepVerbAnswer>(at(id, 'override'), note ? { note } : {}),
  /** *Rewrite the guide* — the escalation's way out: the item is withdrawn and its raiser asked for a new version. */
  humanStepRewrite: (id: string, note?: string) =>
    post<StepVerbAnswer>(at(id, 'rewrite'), note ? { note } : {}),
  /** *Make it a person's turn* — a silent lane's suspected step, converted on a person's word. */
  humanStepConvert: (slug: string, phase: number) =>
    post<StepVerbAnswer>('/api/human-steps/suspected', { slug, phase }),
  /**
   * *Deny* on a permission item (control-tower phase 135) — the waiting session is
   * told "denied — do not retry; find another way inside the plan or say what
   * remains". The reason is optional.
   */
  humanStepDeny: (id: string, reason?: string) =>
    post<StepVerbAnswer>(at(id, 'deny'), reason ? { reason } : {}),
  /**
   * *I'll do it myself* on a permission item (control-tower phase 135) — it becomes
   * your own act, its guide the command; its *I've done this* resumes the session.
   */
  humanStepTakeOver: (id: string) => post<StepVerbAnswer>(at(id, 'convert'), {}),
  /**
   * *Grant* on a permission item (control-tower phase 149) — one press at a
   * scope the item offers; a high one carries the rule typed back. The row and
   * the revokes are `lib/api/permissions.ts`'s.
   */
  humanStepGrant: (id: string, body: { scope: string; rule?: string; reason?: string }) =>
    post<StepVerbAnswer>(at(id, 'grant'), body),
};
