// B5: global Kane variables cannot override the approved app_url. This calls Kane 0.10.5's own
// installed variable loaders (pure functions; no Kane command, no network): the run-time loader
// (chunk-TPCW5OU5 `Y`, exported as `d`) and the dry-run planner's index (chunk-EHB55V23 `I`,
// exported as `c`). KaneVerity's own rule (effectiveLocalAppUrl) is checked against them on the
// same folders. Skipped when the pinned Kane build is not installed (a fresh machine).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../src/config.ts';
import { effectiveLocalAppUrl, RUN_VARIABLES_FILE } from '../src/assurance/designs.ts';

const dist = config.kane.entry ? path.join(path.dirname(config.kane.entry), '..', 'dist') : '';
const pkg = config.kane.entry ? path.join(path.dirname(config.kane.entry), '..', 'package.json') : '';
const RUNTIME = path.join(dist, 'chunk-TPCW5OU5.js');
const PLANNER = path.join(dist, 'chunk-EHB55V23.js');
const pinned = !!pkg && existsSync(pkg) && JSON.parse(readFileSync(pkg, 'utf8')).version === '0.10.5' && existsSync(RUNTIME) && existsSync(PLANNER);
const APPROVED = 'http://127.0.0.1:5174';

type Loaded = { raw: Record<string, { value: string }>; auteurObjective: string };
async function folders(globalFiles: Record<string, unknown>, localFiles: Record<string, unknown>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kv-kane-vars-'));
  const g = path.join(root, 'global');
  const l = path.join(root, 'local');
  await mkdir(g, { recursive: true });
  await mkdir(l, { recursive: true });
  for (const [n, v] of Object.entries(globalFiles)) await writeFile(path.join(g, n), JSON.stringify(v));
  for (const [n, v] of Object.entries(localFiles)) await writeFile(path.join(l, n), JSON.stringify(v));
  return { g, l };
}
async function kane(g: string, l: string) {
  const run = (await import(pathToFileURL(RUNTIME).href)) as { d: (o: Record<string, unknown>) => Loaded };
  const plan = (await import(pathToFileURL(PLANNER).href)) as { c: (o: Record<string, unknown>) => Map<string, { has_value: boolean; source: string }> };
  const r = run.d({ objective: 'start at {{app_url}}/', globalDir: g, localDir: l });
  return { value: r.raw.app_url?.value ?? null, planner: plan.c({ globalDir: g, localDir: l }).get('app_url') ?? null };
}
async function kaneverity(l: string) {
  const files = await Promise.all((await readdir(l)).map(async (name) => ({ name, text: await readFile(path.join(l, name), 'utf8') })));
  return effectiveLocalAppUrl(files);
}
const v = (value: string) => ({ value, secret: false });

test("a global app_url never overrides KaneVerity's run file (Kane's own loaders)", { skip: !pinned && 'Kane CLI 0.10.5 is not installed here' }, async () => {
  const { g, l } = await folders({ 'aaa.json': { app_url: v('http://evil.example') }, 'zzz.json': { app_url: v('http://evil2.example') } }, { 'assurance.json': { app_url: v('') }, [RUN_VARIABLES_FILE]: { app_url: v(APPROVED) } });
  const k = await kane(g, l);
  assert.equal(k.value, APPROVED, 'run time: the approved value');
  assert.equal(k.planner?.has_value, true);
  assert.equal(path.basename(k.planner!.source), RUN_VARIABLES_FILE, 'dry-run planner: resolved from the run file');
  assert.deepEqual(await kaneverity(l), { file: RUN_VARIABLES_FILE, value: APPROVED }, "KaneVerity's rule agrees with Kane");
});

test('without the run file a global value would apply: KaneVerity refuses that state', { skip: !pinned && 'Kane CLI 0.10.5 is not installed here' }, async () => {
  const { g, l } = await folders({ 'g.json': { app_url: v('http://evil.example') } }, { 'other.json': { unrelated: v('x') } });
  assert.equal((await kane(g, l)).value, 'http://evil.example', 'Kane would use the global value');
  assert.equal(await kaneverity(l), null, 'KaneVerity sees no local app_url, so the app_url gate stays closed');
  // With only Kane's empty declaration locally, the local empty value wins over the global one
  // (an unresolved variable, which the dry run reports), never the global value.
  const b = await folders({ 'g.json': { app_url: v('http://evil.example') } }, { 'assurance.json': { app_url: v('') } });
  assert.equal((await kane(b.g, b.l)).value, '');
  assert.deepEqual(await kaneverity(b.l), { file: 'assurance.json', value: '' });
});

test('a later local file that redefines app_url wins in Kane, and KaneVerity detects it', { skip: !pinned && 'Kane CLI 0.10.5 is not installed here' }, async () => {
  const { g, l } = await folders({}, { 'assurance.json': { app_url: v('') }, [RUN_VARIABLES_FILE]: { app_url: v(APPROVED) }, 'zz-local.json': { app_url: v('http://127.0.0.1:9999') } });
  assert.equal((await kane(g, l)).value, 'http://127.0.0.1:9999');
  assert.deepEqual(await kaneverity(l), { file: 'zz-local.json', value: 'http://127.0.0.1:9999' }, 'not the run file: the app_url gate stays closed');
  // An entry without "value", or an unreadable file, is skipped by both.
  const b = await folders({}, { [RUN_VARIABLES_FILE]: { app_url: v(APPROVED) }, 'zz-a.json': { app_url: { secret: false } } });
  await writeFile(path.join(b.l, 'zz-b.json'), '{ not json');
  assert.equal((await kane(b.g, b.l)).value, APPROVED);
  assert.deepEqual(await kaneverity(b.l), { file: RUN_VARIABLES_FILE, value: APPROVED });
});
