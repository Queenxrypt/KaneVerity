import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isAllowedEntryName, readEntry, readIndex, ZIP_LIMITS, ZipError } from '../src/kane/zip.ts';
import { readEvidence } from '../src/kane/evidence.ts';
import { makeZip, TINY_JPEG } from './helpers.ts';

const T = 'tests/acmedesk-x-1a2b3c4d';

test('allowed Kane evidence paths are accepted', () => {
  for (const n of ['run.yaml', 'failure.yaml', `${T}/result.yaml`, `${T}/steps/2-0-2/screenshot.jpg`, `${T}/steps/2-0-2/step.json`, `${T}/logs/0-run.log`, `${T}/auteur/execution.json`]) {
    assert.ok(isAllowedEntryName(n), n);
  }
});

test('traversal, absolute, backslash, drive-letter and unexpected paths are rejected', () => {
  for (const n of ['../evil', `${T}/../../x`, '/etc/passwd', 'C:/Windows/x', `${T}\\steps\\x`, `${T}/steps/2-0-2/payload.exe`, 'node_modules/x.js', '.git/config', `${T}/steps/2-0-2/./screenshot.jpg`, 'a\0b']) {
    assert.equal(isAllowedEntryName(n), false, n);
  }
});

test('reader ignores unexpected entries and reads allowed ones by name only', () => {
  const zip = makeZip([
    { name: `${T}/steps/1-0-1/step.json`, data: JSON.stringify({ ordinal: 1, status: 'passed', summary: 'navigate', url: 'http://127.0.0.1:5174/' }) },
    { name: '../../escape.txt', data: 'x' },
    { name: `${T}/steps/1-0-1/evil.sh`, data: 'rm -rf /' },
  ]);
  const idx = readIndex(zip);
  assert.equal(idx.entries.size, 1);
  assert.deepEqual(idx.rejected.sort(), [`${T}/steps/1-0-1/evil.sh`, '../../escape.txt'].sort());
  assert.match(readEntry(zip, [...idx.entries.values()][0]).toString(), /navigate/);
});

test('entry count, size and zip-bomb limits are enforced', () => {
  const tooMany = makeZip(Array.from({ length: ZIP_LIMITS.maxEntries + 1 }, (_, i) => ({ name: `meta/m${i}.yaml`, data: 'x', method: 0 as const })));
  assert.throws(() => readIndex(tooMany), ZipError);

  const big = makeZip([{ name: `${T}/logs/big.log`, data: Buffer.alloc(ZIP_LIMITS.maxEntryBytes + 1, 0x41) }]);
  assert.equal(readIndex(big).entries.size, 0, 'oversized entry is rejected');

  // Declared size smaller than the real inflated size: must fail, not over-read.
  const lying = makeZip([{ name: `${T}/logs/bomb.log`, data: Buffer.alloc(200_000, 0x41), declaredSize: 10 }]);
  const idx = readIndex(lying);
  assert.throws(() => readEntry(lying, [...idx.entries.values()][0]));

  assert.throws(() => readIndex(Buffer.from('not a zip at all, definitely not')), ZipError);
});

test('evidence summary: steps, failure message, and only real JPEG screenshots', async () => {
  const zip = makeZip([
    { name: `${T}/steps/1-0-1/step.json`, data: JSON.stringify({ ordinal: 1, kind: 'navigate', status: 'passed', summary: 'navigate: go', url: 'http://127.0.0.1:5174/' }) },
    { name: `${T}/steps/2-0-2/step.json`, data: JSON.stringify({ ordinal: 2, kind: '', status: 'failed', summary: "wait: locate 'Settings'", url: 'http://127.0.0.1:5174/' }) },
    { name: `${T}/steps/1-0-1/screenshot.jpg`, data: TINY_JPEG },
    { name: `${T}/steps/2-0-2/screenshot.jpg`, data: Buffer.from('<html>not a jpeg</html>') },
    { name: `${T}/steps/2-0-2/failure.yaml`, data: "step: 0-2\nstatus: broken\nerror:\n  message: The Dashboard has no exact\n    'Settings' element.\ntitle: Settings missing\n" },
  ]);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kv-zip-'));
  const file = path.join(dir, 'pack.evidence');
  await writeFile(file, zip);
  const ev = await readEvidence(file);
  assert.equal(ev.valid, true);
  assert.deepEqual(ev.steps.map((s) => s.status), ['passed', 'failed']);
  assert.equal(ev.screenshots.length, 1);
  assert.equal(ev.failureTitle, 'Settings missing');
  assert.match(ev.failureMessage ?? '', /no exact 'Settings' element/);
  assert.ok(ev.problems.some((p) => /not a JPEG/.test(p)));
});

const REAL_PACK = process.env.KV_REAL_EVIDENCE_PACK;
test('real Kane evidence pack (local only, skipped if KV_REAL_EVIDENCE_PACK is not set)', { skip: !REAL_PACK || !existsSync(REAL_PACK) }, async () => {
  const ev = await readEvidence(REAL_PACK!);
  assert.equal(ev.valid, true);
  assert.deepEqual(ev.rejectedEntries, []);
  assert.ok(ev.steps.length > 0 && ev.screenshots.length > 0);
});
