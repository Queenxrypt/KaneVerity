// Assurance B5: from an approved design to a verified run, through the API, with the fake
// Kane CLI (dynamic mode) in Assurance mode "all". Covers the pre-execution gates (Kane
// approval writes of design items, the run variables file, the free dry run), the paid run
// with its confirmation, post-execution verification from the evidence pack, mutation
// checks, and runs that end without a known result. No real Kane process runs.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDocsServer } from '../../docs/server.ts';
import { makeZip, TESTS_DIR } from './helpers.ts';
import { appendRecord, buildPack, generation1, generation2, goodMembers, writeTestFile, writeVariables, type PackMember } from './design-fixture.ts';

const CORRECTED_DOC = `---
type: tutorial
id: generate-an-api-key
title: Generate an API key
order: 3
app_start: /
last_reviewed: 2025-03-12
---

API keys let your own scripts and services work with AcmeDesk.

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
let defs: { message: string; list: string; count: string };
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
const script = (s: Record<string, unknown>) => writeFile(scriptFile, JSON.stringify({ dynamic: true, review: { mode: 'ok' }, ...s }));
const view = async () => j(await fetch(api + D));
const gate = (d: { readiness: { items: { id: string; ok: boolean; reason: string }[] } }, id: string) => d.readiness.items.find((x) => x.id === id) ?? { id, ok: false, reason: `(no gate ${id})` };
const readDesign = async () => {
  const r = await post(`${D}/retrieve`);
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  return j(r);
};

/** Records 1-2, the B4 approval (record 3), generation 1, the forced generation 2, and the gen-2 test files. */
async function setup() {
  await rm(workspace, { recursive: true, force: true });
  await script({});
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
  assert.equal((await post(`${U}/${UC.slice(7)}/review`, { decision: 'approve', acknowledgeGaps: true, reason: 'Checked.' })).status, 200);
  const g1 = generation1(UC);
  for (const rec of g1.records) await appendRecord(storeDir, rec);
  await writeVariables(workspace);
  const g2 = generation2(UC, g1.ids);
  for (const rec of g2.records) await appendRecord(storeDir, rec);
  await writeTestFile(workspace, 'check-the-success-message', 't-2', g2.ids.defs.message, g2.ids.bodies.message);
  await writeTestFile(workspace, 'check-the-new-key-in-the-list', 't-3', g2.ids.defs.list, g2.ids.bodies.list);
  await writeTestFile(workspace, 'check-the-key-count', 't-4', g2.ids.defs.count, g2.ids.bodies.count);
  defs = g2.ids.defs;
  return { g1: g1.ids, g2 };
}

const packFile = async (name: string, alter: (m: PackMember[]) => void = () => {}, runKind = 'replay') => {
  const members = goodMembers(defs, appOrigin);
  alter(members);
  const f = path.join(work, `${name}.evidence`);
  await writeFile(f, buildPack({ members, appOrigin, runKind }, makeZip));
  return f;
};

const waitExecution = async (until: (x: { state: string }) => boolean) => {
  for (let i = 0; i < 300; i++) {
    const d = await view();
    if (d.execution && until(d.execution)) return d;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the run did not settle');
};

before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), 'kv-design-exec-'));
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
    KANEVERITY_ASSURANCE_MODE: 'all',
    KANEVERITY_ASSURANCE_TIMEOUT_MS: '8000',
    KANEVERITY_REVIEWER: 'test-reviewer',
    KANE_CLI_ENTRY: path.join(TESTS_DIR, 'fake-kane-assurance.cjs'),
    KANEVERITY_DOCS_CONTENT_DIR: contentDir,
    KANEVERITY_ALLOWED_DOCS_ORIGINS: new URL(docsUrl).origin,
    KANEVERITY_ALLOWED_APP_ORIGINS: appOrigin,
    FAKE_ASSURANCE_LOG: logFile,
    FAKE_ASSURANCE_SCRIPT: scriptFile,
    FAKE_ASSURANCE_BALANCE: '[1000, 990]',
  });
  delete process.env.USER;
  workspace = path.join(work, 'data', 'assurance', 'workspace');
  storeDir = path.join(workspace, '.context');
  await script({});
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

const run = (phase: 'authoring' | 'verification') => post(`${D}/execute`, { confirm: { paid: true }, phase });
const settled = async (phase: 'authoring' | 'verification') => {
  const r = await run(phase);
  assert.equal(r.status, 202, JSON.stringify(await r.clone().json()));
  return waitExecution((x) => x.state !== 'started');
};
const notReady = (d: { verificationReadiness?: { items: { id: string; ok: boolean; reason: string }[] } }) => d.verificationReadiness!.items.filter((x) => !x.ok).map((x) => `${x.id}: ${x.reason}`).join(' | ');
const testRuns = async () => (await calls()).filter((c) => c.argv[0] === 'testrun' && !c.argv.includes('--dry-run')).length;

/** Review everything, write the Kane approvals, set app_url, dry run: authoring-ready. */
async function toAuthoringReady() {
  let d = await readDesign();
  const g = d.design;
  // Decisions already current are kept (re-deciding would unbind a Kane write made from them).
  const current = (v: { reviews: { kind: string; target: string; state: string; stale: boolean }[] }, kind: string, target: string) => v.reviews.some((x) => x.kind === kind && x.target === target && x.state === 'approved' && !x.stale);
  for (const o of ['O1', 'O2', 'O3']) if (!current(d, 'mapping', o)) assert.equal((await post(`${D}/review`, { kind: 'mapping', target: o, decision: 'approve' })).status, 200);
  for (const x of g.acs) if (!current(d, 'ac', x.cid)) assert.equal((await post(`${D}/review`, { kind: 'ac', target: x.cid, decision: 'approve' })).status, 200);
  for (const x of g.scenarios) if (!current(d, 'scenario', x.cid)) assert.equal((await post(`${D}/review`, { kind: 'scenario', target: x.cid, decision: 'approve' })).status, 200);
  for (const x of g.tests) if (!current(d, 'test', x.cid)) assert.equal((await post(`${D}/review`, { kind: 'test', target: x.cid, decision: 'approve' })).status, 200);
  d = await view();
  for (const r of d.reviews.filter((x: { kind: string }) => x.kind === 'extra_step')) assert.equal((await post(`${D}/review`, { kind: 'extra_step', target: r.target, decision: 'approve', reason: 'Reads only.' })).status, 200);
  for (const gp of g.gaps) assert.equal((await post(`${D}/review`, { kind: 'gap', target: gp.cid, decision: 'acknowledge', reason: 'Known.', acknowledgeStale: true })).status, 200);
  for (const x of [...g.acs, ...g.scenarios, ...g.tests]) {
    if ((await view()).kaneApprovals.find((k: { target: string }) => k.target === x.cid).state === 'verified') continue;
    const r = await post(`${D}/kane-write`, { target: x.cid });
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
    assert.equal((await j(r)).kaneApprovals.find((k: { target: string }) => k.target === x.cid).state, 'verified');
  }
  if ((await view()).appUrl.state !== 'approved') assert.equal((await post(`${D}/app-url`, { value: appOrigin, confirm: true })).status, 200);
  assert.equal((await post(`${D}/run-variables`, { confirm: true })).status, 200);
  assert.equal((await j(await post(`${D}/dry-run`))).dryRun.latest.state, 'passed');
  d = await readDesign();
  assert.equal(d.readiness.ready, true, d.readiness.items.filter((x: { ok: boolean }) => !x.ok).map((x: { id: string; reason: string }) => `${x.id}: ${x.reason}`).join(' | '));
  return d;
}

/** After an AUTHORED run: read, approve each recording, dry run again: verification-ready. */
async function approveRecordings() {
  let d = await readDesign();
  for (const r of d.recordings) assert.equal((await post(`${D}/review`, { kind: 'recording', target: r.testCid, decision: 'approve' })).status, 200, r.slug);
  d = await view();
  assert.match(gate({ readiness: d.verificationReadiness }, 'dry_run').reason, /Run it again|again after the recording approvals/, 'a fresh dry run is required after authoring and the approvals');
  assert.equal((await j(await post(`${D}/dry-run`))).dryRun.latest.state, 'passed');
  d = await readDesign();
  assert.equal(d.verificationReadiness.ready, true, notReady(d));
  return d;
}

test('gates before authoring, then authoring (AUTHORED, never VERIFIED), recording approval, and verification only from a pure replay with DOM evidence', async () => {
  const { g1, g2 } = await setup();
  let d = await readDesign();
  assert.equal(d.design.integrity.ok, true, d.design.integrity.problems.join(' '));

  // Gates block until met: a refused write, an unknown write (reconciled from the store), app_url, the dry run.
  for (const o of ['O1', 'O2', 'O3']) await post(`${D}/review`, { kind: 'mapping', target: o, decision: 'approve' });
  await post(`${D}/review`, { kind: 'ac', target: g1.ac3, decision: 'approve' });
  await script({ review: { mode: 'refuse' } });
  assert.equal((await j(await post(`${D}/kane-write`, { target: g1.ac3 }))).kaneApprovals.find((k: { target: string }) => k.target === g1.ac3).state, 'not_written');
  await script({ review: { mode: 'crashAfter' } });
  d = await j(await post(`${D}/kane-write`, { target: g1.ac3 }));
  assert.equal(d.kaneApprovals.find((k: { target: string }) => k.target === g1.ac3).state, 'unknown');
  assert.match(gate(d, 'idle').reason, /unknown outcome/);
  assert.equal((await post(`${U}/${UC.slice(7)}/review`, { decision: 'approve', acknowledgeGaps: true })).status, 409, 'use-case decisions wait too');
  await script({});
  assert.equal((await j(await post(`${D}/kane-reconcile`, { target: g1.ac3 }))).kaneApprovals.find((k: { target: string }) => k.target === g1.ac3).state, 'verified');
  await post(`${D}/app-url`, { value: appOrigin, confirm: true });
  d = await j(await post(`${D}/dry-run`));
  assert.deepEqual(d.dryRun.latest.unresolved, ['app_url'], 'without the run file the dry run reports app_url unresolved');
  d = await toAuthoringReady();

  // Ready to author, not to verify: there is no recording yet. Nothing has run.
  assert.equal(d.verificationReadiness.ready, false);
  assert.match(gate({ readiness: d.verificationReadiness }, 'recordings').reason, /no recording yet/);
  assert.equal(await testRuns(), 0);
  assert.equal((await post(`${D}/execute`, { confirm: { paid: true } })).status, 400, 'the phase is explicit');
  assert.equal((await run('verification')).status, 409);
  assert.equal((await post('/api/assurance/jobs', { kind: 'testrun', tutorialId: T, confirm: { paid: true } })).status, 400, 'no generic-API bypass');

  // Authoring run: even with complete evidence, the result is AUTHORED, never VERIFIED.
  await script({ testrun: { pack: await packFile('author-1', undefined, 'author'), packName: 'run-1', appendRecord: 'execution' } });
  d = await settled('authoring');
  assert.equal(d.execution.phase, 'authoring');
  assert.equal(d.execution.verdict, 'AUTHORED', JSON.stringify(d.execution));
  const argv = (await calls()).filter((c) => c.argv[0] === 'testrun' && !c.argv.includes('--dry-run')).pop()!.argv;
  for (const f of ['--agent', '--headless', '--no-adaptive-heal']) assert.ok(argv.includes(f), f);
  for (const f of ['--force', '--local', '--no-testmd-sync', '--author', '--push']) assert.ok(!argv.includes(f), f);

  // The recorded steps are shown for review; approval is bound to the exact recording and test file.
  d = await readDesign();
  assert.equal(d.recordings.length, 3);
  assert.ok(d.recordings.every((r: { exists: boolean; resultMd: string | null; sha256: string | null }) => r.exists && r.resultMd?.includes('Generate Key') && r.sha256));
  assert.match(gate({ readiness: d.verificationReadiness }, 'recordings').reason, /not reviewed/);
  const t2 = d.recordings.find((r: { slug: string }) => r.slug === 't-2');
  // A recording edited after the authoring run is not the one the run produced: refused.
  const rec = path.join(workspace, '.testmuai', 'tests', 'output-check-the-success-message', 'Result.md');
  const recOriginal = await readFile(rec);
  await writeFile(rec, recOriginal.toString('utf8') + '\nhand edit\n');
  await readDesign();
  assert.equal((await post(`${D}/review`, { kind: 'recording', target: t2.testCid, decision: 'approve' })).status, 409);
  await writeFile(rec, recOriginal);
  d = await approveRecordings();
  const hist = JSON.parse(await readFile(path.join(work, 'data', 'assurance', 'design-reviews', `${T}.json`), 'utf8'));
  const recEntry = hist.entries.filter((e: { kind: string }) => e.kind === 'recording').pop();
  assert.equal(recEntry.binding.recording.sha256, d.recordings.find((r: { testCid: string }) => r.testCid === recEntry.target).sha256);
  assert.match(recEntry.binding.testFile.sha256, /^[a-f0-9]{64}$/);

  // Verification: a pure replay with DOM evidence for each outcome -> VERIFIED.
  await script({ testrun: { pack: await packFile('verify-1'), packName: 'run-2', appendRecord: 'execution' } });
  d = await settled('verification');
  assert.equal(d.execution.phase, 'verification');
  assert.equal(d.execution.verdict, 'VERIFIED', JSON.stringify(d.execution));
  assert.deepEqual(d.execution.outcomes.map((o: { outcome: string; basis: string }) => [o.outcome, o.basis]), [['O1', 'dom_value'], ['O2', 'dom_baseline_change'], ['O3', 'dom_value']]);

  // Verification without O1's status-region evidence: NOT VERIFIED.
  await script({ testrun: { pack: await packFile('verify-weak', (m) => (m[0].actions[0].action_params = { ...(m[0].actions[0].action_params as object), locators: ['internal:text="API key generated"i'] })), packName: 'run-3', appendRecord: 'execution' } });
  d = await settled('verification');
  assert.equal(d.execution.verdict, 'NOT_VERIFIED');
  assert.deepEqual(d.execution.outcomes.map((o: { verified: boolean }) => o.verified), [false, true, true]);

  // A verification run that superseded the design in the store: NOT VERIFIED.
  await script({ testrun: { pack: await packFile('verify-2'), packName: 'run-4', appendRecord: 'exec-supersede' } });
  d = await settled('verification');
  assert.equal(d.execution.verdict, 'NOT_VERIFIED');
  assert.match(d.execution.mutation.join(' '), /not an execution record \(exec-supersede\)/);

  // A replay miss that re-authored: run_kind author and rewritten recordings -> NOT VERIFIED, and the next verification is blocked.
  await script({ testrun: { pack: await packFile('reauthored', undefined, 'author'), packName: 'run-5', appendRecord: 'execution', reauthor: true } });
  d = await settled('verification');
  assert.equal(d.execution.verdict, 'NOT_VERIFIED');
  assert.match(d.execution.mutation.join(' '), /recording .* changed during the run \(Kane re-recorded steps\)/);
  assert.match(d.execution.packProblems.join(' '), /not a pure replay \(run_kind: author\)/);
  d = await readDesign();
  assert.equal(d.verificationReadiness.ready, false);
  assert.match(gate({ readiness: d.verificationReadiness }, 'recordings').reason, /approval is stale/);
  assert.equal((await run('verification')).status, 409, 'changed recordings block verification');
  void g2;
});

test("a superseded test's kept file is never run and never blocks, but any change to it does", async () => {
  await setup();
  // Kane keeps t-1's file after the redesign (it never deletes it).
  const OLD = 'generate-an-api-key-and-check-the-documented-outcomes';
  const g1ids = generation1(UC).ids;
  await writeTestFile(workspace, OLD, 't-1', g1ids.definitionId1, g1ids.t1Body);
  const oldRel = `.testmuai/tests/${OLD}_test.md`;
  const oldAbs = path.join(workspace, '.testmuai', 'tests', `${OLD}_test.md`);
  const original = await readFile(oldAbs);
  let d = await toAuthoringReady();
  assert.deepEqual(d.design.supersededTestFiles.map((f: { path: string }) => f.path), [oldRel]);
  assert.deepEqual(d.design.strayTestFiles, []);
  // Changed before the run: refused, and Kane never starts.
  await writeFile(oldAbs, original.toString('utf8') + '\nedited\n');
  const before = await testRuns();
  let r = await run('authoring');
  assert.equal(r.status, 409);
  assert.match((await j(r)).error, /superseded test file|Generated test files|files/i);
  assert.equal(await testRuns(), before);
  await writeFile(oldAbs, original);
  d = await readDesign();
  // An authoring run with the kept file on disk: it is not passed to Kane, and it does not refuse the run.
  await script({ testrun: { pack: await packFile('author-kept', undefined, 'author'), packName: 'run-k1', appendRecord: 'execution' } });
  d = await settled('authoring');
  assert.equal(d.execution.verdict, 'AUTHORED', JSON.stringify(d.execution));
  const argv = (await calls()).filter((c) => c.argv[0] === 'testrun' && !c.argv.includes('--dry-run')).pop()!.argv;
  assert.ok(!argv.includes(oldRel), 'the superseded file is never run');
  // Changed during a run: a mutation, NOT VERIFIED (here an authoring run: not AUTHORED).
  await approveRecordings();
  await script({ testrun: { pack: await packFile('author-kept-2', undefined, 'author'), packName: 'run-k2', appendRecord: 'execution', touchFile: oldRel } });
  d = await settled('authoring');
  assert.equal(d.execution.verdict, 'NOT_VERIFIED');
  assert.match(d.execution.mutation.join(' '), /superseded test file .* changed during the run/);
  await writeFile(oldAbs, original);
});

test('a test file changed during an authoring run fails it, blocks the next run, and its recordings cannot be approved', async () => {
  await setup();
  await toAuthoringReady();
  const file = path.join(workspace, '.testmuai', 'tests', 'check-the-key-count_test.md');
  const original = await readFile(file);
  await script({ testrun: { pack: await packFile('author-mut', undefined, 'author'), packName: 'run-6', mutateTest: true, appendRecord: 'execution' } });
  let d = await settled('authoring');
  assert.equal(d.execution.verdict, 'NOT_VERIFIED');
  assert.match(d.execution.reason, /^Authoring failed/);
  assert.match(d.execution.mutation.join(' '), /check-the-key-count_test\.md changed during the run/);
  d = await readDesign();
  assert.equal(gate(d, 'files').ok, false, 'the changed test file blocks');
  assert.equal((await run('authoring')).status, 409);
  const r = d.recordings.find((x: { slug: string }) => x.slug === 't-2');
  assert.equal((await post(`${D}/review`, { kind: 'recording', target: r.testCid, decision: 'approve' })).status, 409, 'no AUTHORED run produced it');
  await writeFile(file, original);
});

test('an interrupted run stays blocked until reconciled; after a restart a run left "started" becomes unknown', async () => {
  await setup();
  await toAuthoringReady();
  await script({ testrun: { mode: 'hang' } });
  assert.equal((await run('authoring')).status, 202);
  // While Kane is running, the run is shown as running and cannot be reconciled.
  let d = await view();
  assert.equal(d.execution.state, 'started');
  assert.equal(d.execution.kaneRunning, true);
  assert.equal(d.execution.canReconcile, false, 'no Reconcile while Kane is running');
  assert.equal((await post(`${D}/executions/${d.execution.executionId}/reconcile`)).status, 409);
  d = await waitExecution((x) => x.state !== 'started');
  assert.equal(d.execution.state, 'unknown');
  assert.match(gate(await view(), 'idle').reason, /Reconcile it first/);
  assert.equal((await run('authoring')).status, 409, 'blocked pending reconciliation');
  const before = await testRuns();
  d = await j(await post(`${D}/executions/${d.execution.executionId}/reconcile`));
  assert.equal(d.execution.state, 'reconciled');
  assert.equal(d.execution.verdict, 'NOT_VERIFIED');
  assert.equal(await testRuns(), before, 'never re-run');

  // Simulate a restart: a run recorded as started whose job was running when the orchestrator stopped.
  const hist = path.join(work, 'data', 'assurance', 'design-reviews', `${T}.json`);
  const log = JSON.parse(await readFile(hist, 'utf8'));
  const last = log.executions[log.executions.length - 1];
  const jobId = 'j20261125-000000-abcdef';
  await mkdir(path.join(work, 'data', 'assurance', 'jobs', jobId), { recursive: true });
  await writeFile(path.join(work, 'data', 'assurance', 'jobs', jobId, 'job.json'), JSON.stringify({ jobId, kind: 'testrun', params: { kind: 'testrun', tutorialId: T, ucCid: UC, files: [], reviewer: 'test-reviewer', readinessSha256: 'a'.repeat(64) }, tutorialId: T, state: 'running', reason: 'Kane is running.', createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: null, args: [], exitCode: null, cliVersion: '0.10.5', verb: null, doneStatus: null, next: [], pause: null, parentJobId: null, resumedBy: null, requirements: null, credits: { amount: null, basis: null, reportedTotal: null, measured: null, balanceBefore: null, balanceAfter: null }, summary: { ingested: [], commits: [], warnings: [], errors: [], held: 0, messages: [], unknownEventTypes: [], nonJsonLines: 0, invalidLines: 0 } }));
  log.executions.push({ ...last, executionId: 'x20261125-000000-abcdef', jobId, state: 'started', result: null, reason: 'Kane is running the tests.' });
  await writeFile(hist, JSON.stringify(log));
  const { AssuranceJobs } = await import('../src/assurance/jobs.ts');
  const { AssuranceUseCases } = await import('../src/assurance/usecases.ts');
  const { AssuranceDesigns } = await import('../src/assurance/designs.ts');
  const { RequirementsService } = await import('../src/assurance/service.ts');
  const jobs = new AssuranceJobs();
  await jobs.init();
  const restarted = new AssuranceDesigns(new AssuranceUseCases(jobs, new RequirementsService()), jobs);
  await restarted.init();
  const after = JSON.parse(await readFile(hist, 'utf8')).executions.filter((e: { executionId: string }) => e.executionId === 'x20261125-000000-abcdef').map((e: { state: string }) => e.state);
  assert.deepEqual(after, ['started', 'unknown']);
  assert.equal((await jobs.get(jobId)).state, 'interrupted');
  d = await view();
  assert.equal(d.execution.state, 'unknown');
  assert.equal(d.execution.canReconcile, true);
  assert.equal((await run('authoring')).status, 409, 'still blocked: never retried, only reconciled');
});
