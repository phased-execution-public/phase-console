/**
 * THE OUTCOME'S SCHEMA (measured-console phase 12, B4) — the owner of the
 * shape `scripts/phase-outcome.sh` writes to `PE_OUTCOME_FILE`, and of the
 * shape a supervised session returns as its `structured_output`.
 *
 * Two schemas, one source. `OUTCOME_FILE_SCHEMA` is the file: what the script
 * writes field for field (`viewer/test/outcome-schema.test.ts` runs the script
 * over every shape its bats suite declares and validates each file against it).
 * `OUTCOME_SESSION_SCHEMA` is what the runner passes the CLI as `--json-schema`:
 * the file less the four fields the RUNNER owns (`version`, `slug`, `phase`,
 * `written_at` — a session never knows its attempt's clock, and a slug a model
 * spelled is a slug nobody checked), with one more status word, `none`: the
 * session declared nothing. `none` is the absence of a word, not a word, so it
 * never outranks a file that holds one (`server/runner/outcome.ts`
 * `reconcileOutcome`).
 *
 * The script keeps writing the file for hand sessions and the free skill, so
 * the skill's interface (`PE_API`) is unchanged by this.
 *
 * ⚠️ Imports only shared vocabularies with no imports of their own — the
 * client may bundle this, and `node --test` imports it directly.
 */

import { OUTCOME_STATUSES } from './run-lifecycle.js';
import { RUN_ACTS } from './verb-model.js';
import { HUMAN_STEP_KINDS } from './human-step-model.js';
import { PROOF_TYPES, WHY_PERSON } from './turn-model.js';

/** The session schema's extra word: "I declared nothing with phase-outcome.sh". */
export const OUTCOME_NONE = 'none';

/** The step a `needs-human --step <kind>` declaration carries, as the script writes it. */
const STEP_SCHEMA = Object.freeze({
  type: 'object',
  required: ['kind', 'title'],
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: [...HUMAN_STEP_KINDS] },
    title: { type: 'string', maxLength: 300 },
    open_url: { type: 'string', pattern: '^https?://' },
    open_command: { type: 'string', maxLength: 500 },
    where: { type: 'string', enum: ['host', 'any'] },
    proof: { type: 'string', maxLength: 1000 },
    lines: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 300 } },
    code: { type: 'string', pattern: '^[A-Z0-9]{4,9}(-[A-Z0-9]{4,9})?$' },
    credential: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' },
    due_when: { type: 'string', maxLength: 1000 },
    why: { type: 'string', enum: [...WHY_PERSON] },
    why_source: { type: 'string', enum: ['declared', 'inferred'] },
    proof_type: { type: 'string', enum: [...PROOF_TYPES] },
    proof_words: { type: 'string', maxLength: 500 },
    guide: {
      type: 'object',
      required: ['text'],
      additionalProperties: false,
      properties: { text: { type: 'string' }, lang: { type: 'string' } },
    },
    effort: { type: 'integer', minimum: 0 },
    window_minutes: { type: 'integer', minimum: 0 },
    unblocks: { type: 'array', items: { type: 'string' } },
    options: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'label'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,31}$' },
          label: { type: 'string', maxLength: 120 },
          consequence: { type: 'string', maxLength: 300 },
        },
      },
    },
    recommended: { type: 'string' },
    allow_decline: { type: 'boolean' },
    decision_key: { type: 'string' },
    tried: { type: 'string', maxLength: 600 },
  },
});

/** The fields a session and the file share, described for the model that fills them. */
const SHARED_PROPERTIES = Object.freeze({
  reason: { type: 'string', description: 'The --reason you declared: why, in one line.' },
  needs: {
    type: 'string',
    pattern: '^[a-z][a-z0-9.-]{0,63}$',
    description: 'The --needs key a blocked or needs-human declaration named.',
  },
  rule: { type: 'string', description: 'A permission block: the rule that refused.' },
  command: { type: 'string', description: 'A permission block: the command it refused.' },
  run_act: { type: 'string', enum: [...RUN_ACTS], description: 'A run request: the --run-act word.' },
  step: STEP_SCHEMA,
  resume_after: { type: 'string', description: 'The ISO time the wait ends (waiting-external).' },
  session_id: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,128}$' },
  trace: { type: 'string' },
  span: { type: 'string' },
  watch: {
    type: 'array',
    maxItems: 8,
    items: { type: 'string', minLength: 1, maxLength: 1000 },
    description: 'The --watch refs you declared, verbatim.',
  },
});

/** The file `phase-outcome.sh` writes — every field, the runner's four included. */
export const OUTCOME_FILE_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'phase-outcome',
  type: 'object',
  required: ['version', 'slug', 'phase', 'status', 'watch', 'written_at'],
  additionalProperties: false,
  properties: {
    version: { type: 'integer', enum: [1] },
    slug: { type: 'string', minLength: 1 },
    phase: { type: 'integer', minimum: 0 },
    status: { type: 'string', enum: [...OUTCOME_STATUSES] },
    ...SHARED_PROPERTIES,
    written_at: { type: 'string', minLength: 1 },
  },
});

/** What a supervised session returns as `structured_output` — `--json-schema`'s value. */
export const OUTCOME_SESSION_SCHEMA = Object.freeze({
  type: 'object',
  title: 'phase-outcome',
  description:
    'The outcome you declared for this phase with phase-outcome.sh, field for field. ' +
    `Declared nothing? status "${OUTCOME_NONE}". Never a different word from the one you declared.`,
  required: ['status'],
  additionalProperties: false,
  properties: {
    status: {
      type: 'string',
      enum: [...OUTCOME_STATUSES, OUTCOME_NONE],
      description: `The status word you passed phase-outcome.sh, or "${OUTCOME_NONE}" if you declared none.`,
    },
    ...SHARED_PROPERTIES,
  },
});

/** `--json-schema`'s argument: the session schema on one line. */
export function sessionSchemaArg() {
  return JSON.stringify(OUTCOME_SESSION_SCHEMA);
}

/**
 * Validate a value against one of the schemas above — the subset of JSON
 * Schema they use (`type`, `enum`, `required`, `properties`,
 * `additionalProperties: false`, `items`, `maxItems`, `minLength`, `maxLength`,
 * `pattern`, `minimum`). Returns the problems as `<path>: <what>` lines; an
 * empty list is valid. Dependency-free on purpose: the server, the tests and
 * the client read it alike.
 *
 * @param {unknown} value
 * @param {Record<string, any>} schema
 * @param {string} [path]
 * @returns {string[]}
 */
export function validateOutcome(value, schema, path = '$') {
  /** @type {string[]} */
  const problems = [];
  const type = schema.type;
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${path}: not an object`];
    const obj = /** @type {Record<string, unknown>} */ (value);
    for (const key of schema.required ?? []) if (!(key in obj)) problems.push(`${path}.${key}: required`);
    for (const [key, child] of Object.entries(obj)) {
      const sub = schema.properties?.[key];
      if (!sub) {
        if (schema.additionalProperties === false)
          problems.push(`${path}.${key}: not a field of the outcome`);
        continue;
      }
      problems.push(...validateOutcome(child, sub, `${path}.${key}`));
    }
    return problems;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return [`${path}: not an array`];
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
      problems.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items)
      value.forEach((item, i) => problems.push(...validateOutcome(item, schema.items, `${path}[${i}]`)));
    return problems;
  }
  if (type === 'string') {
    if (typeof value !== 'string') return [`${path}: not a string`];
    if (typeof schema.minLength === 'number' && value.length < schema.minLength)
      problems.push(`${path}: shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength)
      problems.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value))
      problems.push(`${path}: does not match ${schema.pattern}`);
  } else if (type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) return [`${path}: not an integer`];
    if (typeof schema.minimum === 'number' && value < schema.minimum)
      problems.push(`${path}: below ${schema.minimum}`);
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') return [`${path}: not a boolean`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    problems.push(`${path}: not one of ${schema.enum.join(', ')}`);
  return problems;
}
