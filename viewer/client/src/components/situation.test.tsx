/**
 * The situation renderer: the label, the blurb, the deciding sentences and
 * the evidence lines all show; compact shows the chip only; null renders
 * nothing. And the client's vocabulary is the shared one.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SituationSummary } from './situation';
import { SITUATIONS, SITUATION_LABELS, situationLabel } from '@/lib/situation';
import { SITUATIONS as SHARED } from '@shared/situation-model.js';

const NEVER_STARTED = {
  id: 'never-started',
  key: 'never-started',
  label: 'Never started',
  actor: 'machine',
  blurb:
    'No handoff, nothing on disk, a session that ended before it began. The phase re-boards fresh — no closeout, no person.',
  why: ['no handoff exists', 'web-admin: clean tree, 0 commits since the phase started'],
};

describe('SituationSummary', () => {
  it('names the situation, says who acts, lists why, and folds the evidence', () => {
    render(
      <SituationSummary
        situation={NEVER_STARTED}
        evidence={['board: ready', 'handoff: none', 'lock: free']}
      />,
    );
    expect(screen.getByText('Never started')).toBeTruthy();
    expect(screen.getByText(/the autopilot climbs its ladder/)).toBeTruthy();
    expect(screen.getByText(/re-boards fresh/)).toBeTruthy();
    const why = screen.getByTestId('situation-why');
    expect(why.textContent).toContain('no handoff exists');
    expect(why.textContent).toContain('clean tree');
    expect(screen.getByText(/Evidence it read \(3\)/)).toBeTruthy();
    expect(screen.getByTestId('situation-evidence').textContent).toContain('lock: free');
  });

  it('shows the sub-kind in the key and a person-shaped actor', () => {
    render(
      <SituationSummary
        situation={{
          id: 'blocked-declared',
          sub: 'credential',
          key: 'blocked-declared:credential',
          label: situationLabel('blocked-declared', 'credential'),
          actor: 'person',
          blurb: 'b',
          why: [],
        }}
      />,
    );
    expect(screen.getByText('Declared blocked · credential')).toBeTruthy();
    expect(screen.getByText('blocked-declared:credential')).toBeTruthy();
    expect(screen.getByText(/a person is needed/)).toBeTruthy();
  });

  it('compact renders the chip alone; null renders nothing', () => {
    const { container } = render(<SituationSummary situation={NEVER_STARTED} evidence={['x']} compact />);
    expect(container.querySelector('[data-testid="situation-why"]')).toBeNull();
    expect(container.querySelector('details')).toBeNull();
    const { container: empty } = render(<SituationSummary situation={null} />);
    expect(empty.innerHTML).toBe('');
  });

  it('speaks the shared vocabulary', () => {
    expect(SITUATIONS).toBe(SHARED);
    for (const id of SITUATIONS) expect(SITUATION_LABELS[id].length).toBeGreaterThan(2);
  });

  it('a usage wall read now stands in for the line the classifier quoted from the park — never both (control-tower phase 86, #78)', () => {
    render(
      <SituationSummary
        situation={{
          id: 'resource-wall',
          sub: 'usage',
          key: 'resource-wall:usage',
          label: situationLabel('resource-wall', 'usage'),
          actor: 'wait',
          blurb: 'A usage wall.',
          why: ['a usage limit: checkpointed at the park — resets in 14 min', 'the run is waiting'],
        }}
        wall={{
          latest: '2026-09-25T12:50:00.000Z',
          reset: true,
          sentence: 'the usage window reset at 12:50Z — waiting for demo P20 (grant)',
          lastReading: {
            at: '2026-09-25T12:40:00.000Z',
            by: 'reading',
            ok: false,
            resetsAt: '2026-09-25T12:50:00.000Z',
          },
        }}
      />,
    );
    expect(screen.queryByText(/checkpointed at the park/)).toBeNull();
    expect(screen.getByText(/the usage window reset at 12:50Z — waiting for demo P20/)).toBeTruthy();
    expect(screen.getByTestId('situation-why').textContent).toContain('the run is waiting');
    expect(screen.getByTestId('situation-wall').textContent).toContain('by reading');
  });
});
