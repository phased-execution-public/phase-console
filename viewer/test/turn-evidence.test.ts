/**
 * What a person attaches (control-tower phase 133, #210) — `turn/evidence.ts`
 * and the `evidence` move.
 *
 *   EV-1  bounded: one piece is at most `EVIDENCE_MAX_BYTES`; one attempt holds
 *         at most `EVIDENCE_PER_ATTEMPT`, and the next check opens the next.
 *   EV-2  screened: text — a note, or a file that reads as text — passes the
 *         secret screen or is refused whole, the value never echoed; an image
 *         is the image it claims to be.
 *   EV-3  stored by content hash, 0600 in a 0700 directory under the
 *         instance's state — never in a tree a session reads — never pushed
 *         and never journalled: the ledger keeps the record, the journal only
 *         the kind and the size.
 *   EV-4  swept by the `turn-evidence` retention sink.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { INSTANCE_STATE_DIR, call, harness, journal, ledgerText, parked } from './turn-harness.ts';

const {
  EVIDENCE_MAX_BYTES, EVIDENCE_PER_ATTEMPT, EVIDENCE_SECRET_REFUSAL, isEvidenceRefusal, screenEvidence, storeEvidence,
} = await import('../server/turn/evidence.ts');
const { collectRetention, planRetention, sanitiseRetention } = await import('../server/retention.ts');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
const ACT = { kind: 'physical', title: 'Plug the key in', proof_type: 'attest' };

test('EV-1 — one piece is bounded, and one attempt holds a bounded number; the next check opens the next', async () => {
  const big = screenEvidence({ kind: 'note', text: 'x'.repeat(EVIDENCE_MAX_BYTES + 1) });
  assert.ok(isEvidenceRefusal(big) && big.status === 413, 'over the size bound');
  const h = harness();
  try {
    const { step } = parked(h, ACT);
    for (let n = 1; n <= EVIDENCE_PER_ATTEMPT; n += 1) {
      const ok = await call(h.svc, 'POST', `/api/human-steps/${step.id}/evidence`, { kind: 'note', text: `piece ${n}` });
      assert.equal(ok.status, 200, `piece ${n}: ${JSON.stringify(ok.body)}`);
    }
    const over = await call(h.svc, 'POST', `/api/human-steps/${step.id}/evidence`, { kind: 'note', text: 'one too many' });
    assert.equal(over.status, 409);
    assert.match(String(over.body.error), new RegExp(`${EVIDENCE_PER_ATTEMPT} pieces`));
    // A check that does not land counts an attempt; the step waits on, and takes the next attempt's evidence.
    h.svc.watchClock.probeNow = async (ref: string) => ({ ref, state: 'pending' as const, detail: 'not yet' });
    const proofStep = parked(h, { kind: 'physical', title: 'Turn it on', proof: 'cmd:"true"' }, 4).step;
    for (let n = 1; n <= EVIDENCE_PER_ATTEMPT; n += 1) {
      await call(h.svc, 'POST', `/api/human-steps/${proofStep.id}/evidence`, { kind: 'note', text: `first ${n}` });
    }
    await call(h.svc, 'POST', `/api/human-steps/${proofStep.id}/check`, {});
    const next = await call(h.svc, 'POST', `/api/human-steps/${proofStep.id}/evidence`, { kind: 'note', text: 'second attempt' });
    assert.equal(next.status, 200, JSON.stringify(next.body));
    assert.equal((next.body.attached as { attempt: number }).attempt, 2);
  } finally { h.cleanup(); }
});

test('EV-2 — text is screened for secrets and refused whole, never echoed; an image is what it claims', async () => {
  for (const offered of [
    { kind: 'note', text: `the token is ${TOKEN}` },
    { kind: 'note', text: `line one\npassword=hunter2hunter2` },
    { kind: 'file', text: `export NPM_TOKEN\n${TOKEN}\n`, name: 'env.sh' },
    { kind: 'file', data: Buffer.from(`key: ${TOKEN}`).toString('base64'), name: 'notes.txt' },
  ]) {
    const refused = screenEvidence(offered);
    assert.ok(isEvidenceRefusal(refused), JSON.stringify(offered).slice(0, 60));
    assert.equal(refused.error, EVIDENCE_SECRET_REFUSAL);
    assert.equal(refused.error.includes(TOKEN), false);
  }
  const fake = screenEvidence({ kind: 'image', mime: 'image/png', data: Buffer.from('not a png at all').toString('base64') });
  assert.ok(isEvidenceRefusal(fake) && /not a image\/png/.test(fake.error));
  const odd = screenEvidence({ kind: 'image', mime: 'image/svg+xml', data: PNG.toString('base64') });
  assert.ok(isEvidenceRefusal(odd), 'an SVG is script, not an image here');
  const png = screenEvidence({ kind: 'image', mime: 'image/png', data: PNG.toString('base64'), name: '../../shot.png' });
  assert.ok(!isEvidenceRefusal(png));
  assert.equal(png.name, 'shot.png', 'a name is its last segment');
  const binary = screenEvidence({ kind: 'file', data: Buffer.from([0, 1, 2, 3, 255]).toString('base64') });
  assert.ok(!isEvidenceRefusal(binary));
  assert.equal(binary.mime, 'application/octet-stream');

  const h = harness();
  try {
    const { step } = parked(h, ACT);
    const refused = await call(h.svc, 'POST', `/api/human-steps/${step.id}/evidence`, { kind: 'note', text: `use ${TOKEN}` });
    assert.equal(refused.status, 400);
    assert.equal(JSON.stringify(refused.body).includes(TOKEN), false, 'never echoed');
    assert.equal(h.svc.humanStepsNow().get(step.id)!.evidence, undefined, 'nothing recorded');
    const dir = join(INSTANCE_STATE_DIR, 'turn-evidence');
    assert.ok(!existsSync(dir) || readdirSync(dir).every((name) => !readFileSync(join(dir, name), 'utf8').includes(TOKEN)), 'nothing stored');
  } finally { h.cleanup(); }
});

test('EV-3 — stored 0600 by content hash under the instance state; the ledger keeps the record, the journal only kind and size, no push', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'pc-evidence-'));
  try {
    const dir = join(scratch, 'turn-evidence');
    const piece = screenEvidence({ kind: 'image', mime: 'image/png', data: PNG.toString('base64') });
    assert.ok(!isEvidenceRefusal(piece));
    const one = storeEvidence(dir, piece);
    const two = storeEvidence(dir, piece);
    assert.equal(one.ref, two.ref, 'the same bytes are one piece');
    assert.deepEqual(readdirSync(dir), [one.ref.slice('sha256:'.length)]);
    assert.equal(statSync(join(dir, readdirSync(dir)[0])).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  } finally { rmSync(scratch, { recursive: true, force: true }); }

  const h = harness();
  try {
    const { state, step } = parked(h, ACT);
    const pushesBefore = h.pushes.length;
    const words = 'The green light came on at 10:42 and stayed on.';
    const attached = await call(h.svc, 'POST', `/api/human-steps/${step.id}/evidence`, { kind: 'note', text: words, name: 'light.txt' });
    assert.equal(attached.status, 200);
    const ref = (attached.body.attached as { ref: string }).ref;
    const file = join(INSTANCE_STATE_DIR, 'turn-evidence', ref.slice('sha256:'.length));
    assert.equal(readFileSync(file, 'utf8'), words);
    assert.ok(!file.startsWith(h.root), 'outside every tree a session reads');
    assert.equal(ledgerText().includes(words), false, 'the ledger keeps the record');
    assert.ok(ledgerText().includes(ref));
    const lines = journal(h.root, state).filter((l) => l.event === 'phase.human-step-evidence');
    assert.equal(lines.length, 1);
    assert.deepEqual(Object.keys(lines[0].data).sort(), ['attempt', 'by', 'bytes', 'evidence', 'kind', 'stepId'], 'its kind and size, and nothing else');
    assert.equal(JSON.stringify(lines[0]).includes(ref.slice(7, 20)), false, 'never its hash');
    assert.equal(JSON.stringify(lines[0]).includes('light.txt'), false, 'never its name');
    assert.equal(h.pushes.length, pushesBefore, 'never pushed');
  } finally { h.cleanup(); }
});

test('EV-4 — the turn-evidence sink ages pieces out and caps the directory, oldest first', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'pc-evidence-sink-'));
  try {
    const dir = join(scratch, 'turn-evidence');
    const old = storeEvidence(dir, { kind: 'note', bytes: Buffer.from('old'), mime: 'text/plain' });
    const recent = storeEvidence(dir, { kind: 'note', bytes: Buffer.from('recent'), mime: 'text/plain' });
    const inventory = collectRetention({ instanceDir: scratch, runsDir: null });
    const pieces = inventory.files.filter((file) => file.sink === 'turn-evidence');
    assert.equal(pieces.length, 2);
    const oldFile = pieces.find((file) => file.path.endsWith(old.ref.slice(7)))!;
    oldFile.at = Date.now() - 40 * 24 * 60 * 60_000;
    const aged = planRetention(inventory, sanitiseRetention({}), Date.now()).filter((a) => a.sink === 'turn-evidence');
    assert.deepEqual(aged.map((a) => a.path), [oldFile.path], 'past thirty days');
    const capped = planRetention(inventory, sanitiseRetention({ turnEvidenceRetainDays: 365, turnEvidenceMaxBytes: 7 } as never), Date.now())
      .filter((a) => a.sink === 'turn-evidence');
    assert.deepEqual(capped.map((a) => a.path), [oldFile.path], 'past the cap, oldest first');
    assert.ok(recent.ref);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
