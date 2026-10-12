/**
 * Settings ▸ Essentials (quiet-console phase 21): every datum the 6.x section
 * showed, in the 7.0 grammar — groups between hairlines, facts in two columns,
 * a status as a word, no middle-dot string, a machine value in the mono face.
 *
 * What it holds, group by group: the source (its directory as `~/…`, the plan
 * and handoff counts, the branch and how far it is from its upstream in words,
 * the uncommitted files with the rest one press away, the indexed sections,
 * and the way to the picker); what this console may do (every switch the start
 * command composes, On or Off as a word, what it unlocks, the section that uses
 * it, and the three answers to "does it run work by itself"); the start command
 * and the launcher (their own tests hold them); the engine (the scripts, the
 * weights and budgets as words); and the keys.
 */

import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Call } from './test-kit';

const server = vi.hoisted(() => ({ reads: {} as Record<string, unknown>, calls: [] as Call[] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);

import type { ConsoleState, LauncherPlanView } from '@/data/api';
import { CAPABILITIES } from '@/lib/start-command';
import { settingsHref, sourceHref } from '@/shell/routes';
import { expectNoAxeViolations } from '@/test/axe';
import { EssentialsSection } from './essentials';
import { renderWithClient } from './test-kit';

const HOME = '/home/testperson';

const STATE: ConsoleState = {
  platform: 'darwin',
  home: HOME,
  port: 4123,
  scriptsDir: `${HOME}/.claude/skills/phased-execution/scripts`,
  root: { path: `${HOME}/code/my-repo`, ok: true, label: 'my-repo', planCount: 12, handoffCount: 3 },
  repo: { available: true, branch: 'main', ahead: 3, behind: 1, dirty: [] },
  searchDocs: 418,
  sizing: { S: 30_000, M: 60_000, L: 120_000, budgetBig: 1_000_000, budgetHaiku: 160_000 },
  allowWrites: true,
  allowRun: true,
  allowTerminal: false,
  allowAgent: true,
  allowAccounts: false,
  allowMcp: true,
  allowWebhooks: false,
  autopilot: true,
  supervisor: { supervised: true },
};

const LAUNCHER: LauncherPlanView = {
  platform: 'darwin',
  supported: false,
  note: 'Start this console from a shell with `./start`, or keep a terminal tab on it.',
  rootOpen: true,
  fullFlags: [],
};

const mount = () => renderWithClient(<EssentialsSection />);
/** The section once the state has answered: its first group is on screen. */
const ready = () => screen.findByRole('heading', { name: 'Source' });
const group = (id: string) => document.querySelector<HTMLElement>(`[data-settings-group="${id}"]`)!;

beforeEach(() => {
  server.calls = [];
  server.reads = { '/api/state': STATE, '/api/launcher': LAUNCHER };
});

describe('the section', () => {
  it('is busy, and says so, until the state answers', () => {
    server.reads['/api/state'] = () => new Promise(() => {});
    mount();
    expect(screen.getByTestId('essentials-loading')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('heading', { name: 'Source' })).toBeNull();
  });

  it('draws its six groups in the order the questions arrive in, and no title of its own', async () => {
    mount();
    await ready();
    const titles = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
    expect(titles).toEqual([
      'Source',
      'What this console may do',
      'Start command',
      'Desktop launcher',
      'Engine',
      'Keyboard',
    ]);
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  it('writes no middle-dot string, no uppercase label, and no absolute home path', async () => {
    const { container } = mount();
    await ready();
    expect(container.textContent).not.toContain('·');
    expect(container.textContent).not.toContain(HOME);
    expect(container.querySelector('.uppercase')).toBeNull();
  });

  it('has no axe violation', async () => {
    const { container } = mount();
    await ready();
    await screen.findByTestId('launcher-unsupported');
    await expectNoAxeViolations(container);
  });
});

describe('Source', () => {
  it('names the directory from home, the counts, the branch and its drift in words, and the index', async () => {
    mount();
    await ready();
    const source = within(group('source'));
    expect(source.getByText('~/code/my-repo')).toHaveAttribute('title', `${HOME}/code/my-repo`);
    expect(source.getByText('Plans').nextElementSibling).toHaveTextContent('12 files in docs/plans');
    expect(source.getByText('Handoff folders').nextElementSibling).toHaveTextContent('3');
    expect(source.getByText('main').tagName).toBe('CODE');
    expect(source.getByText('3 ahead, 1 behind')).toBeInTheDocument();
    expect(source.getByText('Uncommitted under docs/').nextElementSibling).toHaveTextContent('None');
    expect(source.getByText('Indexed sections').nextElementSibling).toHaveTextContent('418');
  });

  it('goes to the source picker through its own address', async () => {
    mount();
    await ready();
    expect(screen.getByRole('link', { name: 'Change source' })).toHaveAttribute('href', sourceHref());
  });

  it('says a branch level with its upstream as the branch alone, and a directory with no git as such', async () => {
    server.reads['/api/state'] = {
      ...STATE,
      repo: { available: true, branch: 'pe/quiet', ahead: 0, behind: 0 },
    };
    const first = mount();
    await ready();
    expect(within(group('source')).getByText('Repository').nextElementSibling).toHaveTextContent(
      /^pe\/quiet$/,
    );
    first.unmount();

    server.reads['/api/state'] = { ...STATE, repo: { available: false } };
    mount();
    await ready();
    expect(within(group('source')).getByText('Not a git repository')).toBeInTheDocument();
  });

  it('names the first six uncommitted files and keeps the rest one press away', async () => {
    const dirty = Array.from({ length: 9 }, (_, i) => `docs/plans/plan-${i + 1}.md`);
    server.reads['/api/state'] = { ...STATE, repo: { ...STATE.repo, dirty } };
    mount();
    await ready();
    const uncommitted = screen.getByTestId('uncommitted');
    for (const file of dirty.slice(0, 6)) expect(within(uncommitted).getByText(file).tagName).toBe('CODE');
    expect(within(uncommitted).queryByText('docs/plans/plan-7.md')).toBeNull();

    fireEvent.click(within(uncommitted).getByRole('button', { name: /3 more files/ }));
    for (const file of dirty.slice(6)) expect(within(uncommitted).getByText(file)).toBeInTheDocument();
  });
});

describe('What this console may do', () => {
  it('draws every switch the start command composes, On or Off as a word, with what it unlocks', async () => {
    mount();
    await ready();
    const lines = group('capabilities').querySelectorAll('[data-capability]');
    expect([...lines].map((line) => line.getAttribute('data-capability'))).toEqual(
      CAPABILITIES.map(([, flag]) => flag),
    );
    for (const [field, flag] of CAPABILITIES) {
      const line = group('capabilities').querySelector<HTMLElement>(`[data-capability="${flag}"]`)!;
      const on = STATE[field] === true;
      expect(within(line).getByText(on ? 'On' : 'Off')).toBeInTheDocument();
      expect(within(line).getByText(flag).tagName).toBe('CODE');
      // What it unlocks is a sentence, never the flag again.
      expect(line.querySelector('p')?.textContent).toMatch(/^[A-Z].+\.$/);
    }
    const writes = group('capabilities').querySelector('[data-capability="--allow-writes"]')!;
    expect(writes).toHaveTextContent('Never commits or pushes.');
  });

  it('links each switch to the section that uses it, by name and without an arrow', async () => {
    mount();
    await ready();
    const capabilities = within(group('capabilities'));
    const links: [string, string][] = [
      ['Open Automation', 'automation'],
      ['Open Accounts', 'accounts'],
      ['Open MCP servers', 'mcp'],
      ['Open Notifications', 'notifications'],
    ];
    for (const [name, section] of links) {
      expect(capabilities.getByRole('link', { name })).toHaveAttribute('href', settingsHref(section));
    }
    expect(group('capabilities').textContent).not.toMatch(/[→›»]/);
  });

  it('says a console with --allow-run and the loop on boards phases by itself', async () => {
    mount();
    await ready();
    const said = screen.getByTestId('runs-by-itself');
    expect(said).toHaveTextContent(/^This console boards phases by itself/);
    expect(within(said).getByRole('link', { name: 'Automation' })).toHaveAttribute(
      'href',
      settingsHref('automation'),
    );
  });

  it('says a console with the loop off boards nothing without a press', async () => {
    server.reads['/api/state'] = { ...STATE, autopilot: false };
    mount();
    await ready();
    expect(screen.getByTestId('runs-by-itself')).toHaveTextContent(
      'Sessions may be spawned, but the convergence loop is off (--no-converge), so nothing boards without a press.',
    );
  });

  it('says a console without --allow-run runs nothing by itself', async () => {
    server.reads['/api/state'] = { ...STATE, allowRun: false };
    mount();
    await ready();
    expect(screen.getByTestId('runs-by-itself')).toHaveTextContent(
      'This console runs nothing by itself. Automation holds what it would obey with --allow-run.',
    );
  });

  it('says when a switch takes effect', async () => {
    mount();
    await ready();
    expect(group('capabilities')).toHaveTextContent('Decided at launch.');
    expect(group('capabilities')).toHaveTextContent(
      'A switch changes nothing until the console restarts with it.',
    );
  });
});

describe('Engine and Keyboard', () => {
  it('names the scripts from home, and the weights and budgets as separate figures', async () => {
    mount();
    await ready();
    const engine = within(group('engine'));
    expect(engine.getByText('~/.claude/skills/phased-execution/scripts').tagName).toBe('CODE');
    const weights = engine.getByText('Phase weights').nextElementSibling!;
    // Three figures, each its own word — never one string glued with dots.
    expect([...weights.querySelectorAll(':scope > span > span')].map((figure) => figure.textContent)).toEqual(
      ['S 30K', 'M 60K', 'L 120K'],
    );
    const budgets = engine.getByText('Session budgets').nextElementSibling!;
    expect(budgets).toHaveTextContent('1M-class 1.0M');
    expect(budgets).toHaveTextContent('200K-class 160K');
    expect(group('engine')).toHaveTextContent(
      'Status, session batches, boot prompts and lint always come from these scripts.',
    );
  });

  it('says not reported rather than a row of zeros when the engine sent no sizing', async () => {
    server.reads['/api/state'] = { ...STATE, sizing: undefined, scriptsDir: undefined };
    mount();
    await ready();
    expect(within(group('engine')).getAllByText('Not reported')).toHaveLength(3);
  });

  it('names the keys the help sheet lists, as keycaps', async () => {
    mount();
    await ready();
    const keyboard = group('keyboard');
    expect([...keyboard.querySelectorAll('kbd')].map((key) => key.textContent)).toEqual([
      '⌘',
      'K',
      '/',
      '⌘',
      'I',
      'Esc',
      '←',
      '→',
    ]);
    expect(keyboard).toHaveTextContent('Search and commands');
    expect(keyboard).toHaveTextContent('The same, without a modifier');
    expect(keyboard).toHaveTextContent('Open or close the panel’s Details');
    expect(keyboard).toHaveTextContent('Close a dialog, a sheet, the palette, the bell or the help sheet');
    expect(keyboard).toHaveTextContent('Widen or narrow the panel from its focused edge');
  });
});
