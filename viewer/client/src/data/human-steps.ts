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

import type {
  HumanStepsList,
  StepAnswerBody,
  StepEvidenceInput,
  StepGrantBody,
  StepOpenBody,
  StepVerbAnswer,
} from '@shared/wire/turn.js';
import { post, q, request } from './http';

export type {
  HumanStepMoveView,
  HumanStepRecord,
  HumanStepsList,
  PermissionRecord,
  ReminderQuiet,
  StepAnswerRecord,
  StepEvidenceInput,
  StepEvidenceRecord,
  StepResume,
  StepTerminalTicket,
  StepVerbAnswer,
  StepVerdictRecord,
} from '@shared/wire/turn.js';

const at = (id: string, verb: string) => `/api/human-steps/${q(id)}/${verb}`;

/** The human-step fetchers — merged into `api` by `./index`. */
export const humanStepsApi = {
  /** `open` — only the steps still waiting on a person. */
  humanSteps: (open?: boolean) => request<HumanStepsList>('/api/human-steps' + (open ? '?open=1' : '')),
  /** *Open* and *Open again* — `here` answers the link for this browser; `host` opens it on the machine. */
  humanStepOpen: (id: string, body: StepOpenBody = {}) => post<StepVerbAnswer>(at(id, 'open'), body),
  /** *I've done this — check*: run the proof now. Never a secret — the server refuses a body that carries one. */
  humanStepCheck: (id: string, note?: string) => post<StepVerbAnswer>(at(id, 'check'), note ? { note } : {}),
  humanStepSnooze: (id: string, minutes?: number) =>
    post<StepVerbAnswer>(at(id, 'snooze'), minutes ? { minutes } : {}),
  /** *I can't do this* — through Your turn's fenced verb (EI-7), which settles a ledger item as its step's own `cannot`. */
  humanStepCannot: (id: string, reason: string) =>
    post<StepVerbAnswer>(`/api/turn/${q(id)}/cannot`, { reason }),
  /** Answer a decision — one of its options, a note, or both (control-tower phase 133). */
  humanStepAnswer: (id: string, body: StepAnswerBody) => post<StepVerbAnswer>(at(id, 'answer'), body),
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
  /**
   * *Undo* on an item being checked (turn-by-turn phase 5) — the check taken
   * back while it runs: the item is To do (or Redo) again, and a verdict that
   * lands later is dropped by its attempt. 409 when it is not being checked.
   */
  humanStepUndo: (id: string) => post<StepVerbAnswer>(at(id, 'undo'), {}),
  /**
   * *Withdraw* (quiet-console phase 8) — the owner takes an open item off Your
   * turn: the console's own `dismiss`, pressed by a person through the owner
   * door (`decline` authority). Not a refusal — *Not doing this* is that, with
   * a reason the session reads — but an item that should never have stood.
   */
  humanStepWithdraw: (id: string, note?: string) =>
    post<StepVerbAnswer>(at(id, 'dismiss'), note ? { note } : {}),
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
   * the revokes are `data/permissions.ts`'s.
   */
  humanStepGrant: (id: string, body: StepGrantBody) => post<StepVerbAnswer>(at(id, 'grant'), body),
};
