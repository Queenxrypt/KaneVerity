// Assurance B5: from an approved design to a verified run, through the API, with the fake
// Kane CLI (dynamic mode) in Assurance mode "all". Covers the pre-execution gates (Kane
// approval writes of design items, the run variables file, the free dry run), the paid run
// with its confirmation, post-execution verification from the evidence pack, mutation
// checks, and runs that end without a known result. No real Kane process runs.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDocsServer } from '../../docs/server.ts';
import { makeZip, TESTS_DIR } from './helpers.ts';
import { confirmedIds, confirmText, planSlugs, selectionChangedNote, startLabel } from '../../web/src/runPlan.ts';
import { appendRecord, buildPack, correctiveGeneration, generation1, generation2, goodMembers, testFileText, writeTestFile, writeVariables, type PackMember } from './design-fixture.ts';

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

const packFile = async (name: string, alter: (m: PackMember[]) => void = () => {}, runKind = 'replay', runId?: string, mergedFrom?: string[], realShape = false) => {
  const members = goodMembers(defs, appOrigin);
  alter(members);
  const f = path.join(work, `${name}.evidence`);
  // realShape: written as Kane 0.10.5 merges a testrun (per-member run kinds, anchored verifies lists).
  await writeFile(f, buildPack({ members, appOrigin, runKind, runId, mergedFrom, ...(realShape ? { layout: 'combined' as const, anchors: true } : {}) }, makeZip));
  return f;
};

/**
 * The fake Kane's testrun options for one run: the combined pack (with Kane's run id), and with
 * perTest also one pack per test, the pack in Kane 0.10.5's real merged shape (perTest: true for
 * three tests, or the number of tests in the run).
 */
const packRun = async (name: string, alter: (m: PackMember[]) => void = () => {}, runKind = 'replay', perTest: boolean | number = false) => {
  const packId = randomUUID();
  const n = perTest === true ? 3 : perTest === false ? 0 : perTest;
  const testPackIds = n ? Array.from({ length: n }, () => randomUUID()) : undefined;
  return { pack: await packFile(name, alter, runKind, packId, testPackIds, !!n), packId, ...(testPackIds ? { testPackIds } : {}) };
};

// Waits are capped well beyond the 30 s fake-Kane limit (a hanging run is killed at that limit).
const waitExecution = async (until: (x: { state: string }) => boolean) => {
  for (let i = 0; i < 1200; i++) {
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

/** As the page does: an authoring run sends the exact tests its confirmation showed (the view's authoringPlan). */
const run = async (phase: 'authoring' | 'verification', tests?: string[]) => post(`${D}/execute`, { confirm: { paid: true, ...(phase === 'authoring' ? { tests: tests ?? (await view()).authoringPlan.tests.map((t: { testCid: string }) => t.testCid) } : {}) }, phase });
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
  await script({ testrun: { ...(await packRun('author-1', undefined, 'author')), appendRecord: 'execution' } });
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
  await script({ testrun: { ...(await packRun('verify-1')), appendRecord: 'execution' } });
  d = await settled('verification');
  assert.equal(d.execution.phase, 'verification');
  assert.equal(d.execution.verdict, 'VERIFIED', JSON.stringify(d.execution));
  assert.deepEqual(d.execution.outcomes.map((o: { outcome: string; basis: string }) => [o.outcome, o.basis]), [['O1', 'dom_value'], ['O2', 'dom_baseline_change'], ['O3', 'dom_value']]);

  // Verification without O1's status-region evidence: NOT VERIFIED.
  await script({ testrun: { ...(await packRun('verify-weak', (m) => (m[0].actions[0].action_params = { ...(m[0].actions[0].action_params as object), locators: ['internal:text="API key generated"i'] }))), appendRecord: 'execution' } });
  d = await settled('verification');
  assert.equal(d.execution.verdict, 'NOT_VERIFIED');
  assert.deepEqual(d.execution.outcomes.map((o: { verified: boolean }) => o.verified), [false, true, true]);

  // A verification run that superseded the design in the store: NOT VERIFIED.
  await script({ testrun: { ...(await packRun('verify-2')), appendRecord: 'exec-supersede' } });
  d = await settled('verification');
  assert.equal(d.execution.verdict, 'NOT_VERIFIED');
  assert.match(d.execution.mutation.join(' '), /not an execution record \(exec-supersede\)/);

  // A replay miss that re-authored: run_kind author and rewritten recordings -> NOT VERIFIED, and the next verification is blocked.
  await script({ testrun: { ...(await packRun('reauthored', undefined, 'author')), appendRecord: 'execution', reauthor: true } });
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
  await script({ testrun: { ...(await packRun('author-kept', undefined, 'author')), appendRecord: 'execution' } });
  d = await settled('authoring');
  assert.equal(d.execution.verdict, 'AUTHORED', JSON.stringify(d.execution));
  const argv = (await calls()).filter((c) => c.argv[0] === 'testrun' && !c.argv.includes('--dry-run')).pop()!.argv;
  assert.ok(!argv.includes(oldRel), 'the superseded file is never run');
  // Every recording approved: no authoring run starts (nothing needs recording).
  await approveRecordings();
  const n = await testRuns();
  const refused = await run('authoring');
  assert.equal(refused.status, 409);
  assert.match((await j(refused)).error, /every test already has an approved, current recording/);
  assert.equal(await testRuns(), n, 'Kane did not run');
  // Changed during a run: a mutation, NOT VERIFIED (here the verification run).
  await script({ testrun: { ...(await packRun('verify-kept-2')), appendRecord: 'execution', touchFile: oldRel } });
  d = await settled('verification');
  assert.equal(d.execution.verdict, 'NOT_VERIFIED');
  assert.match(d.execution.mutation.join(' '), /superseded test file .* changed during the run/);
  await writeFile(oldAbs, original);
});

test('a test file changed during an authoring run fails it, blocks the next run, and its recordings cannot be approved', async () => {
  await setup();
  await toAuthoringReady();
  const file = path.join(workspace, '.testmuai', 'tests', 'check-the-key-count_test.md');
  const original = await readFile(file);
  await script({ testrun: { ...(await packRun('author-mut', undefined, 'author')), mutateTest: true, appendRecord: 'execution' } });
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

// --- Kane 0.10.5's real testrun shape: one pack per test plus a combined pack (2026-11-26) ---

const evDir = () => path.join(workspace, '.testmuai', 'evidence');
const shaOf = async (f: string) => createHash('sha256').update(await readFile(f)).digest('hex');
const evidenceShas = async () => Object.fromEntries(await Promise.all((await readdir(evDir()).catch(() => [] as string[])).sort().map(async (n) => [n, await shaOf(path.join(evDir(), n))])));
const histFile = () => path.join(work, 'data', 'assurance', 'design-reviews', `${T}.json`);
const executionsOf = async (id: string) => JSON.parse(await readFile(histFile(), 'utf8')).executions.filter((e: { executionId: string }) => e.executionId === id);

test("the real four-pack run: Kane's named combined pack is verified, every per-test pack is accounted for and kept, and each test is tied to its file, pack and recording", async () => {
  await setup();
  await toAuthoringReady();
  const before = await evidenceShas();
  const opts = await packRun('author-4', undefined, 'author', true);
  await script({ testrun: { ...opts, appendRecord: 'execution' } });
  let d = await settled('authoring');
  assert.equal(d.execution.verdict, 'AUTHORED', JSON.stringify(d.execution));
  assert.equal(d.execution.checker, 3);
  assert.equal(d.execution.evidenceFile, `${opts.packId}.evidence`);
  assert.deepEqual(d.execution.testPacks, opts.testPackIds!.map((x) => `${x}.evidence`).sort());
  assert.deepEqual(d.execution.kaneRun, { overallStatus: 'passed', totals: { tests: 3, passed: 3, failed: 0, broken: 0, skipped: 0 } });
  // Each outcome's test: its file, Kane's status, its member in the combined pack, its recording.
  assert.deepEqual(d.execution.members.map((m: { outcome: string; testSlug: string }) => [m.outcome, m.testSlug]), [['O1', 't-2'], ['O2', 't-3'], ['O3', 't-4']]);
  for (const m of d.execution.members) {
    assert.equal(m.kaneStatus, 'passed');
    assert.equal(m.packMemberStatus, 'passed');
    assert.ok(opts.testPackIds!.map((x) => `${x}.evidence`).includes(m.testPack), 'its per-test pack');
    assert.ok(m.recording.exists && /^[a-f0-9]{64}$/.test(m.recording.sha256));
    assert.match(m.recording.path, new RegExp(`output-${m.testFile.split('/').pop().replace(/_test\.md$/, '')}$`));
  }
  // The per-test pack for each file is the one Kane reported for it (summary order = argv order).
  const hist = (await executionsOf(d.execution.executionId)).pop();
  assert.equal(hist.result.packs.length, 4);
  assert.equal(hist.result.packs.filter((p: { role: string }) => p.role === 'combined').length, 1);
  assert.match(hist.result.outputSha256, /^[a-f0-9]{64}$/);
  // Every pack is still there, unchanged, and nothing else was touched.
  const after = await evidenceShas();
  for (const [n, sha] of Object.entries(before)) assert.equal(after[n], sha, `${n} unchanged`);
  assert.equal(Object.keys(after).length, Object.keys(before).length + 4);
  assert.equal(after[`${opts.packId}.evidence`], await shaOf(opts.pack));
  // The recordings can be approved, then a four-pack verification replay can verify.
  await approveRecordings();
  const v = await packRun('verify-4', undefined, 'replay', true);
  await script({ testrun: { ...v, appendRecord: 'execution' } });
  d = await settled('verification');
  assert.equal(d.execution.verdict, 'VERIFIED', JSON.stringify(d.execution));
  assert.equal(d.execution.evidenceFile, `${v.packId}.evidence`);
  assert.equal(d.execution.testPacks.length, 3);
  // A finished, current-checker result cannot be re-checked.
  assert.equal(d.execution.canRecheck, false);
  assert.match(d.execution.recheckReason, /already VERIFIED|current checker/);
});

test('fail closed through the real check: missing, unreported, pre-existing or inconsistent packs, and inconsistent output, are never AUTHORED', async () => {
  await setup();
  const other = randomUUID();
  // packAccepted: the pack itself is genuine and checked; the run still fails (here: Kane reported a failed test).
  const cases: { name: string; make: () => Promise<Record<string, unknown>>; re: RegExp; packAccepted?: boolean }[] = [
    { name: 'no testrun_done', make: async () => ({ ...(await packRun('f1', undefined, 'author', true)), events: [{ type: 'testrun_done', drop: true }] }), re: /no testrun_done event/ },
    { name: 'the combined pack file is missing', make: async () => ({ ...(await packRun('f2', undefined, 'author', true)), skipPackFile: true }), re: /that Kane reported is not in the evidence folder/ },
    { name: 'a per-test pack is missing', make: async () => ({ ...(await packRun('f3', undefined, 'author', true)), skipTestPack: 1 }), re: /that Kane reported is not in the evidence folder/ },
    { name: 'an unreported pack appeared', make: async () => ({ ...(await packRun('f4', undefined, 'author', true)), extraPack: `${randomUUID()}.evidence` }), re: /left an evidence pack Kane did not report/ },
    { name: 'the old single-file assumption: four packs, none reported per test', make: async () => ({ ...(await packRun('f5', undefined, 'author', true)), events: [{ type: 'testrun_summary', set: { 'authored.0.source_execution_id': null, 'authored.1.source_execution_id': null, 'authored.2.source_execution_id': null } }] }), re: /left an evidence pack Kane did not report/ },
    { name: 'the pack is not the run Kane reported (run_id)', make: async () => { const o = await packRun('f6', undefined, 'author', true); return { ...o, pack: await packFile('f6b', undefined, 'author', other, o.testPackIds) }; }, re: /does not carry the run id Kane reported/ },
    { name: 'merged_from differs from the reported per-test packs', make: async () => { const o = await packRun('f7', undefined, 'author', true); return { ...o, pack: await packFile('f7b', undefined, 'author', o.packId, [o.testPackIds![0], o.testPackIds![1], other]) }; }, re: /not merged from exactly the per-test packs/ },
    { name: 'the combined pack lacks a test', make: async () => ({ ...(await packRun('f8', (m) => m.splice(2, 1), 'author', true)) }), re: /has no member for test t-4/ },
    { name: 'a test failed', make: async () => ({ ...(await packRun('f9', undefined, 'author', true)), memberStatus: 'failed', overallStatus: 'failed' }), re: /did not report every test as passed/, packAccepted: true },
    { name: 'a malformed output line', make: async () => ({ ...(await packRun('f10', undefined, 'author', true)), rawLines: ['{not json'] }), re: /is not a JSON event/ },
  ];
  for (const c of cases) {
    await toAuthoringReady();
    const cfg = await c.make();
    const before = await evidenceShas();
    await script({ testrun: { ...cfg, appendRecord: 'execution' } });
    const d = await settled('authoring');
    assert.equal(d.execution.verdict, 'NOT_VERIFIED', c.name);
    assert.match(d.execution.problems.join(' '), c.re, c.name);
    if (c.packAccepted) assert.equal(d.execution.evidenceFile, `${cfg.packId}.evidence`, `${c.name}: the genuine pack is named`);
    else assert.equal(d.execution.evidenceFile, null, `${c.name}: no pack accepted`);
    // Nothing that existed before was changed or removed.
    const after = await evidenceShas();
    for (const [n, sha] of Object.entries(before)) assert.equal(after[n], sha, `${c.name}: ${n} unchanged`);
  }
  // A pack Kane names that was already there before the run is not this run's evidence.
  await toAuthoringReady();
  const o = await packRun('f11', undefined, 'author', true);
  await writeFile(path.join(evDir(), `${o.packId}.evidence`), 'was here before the run');
  await script({ testrun: { ...o, appendRecord: 'execution' } });
  const d = await settled('authoring');
  assert.equal(d.execution.verdict, 'NOT_VERIFIED');
  assert.match(d.execution.problems.join(' '), /existed before the run/);
});

/** Make the latest execution look like a version-1 result (the real 2026-11-26 run): NOT_VERIFIED, "4 packs". */
async function asVersion1Result(executionId: string) {
  const log = JSON.parse(await readFile(histFile(), 'utf8'));
  const i = log.executions.map((e: { executionId: string }) => e.executionId).lastIndexOf(executionId);
  const e = log.executions[i];
  const problem = 'The run left 4 evidence packs; exactly one was expected.';
  log.executions[i] = { ...e, state: 'finished', reason: `Authoring failed: ${problem}`, result: { verdict: 'NOT_VERIFIED', recordings: e.result.recordings, mutation: [], evidenceFile: null, verification: null, problems: [problem] } };
  await writeFile(histFile(), JSON.stringify(log));
}

test('free re-check: bound to the completed job, its saved output and fingerprints; never runs Kane; once per checker version; refused with nothing recorded when anything changed', async () => {
  await setup();
  await toAuthoringReady();
  const opts = await packRun('author-r', undefined, 'author', true);
  await script({ testrun: { ...opts, appendRecord: 'execution' } });
  let d = await settled('authoring');
  assert.equal(d.execution.verdict, 'AUTHORED');
  const { executionId, jobId } = d.execution;
  await asVersion1Result(executionId);
  d = await readDesign();
  assert.equal(d.execution.verdict, 'NOT_VERIFIED');
  assert.equal(d.execution.checker, 1);
  assert.equal(d.execution.canRecheck, true, d.execution.recheckReason);
  const t2 = d.recordings.find((r: { slug: string }) => r.slug === 't-2');
  assert.equal((await post(`${D}/review`, { kind: 'recording', target: t2.testCid, decision: 'approve' })).status, 409, 'not approvable from a NOT_VERIFIED run');

  const jobFile = path.join(work, 'data', 'assurance', 'jobs', jobId, 'job.json');
  const stdoutFile = path.join(work, 'data', 'assurance', 'jobs', jobId, 'private', 'stdout.ndjson');
  const credits = path.join(work, 'data', 'credits.json');
  const snapshot = async () => ({ job: await shaOf(jobFile), stdout: await shaOf(stdoutFile), credits: await readFile(credits, 'utf8').catch(() => ''), packs: await evidenceShas(), calls: (await calls()).length, entries: (await executionsOf(executionId)).length });
  const s0 = await snapshot();

  // Refused, nothing recorded: a recording changed since the run.
  const rec = path.join(workspace, '.testmuai', 'tests', 'output-check-the-success-message', 'Result.md');
  const recOriginal = await readFile(rec);
  await writeFile(rec, recOriginal.toString('utf8') + '\nedited after the run\n');
  let r = await post(`${D}/executions/${executionId}/recheck`);
  assert.equal(r.status, 409);
  assert.match((await j(r)).error, /nothing was recorded.*recording changed/);
  await writeFile(rec, recOriginal);
  // Refused, nothing recorded: a test file changed since the run.
  const tf = path.join(workspace, '.testmuai', 'tests', 'check-the-key-count_test.md');
  const tfOriginal = await readFile(tf);
  await writeFile(tf, tfOriginal.toString('utf8') + '\nedited\n');
  r = await post(`${D}/executions/${executionId}/recheck`);
  assert.equal(r.status, 409);
  assert.match((await j(r)).error, /nothing was recorded.*changed during the run/);
  await writeFile(tf, tfOriginal);
  // Unknown run, malformed id: not found.
  assert.equal((await post(`${D}/executions/x20990101-000000-abcdef/recheck`)).status, 404);
  assert.equal((await post(`${D}/executions/..%2F..%2Fjobs/recheck`)).status, 404);
  assert.deepEqual(await snapshot(), s0, 'refusals recorded nothing and changed nothing');

  // The re-check: AUTHORED from what the run left; Kane not run; job, output, packs, credits untouched.
  r = await post(`${D}/executions/${executionId}/recheck`);
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  d = await j(r);
  assert.equal(d.execution.state, 'rechecked');
  assert.equal(d.execution.verdict, 'AUTHORED', JSON.stringify(d.execution));
  assert.equal(d.execution.checker, 3);
  assert.deepEqual(d.execution.recheckOf && [d.execution.recheckOf.verdict, d.execution.recheckOf.checker], ['NOT_VERIFIED', 1]);
  assert.match(d.execution.reason, /Kane was not run again/);
  assert.equal(d.execution.evidenceFile, `${opts.packId}.evidence`);
  assert.equal(d.execution.members.length, 3);
  const s1 = await snapshot();
  assert.deepEqual({ ...s1, entries: s0.entries }, s0, 'no Kane call, no credit entry, job/output/packs unchanged');
  assert.equal(s1.entries, s0.entries + 1, 'one entry appended');
  const entries = await executionsOf(executionId);
  assert.deepEqual(entries.map((e: { state: string }) => e.state).slice(-2), ['finished', 'rechecked'], 'the original result is kept');
  assert.equal(entries[entries.length - 2].result.verdict, 'NOT_VERIFIED');

  // Not again: it was checked by the current checker version.
  assert.equal(d.execution.canRecheck, false);
  r = await post(`${D}/executions/${executionId}/recheck`);
  assert.equal(r.status, 409);
  assert.match((await j(r)).error, /already checked by the current checker \(version 3\)/);
  assert.equal((await executionsOf(executionId)).length, s1.entries, 'nothing recorded');
  // The re-checked run's recordings can now be approved.
  await approveRecordings();
});

test('a failed re-check is recorded and cannot be repeated to fish for a pass', async () => {
  await setup();
  await toAuthoringReady();
  const opts = await packRun('author-f', undefined, 'author', true);
  await script({ testrun: { ...opts, appendRecord: 'execution' } });
  let d = await settled('authoring');
  assert.equal(d.execution.verdict, 'AUTHORED');
  const { executionId } = d.execution;
  await asVersion1Result(executionId);
  // The combined pack was rewritten after the run (its time is outside the job): not this run's evidence.
  const later = new Date(Date.now() + 24 * 3600_000);
  await utimes(path.join(evDir(), `${opts.packId}.evidence`), later, later);
  let r = await post(`${D}/executions/${executionId}/recheck`);
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  d = await j(r);
  assert.equal(d.execution.state, 'rechecked');
  assert.equal(d.execution.verdict, 'NOT_VERIFIED');
  assert.match(d.execution.problems.join(' '), /was not written during this run's job/);
  // Restoring the time does not reopen it: one re-check per checker version.
  const now = new Date();
  await utimes(path.join(evDir(), `${opts.packId}.evidence`), now, now);
  r = await post(`${D}/executions/${executionId}/recheck`);
  assert.equal(r.status, 409);
  assert.match((await j(r)).error, /already checked by the current checker \(version 3\)/);
  assert.equal((await view()).execution.canRecheck, false);
});

// --- Phase A (2026-11-26): per-test recordings, selective authoring, checker 3, the corrective evolve ---

const FILE = { message: '.testmuai/tests/check-the-success-message_test.md', list: '.testmuai/tests/check-the-new-key-in-the-list_test.md', count: '.testmuai/tests/check-the-key-count_test.md' };
/** O1 recorded the way the real 2026-11-26 run did: the message found by its own text. */
const weakO1 = (m: PackMember[]) => (m[0].actions[0].action_params = { ...(m[0].actions[0].action_params as object), locators: ['internal:text="API key generated"i'] });
/** The test files Kane was given (testrun argv), and the files a run plan names: the two must be equal. */
const argvFiles = (argv: string[]) => argv.filter((a) => a.startsWith('.testmuai/tests/')).sort();
const planFiles = (p: { tests: { testFile: string | null }[] }) => p.tests.map((t) => t.testFile!).sort();
const lastRunArgv = async () => (await calls()).filter((c) => c.argv[0] === 'testrun' && !c.argv.includes('--dry-run')).pop()!.argv;
const recOf = (d: { recordings: { slug: string }[] }, slug: string) => d.recordings.find((r) => r.slug === slug) as { slug: string; testCid: string; sha256: string; ok: boolean; reason: string; state: string; stale: boolean; evidence: { ok: boolean; reason: string } };
const decideRec = (slug: string, d: { recordings: { slug: string; testCid: string }[] }, decision: 'approve' | 'reject', reason?: string) => post(`${D}/review`, { kind: 'recording', target: recOf(d, slug).testCid, decision, ...(reason ? { reason } : {}) });

/** Authoring of all three tests with O1's check weak; t-3 and t-4 approved, t-2 (the message test) rejected. */
async function authoredWithT2Rejected() {
  await toAuthoringReady();
  await script({ testrun: { ...(await packRun('author-weak', weakO1, 'author', true)), appendRecord: 'execution' } });
  let d = await settled('authoring');
  assert.equal(d.execution.verdict, 'AUTHORED', JSON.stringify(d.execution));
  d = await readDesign();
  assert.equal(recOf(d, 't-2').evidence.ok, false);
  assert.equal((await decideRec('t-3', d, 'approve')).status, 200);
  assert.equal((await decideRec('t-4', d, 'approve')).status, 200);
  assert.equal((await decideRec('t-2', d, 'reject', 'O1 is found by its own text and is a yes/no answer, not a read of the status region.')).status, 200);
  return readDesign();
}

test('recording review per test: a recorded check that cannot verify is never approved; only that test is recorded again; the others keep their approvals; verification covers every test', async () => {
  await setup();
  await toAuthoringReady();
  // The page's plan is exactly what Kane is given: here every test (nothing is recorded yet).
  const plan0 = (await view()).authoringPlan;
  assert.deepEqual(planSlugs(plan0), ['t-2', 't-3', 't-4']);
  assert.equal(plan0.available, true, plan0.reason);
  assert.equal(startLabel('authoring', plan0), 'Start the authoring run of t-2, t-3 and t-4 (uses credits)');
  await script({ testrun: { ...(await packRun('author-weak', weakO1, 'author', true)), appendRecord: 'execution' } });
  let d = await settled('authoring');
  assert.deepEqual(argvFiles(await lastRunArgv()), planFiles(plan0), 'Kane was given exactly the planned tests');
  assert.equal(d.execution.verdict, 'AUTHORED', 'AUTHORED is the run; each recorded check is judged at review');
  d = await readDesign();
  // The weak check is shown and cannot be approved; the strong ones can.
  assert.equal(recOf(d, 't-2').evidence.ok, false);
  assert.match(recOf(d, 't-2').evidence.reason, /recorded check of O1 does not meet the evidence rules .*located by its text/);
  assert.equal(recOf(d, 't-3').evidence.ok, true, recOf(d, 't-3').evidence.reason);
  assert.equal(recOf(d, 't-4').evidence.ok, true, recOf(d, 't-4').evidence.reason);
  let r = await decideRec('t-2', d, 'approve');
  assert.equal(r.status, 409);
  assert.match((await j(r)).error, /cannot be approved: the recorded check of O1/);
  assert.equal((await decideRec('t-3', d, 'approve')).status, 200);
  assert.equal((await decideRec('t-4', d, 'approve')).status, 200);
  assert.equal((await decideRec('t-2', d, 'reject', 'A yes/no answer from a text locator.')).status, 200);
  d = await readDesign();
  assert.equal(d.verificationReadiness.ready, false);
  assert.match(gate({ readiness: d.verificationReadiness }, 'recordings').reason, /t-2: rejected/);
  const kept = { t3: recOf(d, 't-3').sha256, t4: recOf(d, 't-4').sha256 };
  // Authoring again records only t-2: Kane is given its file alone, and the pack holds only it.
  await toAuthoringReady();
  const plan1 = (await view()).authoringPlan;
  assert.deepEqual(planSlugs(plan1), ['t-2']);
  assert.equal(plan1.available, true, plan1.reason);
  const text1 = confirmText('authoring', plan1, 3);
  assert.match(text1, /records one test in a browser: t-2. 2 tests have an approved, current recording and are not recorded again./);
  assert.doesNotMatch(text1, /t-3|t-4/);
  assert.equal(startLabel('authoring', plan1), 'Start the authoring run of t-2 (uses credits)');
  await script({ testrun: { ...(await packRun('author-t2', (m) => m.splice(1, 2), 'author', 1)), appendRecord: 'execution', reauthor: true } });
  d = await settled('authoring');
  assert.equal(d.execution.verdict, 'AUTHORED', JSON.stringify(d.execution));
  const argv = await lastRunArgv();
  assert.ok(argv.includes(FILE.message) && !argv.includes(FILE.list) && !argv.includes(FILE.count), argv.join(' '));
  assert.deepEqual(argvFiles(argv), planFiles(plan1), 'Kane was given exactly the planned test');
  assert.deepEqual(d.execution.members.map((m: { testSlug: string }) => m.testSlug), ['t-2']);
  // t-3 and t-4 keep their recordings and approvals (each proven by the run that recorded it); t-2 is new.
  d = await readDesign();
  assert.equal(recOf(d, 't-3').sha256, kept.t3);
  assert.equal(recOf(d, 't-4').sha256, kept.t4);
  assert.ok(recOf(d, 't-3').ok && recOf(d, 't-4').ok, `${recOf(d, 't-3').reason} ${recOf(d, 't-4').reason}`);
  assert.equal(recOf(d, 't-2').stale, true, 'the rejection was made on the old recording');
  assert.equal(recOf(d, 't-2').evidence.ok, true, recOf(d, 't-2').evidence.reason);
  assert.equal((await decideRec('t-2', d, 'approve')).status, 200);
  // Verification always replays every approved test.
  assert.equal((await j(await post(`${D}/dry-run`))).dryRun.latest.state, 'passed');
  d = await readDesign();
  assert.equal(d.verificationReadiness.ready, true, notReady(d));
  const vplan = d.verificationPlan;
  assert.deepEqual(planSlugs(vplan), ['t-2', 't-3', 't-4']);
  assert.match(confirmText('verification', vplan, 3), /replays all 3 approved recordings in a browser, with no re-recording: t-2, t-3 and t-4./);
  await script({ testrun: { ...(await packRun('verify-all', undefined, 'replay', true)), appendRecord: 'execution' } });
  d = await settled('verification');
  assert.equal(d.execution.verdict, 'VERIFIED', JSON.stringify(d.execution));
  const vArgv = await lastRunArgv();
  for (const f of Object.values(FILE)) assert.ok(vArgv.includes(f), f);
  assert.deepEqual(argvFiles(vArgv), planFiles(vplan), 'Kane was given exactly the planned tests');
  // Nothing needs recording now: the page says why, in the words the backend refuses with.
  d = await view();
  assert.equal(d.authoringPlan.available, false);
  assert.match(d.authoringPlan.reason, /every test already has an approved, current recording/);
  const refused = await run('authoring');
  assert.equal(refused.status, 409);
  assert.equal((await j(refused)).error, `Not started (authoring): ${d.authoringPlan.reason}`);
});

test("an authoring run of some tests that changes another test's recording is a mutation, and that test's approval no longer counts", async () => {
  await setup();
  let d = await authoredWithT2Rejected();
  await toAuthoringReady();
  await script({ testrun: { ...(await packRun('author-t2-touch', (m) => m.splice(1, 2), 'author', 1)), appendRecord: 'execution', reauthor: true, touchFile: '.testmuai/tests/output-check-the-key-count/Result.md' } });
  d = await settled('authoring');
  assert.equal(d.execution.verdict, 'NOT_VERIFIED');
  assert.match(d.execution.mutation.join(' '), /output-check-the-key-count changed during the run, though its test was not in the run/);
  d = await readDesign();
  assert.equal(recOf(d, 't-4').ok, false);
  assert.match(recOf(d, 't-4').reason, /stale/);
});

test('checker 3: an AUTHORED result from an older checker cannot back a recording approval until its free re-check; VERIFIED is never re-checked', async () => {
  await setup();
  await toAuthoringReady();
  const opts = await packRun('author-v2', undefined, 'author', true);
  await script({ testrun: { ...opts, appendRecord: 'execution' } });
  let d = await settled('authoring');
  assert.equal(d.execution.verdict, 'AUTHORED');
  const { executionId } = d.execution;
  // As the real run's result is now: AUTHORED, made by checker version 2.
  const log = JSON.parse(await readFile(histFile(), 'utf8'));
  const i = log.executions.map((e: { executionId: string }) => e.executionId).lastIndexOf(executionId);
  log.executions[i] = { ...log.executions[i], result: { ...log.executions[i].result, checker: 2 } };
  await writeFile(histFile(), JSON.stringify(log));
  d = await readDesign();
  assert.match(recOf(d, 't-4').evidence.reason, /checked by checker version 2; re-check it \(free\) with version 3 first/);
  assert.equal((await decideRec('t-4', d, 'approve')).status, 409);
  // Nor is it recorded again (paid) when a free re-check is all it needs.
  await toAuthoringReady();
  const runsBefore = await testRuns();
  // The page shows the same reason the backend refuses with, and offers no paid run.
  const pv = (await view()).authoringPlan;
  assert.equal(pv.available, false);
  assert.match(pv.reason, /t-2, t-3, t-4 already have recordings from a run checked by an older checker version\. Re-check that run \(free\) first/);
  const ar = await run('authoring');
  assert.equal(ar.status, 409);
  assert.equal((await j(ar)).error, `Not started (authoring): ${pv.reason}`);
  assert.equal(await testRuns(), runsBefore, 'Kane did not run');
  d = await view();
  assert.equal(d.execution.canRecheck, true, d.execution.recheckReason);
  const before = (await calls()).length;
  const r = await post(`${D}/executions/${executionId}/recheck`);
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  d = await j(r);
  assert.deepEqual([d.execution.state, d.execution.verdict, d.execution.checker, d.execution.recheckOf.verdict, d.execution.recheckOf.checker], ['rechecked', 'AUTHORED', 3, 'AUTHORED', 2]);
  assert.equal((await calls()).length, before, 'Kane was not run');
  d = await approveRecordings();
  await script({ testrun: { ...(await packRun('verify-v3', undefined, 'replay', true)), appendRecord: 'execution' } });
  d = await settled('verification');
  assert.equal(d.execution.verdict, 'VERIFIED');
  assert.equal(d.execution.canRecheck, false);
  assert.match(d.execution.recheckReason, /already VERIFIED/);
});

/** Forget the synthetic evolve jobs of earlier tests (this file's data folder is shared by its tests). */
async function forgetEvolves() {
  const jobsDir = path.join(work, 'data', 'assurance', 'jobs');
  for (const id of await readdir(jobsDir).catch(() => [] as string[])) {
    const job = JSON.parse(await readFile(path.join(jobsDir, id, 'job.json'), 'utf8').catch(() => 'null'));
    if (job?.kind === 'evolve') await rm(path.join(jobsDir, id), { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
  const log = JSON.parse(await readFile(histFile(), 'utf8').catch(() => 'null'));
  if (log) await writeFile(histFile(), JSON.stringify({ ...log, evolveChecks: [] }));
}
/** This use case's one evolve, completed and checked with no problems (as the real one is). */
async function firstEvolveDone() {
  const jobId = 'j20261125-000000-e0e0e0';
  const at = new Date(Date.now() - 3600_000).toISOString();
  await mkdir(path.join(work, 'data', 'assurance', 'jobs', jobId), { recursive: true });
  await writeFile(path.join(work, 'data', 'assurance', 'jobs', jobId, 'job.json'), JSON.stringify({ jobId, kind: 'evolve', params: { kind: 'evolve', tutorialId: T, ucCid: UC, useCase: 'uc-1', reviewer: 'test-reviewer', decisionId: 'r-earlier', inputs: {}, instruction: 'The earlier evolve of this use case.', acknowledgement: 'given' }, tutorialId: T, state: 'complete', reason: 'Complete.', createdAt: at, startedAt: at, finishedAt: at, args: [], exitCode: 0, cliVersion: '0.10.5', verb: null, doneStatus: 'complete', next: [], pause: null, parentJobId: null, resumedBy: null, requirements: null, credits: { amount: 18.13, basis: 'reported', reportedTotal: 18.13, measured: null, balanceBefore: null, balanceAfter: null }, summary: { ingested: [], commits: [], warnings: [], errors: [], held: 0, messages: [], unknownEventTypes: [], nonJsonLines: 0, invalidLines: 0 } }));
  const log = JSON.parse(await readFile(histFile(), 'utf8'));
  log.evolveChecks = [...(log.evolveChecks ?? []), { jobId, at, jobState: 'complete', late: false, problems: [] }];
  await writeFile(histFile(), JSON.stringify(log));
}
const EVOLVE_OK = [{ v: 1, verb: 'design', type: 'run_start', mode: 'agent' }, { v: 1, verb: 'design', type: 'usage', credits: 17.5, total_credits: 17.5 }, { v: 1, verb: 'design', type: 'done', status: 'complete', exit_code: 0 }].map((x) => JSON.stringify(x));
const correctiveInputs = () => ({ useCase: 'uc-1', steps: ['Developer Settings', 'API Keys', 'Generate Key'] as [string, string, string], replace: [{ test: 't-2', scenario: 'sc-2', outcome: 'O1', criterion: 'ac-3', requirement: 'status_region' as const, label: 'API key generated successfully.' }], keep: { criteria: ['ac-2', 'ac-3', 'ac-4'], scenarios: ['sc-2', 'sc-3', 'sc-4'], tests: ['t-3', 't-4'] } });
const waitJobDone = async (jobId: string) => {
  for (let i = 0; i < 1200; i++) {
    const job = await j(await fetch(`${api}/api/assurance/jobs/${jobId}`));
    if (!['queued', 'running'].includes(job.state)) return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the evolve did not end');
};
/** The evolve check recorded for a job (it is appended right after the job ends). */
const evolveCheckOf = async (jobId: string) => {
  for (let i = 0; i < 300; i++) {
    const c = JSON.parse(await readFile(histFile(), 'utf8')).evolveChecks.filter((x: { jobId: string }) => x.jobId === jobId).pop();
    if (c) return c as { problems: string[] };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('no evolve check was recorded');
};
/** Every live and superseded recording and test file, fingerprinted (what a corrective evolve must not change). */
const fingerprints = async () => {
  const dir = path.join(workspace, '.testmuai', 'tests');
  const out: Record<string, string> = {};
  const walk = async (d: string, rel: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(path.join(d, e.name), `${rel}${e.name}/`);
      else out[`${rel}${e.name}`] = await shaOf(path.join(d, e.name));
    }
  };
  await walk(dir, '');
  return out;
};

test('corrective evolve: one, after the recording review; Kane replaces only the rejected test, every kept item, file and recording stays as it is; then only the new test is recorded and verification covers all three', async () => {
  const { g1, g2 } = await setup();
  await forgetEvolves();
  let d = await authoredWithT2Rejected();
  const { correctiveEvolveAcknowledgement, correctiveEvolveInstruction } = await import('../src/assurance/commands.ts');
  const words = correctiveEvolveAcknowledgement(UC, ['t-2']);
  const corrective = (body: Record<string, unknown> = {}) => post(`${D}/evolve`, { corrective: true, confirm: { paid: true }, acknowledgement: words, ...body });
  // Refused before anything runs: no completed evolve yet, wrong words, no paid confirmation, text of its own.
  let r = await corrective();
  assert.equal(r.status, 409);
  assert.match((await j(r)).error, /follows only this use case's one evolve, completed and checked/);
  await firstEvolveDone();
  r = await corrective({ acknowledgement: 'I approve.' });
  assert.equal(r.status, 400);
  assert.match((await j(r)).error, /replaces only t-2 with new tests, keeps every other item exactly as it is/);
  assert.equal((await corrective({ confirm: {} })).status, 400);
  assert.equal((await corrective({ instruction: 'my own words' })).status, 400);
  assert.equal((await post(`${D}/evolve`, { confirm: { paid: true }, acknowledgement: (await import('../src/assurance/commands.ts')).evolveAcknowledgement(UC) })).status, 409, 'the one plain evolve is used');
  const evolvesBefore = (await calls()).filter((c) => c.argv[0] === 'maintain').length;
  assert.equal(evolvesBefore, 0, 'no evolve ran');
  // The corrective evolve: Kane supersedes t-2 with t-5 (a new title, a new file) and keeps the rest.
  const ins = correctiveEvolveInstruction(correctiveInputs());
  const gen = correctiveGeneration(UC, g1, { sc2: g2.ids.sc2, t2: g2.ids.t2 }, ins);
  const newFile = `.testmuai/tests/${gen.ids.name}_test.md`;
  await script({ 'maintain evolve': { stdout: EVOLVE_OK, exit: 0, appendCommits: gen.records, writeFiles: { [newFile]: testFileText('t-5', gen.ids.definitionId, gen.ids.body) } } });
  const before = await fingerprints();
  r = await corrective();
  assert.equal(r.status, 202, JSON.stringify(await r.clone().json()));
  const job = await waitJobDone((await j(r)).jobId);
  assert.equal(job.state, 'complete', job.reason);
  const argv = (await calls()).filter((c) => c.argv[0] === 'maintain').pop()!.argv;
  assert.deepEqual(argv.slice(0, 5), ['maintain', 'evolve', 'uc-1', '--because', ins]);
  assert.match(ins, /Replace only t-2 of uc-1.*status message region \(role=status\).*'API key generated successfully\.'.*Keep ac-2, ac-3, ac-4, sc-2, sc-3, sc-4 and t-3, t-4 exactly as they are/);
  const check = await evolveCheckOf(job.jobId);
  assert.deepEqual(check.problems, []);
  // Every file and recording that existed is byte-identical; only the new test file was added.
  const after = await fingerprints();
  for (const [f, sha] of Object.entries(before)) assert.equal(after[f], sha, f);
  assert.deepEqual(Object.keys(after).filter((f) => !(f in before)), [newFile.replace('.testmuai/tests/', '')]);
  // B5: t-5 replaces t-2; t-3, t-4 and the scenarios are kept from generation 2, by exact content id.
  d = await readDesign();
  assert.deepEqual(d.design.tests.map((x: { slug: string }) => x.slug).sort(), ['t-3', 't-4', 't-5']);
  assert.equal(d.evaluation.generation.ok, true, d.evaluation.generation.problems.join(' '));
  assert.ok(d.evaluation.generation.notes.some((n: string) => /t-4 comes from generation 2 and was kept, unchanged, by the corrective evolve/.test(n)));
  assert.deepEqual(d.design.supersededTestFiles.map((f: { path: string }) => f.path), [FILE.message], "t-2's own file is kept as superseded");
  assert.ok(recOf(d, 't-3').ok && recOf(d, 't-4').ok, 'the kept approvals still count');
  // There is one corrective evolve, and no other evolve or design afterwards.
  r = await corrective();
  assert.ok([400, 409].includes(r.status), String(r.status));
  // Review and approve t-5, record only t-5, approve its recording, verify all three.
  d = await toAuthoringReady();
  await script({ testrun: { ...(await packRun('author-t5', (m) => { m.splice(1, 2); m[0].definitionId = gen.ids.definitionId; }, 'author', 1)), appendRecord: 'execution' } });
  d = await settled('authoring');
  assert.equal(d.execution.verdict, 'AUTHORED', JSON.stringify(d.execution));
  const aArgv = await lastRunArgv();
  assert.ok(aArgv.includes(newFile) && !aArgv.includes(FILE.list) && !aArgv.includes(FILE.count) && !aArgv.includes(FILE.message), aArgv.join(' '));
  d = await readDesign();
  assert.equal((await decideRec('t-5', d, 'approve')).status, 200);
  assert.equal((await j(await post(`${D}/dry-run`))).dryRun.latest.state, 'passed');
  d = await readDesign();
  assert.equal(d.verificationReadiness.ready, true, notReady(d));
  await script({ testrun: { ...(await packRun('verify-corrected', (m) => (m[0].definitionId = gen.ids.definitionId), 'replay', true)), appendRecord: 'execution' } });
  d = await settled('verification');
  assert.equal(d.execution.verdict, 'VERIFIED', JSON.stringify(d.execution));
  const vArgv = await lastRunArgv();
  assert.ok(vArgv.includes(newFile) && vArgv.includes(FILE.list) && vArgv.includes(FILE.count) && !vArgv.includes(FILE.message));
  // The original t-2 file and recording are still exactly as they were.
  const final = await fingerprints();
  for (const [f, sha] of Object.entries(before)) assert.equal(final[f], sha, f);
});

test('corrective evolve fails closed: superseding a kept test or changing a recording, overwriting the rejected test\'s file or not replacing it, each block the design', async () => {
  const { correctiveEvolveAcknowledgement, correctiveEvolveInstruction } = await import('../src/assurance/commands.ts');
  const ins = correctiveEvolveInstruction(correctiveInputs());
  const cases: { name: string; make: (g1: ReturnType<typeof generation1>['ids'], g2: ReturnType<typeof generation2>['ids']) => Record<string, unknown>; re: RegExp[] }[] = [
    {
      name: 'superseded a kept test and changed a recording',
      make: (g1, g2) => {
        const gen = correctiveGeneration(UC, g1, { sc2: g2.sc2, t2: g2.t2 }, ins, { alsoSupersede: [g2.t4] });
        return { appendCommits: gen.records, writeFiles: { [`.testmuai/tests/${gen.ids.name}_test.md`]: testFileText('t-5', gen.ids.definitionId, gen.ids.body), '.testmuai/tests/output-check-the-key-count/Result.md': '# changed by the evolve\n' } };
      },
      re: [/t-4 was superseded, but the corrective evolve had to keep it exactly as it is/, /The recording \.testmuai\/tests\/output-check-the-key-count changed/],
    },
    {
      name: "overwrote the rejected test's file and did not replace it",
      make: (g1, g2) => {
        const gen = correctiveGeneration(UC, g1, { sc2: g2.sc2, t2: g2.t2 }, ins, { noReplace: true });
        return { appendCommits: gen.records, writeFiles: { [FILE.message]: testFileText('t-5', gen.ids.definitionId, gen.ids.body) } };
      },
      re: [/Test file \.testmuai\/tests\/check-the-success-message_test\.md was changed/, /t-2 was not replaced/],
    },
  ];
  for (const c of cases) {
    const { g1, g2 } = await setup();
    await forgetEvolves();
    await authoredWithT2Rejected();
    await firstEvolveDone();
    await script({ 'maintain evolve': { stdout: EVOLVE_OK, exit: 0, ...c.make(g1, g2.ids) } });
    const r = await post(`${D}/evolve`, { corrective: true, confirm: { paid: true }, acknowledgement: correctiveEvolveAcknowledgement(UC, ['t-2']) });
    assert.equal(r.status, 202, `${c.name}: ${JSON.stringify(await r.clone().json())}`);
    const job = await waitJobDone((await j(r)).jobId);
    const check = await evolveCheckOf(job.jobId);
    for (const re of c.re) assert.match(check.problems.join(' '), re, c.name);
    const d = await readDesign();
    assert.equal(d.evaluation.generation.ok, false, c.name);
    assert.equal(d.readiness.ready, false, c.name);
    assert.equal((await run('authoring')).status, 409, `${c.name}: nothing runs on a design the check rejected`);
    await script({});
  }
  await forgetEvolves();
});

test('the authoring run is bound to the tests its confirmation showed: a missing, unexpected, malformed or changed list is refused before Kane starts; the same list in any order starts it', async () => {
  await setup();
  await toAuthoringReady();
  const plan = (await view()).authoringPlan;
  const ids = confirmedIds(plan);
  assert.deepEqual(planSlugs(plan), ['t-2', 't-3', 't-4']);
  const credits = path.join(work, 'data', 'credits.json');
  const executions = async () => JSON.parse(await readFile(histFile(), 'utf8')).executions.length as number;
  const jobs = async () => (await readdir(path.join(work, 'data', 'assurance', 'jobs'))).length;
  const state = async () => ({ kane: await testRuns(), executions: await executions(), jobs: await jobs(), credits: await readFile(credits, 'utf8').catch(() => '') });
  const refused = async (tests: unknown, status: number, re: RegExp) => {
    const r = await post(`${D}/execute`, { confirm: { paid: true, ...(tests === undefined ? {} : { tests }) }, phase: 'authoring' });
    const body = await j(r);
    assert.equal(r.status, status, JSON.stringify(body));
    assert.match(body.error, re);
    return body.error as string;
  };
  const s0 = await state();
  // Malformed: no list, a value that is not a content id, a test named twice.
  await refused(undefined, 400, /needs the exact tests you confirmed.*Nothing was started/);
  await refused(['not-an-id'], 400, /needs the exact tests you confirmed/);
  await refused([ids[0], ids[0], ids[1]], 400, /needs the exact tests you confirmed/);
  await refused('everything', 400, /needs the exact tests you confirmed/);
  // A missing test, an unexpected one, an empty list: the selection differs, so nothing starts.
  await refused(ids.slice(0, 2), 409, /tests to record changed since this confirmation \(confirmed: t-2, t-3; now: t-2, t-3, t-4\)\. Nothing ran and no credits were used/);
  await refused([...ids, 'sha256:' + 'f'.repeat(64)], 409, /confirmed: an unknown test \(sha256:ffffffffffff…\), t-2, t-3, t-4; now: t-2, t-3, t-4\)/);
  await refused([], 409, /confirmed: none; now: t-2, t-3, t-4\)/);
  assert.deepEqual(await state(), s0, 'no Kane test run, no execution entry, no job, no credit entry');
  // The same tests in another order: the confirmation matches, and the run starts.
  await script({ testrun: { ...(await packRun('author-bound', weakO1, 'author', true)), appendRecord: 'execution' } });
  const r = await post(`${D}/execute`, { confirm: { paid: true, tests: [...ids].reverse() }, phase: 'authoring' });
  assert.equal(r.status, 202, JSON.stringify(await r.clone().json()));
  let d = await waitExecution((x) => x.state !== 'started');
  assert.equal(d.execution.verdict, 'AUTHORED', JSON.stringify(d.execution));
  assert.deepEqual(argvFiles(await lastRunArgv()), planFiles(plan));
  // The selection changes after a confirmation was shown (t-3 and t-4 approved, t-2 rejected):
  // the stale confirmation is refused, and the page's note asks for a new one.
  const stale = confirmedIds((await view()).authoringPlan);
  assert.equal(stale.length, 3, 'before the review, every recorded test would be recorded again');
  d = await readDesign();
  assert.equal((await decideRec('t-3', d, 'approve')).status, 200);
  assert.equal((await decideRec('t-4', d, 'approve')).status, 200);
  assert.equal((await decideRec('t-2', d, 'reject', 'A yes/no answer from a text locator.')).status, 200);
  await toAuthoringReady();
  const fresh = (await view()).authoringPlan;
  assert.deepEqual(planSlugs(fresh), ['t-2']);
  const s1 = await state();
  const msg = await refused(stale, 409, /tests to record changed since this confirmation \(confirmed: t-2, t-3, t-4; now: t-2\)\. Nothing ran and no credits were used\. Review the current list and confirm again\./);
  assert.deepEqual(await state(), s1, 'nothing started');
  assert.match(selectionChangedNote(msg)!, /The list below has been refreshed: open the authoring run again to review it and confirm\./);
  assert.equal(selectionChangedNote('Not started (authoring): every test already has an approved, current recording'), null, 'only a changed selection gets that note');
  // The refreshed confirmation starts exactly that run.
  await script({ testrun: { ...(await packRun('author-bound-t2', (m) => m.splice(1, 2), 'author', 1)), appendRecord: 'execution', reauthor: true } });
  const r2 = await post(`${D}/execute`, { confirm: { paid: true, tests: confirmedIds(fresh) }, phase: 'authoring' });
  assert.equal(r2.status, 202, JSON.stringify(await r2.clone().json()));
  d = await waitExecution((x) => x.state !== 'started');
  assert.equal(d.execution.verdict, 'AUTHORED', JSON.stringify(d.execution));
  assert.deepEqual(argvFiles(await lastRunArgv()), planFiles(fresh));
  // A verification run is not bound to a list (it always replays every test); its gates are unchanged.
  assert.equal((await post(`${D}/execute`, { confirm: { paid: true }, phase: 'verification' })).status, 409, 'verification is not ready: t-2 is not approved yet');
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
