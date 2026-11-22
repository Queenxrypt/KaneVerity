// Assurance B3: retrieval against the ACTUAL V1 store (local only).
// The store and requirements are copied to a temporary folder first, so the real
// data is never touched. Skipped when there is no local V1 store (fresh clone).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkCitations } from '../src/assurance/citations.ts';
import { blobPath, readStore } from '../src/assurance/storeReader.ts';
import { TESTS_DIR } from './helpers.ts';

const REPO = path.resolve(TESTS_DIR, '..', '..', '..');
const STORE = path.join(REPO, 'data', 'assurance', 'workspace', '.context');
const REQ_DIR = path.join(REPO, 'data', 'assurance', 'requirements', 'generate-an-api-key');
const present = existsSync(path.join(STORE, 'meta.json')) && existsSync(path.join(REQ_DIR, 'v0001.md'));
const sha = (b: string) => createHash('sha256').update(b).digest('hex');

async function fingerprint(dir: string): Promise<string> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(`${path.relative(dir, p)} ${sha(await readFile(p, 'utf8'))}`);
    }
  };
  await walk(dir);
  return out.sort().join('\n');
}

test('the actual V1 store reads, passes the checks, and shows exactly the V1 findings', { skip: !present && 'no local V1 store (fresh clone)' }, async () => {
  const before = await fingerprint(STORE);
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kv-v1-store-'));
  await cp(STORE, path.join(tmp, '.context'), { recursive: true });
  const store = await readStore(path.join(tmp, '.context'), '0.10.5');
  assert.equal(store.ok, true, store.problems.join(' '));
  assert.equal(store.records, 2);
  assert.deepEqual(store.builds, ['0.10.5']);
  assert.equal(store.sources.length, 1);
  assert.equal(store.sources[0].sourceId, 'kv-generate-an-api-key');
  assert.equal(store.useCases.length, 1);
  const uc = store.useCases[0];
  assert.equal(uc.content.title, 'Generate an API key');
  assert.equal(uc.content.criteria.length, 4);
  assert.equal(uc.citations.length, 6);

  // The source blob is byte-identical to requirements version 1.
  const md = await readFile(path.join(REQ_DIR, 'v0001.md'), 'utf8');
  assert.equal(await readFile(blobPath(path.join(tmp, '.context'), store.sources[0].blob), 'utf8'), md);
  const meta = JSON.parse(await readFile(path.join(REQ_DIR, 'v0001.json'), 'utf8'));

  const r = checkCitations({
    requirementsMarkdown: md,
    lineMap: meta.lineMap,
    expectedSourceId: 'kv-generate-an-api-key',
    expectedSourceCid: store.sources[0].cid,
    citations: uc.citations,
    useCaseText: [uc.content.description, uc.content.summary, ...uc.content.criteria].join('\n'),
  });
  assert.equal(r.summary.valid, 6, 'every V1 quote matches its cited requirements line');
  assert.equal(r.summary.outcomesCited, 3);
  assert.equal(r.summary.stepsCited, 0, 'V1 finding: the documented steps are not cited');
  assert.equal(r.summary.hasGaps, true);
  assert.deepEqual(
    r.coverage.filter((c) => c.kind === 'outcome').map((c) => c.docRef),
    ['tutorials/generate-an-api-key.md:24', 'tutorials/generate-an-api-key.md:25', 'tutorials/generate-an-api-key.md:26'],
  );
  assert.ok(r.coverage.filter((c) => c.kind === 'step').every((c) => c.labelsNamed), 'the step labels are named exactly');

  // Kane's own "skipped" verdict is read for information only.
  assert.deepEqual(store.kaneVerdicts.map((v) => [v.resolution, v.attributedTo]), [['skipped', 'human:owner']]);

  // Tampering with the copy is detected.
  const c2 = (await readdir(path.join(tmp, '.context', 'commits'))).sort()[1];
  const rec = JSON.parse(await readFile(path.join(tmp, '.context', 'commits', c2), 'utf8'));
  await writeFile(path.join(tmp, '.context', 'commits', c2), JSON.stringify({ ...rec, created_by: { build: '0.10.7' } }));
  assert.match((await readStore(path.join(tmp, '.context'), '0.10.5')).problems.join(' '), /written by Kane 0\.10\.7, not the pinned 0\.10\.5/);
  await writeFile(path.join(tmp, '.context', 'meta.json'), JSON.stringify({ schema: 'assurance/context@2', canonicalizer: 'v1' }));
  assert.match((await readStore(path.join(tmp, '.context'), '0.10.5')).problems.join(' '), /Unsupported store format/);

  assert.equal(await fingerprint(STORE), before, 'the real V1 store was not modified');
});
