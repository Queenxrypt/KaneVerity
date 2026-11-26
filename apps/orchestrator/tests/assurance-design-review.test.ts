// Assurance B5: test-design review through the API. The fake Kane CLI runs in dynamic
// mode (fsck/list/view computed from the records). The use case is approved through
// the B4 flow (record 3), then test-design records are appended in the shape Kane
// 0.10.5 wrote them. No real Kane process runs, nothing is paid, nothing is executed.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDocsServer } from '../../docs/server.ts';
import { TESTS_DIR } from './helpers.ts';
import { appendRecord, generation1, generation2, writeTestFile, writeVariables, type DesignIds } from './design-fixture.ts';

// The corrected API-key tutorial (fixed fixture: tests never depend on live docs content).
const CORRECTED_DOC = `---
type: tutorial
id: generate-an-api-key
title: Generate an API key
order: 3
app_start: /
last_reviewed: 2025-03-12
---

API keys let your own scripts and services work with AcmeDesk. This tutorial shows how to create a new key for your workspace.

## Before you begin

- New workspaces start with one default API key.

## Steps

1. In the left navigation menu, click **Developer Settings**.
2. Click **API Keys**.
3. Click **Generate Key**.

## Expected outcome

- The message \`API key generated successfully.\` appears.
- The new key is added to the API keys list.
- The key count below the list shows \`2 keys\`.
`;

let docs: Server;
let app: Server;
let orch: Server;
let api: string;
let work: string;
let scriptFile: string;
let logFile: string;
let storeDir: string;
let workspace: string;
let appOrigin: string;
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
const D = `/api/assurance/designs/${T}/${UC.slice(7)}`;
const criteria = ["Start at {{app_url}}/ in a fresh browser session, then select 'Developer Settings', 'API Keys', and 'Generate Key' in that order.", "The message 'API key generated successfully.' appears after generating the key.", 'The new key is added to the API keys list.', "The key count below the list shows '2 keys'."];
let reqMd = '';
let lineOf: (item: string) => number;

const calls = async () => (await readFile(logFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv: string[] });
const records = async () => (await readdir(path.join(storeDir, 'commits'))).length;
const tests = () => path.join(workspace, '.testmuai', 'tests');

/** Store records 1-2 (V1 format), the B4 approval (record 3), then generation-1 design records 4-7. */
async function setup(): Promise<DesignIds> {
  for (const d of ['reviews', 'usecases', 'designs', 'design-reviews', 'kane-writes']) await rm(path.join(work, 'data', 'assurance', d), { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
  await writeFile(scriptFile, JSON.stringify({ dynamic: true, review: { mode: 'ok' } }));
  const lines = reqMd.split('\n');
  const edge = (line: number, claim: string | null) => ({ type: 'DERIVES', src: SRC, dst: UC, props: { source_id: 'kv-generate-an-api-key', source_cid: SRC, anchor: `L${line}-L${line}`, quote: lines[line - 1], ...(claim ? { claim } : {}) } });
  await mkdir(path.join(storeDir, 'commits'), { recursive: true });
  await mkdir(path.join(storeDir, 'blobs', BLOB.slice(7, 9)), { recursive: true });
  await writeFile(path.join(storeDir, 'meta.json'), JSON.stringify({ schema: 'assurance/context@1', canonicalizer: 'v1' }));
  await writeFile(path.join(storeDir, 'blobs', BLOB.slice(7, 9), BLOB.slice(9)), reqMd);
  await writeFile(path.join(storeDir, 'commits', `000001-${H1.slice(0, 12)}.json`), JSON.stringify({ seq: 1, prev_hash: null, nodes: [{ cid: SRC, label: 'source', content: { source_id: 'kv-generate-an-api-key', blob: BLOB } }], edges: [], review: [], schema_version: 'assurance/context@1', created_by: { build: '0.10.5' }, proposal_id: null }));
  await writeFile(
    path.join(storeDir, 'commits', `000002-${H2.slice(0, 12)}.json`),
    JSON.stringify({ seq: 2, prev_hash: `sha256:${H1}`, proposal_id: null, nodes: [{ cid: UC, label: 'usecase', content: { title: 'Generate an API key', description: "Open 'Developer Settings'.", summary: 'Generate a key.', actors: ['application user'], value: 'Create a key.', risk: 'high', criteria } }], edges: [edge(lineOf('S1'), criteria[0]), ...['O1', 'O2', 'O3'].map((it) => edge(lineOf(it), null))], review: [], names: [{ cid: UC, slug: 'uc-1', by: { kind: 'human', id: 'owner' } }], schema_version: 'assurance/context@1', created_by: { build: '0.10.5', by: { kind: 'human', id: 'owner' } } }),
  );
  await writeFile(path.join(storeDir, 'fake-hashes.json'), JSON.stringify({ '1': `sha256:${H1}`, '2': `sha256:${H2}` }));
  assert.equal((await post(`${U}/retrieve`)).status, 200);
  const r = await post(`${U}/${UC.slice(7)}/review`, { decision: 'approve', acknowledgeGaps: true, reason: 'Checked.' });
  assert.equal(r.status, 200);
  assert.equal((await j(r)).useCases[0].kane.state, 'verified');
  const g1 = generation1(UC);
  for (const rec of g1.records) await appendRecord(storeDir, rec);
  await writeTestFile(workspace, 'generate-an-api-key-and-check-the-documented-outcomes', 't-1', g1.ids.definitionId1, g1.ids.t1Body);
  await writeVariables(workspace);
  return g1.ids;
}

/** Add the forced generation 2 (three pairs) and its test files. */
async function addGeneration2(g1: DesignIds, opts: Parameters<typeof generation2>[2] = {}) {
  const g2 = generation2(UC, g1, opts);
  for (const rec of g2.records) await appendRecord(storeDir, rec);
  await writeTestFile(workspace, 'check-the-success-message', 't-2', g2.ids.defs.message, g2.ids.bodies.message);
  await writeTestFile(workspace, 'check-the-new-key-in-the-list', 't-3', g2.ids.defs.list, g2.ids.bodies.list);
  await writeTestFile(workspace, 'check-the-key-count', 't-4', g2.ids.defs.count, g2.ids.bodies.count);
  return g2.ids;
}

const readDesign = async () => {
  const r = await post(`${D}/retrieve`);
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  return j(r);
};

before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), 'kv-design-review-'));
  scriptFile = path.join(work, 'script.json');
  logFile = path.join(work, 'invocations.ndjson');
  const contentDir = path.join(work, 'content');
  await cp(path.resolve(TESTS_DIR, '..', '..', 'docs', 'content'), contentDir, { recursive: true });
  await writeFile(path.join(contentDir, 'tutorials', 'generate-an-api-key.md'), CORRECTED_DOC, 'utf8');
  docs = createDocsServer(contentDir);
  const docsUrl = (await listen(docs)) + '/';
  app = createServer((_q, s) => s.end('<!doctype html><title>AcmeDesk</title>'));
  const appUrl = (await listen(app)) + '/';
  appOrigin = new URL(appUrl).origin;
  Object.assign(process.env, {
    KANEVERITY_DATA_DIR: path.join(work, 'data'),
    KANEVERITY_ASSURANCE_MODE: 'free',
    // Test-only limit for one fake-Kane process (production: 30 minutes). These files spawn up to
    // ~1,600 node processes each; under full-suite load (three files at a time) a process start
    // was measured at up to 10 s, so 8 s killed healthy reads. 30 s is 3x the worst seen.
    KANEVERITY_ASSURANCE_TIMEOUT_MS: '30000',
    KANEVERITY_REVIEWER: 'test-reviewer',
    KANE_CLI_ENTRY: path.join(TESTS_DIR, 'fake-kane-assurance.cjs'),
    KANEVERITY_DOCS_CONTENT_DIR: contentDir,
    KANEVERITY_ALLOWED_DOCS_ORIGINS: new URL(docsUrl).origin,
    KANEVERITY_ALLOWED_APP_ORIGINS: appOrigin,
    FAKE_ASSURANCE_LOG: logFile,
    FAKE_ASSURANCE_SCRIPT: scriptFile,
  });
  delete process.env.USER;
  workspace = path.join(work, 'data', 'assurance', 'workspace');
  storeDir = path.join(workspace, '.context');
  await writeFile(scriptFile, JSON.stringify({ dynamic: true }));
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

test('current one-scenario design: read with free reads only, blocked on three scenarios, nothing written', async () => {
  await setup();
  const before = (await calls()).length;
  const recs = await records();
  const t1File = await readFile(path.join(tests(), 'generate-an-api-key-and-check-the-documented-outcomes_test.md'));
  const vars = await readFile(path.join(workspace, '.testmuai', 'variables', 'assurance.json'));
  const d = await readDesign();
  assert.equal(d.design.integrity.ok, true, d.design.integrity.problems.join(' '));
  assert.deepEqual(d.design.designRecords.map((r: { phase: string }) => r.phase), ['acs', 'scenarios', 'wiring', 'tests']);
  assert.deepEqual(d.evaluation.mapping.entries.map((m: { outcome: string; acSlug: string }) => `${m.outcome}=${m.acSlug}`), ['O1=ac-3', 'O2=ac-1', 'O3=ac-2']);
  assert.equal(d.evaluation.structure.ok, false);
  assert.match(d.evaluation.structure.problems.join(' '), /Found 1 live scenario; 3 documented outcomes need 3 distinct scenarios/);
  assert.ok(d.evaluation.outcomes.every((o: { specified: boolean; evidence: string }) => !o.specified && o.evidence === 'not_available'));
  // The undocumented "store the current list" in step 2 needs an explicit approval.
  assert.deepEqual(d.evaluation.fidelity[0].extraSteps.map((s: { n: number }) => s.n), [2]);
  assert.equal(d.evaluation.files.ok, true);
  assert.equal(d.evaluation.gaps[0].stale, false);
  assert.equal(d.readiness.ready, false);
  for (const id of ['structure', 'outcomes', 'kane_approvals', 'dry_run', 'app_url', 'reviews', 'mapping']) assert.equal(d.readiness.items.find((x: { id: string }) => x.id === id).ok, false, id);
  // Only the free reads ran: no review write, design, redesign or test run.
  const argv = (await calls()).slice(before).map((c) => c.argv.slice(0, 2).join(' '));
  assert.ok(argv.length > 0 && argv.every((a) => ['context fsck', 'context list', 'context view', '--version'].includes(a) || a.startsWith('--version')), argv.join(', '));
  assert.equal(await records(), recs);
  assert.ok(t1File.equals(await readFile(path.join(tests(), 'generate-an-api-key-and-check-the-documented-outcomes_test.md'))));
  assert.ok(vars.equals(await readFile(path.join(workspace, '.testmuai', 'variables', 'assurance.json'))));
});

test('three-scenario redesign from the acs phase: ac-1 replaced by its delta successor, every outcome specified, stale gap kept, old test file kept as superseded', async () => {
  const g1 = await setup();
  await addGeneration2(g1);
  let d = await readDesign();
  assert.equal(d.design.integrity.ok, true, d.design.integrity.problems.join(' '));
  assert.equal(d.evaluation.structure.ok, true, d.evaluation.structure.problems.join(' '));
  assert.equal(d.evaluation.generation.ok, true, d.evaluation.generation.problems.join(' '));
  assert.equal(d.evaluation.generation.latest, 2);
  // Kane superseded ac-1 (presence) with ac-4 (delta, same text): one live criterion per outcome, no duplicate.
  assert.deepEqual(d.design.acs.map((a: { slug: string; kind: string }) => `${a.slug}:${a.kind}`).sort(), ['ac-2:absolute', 'ac-3:presence', 'ac-4:delta']);
  assert.deepEqual(d.evaluation.mapping.entries.map((m: { outcome: string; acSlug: string }) => `${m.outcome}=${m.acSlug}`), ['O1=ac-3', 'O2=ac-4', 'O3=ac-2']);
  assert.match(d.evaluation.generation.notes.join(' '), /Criterion ac-2 comes from generation 1 and was kept by generation 2/);
  assert.deepEqual(d.evaluation.outcomes.map((o: { outcome: string; specified: boolean; problems: string[] }) => `${o.outcome}:${o.specified}:${o.problems.join('|')}`), ['O1:true:', 'O2:true:', 'O3:true:']);
  // The superseded t-1's file is still on disk (Kane never deletes it): recognised by its pin,
  // kept, never run and fingerprinted, never stray. Nothing was deleted.
  assert.equal(d.evaluation.files.ok, true, d.evaluation.files.problems.join(' '));
  assert.deepEqual(d.design.strayTestFiles, []);
  assert.deepEqual(d.design.supersededTestFiles.map((f: { path: string; id: string; successor: string | null }) => [f.path, f.id, f.successor]), [['.testmuai/tests/generate-an-api-key-and-check-the-documented-outcomes_test.md', 't-1', null]]);
  assert.match(d.evaluation.files.notes.join(' '), /file of t-1, superseded in record #\d+.*never run/);
  // gap-1 still points at sc-1, which the redesign superseded: kept, flagged.
  assert.equal(d.design.gaps.length, 1);
  assert.equal(d.design.gaps[0].refState, 'superseded');
  assert.equal(d.evaluation.gaps[0].stale, true);
  const gap = d.design.gaps[0].cid;
  // Unacknowledged, the stale gap keeps readiness blocked.
  assert.match(d.readiness.items.find((x: { id: string }) => x.id === 'reviews').reason, /Gap gap-1: not reviewed/);
  let r = await post(`${D}/review`, { kind: 'gap', target: gap, decision: 'acknowledge', reason: 'The URL is approved separately.' });
  assert.equal(r.status, 400);
  assert.match((await j(r)).error, /acknowledgeStale/);
  r = await post(`${D}/review`, { kind: 'gap', target: gap, decision: 'reject', reason: 'x' });
  assert.equal(r.status, 400);
  r = await post(`${D}/review`, { kind: 'gap', target: gap, decision: 'acknowledge', reason: 'sc-1 was superseded; the URL is approved separately.', acknowledgeStale: true });
  assert.equal(r.status, 200);
  d = await j(r);
  assert.equal(d.reviews.find((x: { target: string }) => x.target === gap).state, 'acknowledged');
  assert.equal(d.reviews.find((x: { target: string }) => x.target === gap).stale, false);
  assert.doesNotMatch(d.readiness.items.find((x: { id: string }) => x.id === 'reviews').reason, /Gap gap-1/);
  // Acknowledging resolves nothing: the gap is still in the design, still stale, and the
  // history keeps exactly what was acknowledged (the stale reference included).
  assert.equal(d.design.gaps.length, 1);
  assert.equal(d.design.gaps[0].refState, 'superseded');
  assert.equal(d.evaluation.gaps[0].stale, true);
  const hist = JSON.parse(await readFile(path.join(work, 'data', 'assurance', 'design-reviews', `${T}.json`), 'utf8'));
  const ackEntry = hist.entries.find((e: { kind: string }) => e.kind === 'gap');
  assert.equal(ackEntry.decision, 'acknowledged');
  assert.equal(ackEntry.binding.ref, 'sc-1');
  assert.equal(ackEntry.binding.refState, 'superseded');
  assert.equal(ackEntry.binding.refCid, g1.sc1);
  assert.match(ackEntry.reason, /superseded/);
  // Removing the old file clears the file check (the gap stays).
  await rm(path.join(tests(), 'generate-an-api-key-and-check-the-documented-outcomes_test.md'));
  d = await readDesign();
  assert.equal(d.evaluation.files.ok, true, d.evaluation.files.problems.join(' '));
  assert.equal(d.design.gaps.length, 1);
  assert.equal(d.readiness.ready, false);
  assert.equal(d.readiness.items.some((x: { id: string }) => x.id === 'evidence'), false, 'run-time evidence is not a pre-execution gate');
  assert.equal(d.readiness.items.find((x: { id: string }) => x.id === 'kane_approvals').ok, false);
  // The B4 gate (approved in KaneVerity, verified in Kane as record 3) is open; the design gates decide.
  assert.equal(d.readiness.items.find((x: { id: string }) => x.id === 'use_case').ok, true);
  assert.equal(d.readiness.items.find((x: { id: string }) => x.id === 'integrity').ok, true);
  assert.equal(d.readiness.items.find((x: { id: string }) => x.id === 'fresh').ok, true);
});

test('a redesign from the scenarios phase keeps ac-1 as presence: O2 is refused, not silently accepted', async () => {
  const g1 = await setup();
  await addGeneration2(g1, { from: 'scenarios' });
  const d = await readDesign();
  assert.equal(d.design.integrity.ok, true, d.design.integrity.problems.join(' '));
  assert.deepEqual(d.design.acs.map((a: { slug: string; kind: string }) => `${a.slug}:${a.kind}`).sort(), ['ac-1:presence', 'ac-2:absolute', 'ac-3:presence']);
  const o2 = d.evaluation.outcomes.find((o: { outcome: string }) => o.outcome === 'O2');
  assert.equal(o2.specified, false);
  assert.match(o2.problems.join(' '), /ac-1 is a presence criterion, but O2 is a change from the starting state/);
  assert.match(o2.problems.join(' '), /contradict each other/);
  assert.equal(d.readiness.ready, false);
});

test('a criterion re-sent with different text leaves two live criteria for O2: blocked as a duplicate, never silently kept', async () => {
  const g1 = await setup();
  await addGeneration2(g1, { acText: 'After generating the key, every earlier key is still in the API keys list and one new key is added.' });
  const d = await readDesign();
  assert.equal(d.design.integrity.ok, true, d.design.integrity.problems.join(' '));
  // Kane superseded nothing (no text match): ac-1 is still live next to the new criterion.
  assert.deepEqual(d.design.acs.map((a: { slug: string }) => a.slug).sort(), ['ac-1', 'ac-2', 'ac-3', 'ac-4']);
  assert.equal(d.evaluation.structure.ok, false);
  assert.match(d.evaluation.structure.problems.join(' '), /Found 4 live criteria; 3 documented outcomes need exactly 3/);
  assert.equal(d.evaluation.mapping.ok, false);
  assert.equal(d.readiness.ready, false);
});

test('a file pinned like a superseded test but to another definition is stray, not superseded', async () => {
  const g1 = await setup();
  await addGeneration2(g1);
  await writeTestFile(workspace, 'copy-of-old', 't-1', 'sha256:' + '9'.repeat(64), 'tampered body');
  const d = await readDesign();
  assert.deepEqual(d.design.strayTestFiles.map((f: { path: string }) => f.path), ['.testmuai/tests/copy-of-old_test.md']);
  assert.equal(d.design.supersededTestFiles.length, 1);
  assert.equal(d.evaluation.files.ok, false);
});

test('approvals bind to fingerprints: a changed test file or content id makes them stale and unusable', async () => {
  const g1 = await setup();
  const g2 = await addGeneration2(g1);
  await rm(path.join(tests(), 'generate-an-api-key-and-check-the-documented-outcomes_test.md'));
  let d = await readDesign();
  let r = await post(`${D}/review`, { kind: 'test', target: g2.t2, decision: 'approve' });
  assert.equal(r.status, 200);
  r = await post(`${D}/review`, { kind: 'ac', target: g1.ac3, decision: 'approve' });
  assert.equal(r.status, 200);
  // Each outcome's mapping is its own decision: approve O1, reject O2.
  assert.equal((await post(`${D}/review`, { kind: 'mapping', target: 'O1', decision: 'approve' })).status, 200);
  r = await post(`${D}/review`, { kind: 'mapping', target: 'O2', decision: 'reject', reason: 'ac-1 does not say the list grows by one.' });
  assert.equal(r.status, 200);
  d = await j(r);
  assert.equal(d.reviews.find((x: { kind: string; target: string }) => x.kind === 'mapping' && x.target === 'O1').state, 'approved');
  assert.equal(d.reviews.find((x: { kind: string; target: string }) => x.kind === 'mapping' && x.target === 'O2').state, 'rejected');
  assert.match(d.readiness.items.find((x: { id: string }) => x.id === 'mapping').reason, /Mapping O2 → ac-4: rejected/);
  assert.equal(d.reviews.find((x: { target: string }) => x.target === g2.t2).stale, false);
  // The test file is edited on disk (as a heal or a hand edit would).
  const f = path.join(tests(), 'check-the-success-message_test.md');
  await writeFile(f, (await readFile(f, 'utf8')) + '\n## Step 4\n\nClick \'Settings\'.\n');
  d = await readDesign();
  assert.equal(d.evaluation.files.ok, false);
  const st = d.reviews.find((x: { target: string }) => x.target === g2.t2);
  assert.equal(st.state, 'approved');
  assert.equal(st.stale, true);
  assert.equal(d.readiness.items.find((x: { id: string }) => x.id === 'reviews').ok, false);
  r = await post(`${D}/review`, { kind: 'test', target: g2.t2, decision: 'approve' });
  assert.equal(r.status, 409);
  // A criterion re-emitted with changed text gets a new content id: the old approval does not carry over.
  const newAc = 'sha256:' + 'ab'.repeat(32);
  await appendRecord(storeDir, { intent_verb: 'design', created_by: { build: '0.10.5', by: { kind: 'ai', id: 'design-agent' } }, nodes: [{ cid: newAc, label: 'ac', content: { text: "The message 'API key generated successfully.' appears.", derived: true } }], edges: [{ ecid: 'sha256:' + 'cd'.repeat(32), type: 'scoped_to', src: newAc, dst: UC, props: {} }], supersessions: [{ kind: 'node', old: g1.ac3, new: newAc, reason: 'AC re-emitted with changed content', by: { kind: 'ai', id: 'design-agent' } }], names: [{ cid: newAc, slug: 'ac-4', by: { kind: 'ai', id: 'design-agent' } }] });
  d = await readDesign();
  assert.equal(d.reviews.find((x: { target: string }) => x.target === g1.ac3), undefined);
  assert.equal(d.reviews.find((x: { target: string }) => x.target === newAc).state, 'none');
  // O1 now maps to the new criterion: the earlier approval of O1's mapping is stale.
  const o1 = d.reviews.find((x: { kind: string; target: string }) => x.kind === 'mapping' && x.target === 'O1');
  assert.equal(o1.state, 'approved');
  assert.equal(o1.stale, true);
  assert.match(o1.label, /O1 → ac-4/);
});

test('descriptive steps, tags and the check field never count: incomplete assertions block readiness', async () => {
  const g1 = await setup();
  await addGeneration2(g1, {
    // O1: the step only describes the outcome and is not tagged; O3: the check is aimed at the wrong criterion.
    bodies: { message: "# M\n\n## Step 1\n\nIn a fresh browser session, start at {{app_url}}/ and open 'Developer Settings'.\n\n## Step 2\n\nOpen 'API Keys'.\n\n## Step 3\n\nUse 'Generate Key'. The message 'API key generated successfully.' appears.\n" },
    checks: { count: { kind: 'absolute', operator: 'equals', operand: '2 keys', verified_against: 'ac-1' } },
  });
  await rm(path.join(tests(), 'generate-an-api-key-and-check-the-documented-outcomes_test.md'));
  const d = await readDesign();
  const o = Object.fromEntries(d.evaluation.outcomes.map((x: { outcome: string }) => [x.outcome, x]));
  assert.equal(o.O1.specified, false);
  assert.match(o.O1.problems.join(' '), /exactly one step tagged @verifies ac-3/);
  assert.equal(o.O2.specified, true);
  assert.equal(o.O3.specified, false);
  assert.match(o.O3.problems.join(' '), /aimed at ac-1, not ac-2/);
  assert.equal(d.readiness.items.find((x: { id: string }) => x.id === 'outcomes').ok, false);
});

test('app_url: only the exact project URL, with confirmation; Kane\'s variables file is never written; stale when it changes', async () => {
  await setup();
  let d = await readDesign();
  assert.equal(d.appUrl.proposed, appOrigin);
  assert.equal(d.appUrl.writesKaneFile, false);
  const varsFile = path.join(workspace, '.testmuai', 'variables', 'assurance.json');
  const before = await readFile(varsFile);
  assert.equal((await post(`${D}/app-url`, { value: appOrigin })).status, 400);
  assert.equal((await post(`${D}/app-url`, { value: 'http://example.com', confirm: true })).status, 400);
  assert.equal((await post(`${D}/app-url`, { value: appOrigin + '/', confirm: true })).status, 400);
  const r = await post(`${D}/app-url`, { value: appOrigin, confirm: true });
  assert.equal(r.status, 200);
  d = await j(r);
  assert.equal(d.appUrl.state, 'approved');
  assert.equal(d.appUrl.value, appOrigin);
  // Approved, but not yet set for the run: the app_url gate stays closed.
  assert.match(d.readiness.items.find((x: { id: string }) => x.id === 'app_url').reason, /run variables file/);
  assert.ok(before.equals(await readFile(varsFile)), "Kane's variables file is unchanged");
  // KaneVerity writes its own run file (never Kane's), with confirmation, then reads again.
  assert.equal((await post(`${D}/run-variables`, {})).status, 400);
  assert.equal((await post(`${D}/run-variables`, { confirm: true })).status, 200);
  const run = JSON.parse(await readFile(path.join(workspace, '.testmuai', 'variables', 'kaneverity-run.json'), 'utf8'));
  assert.equal(run.app_url.value, appOrigin);
  assert.ok(before.equals(await readFile(varsFile)), "Kane's variables file is still unchanged");
  d = await readDesign();
  assert.equal(d.appUrl.runFileValue, appOrigin);
  assert.equal(d.readiness.items.find((x: { id: string }) => x.id === 'app_url').ok, true);
  // Kane rewrites its variables file: the approval no longer matches it.
  await writeVariables(workspace, 'http://127.0.0.1:1');
  d = await readDesign();
  assert.equal(d.appUrl.stale, true);
  assert.equal(d.readiness.items.find((x: { id: string }) => x.id === 'app_url').ok, false);
});

test('fail closed: a newer store read, a view that disagrees, a damaged history', async () => {
  await setup();
  const d = await readDesign();
  const ac = d.design.acs[0].cid;
  // The store was read again since the design read: decisions are refused until the design is read again.
  assert.equal((await post(`${U}/retrieve`)).status, 200);
  let r = await post(`${D}/review`, { kind: 'ac', target: ac, decision: 'approve' });
  assert.equal(r.status, 409);
  assert.equal((await j(await fetch(api + D))).readiness.items.find((x: { id: string }) => x.id === 'fresh').ok, false);
  // Kane's view shows one design link fewer than the records: the read fails integrity.
  await writeFile(scriptFile, JSON.stringify({ dynamic: true, viewDropLink: true }));
  const bad = await readDesign();
  assert.equal(bad.design.integrity.ok, false);
  assert.match(bad.design.integrity.problems.join(' '), /design links in the records differ/);
  r = await post(`${D}/review`, { kind: 'ac', target: ac, decision: 'approve' });
  assert.equal(r.status, 409);
  await writeFile(scriptFile, JSON.stringify({ dynamic: true }));
  await readDesign();
  // A damaged review history is never shown as empty and never overwritten.
  const hist = path.join(work, 'data', 'assurance', 'design-reviews', `${T}.json`);
  await mkdir(path.dirname(hist), { recursive: true });
  await writeFile(hist, '{"tutorialId": "generate-an-api-key", "entries": [');
  assert.equal((await fetch(api + D)).status, 500);
  assert.equal((await post(`${D}/review`, { kind: 'ac', target: ac, decision: 'approve' })).status, 500);
  assert.equal(await readFile(hist, 'utf8'), '{"tutorialId": "generate-an-api-key", "entries": [');
  await rm(hist);
});

test('requests are validated: unknown kind, missing reason, wrong use case, no X-KaneVerity header', async () => {
  await setup();
  const d = await readDesign();
  const ac = d.design.acs[0].cid;
  assert.equal((await post(`${D}/review`, { kind: 'usecase', target: ac, decision: 'approve' })).status, 400);
  assert.equal((await post(`${D}/review`, { kind: 'ac', target: ac, decision: 'reject' })).status, 400);
  assert.equal((await post(`${D}/review`, { kind: 'ac', target: 'sha256:' + '0'.repeat(64), decision: 'approve' })).status, 404);
  // Mappings are per outcome; there is no all-in-one mapping decision.
  assert.equal((await post(`${D}/review`, { kind: 'mapping', target: 'mapping', decision: 'approve' })).status, 404);
  assert.equal((await post(`${D}/review`, { kind: 'mapping', target: 'O9', decision: 'approve' })).status, 404);
  assert.equal((await post(`${D}/review`, { kind: 'mapping', target: 'O1', decision: 'approve', reason: 'Checked against O1.' })).status, 200);
  assert.equal((await fetch(api + `/api/assurance/designs/${T}/${'0'.repeat(64)}`)).status, 200);
  assert.equal((await j(await fetch(api + `/api/assurance/designs/${T}/${'0'.repeat(64)}`))).design, null);
  assert.equal((await fetch(api + `${D}/retrieve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(api + `/api/assurance/designs/..%2f/${UC.slice(7)}`)).status, 404);
  // Running the tests is paid: refused in mode free before anything is read or started.
  const r = await post(`${D}/execute`, { confirm: { paid: true }, phase: 'authoring' });
  assert.equal(r.status, 403);
  assert.match((await j(r)).error, /needs Assurance mode "all"/);
});
