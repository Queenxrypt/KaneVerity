// Requirements service (Assurance B1): state, preview and generation per tutorial.
// No Kane command is ever started here.
//
// State of a tutorial's requirements:
// - none:    nothing generated yet
// - current: the latest version was generated from the documentation discovery shows,
//            discovery matches the live page, and generating again gives the same bytes
// - stale:   any of those no longer holds (the reasons say which)

import { checkFreshness, contentFingerprint, type Freshness } from '../discovery/freshness.ts';
import { dataPath, readJson } from '../store.ts';
import type { Discovery, Project, Tutorial } from '../types.ts';
import { generateRequirements, RequirementsError, type GeneratedRequirements } from './requirements.ts';
import { isTutorialId, listVersions, readVersion, saveRequirements, type RequirementsVersion } from './store.ts';

export class AssuranceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type RequirementsState = 'none' | 'current' | 'stale';

export interface RequirementsSummary {
  tutorialId: string;
  title: string;
  state: RequirementsState;
  reasons: string[];
  latest: Omit<RequirementsVersion, 'lineMap'> | null;
  versionCount: number;
  freshness: Freshness['status'];
}

const short = (s: string) => s.slice(0, 12);
const withoutMap = ({ lineMap: _omit, ...rest }: RequirementsVersion) => rest;

async function context(): Promise<{ project: Project; discovery: Discovery }> {
  const project = await readJson<Project>(dataPath('project.json'));
  const discovery = await readJson<Discovery>(dataPath('discovery.json'));
  if (!project || !discovery) throw new AssuranceError(409, 'Connect a project and discover tutorials first.');
  return { project, discovery };
}

function findTutorial(discovery: Discovery, id: string): Tutorial {
  if (!isTutorialId(id)) throw new AssuranceError(404, 'Tutorial not found.');
  const t = discovery.tutorials.find((x) => x.id === id);
  if (!t) throw new AssuranceError(404, 'Tutorial not found.');
  return t;
}

function tryGenerate(t: Tutorial, project: Project): { gen: GeneratedRequirements | null; error: string | null } {
  try {
    return { gen: generateRequirements(t, project.appOrigin), error: null };
  } catch (err) {
    if (err instanceof RequirementsError) return { gen: null, error: err.message };
    throw err;
  }
}

function assess(t: Tutorial, latest: RequirementsVersion | null, fresh: Freshness, gen: GeneratedRequirements | null): { state: RequirementsState; reasons: string[] } {
  if (!latest) return { state: 'none', reasons: [] };
  const reasons: string[] = [];
  if (fresh.status === 'stale') reasons.push(`${fresh.reason ?? 'The live documentation changed since discovery.'} Discover again, then regenerate.`);
  if (fresh.status === 'unavailable') reasons.push(`The live documentation could not be checked: ${fresh.reason ?? ''}`.trim());
  const docSha = contentFingerprint(t);
  if (latest.docSha256 !== docSha) reasons.push(`Version ${latest.version} was generated from documentation ${short(latest.docSha256)}; the documentation is now ${short(docSha)}.`);
  else if (gen && gen.reqSha256 !== latest.reqSha256) reasons.push(`Generating again from the same documentation gives different requirements (${short(gen.reqSha256)}).`);
  return { state: reasons.length ? 'stale' : 'current', reasons };
}

export class RequirementsService {
  async list(): Promise<RequirementsSummary[]> {
    const { project, discovery } = await context();
    return Promise.all(
      discovery.tutorials.map(async (t) => {
        const versions = await listVersions(t.id);
        const latest = versions[versions.length - 1] ?? null;
        const fresh = await checkFreshness(t, project);
        const { gen } = tryGenerate(t, project);
        const { state, reasons } = assess(t, latest, fresh, gen);
        return { tutorialId: t.id, title: t.title, state, reasons, latest: latest ? withoutMap(latest) : null, versionCount: versions.length, freshness: fresh.status };
      }),
    );
  }

  /** Full view: state, the stored version (latest or `version`), every version, and a preview of what would be generated. */
  async get(id: string, version: number | null = null) {
    const { project, discovery } = await context();
    const t = findTutorial(discovery, id);
    const versions = await listVersions(id);
    const latest = versions[versions.length - 1] ?? null;
    const fresh = await checkFreshness(t, project);
    const { gen, error } = tryGenerate(t, project);
    const { state, reasons } = assess(t, latest, fresh, gen);

    const wanted = version ?? latest?.version ?? null;
    let shown: { meta: RequirementsVersion; markdown: string; intact: boolean } | null = null;
    if (wanted !== null) {
      shown = await readVersion(id, wanted);
      if (!shown) throw new AssuranceError(404, `Requirements version ${wanted} not found.`);
    }
    // A preview is offered when there is something new to generate, and only from current discovery.
    const preview =
      fresh.status === 'current' && gen && (!latest || gen.reqSha256 !== latest.reqSha256)
        ? { markdown: gen.markdown, reqSha256: gen.reqSha256, docSha256: gen.docSha256, lineMap: gen.lineMap }
        : null;
    return {
      tutorialId: t.id,
      title: t.title,
      docsUrl: t.url,
      appStart: t.appStart,
      state,
      reasons,
      freshness: fresh,
      canGenerate: fresh.status === 'current' && !!gen,
      cannotGenerateReason: error ?? (fresh.status !== 'current' ? fresh.reason : null),
      versions: versions.map(withoutMap),
      shown: shown ? { ...shown.meta, markdown: shown.markdown, intact: shown.intact, isLatest: shown.meta.version === latest?.version } : null,
      preview,
    };
  }

  /** Generate from the current documentation; a new version only if the content changed. */
  async generate(id: string) {
    const { project, discovery } = await context();
    const t = findTutorial(discovery, id);
    // Same rule as verification runs: only from discovery that matches the live page.
    const fresh = await checkFreshness(t, project);
    if (fresh.status !== 'current') throw new AssuranceError(409, `Requirements were not generated: ${fresh.reason} Discover again to refresh the tutorials first.`);
    let gen: GeneratedRequirements;
    try {
      gen = generateRequirements(t, project.appOrigin);
    } catch (err) {
      if (err instanceof RequirementsError) throw new AssuranceError(422, `Requirements can't be generated: ${err.message}`);
      throw err;
    }
    const { status, meta } = await saveRequirements(gen);
    return { status, version: withoutMap(meta) };
  }
}
