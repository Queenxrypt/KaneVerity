// Assurance B3: retrieval against the ACTUAL V1 store (local only).
// The store and requirements are copied to a temporary folder first, so the real
// data is never touched. Skipped when there is no local V1 store (fresh clone).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
// Kane 0.10.5's record 3 from the V-B4a validation (a disposable copy; never written to the real store).
const VB4A_RECORD_3 = {
  seq: 3,
  prev_hash: 'sha256:3be455d75e7bfa9a789eae9b0db6809ee8af6c2711a29bde04f47939f33fae65',
  ts: '2026-11-22T16:36:10.769Z',
  proposal_id: null,
  nodes: [],
  edges: [],
  review: [{ id: 'sha256:4d998a230cc10b0619f9695e54d82330ab62b07fcbba7b906c4f22625eda47aa', kind: 'review-item', resolution: 'approved', edit: null, reason: null, by: { kind: 'human', id: 'operator' } }],
  supersessions: [],
  source_head_moves: {},
  schema_version: 'assurance/context@1',
  parents: ['sha256:3be455d75e7bfa9a789eae9b0db6809ee8af6c2711a29bde04f47939f33fae65'],
  intent_verb: 'review',
  created_by: { build: '0.10.5', by: { kind: 'human', id: 'operator' } },
};
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
  // 2 records (V1), or 3 after V-B4b wrote KaneVerity's verified approval (checked below).
  assert.ok(store.records === 2 || store.records === 3, `records: ${store.records}`);
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
  const REC2 = 'sha256:3be455d75e7bfa9a789eae9b0db6809ee8af6c2711a29bde04f47939f33fae65';
  if (store.records === 3) {
    // After V-B4b: record 3 is exactly one approval of uc-1, recorded for KaneVerity's
    // self-declared reviewer, review-only, linked to record 2. Nothing else was added.
    assert.equal(store.reviews.length, 1);
    const r = store.reviews[0];
    assert.equal(r.seq, 3);
    assert.equal(r.ucCid, uc.cid);
    assert.equal(r.resolution, 'approved');
    assert.match(r.by, /^human:kaneverity:[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/);
    assert.equal(r.reviewOnly, true);
    assert.equal(r.itemsInRecord, 1);
    assert.equal(r.prevHash, REC2);
    assert.equal(r.build, '0.10.5');
    assert.equal(store.useCases.length, 1, 'no new use case');
    // The rest of this test replays V-B4a's record 3 onto the V1 records only.
    await rm(path.join(tmp, '.context', 'commits', (await readdir(path.join(tmp, '.context', 'commits'))).sort()[2]));
  } else {
    // Before V-B4b: no committed review items (uc-1 unreviewed).
    assert.deepEqual(store.reviews, []);
  }

  // B4: the exact record Kane 0.10.5 wrote in the V-B4a validation (on a disposable copy),
  // appended to the V1 records, is read as one approval of uc-1, linked to record 2.
  await writeFile(path.join(tmp, '.context', 'commits', '000003-c0defa5acc39.json'), JSON.stringify(VB4A_RECORD_3));
  const s3 = await readStore(path.join(tmp, '.context'), '0.10.5');
  assert.equal(s3.ok, true, s3.problems.join(' '));
  assert.equal(s3.records, 3);
  assert.equal(s3.tipPrefix, 'c0defa5acc39');
  assert.deepEqual(s3.reviews, [
    {
      seq: 3,
      recordPrefix: 'c0defa5acc39',
      prevHash: 'sha256:3be455d75e7bfa9a789eae9b0db6809ee8af6c2711a29bde04f47939f33fae65',
      ucCid: uc.cid,
      resolution: 'approved',
      by: 'human:operator',
      reviewOnly: true,
      itemsInRecord: 1,
      build: '0.10.5',
      recordHash: null, // the tip's full hash comes from `context view`
    },
  ]);
  assert.equal(s3.useCases[0].cid, uc.cid, 'approval does not change the content id');
  assert.equal(s3.useCases[0].citations.length, 6);
  await rm(path.join(tmp, '.context', 'commits', '000003-c0defa5acc39.json'));

  // Tampering with the copy is detected.
  const c2 = (await readdir(path.join(tmp, '.context', 'commits'))).sort()[1];
  const rec = JSON.parse(await readFile(path.join(tmp, '.context', 'commits', c2), 'utf8'));
  await writeFile(path.join(tmp, '.context', 'commits', c2), JSON.stringify({ ...rec, created_by: { build: '0.10.7' } }));
  assert.match((await readStore(path.join(tmp, '.context'), '0.10.5')).problems.join(' '), /written by Kane 0\.10\.7, not the pinned 0\.10\.5/);
  await writeFile(path.join(tmp, '.context', 'meta.json'), JSON.stringify({ schema: 'assurance/context@2', canonicalizer: 'v1' }));
  assert.match((await readStore(path.join(tmp, '.context'), '0.10.5')).problems.join(' '), /Unsupported store format/);

  assert.equal(await fingerprint(STORE), before, 'the real V1 store was not modified');
});
