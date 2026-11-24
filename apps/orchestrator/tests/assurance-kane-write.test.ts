// Assurance B4: writing a KaneVerity approval into Kane's store, verifying it,
// reconciling unknown outcomes, and the design gate. The fake Kane CLI runs in
// dynamic mode: fsck/list/view are computed from the real files, and
// `context review --verdicts` appends a record in exactly the shape Kane 0.10.5
// wrote in the V-B4a validation (record 3). No real Kane process runs.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
const UC_OTHER = 'sha256:' + '9a9a9a9a' + '1'.repeat(56);
const BLOB = 'sha256:' + '55709884' + 'e'.repeat(56);
const REVIEWER = 'test-reviewer';
const listen = (s: Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const j = async (r: Response): Promise<any> => r.json();
const H = { 'Content-Type': 'application/json', 'X-KaneVerity': '1' };
const post = (p: string, body: unknown = {}) => fetch(api + p, { method: 'POST', headers: H, body: JSON.stringify(body) });
const U = `/api/assurance/usecases/${T}`;
const ucBase = (cid = UC) => `${U}/${cid.slice(7)}`;
const approve = (cid = UC) => post(`${ucBase(cid)}/review`, { decision: 'approve', acknowledgeGaps: true, reason: 'Checked against the documentation.' });
const reject = (cid = UC) => post(`${ucBase(cid)}/review`, { decision: 'reject', reason: 'Steps are not cited.' });
const view = async () => j(await fetch(api + U));
const FORBIDDEN = ['--allow-unreviewed', '--allow-archive', '--force'];

let reqMd = '';
let lineOf: (item: string) => number;
const criteria = ["Start at {{app_url}}/ in a fresh browser session, then select 'Developer Settings', 'API Keys', and 'Generate Key' in that order.", "The message 'API key generated successfully.' appears after generating the key.", 'The new key is added to the API keys list.', "The key count below the list shows '2 keys'."];

const reviewsFile = () => path.join(work, 'data', 'assurance', 'reviews', `${T}.json`);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** A fresh store in the V1 format (records 1-2), with no KaneVerity history. */
async function reset(opts: { uc?: string; keepHistory?: boolean } = {}) {
  const uc = opts.uc ?? UC;
  await rm(storeDir, { recursive: true, force: true });
  if (!opts.keepHistory) {
    await rm(reviewsFile(), { force: true });
    await rm(path.join(work, 'data', 'assurance', 'usecases', T), { recursive: true, force: true });
  }
  const lines = reqMd.split('\n');
  const edge = (line: number, claim: string | null) => ({ type: 'DERIVES', src: SRC, dst: uc, props: { source_id: 'kv-generate-an-api-key', source_cid: SRC, anchor: `L${line}-L${line}`, quote: lines[line - 1], ...(claim ? { claim } : {}) } });
  const edges = [edge(19, criteria[0]), ...['O1', 'O2', 'O3'].map((it) => edge(lineOf(it), null))];
  await mkdir(path.join(storeDir, 'commits'), { recursive: true });
  await mkdir(path.join(storeDir, 'blobs', BLOB.slice(7, 9)), { recursive: true });
  await mkdir(path.join(storeDir, 'proposals', '20261122T150616-kv-generate-an-api-key'), { recursive: true });
  await writeFile(path.join(storeDir, 'meta.json'), JSON.stringify({ schema: 'assurance/context@1', canonicalizer: 'v1' }));
  await writeFile(path.join(storeDir, 'blobs', BLOB.slice(7, 9), BLOB.slice(9)), reqMd);
  await writeFile(path.join(storeDir, 'commits', `000001-${H1.slice(0, 12)}.json`), JSON.stringify({ seq: 1, prev_hash: null, nodes: [{ cid: SRC, label: 'source', content: { source_id: 'kv-generate-an-api-key', blob: BLOB } }], edges: [], review: [], schema_version: 'assurance/context@1', created_by: { build: '0.10.5' }, proposal_id: null }));
  await writeFile(
    path.join(storeDir, 'commits', `000002-${H2.slice(0, 12)}.json`),
    JSON.stringify({ seq: 2, prev_hash: `sha256:${H1}`, proposal_id: '20261122T150616-kv-generate-an-api-key', nodes: [{ cid: uc, label: 'usecase', content: { title: 'Generate an API key', description: "Open 'Developer Settings', then 'API Keys', then 'Generate Key'.", summary: 'Generate a key.', actors: ['application user'], value: 'Create a key.', risk: 'high', criteria } }], edges, review: [], schema_version: 'assurance/context@1', created_by: { build: '0.10.5', by: { kind: 'human', id: 'owner' } } }),
  );
  await writeFile(path.join(storeDir, 'proposals', '20261122T150616-kv-generate-an-api-key', 'review.json'), JSON.stringify([{ id: 'n1', kind: 'review-item', resolution: 'skipped', by: { kind: 'human', id: 'owner' } }]));
  await writeFile(path.join(storeDir, 'fake-hashes.json'), JSON.stringify({ '1': `sha256:${H1}`, '2': `sha256:${H2}` }));
}

/** Append a hand-made record (as something other than KaneVerity would). */
async function appendRecord(rec: Record<string, unknown>) {
  const hashes = JSON.parse(await readFile(path.join(storeDir, 'fake-hashes.json'), 'utf8'));
  const seq = (await readdir(path.join(storeDir, 'commits'))).length + 1;
  const body = JSON.stringify({ seq, prev_hash: hashes[String(seq - 1)], proposal_id: null, nodes: [], edges: [], review: [], supersessions: [], schema_version: 'assurance/context@1', parents: [hashes[String(seq - 1)]], created_by: { build: '0.10.5', by: { kind: 'human', id: 'operator' } }, ...rec });
  const hex = sha(body);
  await writeFile(path.join(storeDir, 'commits', `${String(seq).padStart(6, '0')}-${hex.slice(0, 12)}.json`), body);
  hashes[String(seq)] = `sha256:${hex}`;
  await writeFile(path.join(storeDir, 'fake-hashes.json'), JSON.stringify(hashes));
}

const setReview = (mode: string) => writeFile(scriptFile, JSON.stringify({ dynamic: true, review: { mode } }));
const calls = async () => (await readFile(logFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; env: { USER: string | null } });
const reviewCalls = async () => (await calls()).filter((c) => c.argv[0] === 'context' && c.argv[1] === 'review');
const storeRecords = async () => (await readdir(path.join(storeDir, 'commits'))).length;
const fakeHash = async (seq: number) => JSON.parse(await readFile(path.join(storeDir, 'fake-hashes.json'), 'utf8'))[String(seq)];

before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), 'kv-kane-write-'));
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
    // Short enough for the hang test, long enough that ordinary reads never time out
    // while the whole suite runs in parallel (a timed-out read correctly makes the
    // outcome "unknown", which is not what the other tests check).
    KANEVERITY_ASSURANCE_TIMEOUT_MS: '8000',
    KANEVERITY_REVIEWER: REVIEWER,
    KANE_CLI_ENTRY: path.join(TESTS_DIR, 'fake-kane-assurance.cjs'),
    KANEVERITY_DOCS_CONTENT_DIR: contentDir,
    KANEVERITY_ALLOWED_DOCS_ORIGINS: new URL(docsUrl).origin,
    KANEVERITY_ALLOWED_APP_ORIGINS: new URL(appUrl).origin,
    FAKE_ASSURANCE_LOG: logFile,
    FAKE_ASSURANCE_SCRIPT: scriptFile,
  });
  delete process.env.USER;
  storeDir = path.join(work, 'data', 'assurance', 'workspace', '.context');
  await setReview('ok');
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

test('approval: written to Kane with the exact command, verified in the store, and only then eligible for design', async () => {
  await reset();
  await setReview('ok');
  await post(`${U}/retrieve`);
  const before = (await reviewCalls()).length;
  const r = await approve();
  assert.equal(r.status, 200);
  const d = await j(r);
  const uc = d.useCases[0];
  assert.equal(uc.review.state, 'approved');
  assert.equal(uc.kane.state, 'verified', uc.kane.reason);
  assert.equal(uc.kane.kaneSeq, 3);
  assert.equal(uc.kane.kaneHash, await fakeHash(3), 'the full hash of Kane record 3');
  assert.equal(uc.kane.kaneBy, `human:kaneverity:${REVIEWER}`);
  assert.equal(uc.kane.reviewer, REVIEWER);
  assert.equal(uc.kane.recordInStore, true);
  assert.equal(uc.kaneTrust, 'trusted');
  assert.equal(uc.design.eligible, true, uc.design.reasons.join(' '));
  assert.match(d.note, /Verified in Kane: record #3/);
  assert.equal(d.reviewer.label, REVIEWER);
  assert.equal(d.reviewer.selfDeclared, true);
  // One write, shown once, with every logged step in order (no duplicate "pending" write).
  assert.equal(uc.kaneWrites.length, 1);
  assert.deepEqual(uc.kaneWrites[0].steps.map((s: { step: string }) => s.step), ['started', 'kane_running', 'verified']);
  assert.equal(uc.kaneWrites[0].state, 'verified');
  assert.equal(uc.kaneWrites[0].writeId, uc.kane.writeId);
  assert.equal(uc.kaneWrites[0].decisionId, uc.review.history[0].id, 'the write is linked to the decision');
  assert.equal(uc.kaneWrites[0].kaneSeq, 3);

  // Exactly one Kane write, with the exact allow-listed arguments and USER.
  const rc = (await reviewCalls()).slice(before);
  assert.equal(rc.length, 1);
  const writeId = uc.kane.writeId;
  assert.deepEqual(rc[0].argv, ['context', 'review', '--verdicts', `../kane-writes/${writeId}/verdicts.json`, '--mode', 'ci', '--json']);
  assert.equal(rc[0].env.USER, `kaneverity:${REVIEWER}`);
  const verdicts = JSON.parse(await readFile(path.join(work, 'data', 'assurance', 'kane-writes', writeId, 'verdicts.json'), 'utf8'));
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].ref, UC, 'the verdict names the exact content id');
  assert.equal(verdicts[0].resolution, 'approved');
  assert.match(verdicts[0].reason, new RegExp(uc.kane.decisionId));

  // Nothing private reaches the UI.
  const text = JSON.stringify(d);
  assert.ok(!text.includes('someone') && !text.includes('verdicts.json') && !text.includes('kane-writes'), 'no store path or verdict file path');
  // The decision log holds both kinds of entries, append-only.
  const log = JSON.parse(await readFile(reviewsFile(), 'utf8'));
  assert.equal(log.decisions.length, 1);
  assert.equal(log.kaneWrites.length, 3);
});

test('duplicate and concurrent writes are refused; Kane is called once', async () => {
  const before = (await reviewCalls()).length;
  const r = await post(`${ucBase()}/kane-write`);
  assert.equal(r.status, 409);
  assert.match((await j(r)).error, /already recorded in Kane and verified/);

  // Two writes at once after a refusal: one writes, the other is refused.
  await reset();
  await setReview('refuse');
  await post(`${U}/retrieve`);
  assert.equal((await j(await approve())).useCases[0].kane.state, 'not_written');
  await setReview('ok');
  const n = (await reviewCalls()).length;
  const [a, b] = await Promise.all([post(`${ucBase()}/kane-write`), post(`${ucBase()}/kane-write`)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal((await reviewCalls()).length - n, 1, 'exactly one Kane write');
  assert.equal((await view()).useCases[0].kane.state, 'verified');
  assert.ok((await reviewCalls()).length - before >= 2);
});

test('Kane refuses, or crashes before writing: not written, nothing in the store, retry allowed', async () => {
  for (const mode of ['refuse', 'crashBefore']) {
    await reset();
    await setReview(mode);
    await post(`${U}/retrieve`);
    const d = await j(await approve());
    const uc = d.useCases[0];
    assert.equal(uc.review.state, 'approved', `${mode}: the KaneVerity decision stays recorded`);
    assert.equal(uc.kane.state, 'not_written', mode);
    assert.match(uc.kane.reason, /store is unchanged/, mode);
    assert.equal(uc.kaneTrust, 'derived', mode);
    assert.equal(uc.design.eligible, false, mode);
    assert.match(uc.design.reasons.join(' '), /not been recorded in Kane/, mode);
    assert.equal(uc.kane.canWrite, true, `${mode}: can be written again`);
    assert.equal(await storeRecords(), 2, `${mode}: nothing written`);
    assert.equal(d.locked, null, `${mode}: decisions are not locked`);
  }
  await setReview('ok');
  const d = await j(await post(`${ucBase()}/kane-write`));
  assert.equal(d.useCases[0].kane.state, 'verified');
  assert.equal(d.useCases[0].design.eligible, true);
  // Two separate writes for one decision: the refused one and the retry.
  assert.deepEqual(
    d.useCases[0].kaneWrites.map((w: { state: string; steps: { step: string }[] }) => [w.state, w.steps.map((s) => s.step)]),
    [
      ['not_written', ['started', 'kane_running', 'not_written']],
      ['verified', ['started', 'kane_running', 'verified']],
    ],
  );
  assert.equal(new Set(d.useCases[0].kaneWrites.map((w: { decisionId: string }) => w.decisionId)).size, 1, 'both writes belong to the same decision');
});

test('crash after writing: unknown, everything locked, never retried; reconcile settles it from the store', async () => {
  await reset();
  await setReview('crashAfter');
  await post(`${U}/retrieve`);
  const before = (await reviewCalls()).length;
  let d = await j(await approve());
  let uc = d.useCases[0];
  assert.equal(uc.kane.state, 'unknown', uc.kane.reason);
  assert.match(uc.kane.reason, /did not finish normally \(Kane exited with code 1\)\./);
  assert.equal(uc.kane.externalApproval, false, "KaneVerity's own unconfirmed record is not called external");
  assert.equal(uc.kane.canReconcile, true);
  assert.equal(uc.design.eligible, false);
  assert.match(uc.design.reasons.join(' '), /unknown/);
  assert.equal(d.locked.state, 'unknown');
  // Locked: no decisions, no writes.
  for (const r of [await reject(), await approve(), await post(`${ucBase()}/kane-write`)]) {
    assert.equal(r.status, 409);
    assert.match((await j(r)).error, /unknown outcome/);
  }
  assert.equal((await reviewCalls()).length - before, 1, 'the unknown write was not retried');

  await setReview('ok');
  d = await j(await post(`${ucBase()}/reconcile`));
  uc = d.useCases[0];
  assert.equal(uc.kane.state, 'verified', uc.kane.reason);
  assert.equal(uc.kane.via, 'reconcile');
  assert.equal(uc.kaneWrites.length, 1, 'still one write: reconcile adds a step, not a write');
  assert.deepEqual(uc.kaneWrites[0].steps.map((s: { step: string; via: string }) => [s.step, s.via]), [
    ['started', 'write'],
    ['kane_running', 'write'],
    ['unknown', 'write'],
    ['verified', 'reconcile'],
  ]);
  assert.equal(uc.kane.kaneSeq, 3);
  assert.equal(uc.design.eligible, true);
  assert.equal(d.locked, null);
  assert.equal((await reviewCalls()).length - before, 1, 'reconcile only reads the store');
  assert.equal((await post(`${ucBase()}/reconcile`)).status, 409, 'nothing left to reconcile');
});

test('decisions are refused while a write is pending; a write that times out with nothing in the store is not written', async () => {
  await reset();
  await setReview('hang');
  await post(`${U}/retrieve`);
  const pending = approve();
  // Wait until the write is in progress.
  let v = await view();
  for (let i = 0; i < 100 && v.locked?.state !== 'pending'; i++) {
    await new Promise((r) => setTimeout(r, 50));
    v = await view();
  }
  assert.equal(v.locked?.state, 'pending');
  assert.equal(v.useCases[0].kane.state, 'pending');
  for (const r of [await reject(), await post(`${ucBase()}/kane-write`), await post(`${ucBase()}/reconcile`)]) {
    assert.equal(r.status, 409);
    assert.match((await j(r)).error, /being written to Kane/);
  }
  // The running write job cannot be stopped through the generic jobs API.
  let jobs = await j(await fetch(`${api}/api/assurance/jobs?tutorialId=${T}`));
  for (let i = 0; i < 100 && !jobs.some((x: { kind: string; state: string }) => x.kind === 'review' && x.state === 'running'); i++) {
    await new Promise((r) => setTimeout(r, 50));
    jobs = await j(await fetch(`${api}/api/assurance/jobs?tutorialId=${T}`));
  }
  const running = jobs.find((x: { kind: string; state: string }) => x.kind === 'review' && x.state === 'running');
  assert.ok(running, 'the review job is running');
  assert.ok(!JSON.stringify(running).includes('verdicts.json') && !('args' in running), 'the public job shows no arguments or verdict file path');
  const c = await post(`/api/assurance/jobs/${running.jobId}/cancel`);
  assert.equal(c.status, 409);
  assert.match((await j(c)).error, /cannot be cancelled here/);
  const d = await j(await pending);
  assert.equal(d.useCases[0].kane.state, 'not_written', d.useCases[0].kane.reason);
  assert.equal(await storeRecords(), 2);
  assert.equal(d.locked, null);
});

test('after a restart, a pending write becomes unknown; reconcile finds nothing in the store and marks it not written', async () => {
  await reset();
  await setReview('refuse');
  await post(`${U}/retrieve`);
  const d0 = await j(await approve());
  // Simulate the orchestrator stopping mid-write: a pending entry with no live process.
  const log = JSON.parse(await readFile(reviewsFile(), 'utf8'));
  const last = log.kaneWrites[log.kaneWrites.length - 1];
  log.kaneWrites.push({ ...last, writeId: 'w20261122-120000-abcdef', state: 'pending', via: 'write', reason: 'Writing the approval to Kane.', jobId: null, decisionId: d0.useCases[0].review.history[0].id });
  await writeFile(reviewsFile(), JSON.stringify(log));
  const { AssuranceUseCases } = await import('../src/assurance/usecases.ts');
  const { AssuranceJobs } = await import('../src/assurance/jobs.ts');
  const { RequirementsService } = await import('../src/assurance/service.ts');
  await new AssuranceUseCases(new AssuranceJobs(), new RequirementsService()).init();
  const after = JSON.parse(await readFile(reviewsFile(), 'utf8'));
  const e = after.kaneWrites[after.kaneWrites.length - 1];
  assert.equal(e.state, 'unknown');
  assert.equal(e.via, 'startup');
  let v = await view();
  assert.equal(v.locked.state, 'unknown');
  assert.equal((await reject()).status, 409);
  await setReview('ok');
  v = await j(await post(`${ucBase()}/reconcile`));
  assert.equal(v.useCases[0].kane.state, 'not_written', v.useCases[0].kane.reason);
  assert.equal(v.locked, null);
});

test('an approval made in Kane outside KaneVerity is never accepted and not written over', async () => {
  await reset();
  await setReview('ok');
  await appendRecord({ review: [{ id: UC, kind: 'review-item', resolution: 'approved', edit: null, reason: null, by: { kind: 'human', id: 'operator' } }], intent_verb: 'review' });
  await post(`${U}/retrieve`);
  let uc = (await view()).useCases[0];
  assert.equal(uc.kaneTrust, 'trusted');
  assert.equal(uc.kane.externalApproval, true);
  assert.equal(uc.review.state, 'awaiting_review');
  const before = (await reviewCalls()).length;
  const d = await j(await approve());
  uc = d.useCases[0];
  assert.equal(uc.review.state, 'approved');
  assert.match(d.note, /not through an approval KaneVerity wrote and verified/);
  assert.equal(uc.design.eligible, false);
  assert.match(uc.design.reasons.join(' '), /not made and verified through KaneVerity/);
  assert.equal((await reviewCalls()).length, before, 'nothing written');
});

test('rejection after a verified approval stays in KaneVerity (no archive); re-approving relies on the same verified Kane record', async () => {
  await reset();
  await setReview('ok');
  await post(`${U}/retrieve`);
  assert.equal((await j(await approve())).useCases[0].kane.state, 'verified');
  const before = await calls();
  let d = await j(await reject());
  let uc = d.useCases[0];
  assert.equal(uc.review.state, 'rejected');
  assert.equal(uc.kane.trustedButRejected, true);
  assert.match(d.note, /never archives it/);
  assert.equal(uc.design.eligible, false);
  assert.match(uc.design.reasons.join(' '), /rejected/);
  const during = (await calls()).slice(before.length);
  assert.equal(during.filter((c) => c.argv[1] === 'review').length, 0, 'a rejection never reaches Kane');
  assert.equal(await storeRecords(), 3);

  d = await j(await approve());
  uc = d.useCases[0];
  assert.equal(uc.kane.state, 'verified', uc.kane.reason);
  assert.equal(uc.kane.via, 'reuse');
  assert.equal(uc.kane.kaneSeq, 3);
  assert.equal(uc.design.eligible, true);
  assert.equal(await storeRecords(), 3, 'no new Kane record');
  assert.deepEqual(uc.review.history.map((h: { decision: string }) => h.decision), ['approved', 'rejected', 'approved'], 'the full history is kept');
});

test('a missing or invalid reviewer setting blocks approval; nothing is recorded or written', async () => {
  await reset();
  await setReview('ok');
  await post(`${U}/retrieve`);
  const before = (await reviewCalls()).length;
  for (const value of [undefined, '', 'me@example.org', 'two words', 'x'.repeat(41)]) {
    if (value === undefined) delete process.env.KANEVERITY_REVIEWER;
    else process.env.KANEVERITY_REVIEWER = value;
    const r = await approve();
    assert.equal(r.status, 409, String(value));
    assert.match((await j(r)).error, /KANEVERITY_REVIEWER/);
    const v = await view();
    assert.equal(v.reviewer.label, null);
    assert.ok(v.reviewer.problem);
    assert.equal(v.useCases[0].review.state, 'awaiting_review');
  }
  // A rejection is still possible (it never reaches Kane).
  assert.equal((await j(await reject())).useCases[0].review.state, 'rejected');
  process.env.KANEVERITY_REVIEWER = REVIEWER;
  assert.equal((await reviewCalls()).length, before);
});

test('unknown structures in Kane review records fail the integrity check; nothing can be approved', async () => {
  for (const item of [
    { id: UC, kind: 'mystery', resolution: 'approved', by: { kind: 'human', id: 'x' } },
    { id: UC, kind: 'review-item', resolution: 'blessed', by: { kind: 'human', id: 'x' } },
    { id: UC, kind: 'review-item', resolution: 'approved', by: 'human:x' },
    { id: UC, kind: 'review-item', resolution: 'approved', by: { kind: 'human', id: 'x' }, extra: true },
  ]) {
    await reset();
    await appendRecord({ review: [item] });
    const d = await j(await post(`${U}/retrieve`));
    assert.equal(d.snapshot.integrity.ok, false, JSON.stringify(item));
    assert.match(d.snapshot.integrity.problems.join(' '), /review entry in an unexpected shape/);
    assert.equal((await approve()).status, 409);
  }
});

test('a write that does not match exactly is "written but not verified", never verified, never written again', async () => {
  for (const [mode, re] of [
    ['byOverride', /recorded it as "human:operator", not "human:kaneverity:test-reviewer"/],
    ['extraItem', /more than this one approval/],
    ['notReviewOnly', /more than this one approval/],
    ['badOutput', /output did not confirm/],
  ] as [string, RegExp][]) {
    await reset();
    await setReview(mode);
    await post(`${U}/retrieve`);
    const uc = (await j(await approve())).useCases[0];
    assert.equal(uc.kane.state, 'written_unverified', `${mode}: ${uc.kane.reason}`);
    assert.match(uc.kane.reason, re, mode);
    assert.equal(uc.design.eligible, false, mode);
    assert.match(uc.design.reasons.join(' '), /could not verify/, mode);
    const r = await post(`${ucBase()}/kane-write`);
    assert.equal(r.status, 409, mode);
  }
});

test('a write is refused when the store tip or the requirements changed since the decision', async () => {
  // Store tip moved.
  await reset();
  await setReview('refuse');
  await post(`${U}/retrieve`);
  await approve();
  await setReview('ok');
  await appendRecord({ intent_verb: 'ingest' });
  let r = await post(`${ucBase()}/kane-write`);
  assert.equal(r.status, 409);
  assert.match((await j(r)).error, /store changed since your decision/);

  // Requirements changed after the decision.
  await reset();
  await setReview('refuse');
  await post(`${U}/retrieve`);
  await approve();
  await setReview('ok');
  const file = path.join(contentDir, 'tutorials', 'generate-an-api-key.md');
  const original = await readFile(file, 'utf8');
  await writeFile(file, original.replace('3. Click **Create API Key**.', '3. Click **Make Key**.'));
  await post('/api/discover');
  await post(`/api/assurance/requirements/${T}`);
  r = await post(`${ucBase()}/kane-write`);
  assert.equal(r.status, 409);
  assert.match((await j(r)).error, /requirements version changed or is no longer current/);
  await writeFile(file, original);
  await post('/api/discover');
  await post(`/api/assurance/requirements/${T}`);
});

test('a decided use case whose content id is gone cannot be written', async () => {
  await reset();
  await setReview('refuse');
  await post(`${U}/retrieve`);
  await approve();
  await setReview('ok');
  // Keep the decision log and retrievals; Kane now holds a different version of the use case
  // (new content id) with the same store tip and source.
  await reset({ uc: UC_OTHER, keepHistory: true });
  const before = (await reviewCalls()).length;
  const r = await post(`${ucBase()}/kane-write`);
  assert.equal(r.status, 409);
  const err = (await j(r)).error;
  assert.match(err, /this exact use-case version \(content id\) is no longer in Kane/);
  assert.doesNotMatch(err, /store changed|source version|requirements/, 'only the content id changed');
  assert.equal((await reviewCalls()).length, before, 'nothing written');
});

test('with Assurance switched off, an approval is recorded but not written; it can be written later', async () => {
  const { config } = await import('../src/config.ts');
  await reset();
  await setReview('ok');
  await post(`${U}/retrieve`);
  config.assurance.mode = 'off';
  try {
    const d = await j(await approve());
    const uc = d.useCases[0];
    assert.equal(uc.review.state, 'approved');
    assert.equal(uc.kane.state, 'none');
    assert.equal(uc.kane.canWrite, false);
    assert.match(d.note, /switched off/);
    assert.equal(uc.design.eligible, false);
    assert.equal((await post(`${ucBase()}/kane-write`)).status, 403);
  } finally {
    config.assurance.mode = 'free';
  }
  const d = await j(await post(`${ucBase()}/kane-write`));
  assert.equal(d.useCases[0].kane.state, 'verified');
});

test('bypass flags are never passed to Kane, and the review job cannot be started from the jobs API', async () => {
  const { buildArgs, FORBIDDEN_FLAGS, JOB_KINDS } = await import('../src/assurance/commands.ts');
  assert.deepEqual([...FORBIDDEN_FLAGS], FORBIDDEN);
  // Every Kane invocation in this file.
  for (const c of await calls()) for (const f of FORBIDDEN) assert.ok(!c.argv.includes(f), `${f} in ${c.argv.join(' ')}`);
  // Every job kind's argument list.
  const samples = [
    { kind: 'ingest', tutorialId: T },
    { kind: 'extract', tutorialId: T },
    { kind: 'design', tutorialId: T, ucCid: UC, useCase: 'uc-generate-an-api-key', max: 2, reviewer: REVIEWER, decisionId: 'd20261124-000000-aaaaaa', acknowledgedPrevious: null },
    { kind: 'resume', verb: 'design', sid: 'des-1', answers: [{ id: 'q1', value: '1' }] },
    { kind: 'list', inferred: true },
    { kind: 'cover' },
    { kind: 'view' },
    { kind: 'fsck' },
    { kind: 'review', tutorialId: T, writeId: 'w20261122-120000-abcdef', ucCid: UC, reviewer: REVIEWER },
  ];
  assert.deepEqual(samples.map((s) => s.kind).sort(), Object.keys(JOB_KINDS).sort(), 'every kind is checked');
  for (const s of samples) {
    const args = buildArgs(s as Parameters<typeof buildArgs>[0]);
    for (const f of FORBIDDEN) assert.ok(!args.includes(f), `${s.kind}: ${f}`);
  }
  // The flags appear in the source only in the refusal list.
  const src = path.join(TESTS_DIR, '..', 'src');
  const files: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(path.join(d, e.name));
      else if (e.name.endsWith('.ts')) files.push(path.join(d, e.name));
    }
  };
  await walk(src);
  files.push(path.join(TESTS_DIR, '..', 'server.ts'));
  for (const f of files) {
    const text = await readFile(f, 'utf8');
    for (const flag of ['--allow-unreviewed', '--allow-archive']) {
      const hits = text.split(flag).length - 1;
      if (f.endsWith(path.join('assurance', 'commands.ts'))) assert.equal(hits, 1, `${flag} only in FORBIDDEN_FLAGS`);
      else assert.equal(hits, 0, `${flag} in ${path.basename(f)}`);
    }
  }
  // Internal kind: not startable through the generic jobs API, not listed as a job kind.
  const r = await post('/api/assurance/jobs', { kind: 'review', tutorialId: T });
  assert.equal(r.status, 400);
  const st = await j(await fetch(`${api}/api/assurance/status`));
  assert.ok(!st.kinds.some((k: { kind: string }) => k.kind === 'review'));
});

test('a damaged review history fails closed: nothing is shown as unreviewed or unlocked, and nothing overwrites it', async () => {
  await reset();
  await setReview('ok');
  await post(`${U}/retrieve`);
  assert.equal((await j(await approve())).useCases[0].kane.state, 'verified');
  const good = await readFile(reviewsFile(), 'utf8');
  for (const bad of ['{"tutorialId": "generate-an-api-key", "decisions": [', JSON.stringify({ tutorialId: T, decisions: 'x' }), JSON.stringify({ tutorialId: 'other-tutorial', decisions: [] }), JSON.stringify({ tutorialId: T, decisions: [], kaneWrites: {} }), 'null']) {
    await writeFile(reviewsFile(), bad);
    const before = (await reviewCalls()).length;
    for (const r of [await fetch(api + U), await reject(), await approve(), await post(`${ucBase()}/kane-write`), await post(`${ucBase()}/reconcile`)]) {
      assert.equal(r.status, 500, bad.slice(0, 40));
      assert.match((await j(r)).error, /review history for this tutorial cannot be read/);
    }
    assert.equal(await readFile(reviewsFile(), 'utf8'), bad, 'the damaged file was not rewritten');
    assert.equal((await reviewCalls()).length, before, 'nothing was written to Kane');
  }
  await writeFile(reviewsFile(), good);
  assert.equal((await view()).useCases[0].kane.state, 'verified');
});

test('reconcile with Assurance switched off is refused and records nothing; the write stays unknown and locked', async () => {
  const { config } = await import('../src/config.ts');
  await reset();
  await setReview('crashAfter');
  await post(`${U}/retrieve`);
  assert.equal((await j(await approve())).useCases[0].kane.state, 'unknown');
  const logBefore = await readFile(reviewsFile(), 'utf8');
  config.assurance.mode = 'off';
  try {
    const r = await post(`${ucBase()}/reconcile`);
    assert.equal(r.status, 403);
    assert.match((await j(r)).error, /switched off/);
    assert.equal(await readFile(reviewsFile(), 'utf8'), logBefore, 'nothing recorded');
    assert.equal((await view()).locked.state, 'unknown');
  } finally {
    config.assurance.mode = 'free';
  }
  assert.equal((await j(await post(`${ucBase()}/reconcile`))).useCases[0].kane.state, 'verified');
});

test('the log only ever grows: every earlier entry is kept exactly through a full lifecycle', async () => {
  await reset();
  await setReview('crashAfter');
  await post(`${U}/retrieve`);
  const snapshots: { decisions: unknown[]; kaneWrites: unknown[] }[] = [];
  const take = async () => snapshots.push(JSON.parse(await readFile(reviewsFile(), 'utf8')));
  await approve();
  await take();
  await setReview('ok');
  await post(`${ucBase()}/reconcile`);
  await take();
  await reject();
  await take();
  await approve();
  await take();
  for (let i = 1; i < snapshots.length; i++) {
    const [a, b] = [snapshots[i - 1], snapshots[i]];
    assert.deepEqual(b.decisions.slice(0, a.decisions.length), a.decisions, `decisions kept at step ${i}`);
    assert.deepEqual(b.kaneWrites.slice(0, a.kaneWrites.length), a.kaneWrites, `writes kept at step ${i}`);
    assert.ok(b.decisions.length + b.kaneWrites.length > a.decisions.length + a.kaneWrites.length, `grew at step ${i}`);
  }
});

test("one use case's verified approval never satisfies the design gate for another content id", async () => {
  await reset();
  await setReview('ok');
  const lines = reqMd.split('\n');
  const o1 = lineOf('O1');
  // A second use case from the same source.
  await appendRecord({
    nodes: [{ cid: UC_OTHER, label: 'usecase', content: { title: 'Another use case', description: 'Other.', summary: '', actors: [], value: '', risk: 'low', criteria: [] } }],
    edges: [{ type: 'DERIVES', src: SRC, dst: UC_OTHER, props: { source_id: 'kv-generate-an-api-key', source_cid: SRC, anchor: `L${o1}-L${o1}`, quote: lines[o1 - 1] } }],
    intent_verb: 'extract',
  });
  let d = await j(await post(`${U}/retrieve`));
  assert.equal(d.snapshot.integrity.ok, true, d.snapshot.integrity.problems.join(' '));
  assert.equal(d.useCases.length, 2);
  d = await j(await approve(UC));
  const byCid = (cid: string) => d.useCases.find((u: { cid: string }) => u.cid === cid);
  assert.equal(byCid(UC).kane.state, 'verified');
  assert.equal(byCid(UC).design.eligible, true);
  const other = byCid(UC_OTHER);
  assert.equal(other.review.state, 'awaiting_review');
  assert.equal(other.kane.state, 'none');
  assert.deepEqual(other.kaneWrites, []);
  assert.equal(other.kaneTrust, 'derived');
  assert.equal(other.design.eligible, false);
  // Approving the other one writes and verifies its own record; nothing is shared.
  d = await j(await approve(UC_OTHER));
  const o = d.useCases.find((u: { cid: string }) => u.cid === UC_OTHER);
  assert.equal(o.kane.state, 'verified', o.kane.reason);
  assert.notEqual(o.kane.kaneSeq, d.useCases.find((u: { cid: string }) => u.cid === UC).kane.kaneSeq);
  assert.notEqual(o.kane.decisionId, d.useCases.find((u: { cid: string }) => u.cid === UC).kane.decisionId);
});
