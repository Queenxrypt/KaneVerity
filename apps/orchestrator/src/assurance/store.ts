// Versioned requirements artefacts (Assurance B1), under the git-ignored
//   data/assurance/requirements/<tutorialId>/
//     index.json        every version's metadata, oldest first
//     v0001.md          the requirements document of version 1 (never rewritten)
//     v0001.json        version 1's metadata, including its source line map
//
// Versions are append-only: a new version is written only when the generated
// content differs from the latest one, and each file is created exclusively, so an
// earlier artefact can never be silently overwritten.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dataPath, readJson, writeJson } from '../store.ts';
import type { GeneratedRequirements, LineMapEntry } from './requirements.ts';

export const TUTORIAL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ID_LENGTH = 80;

export interface RequirementsVersion {
  tutorialId: string;
  version: number;
  format: string;
  title: string;
  docSha256: string;
  reqSha256: string;
  createdAt: string;
  /** The version this one replaced (null for the first). */
  supersedes: number | null;
  file: string;
  lineMap: LineMapEntry[];
}

interface Index {
  tutorialId: string;
  versions: RequirementsVersion[];
}

export class RequirementsStoreError extends Error {}

export function isTutorialId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= MAX_ID_LENGTH && TUTORIAL_ID_PATTERN.test(id);
}

const baseDir = () => dataPath('assurance', 'requirements');

/** The tutorial's folder, guaranteed to be inside data/assurance/requirements/. */
function tutorialDir(id: string): string {
  if (!isTutorialId(id)) throw new RequirementsStoreError('Invalid tutorial id.');
  const base = path.resolve(baseDir());
  const dir = path.resolve(base, id);
  if (path.dirname(dir) !== base) throw new RequirementsStoreError('Invalid tutorial id.');
  return dir;
}

const versionName = (v: number) => `v${String(v).padStart(4, '0')}`;
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

async function readIndex(id: string): Promise<Index> {
  const idx = await readJson<Index>(path.join(tutorialDir(id), 'index.json'));
  return idx && Array.isArray(idx.versions) ? idx : { tutorialId: id, versions: [] };
}

export async function listVersions(id: string): Promise<RequirementsVersion[]> {
  return (await readIndex(id)).versions;
}

export async function latestVersion(id: string): Promise<RequirementsVersion | null> {
  const v = await listVersions(id);
  return v.length ? v[v.length - 1] : null;
}

/** A stored version and its document. `intact` is false if the file no longer matches its fingerprint. */
export async function readVersion(id: string, version: number): Promise<{ meta: RequirementsVersion; markdown: string; intact: boolean } | null> {
  const meta = (await listVersions(id)).find((v) => v.version === version);
  if (!meta) return null;
  const markdown = await readFile(path.join(tutorialDir(id), meta.file), 'utf8').catch(() => null);
  if (markdown === null) return { meta, markdown: '', intact: false };
  return { meta, markdown, intact: sha256(markdown) === meta.reqSha256 };
}

const locks = new Map<string, Promise<unknown>>();

/** Store generated requirements as a new version, unless they equal the latest version. */
export async function saveRequirements(gen: GeneratedRequirements, now = new Date()): Promise<{ status: 'created' | 'unchanged'; meta: RequirementsVersion }> {
  const id = gen.tutorialId;
  const dir = tutorialDir(id);
  if (sha256(gen.markdown) !== gen.reqSha256) throw new RequirementsStoreError('Requirements fingerprint mismatch.');
  // One save per tutorial at a time, so two requests can't both create "the next" version.
  const run = (locks.get(id) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const idx = await readIndex(id);
      const last = idx.versions[idx.versions.length - 1];
      if (last && last.reqSha256 === gen.reqSha256) return { status: 'unchanged' as const, meta: last };
      const version = (last?.version ?? 0) + 1;
      const name = versionName(version);
      const meta: RequirementsVersion = {
        tutorialId: id,
        version,
        format: gen.format,
        title: gen.title,
        docSha256: gen.docSha256,
        reqSha256: gen.reqSha256,
        createdAt: now.toISOString(),
        supersedes: last?.version ?? null,
        file: `${name}.md`,
        lineMap: gen.lineMap,
      };
      await mkdir(dir, { recursive: true });
      // 'wx': fail rather than overwrite an existing artefact.
      await writeFile(path.join(dir, meta.file), gen.markdown, { encoding: 'utf8', flag: 'wx' });
      await writeFile(path.join(dir, `${name}.json`), JSON.stringify(meta, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
      await writeJson(path.join(dir, 'index.json'), { tutorialId: id, versions: [...idx.versions, meta] } satisfies Index);
      return { status: 'created' as const, meta };
    });
  locks.set(id, run);
  try {
    return await run;
  } finally {
    if (locks.get(id) === run) locks.delete(id);
  }
}
