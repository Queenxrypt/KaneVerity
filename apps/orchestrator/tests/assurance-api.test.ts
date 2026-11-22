// Assurance B1 API: requirements preview, generation, versions and stale detection.
// Runs against a temporary docs copy and data folder. No Kane command may run.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDocsServer } from '../../docs/server.ts';
import { outdatedDocsContent, TESTS_DIR } from './helpers.ts';

let docs: Server;
let app: Server;
let orch: Server;
let api: string;
let docsUrl: string;
let appUrl: string;
let work: string;
let contentDir: string;
const listen = (s: Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const j = async (r: Response): Promise<any> => r.json();
const H = { 'Content-Type': 'application/json', 'X-KaneVerity': '1' };
const get = (p: string) => fetch(api + p);
const post = (p: string, body: unknown = {}, headers: Record<string, string> = H) => fetch(api + p, { method: 'POST', headers, body: JSON.stringify(body) });
const R = '/api/assurance/requirements';

before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), 'kv-assurance-'));
  contentDir = await outdatedDocsContent();
  docs = createDocsServer(contentDir);
  docsUrl = (await listen(docs)) + '/';
  app = createServer((_q, s) => {
    s.writeHead(200, { 'Content-Type': 'text/html' });
    s.end('<!doctype html><title>AcmeDesk</title>');
  });
  appUrl = (await listen(app)) + '/';
  Object.assign(process.env, {
    KANEVERITY_DATA_DIR: path.join(work, 'data'),
    KANE_CLI_ENTRY: path.join(TESTS_DIR, 'fake-kane.cjs'),
    KANEVERITY_CLAUDE_EXE: path.join(TESTS_DIR, 'fake-claude.cjs'),
    KANEVERITY_DOCS_CONTENT_DIR: contentDir,
    KANEVERITY_ALLOWED_DOCS_ORIGINS: new URL(docsUrl).origin,
    KANEVERITY_ALLOWED_APP_ORIGINS: new URL(appUrl).origin,
    // If any Kane or Claude process were started, these files would appear.
    FAKE_KANE_ARGS_OUT: path.join(work, 'kane-args.json'),
    FAKE_CLAUDE_ARGS_OUT: path.join(work, 'claude-args.json'),
  });
  const { createOrchestrator } = await import('../server.ts');
  orch = createOrchestrator();
  api = await listen(orch);
});

after(() => {
  docs.close();
  app.close();
  orch.close();
});

test('requirements before a project is connected: a clear 409, nothing written', async () => {
  const r = await get(R);
  assert.equal(r.status, 409);
  assert.match((await j(r)).error, /Connect a project/);
});

test('generate, preview, versions, stale detection and regeneration', async () => {
  assert.equal((await post('/api/project', { docsUrl, appUrl })).status, 200);
  assert.equal((await post('/api/discover')).status, 200);

  // Nothing generated yet: every tutorial is "none"; a preview is available.
  const list = await j(await get(R));
  assert.deepEqual(list.map((x: { tutorialId: string; state: string }) => [x.tutorialId, x.state]).sort(), [
    ['configure-workspace-settings', 'none'],
    ['create-a-project', 'none'],
    ['generate-an-api-key', 'none'],
    ['invite-a-team-member', 'none'],
  ]);
  let d = await j(await get(`${R}/generate-an-api-key`));
  assert.equal(d.state, 'none');
  assert.equal(d.shown, null);
  assert.equal(d.canGenerate, true);
  assert.ok(d.preview.markdown.includes("S1. On the 'Dashboard', click 'Settings'."));
  assert.equal(d.preview.lineMap[0].source.line, 18);

  // Generate: version 1, and the stored bytes are exactly the preview.
  let r = await post(`${R}/generate-an-api-key`);
  assert.equal(r.status, 201);
  const g1 = await j(r);
  assert.equal(g1.status, 'created');
  assert.equal(g1.version.version, 1);
  d = await j(await get(`${R}/generate-an-api-key`));
  assert.equal(d.state, 'current', JSON.stringify(d.reasons));
  assert.equal(d.shown.version, 1);
  assert.equal(d.shown.intact, true);
  assert.equal(d.shown.isLatest, true);
  assert.equal(d.preview, null, 'nothing new to generate');
  const v1Markdown = d.shown.markdown;

  // Generating again from unchanged documentation keeps version 1.
  r = await post(`${R}/generate-an-api-key`);
  assert.equal(r.status, 200);
  assert.equal((await j(r)).status, 'unchanged');

  // The documentation changes on the live site: requirements become stale and
  // can't be regenerated until discovery is refreshed (same rule as runs).
  const file = path.join(contentDir, 'tutorials', 'generate-an-api-key.md');
  const original = await readFile(file, 'utf8');
  await writeFile(file, original.replace('3. Click **Create API Key**.', '3. Click **Generate Key**.'));
  d = await j(await get(`${R}/generate-an-api-key`));
  assert.equal(d.state, 'stale');
  assert.match(d.reasons.join(' '), /live documentation changed since discovery/);
  assert.equal(d.canGenerate, false);
  assert.equal(d.preview, null, 'no preview from out-of-date discovery');
  r = await post(`${R}/generate-an-api-key`);
  assert.equal(r.status, 409);
  assert.match((await j(r)).error, /Discover again/);

  // After discovery: still stale (version 1 was made from the old documentation), preview offered.
  assert.equal((await post('/api/discover')).status, 200);
  d = await j(await get(`${R}/generate-an-api-key`));
  assert.equal(d.state, 'stale');
  assert.match(d.reasons.join(' '), /Version 1 was generated from documentation [a-f0-9]{12}; the documentation is now [a-f0-9]{12}/);
  assert.ok(d.preview.markdown.includes("S3. Click 'Generate Key'."));

  // Regenerate: version 2 supersedes 1; version 1 is kept byte for byte.
  r = await post(`${R}/generate-an-api-key`);
  assert.equal(r.status, 201);
  const g2 = await j(r);
  assert.equal(g2.version.version, 2);
  assert.equal(g2.version.supersedes, 1);
  d = await j(await get(`${R}/generate-an-api-key`));
  assert.equal(d.state, 'current');
  assert.deepEqual(d.versions.map((v: { version: number }) => v.version), [1, 2]);
  const old = await j(await get(`${R}/generate-an-api-key?version=1`));
  assert.equal(old.shown.version, 1);
  assert.equal(old.shown.isLatest, false);
  assert.equal(old.shown.intact, true);
  assert.equal(old.shown.markdown, v1Markdown);
  assert.equal(old.shown.docSha256, g1.version.docSha256);

  // Restoring the documentation makes version 2 stale again; regenerating gives version 3
  // (identical text to version 1, but a new version: history is append-only).
  await writeFile(file, original);
  await post('/api/discover');
  assert.equal((await j(await get(`${R}/generate-an-api-key`))).state, 'stale');
  assert.equal((await j(await post(`${R}/generate-an-api-key`))).version.version, 3);

  // Files live only under data/assurance/requirements/<id>/.
  const dir = path.join(work, 'data', 'assurance', 'requirements', 'generate-an-api-key');
  assert.deepEqual((await readdir(dir)).sort(), ['index.json', 'v0001.json', 'v0001.md', 'v0002.json', 'v0002.md', 'v0003.json', 'v0003.md']);
  assert.equal(await readFile(path.join(dir, 'v0001.md'), 'utf8'), v1Markdown);
});

test('input validation and security', async () => {
  for (const bad of ['..%2F..%2Fcredits', '%2e%2e', 'Generate-An-API-Key', 'a_b', 'unknown-tutorial', 'x'.repeat(81)]) {
    const r = await get(`${R}/${bad}`);
    assert.equal(r.status, 404, bad);
    assert.equal((await post(`${R}/${bad}`)).status, 404, `POST ${bad}`);
  }
  for (const v of ['0', '-1', 'abc', '1.5', '9999999']) assert.equal((await get(`${R}/generate-an-api-key?version=${v}`)).status, 400, `version=${v}`);
  assert.equal((await get(`${R}/generate-an-api-key?version=99`)).status, 404);
  assert.equal((await post(`${R}/generate-an-api-key`, {}, { 'Content-Type': 'application/json' })).status, 403, 'missing X-KaneVerity');
  assert.equal((await fetch(`${api}${R}`, { headers: { Origin: 'https://evil.example' } })).status, 403, 'foreign origin');
  assert.equal((await fetch(`${api}${R}/generate-an-api-key`, { method: 'PUT', headers: H, body: '{}' })).status, 404);

  // The stored and served documents never contain the application URL.
  const d = await j(await get(`${R}/generate-an-api-key`));
  assert.ok(!d.shown.markdown.includes(new URL(appUrl).host));
});

test('B1 never starts Kane or Claude, and starts no runs', async () => {
  assert.equal(existsSync(path.join(work, 'kane-args.json')), false, 'no Kane process was started');
  assert.equal(existsSync(path.join(work, 'claude-args.json')), false, 'no Claude process was started');
  assert.deepEqual(await j(await get('/api/runs')), []);
});

test('B2 default: Kane Assurance commands are switched off; nothing can start', async () => {
  const st = await j(await get('/api/assurance/status'));
  assert.equal(st.mode, 'off');
  assert.ok(st.kinds.every((k: { enabled: boolean }) => !k.enabled));
  for (const body of [{ kind: 'ingest', tutorialId: 'generate-an-api-key' }, { kind: 'extract', tutorialId: 'generate-an-api-key', confirm: { paid: true } }, { kind: 'cover' }]) {
    const r = await post('/api/assurance/jobs', body);
    assert.equal(r.status, 403, JSON.stringify(body));
    assert.match((await j(r)).error, /switched off/);
  }
  assert.deepEqual(await j(await get('/api/assurance/jobs')), []);
  assert.equal(existsSync(path.join(work, 'kane-args.json')), false, 'no Kane process was started');
});
