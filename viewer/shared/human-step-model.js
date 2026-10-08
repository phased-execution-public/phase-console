/**
 * A person's turn — the words for a HUMAN STEP, before any verb acts on one.
 *
 * When a run needs an act only a person can do (the named case: a login that
 * opens a browser and waits), that is not a failure, not a stall and not a
 * free-text errand. It is a typed record with a workflow: the console informs,
 * waits, lets the person open the step again as often as they need, proves it
 * was done and resumes the session saying what was proven (control-tower
 * §Architecture 12, operator decision 7). Phase 41 owns this LANGUAGE — the
 * kinds, the states, where a step can be done, the plan bullet's keys and the
 * redaction floor. Phase 43 owns the verbs, phase 44 what the console notices,
 * phase 42 the face; every one of them reads these words and none re-spells
 * them.
 *
 * `scripts/human-steps.env` is the bash twin (the F5 pattern, like
 * `gates.env`); `viewer/test/gates-vocab.test.ts` asks bash for every list
 * below and holds it to these word for word.
 *
 * ⚠️ No imports — the client bundles this module and `node --test` imports it
 * directly. `test/vocab-owners.test.ts` registers every list.
 *
 * FREE, not Pro (decision 7): the language is both editions; only the verbs
 * that act on the host sit behind the flags that already gate them.
 */

/* ------------------------------------------------------------------ *
 * What a person may be asked to do
 * ------------------------------------------------------------------ */

/**
 * Every scenario gets the same workflow — the catalogue of §Architecture 12,
 * in its own order. Eighteen kinds, and closed: a scenario that fits none is a
 * kind nobody has designed the proof for yet, and the lint refuses the word.
 * `operator-act` (control-tower phase 121, #182) is the general act only the
 * operator does — a command to run or a click path to follow — and the one
 * kind that is usually born BEFORE it is due (`upcoming`, below). The last,
 * `permission` (phase 130, #207), is a wall the AI met: it ends by a grant or
 * a denial, never by a proof.
 * @typedef {(typeof HUMAN_STEP_KINDS)[number]} HumanStepKind
 */
export const HUMAN_STEP_KINDS = Object.freeze(
  /** @type {const} */ ([
    'browser-login',
    'device-code',
    'one-time-code',
    'secret-entry',
    'claude-login',
    'mcp-login',
    'os-prompt',
    'os-permission',
    'third-party-approval',
    'physical',
    'person-check',
    'decision',
    'protected-path',
    'interactive-prompt',
    'captcha',
    'email-link',
    'operator-act',
    'permission',
  ]),
);

/**
 * Where a step has got to. Eleven states, a PATH, not flags: `declared` →
 * `notified` → `opened` (as often as the person needs) → `checking` →
 * `proven` is the ordinary road. The last four settle a step; nothing moves
 * out of them. A step declared with a due-when ref starts one stop earlier.
 *
 *   upcoming   — born before it is due (control-tower phase 121): open, but
 *                unannounced and unreminded, and its window has not started.
 *                Its due-when ref landing makes it `declared` with the ONE
 *                push; nothing else moves into it
 *   declared   — written to the ledger; nobody has been told yet
 *   notified   — the inbox row stands and the push went out (a reminder
 *                re-notifies)
 *   opened     — the person opened it (again); the ledger counts how often
 *   checking   — the proof is being run (*I did it — check now*, or the watch)
 *   returned   — checked and sent back, saying exactly what to redo (phase
 *                130's word; phase 134's check writes it)
 *   proven     — the proof held; the session resumes saying so
 *   declined   — the person's own "not doing this", with a reason (phase 130)
 *   expired    — the window closed with nothing proven
 *   cannot     — the person said *I can't do this*: an errand, never a loop
 *   dismissed  — withdrawn: what the CONSOLE does to a step nobody needs any
 *                more (a person declines, or says they can't)
 * @typedef {(typeof HUMAN_STEP_STATES)[number]} HumanStepState
 */
export const HUMAN_STEP_STATES = Object.freeze(
  /** @type {const} */ ([
    'upcoming',
    'declared',
    'notified',
    'opened',
    'checking',
    'returned',
    'proven',
    'declined',
    'expired',
    'cannot',
    'dismissed',
  ]),
);

/** The states a step is still OPEN in — an inbox row stands for each (an `upcoming` one is *Coming up*). */
export const HUMAN_STEP_OPEN_STATES = Object.freeze(
  /** @type {const} */ (/** @type {HumanStepState[]} */ (HUMAN_STEP_STATES.slice(0, 6))),
);

/** The states that settle a step. */
export const HUMAN_STEP_SETTLED_STATES = Object.freeze(
  /** @type {const} */ (/** @type {HumanStepState[]} */ (HUMAN_STEP_STATES.slice(6))),
);

/**
 * Which state may follow which. Re-entry is allowed where the workflow wants
 * it — open again, remind again, check again — and nothing leaves a settled
 * state: a proven step that "un-proves" is a new step. An `upcoming` step
 * becomes due (`declared`), or settles — its proof landed early, a person
 * cannot do it, or it was withdrawn — and is never opened or reminded first.
 * Only a check sends a step back (`checking` → `returned`), and a returned
 * step is worked again like any open one; a person may decline any open step.
 * @type {Readonly<Record<HumanStepState, readonly HumanStepState[]>>}
 */
export const HUMAN_STEP_TRANSITIONS = Object.freeze({
  upcoming: Object.freeze(['declared', 'proven', 'declined', 'expired', 'cannot', 'dismissed']),
  declared: Object.freeze([
    'notified',
    'opened',
    'checking',
    'proven',
    'declined',
    'expired',
    'cannot',
    'dismissed',
  ]),
  notified: Object.freeze([
    'notified',
    'opened',
    'checking',
    'proven',
    'declined',
    'expired',
    'cannot',
    'dismissed',
  ]),
  opened: Object.freeze([
    'notified',
    'opened',
    'checking',
    'proven',
    'declined',
    'expired',
    'cannot',
    'dismissed',
  ]),
  checking: Object.freeze([
    'notified',
    'opened',
    'checking',
    'returned',
    'proven',
    'declined',
    'expired',
    'cannot',
    'dismissed',
  ]),
  returned: Object.freeze([
    'notified',
    'opened',
    'checking',
    'proven',
    'declined',
    'expired',
    'cannot',
    'dismissed',
  ]),
  proven: Object.freeze([]),
  declined: Object.freeze([]),
  expired: Object.freeze([]),
  cannot: Object.freeze([]),
  dismissed: Object.freeze([]),
});

/**
 * May a step in `from` move to `to`? Unknown words answer no.
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
  const next = /** @type {Record<string, readonly string[]>} */ (HUMAN_STEP_TRANSITIONS)[from];
  return Array.isArray(next) && next.includes(to);
}

/**
 * Where the act can be done. `host` — at the machine the console runs on (a
 * browser callback on `localhost`, a keychain prompt, a USB cable); `any` —
 * from any device, the phone included.
 * @typedef {(typeof HUMAN_STEP_WHERE)[number]} HumanStepWhere
 */
export const HUMAN_STEP_WHERE = Object.freeze(/** @type {const} */ (['host', 'any']));

/**
 * The one value `auto-open:` takes. Only a PLAN-declared step may carry it — a
 * step a session declared never opens by itself (the safety floor).
 */
export const HUMAN_STEP_AUTO_OPEN = Object.freeze(/** @type {const} */ (['host']));

/**
 * The four ways a step is born: the plan says so (a `- **Human step:**`
 * bullet), a session says so (`phase-outcome.sh … needs-human --step`), the
 * console notices (phase 44's guard and stall reading), the supervisor raises
 * it (phase 136: its escalation, or an item a chat asks for).
 * @typedef {(typeof HUMAN_STEP_BIRTHS)[number]} HumanStepBirth
 */
export const HUMAN_STEP_BIRTHS = Object.freeze(
  /** @type {const} */ (['plan', 'session', 'console', 'supervisor']),
);

/**
 * The keyed fields of the plan bullet, after its two positional ones (the
 * kind and what to do):
 *
 *   - **Human step:** <kind> · <what> · open: <url or command> · proof: <ref>
 *     · where: host|any · window: 2d [· auto-open: host] [· credential: <id>]
 *     [· due: <ref>]
 *
 * `credential:` belongs to `secret-entry` alone — the registry id the secret
 * is stored under. `due:` (control-tower phase 121) is a watch ref: the step
 * is `upcoming` until it lands, then due — the bullet is legal under the
 * plan's `## Operator errands` too, where it is the plan's own (phase 0).
 *
 * Phase 130 (#207) adds four: `why:` — a `WHY_PERSON` reason the kind allows
 * (`shared/turn-model.js` `KIND_REASONS`; a bullet with none is given its
 * kind's default, an advisory, never a red), `effort:` — the minutes it takes
 * (`5m`, `1h`, or bare minutes), `unblocks:` — the phases it unblocks, comma
 * separated, and `guide:` — a guide file under the docs root, in the grammar
 * of `shared/guide-grammar.js`.
 */
export const HUMAN_STEP_BULLET_KEYS = Object.freeze(
  /** @type {const} */ ([
    'open',
    'proof',
    'where',
    'window',
    'auto-open',
    'credential',
    'due',
    'why',
    'effort',
    'unblocks',
    'guide',
  ]),
);

/**
 * Is a `due:` value a watch ref the console can poll — each scheme's SHAPE,
 * exactly as the F37 lint (`phase-graph.sh`) and the session door
 * (`phase-outcome.sh` `_watch_problem`) read it (control-tower phase 121)? A
 * value that fits none would leave its step `upcoming`, unannounced, for ever.
 * @param {unknown} ref
 * @returns {boolean}
 */
export function dueRefOk(ref) {
  const text = String(ref ?? '');
  const body = text.slice(text.indexOf(':') + 1);
  if (text.startsWith('gh:'))
    return /^gh:[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*#(run|pr)\/[0-9]+$/.test(text);
  if (/^(date|until):/.test(text)) return /^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}/.test(body);
  if (/^(lock|phase|verify):/.test(text)) return /^[A-Za-z0-9][A-Za-z0-9._-]*\/0*[1-9][0-9]*$/.test(body);
  if (text.startsWith('cmd:'))
    return /[^ \t]/.test(body.replace(/^"/, '').replace(/"$/, '').replace(/^'/, '').replace(/'$/, ''));
  if (text.startsWith('unit:'))
    return /^unit:[A-Za-z0-9][A-Za-z0-9._-]{0,62}\/[A-Za-z0-9][A-Za-z0-9@._:-]{0,254}$/.test(text);
  return false;
}

/**
 * The reminder clock a waiting step is re-announced on: +15 m, +1 h, +6 h, then
 * daily (the last entry repeats), quiet hours honoured. Phase 43 runs it: each
 * entry is the gap after the previous reminder — or after the person's last
 * act on the step, whichever is later — indexed by how many reminders went out.
 */
export const REMINDER_SERIES_MS = Object.freeze([
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
]);

/**
 * The verbs a person presses on a step (control-tower phase 43), one route
 * each — `POST /api/human-steps/:id/<verb>`, except `attach`, whose route is
 * `…/evidence`. *Open* and *Open again* are one verb: the ledger counts every
 * open, and a step may be opened again in any state short of settled. Phase
 * 133 (#210) adds the owner's other moves: `answer` (a decision's option, a
 * note, or both), `decline` (with a reason, where the item allows it), `ask`
 * (a question about the task) and `attach` (evidence). Phase 134 (#211) adds
 * `override` — the owner's *Accept anyway*, the ONE route that writes a
 * verdict — and `rewrite`, the escalation's *Rewrite the guide*, which
 * withdraws the item (a `dismiss` move) and resumes its raiser. `answer`, `decline` and `override` carry the owner's authority
 * (`door-model.js` `AUTHORITY_ROUTES`); the rest do not. Not registered in `vocab-owners` for the reason `HUMAN_STEP_WHERE`
 * is not: common words match prose everywhere.
 */
export const HUMAN_STEP_VERBS = Object.freeze(
  /** @type {const} */ ([
    'open',
    'check',
    'snooze',
    'cannot',
    'dismiss',
    'answer',
    'decline',
    'ask',
    'attach',
    'override',
    'rewrite',
  ]),
);

/**
 * What a ledger move line's `verb` records: every verb above, and the
 * console's own moves — the `due` an upcoming step's landed due-when ref makes
 * (control-tower phase 121), the first `notify`, each `remind`, the `prove` a
 * landed proof makes, and the `expire` a closed window makes. A move written
 * before phase 43 carries none, and reads by its state. Phase 130 adds three:
 * `wait` — the same wall met again, ONE step with another waiter (G7), which
 * moves no state; `return` — a check sent the step back; `decline` — a
 * person's "not doing this". Phase 133 adds three more: `answer` — a decision
 * answered, which proves it; `ask` and `attach` — a question and a piece of
 * evidence, which move no state (`HUMAN_STEP_STILL_MOVES`). Phase 134 adds
 * `override` — the owner accepted an item anyway, recorded as the owner's and
 * unverified.
 * @typedef {(typeof HUMAN_STEP_MOVES)[number]} HumanStepMove
 */
export const HUMAN_STEP_MOVES = Object.freeze(
  /** @type {const} */ ([
    'due',
    'notify',
    'remind',
    'open',
    'check',
    'prove',
    'snooze',
    'cannot',
    'dismiss',
    'expire',
    'wait',
    'return',
    'decline',
    'answer',
    'ask',
    'attach',
    'override',
    'rewrite',
  ]),
);

/**
 * The moves that leave a step in the state it was in: another waiter (G7), a
 * question, a piece of evidence. Each is a line of the step's history, never
 * a step along its path — the ledger reader accepts one only at the state it
 * names.
 * @type {readonly HumanStepMove[]}
 */
export const HUMAN_STEP_STILL_MOVES = Object.freeze(
  /** @type {HumanStepMove[]} */ (
    HUMAN_STEP_MOVES.filter((verb) => verb === 'wait' || verb === 'ask' || verb === 'attach')
  ),
);

/**
 * Where `open` sends a step's link. `here` answers it for the caller's own
 * browser; `host` opens it on the machine the console runs on, behind
 * `--allow-terminal` or `--allow-agent`, and only once the caller has been
 * shown the full URL and sent it back. A step whose `open` is a command opens
 * the embedded terminal either way.
 * @typedef {(typeof HUMAN_STEP_OPEN_WHERE)[number]} HumanStepOpenWhere
 */
export const HUMAN_STEP_OPEN_WHERE = Object.freeze(/** @type {const} */ (['here', 'host']));

/**
 * A step's window when it names none: seven days, the ceiling a `needs-human`
 * clock has. Every step ends — expired, and an errand — so none reminds for
 * ever.
 */
export const HUMAN_STEP_DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** How long `snooze` quiets a step's reminders when it names no length, and the most it may. */
export const HUMAN_STEP_SNOOZE_DEFAULT_MS = 60 * 60_000;
export const HUMAN_STEP_SNOOZE_MAX_MS = 24 * 60 * 60_000;

/**
 * What each kind is CALLED and how it is drawn — the ONE place a kind's icon
 * and label are read (phase 42 draws them; nobody re-spells one). `icon` is a
 * lucide name; `where` the default when the step does not say; `proof` the
 * hint for what proves it, in the catalogue's words.
 * @type {Readonly<Record<HumanStepKind, Readonly<{icon: string, label: string, where: HumanStepWhere, proof: string}>>>}
 */
export const KIND_META = Object.freeze({
  'browser-login': Object.freeze({
    icon: 'log-in',
    label: 'Sign in in a browser',
    where: 'host',
    proof: "a cmd: ref running the tool's own status verb (gh auth status)",
  }),
  'device-code': Object.freeze({
    icon: 'smartphone',
    label: 'Enter a device code',
    where: 'any',
    proof: "a cmd: ref running the tool's status verb",
  }),
  'one-time-code': Object.freeze({
    icon: 'hash',
    label: 'Type a one-time code',
    where: 'host',
    proof: "the command's exit — the code is typed in the terminal, never in a chat",
  }),
  'secret-entry': Object.freeze({
    icon: 'key-round',
    label: 'Supply a secret',
    where: 'any',
    proof: 'the credential probe turns green',
  }),
  'claude-login': Object.freeze({
    icon: 'user-round-check',
    label: 'Sign in to Claude',
    where: 'host',
    proof: "the account's meter reads signed in",
  }),
  'mcp-login': Object.freeze({
    icon: 'plug',
    label: 'Sign in an MCP server',
    where: 'host',
    proof: "the server's probe reads connected",
  }),
  'os-prompt': Object.freeze({
    icon: 'fingerprint',
    label: 'Answer a prompt at the machine',
    where: 'host',
    proof: "the command's exit",
  }),
  'os-permission': Object.freeze({
    icon: 'shield-check',
    label: 'Grant an OS permission',
    where: 'host',
    proof: 'a cmd: ref that probes the permission',
  }),
  'third-party-approval': Object.freeze({
    icon: 'building-2',
    label: 'Get an approval elsewhere',
    where: 'any',
    proof: 'a gh: ref (a PR or a run) or a cmd: ref',
  }),
  physical: Object.freeze({
    icon: 'usb',
    label: 'Do something by hand',
    where: 'host',
    proof: 'a cmd: ref that probes the device',
  }),
  'person-check': Object.freeze({
    icon: 'eye',
    label: 'Check it by eye',
    where: 'any',
    proof: "the person's answer — it is right, or it is wrong",
  }),
  decision: Object.freeze({
    icon: 'split',
    label: 'Make a decision',
    where: 'any',
    proof: "the person's answer",
  }),
  'protected-path': Object.freeze({
    icon: 'lock',
    label: 'Make a protected edit',
    where: 'host',
    proof: 'the edit is on the branch',
  }),
  'interactive-prompt': Object.freeze({
    icon: 'terminal',
    label: 'Answer an interactive prompt',
    where: 'host',
    proof: "the command's exit",
  }),
  captcha: Object.freeze({
    icon: 'bot',
    label: 'Pass a captcha',
    where: 'any',
    proof: 'a cmd: ref that probes the service',
  }),
  'email-link': Object.freeze({
    icon: 'mail',
    label: 'Follow a link in an email',
    where: 'any',
    proof: 'a cmd: ref that probes the service',
  }),
  'operator-act': Object.freeze({
    icon: 'clipboard-check',
    label: 'Carry out a task',
    where: 'host',
    proof: 'a cmd: ref that reads what the task changed',
  }),
  permission: Object.freeze({
    icon: 'shield-off',
    label: 'Grant a permission',
    where: 'any',
    proof: 'a grant or a denial — the item ends there',
  }),
});

/**
 * The kind a word names, or null. Case-folded and trimmed, backticks stripped —
 * a plan author writes `` `browser-login` `` as often as the bare word.
 * @param {unknown} word
 * @returns {HumanStepKind|null}
 */
export function humanStepKindOf(word) {
  const w = String(word ?? '')
    .replace(/`/g, '')
    .trim()
    .toLowerCase();
  return /** @type {readonly string[]} */ (HUMAN_STEP_KINDS).includes(w)
    ? /** @type {HumanStepKind} */ (w)
    : null;
}

/* ------------------------------------------------------------------ *
 * The redaction floor
 * ------------------------------------------------------------------ */

/**
 * The shapes a secret has, as POSIX EREs matched CASE-INSENSITIVELY — the
 * dialect `phase-outcome.sh` and `phase-graph.sh` match them in (bash 3.2
 * `[[ =~ ]]` under `nocasematch`). JavaScript reads the same strings through
 * `secretRegExp`, which turns the POSIX classes used here (`[:alnum:]` and
 * `[:space:]`) into its own. No pattern contains a literal space, so the bash
 * twin can keep them in one space-separated line.
 *
 * Tokens by their prefix (GitHub, Anthropic/OpenAI `sk-`, npm, Slack, AWS,
 * Google, Stripe, a JWT, a bearer header, a PEM private key), a password or
 * secret written as an assignment or a flag, and a 6–8 digit code standing
 * alone — the one-time code a person holds. A value shaped like one of these
 * is refused at the door and redacted at every sink.
 */
export const SECRET_PATTERNS = Object.freeze([
  'gh[pousr]_[[:alnum:]]{30,}',
  'github_pat_[[:alnum:]_]{40,}',
  'sk-[[:alnum:]_-]{20,}',
  '(sk|rk)_(live|test)_[[:alnum:]]{16,}',
  'npm_[[:alnum:]]{30,}',
  'xox[abposr]-[[:alnum:]-]{10,}',
  '(akia|asia)[[:alnum:]]{16}',
  'aiza[[:alnum:]_-]{30,}',
  'eyj[[:alnum:]_-]{10,}\\.[[:alnum:]_-]{10,}\\.[[:alnum:]_-]{5,}',
  'bearer[[:space:]]+[[:alnum:]._~+/=-]{20,}',
  '-----begin[^-]{0,40}private[[:space:]]key',
  '(password|passwd|passphrase|pwd|secret|api[_-]?key|access[_-]?key|client[_-]?secret)=[^&[:space:]]{4,}',
  '(password|passwd|passphrase)"?[[:space:]]*:[[:space:]]*"?[^[:space:]"]{4,}',
  '--(password|passwd|token|secret|api-key)[[:space:]]+[^-[:space:]][^[:space:]]{3,}',
  '(^|[^[:alnum:]#./:-])[0-9]{6,8}([^[:alnum:]./-]|$)',
]);

/**
 * URL query parameters whose VALUE is a secret whatever it looks like — an
 * OAuth `code`, an `access_token`, a presigned URL's signature. Compared
 * case-insensitively against the parameter's name.
 */
export const SECRET_QUERY_KEYS = Object.freeze([
  'token',
  'access_token',
  'id_token',
  'refresh_token',
  'auth_token',
  'code',
  'otp',
  'password',
  'passwd',
  'pwd',
  'secret',
  'client_secret',
  'api_key',
  'apikey',
  'key',
  'sig',
  'signature',
  'x-amz-signature',
  'x-amz-credential',
  'x-amz-security-token',
  'session',
  'sessionid',
]);

/** What a redacted value becomes, everywhere. */
export const REDACTED = '[redacted]';

/**
 * One ERE from `SECRET_PATTERNS` as a JavaScript RegExp. The POSIX classes
 * become JavaScript's, everything else is already the same syntax.
 * @param {string} ere
 * @param {string} [flags]
 * @returns {RegExp}
 */
export function secretRegExp(ere, flags = 'i') {
  return new RegExp(ere.replaceAll('[:alnum:]', 'A-Za-z0-9').replaceAll('[:space:]', '\\s'), flags);
}

/** @type {RegExp[]|null} */
let compiled = null;
/** @returns {RegExp[]} */
function patterns() {
  compiled ??= SECRET_PATTERNS.map((ere) => secretRegExp(ere, 'gi'));
  return compiled;
}

/**
 * The query parameters of a URL-shaped value whose values are secrets, or []
 * — never throws on a value that is not a URL.
 * @param {string} text
 * @returns {string[]}
 */
function secretQueryValues(text) {
  const found = [];
  for (const match of String(text).matchAll(/[?&#]([^=&#\s]+)=([^&#\s]+)/g)) {
    const name = decodeSafe(match[1]).toLowerCase();
    if (/** @type {readonly string[]} */ (SECRET_QUERY_KEYS).includes(name) && match[2]) found.push(match[2]);
  }
  return found;
}

/** @param {string} s */
function decodeSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Does `value` carry anything secret-shaped — a token, a password, a one-time
 * code, or a URL query secret? The door's question (`phase-outcome.sh` asks
 * the same one in bash).
 * @param {unknown} value
 * @returns {boolean}
 */
export function looksLikeSecret(value) {
  const text = String(value ?? '');
  if (!text) return false;
  if (secretQueryValues(text).length) return true;
  return patterns().some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}

/**
 * `text` with every secret-shaped run replaced by `REDACTED` — what each of
 * the five sinks (the ledger, a journal line, a push payload, the log, a
 * transcript) writes instead of the value. A URL query secret keeps its
 * parameter name and loses its value, so the link still says what it was.
 * `codes: false` leaves a standalone 6–8 digit number alone — the transcript
 * sink's choice for text that is not a declaration, where such a number is far
 * more often a count than a code.
 * @param {unknown} value
 * @param {{codes?: boolean}} [opts]
 * @returns {string}
 */
export function redactSecrets(value, opts = {}) {
  let text = String(value ?? '');
  if (!text) return text;
  text = text.replace(/([?&#])([^=&#\s]+)=([^&#\s]+)/g, (whole, sep, name, val) =>
    /** @type {readonly string[]} */ (SECRET_QUERY_KEYS).includes(decodeSafe(name).toLowerCase()) && val
      ? `${sep}${name}=${REDACTED}`
      : whole,
  );
  patterns().forEach((re, index) => {
    re.lastIndex = 0;
    const ere = SECRET_PATTERNS[index];
    // A PEM header means the key body follows: nothing after it is kept.
    if (ere.startsWith('-----begin')) {
      const at = text.search(secretRegExp(ere));
      if (at >= 0) text = `${text.slice(0, at)}${REDACTED}`;
      return;
    }
    // The standalone code carries its boundary characters in the match; only
    // the digits go.
    const code = ere.includes('[0-9]{6,8}');
    if (code && opts.codes === false) return;
    text = text.replace(re, (whole) => (code ? whole.replace(/[0-9]{6,8}/, REDACTED) : REDACTED));
  });
  return text;
}

/**
 * Is `url` one a step may open? `http` and `https` only — a `file:`,
 * `javascript:` or custom-scheme link is refused at the door (41 §5) and never
 * reaches a device.
 * @param {unknown} url
 * @returns {boolean}
 */
export function isOpenableUrl(url) {
  // The screen reads the value as given: `trim()` would drop a BOM or a
  // vertical tab at either end before anything looked for one.
  const raw = String(url ?? '');
  return !HIDDEN_CHARS_RE.test(raw) && /^https?:\/\/[^\s/?#]+[^\s]*$/i.test(raw.trim());
}

/**
 * A character a reader cannot see, or one that changes the direction the rest
 * of a line is drawn in (control-tower phase 141, #217): the C0 and C1 controls
 * but a tab, the zero-width space, the bidi embeddings, overrides and isolates,
 * the word joiner and invisible operators, and a byte-order mark. A link or a
 * guide line holding one shows a person something other than what opens or
 * runs, so neither may carry one. The joiners and the direction MARKS
 * (U+200C–U+200F) stay: Persian is written with the non-joiner, and a mark
 * reorders nothing a reader cannot see.
 */
export const HIDDEN_CHARS_RE =
  // eslint-disable-next-line no-control-regex -- the controls are exactly what it refuses
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;

/**
 * A device code's shape: short, upper-case letters and digits, one optional
 * dash (`ABCD-1234`, `FJ4ZK7QXC`). The ONE code a step carries on purpose — it
 * is useless without the person's own signed-in browser, it expires in
 * minutes, and showing it (the push included) is the whole point of the kind.
 */
export const DEVICE_CODE_RE = /^[A-Z0-9]{4,9}(-[A-Z0-9]{4,9})?$/;

/**
 * The interactive sign-in commands the console's guard knows (phase 44). In a
 * `-p` session each hangs on a browser or a prompt nobody sees, so a Bash call
 * that starts with one is a human step, not a command. The bash twin keeps
 * them `|`-separated, because every one of them contains a space.
 */
export const SIGN_IN_SHAPES = Object.freeze([
  'gh auth login',
  'gh auth refresh',
  'glab auth login',
  'npm login',
  'npm adduser',
  'pnpm login',
  'yarn npm login',
  'gcloud auth login',
  'gcloud auth application-default login',
  'az login',
  'aws sso login',
  'aws configure sso',
  'vercel login',
  'netlify login',
  'firebase login',
  'heroku login',
  'fly auth login',
  'flyctl auth login',
  'wrangler login',
  'docker login',
  'claude login',
  'claude setup-token',
  'op signin',
  'doctl auth init',
  'supabase login',
  'railway login',
  'stripe login',
  'yarn login',
  'terraform login',
  'huggingface-cli login',
  'gcloud init',
  'eas login',
  'expo login',
]);

/**
 * The flags that make a sign-in shape read its credential WITHOUT a person —
 * from stdin, a file, the environment or a machine identity — so the call
 * cannot hang and the guard lets it run (`gh auth login --with-token <
 * token.txt`, `docker login --password-stdin`, `az login --identity`). A flag
 * is matched as a whole word, `--flag` or `--flag=value`. The console's alone:
 * no bash reader asks, so there is no twin.
 */
export const SIGN_IN_UNATTENDED = Object.freeze([
  '--with-token',
  '--password-stdin',
  '--identity',
  '--service-principal',
  '--federated-token',
  '--cred-file',
  '--token',
  '--access-token',
  '--api-key',
]);

/**
 * What each sign-in shape is as a person's turn: its kind, and the tool's own
 * status verb as a `cmd:` proof — only where that verb exits non-zero while
 * signed out AND the console's command judge (`runner/verify.ts`
 * `judgeCommand`) runs its tool, because a proof the watch refuses could never
 * prove the step. A shape with no proof names none, and a person's *I did it*
 * proves it. Keyed by exactly `SIGN_IN_SHAPES` (`human-step-guard.test.ts`
 * holds the two together, and every proof to the judge), so the guard's denial
 * can always name the step to declare instead.
 * @type {Readonly<Record<string, Readonly<{kind: HumanStepKind, proof?: string}>>>}
 */
export const SIGN_IN_STEPS = Object.freeze({
  'gh auth login': signInStep('browser-login', 'gh auth status'),
  'gh auth refresh': signInStep('browser-login', 'gh auth status'),
  'glab auth login': signInStep('browser-login'),
  'npm login': signInStep('browser-login', 'npm whoami'),
  'npm adduser': signInStep('browser-login', 'npm whoami'),
  'pnpm login': signInStep('browser-login', 'pnpm whoami'),
  'yarn npm login': signInStep('browser-login', 'yarn npm whoami'),
  'gcloud auth login': signInStep('browser-login'),
  'gcloud auth application-default login': signInStep('browser-login'),
  'az login': signInStep('browser-login'),
  'aws sso login': signInStep('browser-login'),
  'aws configure sso': signInStep('browser-login'),
  'vercel login': signInStep('browser-login'),
  'netlify login': signInStep('browser-login'),
  'firebase login': signInStep('browser-login'),
  'heroku login': signInStep('browser-login'),
  'fly auth login': signInStep('browser-login'),
  'flyctl auth login': signInStep('browser-login'),
  'wrangler login': signInStep('browser-login'),
  'docker login': signInStep('browser-login'),
  'claude login': signInStep('claude-login'),
  'claude setup-token': signInStep('claude-login'),
  'op signin': signInStep('os-prompt'),
  'doctl auth init': signInStep('interactive-prompt'),
  'supabase login': signInStep('browser-login'),
  'railway login': signInStep('browser-login'),
  'stripe login': signInStep('browser-login'),
  'yarn login': signInStep('interactive-prompt'),
  'terraform login': signInStep('browser-login'),
  'huggingface-cli login': signInStep('interactive-prompt'),
  'gcloud init': signInStep('browser-login'),
  'eas login': signInStep('interactive-prompt'),
  'expo login': signInStep('interactive-prompt'),
});

/**
 * @param {HumanStepKind} kind
 * @param {string} [status] the tool's status verb, run as the `cmd:` proof
 */
function signInStep(kind, status) {
  return Object.freeze(status ? { kind, proof: `cmd:"${status}"` } : { kind });
}

/* ------------------------------------------------------------------ *
 * The stall reading — a silent lane waiting on a URL (phase 44)
 * ------------------------------------------------------------------ */

/**
 * The WAITING WORDS the stall reading keys on, as JavaScript RegExp sources
 * matched case-insensitively: a lane that went silent with an http(s) link AND
 * one of these in its last output is read as a SUSPECTED human step — offered
 * to a person for conversion, never converted or opened by itself. Tight on
 * purpose: a link alone is every test log, and "waiting for" alone is every
 * server start. Each phrase is what a sign-in, a device flow, a mailbox or an
 * approval prints while it waits for a person.
 */
export const SUSPECT_WAIT_WORDS = Object.freeze([
  'waiting for (?:you|your|authenti[a-z]*|authori[sz]ation|approval|confirmation|log ?in|sign[- ]?in|the browser|browser|verification)',
  'press (?:enter|return)\\b[^\\n]{0,20}\\b(?:open|browser|continue)',
  '(?:enter|type|input|use|paste) (?:(?:the|this|your|a) (?:[a-z-]+ )?|(?:one[- ]time|device|verification|confirmation|user|pairing|authori[sz]ation) )code\\b',
  '(?:^|[.!:;>\\n]\\s*|please |to )(?:log ?in|sign ?in|authenticate|authori[sz]e)\\b[^\\n]{0,30}\\b(?:at|on|via|visit|by visiting)\\s*:?\\s*https?://',
  '(?:url|link) (?:below|above) to (?:log ?in|sign ?in|authenticate|authori[sz]e)',
  'complete (?:the |your )?(?:sign[- ]?in|log ?in|authentication|authori[sz]ation|verification|captcha)',
  'check your (?:e-?mail|inbox)',
  '(?:your|the) (?:one[- ]time )?device (?:confirmation |activation |verification )?code',
]);

/**
 * The weaker half: words that say OPEN THIS LINK without saying anything waits.
 * They count only for a link that is not the machine's own loopback — "open
 * http://localhost:5173 in your browser" is a dev server, while "open this URL
 * in your web browser: https://github.com/login/device" is a sign-in.
 */
export const SUSPECT_OPEN_WORDS = Object.freeze([
  'open (?:this|the following|the) (?:url|link|page)',
  '(?:open(?:ing)?|visit|go to|navigate to|paste)\\b[^\\n]{0,60}\\b(?:in|into|with) (?:your|a|the) (?:default |web )?browser',
]);

/* ------------------------------------------------------------------ *
 * The folds — the hand-built cards that draw as this family (phase 44)
 * ------------------------------------------------------------------ */

/**
 * The cards the console built by hand before this family existed, and the kind
 * each is drawn as now. Every one gains a `humanStep` view (`humanStepView`)
 * on its inbox row, so the client draws ONE card for all of them; the card's
 * own actions stay what answers it. `person-check` is the verification card (a
 * §Verification only eyes can do), `plan-approval` the plan a plan-mode phase
 * presented (#34), `protected-path` phase 39's wall on `.claude/**`.
 *
 * Widened by control-tower phase 132 (#209) to every row Your turn folds: a
 * person `errand` is an `operator-act`, the approval broker's ask a
 * `permission`, a branch `conflict` a `decision`, the `supervisor`'s
 * escalation an `operator-act`, and the `stall` reading an `operator-act`
 * until its suspected kind is known (`server/turn/fold.ts`).
 * @type {Readonly<Record<string, HumanStepKind>>}
 */
export const HUMAN_STEP_FOLDS = Object.freeze({
  'sign-in': 'claude-login',
  'mcp-auth': 'mcp-login',
  'person-check': 'person-check',
  'plan-approval': 'decision',
  gate: 'decision',
  question: 'decision',
  qa: 'decision',
  'protected-path': 'protected-path',
  errand: 'operator-act',
  approval: 'permission',
  conflict: 'decision',
  supervisor: 'operator-act',
  stall: 'operator-act',
});

/** @typedef {keyof typeof HUMAN_STEP_FOLDS} HumanStepFold */

/**
 * What a step's card offers, in the order a card lays them out: open the link,
 * run the command in the embedded terminal, answer (a decision or a check by
 * eye), apply the patch by hand, open an interactive session here, check the
 * proof, or — a suspected step — make it a person's turn.
 * @typedef {(typeof HUMAN_STEP_OFFERS)[number]} HumanStepOffer
 */
export const HUMAN_STEP_OFFERS = Object.freeze(
  /** @type {const} */ (['open', 'terminal', 'answer', 'patch', 'interactive-session', 'check', 'convert']),
);

/**
 * The settings pane an `os-permission` step sends a person to, by the words
 * the step uses (macOS System Settings, the platform the console runs on; a
 * Linux desktop names its own). The first match wins; none names the Privacy
 * & Security pane, which is where every other grant lives.
 */
export const OS_PERMISSION_PANES = Object.freeze([
  paneFor('screen (?:recording|capture|sharing)', 'Privacy & Security › Screen & System Audio Recording'),
  paneFor('full[- ]disk', 'Privacy & Security › Full Disk Access'),
  paneFor('accessibility', 'Privacy & Security › Accessibility'),
  paneFor('input monitoring|keystroke', 'Privacy & Security › Input Monitoring'),
  paneFor('automation|apple ?events|control (?:another|other) app', 'Privacy & Security › Automation'),
  paneFor('developer tools', 'Privacy & Security › Developer Tools'),
  paneFor('local network', 'Privacy & Security › Local Network'),
  paneFor('camera', 'Privacy & Security › Camera'),
  paneFor('microphone', 'Privacy & Security › Microphone'),
  paneFor('incoming (?:network )?connection|firewall', 'Network › Firewall'),
  paneFor('login item|background item', 'General › Login Items & Extensions'),
]);

/** The pane an `os-permission` step names when its words match none above. */
export const OS_PERMISSION_PANE_DEFAULT = 'System Settings › Privacy & Security';

/**
 * @param {string} match
 * @param {string} pane
 */
function paneFor(match, pane) {
  return Object.freeze({ match, pane: `System Settings › ${pane}` });
}

/**
 * The settings pane an `os-permission` step's words name.
 * @param {unknown} text
 * @returns {string}
 */
export function settingsPaneFor(text) {
  const words = String(text ?? '');
  return (
    OS_PERMISSION_PANES.find((entry) => new RegExp(entry.match, 'i').test(words))?.pane ??
    OS_PERMISSION_PANE_DEFAULT
  );
}

/**
 * One card of the family, whatever raised it — a ledger step, a folded card,
 * or a suspected step — as the client draws it (phase 42 draws ONE card from
 * this). Every field is already safe to show: the caller passes redacted
 * words, and a link is kept only when it is http(s).
 * @typedef {{
 *   kind: HumanStepKind,
 *   label: string,
 *   icon: string,
 *   title: string,
 *   where: HumanStepWhere,
 *   state: HumanStepState,
 *   fold: HumanStepFold | null,
 *   lines: string[],
 *   proof: string,
 *   offers: HumanStepOffer[],
 *   stepId?: string,
 *   suspected?: true,
 *   openUrl?: string,
 *   openCommand?: string,
 *   qr?: string,
 *   code?: string,
 *   act?: string,
 *   path?: string,
 *   dueWhen?: string,
 * }} HumanStepView
 */

/**
 * @typedef {{
 *   kind: string,
 *   title?: string,
 *   where?: string,
 *   state?: string,
 *   fold?: HumanStepFold | null,
 *   lines?: readonly (string | null | undefined | false)[],
 *   proof?: string,
 *   stepId?: string,
 *   suspected?: boolean,
 *   openUrl?: string,
 *   openCommand?: string,
 *   code?: string,
 *   act?: string,
 *   path?: string,
 *   answer?: boolean,
 *   check?: boolean,
 *   dueWhen?: string,
 * }} HumanStepViewInput
 */

/**
 * Build the one view. What `KIND_META` alone would not carry is added here: an
 * `os-permission` step always NAMES its settings pane in its lines, and a
 * `physical` step whose open value is a link carries it as `qr` — a phone
 * scans it at the device. A `protected-path` step carries the act and the path
 * the session named, and offers the patch by hand or an interactive session.
 * An unknown kind reads as `decision`, the family's catch-all.
 * @param {HumanStepViewInput} input
 * @returns {HumanStepView}
 */
export function humanStepView(input) {
  const kind = humanStepKindOf(input.kind) ?? 'decision';
  const meta = KIND_META[kind];
  const lines = (input.lines ?? [])
    .filter((line) => typeof line === 'string' && line.trim())
    .map((line) => String(line).trim());
  if (kind === 'os-permission') {
    const pane = settingsPaneFor([input.title, ...lines].join(' '));
    if (!lines.some((line) => line.includes(pane))) lines.push(`Open ${pane}, and grant it there.`);
  }
  const where = /** @type {readonly string[]} */ (HUMAN_STEP_WHERE).includes(String(input.where))
    ? /** @type {HumanStepWhere} */ (input.where)
    : meta.where;
  const state = /** @type {readonly string[]} */ (HUMAN_STEP_STATES).includes(String(input.state))
    ? /** @type {HumanStepState} */ (input.state)
    : 'notified';
  const openUrl = isOpenableUrl(input.openUrl) ? String(input.openUrl).trim() : undefined;
  const openCommand =
    typeof input.openCommand === 'string' && input.openCommand.trim() ? input.openCommand.trim() : undefined;
  /** @type {HumanStepOffer[]} */
  const offers = [];
  if (openUrl) offers.push('open');
  if (openCommand) offers.push('terminal');
  if (input.answer || kind === 'person-check' || kind === 'decision') offers.push('answer');
  if (kind === 'protected-path') offers.push('patch', 'interactive-session');
  if (input.check) offers.push('check');
  if (input.suspected) offers.push('convert');
  /** @type {HumanStepView} */
  const view = {
    kind,
    label: meta.label,
    icon: meta.icon,
    title: String(input.title ?? '').trim() || meta.label,
    where,
    state,
    fold: input.fold ?? null,
    lines,
    proof: String(input.proof ?? '').trim() || meta.proof,
    offers,
  };
  if (input.stepId) view.stepId = input.stepId;
  if (input.suspected) view.suspected = true;
  if (openUrl) view.openUrl = openUrl;
  if (openCommand) view.openCommand = openCommand;
  if (kind === 'physical' && openUrl) view.qr = openUrl;
  if (kind === 'device-code' && input.code && DEVICE_CODE_RE.test(input.code)) view.code = input.code;
  if (kind === 'protected-path') {
    if (input.act) view.act = input.act;
    if (input.path) view.path = input.path;
  }
  // What an `upcoming` step waits on before it is due (control-tower phase 121).
  if (typeof input.dueWhen === 'string' && input.dueWhen.trim()) view.dueWhen = input.dueWhen.trim();
  return view;
}

/**
 * A credential registry id — what a `secret-entry` step stores its secret
 * under (the keychain service `phase-console-<id>`, else a 0600 file).
 */
export const CREDENTIAL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
