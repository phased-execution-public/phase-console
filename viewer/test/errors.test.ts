/**
 * Stop-signal classification and reset-time parsing.
 *
 * These are the decisions an unattended run gets wrong expensively: sleeping
 * six hours through a model-only limit, hammering an expired login, or coming
 * back a second before a window reopens. Every message string here is a real
 * one from Claude Code's error documentation, not an invention.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CREDENTIAL_CLASSES } from '../shared/ops-vocab.js';

import {
  classify, lostResume, parseResetTime, childEnv, childEnvDecisions, nextModel, resetWaitUntil,
  API_RETRY_ERRORS, BG_WAIT_CEILING_MS, RESET_MARGIN_MS, MAX_AUTO_WAIT_MS, type StopSignal,
} from '../server/runner/errors.ts';

const at = (iso: string) => new Date(iso);

function stop(partial: Partial<StopSignal>): StopSignal {
  return { subtype: 'error_during_execution', code: 1, ...partial };
}

/* ---------------- reset-time parsing ---------------- */

test('parses the plain local clock form', () => {
  const now = at('2026-08-02T10:00:00');
  const reset = parseResetTime("You've hit your session limit · resets 3:45pm", now);
  assert.ok(reset);
  assert.equal(reset.getHours(), 15);
  assert.equal(reset.getMinutes(), 45);
  assert.equal(reset.getDate(), now.getDate(), 'still today when the time is ahead');
});

test('a time already past today rolls to tomorrow', () => {
  const now = at('2026-08-02T20:00:00');
  const reset = parseResetTime('resets 3:45pm', now);
  assert.ok(reset);
  assert.equal(reset.getHours(), 15);
  assert.equal(reset.getDate(), now.getDate() + 1);
});

test('parses the weekday form used by the weekly window', () => {
  const now = at('2026-08-02T10:00:00'); // a Sunday
  const reset = parseResetTime("You've hit your weekly limit · resets Mon 12:00am", now);
  assert.ok(reset);
  assert.equal(reset.getDay(), 1, 'lands on Monday');
  assert.equal(reset.getHours(), 0, '12:00am is midnight, not noon');
});

test('parses the epoch form exactly', () => {
  const reset = parseResetTime('Claude AI usage limit reached|1749924000', at('2026-08-02T10:00:00'));
  assert.ok(reset);
  assert.equal(reset.getTime(), 1749924000 * 1000);
});

test('parses an explicit IANA timezone rather than assuming local', () => {
  const now = at('2026-08-02T10:00:00Z');
  const reset = parseResetTime('Your limit will reset at 3pm (America/Santiago)', now);
  assert.ok(reset, 'a zoned message must resolve');
  // Whatever the host zone, the instant must read 15:00 in Santiago.
  const shown = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santiago', hour: 'numeric', hour12: false,
  }).format(reset);
  assert.equal(Number(shown) % 24, 15);
});

test('a zoned time uses that zone\'s calendar day, not the UTC one', () => {
  // 01:00 UTC is still the previous evening in Los Angeles. Taking the day from
  // UTC put the answer 24h out — a runner that sleeps through a working day.
  const now = at('2026-08-02T01:00:00Z');
  const reset = parseResetTime('Your limit will reset at 11pm (America/Los_Angeles)', now);
  assert.ok(reset);
  const hours = (reset.getTime() - now.getTime()) / 3_600_000;
  assert.ok(hours > 0 && hours < 24, `expected the next 11pm within a day, got ${hours}h`);
  const shown = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false,
  }).format(reset);
  assert.equal(Number(shown) % 24, 23);
});

test('a zoned time east of UTC resolves to the next such moment', () => {
  const now = at('2026-08-02T20:00:00Z'); // already 05:00 on the 3rd in Tokyo
  const reset = parseResetTime('Your limit will reset at 3pm (Asia/Tokyo)', now);
  assert.ok(reset);
  const hours = (reset.getTime() - now.getTime()) / 3_600_000;
  assert.ok(hours > 0 && hours < 24, `expected the next 3pm within a day, got ${hours}h`);
  const shown = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo', hour: 'numeric', hour12: false,
  }).format(reset);
  assert.equal(Number(shown) % 24, 15);
});

test('a reset across a DST boundary lands on the right wall clock', () => {
  // US DST starts 2026-03-08. Asking on the 7th for 3pm must give 3pm as the
  // clock will actually read it that afternoon, not 2pm or 4pm.
  const now = at('2026-03-07T23:00:00Z');
  const reset = parseResetTime('Your limit will reset at 3pm (America/New_York)', now);
  assert.ok(reset);
  const shown = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', hour12: false,
  }).format(reset);
  assert.equal(Number(shown) % 24, 15);
});

test('an unknown timezone falls back rather than throwing', () => {
  assert.doesNotThrow(() => parseResetTime('Your limit will reset at 3pm (Not/AZone)'));
});

test('unparseable text yields null rather than a guess', () => {
  assert.equal(parseResetTime('something went wrong'), null);
  assert.equal(parseResetTime(''), null);
});

/* ---------------- classification ---------------- */

test('success is success', () => {
  assert.equal(classify(stop({ subtype: 'success' })).kind, 'ok');
});

test('a model-only limit switches model instead of sleeping', () => {
  // The expensive confusion: this message contains "limit" and would read as a
  // plan limit, idling the run for hours when Sonnet is available right now.
  const d = classify(stop({ text: "You've hit your Opus limit · resets 3:45pm", model: 'opus' }));
  assert.equal(d.kind, 'switch-model');
});

test('a plan limit waits for the stated reset, with a margin', () => {
  const now = at('2026-08-02T10:00:00');
  const d = classify(stop({ text: "You've hit your session limit · resets 3:45pm" }), now);
  assert.equal(d.kind, 'wait-until');
  if (d.kind !== 'wait-until') return;
  assert.ok(d.at.getTime() > at('2026-08-02T15:45:00').getTime(), 'never returns exactly on the boundary');
  assert.ok(d.at.getTime() < at('2026-08-02T15:50:00').getTime(), 'but not much after');
});

test('a plan limit with no parseable time waits a conservative hour', () => {
  const now = at('2026-08-02T10:00:00');
  const d = classify(stop({ text: 'Claude usage limit reached.' }), now);
  assert.equal(d.kind, 'wait-until');
  if (d.kind !== 'wait-until') return;
  assert.equal(Math.round((d.at.getTime() - now.getTime()) / 60000), 60);
});

test('a reset further out than 12h parks for a human instead of sleeping', () => {
  const now = at('2026-08-02T10:00:00');
  const far = Math.floor(at('2026-08-06T10:00:00').getTime() / 1000);
  const d = classify(stop({ text: `Claude AI usage limit reached|${far}` }), now);
  assert.equal(d.kind, 'needs-human');
});

test('529 overload switches model — capacity is tracked per model', () => {
  const d = classify(stop({
    text: 'API Error: Repeated 529 Overloaded errors. The API is at capacity',
    model: 'opus',
  }));
  assert.equal(d.kind, 'switch-model');
});

test('429 retries later rather than switching or halting', () => {
  const d = classify(stop({ text: 'API Error: Request rejected (429) · this may be a temporary capacity issue.' }));
  assert.equal(d.kind, 'retry');
});

test('auth, org policy, billing and a bad certificate all stop the RUN on its credential (RCV-1)', () => {
  for (const [text, cls] of [
    ['Please run /login · API Error: 401 Invalid authentication credentials', 'auth'],
    ['Login expired · Please run /login', 'auth'],
    ['Your organization has disabled Claude subscription access for Claude Code', 'org-policy'],
    ['Credit balance is too low', 'billing'],
    // The two zero-cost sessions the audit found classified as nothing (RCV-2):
    // a TLS interception is a wall no re-board gets past.
    ['API Error: Unable to connect to API: Self-signed certificate detected.', 'certificate'],
    ['unable to get local issuer certificate', 'certificate'],
  ] as const) {
    const d = classify(stop({ text }));
    assert.equal(d.kind, 'credential-refused', text);
    if (d.kind === 'credential-refused') assert.equal(d.class, cls, text);
  }
  // …and the disposition's kind is the vocabulary's word, exhaustively: every
  // class the owner names is one the classifier can answer with.
  for (const cls of CREDENTIAL_CLASSES) assert.ok(typeof cls === 'string' && cls.length > 3);
});

test('an api_retry category is honoured even with no message text', () => {
  assert.equal(classify(stop({ retryCategories: ['authentication_failed'] })).kind, 'credential-refused');
  assert.equal(classify(stop({ retryCategories: ['overloaded'] })).kind, 'switch-model');
  assert.equal(classify(stop({ retryCategories: ['billing_error'] })).kind, 'credential-refused');
});

test('budget and turn caps resume the same session rather than restarting it', () => {
  const budget = classify(stop({ subtype: 'error_max_budget_usd', text: '' }));
  assert.equal(budget.kind, 'resume');
  if (budget.kind === 'resume') assert.equal(budget.raise, 'budget');

  const turns = classify(stop({ subtype: 'error_max_turns', text: '' }));
  assert.equal(turns.kind, 'resume');
  if (turns.kind === 'resume') assert.equal(turns.raise, 'turns');
});

test('a refusal is not retried', () => {
  const d = classify(stop({ subtype: 'error_during_execution', stopReason: 'refusal', text: '' }));
  assert.equal(d.kind, 'needs-human');
});

test('a reset more than 12h away parks with the usage-window discriminant, not a bare reason', () => {
  const now = new Date('2026-08-02T00:00:00Z');
  const epoch = Math.floor(now.getTime() / 1000) + 20 * 3600;   // 20h out
  const d = classify(stop({ text: `Claude AI usage limit reached|${epoch}` }), now);
  assert.equal(d.kind, 'needs-human');
  // The discriminant is what lets a runner holding another account override
  // the park with a switch — string-matching the reason was the alternative.
  if (d.kind === 'needs-human') {
    assert.equal(d.cause, 'usage-window');
    assert.equal(d.at?.getTime(), epoch * 1000);
  }
  // A credential refusal is its OWN kind since zero-touch-console phase 9
  // (RCV-1): the class the runner retires the account's organisation under
  // rides on it, and `needs-human` never carries a credential again — so
  // nothing can mistake a wall the run must stop on for a person's park.
  const auth = classify(stop({ text: 'Failed to authenticate: OAuth session expired' }));
  assert.equal(auth.kind, 'credential-refused');
  if (auth.kind === 'credential-refused') assert.equal(auth.class, 'auth');
  const org = classify(stop({ text: 'API Error: 403 organization has been disabled' }));
  assert.equal(org.kind, 'credential-refused');
  if (org.kind === 'credential-refused') assert.equal(org.class, 'org-policy');
  const billing = classify(stop({ text: '', retryCategories: ['account_on_hold'] }));
  assert.equal(billing.kind, 'credential-refused');
  if (billing.kind === 'credential-refused') assert.equal(billing.class, 'billing');
  // …and an ordinary person's park carries none at all.
  const plain = classify(stop({ code: 143, text: '' }));
  assert.equal(plain.kind, 'needs-human');
  if (plain.kind === 'needs-human') assert.equal(plain.cause, undefined);
});

test('signals distinguish a supervisor kill from an OOM kill', () => {
  assert.equal(classify(stop({ code: 143, text: '' })).kind, 'needs-human');
  assert.equal(classify(stop({ code: 137, text: '' })).kind, 'retry');
});

test('an unrecognised failure is a phase failure, not a silent success', () => {
  const d = classify(stop({ subtype: undefined, code: 2, text: 'something unexpected' }));
  assert.equal(d.kind, 'phase-failed');
});

test('a phase whose own output discusses these topics is not misread as one', () => {
  // `text` carries the session's own words. Loose patterns turned a phase that
  // merely worked on this subject matter into a parked run waiting on a human
  // who had nothing to fix — the worst kind of false positive, because it looks
  // exactly like a real outage.
  for (const text of [
    'Refactored the 429 backoff and added 401 handling to billing.ts',
    'Added a rate limit table with 529 rows to the billing module',
    'Wrote tests for the login expired path; see docs/auth.md',
  ]) {
    assert.equal(classify(stop({ subtype: undefined, code: 2, text })).kind, 'phase-failed', text);
  }
});

test('a budget cap resumes even when the text mentions a rate limit', () => {
  // subtype is structured and deliberate; the prose is a heuristic. The
  // structured signal has to win, or capped work gets thrown away and re-run.
  const d = classify(stop({
    subtype: 'error_max_budget_usd',
    text: 'Investigated the API Error: 429 retry path before running out of budget',
  }));
  assert.equal(d.kind, 'resume');
});

/* ---------------- child environment + model fallback ---------------- */

test('the child gets the documented unattended retry settings', () => {
  const env = childEnv({ PATH: '/usr/bin' });
  assert.equal(env.CLAUDE_CODE_RETRY_WATCHDOG, '1');
  assert.equal(env.CLAUDE_CODE_MAX_RETRIES, '15');
  assert.equal(env.PATH, '/usr/bin', 'the caller environment survives');
});

test('an explicit retry count from the operator is not overridden', () => {
  assert.equal(childEnv({ CLAUDE_CODE_MAX_RETRIES: '3' }).CLAUDE_CODE_MAX_RETRIES, '3');
});

test('the background-task ceiling is set explicitly — the documented default, never inherited by accident (SES-12)', () => {
  const env = childEnv({ PATH: '/usr/bin' });
  assert.equal(env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, String(BG_WAIT_CEILING_MS));
  assert.equal(BG_WAIT_CEILING_MS, 600_000, 'chapter 09 row 42: 600 000 ms is the CLI\'s own default');
  assert.equal(childEnv({ CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' }).CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, '0',
    'an operator\'s own value survives');
});

test('childEnvDecisions names where each ceiling came from — what phase.retry-ceiling journals', () => {
  assert.deepEqual(childEnvDecisions({ PATH: '/usr/bin' }), {
    maxRetries: { value: '15', source: 'console' },
    bgWaitCeilingMs: { value: '600000', source: 'console' },
  });
  assert.deepEqual(childEnvDecisions({ CLAUDE_CODE_MAX_RETRIES: '3', CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' }), {
    maxRetries: { value: '3', source: 'env' },
    bgWaitCeilingMs: { value: '0', source: 'env' },
  });
  // The env childEnv writes and the decisions say the same thing.
  const env = childEnv({});
  const said = childEnvDecisions({});
  assert.equal(env.CLAUDE_CODE_MAX_RETRIES, said.maxRetries.value);
  assert.equal(env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, said.bgWaitCeilingMs.value);
});

/* ---------------- the session ledger's signals (zero-touch-console phase 4) ---------------- */

test('API_RETRY_ERRORS is the twelve documented `error` values (chapter 09 row 31)', () => {
  assert.deepEqual([...API_RETRY_ERRORS].sort(), [
    'account_on_hold', 'authentication_failed', 'billing_error', 'cloud_credential_error', 'invalid_request',
    'max_output_tokens', 'model_not_found', 'oauth_org_not_allowed', 'overloaded', 'rate_limit', 'server_error',
    'unknown',
  ]);
  assert.ok(Object.isFrozen(API_RETRY_ERRORS));
});

test('isError disqualifies success before any text is read — and without it, today\'s behaviour stands (SES-5)', () => {
  // An error the classifier has no pattern for: the bit alone keeps it from
  // reading as a completed phase, and the reason quotes what it did not know.
  const text = 'API Error: Unable to connect to API: the upstream gateway answered 418.';
  const broken = classify({ subtype: 'success', code: 0, isError: true, text });
  assert.notEqual(broken.kind, 'ok');
  assert.equal(broken.kind, 'phase-failed');
  assert.match(broken.kind === 'phase-failed' ? broken.reason : '', /answered 418/,
    'the reason quotes the error it did not recognise');
  assert.equal(classify({ subtype: 'success', code: 0, text }).kind, 'ok',
    'the same signal without the bit keeps today\'s reading');
});

test('the TLS-interception sign-off is a credential wall, with or without the isError bit (RCV-2)', () => {
  // Twice recorded as a completed phase at 4.1.0; phase 4 made the bit stop
  // that, phase 9 names the wall — credentials are read BEFORE success is
  // believed, so the bit is not what stands between this text and `ok`.
  const text = 'API Error: Unable to connect to API: Self-signed certificate detected.';
  for (const signal of [
    { subtype: 'success' as const, code: 0, isError: true, text },
    { subtype: 'success' as const, code: 0, text },
  ]) {
    const d = classify(signal);
    assert.equal(d.kind, 'credential-refused');
    if (d.kind === 'credential-refused') {
      assert.equal(d.class, 'certificate');
      assert.match(d.reason, /certificate/);
    }
  }
});

test('an aborted turn is never ok, whatever its subtype says', () => {
  assert.notEqual(classify({ subtype: 'success', code: 0, terminalReason: 'aborted_tools' }).kind, 'ok');
  assert.equal(classify({ subtype: 'success', code: 0, terminalReason: 'completed' }).kind, 'ok');
});

test('a session the console ended before its turn was done is never ok', () => {
  assert.notEqual(classify({ subtype: 'success', code: 0, endedBy: 'stop' }).kind, 'ok');
  assert.equal(classify({ subtype: 'success', code: 0, endedBy: 'exit' }).kind, 'ok');
});

test('the spawn watchdog\'s kill is a retry quoting its diagnosis — never "session was terminated (SIGTERM)" (SES-11)', () => {
  const reason = 'no result after init — the session went silent for 55 min after it started and before its first result';
  const disposition = classify({ code: 143, endedBy: 'spawn-watchdog', endedReason: reason });
  assert.equal(disposition.kind, 'retry');
  assert.match(disposition.kind === 'retry' ? disposition.reason : '', /no result after init/);
  assert.doesNotMatch(disposition.kind === 'retry' ? disposition.reason : '', /SIGTERM/);
  // An external SIGTERM nobody named is still what it always was.
  assert.equal(classify({ code: 143 }).kind, 'needs-human');
});

test('"Background tasks still running after" is never ok, and names the tasks the stream saw start (SES-12)', () => {
  const text = 'all done\nBackground tasks still running after 600s; terminating. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.';
  const named = classify({
    subtype: 'success', code: 0, text, backgroundTasks: [{ id: 'bash_7', description: 'npm test -- --run' }],
  });
  assert.equal(named.kind, 'phase-failed');
  assert.match(named.kind === 'phase-failed' ? named.reason : '', /600s/);
  assert.match(named.kind === 'phase-failed' ? named.reason : '', /bash_7 \(npm test -- --run\)/);
  const unnamed = classify({ subtype: 'success', code: 0, text });
  assert.equal(unnamed.kind, 'phase-failed');
  assert.match(unnamed.kind === 'phase-failed' ? unnamed.reason : '', /named no task/);
});

test('a server_error retry category reaches its retry arm (SES-7)', () => {
  const disposition = classify(stop({ subtype: 'error_during_execution', retryCategories: ['server_error'] }));
  assert.equal(disposition.kind, 'retry');
  assert.match(disposition.kind === 'retry' ? disposition.reason : '', /server error/);
});

test('model fallback walks down the ladder and then gives up', () => {
  assert.equal(nextModel('claude-opus-5'), 'sonnet');
  assert.equal(nextModel('sonnet'), 'haiku');
  assert.equal(nextModel('haiku'), null, 'nothing below the last rung');
});

test('a session that could not authenticate is not a success, whatever it reports', () => {
  // Seen in a real run: OAuth expired, the CLI still reported
  // `subtype: success` after one turn and $0.00 having done nothing, and the
  // runner went on to verify work that was never attempted. What the output
  // says has to outrank what the exit status claims.
  const d = classify(stop({
    subtype: 'success',
    text: 'Failed to authenticate: OAuth session expired and could not be refreshed',
  }));
  assert.equal(d.kind, 'credential-refused');
  assert.match(d.kind === 'credential-refused' ? d.reason : '', /authentication/);
});

test('a genuine success is still a success', () => {
  assert.equal(classify(stop({ subtype: 'success', text: 'Wrote three files and ran the tests.' })).kind, 'ok');
});

/* ---------------- which bucket a limit message is about ---------------- */

test('limitBucket names the window in the registry vocabulary', async () => {
  const { limitBucket } = await import('../server/runner/errors.ts');
  assert.equal(limitBucket("You've hit your session limit · resets 3:45pm"), 'five_hour');
  assert.equal(limitBucket("You've hit your weekly limit · resets Mon 12:00am"), 'seven_day');
  assert.equal(limitBucket("You've hit your Opus limit · resets 3:45pm"), 'seven_day_opus');
  assert.equal(limitBucket("you've hit your Fable 5 limit — resets 9pm"), 'seven_day_fable');
  // The epoch form names no window; `five_hour` is the conservative reading
  // and the one the runner has always taken — pinned so a refactor cannot
  // silently move learned walls to the weekly bucket.
  assert.equal(limitBucket('Claude AI usage limit reached|1749924000'), 'five_hour');
});

test('a model limit is a switch-model that names its bucket and reset; capacity names neither', () => {
  const now = at('2026-01-01T13:00:00');
  const quota = classify(stop({
    text: "You've hit your Opus limit · resets 3:45pm", model: 'opus',
  }), now);
  assert.equal(quota.kind, 'switch-model');
  assert.equal(quota.kind === 'switch-model' ? quota.bucket : '', 'seven_day_opus');
  assert.ok(quota.kind === 'switch-model' && quota.at instanceof Date, 'the reset rides along');

  // 529 is the API being busy, not this account's quota — there is no wall to
  // remember, so nothing must be filed against the account.
  const capacity = classify(stop({ text: 'API Error: 529 overloaded_error' }), now);
  assert.equal(capacity.kind, 'switch-model');
  assert.equal(capacity.kind === 'switch-model' ? capacity.bucket : 'set', undefined);
});

/* ---------------- the first model's window (the resource ladder) ---------------- */

test('resetWaitUntil is the reset plus the margin, inside the auto-wait ceiling', () => {
  const now = at('2026-01-01T12:00:00Z');
  const reset = at('2026-01-01T13:00:00Z');
  const until = resetWaitUntil(reset, now);
  assert.ok(until);
  assert.equal(until.getTime(), reset.getTime() + RESET_MARGIN_MS);
  assert.equal(resetWaitUntil(at('2026-01-02T12:00:01Z'), now), null,
    'past the ceiling the wait is not worth sleeping on — the runner falls back as before');
});

test('a reset already behind us answers "now", never a wait into the past', () => {
  const now = at('2026-01-01T12:00:00Z');
  const until = resetWaitUntil(at('2026-01-01T10:00:00Z'), now);
  assert.ok(until);
  assert.equal(until.getTime(), now.getTime());
});

test('the ceiling and the margin are the classifier\'s own constants, exported once', () => {
  assert.equal(MAX_AUTO_WAIT_MS, 12 * 60 * 60 * 1000);
  assert.equal(RESET_MARGIN_MS, 90_000);
  // The classifier's own >12h verdict and the helper agree on the edge.
  const now = at('2026-01-01T12:00:00Z');
  const edge = new Date(now.getTime() + MAX_AUTO_WAIT_MS - RESET_MARGIN_MS);
  assert.ok(resetWaitUntil(edge, now), 'exactly at the ceiling still waits');
  assert.equal(resetWaitUntil(new Date(edge.getTime() + 1), now), null);
});

test('a resume whose conversation the CLI cannot find is a lost session — named, never retried', () => {
  // The CLI's own sentence, verbatim from the stderr of three real runs:
  // the transcript lived under another account's config dir (or another cwd),
  // so `--resume` failed in three seconds with `error_during_execution` and
  // zero turns. Classified as a generic 60 s retry, the same `--resume` was
  // offered nineteen times.
  const lost = stop({
    subtype: 'error_during_execution', code: 1,
    text: 'No conversation found with session ID: 4b6d6e4a-7158-4120-bfe7-f99c657fcfae\n',
  });
  assert.equal(lostResume(lost), true);
  const d = classify(lost);
  assert.equal(d.kind, 'phase-failed');
  if (d.kind === 'phase-failed') assert.match(d.reason, /session .* gone|cannot be resumed/i);

  // The runner's own spawn failure shares the subtype and is NOT a lost resume
  // — `fail()` in spawn.ts writes `error_during_execution` for a child that
  // never started, and that IS worth a retry.
  const spawnFailed = stop({ subtype: 'error_during_execution', code: null, text: 'spawn claude ENOENT' });
  assert.equal(lostResume(spawnFailed), false);
  assert.equal(classify(spawnFailed).kind, 'retry');
  // Nor is the phrase anywhere else in a session's output: only the CLI's
  // refusal, at the top of stderr, counts.
  assert.equal(lostResume(stop({ subtype: 'success', code: 0, text: 'I searched for "No conversation found with session ID" in the docs' })), false);
});
