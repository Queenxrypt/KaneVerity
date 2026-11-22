// Assurance B1: the versioned requirements store. The data folder must be set
// before any orchestrator module loads (config reads it once), so this file uses
// only dynamic imports and never touches the real data/ folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DATA = await mkdtemp(path.join(os.tmpdir(), 'kv-req-store-'));
process.env.KANEVERITY_DATA_DIR = DATA;
const { generateRequirements } = await import('../src/assurance/requirements.ts');
const { saveRequirements, listVersions, readVersion, isTutorialId } = await import('../src/assurance/store.ts');
const { dataPath } = await import('../src/store.ts');
const { tutorial } = await import('./helpers.ts');
const APP = 'http://127.0.0.1:5174';
const apiKey = { ...tutorial(["On the 'Dashboard', click 'Settings'.", "Click 'API'."], ["'Saved' appears."], 'generate-an-api-key'), sourceSha256: 'a'.repeat(64) };

test('versioned store: created, unchanged, new version, never overwrites, path-safe', async () => {
  const dir = dataPath('assurance', 'requirements', 'generate-an-api-key');
  assert.ok(path.resolve(dir).startsWith(path.resolve(DATA)), 'writes only to the temporary data folder');

  const v1 = generateRequirements(apiKey, APP);
  const a = await saveRequirements(v1, new Date('2026-11-22T10:00:00Z'));
  assert.equal(a.status, 'created');
  assert.equal(a.meta.version, 1);
  assert.equal(a.meta.supersedes, null);
  assert.equal((await saveRequirements(v1)).status, 'unchanged', 'same content: no new version');

  // Concurrent saves of the same new content create exactly one version.
  const corrected = { ...apiKey, sourceSha256: 'f'.repeat(64), steps: apiKey.steps.map((s, i) => ({ ...s, kaneText: `${s.kaneText} (v2 ${i})` })) };
  const v2 = generateRequirements(corrected, APP);
  const results = await Promise.all([saveRequirements(v2), saveRequirements(v2), saveRequirements(v2)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['created', 'unchanged', 'unchanged']);
  const versions = await listVersions('generate-an-api-key');
  assert.deepEqual(versions.map((v) => [v.version, v.supersedes, v.docSha256.slice(0, 4)]), [[1, null, v1.docSha256.slice(0, 4)], [2, 1, 'ffff']]);

  // Version 1 is untouched, byte for byte.
  const r1 = await readVersion('generate-an-api-key', 1);
  assert.equal(r1?.markdown, v1.markdown);
  assert.equal(r1?.intact, true);
  assert.equal(r1?.meta.createdAt, '2026-11-22T10:00:00.000Z');
  assert.deepEqual((await readdir(dir)).sort(), ['index.json', 'v0001.json', 'v0001.md', 'v0002.json', 'v0002.md']);

  // Tampering is detected, never silently trusted.
  await writeFile(path.join(dir, 'v0001.md'), v1.markdown + 'tampered\n');
  assert.equal((await readVersion('generate-an-api-key', 1))?.intact, false);
  await writeFile(path.join(dir, 'v0001.md'), v1.markdown);
  assert.equal(await readFile(path.join(dir, 'v0001.md'), 'utf8'), v1.markdown);

  for (const bad of ['..', '../x', 'a/b', 'A', 'a_b', '', 'x'.repeat(81), '-a', 'a-', 'a--b', '%2e%2e']) assert.equal(isTutorialId(bad), false, bad);
  await assert.rejects(saveRequirements({ ...v1, tutorialId: '../escape' }), /Invalid tutorial id/);
  await assert.rejects(saveRequirements({ ...v1, reqSha256: 'a'.repeat(64) }), /fingerprint mismatch/);
  assert.equal(await readVersion('generate-an-api-key', 99), null);
});
