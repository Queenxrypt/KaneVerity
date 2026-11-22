// Use-case retrieval and KaneVerity review (Assurance B3).
//
// Retrieval runs three free, read-only Kane commands through the B2 runner (so it
// needs Assurance mode "free" or "all"): `context fsck --json`, `context list
// --json` and `context view --json`. It then reads the committed records for the
// citation quotes (storeReader.ts) and accepts the result only if every
// cross-check passes:
//   - fsck reports ok, with the same number of records the reader found;
//   - the view's schema and tip match the store's last commit;
//   - the live use cases, titles and trust in `context list` match the records;
//   - the view's citation anchors and criteria match the records;
//   - the source blob Kane cited is byte-identical to a stored requirements version.
// Each retrieval is saved as an append-only snapshot, so review works with
// Assurance switched off and the extraction history is preserved. Nothing is ever
// written to Kane's store.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.ts';
import { dataPath, readJson, writeJson } from '../store.ts';
import { findLeaks, scrubDeep } from '../verify/redact.ts';
import { checkCitations, type CitationReport } from './citations.ts';
import type { LineMapEntry } from './requirements.ts';
import { sourceIdFor } from './commands.ts';
import { jobStdoutPath, type AssuranceJobs, type JobRecord } from './jobs.ts';
import { designEligibility, reviewState, validateDecision, ReviewError, type ReviewEntry } from './review.ts';
import { AssuranceError, type RequirementsService } from './service.ts';
import { isTutorialId, listVersions, readVersion } from './store.ts';
import { blobPath, readStore, SUPPORTED_SCHEMA, type StoreUseCase } from './storeReader.ts';

export const UC_HEX = /^[a-f0-9]{64}$/;

export interface SnapshotUseCase {
  cid: string;
  logicalId: string;
  title: string;
  description: string;
  summary: string;
  value: string;
  risk: string;
  actors: string[];
  criteria: { text: string; citations: number[] }[];
  kaneTrust: string;
  fresh: string;
  mintedSeq: number;
  proposalId: string | null;
  citationReport: CitationReport;
  /** Verdicts Kane recorded itself for this use case's proposal. Information only. */
  kaneVerdicts: { resolution: string; attributedTo: string; countsAsReview: false }[];
}

export interface UseCaseSnapshot {
  snapshot: number;
  tutorialId: string;
  sourceId: string;
  retrievedAt: string;
  cliVersion: string;
  integrity: { ok: boolean; problems: string[] };
  store: { records: number; tipPrefix: string | null };
  fsck: { ok: boolean; issues: number };
  requirements: { version: number; reqSha256: string; docSha256: string } | null;
  source: { cid: string } | null;
  useCases: SnapshotUseCase[];
  jobs: { fsck: string; list: string; view: string };
}

const snapDir = (t: string) => dataPath('assurance', 'usecases', t);
const reviewFile = (t: string) => dataPath('assurance', 'reviews', `${t}.json`);
const pad = (n: number) => String(n).padStart(4, '0');

function decodeHtml(s: string): string {
  return s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Criteria list from the view's rendered content (<ul class="crit"><li>…</li></ul>). */
function viewCriteria(html: string): string[] {
  const ul = /<ul class="crit">([\s\S]*?)<\/ul>/.exec(html);
  if (!ul) return [];
  return [...ul[1].matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => decodeHtml(m[1]));
}

const sortedEq = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

export class AssuranceUseCases {
  private locks = new Map<string, Promise<unknown>>();

  private jobs: AssuranceJobs;
  private requirements: RequirementsService;

  constructor(jobs: AssuranceJobs, requirements: RequirementsService) {
    this.jobs = jobs;
    this.requirements = requirements;
  }

  private async serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
    this.locks.set(key, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === run) this.locks.delete(key);
    }
  }

  /** Run one free read through the runner and return its raw stdout. */
  private async read(kind: 'fsck' | 'list' | 'view'): Promise<{ job: JobRecord; stdout: string }> {
    const started = kind === 'list' ? await this.jobs.start({ kind, inferred: false }) : await this.jobs.start({ kind });
    let job = started;
    for (let i = 0; i < 1200 && (job.state === 'queued' || job.state === 'running'); i++) {
      await new Promise((r) => setTimeout(r, 100));
      job = await this.jobs.get(started.jobId);
    }
    // fsck exits 1 when it finds a problem; its JSON report is still the answer.
    if (job.state !== 'complete' && !(kind === 'fsck' && job.state === 'error' && job.exitCode === 1)) {
      throw new AssuranceError(502, `Reading the Assurance store failed at "${kind}": ${job.reason}`);
    }
    const stdout = await readFile(jobStdoutPath(job.jobId), 'utf8').catch(() => '');
    return { job, stdout };
  }

  async retrieve(tutorialId: unknown): Promise<UseCaseSnapshot> {
    if (!isTutorialId(tutorialId)) throw new AssuranceError(404, 'Tutorial not found.');
    const sourceId = sourceIdFor(tutorialId);
    return this.serial(`retrieve:${tutorialId}`, async () => {
      // Fails with the runner's own 403 when Assurance is switched off.
      const fsckRun = await this.read('fsck');
      const listRun = await this.read('list');
      const viewRun = await this.read('view');
      const problems: string[] = [];

      let fsck: { ok?: unknown; issues?: unknown; records?: unknown } = {};
      try {
        fsck = JSON.parse(fsckRun.stdout);
      } catch {
        problems.push('context fsck did not return JSON.');
      }
      const fsckIssues = Array.isArray(fsck.issues) ? fsck.issues.length : -1;
      if (fsck.ok !== true || fsckIssues !== 0) problems.push(`context fsck reported a damaged store (${fsckIssues} issue(s)).`);

      const rows: { id: string; cid: string; label: string; title: string; trust: string; fresh: string }[] = [];
      for (const line of listRun.stdout.split(/\r?\n/).filter((l) => l.trim())) {
        try {
          const r = JSON.parse(line);
          if (typeof r.cid === 'string' && typeof r.label === 'string') rows.push(r);
        } catch {
          problems.push('context list returned a line that is not JSON.');
        }
      }
      let view: { meta?: { schema?: unknown; tipHash?: unknown }; nodes?: { cid: string; trust: string }[]; edges?: { src: string; dst: string; anchors?: string[] }[]; contentHtml?: Record<string, string> } = {};
      try {
        view = JSON.parse(viewRun.stdout);
      } catch {
        problems.push('context view did not return JSON.');
      }

      const storeDir = path.join(config.assurance.workspaceDir, '.context');
      const store = await readStore(storeDir, config.assurance.pinnedVersion);
      problems.push(...store.problems);
      if (typeof fsck.records === 'number' && fsck.records !== store.records) problems.push(`context fsck counted ${fsck.records} records, the store reader ${store.records}.`);
      if (view.meta?.schema !== SUPPORTED_SCHEMA) problems.push('context view reports a different store schema.');
      if (typeof view.meta?.tipHash !== 'string' || !store.tipPrefix || !view.meta.tipHash.startsWith(`sha256:${store.tipPrefix}`)) problems.push("context view's latest commit does not match the store's last record.");

      // The source and the requirements bytes Kane actually holds.
      const source = store.sources.find((s) => s.sourceId === sourceId) ?? null;
      const sourceRow = rows.find((r) => r.label === 'source' && r.id === sourceId);
      let requirements: UseCaseSnapshot['requirements'] = null;
      let reqMarkdown = '';
      let lineMap: LineMapEntry[] = [];
      if (!source) problems.push(`The source ${sourceId} is not in the Assurance store.`);
      else {
        if (!sourceRow || sourceRow.cid !== source.cid) problems.push('context list does not show the same current source version as the store records.');
        const blob = await readFile(blobPath(storeDir, source.blob), 'utf8').catch(() => null);
        if (blob === null) problems.push("The source's blob is missing from the store.");
        else {
          for (const v of await listVersions(tutorialId)) {
            const r = await readVersion(tutorialId, v.version);
            if (r && r.intact && r.markdown === blob) {
              requirements = { version: v.version, reqSha256: v.reqSha256, docSha256: v.docSha256 };
              reqMarkdown = r.markdown;
              lineMap = r.meta.lineMap;
            }
          }
          if (!requirements) problems.push("The requirements Kane holds match no stored KaneVerity requirements version.");
        }
      }

      // Live use cases (as Kane lists them), cross-checked against the records and the view.
      const liveRows = rows.filter((r) => r.label === 'usecase');
      const useCases: SnapshotUseCase[] = [];
      for (const row of liveRows) {
        const uc: StoreUseCase | undefined = store.useCases.find((u) => u.cid === row.cid);
        if (!uc) {
          problems.push(`Use case ${row.id} is listed by Kane but not found in the store records.`);
          continue;
        }
        if (uc.content.title !== row.title) problems.push(`Use case ${row.id}: the title differs between context list and the records.`);
        const vNode = view.nodes?.find((n) => n.cid === uc.cid);
        if (!vNode || vNode.trust !== row.trust) problems.push(`Use case ${row.id}: the trust differs between context view and context list.`);
        const mine = source ? uc.citations.filter((c) => c.srcCid === source.cid) : [];
        const vEdge = source ? view.edges?.find((e) => e.src === source.cid && e.dst === uc.cid) : undefined;
        if (!vEdge || !sortedEq(vEdge.anchors ?? [], mine.map((c) => c.anchor))) problems.push(`Use case ${row.id}: the citation anchors differ between context view and the records.`);
        if (!sortedEq(viewCriteria(view.contentHtml?.[uc.cid] ?? ''), uc.content.criteria)) problems.push(`Use case ${row.id}: the criteria differ between context view and the records.`);

        const report = checkCitations({
          requirementsMarkdown: reqMarkdown,
          lineMap,
          expectedSourceId: sourceId,
          expectedSourceCid: source?.cid ?? '',
          citations: uc.citations.map((c) => ({ anchor: c.anchor, quote: c.quote, claim: c.claim, sourceId: c.sourceId, sourceCid: c.sourceCid })),
          useCaseText: [uc.content.description, uc.content.summary, ...uc.content.criteria].join('\n'),
        });
        useCases.push({
          cid: uc.cid,
          logicalId: row.id,
          title: uc.content.title,
          description: uc.content.description,
          summary: uc.content.summary,
          value: uc.content.value,
          risk: uc.content.risk,
          actors: uc.content.actors,
          criteria: uc.content.criteria.map((text) => ({ text, citations: report.citations.map((c, i) => (c.claim === text ? i : -1)).filter((i) => i >= 0) })),
          kaneTrust: row.trust,
          fresh: row.fresh,
          mintedSeq: uc.mintedSeq,
          proposalId: uc.proposalId,
          citationReport: report,
          kaneVerdicts: store.kaneVerdicts.filter((v) => v.proposalId === uc.proposalId).map((v) => ({ resolution: v.resolution, attributedTo: v.attributedTo, countsAsReview: false as const })),
        });
      }

      // Append-only snapshot.
      const dir = snapDir(tutorialId);
      await mkdir(dir, { recursive: true });
      const existing = (await readdir(dir).catch(() => [] as string[])).filter((f) => /^snapshot-[0-9]{4}\.json$/.test(f)).sort();
      const n = existing.length ? Number(existing[existing.length - 1].slice(9, 13)) + 1 : 1;
      const snap: UseCaseSnapshot = {
        snapshot: n,
        tutorialId,
        sourceId,
        retrievedAt: new Date().toISOString(),
        cliVersion: config.assurance.pinnedVersion,
        integrity: { ok: problems.length === 0, problems },
        store: { records: store.records, tipPrefix: store.tipPrefix },
        fsck: { ok: fsck.ok === true, issues: fsckIssues },
        requirements,
        source: source ? { cid: source.cid } : null,
        useCases,
        jobs: { fsck: fsckRun.job.jobId, list: listRun.job.jobId, view: viewRun.job.jobId },
      };
      await writeFile(path.join(dir, `snapshot-${pad(n)}.json`), JSON.stringify(snap, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
      return snap;
    });
  }

  async latest(tutorialId: string): Promise<UseCaseSnapshot | null> {
    const files = (await readdir(snapDir(tutorialId)).catch(() => [] as string[])).filter((f) => /^snapshot-[0-9]{4}\.json$/.test(f)).sort();
    return files.length ? readJson<UseCaseSnapshot>(path.join(snapDir(tutorialId), files[files.length - 1])) : null;
  }

  private async decisions(tutorialId: string): Promise<ReviewEntry[]> {
    return (await readJson<{ decisions: ReviewEntry[] }>(reviewFile(tutorialId)))?.decisions ?? [];
  }

  /** Whether the snapshot was read from the requirements version that is current now. */
  private async requirementsCurrent(snap: UseCaseSnapshot): Promise<boolean> {
    try {
      const d = await this.requirements.get(snap.tutorialId);
      return d.state === 'current' && !!snap.requirements && d.shown?.reqSha256 === snap.requirements.reqSha256;
    } catch {
      return false;
    }
  }

  /** The latest snapshot with each use case's review state and design eligibility (UI-safe). */
  async view(tutorialId: unknown) {
    if (!isTutorialId(tutorialId)) throw new AssuranceError(404, 'Tutorial not found.');
    const snap = await this.latest(tutorialId);
    const decisions = await this.decisions(tutorialId);
    if (!snap) return { tutorialId, snapshot: null, useCases: [] };
    const current = await this.requirementsCurrent(snap);
    const pub = scrubDeep({
      tutorialId,
      snapshot: { snapshot: snap.snapshot, retrievedAt: snap.retrievedAt, cliVersion: snap.cliVersion, integrity: snap.integrity, store: snap.store, fsck: snap.fsck, requirements: snap.requirements, requirementsCurrent: current },
      useCases: snap.useCases.map((uc) => {
        const r = reviewState(decisions, uc.cid);
        return { ...uc, review: { state: r.state, history: r.history }, design: designEligibility({ state: r.state, integrityOk: snap.integrity.ok, inLatestSnapshot: true, requirementsCurrent: current }) };
      }),
    });
    const leaks = findLeaks(pub);
    if (leaks.length) throw new AssuranceError(500, `Use cases withheld: sensitive data detected (${leaks.join(', ')}).`);
    return pub;
  }

  /** Record a human decision made in KaneVerity's review interface. */
  async review(tutorialId: unknown, ucHex: unknown, body: unknown) {
    if (!isTutorialId(tutorialId)) throw new AssuranceError(404, 'Tutorial not found.');
    if (typeof ucHex !== 'string' || !UC_HEX.test(ucHex)) throw new AssuranceError(404, 'Use case not found.');
    const cid = `sha256:${ucHex}`;
    return this.serial(`review:${tutorialId}`, async () => {
      const snap = await this.latest(tutorialId);
      const uc = snap?.useCases.find((u) => u.cid === cid);
      if (!snap || !uc) throw new AssuranceError(404, 'Use case not found in the latest retrieval.');
      if (!snap.integrity.ok) throw new AssuranceError(409, 'The latest retrieval failed its integrity checks, so its use cases cannot be reviewed. Read the use cases again.');
      let d: ReturnType<typeof validateDecision>;
      try {
        d = validateDecision(body, uc.citationReport.summary.hasGaps);
      } catch (err) {
        if (err instanceof ReviewError) throw new AssuranceError(400, err.message);
        throw err;
      }
      const s = uc.citationReport.summary;
      const entry: ReviewEntry = {
        ucCid: cid,
        decision: d.decision,
        reason: d.reason,
        acknowledgedGaps: d.acknowledgedGaps,
        gapsAtDecision: { invalid: s.invalid, stepsCited: s.stepsCited, steps: s.steps, outcomesCited: s.outcomesCited, outcomes: s.outcomes, hasGaps: s.hasGaps },
        snapshot: snap.snapshot,
        at: new Date().toISOString(),
        by: 'kaneverity-review',
      };
      const decisions = await this.decisions(tutorialId);
      await writeJson(reviewFile(tutorialId), { tutorialId, decisions: [...decisions, entry] });
      return entry;
    });
  }

  /** For test design (B4): may this use case proceed? */
  async eligibility(tutorialId: string, cid: string) {
    const snap = await this.latest(tutorialId);
    const uc = snap?.useCases.find((u) => u.cid === cid);
    const state = reviewState(await this.decisions(tutorialId), cid).state;
    return designEligibility({ state, integrityOk: !!snap?.integrity.ok, inLatestSnapshot: !!uc, requirementsCurrent: snap ? await this.requirementsCurrent(snap) : false });
  }
}
