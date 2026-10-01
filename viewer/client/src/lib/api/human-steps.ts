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
};

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
  check?: { landed: boolean; read: string; ref?: string };
  resumed?: { launched: boolean; why?: string };
  snoozed?: { until: string };
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
  /** *I did it — check*: run the proof now. A `secret-entry` form sends its secret here, once. */
  humanStepCheck: (id: string, secret?: string) =>
    post<StepVerbAnswer>(at(id, 'check'), secret === undefined ? {} : { secret }),
  humanStepSnooze: (id: string, minutes?: number) =>
    post<StepVerbAnswer>(at(id, 'snooze'), minutes ? { minutes } : {}),
  humanStepCannot: (id: string, reason: string) => post<StepVerbAnswer>(at(id, 'cannot'), { reason }),
  humanStepDismiss: (id: string, note?: string) =>
    post<StepVerbAnswer>(at(id, 'dismiss'), note ? { note } : {}),
  /** *Make it a person's turn* — a silent lane's suspected step, converted on a person's word. */
  humanStepConvert: (slug: string, phase: number) =>
    post<StepVerbAnswer>('/api/human-steps/suspected', { slug, phase }),
};
