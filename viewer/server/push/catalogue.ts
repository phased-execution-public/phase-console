/**
 * What is worth waking someone for.
 *
 * The console already knew how to raise a notification; what it lacked was a
 * way to reach a device that is not looking at it. Push closes that, and the
 * moment it does, restraint becomes the whole design problem: a channel that
 * fires for everything is a channel that gets muted, and the notification it
 * gets muted for is the one that mattered.
 *
 * So the catalogue is graded. Things that stop work dead are on by default;
 * progress you would like to know about is on because it is infrequent; the
 * firehose of "a file changed" is present, off, and honest about why.
 *
 * Categories rather than one switch, because "tell me when a run needs me" and
 * "tell me when a phase lands" are different appetites, and a phone and a
 * laptop rarely want the same ones.
 */

import { GRANT_SCOPE_WORDS } from '../../shared/turn-model.js';

export type CategoryId =
  | 'approval' | 'session-ask' | 'needs-you' | 'gate' | 'qa' | 'halted' | 'parked' | 'stalled'
  | 'phase' | 'finished' | 'ready' | 'changed' | 'session' | 'health' | 'limits' | 'usage-climbing'
  | 'budget' | 'issue' | 'digest' | 'granted';

export type Category = {
  id: CategoryId;
  label: string;
  detail: string;
  /** On for a new subscription unless it is asked to be otherwise. */
  byDefault: boolean;
  /** Interrupts a focus mode and buzzes a wrist. Reserved for "nothing proceeds without you". */
  urgent: boolean;
};

export const CATEGORIES: readonly Category[] = [
  {
    id: 'approval',
    label: 'Permission needed',
    detail: 'A session is blocked on a decision only you can make — a command outside its rules, '
      + 'a gate, or a check it cannot make itself. Nothing proceeds until you answer.',
    byDefault: true,
    urgent: true,
  },
  {
    id: 'session-ask',
    label: 'Session waiting on you',
    detail: 'A Claude session hit a permission prompt or asked for input — an autopilot lane, or one '
      + 'you ran in a terminal or as an agent session. It sits blocked until it is answered: a lane '
      + 'from the inbox, any other session only where it runs.',
    byDefault: true,
    urgent: true,
  },
  {
    id: 'needs-you',
    label: 'A phase needs you',
    detail: 'A phase did its work and stopped at something no automation may sign off — a check '
      + 'written as prose, a verification only a person can make, or a HUMAN STEP: a sign-in, a code, '
      + 'a secret, an approval only you can give, named with Open and I did it (and, for a device '
      + 'code, the code). It is not failed and not finished; it is waiting, and it will keep waiting.',
    byDefault: true,
    urgent: true,
  },
  {
    id: 'gate',
    label: 'Gate needs a person',
    detail: 'A phase is held at a gate only a person may clear — a physical act, a third party, a '
      + 'credential no session holds. The board will call the phase ready the moment it is '
      + 'approved and not one second before, so nothing else moves and nothing else will ask.',
    // Not urgent, and the distinction is the point: a gate is waiting on a
    // DECISION, not on a session parked dead with a hook open. Nothing is
    // spending while it waits. Its own category rather than `needs-you`
    // because the remedy is a single button with a different door — the phase
    // page's Gate card — and a channel that cannot say which of the two it
    // means is a channel that gets muted for the wrong one.
    byDefault: true,
    urgent: false,
  },
  {
    id: 'qa',
    label: 'QA verdict owed or failed',
    detail: 'A finished phase still owes its QA verdict, or QA recorded a fail. Either way the '
      + 'plan gates on it: every dependent phase is held until pass or waived is recorded, and '
      + 'nothing records one by itself.',
    byDefault: true,
    urgent: true,
  },
  {
    id: 'halted',
    label: 'Run halted',
    detail: 'A run stopped on something that must not be automated past — a failed verification, '
      + 'a phase that would not settle. Includes a run that was interrupted with nothing driving it.',
    byDefault: true,
    urgent: true,
  },
  {
    id: 'parked',
    label: 'Run parked or waiting',
    detail: 'Every remaining phase needs a person, or the run is asleep until a usage window '
      + 'reopens. Not an error — it just will not move on its own.',
    byDefault: true,
    urgent: false,
  },
  {
    id: 'stalled',
    label: 'Nothing is happening',
    detail: 'A session is still running and still spending, and it has stopped producing work — '
      + 'silent for ten minutes, six turns without touching a tool, or three attempts that changed '
      + 'nothing. Not urgent: it is not blocked on you, and the run has not stopped. It is the '
      + 'money question rather than the permission question. One exception, once: a stall nothing '
      + 'has resolved 45 minutes later is said again, urgently — at minute ten "it is thinking" is '
      + 'still likely, and at minute seventy it is not. Each card stands itself down when the lane '
      + 'produces work again, its phase ends, the run settles, or the silent-session watchdog '
      + 'recycles the session the card was about — the one case that replaces the card with a line '
      + 'saying what the console did on your behalf.',
    byDefault: true,
    urgent: false,
  },
  {
    id: 'phase',
    label: 'Phase finished or failed',
    detail: 'Each phase as it lands, with what it cost. The steady pulse of a run you are not '
      + 'watching.',
    byDefault: true,
    urgent: false,
  },
  {
    id: 'finished',
    label: 'Plan finished',
    detail: 'A run reached the end of its plan. The one you actually wanted to be told about.',
    byDefault: true,
    urgent: false,
  },
  {
    id: 'ready',
    label: 'Work became ready',
    detail: 'A phase became startable because what it was waiting on finished — including work '
      + 'finished by a session you ran yourself, elsewhere.',
    byDefault: false,
    urgent: false,
  },
  {
    id: 'changed',
    label: 'Plans changed on disk',
    detail: 'Any plan or handoff was written. Genuinely everything — an agent editing a handoff '
      + 'mid-phase fires this. Off by default because it is a firehose, not a signal.',
    byDefault: false,
    urgent: false,
  },
  {
    id: 'session',
    label: 'A session ended',
    detail: 'An agent session or terminal finished while you were not watching it, or exited with '
      + 'an error. Closing one yourself is not announced — you already know.',
    byDefault: true,
    urgent: false,
  },
  {
    id: 'health',
    label: 'Console problems',
    detail: 'The console degraded, its file watch went deaf, or it restarted after a crash. '
      + 'The supervisor failing quietly is the worst case, because everything else still looks fine.',
    byDefault: true,
    urgent: false,
  },
  {
    id: 'limits',
    label: 'Usage limits',
    detail: 'A Claude account this console runs work as hit a usage window — the 5-hour session, '
      + 'the weekly allowance, or a per-model one — with when it resets, plus what the run did '
      + 'about it (waited, switched account, paused) and an account that needs signing in again.',
    byDefault: true,
    urgent: false,
  },
  {
    id: 'usage-climbing',
    label: 'Usage climbing',
    detail: 'Early warning while a window fills — 80% is "plan your afternoon", 95% is "the next '
      + 'long phase will not finish" — and, hours ahead, an account serving live runs that its '
      + 'measured burn will wall: when, when it resets, and which runs are burning it (2 hours '
      + 'before by default). On by default: the wall itself still announces under Usage limits.',
    byDefault: true,
    urgent: false,
  },
  {
    id: 'budget',
    label: 'Budget spent or running low',
    detail: 'A budget that can stop work reached 80% or ran out — a phase\'s wait, a phase\'s or the run\'s '
      + 'dollars, the recovery ladder\'s cap, the failure streak. It says which budget and the arithmetic (the '
      + 'limit, what accrued, what is left, what was asked) and what spent it, and the card beside it raises '
      + 'the budget and retries in one press. Once per budget per attempt. Not urgent: a spent budget holds '
      + 'the work, and nothing spends while it does (control-tower phase 14, #40).',
    // On, and not urgent — the `usage-climbing` precedent: the warning is
    // worth having before the wall, and a spent budget stops spending rather
    // than a session parked dead with a hook open. Its own category rather
    // than `parked` or `needs-you` because the remedy is a raise, not a
    // repair: the CI-flavoured park card sent an operator to check a healthy
    // build while the only thing wrong was a number in the plan.
    byDefault: true,
    urgent: false,
  },
  {
    id: 'issue',
    label: 'Issue drafted by a session',
    detail: 'A session tripped over a problem outside its phase and drafted an issue for it (the plan\'s '
      + '`Issues:` word allows it). Under `draft` it waits in the inbox for your Approve, Discard or edit; '
      + 'under `file` it was filed at once and this tells you what landed. Not urgent: nothing is spending '
      + 'while a draft waits, and a filed issue is a record, not a wall.',
    byDefault: true,
    urgent: false,
  },
  {
    id: 'digest',
    label: 'Hourly digest',
    detail: 'A summary instead of a stream: once an hour, Your turn first — how many items need you, how many '
      + 'came back from a check, how many the AI handled — then every decision waiting on you with how long it '
      + 'has waited and when it expires, every parked run and every stalled session — and, once the channel '
      + 'answers again, the notifications an outage kept from arriving. Nothing waiting sends nothing. Off by '
      + 'default: the categories above already say each thing as it happens.',
    byDefault: false,
    urgent: false,
  },
  {
    id: 'granted',
    label: 'Permission granted',
    detail: 'A grant was applied (control-tower phase 149): who granted which rule, for how far — this call, this '
      + 'phase, this plan, this repository or always — until when, and exactly what it changed. Every grant is a '
      + 'row you can revoke from Settings ▸ Permissions ▸ Grants, and the push opens there, at that grant. Not '
      + 'urgent: it is a record of authority given, and the session it answered resumes by itself.',
    byDefault: true,
    urgent: false,
  },
];

/**
 * The `granted` push (control-tower phase 149): one per grant applied — who,
 * the rule, the reach, the end, and what it changed — tagged by the grant so a
 * repeat replaces rather than stacks. Never a secret: the rule and the command
 * on a row were redacted when they were recorded.
 */
export function grantedPush(row: {
  id: string; by: string; rule: string; scope: string; until: string | null; door: string | null;
  changed: readonly { kind: string }[]; slug: string | null; phase: number | null;
}): { title: string; body: string; tag: string } {
  const reach = GRANT_SCOPE_WORDS as Readonly<Record<string, string>>;
  const end = row.until ? `until ${row.until.slice(0, 16)}Z at the latest` : 'until revoked';
  const where = row.slug ? `${row.slug}${row.phase != null ? ` · phase ${row.phase}` : ''}` : 'this console';
  const kinds = [...new Set(row.changed.map((change) => change.kind))];
  return {
    title: `Granted: ${row.rule}`.slice(0, 120),
    body: `${row.by}${row.door ? ` (${row.door})` : ''} granted ${row.rule} for ${reach[row.scope] ?? row.scope}, ${end} — ${where}. `
      + `Changed: ${kinds.length ? kinds.join(', ') : 'nothing — it was already so'}.`,
    tag: `granted:${row.id}`,
  };
}

/* ------------------------------------------------------------------ *
 * A person's turn — what a human step's push carries (control-tower phase 41)
 * ------------------------------------------------------------------ */

/**
 * The actions an ACT's `needs-you` push names: *Open* (the item, where the
 * person is) and *I did it* (run the proof now). Named as DATA on the
 * payload's `step` — each `action` is the verb's own name, `POST
 * /api/human-steps/:id/<action>` (control-tower phase 43) — and *I did it* is
 * ALSO a signed button (`check` in `PUSH_ACTION_VERBS`), because answering it
 * needs no page: the proof runs on the console. *Open* needs the person's own
 * browser, so it stays the notification's tap. Two, and never more — the
 * platform cap. Phase 42 draws them. A permission item and a decision name
 * their own (`push/actions.ts` `lockScreenOf`, control-tower phase 138): what
 * the `device` door may press, and nothing else.
 */
export const HUMAN_STEP_PUSH_ACTIONS = Object.freeze([
  Object.freeze({ action: 'open', title: 'Open' }),
  Object.freeze({ action: 'check', title: 'I did it' }),
] as const);

/** One button a step's push names: the worker's own *Open*, or a verb the token signs. */
export type StepPushAction = { readonly action: string; readonly title: string };

/** The `step` block of a human step's push payload — ids and words, never a secret. */
export type HumanStepPush = {
  id: string;
  kind: string;
  where: 'host' | 'any';
  /** The lock screen's buttons, in order (control-tower phase 138) — at most two. */
  actions: readonly StepPushAction[];
  /** A `device-code` step's code: the one code a push carries, on purpose. */
  code?: string;
};

/**
 * One human step's announcement: the words (a title naming the kind and the
 * phase, a body saying what to do — with the device code, when the kind has
 * one) and the payload's `step` block. `detail`, which is what a webhook and
 * the out-of-band notice carry off the machine, never holds the code.
 * `actions` is the lock screen's list (`lockScreenOf`); an act's by default.
 */
export function humanStepPush(step: {
  id: string; kind: string; label: string; title: string; where: 'host' | 'any'; slug: string; phase: number; code?: string;
  openCommand?: string; openUrl?: string; actions?: readonly StepPushAction[];
}): { message: { title: string; body: string; detail: string }; step: HumanStepPush } {
  const place = step.where === 'host' ? ' — at the machine the console runs on' : '';
  // Phase 0 is the plan itself — its `## Operator errands` (control-tower phase 121).
  const scope = step.phase > 0 ? `${step.slug} phase ${step.phase}` : `the plan ${step.slug}`;
  // An operator act says what to do NOW, on the lock screen (#182): the exact
  // command when it has one, else the act itself — a click path is its lines.
  const title = step.kind === 'operator-act'
    ? `NOW: ${step.openCommand ?? step.title}`
    : `Your turn: ${step.label.toLowerCase()} — ${scope}`;
  const body = step.kind === 'operator-act'
    ? `${step.title} — ${scope}${step.openUrl ? `: ${step.openUrl}` : ''}${place}.`
    : `${step.title}${step.code ? ` — code ${step.code}` : ''}${place}.`;
  return {
    message: {
      title,
      body,
      detail: `${step.title}${place}.`,
    },
    step: {
      id: step.id, kind: step.kind, where: step.where, actions: step.actions ?? HUMAN_STEP_PUSH_ACTIONS,
      ...(step.code ? { code: step.code } : {}),
    },
  };
}

/**
 * A step's REMINDER (control-tower phase 43) — the same payload as its first
 * push, under words that say it is still waiting and how many times it has
 * been said, so the phone's lock screen tells a reminder from a new ask. It
 * rides the first push's tag, so a device shows one notification per step,
 * replaced, never a pile.
 */
export function humanStepReminderPush(
  step: Parameters<typeof humanStepPush>[0], n: number,
): ReturnType<typeof humanStepPush> {
  const first = humanStepPush(step);
  return {
    message: {
      title: `Still your turn: ${step.label.toLowerCase()} — ${step.slug} phase ${step.phase}`,
      body: `${first.message.body} Reminder ${n}.`,
      detail: `${first.message.detail} Reminder ${n}.`,
    },
    step: first.step,
  };
}

/** The words of a check's push — the one tag the item's pushes ride, so it replaces the first. */
type TurnWords = { title: string; body: string; detail: string };

/** The item's scope in words: a phase of a plan, or the plan itself (phase 0). */
function scopeOf(step: { slug: string; phase: number }): string {
  return step.phase > 0 ? `${step.slug} phase ${step.phase}` : `the plan ${step.slug}`;
}

/**
 * A check sent the item back (control-tower phase 134, #211) — said ONCE, on
 * the item's own tag: what came back and exactly what to redo. The verdict's
 * words were redacted when it was shaped; the push repeats them, nothing more.
 */
export function humanStepReturnedPush(
  step: { title: string; label: string; slug: string; phase: number },
  verdict: { state: string; note: string; redo: readonly string[]; attempt: number },
): { message: TurnWords } {
  const head = verdict.state === 'needs-info' ? 'Needs more from you' : 'Back to you';
  const redo = verdict.redo.length ? ` ${verdict.state === 'needs-info' ? 'Send' : 'Redo'}: ${verdict.redo.join('; ')}` : '';
  return {
    message: {
      title: `${head}: ${step.label.toLowerCase()} — ${scopeOf(step)}`,
      body: `${step.title} — attempt ${verdict.attempt}: ${verdict.note}${redo}`,
      detail: `${step.title} — attempt ${verdict.attempt} came back ${verdict.state}.`,
    },
  };
}

/**
 * The escalation (control-tower phase 134): the `turnEscalateAfter`-th
 * rejection of one item, said ONCE — the attempts are side by side on the
 * item, with its three ways out.
 */
export function humanStepEscalationPush(
  step: { title: string; label: string; slug: string; phase: number }, rejections: number,
): { message: TurnWords } {
  return {
    message: {
      title: `Stuck after ${rejections} checks: ${step.label.toLowerCase()} — ${scopeOf(step)}`,
      body: `${step.title} came back ${rejections} times. Rewrite the guide, say you can't, or accept it anyway — every attempt is on the item.`,
      detail: `${step.title} came back ${rejections} times and needs the owner.`,
    },
  };
}

/**
 * The categories that are claims about a PLAN's progress — silenced entirely for
 * a closed plan, wherever they are announced from.
 *
 * The split is deliberate and narrower than "everything with a slug". A closed
 * plan must not keep reporting phases landing or work becoming ready: that is
 * the pulse an operator closed the plan to stop. But `approval`, `needs-you`,
 * `halted`, `parked`, `session` and `health` are not about the plan — they are
 * about a live process that has stopped and cannot continue without a person.
 * Silencing those because a plan's front matter says `abandoned` would strand a
 * running session with nothing to tell anyone, which is a far worse failure than
 * a stray notification: closing a plan quiets a record, it never gags a
 * process.
 */
export const PLAN_PROGRESS_CATEGORIES: readonly CategoryId[] = ['phase', 'finished', 'ready', 'changed'];

export function isPlanProgress(category: CategoryId): boolean {
  return PLAN_PROGRESS_CATEGORIES.includes(category);
}

const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

export function isCategory(value: unknown): value is CategoryId {
  return typeof value === 'string' && BY_ID.has(value as CategoryId);
}

export function categoryOf(id: CategoryId): Category {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`unknown category ${id}`);
  return found;
}

export function defaultCategories(): Record<CategoryId, boolean> {
  const out = {} as Record<CategoryId, boolean>;
  for (const c of CATEGORIES) out[c.id] = c.byDefault;
  return out;
}

/**
 * A client may send anything. Unknown keys are dropped and missing ones take
 * their default, so an older client's preferences survive a new category rather
 * than silently turning it on.
 */
export function sanitiseCategories(value: unknown): Record<CategoryId, boolean> {
  const out = defaultCategories();
  if (!value || typeof value !== 'object') return out;
  for (const [key, on] of Object.entries(value as Record<string, unknown>)) {
    if (isCategory(key) && typeof on === 'boolean') out[key] = on;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Where a notification goes when you tap it
 * ------------------------------------------------------------------ */

/** What a notification knows about itself, in as much as decides where it lands. */
export type RouteContext = {
  slug?: string | null;
  phase?: number | null;
  /** A terminal/agent session id — `session` notifications deep-link to the one that ended. */
  sessionId?: string | null;
  /** Which page owns it. A claude session lives on `#/agent`, a shell on `#/terminal`. */
  sessionKind?: 'shell' | 'claude' | null;
  /** A Tower bay to land on instead of the run — a supervisor's card (phase 102). */
  bay?: 'needs-you' | null;
  /**
   * The item a push is about (control-tower phase 138, #215): an item's push —
   * its first, each reminder, a check's return — opens the item itself.
   */
  stepId?: string | null;
  /** The grant a `granted` push announces (phase 138): it opens Settings ▸ Permissions ▸ Grants at that row. */
  grantId?: string | null;
};

/**
 * The ONLY place a notification URL is constructed.
 *
 * It was written by hand at two call sites and was wrong at both: they built
 * `/#/plan/<slug>/autopilot`, while the tab is registered as `run`
 * (`web/views/plan.js`). An unknown tab is not an error the router reports — it
 * silently falls back — so every approval notification for the life of the
 * feature opened the Route tab, and the queue you were woken for was one more
 * tap away with nothing saying so.
 *
 * One builder does not make that impossible; it makes it a single line to fix
 * and a single line to test, which is why `test/notifications.test.ts` walks
 * this table against the client's own router rather than trusting it.
 *
 * A category whose payload is missing the slug it needs degrades upwards — to
 * the runs list, or the plan list — rather than producing `#/plan/undefined`.
 */
export function routeFor(category: CategoryId, context: RouteContext = {}): string {
  const slug = context.slug ? encodeURIComponent(context.slug) : null;
  const phase = typeof context.phase === 'number' && Number.isInteger(context.phase) && context.phase > 0
    ? context.phase : null;

  // An item is answered on its own page (control-tower phase 138, #215): Your
  // turn's `#/turn/<id>`, the item expanded with its guide and its buttons —
  // the same address the worker's `stepTarget` opens from the step block, so
  // the body's tap, *Open*, the bell's row and a webhook's link all agree.
  if (category === 'needs-you' && context.stepId) return `/#/turn/${encodeURIComponent(context.stepId)}`;
  // A supervisor's card is answered where it stands (control-tower phase 102):
  // the Tower's Needs-you bay, where its ONE action is.
  if (category === 'needs-you' && context.bay) return `/#/runs?bay=${encodeURIComponent(context.bay)}`;

  switch (category) {
    // Everything about a run in flight lands on the run itself, because that is
    // where the queue, the console and the controls are.
    case 'approval':
    case 'needs-you':
    case 'halted':
    case 'parked':
    // A stall is about one lane of one run, and the run page is where the lane,
    // its tail and the verbs that answer it (steer, freeze, stop) all live.
    case 'stalled':
    case 'finished':
    // A budget is raised where it stopped the work: the run page's next-steps
    // card, whose raise writes the plan or the run setting and retries.
    case 'budget':
      return slug ? `/#/plan/${slug}/run` : '/#/runs';
    case 'phase':
    // A QA hold is answered on the phase page — the QA launcher and Record
    // verdict both live there.
    case 'qa':
    // And so is a gate: the Gate card with its Approve button and the numbered
    // operator steps is on the phase page and nowhere else.
    case 'gate':
      return slug && phase ? `/#/plan/${slug}/phase/${phase}` : slug ? `/#/plan/${slug}/run` : '/#/plans';
    case 'ready':
      return '/#/ready';
    case 'changed':
      return slug ? `/#/plan/${slug}/route` : '/#/plans';
    // The session that ended, on the page that owns its kind. Both pages keep
    // the ended record until it is dismissed, so this link is still good when
    // the notification is tapped an hour later — and if the record HAS gone,
    // the page falls back to its own list rather than a dead end.
    case 'session': {
      const head = context.sessionKind === 'claude' ? 'agent' : 'terminal';
      const id = context.sessionId ? encodeURIComponent(context.sessionId) : null;
      return id ? `/#/${head}/${id}` : `/#/${head}`;
    }
    // The sessions list, where the waiting badge is: a registry session has no
    // detail pane of its own (an agent/terminal id is a different address), so
    // the list is the honest landing.
    case 'session-ask':
      return '/#/sessions';
    case 'health':
      return '/#/settings';
    // The meters and the account list live on Settings; a limit that stopped a
    // specific run still carries its slug and lands on the run instead.
    case 'limits':
    case 'usage-climbing':
      return slug ? `/#/plan/${slug}/run` : '/#/settings';
    // A draft is decided on the Now page's inbox row; a filed issue is read on
    // the repository page. Both start from the phase the session was working,
    // which is where the draft's evidence and the phase's own record meet.
    case 'issue':
      return slug && phase ? `/#/plan/${slug}/phase/${phase}` : '/#/repo/issues';
    // A summary of everything waiting lands where everything waiting is: Now.
    case 'digest':
      return '/#/now';
    // A grant is listed, with its cause and its Revoke, on Settings ▸
    // Permissions ▸ Grants — and the push opens AT the grant it announces
    // (control-tower phase 138), the row's id one query value.
    case 'granted':
      return context.grantId
        ? `/#/settings/permissions?grant=${encodeURIComponent(context.grantId)}`
        : '/#/settings/permissions';
    default: {
      // Exhaustiveness: a new category added to CATEGORIES without a route here
      // is a compile error, not a notification that silently opens the
      // dashboard.
      const unreachable: never = category;
      return String(unreachable);
    }
  }
}
