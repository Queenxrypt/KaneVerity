// Assurance B2: the job runner end to end, against the FAKE Kane Assurance CLI
// (tests/fake-kane-assurance.cjs). No real Kane command runs; no credits are used.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDocsServer } from '../../docs/server.ts';
import { outdatedDocsContent, TESTS_DIR } from './helpers.ts';
import { DOC_PAUSE, DOC_RESUME, pauseExpiringAt } from './fixtures/assurance-docs.ts';

// A live pause: the documented example's expiry date is already in the past.
const LIVE_PAUSE = pauseExpiringAt(new Date(Date.now() + 24 * 3600_000).toISOString());

let docs: Server;
let app: Server;
let orch: Server;
let api: string;
let work: string;
let scriptFile: string;
let logFile: string;
let balanceState: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mods: any;
const listen = (s: Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const j = async (r: Response): Promise<any> => r.json();
const H = { 'Content-Type': 'application/json', 'X-KaneVerity': '1' };
const post = (p: string, body: unknown = {}) => fetch(api + p, { method: 'POST', headers: H, body: JSON.stringify(body) });
const getJob = (id: string) => fetch(`${api}/api/assurance/jobs/${id}`).then(j);
const PAID = { confirm: { paid: true } };
const T = 'generate-an-api-key';

async function script(replies: Record<string, unknown>, balances: unknown[] = [1000]) {
  await writeFile(scriptFile, JSON.stringify(replies));
  await writeFile(balanceState, '0');
  process.env.FAKE_ASSURANCE_BALANCE = JSON.stringify(balances);
}
async function invocations(): Promise<{ argv: string[]; cwd: string; env: Record<string, string | null>; stdinIsTTY: boolean }[]> {
  return (await readFile(logFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
async function waitJob(id: string, done: (x: { state: string }) => boolean, label: string) {
  for (let i = 0; i < 200; i++) {
    const x = await getJob(id);
    if (done(x)) return x;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}
const settled = (x: { state: string }) => !['queued', 'running'].includes(x.state);
async function ledger(): Promise<{ runId: string; credits: number; basis: string; kind: string }[]> {
  return JSON.parse(await readFile(path.join(work, 'data', 'credits.json'), 'utf8').catch(() => '[]'));
}

before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), 'kv-jobs-'));
  scriptFile = path.join(work, 'script.json');
  logFile = path.join(work, 'invocations.ndjson');
  balanceState = path.join(work, 'balance-state');
  const content = await outdatedDocsContent();
  docs = createDocsServer(content);
  const docsUrl = (await listen(docs)) + '/';
  app = createServer((_q, s) => {
    s.writeHead(200, { 'Content-Type': 'text/html' });
    s.end('<!doctype html><title>AcmeDesk</title>');
  });
  const appUrl = (await listen(app)) + '/';
  Object.assign(process.env, {
    KANEVERITY_DATA_DIR: path.join(work, 'data'),
    KANEVERITY_ASSURANCE_MODE: 'all',
    KANEVERITY_ASSURANCE_TIMEOUT_MS: '3000',
    KANE_CLI_ENTRY: path.join(TESTS_DIR, 'fake-kane-assurance.cjs'),
    KANEVERITY_DOCS_CONTENT_DIR: content,
    KANEVERITY_ALLOWED_DOCS_ORIGINS: new URL(docsUrl).origin,
    KANEVERITY_ALLOWED_APP_ORIGINS: new URL(appUrl).origin,
    FAKE_ASSURANCE_LOG: logFile,
    FAKE_ASSURANCE_SCRIPT: scriptFile,
    FAKE_ASSURANCE_BALANCE_STATE: balanceState,
  });
  await script({});
  const server = await import('../server.ts');
  const jobs = await import('../src/assurance/jobs.ts');
  const lock = await import('../src/kane/lock.ts');
  const redact = await import('../src/verify/redact.ts');
  const config = await import('../src/config.ts');
  mods = { server, jobs, lock, redact, config };
  orch = server.createOrchestrator();
  api = await listen(orch);
  assert.equal((await post('/api/project', { docsUrl, appUrl })).status, 200);
  assert.equal((await post('/api/discover')).status, 200);
  assert.equal((await post(`/api/assurance/requirements/${T}`)).status, 201);
});

after(() => {
  docs.close();
  app.close();
  orch.close();
});

test('status, gating and confirmation', async () => {
  const st = await j(await fetch(`${api}/api/assurance/status`));
  assert.equal(st.mode, 'all');
  assert.equal(st.pinnedVersion, '0.10.5');
  assert.deepEqual(st.kinds.map((k: { kind: string; paid: boolean }) => [k.kind, k.paid]), [['ingest', false], ['extract', true], ['design', true], ['resume', true], ['list', false], ['cover', false], ['view', false], ['fsck', false]]);
  let r = await post('/api/assurance/jobs', { kind: 'extract', tutorialId: T });
  assert.equal(r.status, 400, 'paid without confirmation');
  assert.match((await j(r)).error, /uses Kane credits/);
  r = await post('/api/assurance/jobs', { kind: 'extract', tutorialId: T, ...PAID });
  assert.equal(r.status, 409, 'extract before the requirements are landed');
  assert.match((await j(r)).error, /Land the current requirements/);
  for (const bad of [{ kind: 'reconcile' }, { kind: 'resume' }, { kind: '__proto__' }, { kind: 'ingest', tutorialId: '../x' }, { kind: 'design', useCase: 'uc-x --force', max: 1, ...PAID }, { kind: 'design', useCase: 'uc-a-b', max: 50, ...PAID }]) {
    assert.ok([400, 404].includes((await post('/api/assurance/jobs', bad)).status), JSON.stringify(bad));
  }
  assert.equal((await fetch(`${api}/api/assurance/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403, 'missing X-KaneVerity');
  assert.deepEqual(await invocations(), [], 'nothing reached Kane');
});

test('ingest lands exactly the stored requirements, in the workspace, without a terminal, free', async () => {
  await script({ 'context ingest': { stdout: ['created  kv-generate-an-api-key  source sha256:aaa1  blob sha256:bbb2'], stderr: 'next: kane-cli context extract\n', exit: 0, createStore: true } });
  const started = await j(await post('/api/assurance/jobs', { kind: 'ingest', tutorialId: T }));
  const done = await waitJob(started.jobId, settled, 'ingest');
  assert.equal(done.state, 'complete', done.reason);
  assert.equal(done.reason, 'Landed: kv-generate-an-api-key (created).');
  assert.deepEqual(done.summary.ingested, [{ sourceId: 'kv-generate-an-api-key', status: 'created' }]);
  const calls = await invocations();
  assert.deepEqual(calls.map((c) => c.argv), [['--version'], ['context', 'ingest', 'requirements/generate-an-api-key.md', '--as', 'kv-generate-an-api-key', '--mode', 'ci', '--local']]);
  const ws = path.join(work, 'data', 'assurance', 'workspace');
  for (const c of calls) {
    assert.equal(path.resolve(c.cwd), path.resolve(ws), 'runs in the Assurance workspace');
    assert.equal(c.env.KANE_CONTEXT_GITIGNORE, '0', 'Kane must not edit the repository .gitignore');
    assert.equal(c.stdinIsTTY, false);
  }
  const req = await j(await fetch(`${api}/api/assurance/requirements/${T}`));
  assert.equal(await readFile(path.join(ws, 'requirements', `${T}.md`), 'utf8'), req.shown.markdown, 'Kane gets the stored bytes');
  assert.deepEqual(done.requirements, { version: 1, reqSha256: req.shown.reqSha256, docSha256: req.shown.docSha256 });
  assert.equal((await ledger()).length, 0, 'free jobs make no ledger entry');
});

let pausedId: string;
test('extract pauses with Kane\'s questions; cost measured from the balance when Kane reports none', async () => {
  await script({ 'context extract': { stdout: LIVE_PAUSE, exit: 3 } }, [1000, 997.55]);
  const before = (await invocations()).length;
  const started = await j(await post('/api/assurance/jobs', { kind: 'extract', tutorialId: T, ...PAID }));
  const x = await waitJob(started.jobId, settled, 'extract');
  pausedId = x.jobId;
  assert.equal(x.state, 'paused', x.reason);
  assert.equal(x.reason, 'Kane is waiting for 1 answer(s).');
  assert.equal(x.pause.questions[0].id, 'q1');
  assert.equal(x.pause.questions[0].recommendedIndex, 0);
  assert.equal(x.pause.sid, undefined, 'the session id stays server-side');
  assert.deepEqual(x.credits, { amount: 2.45, basis: 'measured', reportedTotal: null, measured: 2.45 });
  const calls = (await invocations()).slice(before).map((c) => c.argv);
  assert.deepEqual(calls, [['balance'], ['context', 'extract', '--mode', 'agent', '--local', '--source', 'kv-generate-an-api-key'], ['balance']], 'version checked only once per process');
  assert.deepEqual((await ledger()).map((e) => [e.runId, e.credits, e.basis, e.kind]), [[x.jobId, 2.45, 'measured', 'assurance:extract']]);
});

test('answers are validated, confirmed, and resume the same session; reported usage wins', async () => {
  for (const [body, re] of [
    [{ answers: { q9: 1 }, ...PAID }, /did not ask/],
    [{ answers: { q1: 5 }, ...PAID }, /option from 1 to 2/],
    [{ answers: {} , ...PAID }, /no answer/],
    [{ answers: { q1: 'a\nb' }, ...PAID }, /single line/],
    [{ answers: { q1: 1 } }, /uses Kane credits/],
  ] as [unknown, RegExp][]) {
    const r = await post(`/api/assurance/jobs/${pausedId}/answer`, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match((await j(r)).error, re);
  }
  await script({ 'resume:ext-20260716T140742-prd-online-store': { stdout: DOC_RESUME, exit: 0 } }, [997.55, 995.1]);
  const before = (await invocations()).length;
  const child = await j(await post(`/api/assurance/jobs/${pausedId}/answer`, { answers: { q1: 1 }, ...PAID }));
  const done = await waitJob(child.jobId, settled, 'resume');
  assert.equal(done.state, 'complete', done.reason);
  assert.equal(done.parentJobId, pausedId);
  assert.deepEqual(done.params, { kind: 'resume', verb: 'extract', answers: [{ id: 'q1', value: '1' }] });
  assert.deepEqual(done.summary.commits, [{ counts: { derived: 5 }, minted: ['uc-create-an-account-to-order'] }]);
  assert.deepEqual(done.credits, { amount: 2.45, basis: 'reported', reportedTotal: 2.45, measured: 2.45 });
  assert.deepEqual((await invocations()).slice(before).map((c) => c.argv)[1], ['context', 'extract', '--resume', 'ext-20260716T140742-prd-online-store', '--mode', 'agent', '--answer', 'q1=1']);
  const parent = await getJob(pausedId);
  assert.equal(parent.state, 'answered');
  assert.equal(parent.resumedBy, child.jobId);
  assert.equal((await post(`/api/assurance/jobs/${pausedId}/answer`, { answers: { q1: 1 }, ...PAID })).status, 409, 'a session is answered once');
});

test('crash without "done": outcome unknown, cost unknown (never 0); one store writer per tutorial', async () => {
  await script({ 'context extract': { stdout: DOC_PAUSE.slice(0, 3), exit: 1, delayMs: 600 } }, ['n/a']);
  const a = await j(await post('/api/assurance/jobs', { kind: 'extract', tutorialId: T, ...PAID }));
  const dup = await post('/api/assurance/jobs', { kind: 'extract', tutorialId: T, ...PAID });
  assert.equal(dup.status, 409, 'a second store-writing job for the same tutorial is refused');
  assert.match((await j(dup)).error, /already (queued|running)/);
  const x = await waitJob(a.jobId, settled, 'crash');
  assert.equal(x.state, 'crashed');
  assert.match(x.reason, /without its final "done" event/);
  assert.deepEqual(x.credits, { amount: null, basis: 'unknown', reportedTotal: null, measured: null });
  const e = (await ledger()).find((l) => l.runId === a.jobId)!;
  assert.equal(e.basis, 'unknown');
  const costs = (await j(await fetch(`${api}/api/health`))).credits;
  assert.equal(costs.runsUnknownCost, 1);
  assert.equal(costs.measuredCredits, 2.45);
  assert.equal(costs.reportedCredits, 2.45);
});

test('a "done" that contradicts the process exit code is not trusted', async () => {
  await script({ cover: { stdout: ['{"type":"coverage","v":1,"verb":"cover","pct":50}', '{"type":"done","v":1,"verb":"cover","status":"complete","exit_code":0}'], exit: 1 } });
  const x = await waitJob((await j(await post('/api/assurance/jobs', { kind: 'cover' }))).jobId, settled, 'cover');
  assert.equal(x.state, 'error');
  assert.match(x.reason, /disagrees with the process exit code/);
});

test('redaction: Kane text is scrubbed in the public job; the raw stream stays private', async () => {
  await script({
    cover: {
      stdout: [
        '{"type":"agent_message","v":1,"verb":"cover","text":"Signed in as person@company.io, logs in C:\\\\Users\\\\someone\\\\kane"}',
        '{"type":"warning","v":1,"verb":"cover","message":"see https://app.lambdatest.com/share/abc"}',
        '{"type":"done","v":1,"verb":"cover","status":"complete","exit_code":0,"next":["kane-cli cover gaps"]}',
      ],
      exit: 0,
    },
  });
  const x = await waitJob((await j(await post('/api/assurance/jobs', { kind: 'cover' }))).jobId, settled, 'cover');
  assert.equal(x.state, 'complete');
  assert.deepEqual(mods.redact.findLeaks(x), []);
  assert.match(x.summary.messages[0], /\[email\].*\[local path\]/);
  assert.match(x.summary.warnings[0], /\[link removed\]/);
  assert.deepEqual(x.next, ['kane-cli cover gaps'], 'next commands are shown, never run');
  const raw = await readFile(path.join(work, 'data', 'assurance', 'jobs', x.jobId, 'private', 'stdout.ndjson'), 'utf8');
  assert.ok(raw.includes('person@company.io'), 'the raw stream is kept privately');
  assert.ok(!(await invocations()).some((c) => c.argv.join(' ').includes('gaps')), 'Kane\'s next[] was not executed');
});

test('one Kane process at a time: a job waits for the shared lock', async () => {
  await script({ cover: { stdout: ['{"type":"done","v":1,"verb":"cover","status":"complete","exit_code":0}'], exit: 0 } });
  const release = await mods.lock.kaneLock.acquire('test:verification-run');
  const id = (await j(await post('/api/assurance/jobs', { kind: 'cover' }))).jobId;
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await getJob(id)).state, 'queued', 'waits while another Kane process holds the lock');
  release();
  assert.equal((await waitJob(id, settled, 'cover after lock')).state, 'complete');
});

test('timeout, cancel while running, cancel while queued, abandon a pause', async () => {
  await script({ cover: { stdout: [], hang: true } });
  const t = await waitJob((await j(await post('/api/assurance/jobs', { kind: 'cover' }))).jobId, settled, 'timeout');
  assert.equal(t.state, 'interrupted', 'stopped at the time limit');

  const running = (await j(await post('/api/assurance/jobs', { kind: 'cover' }))).jobId;
  await waitJob(running, (x) => x.state === 'running', 'running');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await post(`/api/assurance/jobs/${running}/cancel`)).status, 202);
  const c = await waitJob(running, settled, 'cancelled');
  assert.equal(c.state, 'cancelled');

  const release = await mods.lock.kaneLock.acquire('test:hold');
  const queued = (await j(await post('/api/assurance/jobs', { kind: 'cover' }))).jobId;
  const q = await j(await post(`/api/assurance/jobs/${queued}/cancel`));
  assert.equal(q.state, 'cancelled');
  assert.match(q.reason, /Nothing ran/);
  release();

  await script({ 'context extract': { stdout: LIVE_PAUSE, exit: 3 } }, [10, 10]);
  const p = await waitJob((await j(await post('/api/assurance/jobs', { kind: 'extract', tutorialId: T, ...PAID }))).jobId, settled, 'pause');
  assert.equal(p.state, 'paused');
  const ab = await j(await post(`/api/assurance/jobs/${p.jobId}/cancel`));
  assert.equal(ab.state, 'abandoned');
  assert.equal((await post(`/api/assurance/jobs/${p.jobId}/answer`, { answers: { q1: 1 }, ...PAID })).status, 409);
});

test('an expired pause cannot be answered', async () => {
  const expired = DOC_PAUSE.map((l) => l.replace('2026-07-17T14:07:53Z', '2000-01-01T00:00:00Z'));
  await script({ 'context extract': { stdout: expired, exit: 3 } }, [10, 10]);
  const p = await waitJob((await j(await post('/api/assurance/jobs', { kind: 'extract', tutorialId: T, ...PAID }))).jobId, settled, 'pause');
  assert.equal(p.state, 'expired');
  const r = await post(`/api/assurance/jobs/${p.jobId}/answer`, { answers: { q1: 1 }, ...PAID });
  assert.equal(r.status, 409);
  assert.match((await j(r)).error, /expired/);
});

test('after a restart, a job that was running is interrupted and its cost recorded as unknown', async () => {
  const any = (await j(await fetch(`${api}/api/assurance/jobs`)))[0];
  const raw = JSON.parse(await readFile(path.join(work, 'data', 'assurance', 'jobs', any.jobId, 'job.json'), 'utf8'));
  const id = 'j20990101-000000-abcdef';
  await writeFile(path.join(work, 'data', 'assurance', 'jobs', '..', 'jobs', id + '.tmp'), ''); // harmless stray file is ignored
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(work, 'data', 'assurance', 'jobs', id), { recursive: true });
  await writeFile(path.join(work, 'data', 'assurance', 'jobs', id, 'job.json'), JSON.stringify({ ...raw, jobId: id, kind: 'extract', state: 'running', credits: { ...raw.credits, basis: null, amount: null } }));
  const fresh = new mods.jobs.AssuranceJobs();
  await fresh.init();
  const r = await fresh.get(id);
  assert.equal(r.state, 'interrupted');
  assert.match(r.reason, /outcome is unknown/);
  assert.equal((await ledger()).find((e) => e.runId === id)?.basis, 'unknown');
});

test('the pinned version is enforced: another Kane version refuses before any command', async () => {
  process.env.FAKE_ASSURANCE_VERSION = '0.10.7';
  try {
    const other = new mods.jobs.AssuranceJobs();
    const before = (await invocations()).length;
    const started = await other.start({ kind: 'cover' });
    for (let i = 0; i < 100 && ['queued', 'running'].includes((await other.get(started.jobId)).state); i++) await new Promise((r) => setTimeout(r, 50));
    const x = await other.get(started.jobId);
    assert.equal(x.state, 'refused');
    assert.match(x.reason, /0\.10\.7 is installed, but KaneVerity is pinned to 0\.10\.5/);
    assert.deepEqual((await invocations()).slice(before).map((c) => c.argv), [['--version']]);
  } finally {
    delete process.env.FAKE_ASSURANCE_VERSION;
  }
});

test('only allow-listed commands ever reached Kane', async () => {
  // `whoami` is the existing /api/health login check (free, read-only), not an Assurance job.
  const allowed = new Set(['--version', 'balance', 'context ingest', 'context extract', 'cover', 'whoami']);
  for (const c of await invocations()) {
    const key = c.argv[0] === 'context' ? `${c.argv[0]} ${c.argv[1]}` : c.argv[0];
    assert.ok(allowed.has(key), c.argv.join(' '));
    assert.ok(!c.argv.some((a) => /^--(force|allow-unreviewed|allow-archive|yes)$/.test(a)), c.argv.join(' '));
  }
});
