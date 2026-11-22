// Discovery freshness: is the cached tutorial still what the live docs page shows?
// A verification run always uses the cached (discovered) tutorial, so it must
// only start when the live page still has the same content fingerprint.

import { createHash } from 'node:crypto';
import { dataPath, writeJson } from '../store.ts';
import type { Discovery, Project, Tutorial } from '../types.ts';
import { discover, fetchText } from './crawl.ts';
import { extractPage } from './extract.ts';

export type FreshnessStatus = 'current' | 'stale' | 'unavailable';

export interface Freshness {
  id: string;
  status: FreshnessStatus;
  discoveredSha256: string | null;
  liveSha256: string | null;
  reason: string | null;
}

/** The tutorial's content fingerprint: the docs page's own, or one computed from the extracted text. */
export function contentFingerprint(t: Pick<Tutorial, 'sourceSha256' | 'steps' | 'outcomes'>): string {
  if (t.sourceSha256) return t.sourceSha256;
  const text = JSON.stringify({ steps: t.steps.map((s) => s.text), outcomes: t.outcomes.map((o) => o.text) });
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export async function checkFreshness(t: Tutorial, project: Project): Promise<Freshness> {
  const discoveredSha256 = contentFingerprint(t);
  const base = { id: t.id, discoveredSha256 };
  let html: string;
  try {
    html = await fetchText(t.url, project.docsOrigin, /^text\/html\b/i);
  } catch (err) {
    return { ...base, status: 'unavailable', liveSha256: null, reason: `The live documentation page could not be read (${(err as Error).message}).` };
  }
  const page = extractPage(html, t.url, project.appOrigin);
  if (page.kind !== 'tutorial') {
    return { ...base, status: 'stale', liveSha256: null, reason: 'The live page is no longer an actionable tutorial.' };
  }
  const liveSha256 = contentFingerprint(page.tutorial);
  if (liveSha256 !== discoveredSha256) {
    return { ...base, status: 'stale', liveSha256, reason: `The live documentation changed since discovery (discovered ${discoveredSha256.slice(0, 12)}, live ${liveSha256.slice(0, 12)}).` };
  }
  return { ...base, status: 'current', liveSha256, reason: null };
}

export async function checkAll(discovery: Discovery, project: Project): Promise<Freshness[]> {
  return Promise.all(discovery.tutorials.map((t) => checkFreshness(t, project)));
}

/** Discover again and store the result (the one place discovery.json is written). */
export async function refreshDiscovery(project: Project): Promise<Discovery> {
  const result = await discover(project.docsUrl, project.appOrigin);
  await writeJson(dataPath('discovery.json'), result);
  return result;
}
