/**
 * What stopped the session, and when it is worth trying again.
 *
 * An unattended run fails for a dozen different reasons and they want opposite
 * responses. Sleeping through an Opus-only limit wastes hours when switching
 * model would have carried on; retrying an expired login hammers a wall
 * forever. So every stop is classified into one disposition, and the runner
 * only ever acts on the disposition.
 *
 * The division of labour matters: Claude Code already retries 429/529,
 * timeouts and dropped connections with exponential backoff, and
 * `CLAUDE_CODE_RETRY_WATCHDOG=1` — documented for exactly this case,
 * "CI/unattended sessions" — makes it retry 429/529 indefinitely. We set that
 * on the child and do NOT reimplement backoff here. What reaches this module is
 * what the CLI gave up on, plus the things it cannot decide: whether to wait
 * out a plan limit, drop to a cheaper model, resume with a bigger budget, or
 * stop and fetch a human.
 */

import type { EndedBy } from '../../shared/run-lifecycle.js';
import type { CredentialClass, CredentialEvidenceSource } from '../../shared/ops-vocab.js';
import { MODELS_ENV_FALLBACK, modelFamily } from './models.ts';
import { envCarrier } from '../trace.ts';

export type Disposition =
  /** Transient; try the same phase again shortly. */
  | { kind: 'retry'; afterMs: number; reason: string }
  /** A plan window is exhausted. Sleep until it reopens, then retry. */
  | { kind: 'wait-until'; at: Date; reason: string }
  /**
   * Only this model is exhausted or at capacity — the run continues on
   * another. A QUOTA hit also names its window (`bucket`, in the registry's
   * key vocabulary, e.g. `seven_day_opus`) and the reset time when one parsed,
   * so the wall can be filed against the account; a capacity blip (529) names
   * neither — there is nothing to remember.
   */
  | { kind: 'switch-model'; reason: string; bucket?: string; at?: Date }
  /** The work is unfinished but intact: resume that session with a bigger cap. */
  | { kind: 'resume'; raise: 'budget' | 'turns'; reason: string }
  /**
   * Nothing automatic will fix this. Park, notify, wait for a person.
   *
   * `cause: 'usage-window'` marks the one park that IS fixable without a
   * person — a reset too far away to sleep on — so a runner holding another
   * account can act on the discriminant instead of string-matching the
   * reason. `at` rides along as the reset time it named.
   */
  | {
    kind: 'needs-human'; reason: string;
    /**
     * `usage-window`: a reset too far away to sleep on — the one park that IS
     * fixable without a person, so a runner holding another account can act on
     * the discriminant instead of string-matching the reason.
     */
    cause?: 'usage-window';
    at?: Date;
  }
  /**
   * The API refused the run's OWN credential: an organisation policy, an
   * expired or signed-out login, a billing hold, a certificate it would not
   * accept. Its own kind since zero-touch-console phase 9 (RCV-1, SES-2): it
   * used to ride `needs-human` as `cause: 'credential'`, and `needs-human` is
   * a PHASE-level halt — so one blocked credential settled the phase and the
   * loop boarded the next, ten times in 157 s. The runner retires the
   * account's organisation (`leaveAccount`) and halts the RUN on it; `class`
   * is the owner's word (`shared/ops-vocab.js` `CREDENTIAL_CLASSES`).
   */
  | { kind: 'credential-refused'; reason: string; class: CredentialClass; evidence?: CredentialEvidence }
  /**
   * This machine could not reach the API at all. Nobody's fault — not the
   * credential's, not the phase's, not the plan's — so the runner backs off
   * and tries again, charging nothing: no attempt, no failure streak, no
   * ladder rung.
   *
   * `class` is present only when the stop was certificate-SHAPED. A home
   * connection dropping out, a captive portal, a DNS hijack to a splash page
   * and a router intercepting its own reconnect all answer TLS, so the first
   * sighting of one is an outage, not a verdict about the credential. The
   * class travels so the corroboration ledger can count it: three such stops
   * from two sessions over ten minutes with no success between is a standing
   * interception, and only then does one credential cool.
   */
  | { kind: 'connectivity'; reason: string; class?: CredentialClass }
  /** The phase itself failed. Runner decides retry-vs-halt by its own counters. */
  | { kind: 'phase-failed'; reason: string }
  /** Finished normally. */
  | { kind: 'ok' };

/** One tool call the CLI's permission system denied, from `result.permission_denials`. */
export type PermissionDenial = { tool: string; toolUseId?: string; target?: string };

export type StopSignal = {
  /** `subtype` from the result message, when one arrived. */
  subtype?: string;
  /** Process exit code. */
  code?: number | null;
  /** `stop_reason` from the final assistant turn. */
  stopReason?: string | null;
  /** Combined result text / stderr — where the limit messages actually appear. */
  text?: string;
  /** Error categories seen on `system/api_retry` events during the run. */
  retryCategories?: string[];
  /** The model the run used, so a switch can be proposed sensibly. */
  model?: string;
  /**
   * The result message's own error bit. It disqualifies `success` before any
   * text is read (SES-5): a TLS-interception error the patterns below do not
   * know was twice recorded as a completed phase.
   */
  isError?: boolean;
  /** The result's `permission_denials` — the CLI's authoritative record of what it refused. */
  permissionDenials?: PermissionDenial[];
  /** Who ended the session. Anything but `exit` means the console did, before the turn was done. */
  endedBy?: EndedBy;
  /** The ender's own words — the spawn watchdogs' diagnosis. */
  endedReason?: string;
  /** The result's `terminal_reason`: `completed`, `aborted_tools`, `max_turns`, `tool_deferred`… */
  terminalReason?: string;
  /** Background tasks the CLI started and never reported finished. */
  backgroundTasks?: { id: string; description: string; taskType?: string }[];
  /**
   * Turns the session booked, and dollars it spent — the CLI's own ledger,
   * carried in so the classifier can tell a session that DID something from
   * one that did nothing. A phase that ran for six turns and $4 is reporting
   * on work; a one-turn, zero-dollar `success` is the expired-login shape.
   */
  turns?: number;
  costUsd?: number;
  /**
   * What the CLI's API-ERROR channels said on this stop, and nothing else
   * (control-tower phase 54, #57): the words of every assistant message the
   * CLI flagged as an API error (`error` / `is_api_error_message`), the
   * result's own `errors`, and stderr. The billing, auth and org-policy
   * patterns read THIS — never `text`, which also carries the session's own
   * prose. A phase building a purchase flow quotes its fixtures; that is not
   * the API refusing the credential.
   */
  apiText?: string;
  /**
   * The `error` kind of every assistant message the CLI flagged as an API
   * error (`SDKAssistantMessageError`: `billing_error`, `authentication_failed`…)
   * — data the API returned, the same standing as an `api_retry` category.
   */
  apiErrors?: string[];
};

/**
 * What a credential verdict stood on (#57): a kind the API RETURNED as data
 * (`api`), or a sentence matched on one of the CLI's API-error channels
 * (`text`), with what matched. It travels to the retirement, the halt and the
 * account view, so a person can see why a credential was retired — and that a
 * later probe contradicts it.
 */
export type CredentialEvidence = { source: CredentialEvidenceSource; matched: string };

/**
 * A retirement's evidence as the breaker keeps it: what the verdict stood on,
 * and whose stop it was — the session, the phase, the plan and the run.
 */
export type RetirementEvidence = CredentialEvidence & { session?: string; phase?: number; slug?: string; runId?: string };

/** The longest `matched` a verdict carries — the line, never a log. */
export const EVIDENCE_MATCH_MAX = 200;

/**
 * Turns that count as a session having worked. Two, not one: the CLI books a
 * refused session's single turn, so one turn is exactly what "it never
 * started" looks like.
 */
export const WORKED_TURNS = 2;

/**
 * The CLI's `system/api_retry` `error` values — the closed set the docs give
 * (chapter 09 row 31, CLI 2.1.270). The category is this field and nothing
 * else; `error_category` is a different message's (`tool_progress
 * .subagent_retry`), over a narrower set.
 */
export const API_RETRY_ERRORS = Object.freeze([
  'authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'billing_error',
  'rate_limit', 'overloaded', 'invalid_request', 'model_not_found', 'server_error',
  'max_output_tokens', 'cloud_credential_error', 'unknown',
] as const);

/** Past this, sitting and waiting is worse than telling someone. */
export const MAX_AUTO_WAIT_MS = 12 * 60 * 60 * 1000;

/**
 * The LATEST a lane waits out an outage, by how many it has already met on
 * this phase: a minute, two, five, ten, then a quarter of an hour for as long
 * as it lasts.
 *
 * Since control-tower phase 80 (#108) this is the backstop, not the wait. The
 * lane waits on the connectivity probe (`connectivity-probe.ts`, a look every
 * `CONNECTIVITY_PROBE_MS`) and boards again at the first look that finds the
 * API answering; measured before that, a lane whose API came back one minute
 * into a fifteen-minute step waited out the other fourteen. The series stays
 * as the ceiling because the probe is the console's own `fetch` and the
 * session is the CLI — a machine where only one of them can reach the API (a
 * proxy the CLI honours and Node does not) must never wait longer than it
 * did before the probe existed.
 *
 * The TOTAL is bounded by `MAX_AUTO_WAIT_MS`, charged at this series — past
 * twelve hours of no network this stops being weather and becomes something a
 * person has to look at.
 */
export const CONNECTIVITY_BACKOFF_MS = Object.freeze([60_000, 120_000, 300_000, 600_000, 900_000]);

/** The wait after `seen` outages on this phase; the last step repeats. */
export function connectivityBackoffMs(seen: number): number {
  const index = Math.min(Math.max(seen, 0), CONNECTIVITY_BACKOFF_MS.length - 1);
  return CONNECTIVITY_BACKOFF_MS[index];
}

/**
 * Is this text the CLI saying it could not reach the API — the sentence the
 * `connectivity` disposition is read from? The one predicate a record uses to
 * decide that a session's result is the network's words rather than its own
 * (control-tower phase 80, #108; `session-record.ts` `lastWords`).
 */
export function isTransportFailure(text: string | undefined | null): boolean {
  return Boolean(text) && RE.connectivity.test(text!);
}

/**
 * Did the API RETURN a credential verdict, as data, on this stop? The
 * difference between a category the CLI reported and a sentence a session
 * happened to print — and the only thing that may reach an organisation's row.
 */
export function structuredRefusal(signal: StopSignal): boolean {
  return structuredVerdict(apiKinds(signal)) !== null;
}

/** Every credential kind the API returned as data: the retry stream's categories, then the API-error messages' kinds. */
function apiKinds(signal: StopSignal): string[] {
  return [...(signal.retryCategories ?? []), ...(signal.apiErrors ?? [])];
}

/** The credential verdict a set of API kinds amounts to, strongest first — or null when none is one. */
function structuredVerdict(kinds: string[]): { reason: string; class: CredentialClass; kind: string } | null {
  if (kinds.includes('oauth_org_not_allowed')) {
    return { reason: 'organization policy blocks this credential', class: 'org-policy', kind: 'oauth_org_not_allowed' };
  }
  if (kinds.includes('authentication_failed')) return { reason: AUTH_REFUSED, class: 'auth', kind: 'authentication_failed' };
  const billing = kinds.find((kind) => kind === 'billing_error' || kind === 'account_on_hold');
  return billing ? { reason: 'billing or credit balance needs attention', class: 'billing', kind: billing } : null;
}

/**
 * Did this session spend NOTHING — fewer turns than a session that worked, and
 * no dollar figure? Then no model output exists, and its result text can only
 * be the CLI's own words: the expired-login shape, one turn and $0, whose one
 * sentence IS the API's answer.
 */
export function spentNothing(signal: StopSignal): boolean {
  return (signal.turns ?? 0) < WORKED_TURNS && !((signal.costUsd ?? 0) > 0);
}

/**
 * The only text the billing, auth and org-policy patterns may read (#57): the
 * CLI's API-error channels — and, for a session that spent nothing, its result
 * text too, since nothing but the CLI can have written it. A session that did
 * work wrote prose, and prose in a codebase that bills or authenticates
 * legitimately names every one of those product words.
 */
export function credentialChannel(signal: StopSignal): string {
  const api = signal.apiText ?? '';
  return spentNothing(signal) ? [api, signal.text ?? ''].filter(Boolean).join('\n') : api;
}

/** The line a pattern matched on, bounded — what a person reads as the evidence. */
function matchedLine(re: RegExp, text: string): string | null {
  const hit = re.exec(text);
  if (!hit) return null;
  const start = text.lastIndexOf('\n', hit.index) + 1;
  const end = text.indexOf('\n', hit.index + hit[0].length);
  return text.slice(start, end === -1 ? undefined : end).trim().slice(0, EVIDENCE_MATCH_MAX);
}
/** Never come back the instant a window opens — clocks disagree. */
export const RESET_MARGIN_MS = 90_000;

/* ------------------------------------------------------------------ *
 * Reset-time parsing
 * ------------------------------------------------------------------ */

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Pull the reset moment out of a usage-limit message. Claude Code has emitted
 * several shapes over time and an unattended runner meets all of them:
 *
 *   You've hit your session limit · resets 3:45pm
 *   You've hit your weekly limit · resets Mon 12:00am
 *   Claude usage limit reached. Your limit will reset at 3pm (America/Santiago)
 *   Claude AI usage limit reached|1749924000
 *
 * Returns null when nothing parses — the caller then falls back to a
 * conservative fixed wait rather than guessing a time.
 */
export function parseResetTime(text: string, now = new Date()): Date | null {
  if (!text) return null;

  // Epoch form first: unambiguous, no timezone reasoning needed.
  const epoch = /usage limit reached\s*\|\s*(\d{9,13})/i.exec(text);
  if (epoch) {
    const n = Number(epoch[1]);
    const ms = n > 1e11 ? n : n * 1000;
    const at = new Date(ms);
    if (!Number.isNaN(at.getTime())) return at;
  }

  // "… (America/Santiago)" — an explicit zone, so resolve the clock time there.
  const zoned = /reset at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([A-Za-z_]+\/[A-Za-z_+-]+)\)/i.exec(text);
  if (zoned) {
    const at = nextClockTime({
      hour: Number(zoned[1]),
      minute: Number(zoned[2] ?? 0),
      meridiem: zoned[3]?.toLowerCase() as 'am' | 'pm' | undefined,
      timeZone: zoned[4],
      now,
    });
    if (at) return at;
  }

  // "resets Mon 12:00am" — a weekday, so it may be days out (weekly window).
  const weekly = /resets?\s+(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (weekly) {
    const target = WEEKDAYS.indexOf(weekly[1].toLowerCase().slice(0, 3));
    const at = nextClockTime({
      hour: Number(weekly[2]),
      minute: Number(weekly[3] ?? 0),
      meridiem: weekly[4]?.toLowerCase() as 'am' | 'pm' | undefined,
      now,
    });
    if (at && target >= 0) {
      // Roll forward to that weekday.
      while (at.getDay() !== target) at.setDate(at.getDate() + 1);
      return at;
    }
    if (at) return at;
  }

  // "resets 3:45pm" / "reset at 3pm" — plain local clock time.
  const local = /(?:resets?|reset at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text);
  if (local) {
    return nextClockTime({
      hour: Number(local[1]),
      minute: Number(local[2] ?? 0),
      meridiem: local[3].toLowerCase() as 'am' | 'pm',
      now,
    });
  }

  return null;
}

/**
 * Which usage bucket a limit message is about, in the registry's own key
 * vocabulary: `seven_day_<model>` for a per-model wall (matching the usage
 * endpoint's bucket names, so a learned wall and a measured one file under the
 * same key), `five_hour` / `seven_day` for the shared windows. The epoch form
 * names no window at all and files as `five_hour` — the conservative reading,
 * and the one the runner has always taken.
 */
export function limitBucket(text: string): string {
  const model = /you'?ve hit your (opus|sonnet|haiku|fable)/i.exec(text);
  if (model) return `seven_day_${model[1].toLowerCase()}`;
  if (/weekly limit/i.test(text)) return 'seven_day';
  return 'five_hour';
}

/**
 * The next moment the clock reads this time — today if it is still ahead,
 * otherwise tomorrow. With a `timeZone`, the wall-clock time is interpreted
 * there and converted back, which is what makes a message like
 * "3pm (America/Santiago)" usable from a machine in another zone.
 */
function nextClockTime(opts: {
  hour: number; minute: number; meridiem?: 'am' | 'pm'; timeZone?: string; now: Date;
}): Date | null {
  let hour = opts.hour;
  if (opts.meridiem === 'pm' && hour < 12) hour += 12;
  if (opts.meridiem === 'am' && hour === 12) hour = 0;
  if (hour < 0 || hour > 23 || opts.minute < 0 || opts.minute > 59) return null;

  if (opts.timeZone) {
    // The day must come from the clock in THAT zone, not from UTC. Using the
    // UTC date lands on the wrong calendar day whenever the two disagree —
    // 11pm Los Angeles asked at 01:00 UTC used to resolve 24h late, which for a
    // runner means sleeping through a whole working day it could have used.
    const today = zoneParts(opts.now, opts.timeZone);
    if (!today) return null;
    let candidate = zonedInstant(today.year, today.month, today.day, hour, opts.minute, opts.timeZone);
    if (!candidate || candidate.getTime() <= opts.now.getTime()) {
      // Date.UTC normalises a day past the end of the month for us.
      candidate = zonedInstant(today.year, today.month, today.day + 1, hour, opts.minute, opts.timeZone);
    }
    return candidate;
  }

  const at = new Date(opts.now);
  at.setSeconds(0, 0);
  at.setHours(hour, opts.minute, 0, 0);
  if (at.getTime() <= opts.now.getTime()) at.setDate(at.getDate() + 1);
  return at;
}

/** The calendar date and clock this instant shows in `timeZone`. */
function zoneParts(at: Date, timeZone: string): { year: number; month: number; day: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const year = get('year');
    if (!Number.isFinite(year)) return null;
    return { year, month: get('month'), day: get('day') };
  } catch {
    return null; // an unknown zone id
  }
}

/**
 * The instant at which `timeZone` reads this wall-clock date and time.
 *
 * Two passes: guess with the offset at the naive instant, then correct with the
 * offset actually in force there — they differ across a DST boundary, and a
 * usage window reopening at 3am on a spring-forward Sunday is exactly the kind
 * of edge an unattended runner meets at 3am with nobody watching.
 */
function zonedInstant(
  year: number, month: number, day: number, hour: number, minute: number, timeZone: string,
): Date | null {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const first = zoneOffsetMs(new Date(naive), timeZone);
  if (first === null) return null;
  const corrected = zoneOffsetMs(new Date(naive - first), timeZone);
  return new Date(naive - (corrected ?? first));
}

/** How far `timeZone` is ahead of UTC at this instant, in ms. */
function zoneOffsetMs(at: Date, timeZone: string): number | null {
  const parts = zoneShown(at, timeZone);
  if (!parts) return null;
  return parts - Math.floor(at.getTime() / 1000) * 1000;
}

/** This instant's zone-local wall clock, expressed as if it were UTC. */
function zoneShown(at: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const year = get('year');
    if (!Number.isFinite(year)) return null;
    return Date.UTC(year, get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

/**
 * Every pattern here is matched against `text`, which is the session's own
 * output as well as its stderr. That makes loose tokens actively dangerous: a
 * phase that refactors a rate limiter, counts 401 lines, or touches a billing
 * module would otherwise be read as an auth failure and park the whole run for
 * a human who has nothing to fix. So each pattern demands the framing Claude
 * Code actually prints — `API Error:`, a full sentence — never a bare number or
 * a single common word.
 */

/**
 * The CLI's own lead-in on a failed request — what it prints, and what a
 * session narrating an incident in prose does not. Either half is framing:
 * the connect sentence carries the error on its own.
 */
const CERT_FRAME = 'api error:?|unable to connect to api';

/**
 * The CLI's sentence for a connection it could not make. It is framing AND
 * evidence: no session writes it about itself except when it happened.
 */
const CONNECT_SENTENCE = 'unable to connect to api';

/**
 * One sentence, two callers: the structured verdict and the prose match. It
 * names every login change a refusal may be (control-tower phase 91, #131): the
 * classifier is account-blind and cannot tell a lapse from a machine signed in
 * as somebody else, so it says both, and the runner — which knows the identity
 * the run started on — halts on `identity-changed` when that is what it was.
 */
const AUTH_REFUSED = 'authentication failed — the API refused the session\'s Claude login: it lapsed, it was signed out, '
  + 'or the machine was signed in as somebody else; sign that account in again, then continue the run';

/** The certificate diagnoses, bare — only ever matched behind `CERT_FRAME`. */
const CERT_TOKEN = 'self.signed certificate|certificate (?:verify|verification|validation) failed'
  + '|unable to (?:get local issuer|verify the first) certificate'
  + '|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE'
  + '|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID';

const RE = {
  // Shared across every model — switching model does NOT help, only time does.
  planLimit: /you'?ve hit your (session|weekly) limit|usage limit reached|claude ai usage limit/i,
  // Model-specific — the run continues immediately on another model.
  modelLimit: /you'?ve hit your (opus|sonnet|haiku|fable)[a-z0-9. -]* limit/i,
  overloaded: /api error:?\s*529|\b529\b[^\n]{0,24}overload|overloaded[_ ]error|overloaded errors|api is at capacity|is currently overloaded/i,
  rateLimit: /api error:?\s*429|request rejected \(429\)|rate[_ ]limit_error|rate.?limited|temporarily limiting requests|too many requests/i,
  // `login expired` is anchored to the start of a line or clause: the CLI leads
  // with the condition, prose embeds it ("tests for the login expired path").
  auth: /please run \/login|not logged in|invalid api key|invalid x-api-key|oauth (token|session) (expired|revoked|invalid)|failed to authenticate|could not be refreshed|(^|[·|\n]\s*)login expired|authentication_error|could not resolve authentication|api error:?\s*401|401 unauthorized/i,
  billing: /credit balance is too low|insufficient credits|usage credits required|billing (error|issue|problem)|spend limit (reached|exceeded)|payment (required|method)/i,
  orgPolicy: /organization has (been )?disabled|oauth_org_not_allowed|disabled api key authentication|disabled claude subscription/i,
  // A TLS interception (a corporate proxy, an MITM appliance) between this
  // machine and the API — BEHIND the CLI's own framing, on the same line, like
  // every sibling here and unlike the version that shipped through 5.1.0.
  //
  // That version matched five bare Node codes anywhere in a session's text,
  // which broke this table's own rule two paragraphs up and had the most
  // destructive consequence in the system wired to it. The measured cost: a
  // phase that COMPLETED — board `done`, two commits landed, $5.76 spent —
  // wrote a correct sentence about a transport failure it had survived, and
  // the console retired its account and every sibling in the organisation for
  // saying so, two seconds after the phase's own stop hook. The remedy for an
  // outage is to write it down, so the pattern disarmed the repair for the
  // thing it was repairing, every time.
  //
  // `CERT_FRAME` is the framing; `CERT_TOKEN` the diagnosis. The bare codes
  // still count — but only where the CLI actually printed them.
  certificate: new RegExp(`(?:${CERT_FRAME})[^\\n]{0,240}?(?:${CERT_TOKEN})`, 'i'),
  // "This machine cannot reach the API" — the single commonest way a long
  // unattended run meets the world, and the one condition the table could not
  // name until 5.2.0. Ordered AHEAD of `certificate` in `classify`, because
  // the measured incident's text leads with the connect sentence and only then
  // offers the CLI's own hedge about a proxy ("usually a TLS-inspecting
  // corporate proxy") — a guess about the network path, which the console used
  // to promote to a verdict about the organisation.
  connectivity: new RegExp(
    // Either the CLI's connect sentence on its own…
    `(?:${CONNECT_SENTENCE})`
    // …or its error framing followed, on the same line, by a Node network code.
    + `|(?:${CERT_FRAME})[^\\n]{0,240}?\\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETDOWN`
    + '|ENETUNREACH|EHOSTUNREACH|EHOSTDOWN|EPIPE|ERR_SOCKET_CONNECTION_TIMEOUT)\\b',
    'i',
  ),
  serverError: /api error:?\s*5\d\d|internal server error/i,
  timeout: /request timed out/i,
  // The CLI's own sentence when its background-task ceiling ends a `-p` run:
  // "Background tasks still running after 600s; terminating." The work those
  // tasks were doing was killed with the process group (SES-12).
  bgTasks: /Background tasks still running after (\d+)\s*s\b/i,
};

/**
 * Decide what a stopped session means. Order matters: the specific, expensive
 * mistakes are checked before the general ones — a model-only limit must never
 * be read as a plan limit, or the runner sleeps for hours it did not need to.
 */
export function classify(signal: StopSignal, now = new Date()): Disposition {
  const text = signal.text ?? '';
  const cats = signal.retryCategories ?? [];

  // `success` is believed only when nothing else contradicts it (SES-5): not
  // the CLI's own error bit, not a turn the CLI says was aborted, and not a
  // session the console ended before its turn was done.
  const aborted = Boolean(signal.terminalReason?.startsWith('aborted'));
  const endedByConsole = Boolean(signal.endedBy) && signal.endedBy !== 'exit';
  const believedSuccess = signal.subtype === 'success' && !signal.isError && !aborted && !endedByConsole;

  // A STRUCTURED verdict — a category the API itself returned on an
  // `api_retry` event, or the kind on an assistant message the CLI flagged as
  // an API error — is evidence about this session's fate and outranks
  // everything below, success included.
  const structured = structuredVerdict(apiKinds(signal));
  if (structured) {
    return {
      kind: 'credential-refused', reason: structured.reason, class: structured.class,
      evidence: { source: 'api', matched: structured.kind },
    };
  }

  // Everything below reads the session's PROSE, which is its output as well as
  // its stderr — and a session that did a phase's worth of work and reported
  // success is narrating, not confessing. Measured: a completed phase wrote an
  // accurate sentence about a transport failure it had survived and had its
  // account, and its whole organisation, retired for it; every later phase
  // that quoted that handoff did it again, so the remedy for an outage was the
  // thing that reproduced it.
  //
  // The case the credentials-before-success ordering was built for is
  // untouched and stays distinguishable on the CLI's own ledger: an expired
  // login reports success after ONE turn and zero dollars, having done nothing
  // at all.
  const worked = !spentNothing(signal);
  if (!(believedSuccess && worked)) {
    // The network first. The measured certificate incident's text LEADS with
    // the connect sentence and only then offers the CLI's hedge about a proxy,
    // so reading the hedge first is what turned half an hour of no internet
    // into a permanent, machine-wide, latched outage of the product.
    if (RE.connectivity.test(text) || cats.includes('cloud_credential_error')) {
      // Certificate-shaped? Then the class rides along, not as a verdict but
      // as something to corroborate: a home connection dropping out, a captive
      // portal and a router intercepting its own reconnect all answer TLS.
      const shaped = RE.certificate.test(text);
      return {
        kind: 'connectivity',
        reason: shaped
          ? 'this machine could not reach the API, and the connection answered with a certificate '
            + 'it does not trust — retrying; a standing interception shows up as a repeat'
          : 'this machine could not reach the API — retrying',
        ...(shaped ? { class: 'certificate' as CredentialClass } : {}),
      };
    }

    // The organisation, the login and the bill are read off the CLI's
    // API-error channels ONLY (#57) — `credentialChannel`. A session that did
    // work and then failed has written prose, and a phase building a checkout
    // quotes the 402 title and the empty-wallet copy of its own fixtures; read
    // as a verdict, that retired a whole organisation with no API error in the
    // transcript. The certificate keeps phase 3's framing rule on `text`,
    // because its breaker cools only on corroboration.
    const channel = credentialChannel(signal);
    const org = matchedLine(RE.orgPolicy, channel);
    // Deliberately account-agnostic: this classifier cannot see which login
    // the session ran as, and "run /login in this workspace" was flatly wrong
    // advice for a profile or token account. The runner appends the account
    // id; the service composes the exact command.
    const auth = org ? null : matchedLine(RE.auth, channel);
    const bill = org || auth ? null : matchedLine(RE.billing, channel);
    const brokenCredentials: { reason: string; class: CredentialClass; evidence?: CredentialEvidence } | null =
      org ? { reason: 'organization policy blocks this credential', class: 'org-policy', evidence: { source: 'text', matched: org } }
        : auth ? { reason: AUTH_REFUSED, class: 'auth', evidence: { source: 'text', matched: auth } }
          : bill ? { reason: 'billing or credit balance needs attention', class: 'billing', evidence: { source: 'text', matched: bill } }
            : RE.certificate.test(text)
              // Framed, and with no connect sentence in front of it: a
              // standing interception rather than a blip. Still not the
              // credential's fault — but the remedy is the same, and the
              // breaker only moves once the corroboration ledger agrees.
              ? {
                reason: 'the API refused the connection: a certificate this machine does not trust '
                  + '(a self-signed or intercepting certificate) — fix the trust store or the proxy, then continue the run',
                class: 'certificate',
                evidence: { source: 'text', matched: matchedLine(RE.certificate, text) ?? '' },
              }
              : null;
    if (brokenCredentials) return { kind: 'credential-refused', ...brokenCredentials };
  }

  // The spawn's own clock ended this child — the first-event backstop or the
  // init→result bound (SES-10, SES-11). Its diagnosis is precise and its remedy
  // is mechanical, so it is a retry quoting the diagnosis; read as the SIGTERM
  // it arrived as, it used to halt the run for a person who had pressed nothing.
  if (signal.endedBy === 'spawn-watchdog') {
    return {
      kind: 'retry',
      afterMs: 60_000,
      reason: `the spawn watchdog ended the session: ${signal.endedReason ?? 'it stopped making progress'}`,
    };
  }

  // The CLI's background-task ceiling killed work that was still running when
  // a session reported success (SES-12): the phase's own suite or build,
  // backgrounded to satisfy the in-turn-wait guard, died with the process
  // group. Never `ok` — and named, from the tasks the stream saw start.
  const ceiling = RE.bgTasks.exec(text);
  if (ceiling && (signal.subtype === 'success' || !signal.subtype)) {
    const tasks = signal.backgroundTasks ?? [];
    const named = tasks.length
      ? `: ${tasks.map((task) => (task.description ? `${task.id} (${task.description.slice(0, 80)})` : task.id)).join(', ')}`
      : ' (the stream named no task)';
    return {
      kind: 'phase-failed',
      reason: `the CLI's background-task ceiling (${ceiling[1]}s) terminated work still running when the session ended${named}`,
    };
  }

  // Nothing above contradicted it, so the success stands.
  if (believedSuccess) return { kind: 'ok' };

  // Killed by a supervisor or the OS — not the model's doing.
  if (signal.code === 143) return { kind: 'needs-human', reason: 'session was terminated (SIGTERM)' };
  if (signal.code === 137) return { kind: 'retry', afterMs: 30_000, reason: 'session was killed (SIGKILL/OOM) — retrying once' };

  // The work is intact, just capped. `subtype` is a structured field the CLI
  // sets deliberately, so it outranks every text heuristic below — a phase that
  // spent its budget while *discussing* rate limits must still resume, not be
  // read as rate-limited. Resuming the SAME session keeps what it already did.
  if (signal.subtype === 'error_max_budget_usd') {
    return { kind: 'resume', raise: 'budget', reason: 'phase hit its cost cap mid-work' };
  }
  if (signal.subtype === 'error_max_turns') {
    return { kind: 'resume', raise: 'turns', reason: 'phase hit its turn cap mid-work' };
  }

  // Model-specific exhaustion. Checked BEFORE the plan limit: the message
  // "You've hit your Opus limit" also contains the word "limit", and reading it
  // as a plan limit would idle the run for hours when another model is free.
  if (RE.modelLimit.test(text)) {
    const at = parseResetTime(text, now);
    return {
      kind: 'switch-model',
      reason: `${signal.model ?? 'this model'} is rate-limited; the window is per-model`,
      bucket: limitBucket(text),
      ...(at ? { at } : {}),
    };
  }

  // Plan window exhausted — shared across models, so only time fixes it.
  if (RE.planLimit.test(text)) {
    const at = parseResetTime(text, now);
    if (at) {
      const waitMs = at.getTime() - now.getTime() + RESET_MARGIN_MS;
      if (waitMs > MAX_AUTO_WAIT_MS) {
        return {
          kind: 'needs-human',
          cause: 'usage-window',
          at,
          reason: `usage limit resets ${at.toISOString()}, which is more than 12h away — parking rather than sleeping on it`,
        };
      }
      return {
        kind: 'wait-until',
        at: new Date(at.getTime() + RESET_MARGIN_MS),
        reason: `usage limit reached; resumes at ${at.toLocaleString()}`,
      };
    }
    // A limit we could not time. Wait a conservative hour rather than guess.
    return {
      kind: 'wait-until',
      at: new Date(now.getTime() + 60 * 60 * 1000),
      reason: 'usage limit reached with no parseable reset time — retrying in 1h',
    };
  }

  // Capacity, not quota. Per-model, so another model may be free right now.
  if (RE.overloaded.test(text) || cats.includes('overloaded')) {
    return { kind: 'switch-model', reason: 'the API is at capacity for this model (529)' };
  }
  if (RE.rateLimit.test(text) || cats.includes('rate_limit')) {
    return { kind: 'retry', afterMs: 5 * 60_000, reason: 'rate limited (429) after the CLI exhausted its own retries' };
  }
  if (RE.serverError.test(text) || RE.timeout.test(text) || cats.includes('server_error')) {
    return { kind: 'retry', afterMs: 2 * 60_000, reason: 'server error or timeout' };
  }

  // The model declined. A retry produces the same refusal; a person must look.
  if (signal.stopReason === 'refusal') {
    return { kind: 'needs-human', reason: 'the model declined the task' };
  }

  // `--resume` named a conversation the CLI does not hold here — the transcript
  // sits under another account's config dir, or another cwd's project folder.
  // The same command answers the same way every time, so a retry is the loop
  // this branch exists to end (nineteen identical `--resume`s on one phase).
  if (lostResume(signal)) {
    return { kind: 'phase-failed', reason: 'the session to resume is gone: the CLI holds no conversation under that id here' };
  }

  if (signal.subtype === 'error_during_execution') {
    return { kind: 'retry', afterMs: 60_000, reason: 'the loop was interrupted mid-execution' };
  }

  return {
    kind: 'phase-failed',
    reason: signal.subtype === 'success' && signal.isError
      ? `the session reported an error the console does not recognise: ${firstLine(text) || 'no text'}`
      : signal.subtype === 'success' && aborted
        ? `the session's turn was aborted (${signal.terminalReason})`
        : signal.subtype === 'success' && endedByConsole
          ? `the console ended the session (${signal.endedBy}) before its turn was done`
          : signal.subtype ? `session ended: ${signal.subtype}` : `session exited with code ${signal.code ?? '?'}`,
  };
}

/** The first non-blank line of a text, bounded — enough to name an error, never a log. */
function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim()) ?? '').trim().slice(0, 200);
}

/**
 * The CLI's own refusal when `--resume` names a conversation it cannot find:
 * `No conversation found with session ID: <uuid>` at the head of stderr, an
 * `error_during_execution` result, zero turns, three seconds. Measured on three
 * runs (31285928 p3, 65958e6e p7, 3cd7abf5 p8's first rung).
 *
 * Keyed on the sentence, at a line start, and never on the subtype alone:
 * `spawn.ts`'s own `fail()` writes `error_during_execution` for a child that
 * never started, and that one IS worth a retry. A session that merely quotes
 * the words mid-line (a reviewer reading these docs) is not a lost resume.
 */
const RE_LOST_RESUME = /^\s*No conversation found with session ID\b/m;

export function lostResume(signal: StopSignal): boolean {
  if (signal.subtype === 'success') return false;
  return RE_LOST_RESUME.test(signal.text ?? '');
}

/**
 * The console's `CLAUDE_CODE_MAX_RETRIES` for a child, kept on purpose.
 *
 * The docs (chapter 09 row 40, DOC-2): with `CLAUDE_CODE_RETRY_WATCHDOG` set,
 * an UNSET variable defaults to 300 attempts — roughly three hours of backoff
 * for non-capacity transient errors — while an explicit value is honoured as
 * written. So this `15` keeps fifteen, and that is the choice: a CLI retrying a
 * server outage for three hours inside one session holds its lock and produces
 * nothing, where fifteen hands the failure back within minutes to the layers
 * that can act on it — the liveness ladder, the retry-storm park, the account
 * and model switches. It used to be described as raising retries to three
 * hours, which it never did; `phase.retry-ceiling` now journals which ceiling
 * each child ran under.
 */
export const CONSOLE_MAX_RETRIES = '15';

/**
 * The background-task ceiling set on every child: the CLI's documented default
 * (600 000 ms, chapter 09 row 42), set explicitly rather than inherited by
 * accident (SES-12). At the end of a `-p` run the CLI waits up to this long for
 * the session's background tasks and then terminates them. What that wait holds
 * was measured (autopilot-token-drain §Context, CLI 2.1.273): a background SHELL
 * is stopped about five seconds after the turn ends whatever this says, while an
 * Agent or Monitor running in the background keeps the process alive — bounded by this ceiling
 * — and its completion starts a new turn, so the model does read that work. Past the ceiling it
 * is stopped unread (E7, CLI 2.1.274: at a 15 s ceiling, 15 s after the turn ended), which is why
 * wait rule 4 says "ten minutes" and `test/wait-procedure.test.ts` holds that number to this one.
 * Longer would hold a session's process, and its lock, for an agent that has
 * stopped reporting; `0` would hold it for ever. The warning it prints is
 * recognised (`RE.bgTasks`), so the kill is not silent.
 */
export const BG_WAIT_CEILING_MS = 600_000;

/**
 * Environment for a child session.
 *
 * `CLAUDE_CODE_RETRY_WATCHDOG=1` is documented for "CI/unattended sessions":
 * it retries 429 and 529 indefinitely. That is strictly better than anything
 * this runner could do from outside the process, because the CLI can resume
 * mid-turn where we would have to restart the phase. So the child absorbs the
 * transient failures and only the decisions above reach us — within the retry
 * ceiling `CONSOLE_MAX_RETRIES` explains.
 */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const decided = childEnvDecisions(base);
  return {
    ...base,
    CLAUDE_CODE_RETRY_WATCHDOG: '1',
    // The watchdog governs 429/529; this covers everything else it does not.
    CLAUDE_CODE_MAX_RETRIES: decided.maxRetries.value,
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: decided.bgWaitCeilingMs.value,
    // The session's own evidence — its task list, its declared outcome, its
    // lock, its presence hook — is written by a process this console lets go
    // of. Nothing afterwards could correlate those with the drive that started
    // them, so the id travels in the environment. Last, and always stated:
    // outside a span every key is `undefined`, which DELETES an inherited
    // `TRACEPARENT` rather than handing a stranger's trace to a two-hour
    // session.
    ...envCarrier(),
  };
}

/** One environment ceiling a child runs under, and whether the console set it or inherited it. */
export type ChildEnvDecision = { value: string; source: 'env' | 'console' };

/**
 * The two CLI-side ceilings `childEnv` puts on a child, with where each came
 * from — what `phase.retry-ceiling` journals once per spawn, so an exhausted
 * retry budget or a killed background task can be read against the ceiling
 * that was actually in force.
 */
export function childEnvDecisions(base: NodeJS.ProcessEnv = process.env): {
  maxRetries: ChildEnvDecision; bgWaitCeilingMs: ChildEnvDecision;
} {
  return {
    maxRetries: base.CLAUDE_CODE_MAX_RETRIES !== undefined
      ? { value: base.CLAUDE_CODE_MAX_RETRIES, source: 'env' }
      : { value: CONSOLE_MAX_RETRIES, source: 'console' },
    bgWaitCeilingMs: base.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS !== undefined
      ? { value: base.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, source: 'env' }
      : { value: String(BG_WAIT_CEILING_MS), source: 'console' },
  };
}

/**
 * Models to fall back through, in order, when one is limited or at capacity.
 *
 * Strongest first, because falling back is a demotion: a phase that cannot run
 * on Fable should try Opus before it tries Haiku.
 *
 * The order now comes from `scripts/models.env` (via `MODELS_ENV_FALLBACK`)
 * rather than being spelled here, because this array used to be TWO things at
 * once: the escalation ladder, and — imported as `MODELS` by `agent.ts` and
 * `api/routes.ts` — the list of model names a door would accept. Those are not
 * the same list. A ladder wants bare aliases in strength order; a door wants to
 * take every spelling the CLI takes, full ids and `[1m]` variants included.
 * Conflating them is why `claude-opus-5` was a 400 on one route and a silent
 * drop on another. Doors now ask `isKnownModel()`; this stays the ladder.
 */
export const MODEL_FALLBACK = [...MODELS_ENV_FALLBACK.aliases];

/**
 * Where a model sits in the chain, by alias or by full id. -1 when unknown.
 *
 * A `[1m]` variant ranks as its base model on purpose: the suffix selects a
 * context window, not a different model, so `claude-opus-5[1m]` demotes to
 * `sonnet` exactly as `opus` does. Escalation and demotion still emit a bare
 * alias, which means the window preference is dropped at a model switch —
 * recorded here as known and accepted, since the alternative is asserting that
 * every model in the ladder offers a 1M window, which the console cannot know.
 */
function rankOf(model?: string): number {
  const family = modelFamily(model);
  return family ? MODEL_FALLBACK.indexOf(family) : -1;
}

export function nextModel(current?: string): string | null {
  if (!current) return MODEL_FALLBACK[1] ?? null;
  const index = rankOf(current);
  return index >= 0 && index + 1 < MODEL_FALLBACK.length ? MODEL_FALLBACK[index + 1] : null;
}

/**
 * Everything below `current`, for `--fallback-model`.
 *
 * The CLI fails over **inside** the process and keeps the session, where our own
 * `switch-model` disposition can only kill the phase and start it again from
 * the boot prompt — throwing away however long it had been working. So the
 * chain is handed over up front and the disposition becomes the second line of
 * defence rather than the first.
 */
export function fallbackChain(current?: string): string[] {
  const index = rankOf(current);
  return index >= 0 ? MODEL_FALLBACK.slice(index + 1) : [];
}

/**
 * When to come back for a window whose reset moment is known: the reset plus
 * the clock margin — or `null` when that is not a moment worth sleeping to,
 * because it is further out than `MAX_AUTO_WAIT_MS` (past which waiting is
 * worse than telling someone). A reset already behind us answers "now": the
 * window has reopened, there is nothing to wait for, and a wait into the past
 * is the livelock shape.
 *
 * The runner asks this about the FIRST model's window when every model in the
 * fallback chain is limited: the strongest model's reset is the one worth
 * waiting for, and the phase retries its own session on it.
 */
export function resetWaitUntil(at: Date, now = new Date(), maxWaitMs = MAX_AUTO_WAIT_MS): Date | null {
  const until = at.getTime() + RESET_MARGIN_MS;
  if (!Number.isFinite(until)) return null;
  if (until - now.getTime() > maxWaitMs) return null;
  return new Date(Math.max(until, now.getTime()));
}
