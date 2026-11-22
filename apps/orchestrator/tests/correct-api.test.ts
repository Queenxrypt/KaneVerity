// End-to-end correction loop through the API with a FAKE Kane CLI and a FAKE
// Claude Code (no credits, no Claude usage). Uses a temporary copy of the docs
// content so nothing in the repository is modified.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cp, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createDocsServer } from '../../docs/server.ts';
import { loadFixture, makeZip, outdatedDocsContent, TESTS_DIR, TINY_JPEG } from './helpers.ts';

let docs: Server;
let app: Server;
let orch: Server;
let docsUrl: string;
let appUrl: string;
let api: string;
let work: string;
let contentDir: string;
let findLeaks: (v: unknown) => string[];
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const listen = (s: Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const j = async (r: Response): Promise<any> => r.json();
const H = { 'Content-Type': 'application/json', 'X-KaneVerity': '1' };
const post = (p: string, body: unknown = {}) => fetch(api + p, { method: 'POST', headers: H, body: JSON.stringify(body) });

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, label: string): Promise<T> {
  for (let i = 0; i < 150; i++) {
    const v = await fn();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}
const correction = (id: string) => fetch(`${api}/api/corrections/${id}`).then(j);
const runRec = (id: string) => fetch(`${api}/api/runs/${id}`).then(j);

const OUTCOME_MEMORY = {
  msg: { query: "whether the message 'API key generated successfully.' is visible", reasoning: "value: 'true'; equals 'true' -> PASS", extracted_value: 'true' },
  row: { query: 'whether the new key is added to the API keys list', reasoning: "value: 'true'; equals 'true' -> PASS", extracted_value: 'true' },
  count: { query: "whether the key count below the list shows '2 keys'", reasoning: "value: '2 keys'; equals '2 keys' -> PASS", extracted_value: '2 keys' },
};

async function writeFixture(name: string, fx: object): Promise<string> {
  const p = path.join(work, `${name}.json`);
  await writeFile(p, JSON.stringify(fx));
  return p;
}

async function writePack(name: string, steps: { kind: string; status: string; summary: string; url: string }[]): Promise<string> {
  const T = `tests/kv-${name}-abc123`;
  const entries = steps.flatMap((s, i) => [
    { name: `${T}/steps/${i + 1}-0-${i + 1}/step.json`, data: JSON.stringify({ ordinal: i + 1, ...s }) },
    { name: `${T}/steps/${i + 1}-0-${i + 1}/screenshot.jpg`, data: TINY_JPEG },
  ]);
  const p = path.join(work, `${name}.evidence`);
  await writeFile(p, makeZip(entries));
  return p;
}

before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), 'kv-correct-'));
  contentDir = path.join(work, 'content');
  await cp(await outdatedDocsContent(), contentDir, { recursive: true });
  docs = createDocsServer(contentDir);
  docsUrl = (await listen(docs)) + '/';
  app = createServer((_q, s) => {
    s.writeHead(200, { 'Content-Type': 'text/html' });
    s.end('<!doctype html><title>AcmeDesk</title>');
  });
  appUrl = (await listen(app)) + '/';
  const origin = new URL(appUrl).origin;

  Object.assign(process.env, {
    KANEVERITY_DATA_DIR: path.join(work, 'data'),
    KANE_CLI_ENTRY: path.join(TESTS_DIR, 'fake-kane.cjs'),
    KANEVERITY_CLAUDE_EXE: path.join(TESTS_DIR, 'fake-claude.cjs'),
    KANEVERITY_DOCS_CONTENT_DIR: contentDir,
    KANEVERITY_ALLOWED_DOCS_ORIGINS: new URL(docsUrl).origin,
    KANEVERITY_ALLOWED_APP_ORIGINS: origin,
    FAKE_CLAUDE_ARGS_OUT: path.join(work, 'claude-args.json'),
    FAKE_KANE_ARGS_OUT: path.join(work, 'kane-args.json'),
  });
  const { createOrchestrator, trackRuns } = await import('../server.ts');
  const { Runner } = await import('../src/kane/runner.ts');
  ({ findLeaks } = await import('../src/verify/redact.ts'));
  const runner = new Runner();
  trackRuns(runner);
  orch = createOrchestrator(runner);
  api = await listen(orch);
});

after(() => {
  docs.close();
  app.close();
  orch.close();
});

test('full correction loop: FAILED -> Claude asks for exploration -> Kane explores -> Claude proposes -> approve -> Kane retest -> VERIFIED -> restore', async () => {
  const origin = new URL(appUrl).origin;
  const file = path.join(contentDir, 'tutorials', 'generate-an-api-key.md');
  const originalText = await readFile(file, 'utf8');

  // 1. Original verification run: outdated docs -> FAILED at step 1.
  process.env.FAKE_KANE_FIXTURE = path.join(TESTS_DIR, 'fixtures', 'acmedesk-apikey-outdated.json');
  process.env.FAKE_KANE_PACK = await writePack('original', [
    { kind: 'navigate', status: 'passed', summary: `navigate: Navigate to ${appUrl}`, url: appUrl },
    { kind: '', status: 'failed', summary: "wait: Waiting locate the exact 'Settings' element on the Dashboard", url: appUrl },
  ]);
  assert.equal((await post('/api/project', { docsUrl, appUrl })).status, 200);
  assert.equal((await post('/api/discover')).status, 200);
  const { runIds } = await j(await post('/api/runs', { tutorialIds: ['generate-an-api-key'] }));
  const original = await waitFor(() => runRec(runIds[0]), (r) => r.state === 'finished', 'original run');
  assert.equal(original.classification.status, 'FAILED');

  // 2. Claude reviews: evidence shows only the Dashboard -> needs_exploration.
  await writeFile(path.join(work, 'answer1.json'), JSON.stringify({ structured: { decision: 'needs_exploration', rationale: 'Kane only saw the Dashboard.', confidence: 'high', evidenceCited: [`${runIds[0]} step 2`], edits: [], explorationQuestion: 'CLAUDE_CANARY: where are API keys generated?' } }));
  process.env.FAKE_CLAUDE_ANSWER = path.join(work, 'answer1.json');
  const started = await post(`/api/runs/${runIds[0]}/corrections`);
  assert.equal(started.status, 202);
  const cid = (await j(started)).id;
  let c = await waitFor(() => correction(cid), (x) => x.state !== 'analyzing', 'first Claude review');
  assert.equal(c.state, 'needs_exploration');

  // Claude ran restricted, in a temp folder outside the repo, seeing only the package.
  const call1 = JSON.parse(await readFile(path.join(work, 'claude-args.json'), 'utf8'));
  for (const flag of ['--tools', 'Read', '--restricted', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--json-schema']) assert.ok(call1.argv.includes(flag), flag);
  assert.ok(!path.resolve(call1.cwd).startsWith(path.resolve(TESTS_DIR, '..', '..', '..')), 'Claude cwd is outside the repository');
  assert.deepEqual(call1.files.filter((f: string) => !f.startsWith('evidence/')).sort(), ['finding.json', 'tutorial-numbered.txt', 'tutorial.md']);
  assert.ok(call1.files.every((f: string) => /^(finding\.json|tutorial\.md|tutorial-numbered\.txt|evidence\/original-step-\d+\.jpg)$/.test(f)));
  assert.deepEqual(findLeaks(call1.finding), []);
  assert.ok(!/AGENTS|DEMO_SCENARIO|PROJECT_BRIEF|private-domain|US_SECRET|test-manager|session_dir/.test(call1.finding), 'no answer key, project docs or private data in the package');
  // Kane's own failure reason (which names what it saw on the Dashboard) is legitimate
  // evidence; labels Kane never observed must not appear anywhere in the package.
  assert.ok(call1.finding.includes('kaneReason'));
  assert.ok(!/API Keys|Generate Key/.test(call1.finding), 'no route information Kane did not observe');
  assert.equal(existsSync(call1.cwd), false, 'temporary package folder removed after the call');
  assert.ok((await readdir(path.join(work, 'data', 'corrections', cid))).includes('package-1'), 'audit copy kept in data/');

  // A proposal is impossible before exploration (D4), even if Claude tries.
  await writeFile(path.join(work, 'answer-early.json'), JSON.stringify({ structured: { decision: 'proposal', rationale: 'guess', confidence: 'low', evidenceCited: [], edits: [{ line: 18, action: 'replace', newText: 'Click **Developer Settings**.' }], explorationQuestion: '' } }));
  process.env.FAKE_CLAUDE_ANSWER = path.join(work, 'answer-early.json');
  await post(`/api/corrections/${cid}/analyze`);
  c = await waitFor(() => correction(cid), (x) => x.state !== 'analyzing', 'early proposal');
  assert.equal(c.state, 'needs_exploration');
  assert.match(c.stateReason, /no Kane exploration has confirmed the route/i);
  assert.equal(await readFile(file, 'utf8'), originalText, 'file untouched');

  // 3. Kane exploration (fixed template; Claude's text never reaches Kane).
  process.env.FAKE_KANE_FIXTURE = await writeFixture('explore', { exitCode: 0, cliVersion: '0.10.5', progress: [], runEnd: { type: 'run_end', status: 'passed', reason_code: 'success.complete', final_state: { url: `${origin}/developer/api-keys` }, context: { memory: { start_page_heading: { query: 'the main heading of the starting page', extracted_value: 'Dashboard', reasoning: 'stored' }, ...OUTCOME_MEMORY } } } });
  process.env.FAKE_KANE_PACK = await writePack('explore', [
    { kind: 'navigate', status: 'passed', summary: `navigate: Navigate to ${appUrl}`, url: appUrl },
    { kind: 'analyze', status: 'passed', summary: 'analyze: the main heading of the starting page', url: appUrl },
    { kind: 'click', status: 'passed', summary: 'click: Clicking Developer Settings in the left navigation sidebar', url: appUrl },
    { kind: 'click', status: 'passed', summary: 'click: Clicking API Keys link', url: `${origin}/developer` },
    { kind: 'click', status: 'passed', summary: 'click: Clicking Generate Key button', url: `${origin}/developer/api-keys` },
    { kind: 'assert', status: 'passed', summary: "assert: the message 'API key generated successfully.' is visible", url: `${origin}/developer/api-keys` },
  ]);
  const ex = await post(`/api/corrections/${cid}/explore`);
  assert.equal(ex.status, 202);
  c = await waitFor(() => correction(cid), (x) => x.state !== 'exploring', 'exploration');
  assert.equal(c.state, 'route_confirmed', c.stateReason);
  const kaneArgs = JSON.parse(await readFile(path.join(work, 'kane-args.json'), 'utf8'));
  assert.match(kaneArgs.argv[1], /^You are exploring the web application at /);
  assert.ok(!kaneArgs.argv[1].includes('CLAUDE_CANARY'), "Claude's question never reaches Kane");
  const exploreRun = await runRec(c.explorationRunId);
  assert.equal(exploreRun.kind, 'exploration');
  assert.equal(exploreRun.classification.documentationDefect, false);

  // 4. Claude proposes with exploration evidence -> validated, cited, diffed.
  await writeFile(path.join(work, 'answer2.json'), JSON.stringify({ structured: { decision: 'proposal', rationale: 'Exploration clicked Developer Settings, API Keys, Generate Key.', confidence: 'high', evidenceCited: ['exploration steps 3-5'], edits: [{ line: 18, action: 'replace', newText: 'On the **Dashboard**, click **Developer Settings**.' }, { line: 19, action: 'replace', newText: 'Click **API Keys**.' }, { line: 20, action: 'replace', newText: 'Click **Generate Key**.' }], explorationQuestion: '' } }));
  process.env.FAKE_CLAUDE_ANSWER = path.join(work, 'answer2.json');
  await post(`/api/corrections/${cid}/analyze`);
  c = await waitFor(() => correction(cid), (x) => x.state !== 'analyzing', 'proposal');
  assert.equal(c.state, 'proposed', c.stateReason);
  assert.deepEqual(c.proposal.citations.map((x: { label: string; ordinal: number | null }) => [x.label, x.ordinal]), [['Dashboard', null], ['Developer Settings', 3], ['API Keys', 4], ['Generate Key', 5]]);
  assert.ok(c.proposal.diff.includes('-1. On the **Dashboard**, click **Settings**.') && c.proposal.diff.includes('+1. On the **Dashboard**, click **Developer Settings**.'));
  assert.equal(await readFile(file, 'utf8'), originalText, 'nothing written before approval');
  assert.deepEqual(findLeaks(c), []);

  // 5. Approve -> write (fingerprint-guarded) -> retest from the LIVE docs page.
  process.env.FAKE_KANE_FIXTURE = await writeFixture('retest', { exitCode: 0, cliVersion: '0.10.5', progress: [], runEnd: { type: 'run_end', status: 'passed', reason_code: 'success.complete', final_state: { url: `${origin}/developer/api-keys` }, context: { memory: OUTCOME_MEMORY } } });
  process.env.FAKE_KANE_PACK = await writePack('retest', [
    { kind: 'navigate', status: 'passed', summary: `navigate: Navigate to ${appUrl}`, url: appUrl },
    { kind: 'click', status: 'passed', summary: 'click: Clicking Developer Settings', url: appUrl },
    { kind: 'click', status: 'passed', summary: 'click: Clicking API Keys', url: `${origin}/developer` },
    { kind: 'click', status: 'passed', summary: 'click: Clicking Generate Key', url: `${origin}/developer/api-keys` },
  ]);
  assert.equal((await post(`/api/corrections/${cid}/retest`)).status, 409, 'cannot retest before approval');
  const runsBeforeApprove = ((await (await fetch(`${api}/api/runs`, { headers: { 'X-KaneVerity': '1' } })).json()) as unknown[]).length;
  assert.equal((await post(`/api/corrections/${cid}/approve`)).status, 202);
  const written = await readFile(file, 'utf8');
  assert.equal(sha(written), c.proposal.proposedSha256);
  const livePage = await (await fetch(`${docsUrl}tutorials/generate-an-api-key`)).text();
  assert.ok(livePage.includes(`data-source-sha256="${c.proposal.proposedSha256}"`), 'docs page now serves the approved document');
  // Approval only applies the document: no Kane run is started until the retest is confirmed separately.
  c = await correction(cid);
  assert.equal(c.state, 'applied', c.stateReason);
  assert.equal(c.retestRunId, null);
  assert.ok(c.appliedAt);
  const appliedEvents = c.log.filter((l: { event: string }) => l.event === 'applied');
  assert.equal(appliedEvents.length, 1, 'one application produces exactly one audit event');
  assert.match(appliedEvents[0].detail, new RegExp(`fingerprint ${c.proposal.proposedSha256.slice(0, 12)}`));
  assert.equal(((await (await fetch(`${api}/api/runs`, { headers: { 'X-KaneVerity': '1' } })).json()) as unknown[]).length, runsBeforeApprove, 'approve starts no Kane run');
  assert.equal((await post(`/api/corrections/${cid}/approve`)).status, 409, 'cannot approve twice');

  // AUDIT BUG: while a correction is applied, no second correction may start for the tutorial.
  const second = await post(`/api/runs/${runIds[0]}/corrections`);
  assert.equal(second.status, 409);
  assert.match((await j(second)).error, /already open/);

  // Discovery is refreshed after approval: it now shows the applied document and is current.
  const disc = await j(await fetch(`${api}/api/discovery`));
  assert.equal(disc.tutorials.find((t: { id: string }) => t.id === 'generate-an-api-key').sourceSha256, c.proposal.proposedSha256, 'discovery refreshed after approval');
  const fresh = await j(await fetch(`${api}/api/discovery/freshness`));
  assert.ok(fresh.tutorials.every((t: { status: string }) => t.status === 'current'), JSON.stringify(fresh.tutorials));

  // Recovery from not_verified: a first retest that fails leaves the issue open; a retest
  // may be tried again (separately confirmed), and both retests stay in the history.
  const passingRetest = process.env.FAKE_KANE_FIXTURE;
  process.env.FAKE_KANE_FIXTURE = await writeFixture('retest-fail', { exitCode: 1, cliVersion: '0.10.5', progress: [], runEnd: { type: 'run_end', status: 'failed', reason_code: 'assertion_error.step_not_achievable', summary: 'Could not finish.' } });
  assert.equal((await post(`/api/corrections/${cid}/retest`)).status, 202);
  c = await waitFor(() => correction(cid), (x) => x.state !== 'retesting', 'failing retest');
  assert.equal(c.state, 'not_verified', c.stateReason);
  const firstRetest = c.retestRunId;
  process.env.FAKE_KANE_FIXTURE = passingRetest;

  assert.equal((await post(`/api/corrections/${cid}/retest`)).status, 202, 'retest again from not_verified');
  assert.equal((await post(`/api/corrections/${cid}/retest`)).status, 409, 'a second retest request is refused');
  c = await waitFor(() => correction(cid), (x) => x.state !== 'retesting', 'retest');
  assert.equal(c.state, 'verified', c.stateReason);
  assert.deepEqual(c.retestRuns, [firstRetest, c.retestRunId], 'both retests kept in the history');
  assert.notEqual(firstRetest, c.retestRunId);
  assert.ok(c.verification.checks.every((x: { ok: boolean }) => x.ok));
  const retest = await runRec(c.retestRunId);
  assert.equal(retest.kind, 'retest');
  assert.ok(retest.objective.includes("1. On the 'Dashboard', click 'Developer Settings'."), 'retest built from the corrected docs as written');
  assert.ok((await readdir(path.join(work, 'data', 'corrections', cid))).some((f) => f.startsWith('backup-')), 'backup kept');

  // 6. Restoring a VERIFIED correction needs explicit confirmation (it invalidates VERIFIED).
  const corrected = await readFile(file, 'utf8');
  for (const body of [{}, { confirm: true }, { confirm: 'yes' }]) {
    const r = await post(`/api/corrections/${cid}/restore`, body);
    assert.equal(r.status, 409, JSON.stringify(body));
    assert.match((await j(r)).error, /VERIFIED/);
  }
  assert.equal(await readFile(file, 'utf8'), corrected, 'nothing restored without confirmation');
  assert.equal((await correction(cid)).state, 'verified');

  // Restore puts the original back (fingerprint-guarded) and invalidates VERIFIED.
  assert.equal((await post(`/api/corrections/${cid}/restore`, { confirm: 'invalidate-verified' })).status, 202);
  assert.equal(await readFile(file, 'utf8'), originalText);
  c = await correction(cid);
  assert.equal(c.state, 'restored');
  assert.match(c.stateReason, /VERIFIED result no longer applies/);
  assert.ok(c.verification.verified, 'the retest record itself is kept as history');
  assert.equal((await post(`/api/corrections/${cid}/restore`, { confirm: 'invalidate-verified' })).status, 409, 'cannot restore twice');
  const discAfter = await j(await fetch(`${api}/api/discovery`));
  assert.equal(discAfter.tutorials.find((t: { id: string }) => t.id === 'generate-an-api-key').sourceSha256, sha(originalText), 'discovery refreshed after restore');
  assert.equal((await post(`/api/corrections/${cid}/retest`)).status, 409, 'a restored correction cannot be retested');
});

test('exploration that recorded an unexpected origin -> route_uncertain, and Claude cannot be asked for a proposal (D4)', async () => {
  // New correction on a fresh FAILED run (the previous one is closed: restored).
  const origin = new URL(appUrl).origin;
  process.env.FAKE_KANE_FIXTURE = path.join(TESTS_DIR, 'fixtures', 'acmedesk-apikey-outdated.json');
  process.env.FAKE_KANE_PACK = await writePack('original2', [
    { kind: 'navigate', status: 'passed', summary: 'navigate', url: appUrl },
    { kind: '', status: 'failed', summary: "wait: locate the exact 'Settings' element", url: appUrl },
  ]);
  const { runIds } = await j(await post('/api/runs', { tutorialIds: ['generate-an-api-key'] }));
  await waitFor(() => runRec(runIds[0]), (r) => r.state === 'finished', 'run');
  process.env.FAKE_CLAUDE_ANSWER = path.join(work, 'answer1.json');
  const cid = (await j(await post(`/api/runs/${runIds[0]}/corrections`))).id;
  await waitFor(() => correction(cid), (x) => x.state !== 'analyzing', 'review');

  // Exploration that visited another origin: route NOT confirmed (detected after the run).
  process.env.FAKE_KANE_FIXTURE = await writeFixture('explore-bad', { exitCode: 0, cliVersion: '0.10.5', progress: [], runEnd: { type: 'run_end', status: 'passed', reason_code: 'success.complete', context: { memory: OUTCOME_MEMORY } } });
  process.env.FAKE_KANE_PACK = await writePack('explore-bad', [
    { kind: 'navigate', status: 'passed', summary: 'navigate', url: appUrl },
    { kind: 'click', status: 'passed', summary: 'click: Clicking Developer Settings', url: 'https://elsewhere.example/' },
    { kind: 'click', status: 'passed', summary: 'click: Clicking API Keys', url: `${origin}/developer` },
  ]);
  await post(`/api/corrections/${cid}/explore`);
  let c = await waitFor(() => correction(cid), (x) => x.state !== 'exploring', 'exploration');
  assert.equal(c.state, 'route_uncertain');
  assert.match(c.stateReason, /no unexpected origin/i);

  // Claude can't get a proposal through: D4 holds.
  process.env.FAKE_CLAUDE_ANSWER = path.join(work, 'answer2.json');
  const r = await post(`/api/corrections/${cid}/analyze`);
  assert.equal(r.status, 409, 'route_uncertain does not allow asking Claude for a proposal');
  c = await correction(cid);
  assert.equal(c.state, 'route_uncertain');

  // Exploration estimate: an exploration that did agent work but got no Kane-reported
  // cost (timeout) records the EXPLORATION estimate (upper bound of 20-40), labelled as
  // an estimate; no actual cost is invented. The route stays uncertain.
  const h0 = await j(await fetch(`${api}/api/health`));
  assert.deepEqual(h0.credits.estimatedByKind.exploration, [20, 40]);
  process.env.FAKE_KANE_FIXTURE = await writeFixture('explore-timeout', { exitCode: 3, cliVersion: '0.10.5', progress: [{ step: 2, status: 'running', remark: 'Step 1' }], runEnd: null });
  process.env.FAKE_KANE_PACK = '';
  assert.equal((await post(`/api/corrections/${cid}/explore`)).status, 202, 'route_uncertain may explore again');
  c = await waitFor(() => correction(cid), (x) => x.state !== 'exploring', 'timed-out exploration');
  assert.equal(c.state, 'route_uncertain');
  const ex = await runRec(c.explorationRunId);
  assert.equal(ex.kind, 'exploration');
  assert.equal(ex.credits, null, 'no actual cost invented');
  assert.equal(ex.costBasis, 'estimated');
  assert.equal(ex.estimatedCredits, 40, 'exploration estimate, not the verification estimate');
  const h1 = await j(await fetch(`${api}/api/health`));
  assert.equal(h1.credits.runsEstimated, h0.credits.runsEstimated + 1);
  assert.equal(h1.credits.estimatedCredits, h0.credits.estimatedCredits + 40);
  assert.equal(h1.credits.reportedCredits, h0.credits.reportedCredits, 'reported (actual) total unchanged by an estimate');
});

test('exploration modes: allow-listed, recorded on the run, in the audit trail and in Claude\'s package; re-exploring keeps earlier explorations', async () => {
  const origin = new URL(appUrl).origin;
  const list = await j(await fetch(`${api}/api/corrections`));
  const target = list.find((x: { state: string }) => x.state === 'route_uncertain');
  assert.ok(target, 'a route_uncertain correction from the previous test');
  const cid = target.id;
  const before = await correction(cid);
  const earlierRuns = before.explorations.map((e: { runId: string }) => e.runId);
  assert.ok(earlierRuns.length >= 2);

  // Only allow-listed modes.
  for (const bad of ['sidebar', '__proto__', 'constructor', 42]) {
    const r = await post(`/api/corrections/${cid}/explore`, { mode: bad });
    assert.equal(r.status, 400, `mode ${String(bad)}`);
  }
  assert.equal((await correction(cid)).state, 'route_uncertain', 'rejected modes start nothing');

  // Health lists the modes with their exact fixed rule.
  const h = await j(await fetch(`${api}/api/health`));
  assert.deepEqual(h.explorationModes.map((m: { id: string }) => m.id), ['default', 'main-navigation']);
  const rule = h.explorationModes.find((m: { id: string }) => m.id === 'main-navigation').rule;

  // main-navigation exploration (sidebar route evidence).
  process.env.FAKE_KANE_FIXTURE = await writeFixture('explore-sidebar', { exitCode: 0, cliVersion: '0.10.5', progress: [], runEnd: { type: 'run_end', status: 'passed', reason_code: 'success.complete', context: { memory: { start_page_heading: { query: 'the main heading of the starting page', extracted_value: 'Dashboard', reasoning: 'stored' }, ...OUTCOME_MEMORY } } } });
  process.env.FAKE_KANE_PACK = await writePack('explore-sidebar', [
    { kind: 'navigate', status: 'passed', summary: `navigate: Navigate to ${appUrl}`, url: appUrl },
    { kind: 'analyze', status: 'passed', summary: 'analyze: the main heading of the starting page', url: appUrl },
    { kind: 'click', status: 'passed', summary: 'click: Clicking Developer Settings in the main navigation menu', url: appUrl },
    { kind: 'click', status: 'passed', summary: 'click: Clicking API Keys link', url: `${origin}/developer` },
    { kind: 'click', status: 'passed', summary: 'click: Clicking Generate Key button', url: `${origin}/developer/api-keys` },
  ]);
  assert.equal((await post(`/api/corrections/${cid}/explore`, { mode: 'main-navigation' })).status, 202);
  let c = await waitFor(() => correction(cid), (x) => x.state !== 'exploring', 'main-navigation exploration');
  assert.equal(c.state, 'route_confirmed', c.stateReason);
  const navRun = await runRec(c.explorationRunId);
  assert.equal(navRun.kind, 'exploration');
  assert.equal(navRun.explorationMode, 'main-navigation');
  const kaneArgs = JSON.parse(await readFile(path.join(work, 'kane-args.json'), 'utf8'));
  const objLines: string[] = kaneArgs.argv[1].split('\n');
  assert.equal(objLines.filter((l) => l === rule).length, 1, 'Kane received the fixed rule exactly once');
  assert.ok(!/Developer Settings|Generate Key/.test(rule), 'the rule names no app labels');
  assert.deepEqual(c.explorations.map((e: { runId: string }) => e.runId).slice(0, earlierRuns.length), earlierRuns, 'earlier explorations kept in the history');
  assert.equal(c.explorations.at(-1).mode, 'main-navigation');
  assert.equal(c.explorations.at(-1).confirmed, true);
  assert.equal(c.exploration.mode, 'main-navigation');
  assert.ok(c.log.some((l: { event: string; detail: string }) => l.event === 'exploration_started' && /main-navigation/.test(l.detail)), 'audit log records the mode');
  for (const id of earlierRuns) assert.equal((await runRec(id)).runId, id, `earlier exploration ${id} still retrievable`);

  // Claude's package names the mode and its exact rule.
  process.env.FAKE_CLAUDE_ANSWER = path.join(work, 'answer1.json');
  await post(`/api/corrections/${cid}/analyze`);
  c = await waitFor(() => correction(cid), (x) => x.state !== 'analyzing', 'review with mode');
  const call = JSON.parse(await readFile(path.join(work, 'claude-args.json'), 'utf8'));
  const finding = JSON.parse(call.finding);
  assert.equal(finding.explorationEvidence.runId, navRun.runId);
  assert.equal(finding.explorationEvidence.explorationMode, 'main-navigation');
  assert.equal(finding.explorationEvidence.explorationModeLabel, 'Explore using the main navigation menu');
  assert.equal(finding.explorationEvidence.explorationModeRule, rule);

  // Re-exploring is allowed from route_confirmed too (state machine), with the default mode.
  process.env.FAKE_CLAUDE_ANSWER = path.join(work, 'answer1.json');
  const fromState = c.state; // needs_exploration after the fake review
  assert.equal((await post(`/api/corrections/${cid}/explore`, {})).status, 202, `explore from ${fromState} without a mode uses default`);
  c = await waitFor(() => correction(cid), (x) => x.state !== 'exploring', 'default exploration');
  assert.equal((await runRec(c.explorationRunId)).explorationMode, 'default');
  assert.equal(c.state, 'route_confirmed');
  assert.equal((await post(`/api/corrections/${cid}/explore`, { mode: 'main-navigation' })).status, 202, 'explore again from route_confirmed');
  c = await waitFor(() => correction(cid), (x) => x.state !== 'exploring', 'second main-navigation exploration');
  assert.equal(c.explorations.length, earlierRuns.length + 3);
  assert.deepEqual(findLeaks(c), []);
});

test('correction API: only documentation defects, ids validated, foreign origins refused', async () => {
  const runs = await j(await fetch(`${api}/api/runs`));
  const exploration = runs.find((r: { kind: string }) => r.kind === 'exploration');
  assert.equal((await post(`/api/runs/${exploration.runId}/corrections`)).status, 422);
  assert.equal((await fetch(`${api}/api/corrections/..%2F..%2Fcredits`)).status, 404);
  assert.equal((await fetch(`${api}/api/corrections/c00000000-000000-abcdef`)).status, 404);
  assert.equal((await fetch(`${api}/api/corrections`, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${api}/api/corrections/c00000000-000000-abcdef/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403, 'missing X-KaneVerity');
  const list = await j(await fetch(`${api}/api/corrections`));
  assert.deepEqual(findLeaks(list), []);
  assert.ok(!/\.evidence\b|[\\/]private[\\/]|kaneverity-claude-/i.test(JSON.stringify(list)), 'no paths in correction records');
  void loadFixture;
});

test('recovery from error: an error state stays open, Claude can be asked again, or the correction can be closed', async () => {
  const list = await j(await fetch(`${api}/api/corrections`));
  const target = list.find((x: { state: string }) => x.state === 'route_confirmed');
  assert.ok(target, 'a route_confirmed correction from the previous test');
  const cid = target.id;

  // An invalid Claude answer stops the review with an error.
  await writeFile(path.join(work, 'answer-bad.json'), JSON.stringify({ structured: { decision: 'bogus' } }));
  process.env.FAKE_CLAUDE_ANSWER = path.join(work, 'answer-bad.json');
  assert.equal((await post(`/api/corrections/${cid}/analyze`)).status, 202);
  let c = await waitFor(() => correction(cid), (x) => x.state !== 'analyzing', 'bad review');
  assert.equal(c.state, 'error', c.stateReason);

  // 'error' is still open: no second correction may start for this tutorial.
  const failed = (await j(await fetch(`${api}/api/runs`))).find((r: { classification?: { status: string; documentationDefect: boolean }; kind: string }) => r.kind === 'verification' && r.classification?.status === 'FAILED');
  const dup = await post(`/api/runs/${failed.runId}/corrections`);
  assert.equal(dup.status, 409);
  assert.match((await j(dup)).error, /already open/);

  // Recovery 1: ask Claude again.
  process.env.FAKE_CLAUDE_ANSWER = path.join(work, 'answer1.json');
  assert.equal((await post(`/api/corrections/${cid}/analyze`)).status, 202, 'Claude may be asked again from error');
  c = await waitFor(() => correction(cid), (x) => x.state !== 'analyzing', 'retry review');
  assert.equal(c.state, 'needs_exploration');

  // Recovery 2: close it (only from error). Nothing is written to the documentation.
  assert.equal((await post(`/api/corrections/${cid}/dismiss`)).status, 409, 'only an error can be closed');
  process.env.FAKE_CLAUDE_ANSWER = path.join(work, 'answer-bad.json');
  await post(`/api/corrections/${cid}/analyze`);
  c = await waitFor(() => correction(cid), (x) => x.state !== 'analyzing', 'bad review 2');
  assert.equal(c.state, 'error');
  const file = path.join(contentDir, 'tutorials', 'generate-an-api-key.md');
  const before = await readFile(file, 'utf8');
  assert.equal((await post(`/api/corrections/${cid}/dismiss`)).status, 202);
  c = await correction(cid);
  assert.equal(c.state, 'closed');
  assert.equal(await readFile(file, 'utf8'), before, 'closing changes no documentation');
  assert.equal((await post(`/api/corrections/${cid}/analyze`)).status, 409, 'a closed correction is final');
});

test('AUDIT BUG: stale discovery blocks verification runs until discovery is refreshed', async () => {
  const file = path.join(contentDir, 'tutorials', 'create-a-project.md');
  const original = await readFile(file, 'utf8');
  assert.equal((await post('/api/discover')).status, 200);
  const runsBefore = (await j(await fetch(`${api}/api/runs`))).length;
  try {
    // The docs change after discovery (here: an extra step), as an approved correction would.
    await writeFile(file, original.replace('4. Click **Create project**.', '4. Click **Create project**.\n5. Click **Done**.'));
    const r = await post('/api/runs', { tutorialIds: ['create-a-project'] });
    assert.equal(r.status, 409);
    const msg = (await j(r)).error;
    assert.match(msg, /"Create a project" was not verified: The live documentation changed since discovery/);
    assert.match(msg, /Discover again/);
    assert.match(msg, /Nothing was run/);
    assert.equal((await j(await fetch(`${api}/api/runs`))).length, runsBefore, 'no run was queued');

    const fresh = await j(await fetch(`${api}/api/discovery/freshness`));
    const byId = Object.fromEntries(fresh.tutorials.map((t: { id: string; status: string }) => [t.id, t.status]));
    assert.equal(byId['create-a-project'], 'stale');
    assert.equal(byId['generate-an-api-key'], 'current');

    // Safe refresh path: Discover again, then the run may start.
    assert.equal((await post('/api/discover')).status, 200);
    assert.equal((await j(await fetch(`${api}/api/discovery/freshness`))).tutorials.find((t: { id: string }) => t.id === 'create-a-project').status, 'current');
    process.env.FAKE_KANE_FIXTURE = path.join(TESTS_DIR, 'fixtures', 'acmedesk-apikey-outdated.json');
    const ok = await post('/api/runs', { tutorialIds: ['create-a-project'] });
    assert.equal(ok.status, 202);
    const [rid] = (await j(ok)).runIds;
    const run = await waitFor(() => runRec(rid), (x) => x.state === 'finished', 'run after refresh');
    assert.equal(run.tutorial.steps.length, 5, 'the run used the refreshed tutorial');
  } finally {
    await writeFile(file, original);
    await post('/api/discover');
  }

  // Unreadable live documentation: the check reports it as unavailable, never current.
  const { checkFreshness } = await import('../src/discovery/freshness.ts');
  const unreachable = await checkFreshness(
    { id: 'x', title: 'X', url: 'http://127.0.0.1:9/tutorials/x', appStart: '/', method: 'data-kv', sourceSha256: 'a'.repeat(64), steps: [], outcomes: [], warnings: [], notRunnable: null },
    { docsUrl: 'http://127.0.0.1:9/', docsOrigin: 'http://127.0.0.1:9', appUrl, appOrigin: new URL(appUrl).origin, savedAt: '' },
  );
  assert.equal(unreachable.status, 'unavailable');
  assert.match(unreachable.reason ?? '', /could not be read/);
});
