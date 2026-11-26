// Assurance B3/B4/V2: the store reader against an ISOLATED SYNTHETIC store in Kane 0.10.5's
// formats (meta.json, blobs/, commits/ with a linked hash chain, proposals/), built in a
// temporary folder at each state the real store went through: V1 (2 records), V-B4b (3: one
// approval), V2 (7: test-design generation 1) and the forced redesign (9: generation 2).
// Nothing here reads or depends on the project's real Kane store, which keeps growing as
// approved operations run. The requirements are generated from the checked-in outdated
// tutorial fixture with the real generator.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createDocsServer } from '../../docs/server.ts';
import { extractPage } from '../src/discovery/extract.ts';
import { generateRequirements, type GeneratedRequirements } from '../src/assurance/requirements.ts';
import { checkCitations } from '../src/assurance/citations.ts';
import { blobPath, readStore } from '../src/assurance/storeReader.ts';
import { readDesignGraph } from '../src/assurance/designGraph.ts';
import type { Tutorial } from '../src/types.ts';
import { outdatedDocsContent } from './helpers.ts';
import { appendRecord, generation1, generation2Real } from './design-fixture.ts';

const APP = 'http://127.0.0.1:5174';
const sha = (b: string) => createHash('sha256').update(b).digest('hex');
// Record 2's full hash is the one Kane's V-B4a record 3 links to (below), so it is fixed.
const REC1 = `sha256:${sha('synthetic V1 record 1')}`;
const REC2 = 'sha256:3be455d75e7bfa9a789eae9b0db6809ee8af6c2711a29bde04f47939f33fae65';
const SRC = `sha256:${sha('synthetic source node')}`;
const UC = 'sha256:4d998a230cc10b0619f9695e54d82330ab62b07fcbba7b906c4f22625eda47aa';
const PROPOSAL = '20261122T150616-kv-generate-an-api-key';
// The outdated tutorial's steps (S1 names 'Dashboard' and 'Settings'), as V1 described them.
const criteria = ["Start at {{app_url}}/ in a fresh browser session, then on the 'Dashboard' select 'Settings', 'API', and 'Create API Key' in that order.", "The message 'API key generated successfully.' appears after generating the key.", 'The new key is added to the API keys list.', "The key count below the list shows '2 keys'."];
// Kane 0.10.5's record 3 from the V-B4a validation (a disposable copy; never written to any real store).
const VB4A_RECORD_3 = {
  seq: 3,
  prev_hash: REC2,
  ts: '2026-11-22T16:36:10.769Z',
  proposal_id: null,
  nodes: [],
  edges: [],
  review: [{ id: UC, kind: 'review-item', resolution: 'approved', edit: null, reason: null, by: { kind: 'human', id: 'operator' } }],
  supersessions: [],
  source_head_moves: {},
  schema_version: 'assurance/context@1',
  parents: [REC2],
  intent_verb: 'review',
  created_by: { build: '0.10.5', by: { kind: 'human', id: 'operator' } },
};

let docs: Server;
let req: GeneratedRequirements;
let work: string;
const lineOf = (item: string) => req.lineMap.find((e) => e.item === item)!.reqLine;

before(async () => {
  docs = createDocsServer(await outdatedDocsContent());
  await new Promise<void>((r) => docs.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(docs.address() as AddressInfo).port}/tutorials/generate-an-api-key`;
  const page = extractPage(await (await fetch(url)).text(), url, APP);
  assert.equal(page.kind, 'tutorial');
  req = generateRequirements((page as { tutorial: Tutorial }).tutorial, APP);
  work = await mkdtemp(path.join(os.tmpdir(), 'kv-v1-store-'));
});

after(async () => {
  docs.close();
  await rm(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

/**
 * A synthetic store in the V1 state: the source (requirements blob) and the use case, cited by
 * six quotes (the start line with the start criterion, two framing lines, O1-O3; no step), and
 * Kane's own automatic "skipped" verdict attributed to the owner. Optionally later states.
 */
async function storeAt(name: string, state: 'v1' | 'vb4b' | 'v2' | 'redesign'): Promise<string> {
  const dir = path.join(work, name, '.context');
  const lines = req.markdown.split('\n');
  const blob = `sha256:${sha(req.markdown)}`;
  const edge = (line: number, claim: string | null) => ({ type: 'DERIVES', src: SRC, dst: UC, props: { source_id: 'kv-generate-an-api-key', source_cid: SRC, anchor: `L${line}-L${line}`, quote: lines[line - 1], ...(claim ? { claim } : {}) } });
  const framing = [lines.findIndex((l) => l.startsWith('- The journey starts at')) + 1, lines.findIndex((l) => l.startsWith('As a user of the application')) + 1, lines.findIndex((l) => l.startsWith('- The application under test')) + 1];
  assert.ok(framing.every((n) => n > 0), 'the framing lines exist in the generated requirements');
  const edges = [edge(framing[0], criteria[0]), edge(framing[1], null), edge(framing[2], null), ...['O1', 'O2', 'O3'].map((it) => edge(lineOf(it), null))];
  await mkdir(path.join(dir, 'commits'), { recursive: true });
  await mkdir(path.join(dir, 'blobs', blob.slice(7, 9)), { recursive: true });
  await mkdir(path.join(dir, 'proposals', PROPOSAL), { recursive: true });
  await writeFile(path.join(dir, 'meta.json'), JSON.stringify({ schema: 'assurance/context@1', canonicalizer: 'v1' }));
  await writeFile(path.join(dir, 'blobs', blob.slice(7, 9), blob.slice(9)), req.markdown);
  await writeFile(path.join(dir, 'commits', `000001-${REC1.slice(7, 19)}.json`), JSON.stringify({ seq: 1, prev_hash: null, nodes: [{ cid: SRC, label: 'source', content: { source_id: 'kv-generate-an-api-key', blob } }], edges: [], review: [], schema_version: 'assurance/context@1', created_by: { build: '0.10.5' }, proposal_id: null }));
  await writeFile(
    path.join(dir, 'commits', `000002-${REC2.slice(7, 19)}.json`),
    JSON.stringify({ seq: 2, prev_hash: REC1, proposal_id: PROPOSAL, nodes: [{ cid: UC, label: 'usecase', content: { title: 'Generate an API key', description: "On the 'Dashboard', open 'Settings', then 'API', then 'Create API Key'.", summary: 'Generate a key.', actors: ['application user'], value: 'Create a key.', risk: 'high', criteria, derived: true } }], edges, review: [], names: [{ cid: UC, slug: 'uc-1', by: { kind: 'human', id: 'owner' } }], schema_version: 'assurance/context@1', created_by: { build: '0.10.5', by: { kind: 'human', id: 'owner' } } }),
  );
  await writeFile(path.join(dir, 'proposals', PROPOSAL, 'review.json'), JSON.stringify([{ id: 'n1', kind: 'review-item', resolution: 'skipped', by: { kind: 'human', id: 'owner' } }]));
  // The chain for appendRecord (the next record's prev_hash).
  await writeFile(path.join(dir, 'fake-hashes.json'), JSON.stringify({ '1': REC1, '2': REC2 }));
  if (state === 'v1') return dir;
  // V-B4b: KaneVerity's verified approval of uc-1, recorded for its self-declared reviewer.
  const reviewer = { kind: 'human', id: 'kaneverity:test-reviewer' };
  await appendRecord(dir, { review: [{ id: UC, kind: 'review-item', resolution: 'approved', edit: null, reason: null, by: reviewer }], intent_verb: 'review', created_by: { build: '0.10.5', by: reviewer } });
  if (state === 'vb4b') return dir;
  // V2: the one approved test design of uc-1 (generation 1: acs, scenarios, wiring, tests).
  const g1 = generation1(UC);
  for (const rec of g1.records) await appendRecord(dir, rec);
  if (state === 'v2') return dir;
  // The forced redesign (2026-11-25): generation 2, phases scenarios and wiring only.
  for (const rec of generation2Real(UC, g1.ids).records) await appendRecord(dir, rec);
  return dir;
}

/** Remove the fixture's own hash-chain helper file, so the store holds only Kane's own files. */
async function withoutChainFile(dir: string) {
  await rm(path.join(dir, 'fake-hashes.json'));
  return dir;
}

test('V1 (2 records): the store reads, passes the checks, and shows exactly the V1 findings', async () => {
  const dir = await withoutChainFile(await storeAt('v1', 'v1'));
  const store = await readStore(dir, '0.10.5');
  assert.equal(store.ok, true, store.problems.join(' '));
  assert.equal(store.records, 2);
  assert.equal(store.tipPrefix, REC2.slice(7, 19));
  assert.deepEqual(store.builds, ['0.10.5']);
  assert.equal(store.sources.length, 1);
  assert.equal(store.sources[0].sourceId, 'kv-generate-an-api-key');
  assert.equal(store.useCases.length, 1);
  const uc = store.useCases[0];
  assert.equal(uc.cid, UC);
  assert.equal(uc.content.title, 'Generate an API key');
  assert.equal(uc.content.criteria.length, 4);
  assert.equal(uc.citations.length, 6);
  // The source blob is byte-identical to the requirements.
  assert.equal(await readFile(blobPath(dir, store.sources[0].blob), 'utf8'), req.markdown);

  const r = checkCitations({
    requirementsMarkdown: req.markdown,
    lineMap: req.lineMap,
    expectedSourceId: 'kv-generate-an-api-key',
    expectedSourceCid: store.sources[0].cid,
    citations: uc.citations,
    useCaseText: [uc.content.description, uc.content.summary, ...uc.content.criteria].join('\n'),
  });
  assert.equal(r.summary.valid, 6, 'every quote matches its cited requirements line');
  assert.equal(r.summary.outcomesCited, 3);
  assert.equal(r.summary.stepsCited, 0, 'V1 finding: the documented steps are not cited');
  assert.equal(r.summary.hasGaps, true);
  assert.deepEqual(
    r.coverage.filter((c) => c.kind === 'outcome').map((c) => c.docRef),
    ['tutorials/generate-an-api-key.md:24', 'tutorials/generate-an-api-key.md:25', 'tutorials/generate-an-api-key.md:26'],
  );
  assert.ok(r.coverage.filter((c) => c.kind === 'step').every((c) => c.labelsNamed), 'the step labels are named exactly');
  // Kane's own "skipped" verdict is read for information only; nothing is reviewed yet.
  assert.deepEqual(store.kaneVerdicts.map((v) => [v.resolution, v.attributedTo]), [['skipped', 'human:owner']]);
  assert.deepEqual(store.reviews, []);
});

test("V-B4b (3 records): record 3 is exactly one approval of uc-1 for KaneVerity's self-declared reviewer, review-only, linked to record 2", async () => {
  const dir = await withoutChainFile(await storeAt('vb4b', 'vb4b'));
  const store = await readStore(dir, '0.10.5');
  assert.equal(store.ok, true, store.problems.join(' '));
  assert.equal(store.records, 3);
  assert.equal(store.reviews.length, 1);
  const r = store.reviews[0];
  assert.equal(r.seq, 3);
  assert.equal(r.ucCid, UC);
  assert.equal(r.resolution, 'approved');
  assert.match(r.by, /^human:kaneverity:[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/);
  assert.equal(r.reviewOnly, true);
  assert.equal(r.itemsInRecord, 1);
  assert.equal(r.prevHash, REC2);
  assert.equal(r.build, '0.10.5');
  assert.equal(store.useCases.length, 1, 'no new use case');
});

test("V-B4a: Kane 0.10.5's own record 3, appended to the V1 records, is read as one approval of uc-1 linked to record 2", async () => {
  const dir = await withoutChainFile(await storeAt('vb4a', 'v1'));
  await writeFile(path.join(dir, 'commits', '000003-c0defa5acc39.json'), JSON.stringify(VB4A_RECORD_3));
  const s3 = await readStore(dir, '0.10.5');
  assert.equal(s3.ok, true, s3.problems.join(' '));
  assert.equal(s3.records, 3);
  assert.equal(s3.tipPrefix, 'c0defa5acc39');
  assert.deepEqual(s3.reviews, [
    {
      seq: 3,
      recordPrefix: 'c0defa5acc39',
      prevHash: REC2,
      ucCid: UC,
      resolution: 'approved',
      by: 'human:operator',
      reviewOnly: true,
      itemsInRecord: 1,
      build: '0.10.5',
      recordHash: null, // the tip's full hash comes from `context view`
    },
  ]);
  assert.equal(s3.useCases[0].cid, UC, 'approval does not change the content id');
  assert.equal(s3.useCases[0].citations.length, 6);
});

test('V2 (7 records): records 4-7 are exactly one test design of uc-1 (generation 1), by the design agent, nothing superseded', async () => {
  const dir = await withoutChainFile(await storeAt('v2', 'v2'));
  const store = await readStore(dir, '0.10.5');
  assert.equal(store.ok, true, store.problems.join(' '));
  assert.equal(store.records, 7);
  const g = await readDesignGraph(dir, null);
  const design = g.records.slice(3);
  assert.deepEqual(design.map((x) => [x.seq, x.intentVerb, x.createdBy, x.designPhase?.phase, x.designPhase?.generation, x.designPhase?.ucRoot]), [4, 5, 6, 7].map((seq, i) => [seq, 'design', 'ai:design-agent', ['acs', 'scenarios', 'wiring', 'tests'][i], 1, UC]));
  assert.equal(g.supersededNodes.size, 0);
  assert.deepEqual([...g.nodes.values()].filter((n) => n.seq >= 4).map((n) => n.label).sort(), ['ac', 'ac', 'ac', 'gap', 'scenario', 'test']);
});

test('forced redesign (9 records): records 8-9 are generation 2 (scenarios and wiring only); sc-1 superseded by its reuse_of successor, nothing else', async () => {
  const dir = await withoutChainFile(await storeAt('redesign', 'redesign'));
  const store = await readStore(dir, '0.10.5');
  assert.equal(store.ok, true, store.problems.join(' '));
  assert.equal(store.records, 9);
  const g = await readDesignGraph(dir, null);
  const gen2 = g.records.slice(7);
  assert.deepEqual(gen2.map((x) => [x.seq, x.intentVerb, x.createdBy, x.designPhase?.phase, x.designPhase?.generation]), [[8, 'design', 'ai:design-agent', 'scenarios', 2], [9, 'design', 'ai:design-agent', 'wiring', 2]]);
  assert.equal(gen2[0].designGeneration?.supersedesGeneration, 1);
  assert.deepEqual([...g.supersededNodes.values()].map((x) => [x.seq, x.reason]), [[8, '--force redesign of uc-1 by design-agent (reuse_of successor)']]);
  assert.deepEqual([...g.nodes.values()].filter((n) => n.seq >= 8).map((n) => n.label), ['scenario']);
});

test('tampering is detected: a record from another Kane build, a broken link, an unexpected file, an unsupported format', async () => {
  const dir = await withoutChainFile(await storeAt('tamper', 'v1'));
  const c2 = path.join(dir, 'commits', `000002-${REC2.slice(7, 19)}.json`);
  const rec = JSON.parse(await readFile(c2, 'utf8'));
  await writeFile(c2, JSON.stringify({ ...rec, created_by: { build: '0.10.7' } }));
  assert.match((await readStore(dir, '0.10.5')).problems.join(' '), /written by Kane 0\.10\.7, not the pinned 0\.10\.5/);
  await writeFile(c2, JSON.stringify({ ...rec, prev_hash: `sha256:${'0'.repeat(64)}` }));
  assert.match((await readStore(dir, '0.10.5')).problems.join(' '), /Commit 2 does not link to the previous commit/);
  await writeFile(c2, JSON.stringify(rec));
  assert.equal((await readStore(dir, '0.10.5')).ok, true, 'restored');
  // A JSON file that is not named like a commit (the reader lists only *.json in commits/).
  await writeFile(path.join(dir, 'commits', 'extra-record.json'), JSON.stringify(rec));
  assert.match((await readStore(dir, '0.10.5')).problems.join(' '), /Unexpected file in commits\/: extra-record\.json/);
  await rm(path.join(dir, 'commits', 'extra-record.json'));
  await writeFile(path.join(dir, 'meta.json'), JSON.stringify({ schema: 'assurance/context@2', canonicalizer: 'v1' }));
  assert.match((await readStore(dir, '0.10.5')).problems.join(' '), /Unsupported store format/);
});
