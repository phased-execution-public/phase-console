/**
 * The bell drawer offers a notification's own buttons and presses them through
 * `POST /api/push/action` with its one-shot token (control-tower phase 25).
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationRecord } from '@/lib/api';

const { pushAction } = vi.hoisted(() => ({ pushAction: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, pushAction } };
});

import { NotificationActions } from './drawer';

const ITEM = {
  id: 'n1',
  at: '2026-09-29T10:00:00.000Z',
  category: 'approval',
  title: 'Allow Bash(git push)?',
  body: 'demo P4 asks',
  url: '/#/now',
  urgent: true,
  read: false,
  delivery: [],
  actions: [
    { action: 'allow', title: 'Allow' },
    { action: 'deny', title: 'Deny' },
  ],
  callback: 'signed.token',
} as unknown as NotificationRecord;

beforeEach(() => vi.clearAllMocks());

describe('a notification’s buttons in the bell drawer', () => {
  it('presses the one chosen with the notification’s own token, and says it was answered', async () => {
    pushAction.mockResolvedValue({ ok: true });
    render(<NotificationActions item={ITEM} />);
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(pushAction).toHaveBeenCalledWith('signed.token', 'deny'));
    expect(await screen.findByTestId('notification-answered')).toHaveTextContent('Deny — answered.');
  });

  it('says so when the phone answered first', async () => {
    pushAction.mockRejectedValue(new Error('this notification has already been answered'));
    render(<NotificationActions item={ITEM} />);
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(await screen.findByTestId('notification-answered')).toHaveTextContent(
      'this notification has already been answered',
    );
  });
});
