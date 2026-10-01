/**
 * What the console NOTICES of a person's turn (control-tower phase 44,
 * §Architecture 12's third birth channel) — the two halves:
 *
 *   HG-1  a supervised Bash call matching a sign-in shape is denied BEFORE it
 *         runs, on every profile, with the procedure as the reason and the
 *         human step it should declare instead;
 *   HG-2  the same call where the console drives nothing (an operator's own
 *         terminal, a CLI no run token names) is untouched;
 *   HG-3  a status verb, a non-interactive sign-in, and a sign-in that is only
 *         DATA (a here-doc, a quoted string, a grep) are not denied;
 *   HG-4  the stall detector reads "silent + a link in the last output +
 *         waiting words" as a SUSPECTED human step, raises it with the link it
 *         saw, and never converts or opens it by itself — measured against a
 *         fixture corpus of real sign-in output and ordinary output with links.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { SKILL_DIR } = await import('../server/config.ts');
const { signInCall, signInJournalCommand, signInRefusal } = await import('../server/runner/approvals.ts');
const { judgeCommand } = await import('../server/runner/verify.ts');
const {
  applyEvent, evaluateStall, newLaneSignals, stallThresholds, suspectedStepOf,
} = await import('../server/runner/liveness.ts');
const {
  HUMAN_STEP_KINDS, KIND_META, SIGN_IN_SHAPES, SIGN_IN_STEPS, SIGN_IN_UNATTENDED,
} = await import('../shared/human-step-model.js');
const { cmdRefProblem, parseWatchRef } = await import('../server/watch-refs.ts');
const { Service } = await import('../server/service.ts');

const VIEWER = fileURLToPath(new URL('..', import.meta.url));

const flags = {
  port: 0, host: '127.0.0.1', open: false, allowWrites: false,
  scriptsDir: join(SKILL_DIR, 'scripts'),
  logFile: null,
};

type Noted = { event: string; data: Record<string, unknown>; phase?: number };

/** A console driving run `r1` of plan `demo`, phase 2 on the lane — the hook's supervised case. */
function laned(profile: string) {
  const service = new Service(flags as never);
  const noted: Noted[] = [];
  (service as unknown as { runners: Map<string, unknown> }).runners.set('demo', {
    busy: () => true,
    current: () => ({ id: 'r1', slug: 'demo', activePhase: 2, permissionProfile: profile, phases: {} }),
    note: (event: string, data: Record<string, unknown>, phase?: number) => noted.push({ event, data, phase }),
    noteWaitDenied: () => {},
    park: () => {},
    isSpending: () => false,
  });
  return { service, noted };
}

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });

function decision(reply: Record<string, unknown>): { permissionDecision: string; permissionDecisionReason: string } {
  return (reply as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } })
    .hookSpecificOutput;
}

/* ------------------------------------------------------------------ *
 * The vocabulary the guard reads
 * ------------------------------------------------------------------ */

test('every sign-in shape names the human step it is — a known kind, and a proof the watch can run', () => {
  assert.deepEqual(Object.keys(SIGN_IN_STEPS).sort(), [...SIGN_IN_SHAPES].sort(), 'SIGN_IN_STEPS is keyed by exactly SIGN_IN_SHAPES');
  for (const shape of SIGN_IN_SHAPES) {
    const step = SIGN_IN_STEPS[shape]!;
    assert.ok((HUMAN_STEP_KINDS as readonly string[]).includes(step.kind), `${shape}: ${step.kind} is not a kind`);
    if (step.proof) {
      const parsed = parseWatchRef(step.proof);
      assert.equal(parsed?.kind, 'cmd', `${shape}: the proof is a cmd: ref`);
      const command = (parsed as { command: string }).command;
      assert.equal(cmdRefProblem(command), null, `${shape}: the proof is self-contained`);
      // The watch clock's own judge must run it, or the step could never be proven.
      assert.equal(judgeCommand(command), null, `${shape}: the console's command judge refuses ${command}`);
    }
  }
  // Every unattended flag is a long option — a short one would match inside
  // too many unrelated commands to be honest.
  for (const flag of SIGN_IN_UNATTENDED) assert.match(flag, /^--[a-z][a-z-]+$/);
});

/* ------------------------------------------------------------------ *
 * HG-1 — denied before it runs, with the step to declare
 * ------------------------------------------------------------------ */

test('HG-1: a supervised sign-in is denied before it runs, on every profile, with the step to declare instead', async () => {
  for (const profile of ['guarded', 'trusted', 'bypass']) {
    const { service, noted } = laned(profile);
    const answer = decision(await service.decideToolUse(bash('gh auth login --web'), 'r1'));
    assert.equal(answer.permissionDecision, 'deny', `${profile}: gh auth login ran`);
    const reason = answer.permissionDecisionReason;
    // The procedure: why, what to write first, and the declaration whole.
    assert.match(reason, /interactive sign-in \(`gh auth login`\)/);
    assert.match(reason, /nobody sees/);
    assert.match(reason, /handoff `in-progress`/);
    assert.match(reason, /phase-outcome\.sh demo 2 needs-human --needs human-acts --step browser-login/);
    assert.match(reason, /--title 'Sign in in a browser: gh auth login'/);
    assert.match(reason, /--open-command 'gh auth login'/);
    assert.match(reason, /--where host/);
    assert.match(reason, /--proof 'cmd:"gh auth status"'/);
    assert.match(reason, /resumes THIS session/);
    const denied = noted.find((n) => n.event === 'phase.tool-denied');
    assert.equal(denied?.data.rule, 'sign-in');
    assert.equal(denied?.data.shape, 'gh auth login');
    assert.equal(denied?.data.step, 'browser-login');
    assert.equal(denied?.phase, 2);
    service.close();
  }
});

test('HG-1: no spelling hides a sign-in — wrappers, runners, env, sudo, paths, groups and chains', () => {
  const cases: [string, string][] = [
    ['npx wrangler login', 'wrangler login'],
    ['npx -y vercel login', 'vercel login'],
    ['pnpm dlx netlify login', 'netlify login'],
    ['bunx firebase login', 'firebase login'],
    ['CLOUDSDK_CORE_PROJECT=x gcloud auth login', 'gcloud auth login'],
    ['timeout 120 npm login', 'npm login'],
    ['nohup az login &', 'az login'],
    ['sudo docker login', 'docker login'],
    ['/opt/homebrew/bin/gh auth refresh -s workflow', 'gh auth refresh'],
    ['cd infra && aws sso login --profile prod', 'aws sso login'],
    ['(cd site && vercel login)', 'vercel login'],
    ['{ heroku login; }', 'heroku login'],
    ['echo start; claude setup-token', 'claude setup-token'],
    ['gcloud auth application-default login --no-launch-browser', 'gcloud auth application-default login'],
    // A compound's body is split again; a continuation is one line.
    ['if ! gh auth status; then gh auth login; fi', 'gh auth login'],
    ['for p in a b; do npm login --scope=@$p; done', 'npm login'],
    ['gh auth login \\\n  --hostname github.example.com', 'gh auth login'],
  ];
  for (const [command, shape] of cases) {
    const call = signInCall(command);
    assert.equal(call?.shape, shape, `missed: ${command}`);
  }
  // Each shape's step is the one its table row names.
  assert.equal(signInCall('claude login')?.step.kind, 'claude-login');
  assert.equal(signInCall('op signin')?.step.kind, 'os-prompt');
  assert.equal(signInCall('npm login')?.step.proof, 'cmd:"npm whoami"');
  // A tool the console's judge does not run names no proof — a person's word proves it.
  const bare = signInCall('az login')!;
  assert.equal(bare.step.proof, undefined);
  const words = signInRefusal(bare, 'bash x/phase-outcome.sh demo 2');
  assert.doesNotMatch(words, /--proof '/, 'no --proof flag in the declaration');
  assert.match(words, /It names no --proof/);
  assert.match(words, /--step browser-login --title 'Sign in in a browser: az login' --open-command 'az login' --where host --reason/);
});

/* ------------------------------------------------------------------ *
 * HG-2 — an operator's own terminal is untouched
 * ------------------------------------------------------------------ */

test('HG-2: the same call where the console drives nothing is untouched by the guard', async () => {
  const PENDING = Symbol('still asking');
  for (const token of [null, 'no-such-run']) {
    const service = new Service(flags as never);
    const reply = await Promise.race([
      service.decideToolUse(bash('gh auth login'), token),
      new Promise((resolve) => setTimeout(() => resolve(PENDING), 300)),
    ]);
    // Either the policy answered it (a card, or an allow) — never the guard.
    if (reply !== PENDING) {
      assert.doesNotMatch(decision(reply as Record<string, unknown>).permissionDecisionReason ?? '', /interactive sign-in/);
    }
    service.close();
  }
  // The operator's embedded terminal is a shell the console starts, not a
  // Claude session: nothing there passes through a PreToolUse hook at all.
  const terminal = readFileSync(join(VIEWER, 'server', 'terminal.ts'), 'utf8');
  assert.doesNotMatch(terminal, /signInCall|decideToolUse/);
});

/* ------------------------------------------------------------------ *
 * HG-3 — status verbs, unattended flags and data are not sign-ins
 * ------------------------------------------------------------------ */

test('HG-3: a status verb, a non-interactive sign-in and a sign-in written as data are not denied', async () => {
  const allowed = [
    'gh auth status',
    'gh auth status --hostname github.com',
    'gh auth token >/dev/null && echo ok',
    'firebase login:list',
    'npm whoami',
    'az account show',
    'aws sts get-caller-identity',
    'gh auth login --with-token < .secrets/gh-token',
    'echo "$TOKEN" | docker login ghcr.io -u me --password-stdin',
    'az login --identity',
    'gcloud auth login --cred-file=key.json',
    'huggingface-cli login --token "$HF_TOKEN"',
    'echo "run gh auth login first"',
    "grep -rn 'gh auth login' docs/",
    'git commit -m "docs: explain gh auth login"',
    "cat > notes.md <<'EOF'\ngh auth login\nnpx wrangler login\nEOF",
    'ghx auth login',
    'npm loginx',
    'gh auth login --help',
    'gh auth login \\\n  --with-token < .secrets/gh-token',
  ];
  for (const command of allowed) assert.equal(signInCall(command), null, `denied: ${command}`);

  const { service, noted } = laned('bypass');
  for (const command of ['gh auth status', 'gh auth login --with-token < t.txt']) {
    const answer = decision(await service.decideToolUse(bash(command), 'r1'));
    assert.equal(answer.permissionDecision, 'allow', command);
  }
  assert.equal(noted.filter((n) => n.data.rule === 'sign-in').length, 0);
  service.close();
});

test('HG-1: a password on the command line is refused like any sign-in, and never reaches the journal', async () => {
  const { service, noted } = laned('bypass');
  const answer = decision(await service.decideToolUse(bash('docker login -u me -p hunter2 ghcr.io'), 'r1'));
  assert.equal(answer.permissionDecision, 'deny');
  const denied = noted.find((n) => n.data.rule === 'sign-in');
  assert.ok(denied);
  assert.doesNotMatch(String(denied!.data.command), /hunter2/);
  assert.doesNotMatch(answer.permissionDecisionReason, /hunter2/);
  assert.doesNotMatch(signInJournalCommand('docker login --password=s3cr3tpw ghcr.io'), /s3cr3tpw/);
  assert.equal(signInJournalCommand('docker login -u me -p hunter2 ghcr.io'), 'docker login -u me -p [redacted] ghcr.io');
  service.close();
});

/* ------------------------------------------------------------------ *
 * HG-4 — the stall reading
 * ------------------------------------------------------------------ */

/**
 * Real sign-in output (lightly trimmed), each ending the way the CLI leaves it
 * while it waits for a person — and the kind each reads as.
 */
const POSITIVES: [string, string, string][] = [
  ['gh device flow',
    '! First copy your one-time code: 1A2B-3C4D\nOpen this URL to continue in your web browser: https://github.com/login/device\n',
    'device-code'],
  ['gcloud',
    'Go to the following link in your browser:\n\n    https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=325559.apps.googleusercontent.com&scope=openid&state=Zq9\n\nEnter authorization code: ',
    'browser-login'],
  ['az',
    'To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code FGH7JKL9M to authenticate.',
    'browser-login'],
  ['aws sso',
    'Attempting to automatically open the SSO authorization page in your default browser.\nIf the browser does not open, open the following URL:\n\nhttps://device.sso.us-east-1.amazonaws.com/\n\nThen enter the code:\n\nWXYZ-QRST\n',
    'device-code'],
  ['wrangler',
    'Attempting to login via OAuth...\nOpening a link in your default browser: https://dash.cloudflare.com/oauth2/auth?response_type=code&client_id=54d1&state=abc\n',
    'browser-login'],
  ['vercel',
    '> Please visit the following URL in your web browser: https://vercel.com/oauth/device?user_code=ABCD-EFGH\n> Waiting for authentication...',
    'browser-login'],
  ['npm',
    'Login at:\nhttps://www.npmjs.com/login?next=/login/cli/5d1c\nPress ENTER to open in the browser...',
    'browser-login'],
  ['docker',
    'Your one-time device confirmation code is: KPMN-RTVW\nPress ENTER to open your browser or submit your device code here: https://login.docker.com/activate\n\nWaiting for authentication in the browser…',
    'device-code'],
  ['claude',
    "Browser didn't open? Use the url below to sign in:\n\nhttps://claude.ai/oauth/authorize?client_id=9d1c&response_type=code&state=x1\n\nPaste code here if prompted >",
    'browser-login'],
  ['heroku',
    'heroku: Press any key to open up the browser to login or q to exit:\nOpening browser to https://cli-auth.heroku.com/auth/cli/browser/5f1\nheroku: Waiting for login...',
    'browser-login'],
  ['a session asking in its own words',
    "I can't finish this without you: please open https://example.com/device in your browser and enter the code WXYZ-1234. I'm waiting for you to complete the sign-in.",
    'device-code'],
  ['a magic link',
    'We sent a magic link to you@example.com. Check your email and follow it to continue: https://app.example.com/verify',
    'email-link'],
  ['an org approval',
    'Waiting for approval from an organization owner: https://github.com/organizations/acme/settings/oauth_application_policy',
    'third-party-approval'],
  ['a captcha',
    'Please complete the captcha at https://example.com/challenge to continue.',
    'captcha'],
];

/** Ordinary output with links in it — what a silent lane's last words usually are. */
const NEGATIVES: [string, string][] = [
  ['a server start', 'Server running at http://localhost:3000/'],
  ['vite', '  VITE v5.0.0  ready in 300 ms\n\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host to expose'],
  ['a dev server, in words', 'Open http://localhost:5173 in your browser to see the app.'],
  ['git push', "remote: Create a pull request for 'feat' on GitHub by visiting:\nremote:      https://github.com/acme/repo/pull/new/feat\n"],
  ['npm warn', 'npm WARN deprecated inflight@1.0.6: This module is not supported. See https://github.com/npm/rfcs'],
  ['a tap log', 'ok 1 - fetches https://example.com/api\n# pass 12\n# fail 0'],
  ['waiting on a port', 'Waiting for the server at http://localhost:8080 to start...'],
  ['playwright', 'Serving HTML report at http://localhost:9323. Press Ctrl+C to quit.'],
  ['docs prose', 'See the docs at https://docs.example.com/auth for how to authenticate.'],
  ['a PR url', 'https://github.com/acme/repo/pull/42'],
  ['a redirect', 'HTTP/2 302\nlocation: https://accounts.google.com/signin\n'],
  ['a deploy', 'Deployed to https://my-app.vercel.app (verify it with curl)'],
  ['a CI run', 'Triggered via push about 1 minute ago\nView this run on GitHub: https://github.com/acme/repo/actions/runs/123'],
  ['readme words', 'Open http://localhost:4123 to see the console.'],
  ['pricing', 'Visit https://example.com/pricing for plans.'],
  ['a login page, described', 'The login page at https://app.example.com/login now renders the form; the e2e test covers it.'],
  ['a bats failure', 'not ok 3 verify the login at http://localhost:3000/login redirects'],
  ['a file link', 'Open the coverage report in your browser: file:///tmp/coverage/index.html'],
  ['a test named for sign-in', 'ok 4 - sign in at http://localhost:3000 sets the cookie'],
  ['a commit', '[pe/demo 1a2b3c4] fix(auth): the device login page links https://example.com/help'],
  ['a changelog line', '- The sign-in guard names the step (https://github.com/acme/repo/issues/9).'],
  ['a curl of an api', '{"login":"octocat","html_url":"https://github.com/octocat"}'],
  ['a waiting spinner', 'Waiting for 3 background tasks to finish (logs: https://ci.example.com/job/7)'],
  ['a gh pr checks table', 'build\tpass\t1m\thttps://github.com/acme/repo/actions/runs/9/job/1'],
  ['a timeout', 'Error: Timed out waiting for http://localhost:6006 after 30000ms'],
];

test('HG-4: the reading keys on a link AND waiting words — every fixture sign-in read, no ordinary output read', () => {
  const missed: string[] = [];
  for (const [name, text, kind] of POSITIVES) {
    const seen = suspectedStepOf(text);
    if (!seen) { missed.push(name); continue; }
    assert.equal(seen.kind, kind, `${name}: read as ${seen.kind}`);
    assert.match(seen.url, /^https:\/\//, `${name}: the link`);
    assert.doesNotMatch(`${seen.url} ${seen.words}`, /\b[A-Z0-9]{4,9}-[A-Z0-9]{4,9}\b/, `${name}: a device code reached the reading`);
    assert.ok(seen.words.length > 0);
    assert.equal(seen.where, KIND_META[seen.kind].where);
  }
  assert.deepEqual(missed, [], 'a sign-in the reading did not see');
  const falsePositives = NEGATIVES.filter(([, text]) => suspectedStepOf(text)).map(([name]) => name);
  assert.deepEqual(falsePositives, [], `the false-positive rate against the fixtures is ${falsePositives.length}/${NEGATIVES.length}`);
});

test('HG-4: the link it keeps is redacted, and a localhost callback is the machine\'s', () => {
  const seen = suspectedStepOf('Waiting for authentication — open https://auth.example.com/cb?code=4f9a8b7c6d&state=ok in your browser');
  assert.ok(seen);
  assert.match(seen!.url, /code=\[redacted\]/);
  assert.doesNotMatch(seen!.url, /4f9a8b7c6d/);
  const local = suspectedStepOf('Waiting for you to sign in at http://localhost:8976/oauth/start');
  assert.equal(local?.where, 'host');
  const coded = suspectedStepOf('> Please visit the following URL in your web browser: https://vercel.com/oauth/device?user_code=ABCD-EFGH\n> Waiting for authentication...');
  assert.equal(coded?.url, 'https://vercel.com/oauth/device?user_code=[redacted]');
  const spoken = suspectedStepOf('Please sign in with code ABCD-1234 at https://example.com/device');
  assert.doesNotMatch(spoken?.words ?? '', /ABCD-1234/);
});

test('HG-4: a silent lane whose last output is a sign-in raises a SUSPECTED step with the link it saw', () => {
  const T0 = Date.parse('2026-09-30T08:00:00.000Z');
  const thresholds = stallThresholds();
  const signals = newLaneSignals(T0);
  applyEvent(signals, { kind: 'tool', id: 'a', name: 'Bash', summary: 'npx some-cli auth' }, T0 + 1_000);
  applyEvent(signals, { kind: 'tool-result', id: 'a', ok: false, detail: POSITIVES[0]![1] }, T0 + 2_000);
  // Not yet silent: nothing is raised, whatever the output said.
  assert.equal(evaluateStall(signals, thresholds, T0 + 3_000), null);
  const stall = evaluateStall(signals, thresholds, T0 + 2_000 + thresholds.stallSilentMs + 1);
  assert.equal(stall?.signal, 'silent');
  assert.equal(stall?.suspectedStep?.kind, 'device-code');
  assert.equal(stall?.suspectedStep?.url, 'https://github.com/login/device');
  assert.equal(stall?.suspectedStep?.at, new Date(T0 + 2_000).toISOString());
  // The code the CLI printed stays in its transcript — the reading rides a journal line.
  assert.doesNotMatch(JSON.stringify(stall), /1A2B-3C4D/);

  // A later output that reads as nothing drops it: it is only ever the LAST output.
  applyEvent(signals, { kind: 'text', text: 'Signed in. Carrying on with the migration.' }, T0 + 3_000);
  const after = evaluateStall(signals, thresholds, T0 + 3_000 + thresholds.stallSilentMs + 1);
  assert.equal(after?.signal, 'silent');
  assert.equal(after?.suspectedStep, undefined);

  // spawn.ts reads a result's WHOLE text and hands the reading over on the
  // event, because `detail` is the first 200 characters, folded.
  const clipped = newLaneSignals(T0);
  const whole = `${'x'.repeat(400)}\n${POSITIVES[6]![1]}`;
  applyEvent(clipped, { kind: 'tool-result', id: 'c', ok: true, detail: whole.slice(0, 200), suspected: suspectedStepOf(whole)! }, T0 + 1_000);
  assert.equal(clipped.suspectedStep?.url, 'https://www.npmjs.com/login?next=/login/cli/5d1c');
  const spawnSource = readFileSync(join(VIEWER, 'server', 'runner', 'spawn.ts'), 'utf8');
  assert.match(spawnSource, /const suspected = parent \? null : suspectedStepOf\(full\)/, 'the reading is made over the unclipped text');

  // A subagent's output is its own.
  const sub = newLaneSignals(T0);
  applyEvent(sub, { kind: 'tool-result', id: 'b', ok: true, detail: POSITIVES[5]![1], parent: 'call-1' }, T0 + 1_000);
  assert.equal(sub.suspectedStep, undefined);
});

test('HG-4: nothing converts or opens a suspected step by itself — only a person\'s request does', () => {
  const server = join(VIEWER, 'server');
  const files = [
    ...readdirSync(join(server, 'runner')).map((name) => join(server, 'runner', name)),
    join(server, 'inbox.ts'),
  ].filter((file) => file.endsWith('.ts'));
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const act of ['recordHumanStep(', 'declareHumanStep(', 'openUrlOnHost(', 'convertSuspectedStep(']) {
      assert.ok(!text.includes(act), `${file.slice(server.length)} calls ${act} — the reading is advisory`);
    }
  }
  // The one door that turns a suspicion into a step is a person's: the
  // service verb the inbox row's action posts to, and it declares with
  // `birth: 'console'` — nowhere else does.
  const births = [...readdirSync(server)].filter((name) => name.endsWith('.ts'))
    .filter((name) => readFileSync(join(server, name), 'utf8').includes("birth: 'console'"));
  assert.deepEqual(births, ['service-recovery.ts']);
});

test('HG-4: a person converts a suspicion ONCE — a second press answers the same step, and a lane that spoke refuses', () => {
  const service = new Service(flags as never);
  const since = new Date(Date.now() - 11 * 60_000).toISOString();
  const suspectedStep = {
    kind: 'browser-login', url: 'https://github.com/login/device', words: 'Open this URL to continue in your web browser',
    where: 'host', at: since,
  };
  let record: Record<string, unknown> = {
    phase: 3, status: 'running', sessionId: 's-3', stall: { signal: 'silent', since, detail: 'quiet', suspectedStep },
  };
  (service as unknown as { runners: Map<string, unknown> }).runners.set('demo', {
    busy: () => true,
    current: () => ({ id: 'r1', slug: 'demo', activePhase: 3, phases: { 3: record } }),
    note: () => {}, park: () => {}, isSpending: () => false,
  });
  const first = service.convertSuspectedStep({ slug: 'demo', phase: 3 }, { by: 'tester' }) as {
    ok: boolean; already?: boolean; step: { id: string; birth: string; kind: string; openUrl?: string; runId?: string; state: string };
  };
  assert.equal(first.ok, true);
  assert.equal(first.step.birth, 'console');
  assert.equal(first.step.kind, 'browser-login');
  assert.equal(first.step.openUrl, 'https://github.com/login/device');
  assert.equal(first.step.runId, 'r1');
  assert.equal(first.step.state, 'notified', 'a person is told once, like any step');
  const second = service.convertSuspectedStep({ slug: 'demo', phase: 3 }, { by: 'tester' }) as typeof first;
  assert.equal(second.already, true);
  assert.equal(second.step.id, first.step.id);
  // The lane spoke (or ended): there is nothing left to convert.
  record = { phase: 3, status: 'running', sessionId: 's-3' };
  const spoke = service.convertSuspectedStep({ slug: 'demo', phase: 3 }, { by: 'tester' }) as { ok: boolean; status?: number };
  assert.deepEqual([spoke.ok, spoke.status], [false, 409]);
  const none = service.convertSuspectedStep({ slug: 'demo', phase: 9 }, { by: 'tester' }) as { ok: boolean; status?: number };
  assert.deepEqual([none.ok, none.status], [false, 404]);
  service.close();
});

test('the launch door\'s steps live as long as their turn: withdrawn once the phase\'s handoff reads complete', () => {
  const service = new Service(flags as never);
  const handoffs = [{ phase: 5, status: 'complete' }, { phase: 6, status: 'in-progress' }];
  (service as unknown as { store: unknown }).store = { get: () => ({ handoffs }), list: () => [] };
  const door = (phase: number) => service.recordHumanStep({
    slug: 'doorplan', phase, birth: 'plan', step: { kind: 'browser-login', title: `Sign in to Vercel for ${phase}`, open_command: 'vercel login' },
  })!;
  const done = door(5);
  const owed = door(6);
  const tick = (service as unknown as { humanStepClockTick: (now?: number) => { dismissed: string[] } }).humanStepClockTick(Date.now());
  assert.ok(tick.dismissed.includes(done.id), 'a step for a finished phase stops asking');
  assert.ok(!tick.dismissed.includes(owed.id), 'a step for a phase still to run keeps asking');
  assert.equal(service.humanStepsNow().get(done.id)?.note, 'the phase closed');
  service.close();
});
