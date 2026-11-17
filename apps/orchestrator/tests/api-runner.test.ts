// End-to-end orchestrator test with a FAKE Kane CLI (no credits are used).
// Covers API security, the MVP origin allow-list, discovery, queueing, Kane
// invocation (no shell), evidence handling, classification, redaction,
// screenshot policy and the credit limit.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDocsServer } from '../../docs/server.ts';
import { makeZip, TESTS_DIR, TINY_JPEG } from './helpers.ts';

let docs: Server;
let app: Server;
let orch: Server;
let docsUrl: string;
let appUrl: string;
let api: string;
let dataDir: string;
let argsOut: string;
let findLeaks: (v: unknown) => string[];
let appUp = true;

const listen = (s: Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

before(async () => {
  docs = createDocsServer();
  docsUrl = (await listen(docs)) + '/';
  app = createServer((_req, res) => {
    if (!appUp) {
      res.writeHead(503);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>AcmeDesk</title>');
  });
  appUrl = (await listen(app)) + '/';
  const appOrigin = new URL(appUrl).origin;

  dataDir = await mkdtemp(path.join(os.tmpdir(), 'kv-orch-'));
  argsOut = path.join(dataDir, 'fake-args.json');
  const pack = path.join(dataDir, 'fake.evidence');
  const T = 'tests/kv-generate-an-api-key-abc123';
  await writeFile(
    pack,
    makeZip([
      { name: `${T}/steps/1-0-1/step.json`, data: JSON.stringify({ ordinal: 1, kind: 'navigate', status: 'passed', summary: `navigate: Navigate to ${appUrl}`, url: appUrl }) },
      { name: `${T}/steps/2-0-2/step.json`, data: JSON.stringify({ ordinal: 2, kind: '', status: 'failed', summary: "wait: Waiting locate the exact 'Settings' element on the Dashboard", url: appUrl }) },
      // No URL recorded for this step: its screenshot can't be shown to be on the app, so it must be withheld.
      { name: `${T}/steps/3-0-3/step.json`, data: JSON.stringify({ ordinal: 3, kind: 'wait', status: 'passed', summary: 'wait' }) },
      { name: `${T}/steps/1-0-1/screenshot.jpg`, data: TINY_JPEG },
      { name: `${T}/steps/2-0-2/screenshot.jpg`, data: TINY_JPEG },
      { name: `${T}/steps/3-0-3/screenshot.jpg`, data: TINY_JPEG },
      { name: `${T}/steps/2-0-2/failure.yaml`, data: "error:\n  message: No exact 'Settings' element.\ntitle: Settings locator no longer matches\n" },
      { name: `${T}/result.yaml`, data: 'status: failed\nuser_email: owner@private-domain.test\n' },
      { name: '../../outside.txt', data: 'should be ignored' },
    ]),
  );

  Object.assign(process.env, {
    KANEVERITY_DATA_DIR: dataDir,
    KANE_CLI_ENTRY: path.join(TESTS_DIR, 'fake-kane.cjs'),
    KANEVERITY_ALLOWED_DOCS_ORIGINS: new URL(docsUrl).origin,
    KANEVERITY_ALLOWED_APP_ORIGINS: appOrigin,
    KANEVERITY_CREDIT_LIMIT: '100',
    FAKE_KANE_FIXTURE: path.join(TESTS_DIR, 'fixtures', 'acmedesk-apikey-outdated.json'),
    FAKE_KANE_PACK: pack,
    FAKE_KANE_ARGS_OUT: argsOut,
  });
  // Import after env is set: config reads it at load time.
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const j = async (r: Response): Promise<any> => r.json();
const ledgerNow = async (): Promise<{ credits: number }[]> => {
  try {
    return JSON.parse(await readFile(path.join(dataDir, 'credits.json'), 'utf8'));
  } catch {
    return [];
  }
};
const H = { 'Content-Type': 'application/json', 'X-KaneVerity': '1' };
const post = (p: string, body: unknown, headers: Record<string, string> = H) => fetch(api + p, { method: 'POST', headers, body: JSON.stringify(body) });

async function waitFinished(runId: string): Promise<Record<string, any>> {
  for (let i = 0; i < 100; i++) {
    const r = await j(await fetch(`${api}/api/runs/${runId}`));
    if (r.state === 'finished') return r;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('run did not finish');
}

/** Raw request so we can send a forged Host header (fetch does not allow it). */
function rawGet(p: string, host: string): Promise<number> {
  const u = new URL(api);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path: p, headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

test('security: mutating requests need the custom header, JSON, and an allowed Origin', async () => {
  assert.equal((await post('/api/project', {}, { 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await post('/api/project', {}, { ...H, Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/project', {}, { 'X-KaneVerity': '1', 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('/api/project', { big: 'x'.repeat(70_000) })).status, 413);
  assert.equal(await rawGet('/api/health', 'evil.example:4000'), 421, 'DNS-rebinding Host is rejected');
  assert.equal((await fetch(api + '/api/health')).headers.get('access-control-allow-origin'), null, 'no CORS');
  // Reads are refused too when a foreign browser Origin is present.
  assert.equal((await fetch(api + '/api/health', { headers: { Origin: 'http://127.0.0.1:5174' } })).status, 403);
  assert.equal((await fetch(api + '/api/runs', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(api + '/api/health', { headers: { Origin: 'http://127.0.0.1:5173' } })).status, 200, 'the UI origin is allowed');
});

test('MVP scope: only the allow-listed local demo origins can be connected', async () => {
  const r = await post('/api/project', { docsUrl: 'https://docs.thirdparty.example/', appUrl: 'https://app.thirdparty.example/' });
  assert.equal(r.status, 400);
  assert.match((await j(r)).error, /controlled local demo.*not supported for live execution yet/);
  assert.equal((await post('/api/project', { docsUrl: 'file:///etc/passwd', appUrl })).status, 400);
  assert.equal((await post('/api/project', { docsUrl: '', appUrl })).status, 400);
});

test('health reports Kane login via exit code only (identity never returned) and the credit budget', async () => {
  const h = await j(await fetch(api + '/api/health'));
  assert.equal(h.kane.loggedIn, true);
  assert.equal('balance' in h.kane, false, 'the TestMu account balance is never sent to the UI');
  assert.ok(!JSON.stringify(h).includes('999'));
  assert.deepEqual(Object.keys(h.credits).sort(), ['available', 'limit', 'reserved', 'spent']);
  assert.equal(h.credits.limit, 100);
  assert.deepEqual(findLeaks(h), []);
  assert.ok(!JSON.stringify(h).includes('someone@'));
});

test('full flow: connect, discover, run outdated API-key tutorial -> FAILED at step 1 with private data redacted', async () => {
  assert.equal((await post('/api/project', { docsUrl, appUrl })).status, 200);
  const d = await j(await post('/api/discover', {}));
  assert.equal(d.tutorials.length, 4);

  const start = await post('/api/runs', { tutorialIds: ['generate-an-api-key'] });
  assert.equal(start.status, 202);
  const { runIds } = await j(start);
  const run = await waitFinished(runIds[0]);

  // Classification
  assert.equal(run.classification.status, 'FAILED');
  assert.equal(run.classification.failedStep, 1);
  assert.equal(run.classification.documentationDefect, true);

  // Kane invocation: node + entry (no shell), exact objective, app start URL, own working dir.
  const { argv, cwd } = JSON.parse(await readFile(argsOut, 'utf8'));
  assert.equal(argv[0], 'run');
  assert.match(argv[1], /^You are verifying documentation for the web application at /);
  assert.ok(argv[1].includes("1. On the 'Dashboard', click 'Settings'."));
  assert.ok(argv[1].includes("Assert that: The key count below the list shows '2 keys'."));
  assert.equal(argv[argv.indexOf('--url') + 1], appUrl);
  assert.ok(argv.includes('--agent') && argv.includes('--headless'));
  assert.ok(path.resolve(cwd).startsWith(path.resolve(dataDir)));

  // Privacy: no email, share link, local path or account fields in the public record or files.
  assert.deepEqual(findLeaks(run), []);
  const pubText = await readFile(path.join(dataDir, 'runs', runIds[0], 'public.json'), 'utf8');
  assert.deepEqual(findLeaks(pubText), []);
  assert.ok(!pubText.includes('private-domain'));
  assert.ok(!pubText.includes('US_SECRET'));
  assert.ok(run.warnings.some((w: string) => /unreadable output line/.test(w)));

  // No evidence pack paths anywhere in the UI record: a safe run reference and validation status only.
  assert.equal(run.evidence.runReference, runIds[0]);
  assert.equal('reference' in run.evidence, false);
  assert.ok(!/\.evidence\b|private[\\/]|[\\/]work[\\/]|data[\\/]runs/i.test(JSON.stringify(run)), 'no file paths in the public record');
  assert.deepEqual(run.evidence.kaneValidation, { status: 'valid', packStatus: 'finalized', warnings: 1, errors: 0 });

  // The runs list and the live event stream use the same redacted record.
  const list = await j(await fetch(`${api}/api/runs`));
  assert.ok(list.some((r: { runId: string }) => r.runId === runIds[0]));
  assert.deepEqual(findLeaks(list), []);
  assert.ok(!/\.evidence\b|private[\\/]/i.test(JSON.stringify(list)));
  const ctrl = new AbortController();
  const sse = await fetch(`${api}/api/runs/${runIds[0]}/events`, { signal: ctrl.signal });
  assert.equal(sse.headers.get('content-type'), 'text/event-stream');
  const reader = sse.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value).split('\n\n')[0];
  ctrl.abort();
  assert.match(first, /^data: \{/);
  const event = JSON.parse(first.slice(6).trim());
  assert.equal(event.runId, runIds[0]);
  assert.equal(event.classification.status, 'FAILED');
  assert.deepEqual(findLeaks(event), []);

  // Evidence: unexpected archive entry ignored; nothing written outside the run folder.
  assert.ok(run.evidence.problems.some((p: string) => /unexpected entr/.test(p)));
  assert.equal(existsSync(path.join(dataDir, 'outside.txt')), false);
  assert.equal(existsSync(path.join(dataDir, 'runs', runIds[0], 'outside.txt')), false);

  // Screenshots: published only for steps on the app origin; others withheld and kept private.
  assert.deepEqual(run.evidence.screenshots.map((s: { file: string }) => s.file).sort(), ['1.jpg', '2.jpg']);
  assert.equal(run.evidence.withheldScreenshots, 1);
  assert.equal((await fetch(`${api}/api/runs/${runIds[0]}/screens/2.jpg`)).headers.get('content-type'), 'image/jpeg');
  assert.equal((await fetch(`${api}/api/runs/${runIds[0]}/screens/3.jpg`)).status, 404, 'withheld screenshot not served');
  assert.ok((await readdir(path.join(dataDir, 'runs', runIds[0], 'private', 'screens'))).includes('3.jpg'), 'raw copy kept privately');

  // Private files are never reachable through the API.
  for (const p of ['private/run.json', 'private/kane.ndjson', 'private/evidence.evidence', 'screens/..%2Fprivate%2Frun.json', 'screens/..%2F..%2Fcredits.json', 'screens/1.png']) {
    assert.equal((await fetch(`${api}/api/runs/${runIds[0]}/${p}`)).status, 404, p);
  }

  // Credits: actual Kane credits recorded in the ledger.
  const ledger = JSON.parse(await readFile(path.join(dataDir, 'credits.json'), 'utf8'));
  assert.equal(ledger.length, 1);
  assert.ok(ledger[0].credits > 0 && ledger[0].credits < 35);
});

test('credit limit: requests that could exceed the 100-credit limit are refused before Kane starts', async () => {
  const r = await post('/api/runs', { tutorialIds: ['create-a-project', 'invite-a-team-member', 'configure-workspace-settings'] });
  assert.equal(r.status, 409);
  assert.match((await j(r)).error, /Credit limit/);
});

test('a run whose evidence shows a visit outside the app is NEEDS_REVIEW, not a documentation defect', async () => {
  const pack = path.join(dataDir, 'offorigin.evidence');
  const T = 'tests/kv-generate-an-api-key-def456';
  await writeFile(
    pack,
    makeZip([
      { name: `${T}/steps/1-0-1/step.json`, data: JSON.stringify({ ordinal: 1, kind: 'navigate', status: 'passed', summary: 'navigate', url: 'https://elsewhere.example/' }) },
      { name: `${T}/steps/2-0-2/step.json`, data: JSON.stringify({ ordinal: 2, kind: '', status: 'failed', summary: "wait: locate the exact 'Settings' element", url: appUrl }) },
      { name: `${T}/steps/1-0-1/screenshot.jpg`, data: TINY_JPEG },
    ]),
  );
  const prev = process.env.FAKE_KANE_PACK;
  process.env.FAKE_KANE_PACK = pack;
  try {
    const { runIds } = await j(await post('/api/runs', { tutorialIds: ['generate-an-api-key'] }));
    const run = await waitFinished(runIds[0]);
    assert.equal(run.classification.status, 'NEEDS_REVIEW');
    assert.equal(run.classification.code, 'left_app_origin');
    assert.equal(run.classification.documentationDefect, false);
    assert.equal(run.evidence.screenshots.length, 0, 'off-origin screenshot is withheld');
    assert.equal(run.evidence.withheldScreenshots, 1);
  } finally {
    process.env.FAKE_KANE_PACK = prev;
  }
});

test('Kane setup error (exit 2, no agent work) -> BLOCKED and 0 credits recorded', async () => {
  const before = (await ledgerNow()).length;
  const fx = path.join(dataDir, 'setup-error.json');
  await writeFile(fx, JSON.stringify({ exitCode: 2, cliVersion: '0.10.5', progress: [], runEnd: null }));
  const prev = process.env.FAKE_KANE_FIXTURE;
  process.env.FAKE_KANE_FIXTURE = fx;
  try {
    const { runIds } = await j(await post('/api/runs', { tutorialIds: ['generate-an-api-key'] }));
    const run = await waitFinished(runIds[0]);
    assert.equal(run.classification.status, 'BLOCKED');
    assert.equal(run.classification.code, 'kane_setup_error');
    const ledger = await ledgerNow();
    assert.equal(ledger.length, before + 1);
    assert.equal(ledger[ledger.length - 1].credits, 0);
  } finally {
    process.env.FAKE_KANE_FIXTURE = prev;
  }
});

test('unknown tutorial ids and malformed run ids are rejected', async () => {
  assert.equal((await post('/api/runs', { tutorialIds: ['nope'] })).status, 404);
  assert.equal((await post('/api/runs', { tutorialIds: 'generate-an-api-key' })).status, 400);
  assert.equal((await fetch(`${api}/api/runs/..%2F..%2Fcredits`)).status, 404);
  assert.equal((await fetch(`${api}/api/runs/r00000000-000000-zzzzzz`)).status, 404);
});

test('app unreachable at run time -> BLOCKED, Kane never started, no credits used', async () => {
  const ledgerBefore = JSON.parse(await readFile(path.join(dataDir, 'credits.json'), 'utf8')).length;
  appUp = false;
  await writeFile(argsOut, '{}');
  const { runIds } = await j(await post('/api/runs', { tutorialIds: ['generate-an-api-key'] }));
  const run = await waitFinished(runIds[0]);
  appUp = true;
  assert.equal(run.classification.status, 'BLOCKED');
  assert.equal(run.classification.documentationDefect, false);
  assert.equal(await readFile(argsOut, 'utf8'), '{}', 'Kane was not invoked');
  const ledger = JSON.parse(await readFile(path.join(dataDir, 'credits.json'), 'utf8'));
  assert.equal(ledger.length, ledgerBefore, 'no ledger entry for a run that never started');
});
