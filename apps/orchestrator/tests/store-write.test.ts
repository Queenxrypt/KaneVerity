// Regression: record writes must not be lost when the file is read at the same time.
// On Windows, replacing a file that another request is reading fails with
// EPERM/EBUSY. Before the fix the write was silently lost (a correction stayed in
// "analyzing", with a stray record.json.<pid>.tmp left behind), and concurrent
// writes in one process shared a single temporary file name.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJson } from '../src/store.ts';

test('concurrent writes while readers poll: every write lands, in call order, and no temp files remain', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kv-store-'));
  const file = path.join(dir, 'record.json');
  await writeJson(file, { n: -1 });

  // Two readers polling every few milliseconds: far more often than the UI (every 3s).
  let reading = true;
  let reads = 0;
  let partial = 0;
  const readers = Array.from({ length: 2 }, async () => {
    while (reading) {
      // readJson is what the orchestrator uses: it must always return a whole record.
      if ((await readJson(file)) === null) partial++;
      else reads++;
      await new Promise((r) => setTimeout(r, 2));
    }
  });

  const N = 40;
  const results: PromiseSettledResult<void>[] = [];
  try {
    const writes: Promise<void>[] = [];
    for (let n = 0; n < N; n++) writes.push(writeJson(file, { n, pad: 'x'.repeat(4000) }));
    results.push(...(await Promise.allSettled(writes)));
  } finally {
    reading = false;
    await Promise.all(readers);
  }
  const lost = results.filter((r) => r.status === 'rejected');
  assert.equal(lost.length, 0, `writes lost: ${lost.map((r) => String((r as PromiseRejectedResult).reason)).slice(0, 3).join('; ')}`);

  assert.equal((await readJson<{ n: number }>(file))?.n, N - 1, 'the last call wins');
  assert.equal(partial, 0, 'readers never see a partially written file');
  assert.ok(reads > 0);
  assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith('.tmp')), [], 'no temporary files left behind');
});

test('the value is captured when writeJson is called, not when the queued write runs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kv-store-'));
  const file = path.join(dir, 'record.json');
  const rec = { state: 'analyzing' };
  const first = writeJson(file, rec);
  rec.state = 'needs_exploration';
  const second = writeJson(file, rec);
  await Promise.all([first, second]);
  assert.equal((await readJson<{ state: string }>(file))?.state, 'needs_exploration');
});
