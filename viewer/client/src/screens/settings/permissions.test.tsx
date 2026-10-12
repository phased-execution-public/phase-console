/**
 * Settings ▸ Permissions (quiet-console phase 23): the grants, the owner keys,
 * and what a session may run unasked — ported from the 6.x policy editor's test.
 *
 * Grants and owner keys have tests of their own (`grants.test.tsx`,
 * `owner-keys.test.tsx`), so the section is asserted here only for what it
 * composes. The rest is the rule editor (`rules.tsx`), and what is worth pinning
 * there is the one deliberate difference between its edits: every list strikes
 * the same way — the operator's own rules one press, shipped rules struck by
 * name with Restore and Restore defaults as the ways back — except that striking
 * a SHIPPED deny rule asks once first, naming the rule and the scope, because it
 * is the one edit that widens what every future run may do with this console
 * dead. Then the scope (everywhere, or one plan, which is read and written by
 * its slug), the builder, auto-grant, and what the server says cannot work.
 *
 * Every edit is one route, `POST /api/policy`, pressed through the owner door
 * (`press()`); the advisory's receipt is its own route and no edit. The wire is
 * what is asserted: the exact body each press sent, and what the page then says.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PolicyAdvisory, PolicyLists, PolicyView } from '@/data/api';
import type { AuthorityRequest } from '@/data/owner';
import { renderWithClient, sent, type FixtureServer } from './test-kit';

const server = vi.hoisted((): FixtureServer => ({ reads: {}, calls: [] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);
// What a press came to is a toast, and the tray is the shell's: the assertion is on what was raised.
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/ui', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/ui')>()), toast }));

import { ApiError } from '@/data/http';
import { expectNoAxeViolations } from '@/test/axe';
import { PermissionSettingsSection } from './permissions';
import { RulesGroup } from './rules';

const GLOBAL_FILE = '/home/x/.config/phase-console/autopilot.json';
const PLAN_FILE = '/home/x/.config/phase-console/plans/abc12345-repo/alpha.json';

/** The shipped lists. */
const DEFAULTS: PolicyLists = {
  deny: ['Bash(git push:*)', 'Bash(sudo:*)', 'Bash(git reset --hard:*)'],
  ask: ['Bash(git commit:*)', 'Bash(gh pr create:*)'],
  allow: ['Bash(ls:*)', 'Grep'],
};

/**
 * Everywhere, as a server from before auto-grant and the advisories answers:
 * a deny rule and an ask rule of the operator's own, and one shipped deny rule
 * struck by name — gone from the wall, listed under it.
 */
const OLDER: PolicyView = {
  defaults: DEFAULTS,
  extra: {
    deny: ['Bash(task nuke:*)'],
    ask: ['Bash(task deploy:*)'],
    allow: [],
    removed: { deny: ['Bash(git reset --hard:*)'], ask: [], allow: [] },
  },
  plan: null,
  effective: {
    deny: ['Bash(git push:*)', 'Bash(sudo:*)', 'Bash(task nuke:*)'],
    ask: ['Bash(git commit:*)', 'Bash(gh pr create:*)', 'Bash(task deploy:*)'],
    allow: ['Bash(ls:*)', 'Grep'],
  },
  file: GLOBAL_FILE,
  profiles: [],
  inert: [],
  support: [],
  hookTools: ['Bash', 'Edit', 'WebFetch'],
  wrappersNotStripped: ['npx', 'docker exec'],
  seen: [],
};

/** The same rules today: auto-grant on as shipped, the global file silent about it. */
const GLOBAL: PolicyView = { ...OLDER, autoApprove: { global: null, plan: null, effective: true } };

/** After the wall's `git push` rule is struck everywhere. */
const PUSH_STRUCK: PolicyView = {
  ...GLOBAL,
  extra: {
    ...GLOBAL.extra,
    removed: { deny: ['Bash(git reset --hard:*)', 'Bash(git push:*)'], ask: [], allow: [] },
  },
  effective: { ...GLOBAL.effective, deny: ['Bash(sudo:*)', 'Bash(task nuke:*)'] },
};

/** alpha's scope: an ask rule of its own, a shipped ask rule struck there, auto-grant off everywhere and silent here. */
const ALPHA: PolicyView = {
  ...GLOBAL,
  plan: {
    slug: 'alpha',
    path: PLAN_FILE,
    extra: {
      deny: [],
      ask: ['Bash(npm run e2e:*)'],
      allow: [],
      removed: { deny: [], ask: ['Bash(gh pr create:*)'], allow: [] },
    },
  },
  effective: {
    ...GLOBAL.effective,
    ask: ['Bash(git commit:*)', 'Bash(task deploy:*)', 'Bash(npm run e2e:*)'],
  },
  autoApprove: { global: false, plan: null, effective: false },
};

/**
 * The policy as the server holds it: `GET /api/policy` answers everywhere's
 * rules, or alpha's for `?slug=alpha`; a write answers with the rules it made,
 * which every later read of that scope answers too.
 */
function servePolicy({
  everywhere = GLOBAL,
  alpha = ALPHA,
  after,
}: { everywhere?: PolicyView; alpha?: PolicyView; after?: PolicyView } = {}) {
  let held = everywhere;
  server.reads['/api/policy'] = () =>
    server.calls[server.calls.length - 1]!.path.endsWith('?slug=alpha') ? alpha : held;
  server.reads['POST /api/policy'] = (body: unknown) => {
    if ((body as { scope?: string }).scope === 'plan') return alpha;
    held = after ?? held;
    return held;
  };
}

/** Every policy edit, bodies only, in the order pressed. */
const writes = () => sent(server, 'POST', '/api/policy');
/** Every read of the policy, with the scope it asked for. */
const reads = () =>
  server.calls
    .filter((call) => call.method === 'GET' && call.path.split('?')[0] === '/api/policy')
    .map((call) => call.path);
const region = (name: string) => screen.getByRole('region', { name });
const chipsOf = (list: HTMLElement) =>
  within(list)
    .getAllByRole('listitem')
    .map((item) => item.textContent);
const chip = (list: HTMLElement, rule: string) => within(list).getByText(rule).closest('li')!;
const options = (select: HTMLElement) =>
  within(select)
    .getAllByRole('option')
    .map((option) => option.textContent);

async function mountRules(allowWrites = true) {
  const mounted = renderWithClient(<RulesGroup allowWrites={allowWrites} />);
  await screen.findByRole('heading', { name: 'What a session may run unasked' });
  return mounted;
}

/** Point the rules at alpha: the scope, then the plan, then alpha's own read. */
async function choosePlan() {
  fireEvent.change(screen.getByRole('combobox', { name: 'These rules apply' }), {
    target: { value: 'plan' },
  });
  const plan = screen.getByRole('combobox', { name: 'Plan' });
  await within(plan).findByRole('option', { name: 'alpha' });
  fireEvent.change(plan, { target: { value: 'alpha' } });
  await screen.findByText(PLAN_FILE);
}

beforeEach(() => {
  server.calls = [];
  server.reads = { '/api/plans': [{ slug: 'alpha' }, { slug: 'beta' }] };
  servePolicy();
  toast.mockClear();
  window.location.hash = '#/settings/permissions';
});

describe('the section', () => {
  it('composes the grants, the owner keys and the rules, in that order, editable once the console allows writes', async () => {
    server.reads['/api/state'] = { allowWrites: true };
    server.reads['/api/permissions/grants'] = { grants: [], live: 0 };
    server.reads['/api/owner'] = {
      state: 'unenrolled',
      mode: 'unenrolled',
      keys: [],
      session: null,
      requests: [],
      relyingParty: { id: 'localhost', origin: 'http://localhost:4130' },
    };
    renderWithClient(<PermissionSettingsSection />);
    await screen.findByRole('heading', { name: 'What a session may run unasked' });
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      'Grants',
      'Owner keys',
      'What a session may run unasked',
    ]);
    // The console's own answer is what opens the rules to edits.
    expect(await screen.findByRole('region', { name: 'Add a rule' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Bash(task nuke:*)' })).toBeInTheDocument();
  });
});

describe('the three lists', () => {
  it('draws the wall, the ask list and the allow list as chips, each said for what it is', async () => {
    const { container } = await mountRules();
    expect(reads()).toEqual(['/api/policy']);
    const group = region('What a session may run unasked');
    expect(group).toHaveTextContent(
      'Highlighted rules are this scope’s own; the rest ship with the console.',
    );
    expect(within(group).getByText(GLOBAL_FILE)).toBeInTheDocument();

    const deny = screen.getByRole('list', { name: 'Denied — the wall: 3 rules' });
    const ask = screen.getByRole('list', { name: 'Asked — the workflow: 3 rules' });
    const allow = screen.getByRole('list', { name: 'Allowed: 2 rules' });
    expect(chipsOf(deny)).toEqual(GLOBAL.effective.deny);
    expect(chipsOf(ask)).toEqual(GLOBAL.effective.ask);
    expect(chipsOf(allow)).toEqual(GLOBAL.effective.allow);

    // Which layer each list is, said before what it holds.
    expect(region('Denied — the wall')).toHaveTextContent(
      'Evaluated inside the CLI, with no network involved, and measured holding with this console stopped.',
    );
    expect(region('Asked — the workflow')).toHaveTextContent(
      'which FAILS OPEN: with this console not running, the call proceeds unasked.',
    );
    expect(region('Allowed')).toHaveTextContent('Never round-trip to the hook.');

    // This scope's own rules are marked; a shipped deny rule says its removal asks first.
    expect(chip(deny, 'Bash(task nuke:*)')).toHaveAttribute('title', 'Yours, at the global scope');
    expect(chip(deny, 'Bash(git push:*)')).toHaveAttribute(
      'title',
      'Shipped deny rule — the wall at run time. Removing it asks first.',
    );
    expect(chip(ask, 'Bash(git commit:*)')).toHaveAttribute(
      'title',
      'Shipped — removing it strikes it here; Restore defaults brings it back.',
    );
    for (const rule of [...GLOBAL.effective.deny, ...GLOBAL.effective.ask, ...GLOBAL.effective.allow]) {
      expect(screen.getByRole('button', { name: `Remove ${rule}` })).toBeInTheDocument();
    }

    // A struck shipped rule is listed under its list, with its way back.
    expect(region('Denied — the wall')).toHaveTextContent('Shipped rules struck at the global scope:');
    expect(
      within(region('Denied — the wall')).getByRole('button', { name: 'Restore Bash(git reset --hard:*)' }),
    ).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('without --allow-writes shows every rule and offers no edit', async () => {
    await mountRules(false);
    expect(chipsOf(screen.getByRole('list', { name: 'Denied — the wall: 3 rules' }))).toEqual(
      GLOBAL.effective.deny,
    );
    expect(region('Denied — the wall')).toHaveTextContent('Shipped rules struck at the global scope:');
    expect(within(region('Denied — the wall')).getByText('Bash(git reset --hard:*)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Restore/ })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Add a rule' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: /Auto-grant approvals/ })).toBeDisabled();
    expect(screen.getByText(/to edit rules here/)).toHaveTextContent(
      `Start the console with --allow-writes to edit rules here, or edit ${GLOBAL_FILE} directly.`,
    );
    expect(writes()).toEqual([]);
  });
});

describe('striking a rule', () => {
  it('a shipped deny rule asks once, naming the rule and the scope, and is written only on confirm', async () => {
    servePolicy({ after: PUSH_STRUCK });
    await mountRules();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Bash(git push:*)' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove a shipped deny rule?' });
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    expect(dialog).toHaveTextContent(
      'Bash(git push:*) is part of the shipped deny list — the layer enforced inside the CLI, which holds even with this console stopped. Removed at the global scope, every future run, on every profile, may then do it without asking.',
    );
    expect(dialog).toHaveTextContent('Reversible here: the struck rule stays listed with Restore');
    // Asked, not done: nothing goes until the question is answered.
    expect(writes()).toEqual([]);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove it' }));
    await waitFor(() =>
      expect(writes()).toEqual([{ scope: 'global', slug: null, remove: { deny: ['Bash(git push:*)'] } }]),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Removed', 'ok'));
    // The rule left the wall and waits under it, with its way back — and nothing asked twice.
    await waitFor(() =>
      expect(screen.getByRole('list', { name: 'Denied — the wall: 2 rules' })).not.toHaveTextContent(
        'Bash(git push:*)',
      ),
    );
    expect(
      within(region('Denied — the wall')).getByRole('button', { name: 'Restore Bash(git push:*)' }),
    ).toBeInTheDocument();
    expect(writes()).toHaveLength(1);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('Keep the wall answers no: nothing is sent and the rule stays', async () => {
    await mountRules();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Bash(git push:*)' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove a shipped deny rule?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep the wall' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(writes()).toEqual([]);
    expect(toast).not.toHaveBeenCalled();
    expect(chipsOf(screen.getByRole('list', { name: 'Denied — the wall: 3 rules' }))).toContain(
      'Bash(git push:*)',
    );
    expect(screen.getByRole('button', { name: 'Remove Bash(git push:*)' })).toBeEnabled();
  });

  const ONE_PRESS: [string, keyof PolicyLists, string][] = [
    ['a shipped ask rule', 'ask', 'Bash(git commit:*)'],
    ['a shipped allow rule', 'allow', 'Bash(ls:*)'],
    ['a deny rule of the operator’s own', 'deny', 'Bash(task nuke:*)'],
  ];
  it.each(ONE_PRESS)('strikes %s in one press, with no question asked', async (_what, list, rule) => {
    await mountRules();
    fireEvent.click(screen.getByRole('button', { name: `Remove ${rule}` }));
    await waitFor(() =>
      expect(writes()).toEqual([{ scope: 'global', slug: null, remove: { [list]: [rule] } }]),
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Removed', 'ok'));
  });
});

describe('the way back', () => {
  it('Restore brings one struck rule back, and Restore defaults returns a list to stock where this scope holds something', async () => {
    await mountRules();
    // A list this scope has neither added to nor struck from has nothing to restore.
    expect(within(region('Allowed')).queryByRole('button', { name: 'Restore defaults' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Restore Bash(git reset --hard:*)' }));
    await waitFor(() =>
      expect(writes()).toEqual([
        { scope: 'global', slug: null, restore: { deny: ['Bash(git reset --hard:*)'] } },
      ]),
    );
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Brought the shipped rule back', 'ok'));

    const reset = within(region('Denied — the wall')).getByRole('button', { name: 'Restore defaults' });
    await waitFor(() => expect(reset).toBeEnabled());
    fireEvent.click(reset);
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]).toEqual({ scope: 'global', slug: null, reset: ['deny'] });
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Restored deny to the shipped defaults', 'ok'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('the scope', () => {
  it('to one plan: nothing is written until a plan is chosen, and then that plan’s rules are read', async () => {
    await mountRules();
    fireEvent.change(screen.getByRole('combobox', { name: 'These rules apply' }), {
      target: { value: 'plan' },
    });
    const plan = screen.getByRole('combobox', { name: 'Plan' });
    await within(plan).findByRole('option', { name: 'alpha' });
    expect(options(plan)).toEqual(['Choose a plan', 'alpha', 'beta']);

    // No plan, no target: no chip strikes, no restore, no auto-grant, and the builder refuses.
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Restore/ })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    const builder = region('Add a rule');
    expect(within(builder).getByRole('button', { name: 'Add for a plan' })).toBeDisabled();
    expect(builder).toHaveTextContent('Choose a plan first.');
    fireEvent.change(within(builder).getByLabelText('Value'), { target: { value: 'git tag' } });
    fireEvent.keyDown(within(builder).getByLabelText('Value'), { key: 'Enter' });
    expect(writes()).toEqual([]);

    fireEvent.change(plan, { target: { value: 'alpha' } });
    expect(await screen.findByText(PLAN_FILE)).toBeInTheDocument();
    expect(reads()).toEqual(['/api/policy', '/api/policy?slug=alpha']);
    expect(screen.getByText(/The global rules and/)).toHaveTextContent(
      'The global rules and alpha’s own. The global ones are edited from the Everywhere scope.',
    );
    const ask = screen.getByRole('list', { name: 'Asked — the workflow: 3 rules' });
    expect(chipsOf(ask)).toEqual(ALPHA.effective.ask);
    expect(chip(ask, 'Bash(npm run e2e:*)')).toHaveAttribute('title', 'Yours, at the alpha scope');
    // A console-wide rule of the operator's is neither alpha's nor shipped, and says where it is edited.
    expect(chip(ask, 'Bash(task deploy:*)')).toHaveAttribute(
      'title',
      'Yours, for every plan — remove it at the global scope.',
    );
    expect(chip(ask, 'Bash(git commit:*)')).toHaveAttribute(
      'title',
      'Shipped — removing it strikes it here; Restore defaults brings it back.',
    );
    // alpha's own rules and the shipped ones are struck here; the global scope's own are edited there.
    expect(screen.getByRole('button', { name: 'Remove Bash(npm run e2e:*)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Bash(git commit:*)' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Bash(task deploy:*)' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove Bash(task nuke:*)' })).toBeNull();
    // What alpha struck, not what everywhere did.
    expect(region('Asked — the workflow')).toHaveTextContent('Shipped rules struck at the alpha scope:');
    expect(screen.getByRole('button', { name: 'Restore Bash(gh pr create:*)' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore Bash(git reset --hard:*)' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add for alpha' })).toBeInTheDocument();

    // Everywhere again: the global rules, from the read already made.
    fireEvent.change(screen.getByRole('combobox', { name: 'These rules apply' }), {
      target: { value: 'global' },
    });
    expect(await screen.findByText(GLOBAL_FILE)).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Plan' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove Bash(task nuke:*)' })).toBeInTheDocument();
    expect(reads()).toEqual(['/api/policy', '/api/policy?slug=alpha']);
    expect(writes()).toEqual([]);
  });

  it('while a plan’s rules are read the last scope stays drawn, the picker keeps its focus, and nothing can be written', async () => {
    let answer: (view: PolicyView) => void = () => {};
    server.reads['/api/policy'] = () =>
      server.calls[server.calls.length - 1]!.path.endsWith('?slug=alpha')
        ? new Promise<PolicyView>((resolve) => (answer = resolve))
        : GLOBAL;
    await mountRules();
    fireEvent.change(screen.getByRole('combobox', { name: 'These rules apply' }), {
      target: { value: 'plan' },
    });
    const plan = screen.getByRole('combobox', { name: 'Plan' });
    await within(plan).findByRole('option', { name: 'alpha' });
    plan.focus();
    fireEvent.change(plan, { target: { value: 'alpha' } });
    await waitFor(() => expect(reads()).toEqual(['/api/policy', '/api/policy?slug=alpha']));
    // The same picker, still focused, over everywhere's rules — and every write shut until alpha's land.
    expect(screen.getByRole('combobox', { name: 'Plan' })).toBe(plan);
    expect(plan).toHaveFocus();
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
    expect(within(region('Add a rule')).getByRole('button', { name: 'Add for alpha' })).toBeDisabled();
    answer(ALPHA);
    expect(await screen.findByText(PLAN_FILE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Bash(npm run e2e:*)' })).toBeInTheDocument();
    expect(writes()).toEqual([]);
  });

  it('every write at a plan names it — a strike, an add, and the wall’s question at that scope', async () => {
    await mountRules();
    await choosePlan();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Bash(npm run e2e:*)' }));
    await waitFor(() =>
      expect(writes()).toEqual([{ scope: 'plan', slug: 'alpha', remove: { ask: ['Bash(npm run e2e:*)'] } }]),
    );
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Removed for alpha', 'ok'));

    const builder = region('Add a rule');
    fireEvent.change(within(builder).getByLabelText('Value'), { target: { value: 'npm run lint' } });
    const add = within(builder).getByRole('button', { name: 'Add for alpha' });
    await waitFor(() => expect(add).toBeEnabled());
    fireEvent.click(add);
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]).toEqual({ scope: 'plan', slug: 'alpha', add: { ask: ['Bash(npm run lint:*)'] } });
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('Added Bash(npm run lint:*) to ask for alpha', 'ok'),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Bash(sudo:*)' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove a shipped deny rule?' });
    expect(dialog).toHaveTextContent(
      'Removed at the alpha scope, every future run, on every profile, may then do it without asking.',
    );
    expect(writes()).toHaveLength(2);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove it' }));
    await waitFor(() => expect(writes()).toHaveLength(3));
    expect(writes()[2]).toEqual({ scope: 'plan', slug: 'alpha', remove: { deny: ['Bash(sudo:*)'] } });
  });
});

describe('the rule builder', () => {
  it('builds a rule from its form, shows it as it will be written, and adds it to the list chosen', async () => {
    servePolicy({ everywhere: { ...GLOBAL, seen: ['Bash', 'WebSearch'] } });
    await mountRules();
    const builder = region('Add a rule');
    const form = within(builder).getByRole('combobox', { name: 'Form' });
    const to = within(builder).getByRole('combobox', { name: 'To' });
    const preview = within(builder).getByTestId('rule-preview');
    const add = within(builder).getByRole('button', { name: 'Add everywhere' });

    // The first form: a command prefix on Bash, to the ask list.
    expect(form).toHaveValue('prefix');
    expect(within(builder).getByLabelText('Tool')).toHaveValue('Bash');
    expect(to).toHaveValue('ask');
    expect(options(to)).toEqual([
      'deny — never, whatever I press',
      'ask — stop and show me',
      'allow — stop asking about it',
    ]);
    fireEvent.change(within(builder).getByLabelText('Value'), { target: { value: '  git tag ' } });
    expect(preview).toHaveTextContent('Bash(git tag:*)');
    fireEvent.click(add);
    await waitFor(() =>
      expect(writes()).toEqual([{ scope: 'global', slug: null, add: { ask: ['Bash(git tag:*)'] } }]),
    );
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Added Bash(git tag:*) to ask', 'ok'));
    expect(within(builder).getByLabelText('Value')).toHaveValue('');

    // A web domain, to the wall, pressed with Enter.
    await waitFor(() => expect(form).toBeEnabled());
    fireEvent.change(form, { target: { value: 'domain' } });
    expect(within(builder).getByLabelText('Tool')).toHaveValue('WebFetch');
    fireEvent.change(to, { target: { value: 'deny' } });
    fireEvent.change(within(builder).getByLabelText('Value'), { target: { value: '*.example.com' } });
    expect(preview).toHaveTextContent('WebFetch(domain:*.example.com)');
    fireEvent.keyDown(within(builder).getByLabelText('Value'), { key: 'Enter' });
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]).toEqual({
      scope: 'global',
      slug: null,
      add: { deny: ['WebFetch(domain:*.example.com)'] },
    });

    // A whole tool takes no value, and a tool the console was asked about is one press away.
    await waitFor(() => expect(form).toBeEnabled());
    fireEvent.change(form, { target: { value: 'tool' } });
    expect(within(builder).queryByLabelText('Value')).toBeNull();
    expect(builder).toHaveTextContent('Tools this console has been asked about:');
    fireEvent.click(within(builder).getByRole('button', { name: 'WebSearch' }));
    expect(preview).toHaveTextContent(/^WebSearch$/);
    // Allow is the one list that widens, and says so before it is pressed.
    expect(within(builder).getByRole('status')).toHaveTextContent(
      'Adding to deny or ask makes a run more careful.',
    );
    fireEvent.change(to, { target: { value: 'allow' } });
    expect(within(builder).getByRole('status')).toHaveTextContent(
      'This widens what an unattended run may do.',
    );
    expect(within(builder).getByRole('status')).toHaveAttribute('data-severity', 'warn');
    expect(writes()).toHaveLength(2);
  });

  it('refuses an empty rule on the page: nothing to show, nothing to press, and Enter sends nothing', async () => {
    await mountRules();
    const builder = region('Add a rule');
    // A form that asks for a value builds nothing without one — never `Bash(:*)`.
    expect(within(builder).getByRole('combobox', { name: 'Form' })).toHaveValue('prefix');
    expect(within(builder).getByTestId('rule-preview')).toHaveTextContent('—');
    expect(within(builder).getByRole('button', { name: 'Add everywhere' })).toBeDisabled();
    fireEvent.keyDown(within(builder).getByLabelText('Value'), { key: 'Enter' });
    expect(writes()).toEqual([]);
    fireEvent.change(within(builder).getByRole('combobox', { name: 'Form' }), { target: { value: 'free' } });
    // Written whole: no tool field, and the value is the rule.
    expect(within(builder).queryByLabelText('Tool')).toBeNull();
    const rule = within(builder).getByLabelText('Rule');
    expect(rule).toHaveAttribute('placeholder', 'Bash(task deploy:*)');
    const preview = within(builder).getByTestId('rule-preview');
    const add = within(builder).getByRole('button', { name: 'Add everywhere' });
    expect(preview).toHaveTextContent('—');
    expect(add).toBeDisabled();

    fireEvent.change(rule, { target: { value: '   ' } });
    expect(preview).toHaveTextContent('—');
    expect(add).toBeDisabled();
    fireEvent.keyDown(rule, { key: 'Enter' });
    fireEvent.click(add);
    expect(writes()).toEqual([]);

    // Once there is a rule it is shown as it will be written, and may be pressed.
    fireEvent.change(rule, { target: { value: ' Bash(task deploy:*) ' } });
    expect(preview).toHaveTextContent('Bash(task deploy:*)');
    expect(add).toBeEnabled();
    expect(writes()).toEqual([]);
    expect(toast).not.toHaveBeenCalled();
  });

  it('a rule the server refuses is said in the server’s words, and nothing is added', async () => {
    const refused =
      'A rule would never match: Write(./notes.md) (Write(…) path rules are never consulted — only Read(…) and Edit(…) are)';
    server.reads['POST /api/policy'] = new ApiError(refused, 400, '/api/policy', {
      error: refused,
      rules: [{ raw: 'Write(./notes.md)', note: 'Write(…) path rules are never consulted' }],
    });
    await mountRules();
    const builder = region('Add a rule');
    fireEvent.change(within(builder).getByRole('combobox', { name: 'Form' }), { target: { value: 'path' } });
    fireEvent.change(within(builder).getByLabelText('Tool'), { target: { value: 'Write' } });
    fireEvent.change(within(builder).getByLabelText('Value'), { target: { value: './notes.md' } });
    fireEvent.change(within(builder).getByRole('combobox', { name: 'To' }), { target: { value: 'allow' } });
    expect(within(builder).getByTestId('rule-preview')).toHaveTextContent('Write(./notes.md)');
    fireEvent.click(within(builder).getByRole('button', { name: 'Add everywhere' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(refused, 'error'));
    expect(toast).toHaveBeenCalledTimes(1);
    expect(writes()).toEqual([{ scope: 'global', slug: null, add: { allow: ['Write(./notes.md)'] } }]);
    expect(chipsOf(screen.getByRole('list', { name: 'Allowed: 2 rules' }))).toEqual(GLOBAL.effective.allow);
    // The refused rule is still typed, to be corrected rather than typed again.
    expect(within(builder).getByLabelText('Value')).toHaveValue('./notes.md');
  });
});

describe('auto-grant', () => {
  it('everywhere it is on as shipped, and one press turns it off', async () => {
    await mountRules();
    const box = screen.getByRole('checkbox', { name: /Auto-grant approvals \(on as shipped\)/ });
    expect(box).toBeChecked();
    expect(box).toBeEnabled();
    fireEvent.click(box);
    await waitFor(() =>
      expect(writes()).toEqual([{ scope: 'global', slug: null, set: { autoApprove: false } }]),
    );
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Auto-grant off everywhere', 'ok'));
  });

  it('for one plan it is inherit, on or off, and Inherit clears the plan’s own word', async () => {
    servePolicy({ alpha: { ...ALPHA, autoApprove: { global: false, plan: true, effective: true } } });
    await mountRules();
    await choosePlan();
    // The everywhere switch is the global scope's, not this one's.
    expect(screen.queryByRole('checkbox')).toBeNull();
    const auto = screen.getByRole('combobox', { name: 'Auto-grant approvals for alpha' });
    expect(auto).toHaveValue('on');
    expect(options(auto)).toEqual([
      'Inherit (everywhere: off)',
      'On — cards answer themselves',
      'Off — every card waits for a person',
    ]);
    fireEvent.change(auto, { target: { value: '' } });
    await waitFor(() =>
      expect(writes()).toEqual([{ scope: 'plan', slug: 'alpha', set: { autoApprove: null } }]),
    );
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Auto-grant now inherits for alpha', 'ok'));

    await waitFor(() => expect(auto).toBeEnabled());
    fireEvent.change(auto, { target: { value: 'off' } });
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]).toEqual({ scope: 'plan', slug: 'alpha', set: { autoApprove: false } });
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Auto-grant off for alpha', 'ok'));
  });

  it('a server from before auto-grant and the advisories draws neither', async () => {
    servePolicy({ everywhere: OLDER });
    await mountRules();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText(/Auto-grant/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'I have read this' })).toBeNull();
    expect(screen.getByRole('list', { name: 'Denied — the wall: 3 rules' })).toBeInTheDocument();
  });
});

describe('what the server says cannot work', () => {
  it('an advisory not yet read is a banner naming its rules, and I have read this records the receipt', async () => {
    const askEmpty: PolicyAdvisory = {
      kind: 'ask-empty',
      rules: ['Bash(git commit:*)', 'Bash(gh pr create:*)'],
      message:
        'The effective ask list is empty — every shipped ask rule is struck (2), so no run on any profile asks about anything.',
      acknowledged: false,
      fingerprint: 'f-ask',
    };
    const denyStruck: PolicyAdvisory = {
      kind: 'deny-struck',
      rules: ['Bash(git reset --hard:*)'],
      message: '1 shipped deny rule is struck out of the wall that holds with the console dead.',
      acknowledged: true,
      fingerprint: 'f-deny',
    };
    const nothingAsks: PolicyView = {
      ...GLOBAL,
      extra: {
        ...GLOBAL.extra,
        ask: [],
        removed: {
          deny: ['Bash(git reset --hard:*)'],
          ask: ['Bash(git commit:*)', 'Bash(gh pr create:*)'],
          allow: [],
        },
      },
      effective: { ...GLOBAL.effective, ask: [] },
      advisory: [askEmpty, denyStruck],
    };
    let read = false;
    server.reads['/api/policy'] = () =>
      read ? { ...nothingAsks, advisory: [{ ...askEmpty, acknowledged: true }, denyStruck] } : nothingAsks;
    server.reads['POST /api/policy/advisory/acknowledge'] = (body: unknown) => {
      read = true;
      return { ok: true, kind: (body as { kind: string }).kind, advisory: [] };
    };
    await mountRules();
    expect(region('Asked — the workflow')).toHaveTextContent('None.');
    // Only the advisory not yet read is drawn.
    const banner = screen.getByText('Nothing here asks.').closest<HTMLElement>('[role="status"]')!;
    expect(banner).toHaveTextContent(askEmpty.message);
    expect(banner).toHaveTextContent('Bash(git commit:*)');
    expect(banner).toHaveTextContent('Bash(gh pr create:*)');
    expect(screen.queryByText('The deny wall is struck.')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'I have read this' })).toHaveLength(1);

    fireEvent.click(within(banner).getByRole('button', { name: 'I have read this' }));
    await waitFor(() =>
      expect(sent(server, 'POST', '/api/policy/advisory/acknowledge')).toEqual([{ kind: 'ask-empty' }]),
    );
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('Acknowledged — it comes back if the rules change.', 'ok'),
    );
    // Read again, it is gone — and a receipt is no edit.
    await waitFor(() => expect(screen.queryByText('Nothing here asks.')).toBeNull());
    expect(writes()).toEqual([]);
  });

  it('names the rules that parse and do nothing, the wrappers not seen through, and the tools the hook reaches', async () => {
    servePolicy({
      everywhere: {
        ...GLOBAL,
        inert: [
          { raw: 'Write(./notes.md)', note: 'Write(…) path rules are never consulted' },
          { raw: 'Bash(command:rm *)', note: 'Bash(command:…) is not a rule Claude Code honours' },
        ],
      },
    });
    await mountRules();
    const inert = screen.getByText('These parse and do nothing.').closest<HTMLElement>('[role="status"]')!;
    expect(inert).toHaveTextContent('Write(./notes.md) — Write(…) path rules are never consulted');
    expect(inert).toHaveTextContent('Bash(command:rm *) — Bash(command:…) is not a rule Claude Code honours');

    const fold = screen.getByRole('button', {
      name: 'How these are evaluated — the parts that surprise people',
    });
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(fold);
    expect(screen.getByText(/Wrappers are seen through/)).toHaveTextContent(
      'Not npx docker exec — a rule about what those run will not fire.',
    );
    expect(screen.getByText(/reach this console’s hook/)).toHaveTextContent(
      'Only Bash Edit WebFetch reach this console’s hook.',
    );
  });
});

describe('the owner door', () => {
  it('a write the owner door only wrote down is said in the server’s words, never as done', async () => {
    const asked: AuthorityRequest = {
      id: 'q-1',
      at: '2026-10-12T09:00:00.000Z',
      state: 'open',
      door: 'device',
      label: 'iPhone',
      press: 'policy-widen',
      authority: 'policy-widen',
      risk: 'high',
      method: 'POST',
      path: '/api/policy',
      body: { scope: 'global', slug: null, remove: { deny: ['Bash(git push:*)'] } },
      summary: 'strike Bash(git push:*) from the deny wall',
      item: null,
      repeats: 0,
      ask: 'asked by iPhone through device — strike Bash(git push:*) from the deny wall — confirm?',
    };
    server.reads['POST /api/policy'] = {
      requested: true,
      request: asked,
      error: 'Asked of the owner: confirm it on Your turn.',
    };
    await mountRules();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Bash(git push:*)' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove it' }),
    );

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('Asked of the owner: confirm it on Your turn.', 'info', 6000),
    );
    expect(toast).toHaveBeenCalledTimes(1);
    expect(writes()).toEqual([{ scope: 'global', slug: null, remove: { deny: ['Bash(git push:*)'] } }]);
    // Nothing was done: the wall still holds the rule, and it can still be struck.
    expect(chipsOf(screen.getByRole('list', { name: 'Denied — the wall: 3 rules' }))).toContain(
      'Bash(git push:*)',
    );
    expect(await screen.findByRole('button', { name: 'Remove Bash(git push:*)' })).toBeEnabled();
  });
});
