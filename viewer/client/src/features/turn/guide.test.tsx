/**
 * The guide an item carries, drawn (control-tower phase 137, #214, §Architecture
 * 19 "Language"). The grammar is `shared/guide-grammar.js` — ONE parser; this is
 * the page's drawing of what it parsed.
 *
 *   G-1 the why, then every step numbered with its tick, its command, what to
 *       expect, a warning and a link — then "If it goes wrong";
 *   G-2 a command is copied two ways — as it is, and behind `!` for a person's
 *       own Claude Code session — and the page never runs it;
 *   G-3 a link shows its full address before it opens, and opens away from
 *       the console;
 *   G-4 a tick is the person's own mark: it stays across a reload, per item;
 *   G-5 a guide carries its language — a right-to-left one is drawn `dir="rtl"`
 *       with its commands, refs and numbers isolated left-to-right;
 *   G-6 a guide stored as text is read through the one grammar, and one the
 *       grammar refuses is not drawn as if it were a guide.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseGuide, type Guide } from '@shared/guide-grammar.js';
import { GuideView, claudeCodeCommand, guideOf } from './guide';

const TEXT = `The release pushes as you, so only you can sign the CLI in.

## Steps
1. Sign the gh CLI in
   \`\`\`sh
   gh auth login --web
   \`\`\`
   Expect: a browser opens on github.com/login/device
   Warning: never paste the one-time code anywhere but that page
   Link: [GitHub's sign-in help](https://docs.github.com/en/get-started/sign-in)
2. Check it took
   \`\`\`sh
   gh auth status
   \`\`\`
   Expect: Logged in to github.com

## If it goes wrong
- The browser never opens — run \`gh auth login\` without --web and follow the prompts
`;

const PERSIAN = `انتشار به نام شما انجام می‌شود، پس فقط خودتان می‌توانید وارد شوید.

## Steps
1. ورود به gh را انجام دهید
   \`\`\`sh
   gh auth login --web
   \`\`\`
   Expect: مرورگر صفحهٔ github.com/login/device را باز می‌کند
2. نتیجه را با \`gh auth status\` بررسی کنید
`;

function parsed(text: string, lang = 'en'): Guide {
  const read = parseGuide(text, { lang });
  if (!read.ok) throw new Error(read.error);
  return read.guide;
}

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.localStorage.clear();
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('G-1 the guide, whole', () => {
  it('draws the why, the numbered steps with every field, and what to do when it goes wrong', () => {
    render(<GuideView guide={parsed(TEXT)} itemId="s1" />);
    const guide = screen.getByTestId('turn-guide');
    expect(within(guide).getByTestId('guide-why').textContent).toContain('only you can sign the CLI in');
    const steps = within(guide).getAllByTestId('guide-step');
    expect(steps).toHaveLength(2);
    expect(within(steps[0]!).getByTestId('guide-step-number').textContent).toBe('1');
    expect(within(steps[0]!).getByTestId('guide-step-text').textContent).toBe('Sign the gh CLI in');
    expect(within(steps[0]!).getByTestId('guide-command').textContent).toContain('gh auth login --web');
    expect(within(steps[0]!).getByTestId('guide-expect').textContent).toContain(
      'a browser opens on github.com/login/device',
    );
    expect(within(steps[0]!).getByTestId('guide-warning').textContent).toContain(
      'never paste the one-time code',
    );
    expect(within(steps[0]!).getByRole('link', { name: /GitHub's sign-in help/ })).toBeTruthy();
    expect(within(steps[1]!).getByTestId('guide-expect').textContent).toContain('Logged in to github.com');
    // Each step's tick names the step it marks.
    expect(within(steps[0]!).getByRole('checkbox', { name: /Step 1 done/ })).toBeTruthy();
    const trouble = within(guide).getByTestId('guide-trouble');
    expect(within(trouble).getByRole('heading', { name: 'If it goes wrong' })).toBeTruthy();
    expect(trouble.textContent).toContain('The browser never opens');
    expect(trouble.textContent).toContain('without --web');
  });
});

describe('G-2 a command is copied two ways, and never run', () => {
  it('copies it plain, and with the ! prefix for Claude Code', async () => {
    render(<GuideView guide={parsed(TEXT)} itemId="s1" />);
    const first = screen.getAllByTestId('guide-step')[0]!;
    fireEvent.click(within(first).getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('gh auth login --web'));
    fireEvent.click(within(first).getByRole('button', { name: 'Copy for Claude Code' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('!gh auth login --web'));
    expect(claudeCodeCommand('gh auth status')).toBe('!gh auth status');
    expect(claudeCodeCommand('  gh auth status  ')).toBe('!gh auth status');
  });

  it('offers no way to run a command from the page', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    render(<GuideView guide={parsed(TEXT)} itemId="s1" />);
    for (const button of screen.getAllByRole('button')) fireEvent.click(button);
    expect(screen.queryByRole('button', { name: /run/i })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('G-3 a link shows where it goes before it goes', () => {
  it('prints the whole address beside its label, and opens away from the console', () => {
    render(<GuideView guide={parsed(TEXT)} itemId="s1" />);
    const link = screen.getByRole('link', { name: /GitHub's sign-in help/ });
    expect(link.getAttribute('href')).toBe('https://docs.github.com/en/get-started/sign-in');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByTestId('guide-link-address').textContent).toBe(
      'https://docs.github.com/en/get-started/sign-in',
    );
  });
});

describe('G-4 a tick is the person’s own mark', () => {
  it('stays across a reload, for that item only', () => {
    const view = render(<GuideView guide={parsed(TEXT)} itemId="s1" />);
    const tick = screen.getByRole('checkbox', { name: /Step 1 done/ }) as HTMLInputElement;
    expect(tick.checked).toBe(false);
    fireEvent.click(tick);
    expect(tick.checked).toBe(true);
    expect(screen.getAllByTestId('guide-step')[0]!.getAttribute('data-done')).toBe('true');
    view.unmount();
    render(<GuideView guide={parsed(TEXT)} itemId="s1" />);
    expect((screen.getByRole('checkbox', { name: /Step 1 done/ }) as HTMLInputElement).checked).toBe(true);
    view.unmount();
  });

  it('another item starts with no ticks', () => {
    window.localStorage.setItem('turn:ticks:s1', '[0]');
    render(<GuideView guide={parsed(TEXT)} itemId="s2" />);
    expect((screen.getByRole('checkbox', { name: /Step 1 done/ }) as HTMLInputElement).checked).toBe(false);
  });
});

describe('G-5 a guide carries its language', () => {
  it('draws a Persian guide right-to-left, its commands, refs and numbers isolated left-to-right', () => {
    render(<GuideView guide={parsed(PERSIAN, 'fa')} itemId="s-fa" />);
    const guide = screen.getByTestId('turn-guide');
    expect(guide.getAttribute('dir')).toBe('rtl');
    expect(guide.getAttribute('lang')).toBe('fa');
    // The command block reads left-to-right inside the right-to-left guide.
    for (const block of within(guide).getAllByTestId('guide-command')) {
      expect(block.getAttribute('dir')).toBe('ltr');
    }
    // An inline command in a step's words is isolated too.
    const inline = within(screen.getAllByTestId('guide-step')[1]!).getByText('gh auth status');
    expect(inline.tagName).toBe('CODE');
    expect(inline.getAttribute('dir')).toBe('ltr');
    // A ref in an Expect line, and each step's number, are isolated runs.
    expect(within(guide).getAllByTestId('guide-step-number')[0]!.getAttribute('dir')).toBe('ltr');
    const expectLine = within(guide).getByTestId('guide-expect');
    expect(expectLine.querySelector('bdi[dir="ltr"]')?.textContent).toBe('github.com/login/device');
  });

  it('draws an English guide left-to-right', () => {
    render(<GuideView guide={parsed(TEXT)} itemId="s1" />);
    expect(screen.getByTestId('turn-guide').getAttribute('dir')).toBe('ltr');
  });
});

describe('G-6 the one grammar reads a stored guide', () => {
  it('takes a parsed guide as it is, reads a text one, and refuses what the grammar refuses', () => {
    const guide = parsed(TEXT);
    expect(guideOf(guide)).toBe(guide);
    expect(guideOf({ text: PERSIAN, lang: 'fa' })?.dir).toBe('rtl');
    expect(guideOf(TEXT)?.steps).toHaveLength(2);
    expect(guideOf('## Nonsense\nnot a guide')).toBeNull();
    expect(guideOf(undefined)).toBeNull();
    expect(guideOf({ lang: 'en' })).toBeNull();
  });
});
