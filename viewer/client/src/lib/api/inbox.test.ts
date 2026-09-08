/**
 * `inboxAct` — performing a remedy exactly as the server spelled it.
 *
 * The rule this file defends is that the client owns NO routing table. The
 * endpoint, the method and the body come off the `InboxAction`; the only thing
 * the client adds is the operator's own words, and even then it does not
 * choose the key — `action.says.field` does.
 *
 * Tested against a stubbed `fetch` rather than through a component, because a
 * component test mocks `api` and would therefore assert against the mock. That
 * is exactly how the empty-note case survived its first mutation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './index';
import type { InboxAction } from './inbox';

const action = (over: Partial<InboxAction> = {}): InboxAction => ({
  verb: 'approve',
  label: 'Approve the gate',
  endpoint: '/api/plans/demo/gate/4',
  method: 'POST',
  body: { approve: true, continueRun: true },
  says: { field: 'note', label: 'Evidence (optional)' },
  ...over,
});

let sent: { url: string; init: RequestInit }[] = [];

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

const bodyOf = () => JSON.parse(String(sent[0].init.body));

describe('inboxAct', () => {
  it("sends the server's endpoint, method and body untouched", async () => {
    await api.inboxAct(action());
    expect(sent[0].url).toBe('/api/plans/demo/gate/4');
    expect(sent[0].init.method).toBe('POST');
    expect(bodyOf()).toEqual({ approve: true, continueRun: true });
  });

  it("adds the operator's words under the key the ACTION named", async () => {
    await api.inboxAct(action(), 'ran the migration on a copy');
    expect(bodyOf()).toEqual({ approve: true, continueRun: true, note: 'ran the migration on a copy' });

    sent = [];
    await api.inboxAct(action({ says: { field: 'reason', label: 'Why' } }), 'the diff is wrong');
    expect(bodyOf()).toEqual({ approve: true, continueRun: true, reason: 'the diff is wrong' });
  });

  it('sends nothing extra for an empty box', async () => {
    // An empty field must produce the SAME request as no field at all.
    // Otherwise every gate approved without a note writes `note: ""` into
    // gate-status.md, and an empty string is a claim where absence is not.
    for (const said of ['', '   ', '\n\t ', undefined]) {
      sent = [];
      await api.inboxAct(action(), said);
      expect(bodyOf()).toEqual({ approve: true, continueRun: true });
    }
  });

  it('trims what was typed — a dictated sentence arrives with a trailing space', async () => {
    await api.inboxAct(action(), '  checked the backup  ');
    expect(bodyOf().note).toBe('checked the backup');
  });

  it('ignores words on an action that declared no field for them', async () => {
    // A caller with one box and several buttons passes the same text to all of
    // them; an action that takes no words must not grow one.
    await api.inboxAct(action({ says: undefined }), 'these words have nowhere to go');
    expect(bodyOf()).toEqual({ approve: true, continueRun: true });
  });

  it('never puts a body on a GET', async () => {
    await api.inboxAct(action({ method: 'GET', endpoint: '/api/accounts/refresh' }), 'words');
    expect(sent[0].init.body).toBeUndefined();
  });
});
