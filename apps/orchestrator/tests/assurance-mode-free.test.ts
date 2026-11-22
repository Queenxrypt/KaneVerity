// Assurance B2: in "free" mode only commands that use no credits may start.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.KANEVERITY_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'kv-free-'));
process.env.KANEVERITY_ASSURANCE_MODE = 'free';
const { AssuranceJobs } = await import('../src/assurance/jobs.ts');

test('free mode refuses every paid command, whatever the confirmation', async () => {
  const jobs = new AssuranceJobs({ entry: path.join(import.meta.dirname, 'fake-kane-assurance.cjs') });
  for (const req of [{ kind: 'extract', tutorialId: 'generate-an-api-key', confirm: { paid: true } }, { kind: 'design', useCase: 'uc-a-b', max: 1, confirm: { paid: true } }]) {
    await assert.rejects(jobs.start(req), (e: Error & { status?: number }) => e.status === 403 && /Only free Assurance commands/.test(e.message), JSON.stringify(req));
  }
  assert.deepEqual(await jobs.list(), []);
});
