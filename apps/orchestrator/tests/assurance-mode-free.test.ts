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
  await assert.rejects(jobs.start({ kind: 'extract', tutorialId: 'generate-an-api-key', confirm: { paid: true } }), (e: Error & { status?: number }) => e.status === 403 && /Only free Assurance commands/.test(e.message));
  // Design is internal (V2): the generic API never starts it, and the runner's own design
  // entry still refuses in free mode.
  await assert.rejects(jobs.start({ kind: 'design', useCase: 'uc-a-b', max: 1, confirm: { paid: true } }), (e: Error & { status?: number }) => e.status === 400 && /Unknown job kind/.test(e.message));
  await assert.rejects(
    jobs.startDesign({ tutorialId: 'generate-an-api-key', ucCid: 'sha256:' + 'd'.repeat(64), useCase: 'uc-1', max: 1, reviewer: 'r', decisionId: 'd20261124-000000-aaaaaa', acknowledgedPrevious: null, requirements: null, confirm: { paid: true } }),
    (e: Error & { status?: number }) => e.status === 403 && /Only free Assurance commands/.test(e.message),
  );
  assert.deepEqual(await jobs.list(), []);
});
