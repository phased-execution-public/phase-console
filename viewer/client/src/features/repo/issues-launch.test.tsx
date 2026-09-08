/**
 * The plan-from-issues launch — the payload, and the parity that keeps it whole.
 *
 * Two questions, and the second is the one the plan asked for in as many words:
 *
 *  1. **What does one click actually send?** The builder is pure, so it is
 *     pinned field by field including the omissions — a key that stops being
 *     sent degrades silently to the server's own default, and the session looks
 *     healthy and is not the session that was asked for.
 *  2. **Can this dialog reach every option the server accepts?** Every member of
 *     `AGENT_TICKET_FIELDS` must be either in a payload this surface can send or
 *     in `TICKET_FIELD_GAPS` with a written reason. A field the server gains and
 *     this dialog cannot reach is then a failing test rather than a capability
 *     nobody notices is missing — the same rule the run form lives under
 *     (`run-setup/schema-parity.test.ts`).
 */

import { describe, expect, it } from 'vitest';
import { AGENT_TICKET_FIELDS } from '@shared/run-settings.js';
import { EMPTY } from '@/features/run-setup/schema';
import { MODES, buildLaunch, shows } from '@/features/run-setup/modes';
import {
  issuesTicket,
  launchBlockedReason,
  briefBytes,
  TICKET_FIELD_GAPS,
  BRIEF_MAX,
  BRIEF_MAX_BYTES,
} from './issues-launch';
import { SELECTION_MAX } from './issues';

/** Every choice turned ON, so a conditionally-sent field is visible to the walk. */
const LOUD = {
  ...EMPTY,
  model: 'claude-opus-5',
  effort: 'high',
  accountId: 'work',
  ultracode: true,
  attachDefaultSkills: true,
  skills: ['design-system'],
};

const TICKET = (over: Partial<Parameters<typeof issuesTicket>[1]> = {}) =>
  issuesTicket(buildLaunch(LOUD, 'plan', ['phased-execution']), {
    brief: 'close these three',
    issues: ['acme/one#7', 'acme/two#3'],
    size: { cols: 120, rows: 40 },
    ...over,
  });

describe('one click sends exactly what was chosen', () => {
  it('carries the issues as REFS, the brief, and every option the form offered', () => {
    expect(TICKET()).toEqual({
      intent: 'plan',
      brief: 'close these three',
      issues: ['acme/one#7', 'acme/two#3'],
      model: 'claude-opus-5',
      effort: 'high',
      accountId: 'work',
      ultracode: true,
      // The plan's default skills are UNIONED by the caller, not the server: a
      // ticket has no attach flag for the server to union with.
      skills: ['phased-execution', 'design-system'],
      cols: 120,
      rows: 40,
    });
  });

  it('sends REFS and never issue TEXT', () => {
    // The server resolves each ref against its own cache and composes the
    // section itself, applying the sanitiser three QA rounds of Phase 15 paid
    // for. A client that pasted issue text would walk around all of it.
    const body = TICKET();
    expect(body.issues).toEqual(['acme/one#7', 'acme/two#3']);
    expect(JSON.stringify(body)).not.toContain('the lock never releases');
  });

  it('omits an empty brief and an empty selection rather than sending empty values', () => {
    // The BUILDER's rule: a ticket that sends `issues: []` and one that sends
    // nothing must not be two different things to a server whose absent state
    // IS "no issues".
    //
    // ⚠️ This is not a claim that such a ticket is legal. It is not — the server
    // answers `400 a plan session needs a brief.` — and the dialog is what must
    // never compose one. That is `launchBlockedReason`, below; reading this case
    // as "an empty brief is fine" is the misreading QA round 1 caught, when the
    // button really did fire a payload this test called correct.
    const bare = issuesTicket({}, { brief: '   ', issues: [] });
    expect(bare).toEqual({ intent: 'plan' });
    expect('brief' in bare).toBe(false);
    expect('issues' in bare).toBe(false);
    // …and the dialog would never have got here.
    expect(
      launchBlockedReason({ allowAgent: true, rootOpen: true, issues: [], brief: '   ', pending: false }),
    ).toBeTruthy();
  });

  describe('the launch refuses everything the server would refuse', () => {
    const ok = { allowAgent: true, rootOpen: true, issues: ['acme/one#7'], brief: 'do it', pending: false };

    it('opens only when every condition holds', () => {
      expect(launchBlockedReason(ok)).toBeUndefined();
    });

    it('refuses an empty brief — `agent.ts` answers 400 on one', () => {
      expect(launchBlockedReason({ ...ok, brief: '' })).toMatch(/brief/i);
      expect(launchBlockedReason({ ...ok, brief: '   \n  ' })).toMatch(/brief/i);
    });

    it('refuses an empty selection, the missing flag, a closed source and the cap', () => {
      expect(launchBlockedReason({ ...ok, issues: [] })).toMatch(/at least one issue/i);
      expect(launchBlockedReason({ ...ok, allowAgent: false })).toMatch(/--allow-agent/);
      expect(launchBlockedReason({ ...ok, rootOpen: false })).toMatch(/source directory/i);
      expect(
        launchBlockedReason({
          ...ok,
          issues: Array.from({ length: SELECTION_MAX + 1 }, (_, i) => `a/b#${i}`),
        }),
      ).toMatch(new RegExp(String(SELECTION_MAX)));
    });

    it('refuses a brief the SERVER would refuse — bytes, not characters', () => {
      // `maxLength` counts UTF-16 code units and `agent.ts` counts bytes, so
      // ~4 100 Persian characters clear the textarea and are refused by the
      // server. That is round 1's High arriving through the other end of the
      // field, so the dialog refuses it before the click. (QA round 2.)
      const persian = 'ی'.repeat(4200);
      expect(persian.length).toBeLessThan(BRIEF_MAX);
      expect(briefBytes(persian)).toBeGreaterThan(BRIEF_MAX_BYTES);
      expect(launchBlockedReason({ ...ok, brief: persian })).toMatch(/bytes/i);
      // …and an ASCII brief of the same character count is fine, which is what
      // makes this a UNIT question rather than a smaller cap.
      expect(launchBlockedReason({ ...ok, brief: 'a'.repeat(4200) })).toBeUndefined();
    });

    it('says it is starting rather than any other reason, once it is', () => {
      expect(launchBlockedReason({ ...ok, brief: '', pending: true })).toMatch(/starting/i);
    });
  });

  it('never carries a permission mode — the omission IS the choice', () => {
    // A plan-authoring session always starts in plan mode, so it presents the
    // graph for approval before writing. A mode chosen here could write a plan
    // nobody approved.
    const body = TICKET();
    expect('permissionMode' in body).toBe(false);
    expect('permissionProfile' in body).toBe(false);
    expect(shows('plan', 'permissionProfile')).toBe(false);
  });

  it('`default` account is still an omission, and `auto` still travels', () => {
    expect('accountId' in buildLaunch({ ...LOUD, accountId: 'default' }, 'plan', [])).toBe(false);
    expect(buildLaunch({ ...LOUD, accountId: 'auto' }, 'plan', []).accountId).toBe('auto');
  });

  it('ultracode is off unless it was ticked', () => {
    expect('ultracode' in buildLaunch({ ...LOUD, ultracode: false }, 'plan', [])).toBe(false);
  });

  it('the two ceilings are the server’s, mirrored where they are enforced', () => {
    // `TICKET_ISSUES_MAX` is a count and mirrors exactly. `MAX_BRIEF_BYTES` is
    // BYTES and this is CHARACTERS — the textarea's cap, same as the wizard's.
    // They agree for any brief this side of astral characters, and where they
    // do not the server answers with its own sentence rather than truncating.
    expect(SELECTION_MAX).toBe(20);
    expect(BRIEF_MAX).toBe(8000);
  });
});

describe('every ticket field is reachable, or its absence is written down', () => {
  /** What this surface can actually put on the wire, with everything turned on. */
  const sendable = new Set(Object.keys(TICKET()));

  it('names every AGENT_TICKET_FIELDS member exactly once, in one place or the other', () => {
    const unreachable: string[] = [];
    for (const field of AGENT_TICKET_FIELDS) {
      if (sendable.has(field)) continue;
      if (field in TICKET_FIELD_GAPS) continue;
      unreachable.push(field);
    }
    expect(
      unreachable,
      'add the control to `plan` mode, or record why this ticket cannot carry it in TICKET_FIELD_GAPS',
    ).toEqual([]);
  });

  it('records no reason for a field it DOES send', () => {
    // A gap entry beside a field the payload carries is a stale explanation,
    // which is worse than none: it describes a decision nobody made.
    const contradictions = Object.keys(TICKET_FIELD_GAPS).filter((field) => sendable.has(field));
    expect(contradictions).toEqual([]);
  });

  it('records no reason for a field the server does not have', () => {
    const ghosts = Object.keys(TICKET_FIELD_GAPS).filter(
      (field) => !(AGENT_TICKET_FIELDS as readonly string[]).includes(field),
    );
    expect(ghosts, 'a gap for a field no door reads is a reason nobody needs').toEqual([]);
  });

  it('every recorded gap gives an actual reason, not a shrug', () => {
    for (const [field, reason] of Object.entries(TICKET_FIELD_GAPS)) {
      expect(reason.length, `"${field}" needs a reason worth reading`).toBeGreaterThan(40);
    }
  });

  it('sends nothing the ticket door would not read', () => {
    const accepted = new Set<string>(AGENT_TICKET_FIELDS);
    // `kind` is added by the API client itself, not by this builder.
    for (const field of sendable) {
      expect(accepted.has(field), `this dialog would send "${field}", which no ticket door reads`).toBe(true);
    }
  });

  it('is the WIZARD’s field set plus the two things a wizard cannot know', () => {
    // The consolidation rule: one launcher, extended. `issues` and `brief` are
    // the ticket's own, and every choice comes from `MODES.plan`.
    expect([...MODES.plan.fields]).toEqual([
      'model',
      'effort',
      'accountId',
      'attachDefaultSkills',
      'skills',
      'ultracode',
    ]);
    expect(MODES.plan.door).toBe('launch');
  });
});
