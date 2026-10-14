/**
 * The one command block (turn-by-turn phase 8):
 *
 *   CB-1 a command reads left to right in any page, scrolls in its own focusable,
 *        named box, and offers Copy and Copy for Claude Code — never a way to run it;
 *   CB-2 a command holding a `<placeholder>` is a template: it says what to fill
 *        in first, marks each placeholder, and offers no plain Copy;
 *   CB-3 a shell redirect is never read as a placeholder;
 *   CB-4 no axe violation.
 */

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '@/test/axe';
import { CodeBlock, claudeCodeCommand, fillInWords, placeholdersOf } from './code-block';

describe('CB-1 a command', () => {
  it('left to right, focusable and named, with its two copies', () => {
    render(<CodeBlock code="gh auth status" />);
    const pre = screen.getByTestId('code-block');
    expect(pre.getAttribute('dir')).toBe('ltr');
    expect(pre.getAttribute('tabindex')).toBe('0');
    expect(pre.getAttribute('aria-label')).toBe('Command');
    const block = screen.getByTestId('code-block-block');
    expect(within(block).getByRole('button', { name: 'Copy' })).toBeTruthy();
    expect(within(block).getByRole('button', { name: 'Copy for Claude Code' })).toBeTruthy();
    expect(within(block).queryByRole('button', { name: /run/i })).toBeNull();
    expect(claudeCodeCommand('  gh auth status ')).toBe('!gh auth status');
  });

  it('a surface keeps its own test id and its own copy label', () => {
    render(
      <CodeBlock
        code="tailscale serve 443"
        testId="reach-command"
        copyLabel="Copy the serve command"
        claudeCode={false}
      />,
    );
    expect(screen.getByTestId('reach-command').textContent).toBe('tailscale serve 443');
    expect(screen.getByRole('button', { name: 'Copy the serve command' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy for Claude Code' })).toBeNull();
  });
});

describe('CB-2 a template', () => {
  it('says what to fill in, marks it, and offers no plain Copy', () => {
    render(<CodeBlock code="bash <skill>/start --root <repo> --remote <name>.ts.net" />);
    expect(screen.getByTestId('code-template').textContent).toBe('Fill in <skill>, <repo> and <name> first.');
    expect(
      screen.getAllByText(/^<(skill|repo|name)>$/).every((el) => el.hasAttribute('data-placeholder')),
    ).toBe(true);
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy for Claude Code' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy the template' })).toBeTruthy();
    expect(screen.getByTestId('code-block-block').getAttribute('data-template')).toBe('true');
  });

  it('names each placeholder once, in order', () => {
    expect(placeholdersOf('x <a> <b> <a>')).toEqual(['a', 'b']);
    expect(fillInWords(['token'])).toBe('Fill in <token> first.');
  });
});

describe('CB-3 a redirect is not a placeholder', () => {
  it('reads `< file`, `2>&1` and `<<EOF` as the shell does', () => {
    expect(placeholdersOf('sort < input.txt 2>&1 > out.txt')).toEqual([]);
    expect(placeholdersOf('cat <<EOF')).toEqual([]);
  });
});

describe('CB-4 axe', () => {
  it('a command and a template have no violation', async () => {
    const { container } = render(
      <>
        <CodeBlock code="gh auth status" />
        <CodeBlock code="gh auth login --hostname <host>" testId="other" />
      </>,
    );
    await expectNoAxeViolations(container);
  });
});
