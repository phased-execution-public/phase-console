/**
 * Launch presets — a whole posture in one press (control-tower phase 22).
 *
 * A preset is a PARTIAL set of launch-form values applied OVER the seed: it
 * moves the keys it declares and nothing else, so a plan's scope, its model,
 * its branch and every value the operator has not asked a preset about stay
 * exactly where the seed put them. The three share ONE key set
 * (`PRESET_KEYS`), which is what makes moving from one to another total:
 * Careful then Balanced leaves nothing of Careful behind.
 *
 * **Balanced IS the baseline.** Its values are what a fresh console launches
 * with when nobody has set anything (`BASELINE` in the client's `seed.ts`,
 * which `presets.test.ts` holds this table to), so choosing it is how an
 * operator gets back to the shipped posture after a preference or a last
 * launch moved it.
 *
 * The values are FORM values — the strings and booleans the launch form holds
 * (an empty number box is `''`, the console's own cap) — because a preset is
 * applied to the form, never to a payload: the payload is built from the form
 * as it always was, so a launch that picks no preset posts the same bytes.
 *
 * `last-launch` is the fourth choice and is not a table row: it is this
 * browser's memory of the plan (`launch-memory.ts`), offered only when there
 * is one.
 */

/** The three posture presets, in the order the form offers them. */
export const LAUNCH_PRESETS = Object.freeze(/** @type {const} */ (['careful', 'balanced', 'hands-off']));

/** The fourth choice: what this browser last launched the plan with. */
export const LAST_LAUNCH_PRESET = /** @type {const} */ ('last-launch');

/** The preset the shipped defaults ARE. */
export const BASELINE_PRESET = /** @type {const} */ ('balanced');

/** How each choice is named on its button. */
export const PRESET_LABELS = Object.freeze({
  careful: 'Careful',
  balanced: 'Balanced',
  'hands-off': 'Hands-off',
  'last-launch': 'Last launch',
});

/** One sentence per choice — the button's description, in the operator's words. */
export const PRESET_BLURBS = Object.freeze({
  careful:
    'You are watching: commits and installs ask first, anything unclear stops and asks, a usage limit pauses, and recovery stops early.',
  balanced: 'What this console ships with: trusted, keeps going where it safely can, and recovers by itself.',
  'hands-off':
    'Nobody is watching: a question a person does not answer in 60 s is answered by rule, and a run tolerates a longer failure streak before it stops.',
  'last-launch': 'What this browser launched this plan with last time.',
});

/**
 * The keys every preset declares — posture only: how much the run asks a
 * person, where it stops and how far it recovers on its own. Never a scope, a
 * model, a branch or a budget in dollars: those are questions about THIS plan,
 * and a preset that answered them would be answering for a plan it has never
 * read.
 */
export const PRESET_KEYS = Object.freeze(
  /** @type {const} */ ([
    'permissionProfile',
    'autonomy',
    'onLimit',
    'autoRecover',
    'maxConsecutiveFailures',
    'ladderPerRunRungs',
    'relay',
  ]),
);

/** Each preset's values, one per `PRESET_KEYS` member. */
export const PRESET_VALUES = Object.freeze({
  careful: Object.freeze({
    permissionProfile: 'guarded',
    autonomy: 'halt-on-everything',
    onLimit: 'pause',
    autoRecover: false,
    maxConsecutiveFailures: '1',
    // #14: the run's own recovery rungs, low — a person is there to decide.
    ladderPerRunRungs: '3',
    relay: 'off',
  }),
  balanced: Object.freeze({
    permissionProfile: 'trusted',
    autonomy: 'keep-going',
    onLimit: 'switch',
    autoRecover: true,
    maxConsecutiveFailures: '',
    ladderPerRunRungs: '',
    relay: 'off',
  }),
  'hands-off': Object.freeze({
    permissionProfile: 'trusted',
    autonomy: 'keep-going',
    onLimit: 'switch',
    autoRecover: true,
    // A streak halt waits for a person's Start, and a rescued flake counts
    // toward it: an unattended run gets room for four.
    maxConsecutiveFailures: '4',
    ladderPerRunRungs: '',
    relay: 'last-resort',
  }),
});
