// V2 safety: test design only through the use-case endpoint, for the latest KaneVerity
// approval verified in Kane, with fresh checks, explicit paid confirmation, pause handling
// without automatic answers, and no silent retries. The fake Kane CLI computes the store
// reads from real files (dynamic mode) and replays scripted design streams in Kane's
// documented event format. No real Kane process runs.

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
const REVIEWER = 'design-reviewer';
const PAID = { confirm: { paid: true } };
const FORBIDDEN = ['--allow-unreviewed', '--allow-archive', '--force'];
const listen = (s: Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const j = async (r: Response): Promise<any> => r.json();
const H = { 'Content-Type': 'application/json', 'X-KaneVerity': '1' };
const post = (p: string, body: unknown = {}) => fetch(api + p, { method: 'POST', headers: H, body: JSON.stringify(body) });
const U = `/api/assurance/usecases/${T}`;
const ucBase = (cid = UC) => `${U}/${cid.slice(7)}`;
const approve = (cid = UC) => post(`${ucBase(cid)}/review`, { decision: 'approve', acknowledgeGaps: true, reason: 'Approved for the design tests.' });
const reject = (cid = UC) => post(`${ucBase(cid)}/review`, { decision: 'reject', reason: 'Not this version.' });
const design = (body: unknown = PAID, cid = UC) => post(`${ucBase(cid)}/design`, body);
const view = async () => j(await fetch(api + U));
const reviewsFile = () => path.join(work, 'data', 'assurance', 'reviews', `${T}.json`);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// Design streams in the documented envelope ({"type", "v": 1, "verb": "design"}).
const env = (o: Record<string, unknown>) => JSON.stringify({ v: 1, verb: 'design', ...o });
const DESIGN_OK = [env({ type: 'run_start', mode: 'agent' }), env({ type: 'agent_activity', kind: 'decision', label: 'grounding the use case' }), env({ type: 'usage', credits: 1.25, total_credits: 1.25 }), env({ type: 'commit', derived: 3, minted: [{ cid: 'sha256:' + 'a1'.repeat(32), logical_id: 'ac-uc-1-1' }] }), env({ type: 'done', status: 'complete', exit_code: 0 })];
const SID = 'des-20261124T120000-uc-1';
const future = () => new Date(Date.now() + 3600_000).toISOString();
const DESIGN_PAUSE = () => [env({ type: 'run_start', mode: 'agent' }), env({ type: 'usage', credits: 0.5, total_credits: 0.5 }), env({ type: 'session_paused', sid: SID, resume: `kane-cli design tests --resume ${SID} --mode agent`, expires_at: future(), pending_questions: [{ id: 'q1', text: 'How many keys should the list show?', risk: 'low', rationale: 'The outcome names 2 keys.', options: [{ label: 'Two', detail: '...' }, { label: 'Any', detail: '...' }], recommended_index: 0, allow_free_text: false }] }), env({ type: 'done', status: 'paused', exit_code: 3 })];
const DESIGN_ERROR = [env({ type: 'run_start', mode: 'agent' }), env({ type: 'error', code: 'DESIGN_FAILED', message: 'the agent could not complete the design' }), env({ type: 'done', status: 'error', exit_code: 1 })];

let reqMd = '';
let lineOf: (item: string) => number;
const criteria = ["Start at {{app_url}}/ in a fresh browser session, then select 'Developer Settings', 'API Keys', and 'Generate Key' in that order.", "The message 'API key generated successfully.' appears after generating the key.", 'The new key is added to the API keys list.', "The key count below the list shows '2 keys'."];

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
  await writeFile(path.join(storeDir, 'meta.json'), JSON.stringify({ schema: 'assurance/context@1', canonicalizer: 'v1' }));
  await writeFile(path.join(storeDir, 'blobs', BLOB.slice(7, 9), BLOB.slice(9)), reqMd);
  await writeFile(path.join(storeDir, 'commits', `000001-${H1.slice(0, 12)}.json`), JSON.stringify({ seq: 1, prev_hash: null, nodes: [{ cid: SRC, label: 'source', content: { source_id: 'kv-generate-an-api-key', blob: BLOB } }], edges: [], review: [], schema_version: 'assurance/context@1', created_by: { build: '0.10.5' }, proposal_id: null }));
  await writeFile(
    path.join(storeDir, 'commits', `000002-${H2.slice(0, 12)}.json`),
    JSON.stringify({ seq: 2, prev_hash: `sha256:${H1}`, proposal_id: '20261122T150616-kv-generate-an-api-key', nodes: [{ cid: uc, label: 'usecase', content: { title: 'Generate an API key', description: "Open 'Developer Settings', then 'API Keys', then 'Generate Key'.", summary: 'Generate a key.', actors: ['application user'], value: 'Create a key.', risk: 'high', criteria } }], edges, review: [], schema_version: 'assurance/context@1', created_by: { build: '0.10.5', by: { kind: 'human', id: 'owner' } } }),
  );
  await writeFile(path.join(storeDir, 'fake-hashes.json'), JSON.stringify({ '1': `sha256:${H1}`, '2': `sha256:${H2}` }));
  // Earlier design jobs from other tests must not count for this store's use case.
  await rm(path.join(work, 'data', 'assurance', 'jobs'), { recursive: true, force: true });
}

async function appendRecord(rec: Record<string, unknown>) {
  const hashes = JSON.parse(await readFile(path.join(storeDir, 'fake-hashes.json'), 'utf8'));
  const seq = (await readdir(path.join(storeDir, 'commits'))).length + 1;
  const body = JSON.stringify({ seq, prev_hash: hashes[String(seq - 1)], proposal_id: null, nodes: [], edges: [], review: [], supersessions: [], schema_version: 'assurance/context@1', parents: [hashes[String(seq - 1)]], created_by: { build: '0.10.5', by: { kind: 'human', id: 'operator' } }, ...rec });
  const hex = sha(body);
  await writeFile(path.join(storeDir, 'commits', `${String(seq).padStart(6, '0')}-${hex.slice(0, 12)}.json`), body);
  hashes[String(seq)] = `sha256:${hex}`;
  await writeFile(path.join(storeDir, 'fake-hashes.json'), JSON.stringify(hashes));
}

/** Script the fake: dynamic store reads, an approval write, and the design replies. */
const setScript = (designReply: Record<string, unknown> = { stdout: DESIGN_OK, exit: 0 }, extra: Record<string, unknown> = {}) => writeFile(scriptFile, JSON.stringify({ dynamic: true, review: { mode: 'ok' }, 'design tests': designReply, ...extra }));
const calls = async () => (await readFile(logFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; env: { USER: string | null } });
const designCalls = async () => (await calls()).filter((c) => c.argv[0] === 'design');

async function waitJob(id: string) {
  for (let i = 0; i < 300; i++) {
    const job = await j(await fetch(`${api}/api/assurance/jobs/${id}`));
    if (job.state !== 'queued' && job.state !== 'running') return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('job did not settle');
}

/** A store with uc approved in KaneVerity and that approval verified in Kane. */
async function approvedAndVerified() {
  await reset();
  await setScript();
  await post(`${U}/retrieve`);
  const d = await j(await approve());
  assert.equal(d.useCases[0].kane.state, 'verified', d.useCases[0].kane.reason);
  assert.equal(d.useCases[0].design.eligible, true);
}

before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), 'kv-design-'));
  scriptFile = path.join(work, 'script.json');
  logFile = path.join(work, 'invocations.ndjson');
  contentDir = await outdatedDocsContent();
  docs = createDocsServer(contentDir);
  const docsUrl = (await listen(docs)) + '/';
  app = createServer((_q, s) => s.end('<!doctype html><title>AcmeDesk</title>'));
  const appUrl = (await listen(app)) + '/';
  Object.assign(process.env, {
    KANEVERITY_DATA_DIR: path.join(work, 'data'),
    KANEVERITY_ASSURANCE_MODE: 'all',
    KANEVERITY_ASSURANCE_TIMEOUT_MS: '20000',
    KANEVERITY_REVIEWER: REVIEWER,
    KANE_CLI_ENTRY: path.join(TESTS_DIR, 'fake-kane-assurance.cjs'),
    KANEVERITY_DOCS_CONTENT_DIR: contentDir,
    KANEVERITY_ALLOWED_DOCS_ORIGINS: new URL(docsUrl).origin,
    KANEVERITY_ALLOWED_APP_ORIGINS: new URL(appUrl).origin,
    FAKE_ASSURANCE_LOG: logFile,
    FAKE_ASSURANCE_SCRIPT: scriptFile,
    FAKE_ASSURANCE_BALANCE: '[1000, 998.75]',
  });
  delete process.env.USER;
  storeDir = path.join(work, 'data', 'assurance', 'workspace', '.context');
  await setScript();
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

test('design is not reachable through the generic jobs API', async () => {
  for (const body of [{ kind: 'design', useCase: 'uc-1', max: 1, ...PAID }, { kind: 'design', tutorialId: T, ucCid: UC, useCase: 'uc-1', max: 1, reviewer: REVIEWER, ...PAID }]) {
    const r = await post('/api/assurance/jobs', body);
    assert.equal(r.status, 400);
    assert.match((await j(r)).error, /Unknown job kind/);
  }
  const st = await j(await fetch(`${api}/api/assurance/status`));
  assert.ok(!st.kinds.some((k: { kind: string }) => k.kind === 'design' || k.kind === 'review'));
  assert.deepEqual(await designCalls(), []);
});

test('refused before any Kane read: no reviewer, wrong mode, no paid confirmation, bad max', async () => {
  const { config } = await import('../src/config.ts');
  await approvedAndVerified();
  const reads = async () => (await calls()).length;
  const n = await reads();
  let r = await design({});
  assert.equal(r.status, 400);
  assert.match((await j(r)).error, /uses Kane credits/);
  for (const max of [0, 9, 1.5, '1']) assert.equal((await design({ ...PAID, max })).status, 400, String(max));
  config.assurance.mode = 'free';
  try {
    r = await design();
    assert.equal(r.status, 403);
    assert.match((await j(r)).error, /needs Assurance mode "all"/);
  } finally {
    config.assurance.mode = 'all';
  }
  delete process.env.KANEVERITY_REVIEWER;
  try {
    r = await design();
    assert.equal(r.status, 409);
    assert.match((await j(r)).error, /KANEVERITY_REVIEWER/);
  } finally {
    process.env.KANEVERITY_REVIEWER = REVIEWER;
  }
  assert.equal(await reads(), n, 'no Kane command ran for any refused request');
});

test('only an approved use case whose approval is verified in Kane can be designed', async () => {
  // Awaiting review.
  await reset();
  await setScript();
  await post(`${U}/retrieve`);
  let r = await design();
  assert.equal(r.status, 409);
  assert.match((await j(r)).error, /Not started: It has not been reviewed in KaneVerity/);
  // Approved, but the Kane write did not happen.
  await setScript(undefined, { review: { mode: 'refuse' } });
  assert.equal((await j(await approve())).useCases[0].kane.state, 'not_written');
  r = await design();
  assert.equal(r.status, 409);
  assert.match((await j(r)).error, /not been recorded in Kane/);
  // Rejected after a verified approval.
  await approvedAndVerified();
  await reject();
  r = await design();
  assert.equal(r.status, 409);
  assert.match((await j(r)).error, /rejected in KaneVerity review/);
  assert.deepEqual(await designCalls(), [], 'Kane design never ran');
});

test('an approval made in Kane outside KaneVerity never qualifies', async () => {
  await reset();
  await setScript();
  await appendRecord({ review: [{ id: UC, kind: 'review-item', resolution: 'approved', edit: null, reason: null, by: { kind: 'human', id: 'operator' } }], intent_verb: 'review' });
  await post(`${U}/retrieve`);
  await approve();
  const r = await design();
  assert.equal(r.status, 409);
  assert.match((await j(r)).error, /not been recorded in Kane|not made and verified through KaneVerity/);
  assert.deepEqual(await designCalls(), []);
});

test('the fresh read must still show the approved content id; a replaced use case is refused', async () => {
  await approvedAndVerified();
  // Kane now holds another version of the use case under the same logical id.
  await reset({ uc: UC_OTHER, keepHistory: true });
  const before = (await calls()).length;
  const r = await design();
  assert.equal(r.status, 409);
  assert.match((await j(r)).error, /this exact use-case version \(content id\) is not in Kane's store/);
  const after = (await calls()).slice(before).map((c) => c.argv.slice(0, 2).join(' '));
  assert.deepEqual(after, ['context fsck', 'context list', 'context view'], 'only the fresh free reads ran');
});

test('stale requirements block design', async () => {
  await approvedAndVerified();
  const file = path.join(contentDir, 'tutorials', 'generate-an-api-key.md');
  const original = await readFile(file, 'utf8');
  await writeFile(file, original.replace('3. Click **Create API Key**.', '3. Click **Make Key**.'));
  await post('/api/discover');
  await post(`/api/assurance/requirements/${T}`);
  try {
    const r = await design();
    assert.equal(r.status, 409);
    assert.match((await j(r)).error, /no longer the current version/);
    assert.deepEqual(await designCalls(), []);
  } finally {
    await writeFile(file, original);
    await post('/api/discover');
    await post(`/api/assurance/requirements/${T}`);
  }
});

test('a design: fresh checks, then the exact command with USER, bound to the tutorial and content id; cost recorded; no second design', async () => {
  await approvedAndVerified();
  const before = (await calls()).length;
  const r = await design();
  assert.equal(r.status, 202);
  const started = await j(r);
  assert.equal(started.kind, 'design');
  assert.equal(started.tutorialId, T);
  assert.equal(started.params.ucCid, UC);
  assert.equal(started.params.useCase, 'uc-1');
  assert.equal(started.params.max, 1);
  assert.equal(started.params.reviewer, REVIEWER);
  assert.match(started.params.decisionId, /^d[0-9]{8}-[0-9]{6}-[a-f0-9]{6}$/);
  const done = await waitJob(started.jobId);
  assert.equal(done.state, 'complete', done.reason);
  assert.equal(done.credits.amount, 1.25);
  assert.equal(done.credits.basis, 'reported');

  const seq = (await calls()).slice(before);
  const kinds = seq.map((c) => c.argv.slice(0, 2).join(' '));
  const at = kinds.indexOf('design tests');
  assert.deepEqual(kinds.slice(0, 3), ['context fsck', 'context list', 'context view'], 'a fresh store read first');
  assert.ok(at > 2);
  assert.deepEqual(seq[at].argv, ['design', 'tests', '--use-case', 'uc-1', '--mode', 'agent', '--max', '1']);
  assert.equal(seq[at].env.USER, `kaneverity:${REVIEWER}`);
  for (const c of seq) for (const f of FORBIDDEN) assert.ok(!c.argv.includes(f), `${f} in ${c.argv.join(' ')}`);

  const ledger = JSON.parse(await readFile(path.join(work, 'data', 'credits.json'), 'utf8'));
  const entries = Array.isArray(ledger) ? ledger : ledger.entries;
  assert.ok(entries.some((e: { kind?: string; credits: number; basis?: string }) => e.kind === 'assurance:design' && e.credits === 1.25 && e.basis === 'reported'));

  const uc = (await view()).useCases[0];
  assert.equal(uc.testDesign.latestJob.state, 'complete');
  assert.equal(uc.testDesign.canStart, false);
  assert.match(uc.testDesign.blockedBy, /already has a test design/);
  const again = await design();
  assert.equal(again.status, 409);
  assert.match((await j(again)).error, /already has a test design.*needs an acknowledged forced redesign/);
  assert.equal((await designCalls()).length, 1);
});

test('B5 redesign exception: only an acknowledged --force --phase acs|scenarios over a complete design; paid gates unchanged', async () => {
  const { redesignAcknowledgement, buildArgs } = await import('../src/assurance/commands.ts');
  const { config } = await import('../src/config.ts');
  await approvedAndVerified();
  const words = (phase: 'acs' | 'scenarios') => redesignAcknowledgement(UC, phase);
  // Nothing to replace yet: a redesign is refused before any Kane command.
  let before = (await designCalls()).length;
  let r = await design({ ...PAID, redesign: { phase: 'acs', acknowledgement: words('acs') } });
  assert.equal(r.status, 409);
  assert.match((await j(r)).error, /needs a complete test design of this use case to replace/);
  // A first, ordinary design.
  const first = await j(await design());
  assert.equal((await waitJob(first.jobId)).state, 'complete');
  assert.equal((await designCalls()).length, before + 1);
  before = (await designCalls()).length;
  // Refused, at no cost: a phase outside the exception, a missing or altered acknowledgement, no paid confirmation, mode free.
  for (const [body, status, msg] of [
    [{ ...PAID, redesign: { phase: 'tests', acknowledgement: words('acs') } }, 400, /must be "acs" or "scenarios"/],
    [{ ...PAID, redesign: { phase: 'grounding', acknowledgement: words('acs') } }, 400, /must be "acs" or "scenarios"/],
    [{ ...PAID, redesign: { phase: 'acs' } }, 400, /exact acknowledgement/],
    [{ ...PAID, redesign: { phase: 'acs', acknowledgement: words('scenarios') } }, 400, /exact acknowledgement/],
    [{ ...PAID, redesign: { phase: 'acs', acknowledgement: words('acs') + ' ' } }, 400, /exact acknowledgement/],
    [{ redesign: { phase: 'acs', acknowledgement: words('acs') } }, 400, /uses Kane credits/],
  ] as const) {
    r = await design(body);
    assert.equal(r.status, status, JSON.stringify(body));
    assert.match((await j(r)).error, msg);
  }
  config.assurance.mode = 'free';
  try {
    r = await design({ ...PAID, redesign: { phase: 'acs', acknowledgement: words('acs') } });
    assert.equal(r.status, 403);
  } finally {
    config.assurance.mode = 'all';
  }
  assert.equal((await designCalls()).length, before, 'no Kane design command for any refused request');
  // The acknowledged redesign: exactly "--force --phase acs" at the end, nothing else forbidden.
  r = await design({ ...PAID, max: 3, redesign: { phase: 'acs', acknowledgement: words('acs') } });
  assert.equal(r.status, 202, JSON.stringify(await r.clone().json()));
  const job = await j(r);
  assert.deepEqual(job.params.redesign, { phase: 'acs', acknowledgement: words('acs') });
  assert.equal((await waitJob(job.jobId)).state, 'complete');
  const argv = (await designCalls()).pop()!.argv;
  assert.deepEqual(argv, ['design', 'tests', '--use-case', 'uc-1', '--mode', 'agent', '--max', '3', '--force', '--phase', 'acs']);
  for (const f of ['--allow-unreviewed', '--allow-archive']) assert.ok(!argv.includes(f), f);
  // buildArgs itself refuses --force without the exact acknowledgement, or for any other kind.
  const p = { kind: 'design' as const, tutorialId: T, ucCid: UC, useCase: 'uc-1', max: 3, reviewer: REVIEWER, decisionId: 'd20261125-000000-aaaaaa', acknowledgedPrevious: null };
  assert.throws(() => buildArgs({ ...p, redesign: { phase: 'acs', acknowledgement: 'yes' } }), /never passes --force/);
  assert.throws(() => buildArgs({ ...p, redesign: { phase: 'tests' as 'acs', acknowledgement: words('acs') } }), /acs or scenarios/);
  assert.deepEqual(buildArgs({ ...p, redesign: { phase: 'scenarios', acknowledgement: words('scenarios') } }).slice(-3), ['--force', '--phase', 'scenarios']);
  assert.ok(!buildArgs(p).includes('--force'), 'an ordinary design never gets --force');
});

test('a redesign after a failed, interrupted or expired attempt is refused: an incomplete or unknown outcome needs a separate recovery decision', async () => {
  const { redesignAcknowledgement } = await import('../src/assurance/commands.ts');
  const { AssuranceJobs } = await import('../src/assurance/jobs.ts');
  await approvedAndVerified();
  const REDESIGN = { ...PAID, max: 3, redesign: { phase: 'acs', acknowledgement: redesignAcknowledgement(UC, 'acs') } };
  const decisionId = (await view()).useCases[0].review.history[0].id;
  const first = await j(await design());
  assert.equal((await waitJob(first.jobId)).state, 'complete');
  const refusedLike = async (jobId: string, state: string) => {
    const before = (await designCalls()).length;
    for (const body of [REDESIGN, { ...REDESIGN, acknowledgePrevious: jobId }]) {
      const r = await design(body);
      assert.equal(r.status, 409);
      const error = (await j(r)).error as string;
      assert.ok(error.includes(`(job ${jobId}, ${state}) ended with an incomplete or unknown outcome`), error);
      assert.match(error, /Kane may hold part of a design/);
      assert.match(error, /recovering needs a separate, recorded decision/);
      assert.match(error, /Nothing was started and no credits were used/);
      assert.doesNotMatch(error, /there is none/, 'a design exists; only the last attempt is unknown');
    }
    assert.equal((await designCalls()).length, before, 'no Kane design command, nothing retried');
  };
  // A design job record as the job runner writes it, newer than the complete design.
  const writeJob = async (id: string, minutes: number, state: string, pause: unknown) => {
    const dir = path.join(work, 'data', 'assurance', 'jobs', id);
    await mkdir(path.join(dir, 'private'), { recursive: true });
    const at = new Date(Date.now() + minutes * 60_000).toISOString();
    await writeFile(path.join(dir, 'job.json'), JSON.stringify({ jobId: id, kind: 'design', params: { kind: 'design', tutorialId: T, ucCid: UC, useCase: 'uc-1', max: 3, reviewer: REVIEWER, decisionId, acknowledgedPrevious: null, redesign: REDESIGN.redesign }, tutorialId: T, state, reason: 'Kane is running.', createdAt: at, startedAt: at, finishedAt: null, args: [], exitCode: null, cliVersion: '0.10.5', verb: 'design', doneStatus: null, next: [], pause, parentJobId: null, resumedBy: null, requirements: null, credits: { amount: null, basis: null, reportedTotal: null, measured: null, balanceBefore: null, balanceAfter: null }, summary: { ingested: [], commits: [], warnings: [], errors: [], held: 0, messages: [], unknownEventTypes: [], nonJsonLines: 0, invalidLines: 0 } }));
  };

  // 1. A redesign that failed (Kane exited with an error).
  await setScript({ stdout: DESIGN_ERROR, exit: 1 });
  const failed = await j(await design(REDESIGN));
  assert.equal((await waitJob(failed.jobId)).state, 'error');
  await setScript();
  await refusedLike(failed.jobId, 'error');

  // 2. A redesign that was running when the orchestrator stopped (marked interrupted on start-up).
  const interrupted = 'j20261125-020202-abcdef';
  await writeJob(interrupted, 1, 'running', null);
  await new AssuranceJobs().init();
  assert.equal(JSON.parse(await readFile(path.join(work, 'data', 'assurance', 'jobs', interrupted, 'job.json'), 'utf8')).state, 'interrupted');
  await refusedLike(interrupted, 'interrupted');

  // 3. A redesign paused with Kane's questions whose session expired.
  const expired = 'j20261125-030303-abcdef';
  await writeJob(expired, 2, 'paused', { sid: SID, expiresAt: new Date(Date.now() - 60_000).toISOString(), questions: [], crashed: false, held: null });
  await refusedLike(expired, 'paused and expired');
});

test('a redesign after a request refused before Kane started says so: the complete design is intact, no credits were used; one Kane itself refused keeps the recovery message', async () => {
  const { redesignAcknowledgement } = await import('../src/assurance/commands.ts');
  const { AssuranceJobs } = await import('../src/assurance/jobs.ts');
  await approvedAndVerified();
  const ack = redesignAcknowledgement(UC, 'acs');
  const REDESIGN = { ...PAID, max: 3, redesign: { phase: 'acs', acknowledgement: ack } };
  const decisionId = (await view()).useCases[0].review.history[0].id;
  const first = await j(await design());
  assert.equal((await waitJob(first.jobId)).state, 'complete');

  // 1. A redesign request the run-time preflight refused: Kane's design never ran.
  const jobs = new AssuranceJobs();
  jobs.setDesignPreflight(async () => 'the KaneVerity decision changed since the design was requested.');
  const before = (await calls()).length;
  const job = await jobs.startDesign({ tutorialId: T, ucCid: UC, useCase: 'uc-1', max: 3, reviewer: REVIEWER, decisionId, acknowledgedPrevious: null, redesign: { phase: 'acs', acknowledgement: ack }, requirements: null, confirm: PAID.confirm });
  let done = job;
  for (let i = 0; i < 200 && (done.state === 'queued' || done.state === 'running'); i++) {
    await new Promise((r) => setTimeout(r, 50));
    done = await jobs.get(job.jobId);
  }
  assert.equal(done.state, 'refused');
  assert.equal(done.exitCode, null, 'Kane never ran');
  assert.ok(!(await calls()).slice(before).some((c) => c.argv[0] === 'design'), 'no design command');
  const n = (await designCalls()).length;
  for (const body of [REDESIGN, { ...REDESIGN, acknowledgePrevious: job.jobId }]) {
    const r = await design(body);
    assert.equal(r.status, 409, 'still refused: the safeguards and refusal behaviour are unchanged');
    const error = (await j(r)).error as string;
    assert.ok(error.includes(`(job ${job.jobId}) was refused before Kane started`), error);
    assert.match(error, /Kane's design did not run, no credits were used, and the existing complete design is intact/);
    assert.match(error, /needs a separate, recorded decision/);
    assert.doesNotMatch(error, /there is none|incomplete or unknown outcome|may hold part of a design/);
  }
  assert.equal((await designCalls()).length, n, 'nothing ran');
  // Unchanged V2 behaviour: an ordinary design after a refused request is not blocked by it.
  const plain = await design();
  assert.equal(plain.status, 202, JSON.stringify(await plain.clone().json()));
  assert.equal((await waitJob((await j(plain)).jobId)).state, 'complete');

  // 2. A redesign Kane itself refused after it started (exit 2): its outcome is not known to KaneVerity.
  await setScript({ stdout: [env({ type: 'run_start', mode: 'agent' }), env({ type: 'gate_refused', code: 'GENERATION_LIVE', message: 'uc-1 already has a live design', final: true }), env({ type: 'done', status: 'refused', exit_code: 2 })], exit: 2 });
  const kaneRefused = await j(await design(REDESIGN));
  assert.equal(kaneRefused.state === 'queued' || kaneRefused.state === 'running', true, JSON.stringify(kaneRefused));
  const kr = await waitJob(kaneRefused.jobId);
  await setScript();
  assert.equal(kr.state, 'refused');
  assert.equal(kr.exitCode, 2, 'Kane ran');
  const r = await design(REDESIGN);
  assert.equal(r.status, 409);
  const error = (await j(r)).error as string;
  assert.ok(error.includes(`(job ${kaneRefused.jobId}, refused by Kane after it started) ended with an incomplete or unknown outcome`), error);
  assert.match(error, /recovering needs a separate, recorded decision/);
  assert.doesNotMatch(error, /before Kane started|there is none/);
});

test('the logical id comes from the fresh read: a second use case is designed by its own id', async () => {
  await reset();
  await setScript();
  const lines = reqMd.split('\n');
  const o1 = lineOf('O1');
  await appendRecord({
    nodes: [{ cid: UC_OTHER, label: 'usecase', content: { title: 'Another use case', description: 'Other.', summary: '', actors: [], value: '', risk: 'low', criteria: [] } }],
    edges: [{ type: 'DERIVES', src: SRC, dst: UC_OTHER, props: { source_id: 'kv-generate-an-api-key', source_cid: SRC, anchor: `L${o1}-L${o1}`, quote: lines[o1 - 1] } }],
    intent_verb: 'extract',
  });
  const rr = await post(`${U}/retrieve`);
  const rv = await j(rr);
  assert.equal(rr.status, 200, JSON.stringify(rv));
  assert.equal(rv.snapshot.integrity.ok, true, rv.snapshot.integrity.problems.join(' '));
  assert.deepEqual(rv.useCases.map((u: { logicalId: string }) => u.logicalId).sort(), ['uc-1', 'uc-2']);
  const ap = await j(await approve(UC_OTHER));
  const other = ap.useCases.find((u: { cid: string }) => u.cid === UC_OTHER);
  assert.ok(other, JSON.stringify(ap).slice(0, 600));
  assert.equal(other.kane.state, 'verified', other.kane.reason);
  // uc-1 is not approved: it cannot be designed, and the other one's approval does not count for it.
  assert.equal((await design(PAID, UC)).status, 409);
  const r = await design(PAID, UC_OTHER);
  assert.equal(r.status, 202);
  const job = await waitJob((await j(r)).jobId);
  assert.equal(job.params.ucCid, UC_OTHER);
  assert.equal(job.params.useCase, 'uc-2');
  assert.deepEqual((await designCalls()).at(-1)!.argv.slice(0, 4), ['design', 'tests', '--use-case', 'uc-2']);
});

test('REGRESSION: a list read that lost a use case fails integrity instead of silently dropping it', async () => {
  // The cause found for the one-off failure of the test above: a retrieval whose
  // `context list` missed the last use case still passed integrity.
  await reset();
  const lines = reqMd.split('\n');
  const o1 = lineOf('O1');
  await appendRecord({
    nodes: [{ cid: UC_OTHER, label: 'usecase', content: { title: 'Another use case', description: 'Other.', summary: '', actors: [], value: '', risk: 'low', criteria: [] } }],
    edges: [{ type: 'DERIVES', src: SRC, dst: UC_OTHER, props: { source_id: 'kv-generate-an-api-key', source_cid: SRC, anchor: `L${o1}-L${o1}`, quote: lines[o1 - 1] } }],
    intent_verb: 'extract',
  });
  await setScript(undefined, { listDropLast: true });
  const d = await j(await post(`${U}/retrieve`));
  assert.equal(d.snapshot.integrity.ok, false);
  assert.match(d.snapshot.integrity.problems.join(' '), /context list and context view show different use cases \(list: 1, view: 2\)/);
  // Nothing can be approved or designed from it.
  assert.equal((await approve(UC)).status, 409);
  assert.equal((await design()).status, 409);
  await setScript();
  const ok = await j(await post(`${U}/retrieve`));
  assert.equal(ok.snapshot.integrity.ok, true, ok.snapshot.integrity.problems.join(' '));
  assert.equal(ok.useCases.length, 2);
});

test('concurrent requests start one design; decisions are locked while it runs', async () => {
  await approvedAndVerified();
  await setScript({ stdout: DESIGN_OK, exit: 0, delayMs: 2500 });
  const before = (await designCalls()).length;
  const [a, b] = await Promise.all([design(), design()]);
  assert.deepEqual([a.status, b.status].sort(), [202, 409]);
  const loser = a.status === 409 ? a : b;
  assert.match((await j(loser)).error, /already (queued|running)|A job for this tutorial is already/);
  const winner = await j(a.status === 202 ? a : b);
  // While the design is queued or running, no decision can change.
  for (let i = 0; i < 100; i++) {
    const s = (await j(await fetch(`${api}/api/assurance/jobs/${winner.jobId}`))).state;
    if (s === 'running') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const r = await reject();
  assert.equal(r.status, 409);
  assert.match((await j(r)).error, /test design for this tutorial is (queued|running).*Decisions are locked/);
  assert.equal((await waitJob(winner.jobId)).state, 'complete');
  assert.equal((await designCalls()).length - before, 1, 'Kane design ran once');
});

test('the runner runs the design preflight right before Kane starts: a refusal means Kane never runs and nothing is charged', async () => {
  const { AssuranceJobs } = await import('../src/assurance/jobs.ts');
  await approvedAndVerified();
  await setScript();
  const before = (await calls()).length;
  const jobs = new AssuranceJobs();
  const seen: string[] = [];
  jobs.setDesignPreflight(async (job) => {
    seen.push(job.jobId);
    return 'the requirements are no longer the current version.';
  });
  const job = await jobs.startDesign({ tutorialId: T, ucCid: UC, useCase: 'uc-1', max: 1, reviewer: REVIEWER, decisionId: 'd20261124-000000-aaaaaa', acknowledgedPrevious: null, requirements: null, confirm: PAID.confirm });
  let done = job;
  for (let i = 0; i < 200 && (done.state === 'queued' || done.state === 'running'); i++) {
    await new Promise((r) => setTimeout(r, 50));
    done = await jobs.get(job.jobId);
  }
  assert.deepEqual(seen, [job.jobId], 'the preflight ran for this job');
  assert.equal(done.state, 'refused');
  assert.match(done.reason, /Not started: the requirements are no longer the current version\. Kane's design did not start and no credits were used\./);
  assert.equal(done.credits.basis, null, 'no cost recorded');
  const ran = (await calls()).slice(before).map((c) => c.argv[0]);
  assert.ok(!ran.includes('design') && !ran.includes('balance'), `no design and no balance read: ${ran.join(', ')}`);

  // A runner without the checks never starts a design.
  const bare = new AssuranceJobs();
  const j2 = await bare.startDesign({ tutorialId: T, ucCid: UC, useCase: 'uc-1', max: 1, reviewer: REVIEWER, decisionId: 'd20261124-000000-aaaaaa', acknowledgedPrevious: null, requirements: null, confirm: PAID.confirm });
  let d2 = j2;
  for (let i = 0; i < 200 && (d2.state === 'queued' || d2.state === 'running'); i++) {
    await new Promise((r) => setTimeout(r, 50));
    d2 = await bare.get(j2.jobId);
  }
  assert.equal(d2.state, 'refused');
  assert.match(d2.reason, /design checks are not available/);
  assert.ok(!(await calls()).slice(before).some((c) => c.argv[0] === 'design'));
});

test('the run-time preflight refuses a design whose decision changed after it was requested', async () => {
  const { AssuranceUseCases } = await import('../src/assurance/usecases.ts');
  const { AssuranceJobs } = await import('../src/assurance/jobs.ts');
  const { RequirementsService } = await import('../src/assurance/service.ts');
  await approvedAndVerified();
  const jobs = new AssuranceJobs();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const uc = new AssuranceUseCases(jobs, new RequirementsService()) as any;
  const decisionId = (await view()).useCases[0].review.history[0].id;
  const job = { jobId: 'j20261124-000000-aaaaaa', kind: 'design', tutorialId: T, params: { kind: 'design', tutorialId: T, ucCid: UC, useCase: 'uc-1', max: 1, reviewer: REVIEWER, decisionId, acknowledgedPrevious: null } };
  assert.equal(await uc.designPreflight(job), null, 'eligible as requested');
  assert.match(await uc.designPreflight({ ...job, params: { ...job.params, decisionId: 'd20261124-000000-bbbbbb' } }), /decision changed/);
  assert.match(await uc.designPreflight({ ...job, params: { ...job.params, useCase: 'uc-9' } }), /id for this use case changed/);
  assert.match(await uc.designPreflight({ ...job, params: { ...job.params, reviewer: 'someone-else' } }), /reviewer setting changed/);
  assert.match(await uc.designPreflight({ ...job, params: { ...job.params, ucCid: UC_OTHER } }), /not in the latest retrieval/);
  await reject();
  assert.match(await uc.designPreflight(job), /decision changed|rejected/);
});

test('a failed design needs an explicit acknowledgement before another (paid) attempt; never retried by itself', async () => {
  await approvedAndVerified();
  await setScript({ stdout: DESIGN_ERROR, exit: 1 });
  const first = await j(await design());
  const done = await waitJob(first.jobId);
  assert.equal(done.state, 'error');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await designCalls()).filter((c) => c.argv[1] === 'tests').length >= 1, true);
  const n = (await designCalls()).length;
  await setScript();
  let r = await design();
  assert.equal(r.status, 409);
  assert.match((await j(r)).error, new RegExp(`job ${first.jobId}\\) ended without a known result.*acknowledgePrevious`));
  r = await design({ ...PAID, acknowledgePrevious: 'j20261124-000000-ffffff' });
  assert.equal(r.status, 409, 'a different job id is not an acknowledgement');
  assert.equal((await designCalls()).length, n, 'nothing ran again by itself');
  r = await design({ ...PAID, acknowledgePrevious: first.jobId });
  assert.equal(r.status, 202);
  const second = await waitJob((await j(r)).jobId);
  assert.equal(second.params.acknowledgedPrevious, first.jobId);
  assert.equal(second.state, 'complete');
});

test('an interrupted design (orchestrator restart) is never retried and needs an acknowledgement', async () => {
  await approvedAndVerified();
  const decisionId = (await view()).useCases[0].review.history[0].id;
  // A design job that was running when the orchestrator stopped.
  const id = 'j20261124-010101-abcdef';
  const dir = path.join(work, 'data', 'assurance', 'jobs', id);
  await mkdir(path.join(dir, 'private'), { recursive: true });
  const now = new Date().toISOString();
  await writeFile(path.join(dir, 'job.json'), JSON.stringify({ jobId: id, kind: 'design', params: { kind: 'design', tutorialId: T, ucCid: UC, useCase: 'uc-1', max: 1, reviewer: REVIEWER, decisionId, acknowledgedPrevious: null }, tutorialId: T, state: 'running', reason: 'Kane is running.', createdAt: now, startedAt: now, finishedAt: null, args: [], exitCode: null, cliVersion: '0.10.5', verb: 'design', doneStatus: null, next: [], pause: null, parentJobId: null, resumedBy: null, requirements: null, credits: { amount: null, basis: null, reportedTotal: null, measured: null, balanceBefore: null, balanceAfter: null }, summary: { ingested: [], commits: [], warnings: [], errors: [], held: 0, messages: [], unknownEventTypes: [], nonJsonLines: 0, invalidLines: 0 } }));
  const { AssuranceJobs } = await import('../src/assurance/jobs.ts');
  await new AssuranceJobs().init();
  const rec = JSON.parse(await readFile(path.join(dir, 'job.json'), 'utf8'));
  assert.equal(rec.state, 'interrupted');
  assert.equal(rec.credits.basis, 'unknown', 'a paid job interrupted mid-run has an unknown cost, never 0');
  const before = (await designCalls()).length;
  const r = await design();
  assert.equal(r.status, 409);
  assert.match((await j(r)).error, new RegExp(`job ${id}\\) ended without a known result`));
  assert.equal((await designCalls()).length, before);
  const uc = (await view()).useCases[0];
  assert.equal(uc.testDesign.needsAcknowledgement, id);
});

test("Kane's questions pause the design: never answered automatically; a resume is paid, re-checked and bound", async () => {
  await approvedAndVerified();
  await setScript({ stdout: DESIGN_PAUSE(), exit: 3 }, { [`resume:${SID}`]: { stdout: DESIGN_OK, exit: 0 } });
  const before = (await calls()).length;
  const paused = await waitJob((await j(await design())).jobId);
  assert.equal(paused.state, 'paused', paused.reason);
  assert.equal(paused.pause.questions[0].id, 'q1');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!(await calls()).slice(before).some((c) => c.argv.includes('--resume')), 'nothing answered Kane by itself');
  // No new design while paused.
  let r = await design();
  assert.equal(r.status, 409);
  assert.match((await j(r)).error, /paused with Kane's questions/);
  // The generic jobs API can neither answer nor stop a test-design session.
  r = await post(`/api/assurance/jobs/${paused.jobId}/answer`, { answers: { q1: 1 }, ...PAID });
  assert.equal(r.status, 409);
  assert.match((await j(r)).error, /answered from their use case/);
  r = await post(`/api/assurance/jobs/${paused.jobId}/cancel`);
  assert.equal(r.status, 409);
  assert.match((await j(r)).error, /stopped or abandoned from their use case/);
  // The design endpoint must name this job's own use case.
  assert.equal((await post(`${ucBase(UC_OTHER)}/design/${paused.jobId}/answer`, { answers: { q1: 1 }, ...PAID })).status, 404);
  assert.equal((await post(`${ucBase()}/design/j20261124-000000-ffffff/answer`, { answers: { q1: 1 }, ...PAID })).status, 404);
  assert.equal((await post(`${ucBase()}/design/..%2F..%2Fx/answer`, { answers: { q1: 1 }, ...PAID })).status, 404);
  assert.equal((await j(await fetch(`${api}/api/assurance/jobs/${paused.jobId}`))).state, 'paused', 'still paused');
  // Refused before any Kane read: wrong mode, or a changed reviewer setting.
  const { config } = await import('../src/config.ts');
  const readsBefore = (await calls()).length;
  config.assurance.mode = 'free';
  try {
    r = await post(`${ucBase()}/design/${paused.jobId}/answer`, { answers: { q1: 1 }, ...PAID });
    assert.equal(r.status, 403);
  } finally {
    config.assurance.mode = 'all';
  }
  process.env.KANEVERITY_REVIEWER = 'someone-else';
  try {
    r = await post(`${ucBase()}/design/${paused.jobId}/answer`, { answers: { q1: 1 }, ...PAID });
    assert.equal(r.status, 409);
    assert.match((await j(r)).error, /reviewer setting changed/);
  } finally {
    process.env.KANEVERITY_REVIEWER = REVIEWER;
  }
  assert.equal((await calls()).length, readsBefore, 'no Kane command ran for the refused answers');
  // Answering is a separate paid step, from the use case.
  r = await post(`${ucBase()}/design/${paused.jobId}/answer`, { answers: { q1: 1 } });
  assert.equal(r.status, 400);
  assert.match((await j(r)).error, /uses Kane credits/);
  r = await post(`${ucBase()}/design/${paused.jobId}/answer`, { answers: { q1: 1 }, ...PAID });
  assert.equal(r.status, 202);
  const child = await waitJob((await j(r)).jobId);
  assert.equal(child.kind, 'resume');
  assert.equal(child.state, 'complete', child.reason);
  const resumeCall = (await calls()).filter((c) => c.argv.includes('--resume')).at(-1)!;
  assert.deepEqual(resumeCall.argv, ['design', 'tests', '--resume', SID, '--mode', 'agent', '--answer', 'q1=1']);
  assert.equal(resumeCall.env.USER, `kaneverity:${REVIEWER}`);
});

test('a paused design whose use case was rejected, or re-approved with a new decision, is not resumed', async () => {
  await approvedAndVerified();
  await setScript({ stdout: DESIGN_PAUSE(), exit: 3 }, { [`resume:${SID}`]: { stdout: DESIGN_OK, exit: 0 } });
  const paused = await waitJob((await j(await design())).jobId);
  assert.equal(paused.state, 'paused');
  const resumesBefore = (await calls()).filter((c) => c.argv.includes('--resume')).length;
  assert.equal((await j(await reject())).useCases[0].review.state, 'rejected', 'decisions are allowed while a design is paused');
  let r = await post(`${ucBase()}/design/${paused.jobId}/answer`, { answers: { q1: 1 }, ...PAID });
  assert.equal(r.status, 409);
  assert.match((await j(r)).error, /rejected/);
  // Re-approving is a new decision: the paused session relied on the old one.
  assert.equal((await j(await approve())).useCases[0].kane.state, 'verified');
  r = await post(`${ucBase()}/design/${paused.jobId}/answer`, { answers: { q1: 1 }, ...PAID });
  assert.equal(r.status, 409);
  assert.match((await j(r)).error, /decision this design relies on has changed/);
  assert.equal((await calls()).filter((c) => c.argv.includes('--resume')).length, resumesBefore, 'the paused session was never resumed');
  // Abandoning it (from its use case) is allowed; a new design then needs an acknowledgement.
  const ab = await post(`${ucBase()}/design/${paused.jobId}/cancel`);
  assert.equal(ab.status, 202);
  assert.equal((await j(ab)).state, 'abandoned');
  r = await design();
  assert.equal(r.status, 409);
  assert.match((await j(r)).error, /ended without a known result/);
});
