/**
 * The words for an issue a SESSION wants filed — before anything can file one.
 *
 * A session that finds a real defect outside its phase's scope has, today, one
 * place to put it: a sentence in its handoff, which nothing reads. The estate
 * has a repository page and `gh` is signed in, so the missing piece is not
 * capability but restraint — an unattended session that can open issues will
 * open the same one four times from four phases. Everything that restraint is
 * made of is a word, and the words are here: what a session may ask for, what
 * the console may be doing about it, what it costs, what kind of issue it is
 * and how bad (control-tower phase 114), and what makes two drafts the same
 * issue.
 *
 * `scripts/issues.env` is the bash twin (the F5 pattern, like `gates.env`);
 * `viewer/test/gates-vocab.test.ts` asks bash for every list below and holds it
 * to these word for word.
 *
 * ⚠️ Data only, no imports — the client bundles this module and `node --test`
 * imports it directly. `test/vocab-owners.test.ts` registers every list.
 *
 * FREE, not Pro (decision 19): the filing engine is Pro and arrives in phase
 * 12; `phase-graph.sh --issues` reads these words and the free tree ships it.
 */

/* ------------------------------------------------------------------ *
 * What a plan allows
 * ------------------------------------------------------------------ */

// How far a plan lets its sessions go (`off | draft | file`), its default, and the
// operator's draft scope live in `issue-modes.js` — the words first paint reads,
// kept apart so the rest of this model stays out of it (phase 123).
import { DEFAULT_ISSUES, ISSUE_MODES, OPERATOR_ISSUE_SCOPE } from './issue-modes.js';

export { DEFAULT_ISSUES, ISSUE_MODES, OPERATOR_ISSUE_SCOPE };

/** @typedef {(typeof ISSUE_MODES)[number]} IssueMode */

/**
 * What each issues word is CALLED, decided once (phase 15) — the launch
 * form's picker and its review row, which is to say a RUN's word. A run's
 * `off` is stored as no word at all (phase 15), so it says nothing of its own
 * and the console's own setting decides (control-tower phase 115); to keep one
 * run from filing anything, launch it at `draft`.
 * @type {Readonly<Record<IssueMode, string>>}
 */
export const ISSUE_MODE_LABELS = Object.freeze({
  off: 'Off — no word for this run: the console’s own setting decides',
  draft: 'Draft — the console holds it in the inbox for a person to approve',
  file: 'File — the console files it at once, inside the budgets',
});


/**
 * What a session may ask for. `close` is deliberately in the list and
 * deliberately the one the console holds longest: a phase that believes it
 * fixed something has not proved it until its work has LANDED, so a close is
 * held until the landing ledger says so.
 * @typedef {(typeof ISSUE_ACTIONS)[number]} IssueAction
 */
export const ISSUE_ACTIONS = Object.freeze(/** @type {const} */ (['file', 'comment', 'close']));

/**
 * Where a draft has got to. Eleven states because each one is a different thing
 * for a person to do — and because "it did not appear on GitHub" has five
 * distinct causes that a single `failed` would hide.
 *
 * `drafted` → `pending-approval` → `filing` → `filed` is the ordinary road.
 * `duplicate` is the fingerprint already seen; `discarded` a person's No;
 * `over-budget` the cap, which is a refusal the SESSION should learn about
 * and not a failure of the issue. `pending-landing` (phase 12) is the one
 * hold with a clock of its own: a `close` whose phase has not LANDED yet — a
 * fix a session believes in is not a fix until it is on the branch that
 * matters — and it moves to `pending-approval` by itself the moment the
 * landing ledger says so.
 * @typedef {(typeof ISSUE_STATES)[number]} IssueState
 */
export const ISSUE_STATES = Object.freeze(
  /** @type {const} */ ([
    'drafted',
    'duplicate',
    'pending-landing',
    'pending-approval',
    'filing',
    'filed',
    'commented',
    'closed',
    'discarded',
    'over-budget',
    'failed',
  ]),
);

/**
 * Three per phase — and one suggestion.
 *
 * Small on purpose. A phase with four things to report has found a class of
 * problem, and a class of problem is one issue with four bullets — which is
 * also the issue a person can act on. The budget is what turns the second
 * shape into the first. Since control-tower phase 114 a draft past it is HELD
 * for a person (`pending-approval`, the reason named), never dropped: the
 * budget tells the session to fold, it does not lose what the session found.
 *
 * `suggestion` is the one improvement suggestion a phase may make, beside its
 * three problems and never out of them (phase 114, operator decision 16).
 *
 * `dailyFilings` is the CONSOLE's rate, not a session's budget (control-tower
 * phase 115): how many issues and comments a console files BY ITSELF in any 24
 * hours. It replaced the per-run cap of ten, which dropped what came after it;
 * a draft over the rate is held and filed in order when the rate allows, and a
 * person's Approve never counts against it.
 *
 * The OPERATOR door has meters of its own (control-tower phase 12, #30): one
 * draft per ticket — an investigation that files four issues was not asked
 * to — and ten a day across every ticket, counted by the UTC date the draft
 * was written. A phase and a run are the wrong meters for a person's button.
 */
export const ISSUE_BUDGETS = Object.freeze({
  phase: 3,
  suggestion: 1,
  ticket: 1,
  operatorDay: 10,
  dailyFilings: 20,
});

/* ------------------------------------------------------------------ *
 * What a draft IS, and how bad (control-tower phase 114)
 * ------------------------------------------------------------------ */

/**
 * The kind of issue a draft is — GitHub's own three default type labels, so a
 * filed issue lands under a label every repository already has.
 *
 * `bug`           — something is wrong: it does not do what it says.
 * `enhancement`   — something could be better: it works, and could do more.
 * `documentation` — something is said wrong: the words, not the code.
 * @typedef {(typeof ISSUE_TYPES)[number]} IssueType
 */
export const ISSUE_TYPES = Object.freeze(/** @type {const} */ (['bug', 'enhancement', 'documentation']));

/**
 * How bad it is, worst first — the rubric of §Architecture 18. A session
 * chooses by the meanings below and never by how annoyed it is.
 * @typedef {(typeof ISSUE_SEVERITIES)[number]} IssueSeverity
 */
export const ISSUE_SEVERITIES = Object.freeze(/** @type {const} */ (['critical', 'high', 'medium', 'low']));

/**
 * Each severity's one-line meaning — the rubric itself. `scripts/issues.env`
 * carries it as `ISSUE_SEVERITY_RUBRIC` (`level=meaning|…`), which is what the
 * script prints when a bug names no severity, so a meaning may hold neither
 * `|` nor `=`.
 * @type {Readonly<Record<IssueSeverity, string>>}
 */
export const ISSUE_SEVERITY_MEANINGS = Object.freeze({
  critical:
    'data loss, a security or permission bypass, an unapproved production change, or every lane blocked',
  high: 'a run halts or parks, or reaches a wrong verdict, with no in-run workaround',
  medium: 'time or money wasted, a workaround exists',
  low: 'cosmetic, wording, noise',
});

/** The severity a draft carries when it names none — never a bug's: a bug must say. */
export const DEFAULT_ISSUE_SEVERITY = 'low';

/** The types whose drafts must name a severity: a bug is the one a person triages by it. */
export const ISSUE_SEVERITY_REQUIRED_FOR = Object.freeze(/** @type {const} */ (['bug']));

/**
 * The lifecycle labels a session-filed issue carries beside its type and its
 * severity: `awaiting-plan` until a plan takes it (then `plan:<slug>`, by the
 * amendment that plans it — `references/conventions.md` §Issues), and
 * `from-session`, because a console filed it. Never `phase-console` or the bare
 * plan slug: they exist on no repository.
 */
export const ISSUE_LABELS = Object.freeze(/** @type {const} */ (['awaiting-plan', 'from-session']));

/** A severity's label is the level under this prefix: `severity:high`. */
export const ISSUE_SEVERITY_LABEL_PREFIX = 'severity:';

/**
 * The label a severity is filed under.
 * @param {string} level
 */
export function issueSeverityLabel(level) {
  return `${ISSUE_SEVERITY_LABEL_PREFIX}${level}`;
}

/** What a suggestion always is: an improvement, never a defect report. */
export const SUGGESTION_TYPE = 'enhancement';

/**
 * Whether a console takes suggestions — the words of `PE_ISSUES_SUGGEST`,
 * which Settings ▸ Issues ▸ "Also file improvement suggestions" drives.
 */
export const ISSUE_SUGGEST_WORDS = Object.freeze(/** @type {const} */ (['off', 'on']));

/** Off until a person turns it on (operator decision 16). */
export const DEFAULT_ISSUE_SUGGEST = 'off';

/**
 * The word `--repo` takes to mean "the repository `--where` lives in": the
 * longest estate key that prefixes the path, and the path made relative to it.
 */
export const ISSUE_REPO_AUTO = 'auto';

/** The estate key of the docs root itself — what `--repo auto` falls back to. */
export const ROOT_REPO_KEY = 'root';

/**
 * The repository KEY that names the console's OWN repository rather than one
 * of the plan's (control-tower phase 101, #145 D): the supervisor drafts the
 * console's defects there, through the same ledger, dedupe and approval a
 * session's draft takes. Never a submodule path, so it can never shadow one.
 */
export const CONSOLE_REPO_KEY = 'console';

/**
 * The fields a session's draft carries. `number` is empty for `file` and
 * required for `comment`/`close`; `type`, `severity` and `suggestion` ride a
 * `file` draft only (control-tower phase 114 — on the ledger line the type is
 * `issue_type`, because `type` is the line's own discriminator).
 */
export const ISSUE_FIELDS = Object.freeze(
  /** @type {const} */ ([
    'action',
    'title',
    'body',
    'labels',
    'type',
    'severity',
    'suggestion',
    'repo',
    'number',
  ]),
);

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

/** FNV-1a, 32 bits, seeded — not cryptographic, and never asked to be. */
function fnv1a(text, seed) {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i) & 0xff;
    // The FNV prime, 16777619, multiplied without losing the low bits to a float.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A title as the dedupe reads it: case folded, whitespace collapsed, and the
 * punctuation a rewording adds at the edges dropped — `Phase-lock.sh drops
 * the lease!` and `phase-lock.sh drops the lease` are one finding. The ONE
 * rule, used by `issueFingerprint` below and by the engine's match against
 * the cached estate, so a title dedupes the same way against a draft and
 * against an issue (phase 12).
 *
 * @param {string | undefined} title
 */
export function normaliseIssueTitle(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?:;,\s]+$/, '');
}

/**
 * What makes two drafts the SAME issue: the repository, the action and the
 * title — never the body.
 *
 * The body is excluded because the thing being deduplicated is a session's
 * rewording. Two phases that trip over one broken lock will describe it at
 * different lengths with different stack traces and mean one issue; if the
 * body counted, the dedupe would catch none of them, which is the failure the
 * budget alone cannot prevent. The cost of the choice is the opposite error —
 * two genuinely different findings under one title collapse into one — and
 * that one is visible (a person reads the draft) where the other is not.
 *
 * Twelve hex characters, the shape a ruling id already uses, so the two read
 * alike in a journal line.
 *
 * @param {{ repo?: string, action?: string, title?: string }} draft
 */
export function issueFingerprint(draft) {
  const identity = [draft?.repo ?? '', draft?.action ?? '']
    .map((part) => String(part).trim().toLowerCase().replace(/\s+/g, ' '))
    .concat(normaliseIssueTitle(draft?.title))
    .join('');
  const a = fnv1a(identity, 0x811c9dc5);
  const b = fnv1a(identity, 0x01000193);
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0').slice(0, 4);
}

/* ------------------------------------------------------------------ *
 * What the Issues desk reads off an issue (control-tower phase 118)
 * ------------------------------------------------------------------ */

/**
 * What KIND of issue it is: GitHub's three default type labels (the ones a
 * session files under, `ISSUE_TYPES`), GitHub's `question`, and `other` for an
 * issue that carries none of them. In this order, which is also the order a
 * label set is read in — an issue labelled both `bug` and `enhancement` is a
 * bug — and the order the desk sorts by.
 * @typedef {(typeof ISSUE_CATEGORIES)[number]} IssueCategory
 */
export const ISSUE_CATEGORIES = Object.freeze(
  /** @type {const} */ (['bug', 'enhancement', 'documentation', 'question', 'other']),
);

/**
 * The severities a desk can read: the rubric's four, worst first, then `none`
 * for an issue that carries no `severity:` label — a person filed it, or nobody
 * has triaged it yet. Never a guess.
 * @typedef {(typeof ISSUE_SEVERITY_WORDS)[number]} IssueSeverityWord
 */
export const ISSUE_SEVERITY_WORDS = Object.freeze(
  /** @type {const} */ (['critical', 'high', 'medium', 'low', 'none']),
);

/**
 * Where an issue stands in a plan, read off its labels and its state:
 *
 * `needs-plan` — it carries `awaiting-plan` and no plan has taken it;
 * `planned`    — it carries `plan:<slug>` (and, where the local plan names it
 *                on a phase's `Fixes:` line, that phase);
 * `deferred`   — it carries `plan:<slug>-deferred`;
 * `fixed`      — it is CLOSED and names its fix: a `plan:<slug>` label;
 * `none`       — none of these. An open issue nobody triaged, or a closed one
 *                that names no fix: closed is not the same claim as fixed.
 * @typedef {(typeof ISSUE_PLAN_STATES)[number]} IssuePlanState
 */
export const ISSUE_PLAN_STATES = Object.freeze(
  /** @type {const} */ (['needs-plan', 'planned', 'deferred', 'fixed', 'none']),
);

/** A plan takes an issue under this prefix (`references/conventions.md` §Issues). */
export const PLAN_LABEL_PREFIX = 'plan:';

/** …and defers one under the same label with this suffix. */
export const DEFERRED_LABEL_SUFFIX = '-deferred';


/** The lifecycle label an issue carries until a plan takes it — `ISSUE_LABELS`' first. */
const AWAITING_PLAN = ISSUE_LABELS[0];

/** A label as it is compared: GitHub keeps the case a person typed, and `Bug` is a bug. */
const fold = (/** @type {unknown} */ label) =>
  String(label ?? '')
    .trim()
    .toLowerCase();

/**
 * The category a label set reads as.
 * @param {readonly string[] | undefined} labels
 * @returns {IssueCategory}
 */
export function categoryOf(labels) {
  const have = new Set((labels ?? []).map(fold));
  return ISSUE_CATEGORIES.find((category) => category !== 'other' && have.has(category)) ?? 'other';
}

/**
 * The severity a label set reads as: a `severity:<level>` label whose level the
 * rubric knows, the worst of them when there are several, else `none`.
 * @param {readonly string[] | undefined} labels
 * @returns {IssueSeverityWord}
 */
export function severityOf(labels) {
  const levels = new Set(
    (labels ?? [])
      .map(fold)
      .filter((label) => label.startsWith(ISSUE_SEVERITY_LABEL_PREFIX))
      .map((label) => label.slice(ISSUE_SEVERITY_LABEL_PREFIX.length).trim()),
  );
  return ISSUE_SEVERITIES.find((level) => levels.has(level)) ?? 'none';
}

/**
 * The `#n` numbers a phase's `Fixes:` line names, once each, in order. A bare
 * number ("phase 19") is not an issue: only `#` makes one.
 * @param {string | undefined} text
 * @returns {number[]}
 */
export function fixesNumbers(text) {
  /** @type {number[]} */
  const out = [];
  for (const match of String(text ?? '').matchAll(/#(\d{1,9})\b/g)) {
    const number = Number(match[1]);
    if (number > 0 && !out.includes(number)) out.push(number);
  }
  return out;
}

/**
 * @typedef {{ state: IssuePlanState, slug?: string, phases?: number[] }} IssuePlan
 * @typedef {(slug: string, number: number) => readonly number[] | undefined} FixesLookup
 */

/**
 * Where an issue stands in a plan.
 *
 * `fixesOf` answers which phases of a LOCAL plan name the issue on their
 * `Fixes:` line — the console reads its own plans for it; without one, or for a
 * plan this console cannot read, a planned issue still names its plan, just not
 * the phase. A plan label outranks `awaiting-plan`, because the amendment that
 * plans an issue is what relabels it, and a non-deferred plan label outranks a
 * deferred one.
 * @param {{ number?: number, state?: string, labels?: readonly string[] }} issue
 * @param {FixesLookup} [fixesOf]
 * @returns {IssuePlan}
 */
export function planStateOf(issue, fixesOf) {
  const labels = (issue?.labels ?? []).map((label) => String(label ?? '').trim());
  const closed = String(issue?.state ?? '').toUpperCase() === 'CLOSED';
  /** @type {string | undefined} */
  let planned;
  /** @type {string | undefined} */
  let deferred;
  for (const label of labels) {
    if (!fold(label).startsWith(PLAN_LABEL_PREFIX)) continue;
    const slug = label.slice(PLAN_LABEL_PREFIX.length).trim();
    if (!slug) continue;
    if (slug.toLowerCase().endsWith(DEFERRED_LABEL_SUFFIX)) {
      deferred ??= slug.slice(0, -DEFERRED_LABEL_SUFFIX.length) || undefined;
    } else {
      planned ??= slug;
    }
  }
  /** @param {IssuePlanState} state @param {string} slug @returns {IssuePlan} */
  const withPhases = (state, slug) => {
    const phases = issue?.number ? fixesOf?.(slug, issue.number) : undefined;
    return phases?.length ? { state, slug, phases: [...phases] } : { state, slug };
  };
  if (closed) return planned ? withPhases('fixed', planned) : { state: 'none' };
  if (planned) return withPhases('planned', planned);
  if (deferred) return { state: 'deferred', slug: deferred };
  if (labels.some((label) => fold(label) === AWAITING_PLAN)) return { state: 'needs-plan' };
  return { state: 'none' };
}

/**
 * The desk's whole reading of one issue — derived here and nowhere else, so
 * the server's payload and the client's filters cannot disagree about a word.
 * @param {{ number?: number, state?: string, labels?: readonly string[] }} issue
 * @param {FixesLookup} [fixesOf]
 * @returns {{ category: IssueCategory, severity: IssueSeverityWord, plan: IssuePlan }}
 */
export function triageOf(issue, fixesOf) {
  return {
    category: categoryOf(issue?.labels),
    severity: severityOf(issue?.labels),
    plan: planStateOf(issue, fixesOf),
  };
}

/* ------------------------------------------------------------------ *
 * Repositories outside the console (control-tower phase 118)
 * ------------------------------------------------------------------ */

/**
 * How many repositories an operator may add to the desk beyond the estate —
 * `prefs.issueRepos`. Each is one `gh issue list` per refresh.
 */
export const ISSUE_REPOS_MAX = 12;

/**
 * An added repository's key. An inventory key is `root` or a root-relative
 * path, and neither ever holds a `:`, so the two cannot shadow each other.
 */
export const ADDED_REPO_KEY_PREFIX = 'github:';

/** @param {string} nameWithOwner */
export function addedRepoKey(nameWithOwner) {
  return `${ADDED_REPO_KEY_PREFIX}${nameWithOwner}`;
}

/**
 * GitHub's own `owner/name` alphabet — the gate a name passes before it can
 * reach `gh --repo` in a fixed argv. Anything else is `''`.
 * @param {unknown} value
 */
export function issueRepoName(value) {
  if (typeof value !== 'string') return '';
  const name = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(name)) return '';
  const repo = name.slice(name.indexOf('/') + 1);
  return repo === '.' || repo === '..' ? '' : name;
}

/**
 * The repositories a person added, as stored: well-formed, once each, bounded.
 * @param {unknown} value
 * @returns {string[]}
 */
export function issueReposOf(value) {
  if (!Array.isArray(value)) return [];
  /** @type {string[]} */
  const out = [];
  for (const entry of value) {
    const name = issueRepoName(entry);
    if (name && !out.some((seen) => seen.toLowerCase() === name.toLowerCase())) out.push(name);
    if (out.length >= ISSUE_REPOS_MAX) break;
  }
  return out;
}
