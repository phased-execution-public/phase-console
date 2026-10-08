/**
 * The guide grammar — ONE parser (control-tower phase 130, #207) — GG-1..4.
 *
 *   GG-1  a guide reads into its why, its numbered steps (each with an
 *         optional command, expected result, warning and link) and its "If it
 *         goes wrong"; it carries its language and direction; written back,
 *         it reads the same.
 *   GG-2  twenty steps and 24 KB at most.
 *   GG-3  anything but http/https in a link is refused.
 *   GG-4  a secret-shaped value on any line is refused by its line number and
 *         never echoed.
 */
import './state-sandbox.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  GUIDE_MAX_BYTES, GUIDE_MAX_STEPS, guideCommands, guideDirection, parseGuide, renderGuide,
} from '../shared/guide-grammar.js';

const FULL = [
  'Signing in lets the run push its branch.',
  'It takes a minute.',
  '',
  '## Steps',
  '1. Run the sign-in in your own terminal.',
  '   ```sh',
  '   gh auth login --web',
  '   ```',
  '   Expect: a browser opens on the device page.',
  '   Warning: do not paste the code anywhere but that page.',
  '   Link: [GitHub device page](https://github.com/login/device)',
  '2. Come back and press *I have done this*.',
  '',
  '## If it goes wrong',
  '- The browser never opens — copy the link and open it yourself.',
  '- It says the code expired — run the command again.',
].join('\n');

test('GG-1: a full guide reads into why, steps and trouble', () => {
  const read = parseGuide(FULL);
  assert.ok(read.ok, JSON.stringify(read));
  if (!read.ok) return;
  const g = read.guide;
  assert.equal(g.summary, 'Signing in lets the run push its branch. It takes a minute.');
  assert.equal(g.steps.length, 2);
  assert.deepEqual(g.steps[0], {
    text: 'Run the sign-in in your own terminal.',
    code: 'gh auth login --web',
    expect: 'a browser opens on the device page.',
    warn: 'do not paste the code anywhere but that page.',
    link: { label: 'GitHub device page', url: 'https://github.com/login/device' },
  });
  assert.deepEqual(g.steps[1], { text: 'Come back and press *I have done this*.' });
  assert.deepEqual(g.trouble, [
    { symptom: 'The browser never opens', fix: 'copy the link and open it yourself.' },
    { symptom: 'It says the code expired', fix: 'run the command again.' },
  ]);
  assert.equal(g.lang, 'en');
  assert.equal(g.dir, 'ltr');
  assert.deepEqual(guideCommands(g), ['gh auth login --web']);
  const again = parseGuide(renderGuide(g));
  assert.ok(again.ok);
  if (again.ok) assert.deepEqual(again.guide, g, 'written back, it reads the same');
});

test('GG-1: a guide carries its language; a right-to-left one says so', () => {
  const fa = parseGuide('برای ورود، این مراحل را دنبال کنید.\n\n## Steps\n1. دستور را اجرا کنید.\n   ```sh\n   gh auth login\n   ```\n', { lang: 'fa' });
  assert.ok(fa.ok);
  if (fa.ok) {
    assert.equal(fa.guide.lang, 'fa');
    assert.equal(fa.guide.dir, 'rtl');
    assert.equal(fa.guide.steps[0]!.code, 'gh auth login', 'the command stays as written, isolated left-to-right by the page');
  }
  assert.equal(guideDirection('ar'), 'rtl');
  assert.equal(guideDirection('pt-BR'), 'ltr');
  const bad = parseGuide('why', { lang: 'not a tag!' });
  assert.equal(bad.ok, false);
});

test('GG-1: a guide that only says why is a guide; one with nothing is not', () => {
  const why = parseGuide('Only you can approve the invoice.');
  assert.ok(why.ok);
  if (why.ok) assert.deepEqual(why.guide.steps, []);
  assert.equal(parseGuide('').ok, false);
  assert.equal(parseGuide('Why.\n\n## Steps\n').ok, false, 'a Steps heading with no step');
  const stray = parseGuide('Why.\n\n## Steps\nnot numbered\n1. a step\n');
  assert.equal(stray.ok, false);
  if (!stray.ok) assert.equal(stray.line, 4);
  const heading = parseGuide('Why.\n\n## Notes\n');
  assert.equal(heading.ok, false);
  if (!heading.ok) assert.match(heading.error, /two headings/);
  const fence = parseGuide('Why.\n\n## Steps\n1. Run it\n   ```sh\n   ls\n');
  assert.equal(fence.ok, false);
  if (!fence.ok) assert.match(fence.error, /never closed/);
});

test('GG-2: twenty steps at most, and 24 KB', () => {
  const steps = (n: number) => `Why.\n\n## Steps\n${Array.from({ length: n }, (_, i) => `${i + 1}. Step ${i + 1}`).join('\n')}\n`;
  assert.equal(GUIDE_MAX_STEPS, 20);
  assert.equal(GUIDE_MAX_BYTES, 24 * 1024);
  assert.ok(parseGuide(steps(20)).ok, 'twenty steps');
  const many = parseGuide(steps(21));
  assert.equal(many.ok, false);
  if (!many.ok) assert.match(many.error, /20 steps at most/);
  const big = parseGuide(`${'a '.repeat(GUIDE_MAX_BYTES / 2)}x`);
  assert.equal(big.ok, false);
  if (!big.ok) assert.match(big.error, /24576 bytes at most/);
});

test('GG-3: http and https links only — in a Link: line and inline', () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'vscode://open', 'ftp://host/x']) {
    const link = parseGuide(`Why.\n\n## Steps\n1. Open it\n   Link: [here](${url})\n`);
    assert.equal(link.ok, false, `Link: ${url}`);
    const inline = parseGuide(`Why, see [this](${url}).`);
    assert.equal(inline.ok, false, `inline ${url}`);
  }
  assert.equal(parseGuide('Why, see <javascript:alert(1)>.').ok, false, 'an autolink is a link');
  assert.ok(parseGuide('Why, see [the docs](https://example.com/docs).').ok);
  assert.ok(parseGuide('Why.\n\n## Steps\n1. Open it\n   Link: http://localhost:4130/#/runs\n').ok, 'a bare http link');
});

test('GG-4: a secret-shaped value on any line is refused by its line number, never echoed', () => {
  const token = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
  for (const [text, line] of [
    [`Why ${token}.`, 1],
    [`Why.\n\n## Steps\n1. Paste it\n   \`\`\`sh\n   gh auth login --with-token ${token}\n   \`\`\`\n`, 6],
    ['Why.\n\n## Steps\n1. Open https://example.com/cb?code=abcdef123456&state=x\n', 4],
    ['Why.\n\n## If it goes wrong\n- password=hunter2hunter2 — reset it\n', 4],
  ] as const) {
    const read = parseGuide(text);
    assert.equal(read.ok, false, text);
    if (!read.ok) {
      assert.equal(read.line, line, `refused at line ${line}`);
      assert.match(read.error, /secret-shaped/);
      assert.ok(!read.error.includes(token) && !read.error.includes('hunter2') && !read.error.includes('abcdef123456'), 'the value is never echoed');
    }
  }
});

test('guideCommands: every command line of every step, comments and prompts aside', () => {
  const read = parseGuide('Why.\n\n## Steps\n1. Two commands\n   ```sh\n   # set up\n   $ npm ci\n   npm test\n   ```\n2. No command\n');
  assert.ok(read.ok);
  if (read.ok) assert.deepEqual(guideCommands(read.guide), ['npm ci', 'npm test']);
  assert.deepEqual(guideCommands(null), []);
});
