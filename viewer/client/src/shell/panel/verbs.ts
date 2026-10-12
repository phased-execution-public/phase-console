/**
 * The operator's verbs, as a surface offers them (§Architecture 5): the panel's
 * Actions tab and the palette's *do* section both read this.
 *
 * Every verb names a RECORD — the thing its identity is: nothing at all (the
 * console's own lists and its policy), a plan that may have no run yet, a run,
 * one phase of it, a stored trigger, a waiting permission card. The kind is
 * DERIVED from the verb's own row — its route's placeholders and the positional
 * words its CLI takes — and overridden only where that spelling under-tells the
 * target. A record's Actions tab lists exactly its kind's verbs.
 *
 * An offer is one of three. A PRESS needs nothing but its record's identity. An
 * OPEN takes more — words, an account, a decision — so it is a link to where it
 * is drawn, never a press with an empty body. A READ is a link to where it is
 * drawn. A verb whose capability flag this console lacks is offered DISABLED,
 * naming the flag, rather than hidden: a list padded with things you cannot do
 * is a list people stop reading, but a verb that vanishes is a verb nobody
 * knows exists.
 *
 * Off first paint: the registry is 1,200 lines, and only lazy chunks import it.
 */

import { OPERATOR_VERBS } from '@shared/verb-model.js';
import { CAPABILITY_WORDS } from '@shared/capability-model.js';
import { SURFACE, type SurfaceDoor, type SurfaceRow } from '@/data/surface';
import { verbLine, type VerbArgs } from '@/data/verbs';
import { bellHref, hrefOf, paletteHref, planHref, plansHref, type Route } from '../routes';

/** What a verb's identity names: the record a press acts on, or a read reads. */
export const RECORD_KINDS = ['console', 'plan', 'run', 'phase', 'trigger', 'approval'] as const;

export type RecordKind = (typeof RECORD_KINDS)[number];

/** Pressed here, opened where it is drawn because it takes more, or read where it is drawn. */
export type OfferMode = 'press' | 'open' | 'read';

/** A value of a record's identity: a slug and an id are words, a phase a number. */
type IdentityValue = string | number;

export interface VerbOffer {
  name: string;
  /** `read` answers, `act` changes something. */
  kind: 'read' | 'act';
  /** The record it names. */
  record: RecordKind;
  mode: OfferMode;
  summary: string;
  /** What an `open` verb takes beyond its record's identity, in words. */
  takes?: string;
  /** The capability flag it needs (`--allow-run`), when the console lacks it. */
  needs?: string;
  /** The identity fields the context filled. */
  identity: Readonly<Record<string, IdentityValue>>;
  /** Those the context could not: such a verb is offered by its door or its line, never pressed. */
  missing: readonly string[];
  /** The route's placeholders, filled — what `pressVerb` builds the path from. */
  args: VerbArgs;
  /**
   * What a press sends: the identity the path does not carry (a phase rides the
   * body of `retry`, a slug and a phase the body of `pin`), plus the word the
   * table cannot hand the route (`approve` and `deny` share one route).
   */
  body: Readonly<Record<string, IdentityValue>>;
  /** The terminal's spelling of it, where this tree's `phase-console run` presses it. */
  line?: string;
  /** Where the registry says a person meets it today. */
  door?: SurfaceDoor;
}

/** The flags a console has, as `/api/state` reports them (`allowRun`, …). */
export type Capabilities = Partial<Record<string, boolean | undefined>>;

interface VerbRowView {
  name: string;
  kind: 'read' | 'act';
  route: string;
  edition: string;
  cli: null | { args: readonly string[]; flags: Readonly<Record<string, string | true>> };
  summary?: string;
}

/** A verb's record, and the identity fields a press names it by. */
export interface VerbIdentity {
  record: RecordKind;
  /** In the order a line and a body name them. */
  fields: readonly string[];
}

/** A route placeholder → the identity field that fills it: `:n` is a phase, spelled short. */
const PLACEHOLDER_FIELD: Readonly<Record<string, string>> = {
  slug: 'slug',
  phase: 'phase',
  id: 'id',
  n: 'phase',
};

/** The CLI's positional words that NAME a record; any other (`accountId`) gives it a value. */
const IDENTITY_WORDS: readonly string[] = ['slug', 'phase', 'id'];

const PHASE: VerbIdentity = { record: 'phase', fields: ['slug', 'phase'] };

/**
 * Where a row's own spelling under-tells its target. The run-verb switch's rows
 * with no CLI shape read `body.phase` all the same (`server/api/routes.ts`);
 * `start` names a plan that may have no run to press yet; `status` reads the
 * console's one list for one plan; `resolve` and `unresolve` address the run
 * that raised the card by its id, which on a plan that has run since is not
 * the latest.
 */
const IDENTITY_OVERRIDES: Readonly<Record<string, VerbIdentity>> = {
  start: { record: 'plan', fields: ['slug'] },
  status: { record: 'console', fields: [] },
  resolve: { record: 'run', fields: ['slug', 'runId'] },
  unresolve: { record: 'run', fields: ['slug', 'runId'] },
  skip: PHASE,
  'verify-command': PHASE,
  'qa-recover': PHASE,
  'qa-rerun': PHASE,
  recheck: PHASE,
  closeout: PHASE,
  'isolate-phase': PHASE,
  delegate: PHASE,
  'plan-approval': PHASE,
};

/**
 * The acts that take more than their record's identity, and what a person
 * gives each. Pressed with an empty body they would be refused, or act on
 * nothing in particular — so they are offered where they are drawn.
 */
const TAKES: Readonly<Record<string, string>> = {
  steer: 'the words to send',
  ask: 'a question',
  answer: 'an answer',
  identity: 'a choice of login',
  note: 'the note',
  'switch-account': 'an account',
  trigger: 'what to wait for and what to press',
  'queue-policy': 'a policy',
  'raise-budget': 'the new budget',
  'plan-approval': 'a decision',
  'verify-command': 'the command',
  delegate: 'the words for its session',
  settings: 'the settings to change',
};

/** The flags a verb's line spells as `<word>` even unfilled: what it takes, from a terminal. */
const LINE_TEMPLATES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  wait: { '--for': 'predicate' },
  steer: { '--text': 'text' },
  note: { '--text': 'text' },
  trigger: { '--when': 'event', '--then': 'verb' },
  'queue-policy': { '--policy': 'policy' },
};

/**
 * What `approve` and `deny` cannot say by their route alone: they press the
 * same one, and the card reads the decision from the body (`bin/run-verb.mjs`).
 */
const FIXED_BODY: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  approve: { decision: 'allow' },
  deny: { decision: 'deny' },
};

/**
 * The editions whose rows this tree's `phase-console run` presses: every read
 * in both — and in Pro the acts and `wait` too. The free build's run verb reads
 * only, so a line for an act there is a line that refuses.
 */
const CLI_EDITIONS: readonly string[] = [
  'free',
];

const ROWS = OPERATOR_VERBS as readonly unknown[] as readonly VerbRowView[];

/** The placeholders of a route: `:slug`, `:phase`, `:id`, `:n`. */
function placeholdersOf(route: string): string[] {
  return [...route.matchAll(/:([a-z]+)/g)].map((m) => m[1]!);
}

/** A row's identity as its own spelling tells it. */
function derivedIdentity(row: VerbRowView): VerbIdentity {
  const named = new Set<string>();
  for (const key of placeholdersOf(row.route)) named.add(PLACEHOLDER_FIELD[key] ?? key);
  for (const word of row.cli?.args ?? []) if (IDENTITY_WORDS.includes(word)) named.add(word);
  const fields = IDENTITY_WORDS.filter((field) => named.has(field));
  const record: RecordKind = named.has('id')
    ? named.has('slug')
      ? 'trigger'
      : 'approval'
    : named.has('phase')
      ? 'phase'
      : named.has('slug')
        ? 'run'
        : 'console';
  return { record, fields };
}

/** A verb's record and the identity fields a press names it by. Throws for a name the table does not hold. */
export function verbIdentity(name: string): VerbIdentity {
  const row = ROWS.find((verb) => verb.name === name);
  if (!row) throw new Error(`No operator verb is called ${name}.`);
  return IDENTITY_OVERRIDES[name] ?? derivedIdentity(row);
}

/** Every verb of one record kind, in the table's order. */
export function verbsOf(kind: RecordKind): string[] {
  return ROWS.filter((row) => verbIdentity(row.name).record === kind).map((row) => row.name);
}

/** `--allow-run` → `allowRun`: the state's name for a flag, from the one capability table. */
function stateKeyOf(flag: string): string | null {
  const row = (CAPABILITY_WORDS as readonly { flag: string; field: string }[]).find((w) => w.flag === flag);
  return row?.field ?? null;
}

/** The flag a registry row needs, when this console lacks it. */
export function lackedFlag(
  row: Pick<SurfaceRow, 'flag'> | undefined,
  capabilities: Capabilities | undefined,
) {
  if (!row?.flag) return undefined;
  const key = stateKeyOf(row.flag);
  return key && capabilities?.[key] !== true ? row.flag : undefined;
}

/** A context's value for an identity field: a phase is a number, whatever the address spelled. */
function identityValue(args: VerbArgs, field: string): IdentityValue | undefined {
  const value = args[field];
  if (value === undefined || value === '') return undefined;
  if (field !== 'phase') return value;
  const phase = Number(value);
  return Number.isSafeInteger(phase) && phase > 0 ? phase : undefined;
}

function offerOf(
  verb: VerbRowView,
  row: SurfaceRow,
  context: VerbArgs,
  capabilities: Capabilities | undefined,
) {
  const { record, fields } = verbIdentity(verb.name);
  const identity: Record<string, IdentityValue> = {};
  for (const field of fields) {
    const value = identityValue(context, field);
    if (value !== undefined) identity[field] = value;
  }
  const missing = fields.filter((field) => identity[field] === undefined);
  const placeholders = placeholdersOf(verb.route);
  const inPath = new Set(placeholders.map((key) => PLACEHOLDER_FIELD[key] ?? key));
  const args: Record<string, IdentityValue> = {};
  for (const key of placeholders) {
    const value = identity[PLACEHOLDER_FIELD[key] ?? key];
    if (value !== undefined) args[key] = value;
  }
  const body: Record<string, IdentityValue> = { ...FIXED_BODY[verb.name] };
  for (const [field, value] of Object.entries(identity)) if (!inPath.has(field)) body[field] = value;

  const takes = TAKES[verb.name];
  const offer: VerbOffer = {
    name: verb.name,
    kind: verb.kind,
    record,
    mode: verb.kind === 'read' ? 'read' : takes || missing.length ? 'open' : 'press',
    summary: verb.summary ?? '',
    identity,
    missing,
    args,
    body,
  };
  if (takes) offer.takes = takes;
  const needs = lackedFlag(row, capabilities);
  if (needs) offer.needs = needs;
  if (CLI_EDITIONS.includes(verb.edition)) {
    const line = verbLine(verb.name, identity, LINE_TEMPLATES[verb.name]);
    if (line) offer.line = line;
  }
  if (row.door) offer.door = row.door;
  return offer;
}

/**
 * Every verb of these record kinds the registry knows, in the table's order,
 * for a context that names the record (`{slug, phase}` for a phase, `{id}` for
 * a card). A verb whose identity the context cannot fill is still offered,
 * with what is `missing` — the palette offers it by its line or its door.
 */
export function verbOffers(
  kinds: RecordKind | readonly RecordKind[],
  context: VerbArgs,
  capabilities: Capabilities | undefined,
): VerbOffer[] {
  const wanted = typeof kinds === 'string' ? [kinds] : kinds;
  const rows = new Map(
    SURFACE.filter((row) => row.kind === 'verb' && row.verb).map((row) => [row.verb as string, row]),
  );
  const out: VerbOffer[] = [];
  for (const verb of ROWS) {
    const row = rows.get(verb.name);
    if (!row || !wanted.includes(verbIdentity(verb.name).record)) continue;
    out.push(offerOf(verb, row, context, capabilities));
  }
  return out;
}

/**
 * The context an address supplies: a plan's slug, a phase (its own page, a
 * lane's pane, `?phase=`), and the run a plan's history names (`?run=`).
 */
export function verbArgsOf(route: Pick<Route, 'segments' | 'query'>): VerbArgs {
  const [head, slug, third, fourth] = route.segments;
  const phaseOf = (value: string | undefined) =>
    /^\d{1,4}$/.test(value ?? '') && Number(value) > 0 ? Number(value) : undefined;
  const args: Record<string, IdentityValue> = {};
  if (head === 'plan' && slug) args.slug = slug;
  const phase =
    (head === 'plan' && third === 'phase' ? phaseOf(fourth) : undefined) ??
    phaseOf(/^p(\d{1,4})$/.exec(route.query.lane ?? '')?.[1]) ??
    phaseOf(route.query.phase);
  if (phase !== undefined) args.phase = phase;
  if (head === 'plan' && route.query.run) args.runId = route.query.run;
  return args;
}

/**
 * Where a verb is drawn, as an address: a plan tab is THAT plan's — the slug
 * the context names rides along, or `journal` on `#/plan/demo/run` would open
 * a plan called "run" — and with no slug, the library to pick one from; the
 * shell's parts open over `base`; every other door is its head and section.
 */
export function verbDoorHref(
  door: SurfaceDoor,
  identity: Readonly<Record<string, unknown>>,
  options: { name?: string; base?: Route } = {},
): string {
  if (door.place === 'Shell') {
    return door.section === 'palette'
      ? paletteHref(options.name ?? '', options.base)
      : bellHref(options.base);
  }
  if (door.head === 'plan') {
    const slug = identity.slug;
    return typeof slug === 'string' && slug ? planHref(slug, door.section) : plansHref();
  }
  return hrefOf(door.section ? `${door.head}/${door.section}` : door.head);
}
