/**
 * The wire of the permission policy — the shipped lists, the operator's adds and strikes, the
 * standing advisories, and the one edit verb (measured-console phase 32).
 */

/**
 * @typedef {object} RuleSupport
 * @property {string} raw
 * @property {string} tool
 * @property {string} form
 * @property {string} support
 * @property {string} [note]
 */
/**
 * @typedef {object} PolicyLists
 * @property {string[]} deny
 * @property {string[]} ask
 * @property {string[]} allow
 */
/**
 * What a policy FILE holds: the operator's own rules plus the shipped
 * ask/allow defaults they have struck by name. Deliberately no `removed.deny`
 * — the shipped deny list is the wall and cannot be struck from a browser.
 *
 * - `removed`: `deny` is optional: servers from before the 2026-08 parity omit it.
 * @typedef {PolicyLists & {
 *   removed?: { deny?: string[]; ask: string[]; allow: string[] };
 * }} PolicyExtras
 */
/**
 * @typedef {object} PolicyView
 * @property {PolicyLists} defaults
 * @property {PolicyExtras} extra
 * @property {{ slug: string; path: string; extra: PolicyExtras } | null} plan
 * @property {PolicyLists} effective
 * @property {PolicyLists} [struck] - Which SHIPPED defaults are struck, per list — the removals themselves, rather than their effect on `effective`. Absent on a server from before 3.5.0, where the only way to see one was to diff `effective` against `defaults` and infer.
 * @property {string} [profile] - The profile a new run here would get. Not a preference — the profile is per-run — so this is the word the run door falls back to, and `profiles` below stays the catalogue of what exists. Absent before 3.5.0.
 * @property {string} file
 * @property {{ id: string; label: string }[]} profiles
 * @property {{ raw: string; note?: string }[]} inert - Rules the syntax accepts that nothing honours; `note` is absent where the parser has nothing to add.
 * @property {PolicyAdvisory[]} [advisory] - What the policy in force cannot do (phase 12): an empty ask list, a struck deny wall — each with the rules it names and whether the operator has acknowledged it against exactly those rules. Absent on a server from before the feature; the banner then has nothing to show.
 * @property {RuleSupport[]} support
 * @property {string[]} hookTools
 * @property {string[]} wrappersNotStripped
 * @property {string[]} [seen] - Tools this console has actually been asked about.
 * @property {{ global: boolean | null; plan: boolean | null; effective: boolean }} [autoApprove] - Auto-grant provenance: what the global file says, what the plan's file says (null = that scope is silent), and the answer in force — which ships ON. Absent on a server from before the feature; hide the editor then.
 */
/**
 * One standing advisory (`shared/ops-vocab.js` `POLICY_ADVISORY_KINDS`).
 * @typedef {object} PolicyAdvisory
 * @property {import('../ops-vocab.js').PolicyAdvisoryKind} kind
 * @property {string[]} rules
 * @property {string} message
 * @property {boolean} acknowledged
 * @property {string} fingerprint
 */
/**
 * What `POST /api/policy` accepts — one scope, one edit.
 * @typedef {object} PolicyEdit
 * @property {'global' | 'plan'} scope
 * @property {string | null} [slug]
 * @property {Partial<Record<keyof PolicyLists, string[]>>} [add]
 * @property {Partial<Record<keyof PolicyLists, string[]>>} [remove] - Also strikes a SHIPPED default by name — deny included since the 2026-08 parity.
 * @property {(keyof PolicyLists)[]} [reset] - Return these parts to stock at the chosen scope: your rules out, strikes forgiven.
 * @property {{ deny?: string[]; ask?: string[]; allow?: string[] }} [restore] - Forgive individual strikes — the named shipped defaults apply again, as defaults.
 * @property {boolean | null} [autoApprove] - Set (true/false) or clear (null → inherit) the auto-grant scalar at the chosen scope. Rides the same door as the lists — the wire shape is `{set: {autoApprove}}`, folded in by `editPolicy` below.
 */
/**
 * `POST /api/policy` as the wire carries it: a `PolicyEdit` with the auto-grant scalar riding
 * `set` — `editPolicy` folds it there, so a rule edit without it never clears the stored value. A
 * bare `{deny, ask}` is the older tightening-only body and still means what it did.
 * @typedef {Omit<PolicyEdit, 'autoApprove'> & { set?: { autoApprove?: boolean | null } }} PolicyEditBody
 */
/**
 * `POST /api/policy/advisory/acknowledge` — the receipt, and the advisories as they now stand.
 * @typedef {object} PolicyAdvisoryAck
 * @property {true} ok
 * @property {string} kind - The advisory acknowledged — a `PolicyAdvisoryKind`, checked by the route.
 * @property {PolicyAdvisory[]} advisory
 */

/**
 * Every route this family owns → the typedef its response is (and, for a write, the one it takes).
 * @type {Readonly<Record<string, { response: string, body?: string }>>}
 */
export const WIRE_ROUTES = Object.freeze({
  'GET /api/policy': { response: 'PolicyView' },
  'POST /api/policy/advisory/acknowledge': { response: 'PolicyAdvisoryAck' },
  'POST /api/policy': { response: 'PolicyView', body: 'PolicyEditBody' },
});
