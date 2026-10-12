/**
 * The relay's rule table (quiet-console phase 21; zero-touch phase 14's
 * editor): rules read from the settings schema and saved WHOLE through
 * `POST /api/prefs` — a rule needs a key and an answer, a rule with the same
 * key and profile replaces the old one, a removal takes it out of the list
 * that is written, and nothing ships.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Call } from './test-kit';

const server = vi.hoisted(() => ({ reads: {} as Record<string, unknown>, calls: [] as Call[] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);

import { renderWithClient, schemaAnswer, sent } from './test-kit';
import { RelayRulesEditor } from './relay-rules';

function serve(relayRules?: unknown) {
  const held: Record<string, unknown> = relayRules === undefined ? {} : { relayRules };
  server.reads['/api/prefs/schema'] = () =>
    schemaAnswer('relayRules' in held ? { relayRules: { value: held.relayRules, source: 'instance' } } : {});
  server.reads['POST /api/prefs'] = (body: unknown) => {
    Object.assign(held, body as Record<string, unknown>);
    return { ok: true };
  };
}

/** The list the last save sent. */
const saved = () => (sent(server, 'POST', '/api/prefs').at(-1) as { relayRules: unknown }).relayRules;

beforeEach(() => {
  server.calls = [];
  server.reads = {};
});

describe('<RelayRulesEditor>', () => {
  it('adds a rule with its key, its answer and its profile, written whole', async () => {
    serve();
    const { container } = renderWithClient(<RelayRulesEditor />);
    expect(await screen.findByText(/No rules ship/)).toBeTruthy();
    expect(container.querySelectorAll('[data-pref="relayRules"]')).toHaveLength(1);
    const add = screen.getByRole('button', { name: 'Add rule' });
    expect(add).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Question key'), { target: { value: 'colour:*' } });
    expect(add).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Answer'), { target: { value: 'Blue' } });
    fireEvent.change(screen.getByLabelText('On runs of'), { target: { value: 'trusted' } });
    fireEvent.click(add);
    await waitFor(() => expect(sent(server, 'POST', '/api/prefs')).toHaveLength(1));
    expect(saved()).toEqual([
      {
        id: 'AskUserQuestion:colour:*:trusted',
        tool: 'AskUserQuestion',
        key: 'colour:*',
        profile: 'trusted',
        answer: 'Blue',
      },
    ]);
    // The form empties for the next rule, and the rule is listed in words.
    expect((screen.getByLabelText('Question key') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Answer') as HTMLInputElement).value).toBe('');
    await waitFor(() =>
      expect(container.querySelector('[data-relay-rule]')?.textContent).toContain('on trusted runs'),
    );
  });

  it('a rule for a key and profile already ruled replaces the old one', async () => {
    serve([{ key: 'colour:*', answer: 'Blue' }]);
    renderWithClient(<RelayRulesEditor />);
    expect(await screen.findByText('colour:*')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Question key'), { target: { value: 'colour:*' } });
    fireEvent.change(screen.getByLabelText('Answer'), { target: { value: 'Red' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    await waitFor(() => expect(sent(server, 'POST', '/api/prefs')).toHaveLength(1));
    expect(saved()).toEqual([
      {
        id: 'AskUserQuestion:colour:*:*',
        tool: 'AskUserQuestion',
        key: 'colour:*',
        profile: '*',
        answer: 'Red',
      },
    ]);
  });

  it('removes a rule by writing the list without it', async () => {
    serve([
      { key: 'colour:*', answer: 'Blue' },
      { key: 'port:*', answer: '8080', profile: 'guarded' },
    ]);
    renderWithClient(<RelayRulesEditor />);
    expect(await screen.findByText('colour:*')).toBeTruthy();
    expect(screen.getByText('on guarded runs')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove the rule for colour:*' }));
    await waitFor(() => expect(sent(server, 'POST', '/api/prefs')).toHaveLength(1));
    expect(saved()).toEqual([
      {
        id: 'AskUserQuestion:port:*:guarded',
        tool: 'AskUserQuestion',
        key: 'port:*',
        profile: 'guarded',
        answer: '8080',
      },
    ]);
  });
});
