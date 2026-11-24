// Assurance B3 end to end: retrieval through the runner (fake Kane CLI, free reads
// only), integrity cross-checks, KaneVerity review and the design gate. The store
// is a synthetic one in exactly the format validated against the real V1 store.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDocsServer } from '../../docs/server.ts';
import { outdatedDocsContent, TESTS_DIR } from './helpers.ts';

let docs: Server;
let app: Server;
let orch: Server;
let api: string;
let work: string;
let contentDir: string;
let scriptFile: string;
let logFile: string;
let storeDir: string;
const T = 'generate-an-api-key';
const H1 = '3ccad232cdf0' + 'a'.repeat(52);
const H2 = '3be455d75e7b' + 'b'.repeat(52);
const SRC = 'sha256:' + '6ee2d0e7' + 'c'.repeat(56);
const UC = 'sha256:' + '4d998a23' + 'd'.repeat(56);
const BLOB = 'sha256:' + '55709884' + 'e'.repeat(56);
const listen = (s: Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const j = async (r: Response): Promise<any> => r.json();
const H = { 'Content-Type': 'application/json', 'X-KaneVerity': '1' };
const post = (p: string, body: unknown = {}) => fetch(api + p, { method: 'POST', headers: H, body: JSON.stringify(body) });
const U = `/api/assurance/usecases/${T}`;
const ucPath = `${U}/${UC.slice(7)}/review`;

let reqMd = '';
let lineOf: (item: string) => number;
const criteria = ["Start at {{app_url}}/ in a fresh browser session, then select 'Developer Settings', 'API Keys', and 'Generate Key' in that order.", "The message 'API key generated successfully.' appears after generating the key.", 'The new key is added to the API keys list.', "The key count below the list shows '2 keys'."];

/** Write a store in the V1 format, citing the given requirements items. */
async function writeStore(opts: { blobText?: string; citeItems?: string[] } = {}) {
  const lines = reqMd.split('\n');
  const edge = (line: number, claim: string | null) => ({ type: 'DERIVES', src: SRC, dst: UC, props: { source_id: 'kv-generate-an-api-key', source_cid: SRC, anchor: `L${line}-L${line}`, quote: lines[line - 1], ...(claim ? { claim } : {}) } });
  const items = opts.citeItems ?? ['O1', 'O2', 'O3'];
  const edges = [edge(19, criteria[0]), ...items.map((it) => edge(lineOf(it), null))];
  await mkdir(path.join(storeDir, 'commits'), { recursive: true });
  await mkdir(path.join(storeDir, 'blobs', BLOB.slice(7, 9)), { recursive: true });
  await mkdir(path.join(storeDir, 'proposals', '20261122T150616-kv-generate-an-api-key'), { recursive: true });
  await writeFile(path.join(storeDir, 'meta.json'), JSON.stringify({ schema: 'assurance/context@1', canonicalizer: 'v1' }));
  await writeFile(path.join(storeDir, 'blobs', BLOB.slice(7, 9), BLOB.slice(9)), opts.blobText ?? reqMd);
  await writeFile(path.join(storeDir, 'commits', `000001-${H1.slice(0, 12)}.json`), JSON.stringify({ seq: 1, prev_hash: null, nodes: [{ cid: SRC, label: 'source', content: { source_id: 'kv-generate-an-api-key', blob: BLOB } }], edges: [], schema_version: 'assurance/context@1', created_by: { build: '0.10.5' }, proposal_id: null }));
  await writeFile(
    path.join(storeDir, 'commits', `000002-${H2.slice(0, 12)}.json`),
    JSON.stringify({ seq: 2, prev_hash: `sha256:${H1}`, proposal_id: '20261122T150616-kv-generate-an-api-key', nodes: [{ cid: UC, label: 'usecase', content: { title: 'Generate an API key', description: "Open 'Developer Settings', then 'API Keys', then 'Generate Key'.", summary: 'Generate a key.', actors: ['application user'], value: 'Create a key.', risk: 'high', criteria, derived: true } }], edges, schema_version: 'assurance/context@1', created_by: { build: '0.10.5', by: { kind: 'human', id: 'owner' } } }),
  );
  // Kane's own automatic verdict, attributed to the owner (the V1 finding).
  await writeFile(path.join(storeDir, 'proposals', '20261122T150616-kv-generate-an-api-key', 'review.json'), JSON.stringify([{ id: 'n1', kind: 'review-item', resolution: 'skipped', by: { kind: 'human', id: 'owner' } }]));
  return edges.map((e) => e.props.anchor);
}

/** Script the fake Kane CLI's three free reads to match (or contradict) the store. */
async function scriptReads(anchors: string[], o: { trust?: string; fsckOk?: boolean; viewAnchors?: string[]; viewTip?: string } = {}) {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/'/g, '&#39;');
  const view = {
    meta: { schema: 'assurance/context@1', tipHash: o.viewTip ?? `sha256:${H2}`, storePath: 'C:\\Users\\someone\\private' },
    nodes: [{ cid: UC, label: 'usecase', trust: o.trust ?? 'derived' }, { cid: SRC, label: 'source', trust: 'derived' }],
    edges: [{ src: SRC, dst: UC, anchors: o.viewAnchors ?? anchors }],
    contentHtml: { [UC]: `<ul class="crit">${criteria.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` },
  };
  await writeFile(
    scriptFile,
    JSON.stringify({
      'context fsck': { stdout: [JSON.stringify({ ok: o.fsckOk ?? true, issues: o.fsckOk === false ? [{ code: 'X' }] : [], records: 2 })], exit: o.fsckOk === false ? 1 : 0 },
      'context list': { stdout: [JSON.stringify({ id: 'kv-generate-an-api-key', cid: SRC, label: 'source', title: 'kv-generate-an-api-key', trust: '-', fresh: 'fresh' }), JSON.stringify({ id: 'uc-1', cid: UC, label: 'usecase', title: 'Generate an API key', trust: o.trust ?? 'derived', fresh: 'fresh' })], exit: 0 },
      'context view': { stdout: [JSON.stringify(view)], exit: 0 },
    }),
  );
}

before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), 'kv-usecases-'));
  scriptFile = path.join(work, 'script.json');
  logFile = path.join(work, 'invocations.ndjson');
  contentDir = await outdatedDocsContent();
  docs = createDocsServer(contentDir);
  const docsUrl = (await listen(docs)) + '/';
  app = createServer((_q, s) => s.end('<!doctype html><title>AcmeDesk</title>'));
  const appUrl = (await listen(app)) + '/';
  Object.assign(process.env, {
    KANEVERITY_DATA_DIR: path.join(work, 'data'),
    KANEVERITY_ASSURANCE_MODE: 'free',
    KANEVERITY_REVIEWER: 'b3-reviewer',
    KANE_CLI_ENTRY: path.join(TESTS_DIR, 'fake-kane-assurance.cjs'),
    KANEVERITY_DOCS_CONTENT_DIR: contentDir,
    KANEVERITY_ALLOWED_DOCS_ORIGINS: new URL(docsUrl).origin,
    KANEVERITY_ALLOWED_APP_ORIGINS: new URL(appUrl).origin,
    FAKE_ASSURANCE_LOG: logFile,
    FAKE_ASSURANCE_SCRIPT: scriptFile,
  });
  storeDir = path.join(work, 'data', 'assurance', 'workspace', '.context');
  await writeFile(scriptFile, '{}');
  const { createOrchestrator } = await import('../server.ts');
  orch = createOrchestrator();
  api = await listen(orch);
  assert.equal((await post('/api/project', { docsUrl, appUrl })).status, 200);
  assert.equal((await post('/api/discover')).status, 200);
  assert.equal((await post(`/api/assurance/requirements/${T}`)).status, 201);
  const req = await j(await fetch(`${api}/api/assurance/requirements/${T}`));
  reqMd = req.shown.markdown;
  lineOf = (item) => req.shown.lineMap.find((e: { item: string }) => e.item === item).reqLine;
});

after(() => {
  docs.close();
  app.close();
  orch.close();
});

test('before any retrieval: no snapshot', async () => {
  const d = await j(await fetch(api + U));
  assert.equal(d.snapshot, null);
  assert.deepEqual(d.useCases, []);
});

test('retrieval: free reads only, integrity passes, use case awaits KaneVerity review and cannot go to design', async () => {
  const anchors = await writeStore();
  await scriptReads(anchors);
  const storeBefore = await readdir(path.join(storeDir, 'commits'));
  const r = await post(`${U}/retrieve`);
  assert.equal(r.status, 200);
  const d = await j(r);
  assert.equal(d.snapshot.integrity.ok, true, d.snapshot.integrity.problems.join(' '));
  assert.equal(d.snapshot.requirements.version, 1);
  assert.equal(d.snapshot.requirementsCurrent, true);
  const uc = d.useCases[0];
  assert.equal(uc.logicalId, 'uc-1');
  assert.equal(uc.review.state, 'awaiting_review');
  assert.equal(uc.design.eligible, false);
  assert.match(uc.design.reasons.join(' '), /not been reviewed in KaneVerity/);
  assert.equal(uc.citationReport.summary.outcomesCited, 3);
  assert.equal(uc.citationReport.summary.stepsCited, 0, 'steps not cited: shown as a gap');
  assert.equal(uc.citationReport.summary.hasGaps, true);
  assert.deepEqual(uc.kaneVerdicts, [{ resolution: 'skipped', attributedTo: 'human:owner', countsAsReview: false }]);
  assert.deepEqual(uc.criteria[0].citations, [0], 'criterion 1 is linked to its citation');
  assert.ok(!JSON.stringify(d).includes('someone'), "the view's local store path never reaches the response");
  assert.deepEqual(await readdir(path.join(storeDir, 'commits')), storeBefore, 'nothing written to the store');
  const calls = (await readFile(logFile, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l).argv.join(' '));
  assert.ok(calls.includes('context fsck --json') && calls.includes('context list --json') && calls.includes('context view --json'));
  assert.ok(!calls.some((c) => /review|extract|design|ingest/.test(c)), 'only free reads ran');
});

test("REGRESSION: Kane's trust \"trusted\" and Kane's auto verdict never count as KaneVerity approval", async () => {
  await scriptReads(await writeStore(), { trust: 'trusted' });
  const d = await j(await post(`${U}/retrieve`));
  assert.equal(d.useCases[0].kaneTrust, 'trusted');
  assert.equal(d.useCases[0].review.state, 'awaiting_review');
  assert.equal(d.useCases[0].design.eligible, false);
});

test('explicit rejection and approval through the review interface', async () => {
  let r = await post(ucPath, { decision: 'approve' });
  assert.equal(r.status, 400, 'gaps need an explicit acknowledgement');
  assert.match((await j(r)).error, /citation gaps/);
  r = await post(ucPath, { decision: 'reject' });
  assert.equal(r.status, 400);
  assert.match((await j(r)).error, /needs a reason/);
  assert.equal((await fetch(api + ucPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'reject', reason: 'x' }) })).status, 403, 'needs X-KaneVerity');

  let d = await j(await post(ucPath, { decision: 'reject', reason: 'Steps are not cited.' }));
  assert.equal(d.useCases[0].review.state, 'rejected');
  assert.equal(d.useCases[0].design.eligible, false);
  assert.match(d.useCases[0].design.reasons.join(' '), /rejected/);

  d = await j(await post(ucPath, { decision: 'approve', acknowledgeGaps: true, reason: 'Steps checked by the fidelity check.' }));
  const uc = d.useCases[0];
  assert.equal(uc.review.state, 'approved');
  // B4: an approval alone is not enough. Here Kane already lists the use case as trusted
  // (scripted above) without a KaneVerity-written approval, so nothing is written to Kane.
  assert.equal(uc.design.eligible, false);
  assert.match(uc.design.reasons.join(' '), /not been recorded in Kane/);
  assert.match(d.note, /not through an approval KaneVerity wrote and verified/);
  assert.deepEqual(uc.review.history.map((h: { decision: string; acknowledgedGaps: boolean; by: string; reviewer: string | null }) => [h.decision, h.acknowledgedGaps, h.by, h.reviewer]), [['rejected', false, 'kaneverity-review', 'b3-reviewer'], ['approved', true, 'kaneverity-review', 'b3-reviewer']]);
  assert.equal(uc.review.history[1].gapsAtDecision.stepsCited, 0, 'the gaps at the time are recorded with the decision');
  assert.equal((await post(`${U}/${'f'.repeat(64)}/review`, { decision: 'approve' })).status, 404);
});

test('a fully cited use case can be approved without an acknowledgement', async () => {
  await scriptReads(await writeStore({ citeItems: ['S1', 'S2', 'S3', 'O1', 'O2', 'O3'] }));
  const d = await j(await post(`${U}/retrieve`));
  assert.equal(d.useCases[0].citationReport.summary.hasGaps, false);
  assert.equal(d.useCases[0].review.state, 'approved', 'the earlier approval applies to the same use-case version');
});

test('integrity failures block review: mismatched view, damaged store, wrong requirements bytes', async () => {
  const anchors = await writeStore();
  for (const [label, opts, re] of [
    ['view anchors differ', { viewAnchors: ['L1-L1'] }, /anchors differ/],
    ['fsck reports damage', { fsckOk: false }, /damaged store/],
    ['view tip differs', { viewTip: 'sha256:' + '0'.repeat(64) }, /latest commit does not match/],
  ] as [string, object, RegExp][]) {
    await scriptReads(anchors, opts);
    const d = await j(await post(`${U}/retrieve`));
    assert.equal(d.snapshot.integrity.ok, false, label);
    assert.match(d.snapshot.integrity.problems.join(' '), re, label);
    assert.equal(d.useCases[0].design.eligible, false, label);
    const r = await post(ucPath, { decision: 'approve', acknowledgeGaps: true });
    assert.equal(r.status, 409, `${label}: no review on a failed retrieval`);
  }
  await scriptReads(await writeStore({ blobText: reqMd.replace('Create API Key', 'Make Key') }));
  const d = await j(await post(`${U}/retrieve`));
  assert.match(d.snapshot.integrity.problems.join(' '), /match no stored KaneVerity requirements version/);
});

test('every retrieval is kept as an append-only snapshot', async () => {
  const files = (await readdir(path.join(work, 'data', 'assurance', 'usecases', T))).sort();
  assert.ok(files.length >= 6);
  assert.deepEqual(files, files.map((_, i) => `snapshot-${String(i + 1).padStart(4, '0')}.json`));
});

test('when the requirements change, an approved use case can no longer go to design', async () => {
  await scriptReads(await writeStore({ citeItems: ['S1', 'S2', 'S3', 'O1', 'O2', 'O3'] }));
  const before = (await j(await post(`${U}/retrieve`))).useCases[0];
  assert.equal(before.review.state, 'approved');
  assert.doesNotMatch(before.design.reasons.join(' '), /no longer the current version/);
  const file = path.join(contentDir, 'tutorials', 'generate-an-api-key.md');
  const original = await readFile(file, 'utf8');
  await writeFile(file, original.replace('3. Click **Create API Key**.', '3. Click **Make Key**.'));
  await post('/api/discover');
  await post(`/api/assurance/requirements/${T}`);
  const d = await j(await fetch(api + U));
  assert.equal(d.snapshot.requirementsCurrent, false);
  assert.equal(d.useCases[0].design.eligible, false);
  assert.match(d.useCases[0].design.reasons.join(' '), /no longer the current version/);
  await writeFile(file, original);
});
