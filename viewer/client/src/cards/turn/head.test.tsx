/**
 * The card's head under the title rule (#377):
 *
 *   TH-1 the plan's errand ref is a chip beside the title, never in it;
 *   TH-2 the act's whole words show beneath a title the composer had to cut,
 *        and nothing more when the title says it all;
 *   TH-3 a landing errand's files fold under *Details*, counted by repository
 *        ("12 files in aws · 3 in web"), each repository's paths
 *        listed when opened, with one copy of them all.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { TurnItem } from '@/data/api';
import { expectNoAxeViolations } from '@/test/axe';
import { Head, filesWords } from './head';

function item(over: Partial<TurnItem> = {}): TurnItem {
  return {
    item: 's1',
    record: 'projected',
    source: 'plan',
    kind: 'operator-act',
    why: 'reserved',
    proofType: 'attest',
    group: 'now',
    rows: ['row-1'],
    title: 'Enter Feed B’s investor-password data account',
    need: '',
    how: '',
    severity: 'needs-you',
    slug: 'demo',
    phase: 0,
    since: '2026-10-13T09:00:00.000Z',
    href: '/plan/demo',
    actions: [],
    type: 'do',
    personStatus: 'todo',
    readiness: 'now',
    ...over,
  } as TurnItem;
}

function head(over: Partial<TurnItem> = {}) {
  const it = item(over);
  return render(<Head item={it} titleId="t1" title={it.title} />);
}

describe('TH-1 the errand ref is a chip', () => {
  it('draws E-4 beside the title, and the title carries no ref', () => {
    head({ errandRef: 'E-4' });
    expect(screen.getByTestId('turn-title').textContent).toBe(
      'Enter Feed B’s investor-password data account',
    );
    expect(screen.getByTestId('turn-errand-ref').textContent).toBe('E-4');
  });

  it('draws no chip on an item with no ref', () => {
    head();
    expect(screen.queryByTestId('turn-errand-ref')).toBeNull();
  });
});

describe('TH-2 the whole words beneath a cut title', () => {
  it('shows the headline when the title had to cut it', () => {
    const headline =
      'Ai-builder-e2e-fixes-r3 — pe/ai-builder-e2e-fixes-r3 in `aws` holds changes origin/main does not hold: contracts/api/app.ts';
    head({ title: 'Ai-builder-e2e-fixes-r3 — pe/ai-builder-e2e-fixes-r3 in `aws` holds changes…', headline });
    expect(screen.getByTestId('turn-headline').textContent).toBe(headline);
  });

  it('shows nothing more when the title says it all', () => {
    head({ headline: 'Enter Feed B’s investor-password data account' });
    expect(screen.queryByTestId('turn-headline')).toBeNull();
  });
});

describe('TH-3 a landing errand’s files under Details', () => {
  const files = [
    { repo: 'aws', paths: Array.from({ length: 12 }, (_, i) => `contracts/api/file-${i}.ts`) },
    { repo: 'web', paths: ['src/a.tsx', 'src/b.tsx', 'src/c.tsx'] },
  ];

  it('counts them by repository, folded, and lists them when opened', async () => {
    expect(filesWords(files)).toBe('12 files in aws · 3 in web');
    const { container } = head({
      title: 'Land ai-builder-e2e-fixes-r3 on main: 2 repositories differ from origin/main',
      files,
    });
    const toggle = screen.getByTestId('turn-files-toggle');
    expect(toggle.textContent).toContain('Details — 12 files in aws · 3 in web');
    expect(screen.queryByTestId('turn-files')).toBeNull();
    fireEvent.click(toggle);
    const list = screen.getByTestId('turn-files');
    expect(within(list).getByText('12 files in aws')).toBeTruthy();
    expect(within(list).getByText('3 files in web')).toBeTruthy();
    expect(within(list).getByText('contracts/api/file-0.ts')).toBeTruthy();
    expect(within(list).getByTestId('turn-files-copy').textContent).toContain('Copy the file list');
    await expectNoAxeViolations(container);
  });

  it('draws no Details on an item with no files', () => {
    head();
    expect(screen.queryByTestId('turn-files-toggle')).toBeNull();
  });
});
