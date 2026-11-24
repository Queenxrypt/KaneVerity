// Use-case retrieval, KaneVerity review and the Kane approval write (Assurance B3, B4).
//
// Retrieval (B3) runs three free, read-only Kane commands through the B2 runner (so it
// needs Assurance mode "free" or "all"): `context fsck --json`, `context list
// --json` and `context view --json`. It then reads the committed records for the
// citation quotes and review items (storeReader.ts) and accepts the result only if
// every cross-check passes:
//   - fsck reports ok, with the same number of records the reader found;
//   - the view's schema and tip match the store's last commit;
//   - the live use cases, titles and trust in `context list` match the records;
//   - the view's citation anchors and criteria match the records;
//   - the source blob Kane cited is byte-identical to a stored requirements version.
// Each retrieval is saved as an append-only snapshot.
//
// Approval write (B4): a KaneVerity approval is recorded in Kane's store with the
// free `context review --verdicts <file> --mode ci --json`, then independently
// verified by reading the store again. Every step is an append-only kane_write
// entry. A write whose outcome is not proven is "unknown": decisions and writes for
// the tutorial are locked until the user checks the store (reconcile). An unknown
// write is never retried automatically. Rejections stay in KaneVerity; nothing is
// ever archived in Kane. Kane's `by` field and the reviewer name are compared, never
// treated as proof of identity.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config, reviewerSetting } from '../config.ts';
import { assertInstanceLock } from '../instanceLock.ts';
import { dataPath, readJson, writeJson } from '../store.ts';
import { findLeaks, scrub, scrubDeep } from '../verify/redact.ts';
import { checkCitations, type CitationReport } from './citations.ts';
import type { LineMapEntry } from './requirements.ts';
import { kaneUserFor, sourceIdFor } from './commands.ts';
import { JOB_ID_PATTERN, jobStdoutPath, type AssuranceJobs, type JobRecord } from './jobs.ts';
import {
  blockingWrite,
  currentWrites,
  designEligibility,
  reviewState,
  validateDecision,
  ReviewError,
  type KaneApprovalStatus,
  type KaneWriteEntry,
  type KaneWriteState,
  type ReviewEntry,
  type ReviewLog,
} from './review.ts';
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

/** A committed Kane review item, as kept in a snapshot (B4). */
export interface SnapshotKaneReview {
  seq: number;
  /** Full record hash (the tip's comes from `context view`). */
  recordHash: string | null;
  prevHash: string | null;
  ucCid: string;
  resolution: string;
  by: string;
  reviewOnly: boolean;
  itemsInRecord: number;
  build: string | null;
}

export interface UseCaseSnapshot {
  snapshot: number;
  tutorialId: string;
  sourceId: string;
  retrievedAt: string;
  cliVersion: string;
  integrity: { ok: boolean; problems: string[] };
  /** tipHash: the full hash of the last record (B4; absent in B3 snapshots). */
  store: { records: number; tipPrefix: string | null; tipHash?: string | null };
  fsck: { ok: boolean; issues: number };
  requirements: { version: number; reqSha256: string; docSha256: string } | null;
  source: { cid: string } | null;
  useCases: SnapshotUseCase[];
  /** B4: every committed review item in the store (absent in B3 snapshots). */
  kaneReviews?: SnapshotKaneReview[];
  jobs: { fsck: string; list: string; view: string };
}

const snapDir = (t: string) => dataPath('assurance', 'usecases', t);
const reviewFile = (t: string) => dataPath('assurance', 'reviews', `${t}.json`);
const writeDir = (writeId: string) => dataPath('assurance', 'kane-writes', writeId);
const pad = (n: number) => String(n).padStart(4, '0');

function newId(prefix: 'd' | 'w', now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const d = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`;
  const t = `${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return `${prefix}${d}-${t}-${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`;
}

function decodeHtml(s: string): string {
  return s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Criteria list from the view's rendered content (<ul class="crit"><li>…</li></ul>). */
function viewCriteria(html: string): string[] {
  const ul = /<ul class="crit">([\s\S]*?)<\/ul>/.exec(html);
  if (!ul) return [];
  return [...ul[1].matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => decodeHtml(m[1]));
}

/**
 * The audit trail of approval writes, one group per write (writeId), oldest first.
 * The log keeps every step; this only presents them: the first "pending" entry is
 * the write starting (verdict file prepared), the second is Kane running (job id
 * known), and later entries are outcomes.
 */
export type WriteStep = 'started' | 'kane_running' | 'verified' | 'not_written' | 'unknown' | 'written_unverified';
function groupWrites(entries: KaneWriteEntry[], active: Set<string>) {
  const groups = new Map<string, { writeId: string; decisionId: string; reviewer: string; state: KaneWriteState; kaneSeq: number | null; kaneHash: string | null; steps: { step: WriteStep; via: KaneWriteEntry['via']; at: string; reason: string; kaneSeq: number | null; kaneHash: string | null }[] }>();
  for (const e of entries) {
    let g = groups.get(e.writeId);
    if (!g) {
      g = { writeId: e.writeId, decisionId: e.decisionId, reviewer: e.reviewer, state: e.state, kaneSeq: null, kaneHash: null, steps: [] };
      groups.set(e.writeId, g);
    }
    const step: WriteStep = e.state === 'pending' ? (e.jobId ? 'kane_running' : 'started') : e.state;
    g.steps.push({ step, via: e.via, at: e.at, reason: e.reason, kaneSeq: e.kaneSeq, kaneHash: e.kaneHash });
    g.state = e.state;
    g.kaneSeq = e.kaneSeq;
    g.kaneHash = e.kaneHash;
  }
  // A pending write that is not running in this process has an unknown outcome.
  return [...groups.values()].map((g) => ({ ...g, state: g.state === 'pending' && !active.has(g.writeId) ? ('unknown' as const) : g.state }));
}

const sortedEq = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const citationsKey = (uc: SnapshotUseCase) => JSON.stringify(uc.citationReport.citations.map((c) => [c.anchor, c.quote, c.sourceCid, c.claim]));

export class AssuranceUseCases {
  private locks = new Map<string, Promise<unknown>>();
  /** Writes running in this process (a pending write not listed here is unknown). */
  private activeWrites = new Set<string>();
  /** Tutorials with a write running now: decisions and writes are refused at once, not queued. */
  private writing = new Set<string>();

  private refuseWhileWriting(tutorialId: string) {
    if (this.writing.has(tutorialId)) throw new AssuranceError(409, 'An approval is being written to Kane. Decisions and writes for this tutorial are locked until it finishes.');
  }

  private jobs: AssuranceJobs;
  private requirements: RequirementsService;

  constructor(jobs: AssuranceJobs, requirements: RequirementsService) {
    this.jobs = jobs;
    this.requirements = requirements;
    // Right before Kane starts a design (or design resume): re-check KaneVerity's own state.
    jobs.setDesignPreflight((j) => this.designPreflight(j));
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

  /** After a restart: a write that was pending has an unknown outcome. Nothing is retried. */
  async init(): Promise<void> {
    const files = await readdir(dataPath('assurance', 'reviews')).catch(() => [] as string[]);
    for (const f of files) {
      const t = f.replace(/\.json$/, '');
      if (!f.endsWith('.json') || !isTutorialId(t)) continue;
      let log: Awaited<ReturnType<AssuranceUseCases['log']>>;
      try {
        log = await this.log(t);
      } catch (err) {
        // A damaged history stays as it is; every request for this tutorial fails closed.
        console.error(`[orchestrator] ${(err as Error).message}`);
        continue;
      }
      for (const w of currentWrites(log.kaneWrites ?? [])) {
        if (w.state !== 'pending' || this.activeWrites.has(w.writeId)) continue;
        await this.appendWrite(t, {
          ...w,
          state: 'unknown',
          via: 'startup',
          at: new Date().toISOString(),
          reason: "The orchestrator stopped while this approval was being written to Kane, so the outcome is unknown. Check Kane's store before doing anything else.",
        });
      }
    }
  }

  /** Wait for a job to finish (the runner enforces its own timeout). */
  private async waitJob(started: JobRecord, maxMs: number): Promise<JobRecord> {
    let job = started;
    const until = Date.now() + maxMs;
    while ((job.state === 'queued' || job.state === 'running') && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
      job = await this.jobs.get(started.jobId);
    }
    return job;
  }

  /** Run one free read through the runner and return its raw stdout. */
  private async read(kind: 'fsck' | 'list' | 'view'): Promise<{ job: JobRecord; stdout: string }> {
    const started = kind === 'list' ? await this.jobs.start({ kind, inferred: false }) : await this.jobs.start({ kind });
    const job = await this.waitJob(started, 120_000);
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
      let view: { meta?: { schema?: unknown; tipHash?: unknown }; nodes?: { cid: string; trust: string; label?: string }[]; edges?: { src: string; dst: string; anchors?: string[] }[]; contentHtml?: Record<string, string> } = {};
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
      const tipOk = typeof view.meta?.tipHash === 'string' && !!store.tipPrefix && /^sha256:[a-f0-9]{64}$/.test(view.meta.tipHash) && view.meta.tipHash.startsWith(`sha256:${store.tipPrefix}`);
      if (!tipOk) problems.push("context view's latest commit does not match the store's last record.");
      const tipHash = tipOk ? (view.meta!.tipHash as string) : null;

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
      // `context list` and `context view` must name the same use cases: a use case missing
      // from either (for example a truncated read) fails the integrity check rather than
      // silently disappearing from the review.
      const viewUcs = (view.nodes ?? []).filter((n) => n.label === 'usecase').map((n) => n.cid);
      if (!sortedEq(viewUcs, liveRows.map((r) => r.cid))) problems.push(`context list and context view show different use cases (list: ${liveRows.length}, view: ${viewUcs.length}).`);
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

      // B4: committed review items, with full record hashes (the tip's from the view).
      const kaneReviews: SnapshotKaneReview[] = store.reviews.map((r) => ({
        seq: r.seq,
        recordHash: r.recordHash ?? (r.seq === store.records ? tipHash : null),
        prevHash: r.prevHash,
        ucCid: r.ucCid,
        resolution: r.resolution,
        by: r.by,
        reviewOnly: r.reviewOnly,
        itemsInRecord: r.itemsInRecord,
        build: r.build,
      }));

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
        store: { records: store.records, tipPrefix: store.tipPrefix, tipHash },
        fsck: { ok: fsck.ok === true, issues: fsckIssues },
        requirements,
        source: source ? { cid: source.cid } : null,
        useCases,
        kaneReviews,
        jobs: { fsck: fsckRun.job.jobId, list: listRun.job.jobId, view: viewRun.job.jobId },
      };
      await writeFile(path.join(dir, `snapshot-${pad(n)}.json`), JSON.stringify(snap, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
      return snap;
    });
  }

  async latest(tutorialId: string): Promise<UseCaseSnapshot | null> {
    const files = (await readdir(snapDir(tutorialId)).catch(() => [] as string[])).filter((f) => /^snapshot-[0-9]{4}\.json$/.test(f)).sort();
    if (!files.length) return null;
    const s = await readJson<UseCaseSnapshot>(path.join(snapDir(tutorialId), files[files.length - 1]));
    // Fail closed: an unreadable latest retrieval is never shown as "nothing read yet".
    if (!s) throw new AssuranceError(500, `The latest use-case retrieval (${files[files.length - 1]}) cannot be read. Read the use cases again.`);
    return s;
  }

  private async snapshotNo(tutorialId: string, n: number): Promise<UseCaseSnapshot | null> {
    return readJson<UseCaseSnapshot>(path.join(snapDir(tutorialId), `snapshot-${pad(n)}.json`));
  }

  /**
   * The review history, read fail-closed: only a missing file is an empty history.
   * A file that exists but cannot be read or parsed, or has the wrong shape, is an
   * error, so nothing is shown as unreviewed or unlocked, and no append can
   * overwrite (erase) the history.
   */
  private async log(tutorialId: string): Promise<{ decisions: ReviewEntry[]; kaneWrites: KaneWriteEntry[] }> {
    const file = reviewFile(tutorialId);
    const damaged = () => new AssuranceError(500, `The review history for this tutorial cannot be read, so nothing was shown or changed. Check data/assurance/reviews/${tutorialId}.json; KaneVerity never rewrites a history it cannot read.`);
    let parsed: unknown;
    for (let attempt = 1; ; attempt++) {
      try {
        parsed = JSON.parse(await readFile(file, 'utf8'));
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? '';
        if (code === 'ENOENT') return { decisions: [], kaneWrites: [] };
        // An atomic replace caught mid-way on Windows is retried briefly.
        if ((err instanceof SyntaxError || ['EBUSY', 'EPERM', 'EACCES'].includes(code)) && attempt < 10) {
          await new Promise((r) => setTimeout(r, 20 * attempt));
          continue;
        }
        throw damaged();
      }
    }
    const l = parsed as Partial<ReviewLog> | null;
    if (!l || typeof l !== 'object' || l.tutorialId !== tutorialId || !Array.isArray(l.decisions) || (l.kaneWrites !== undefined && !Array.isArray(l.kaneWrites))) throw damaged();
    return { decisions: l.decisions, kaneWrites: l.kaneWrites ?? [] };
  }

  /** Refuse to write shared history unless this orchestrator still holds the data folder lock. */
  private guardInstance() {
    try {
      assertInstanceLock();
    } catch (err) {
      throw new AssuranceError(503, (err as Error).message);
    }
  }

  /** Append only: the stored entries are kept exactly and the new one goes last. */
  private async appendDecision(tutorialId: string, e: ReviewEntry) {
    this.guardInstance();
    const l = await this.log(tutorialId);
    await writeJson(reviewFile(tutorialId), { tutorialId, decisions: [...l.decisions, e], kaneWrites: l.kaneWrites } satisfies ReviewLog);
  }

  private async appendWrite(tutorialId: string, e: KaneWriteEntry) {
    this.guardInstance();
    const l = await this.log(tutorialId);
    await writeJson(reviewFile(tutorialId), { tutorialId, decisions: l.decisions, kaneWrites: [...l.kaneWrites, e] } satisfies ReviewLog);
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

  /** The Kane side of the latest KaneVerity decision for one use case. */
  private kaneStatus(snap: UseCaseSnapshot, uc: SnapshotUseCase, decisions: ReviewEntry[], writes: KaneWriteEntry[]) {
    const r = reviewState(decisions, uc.cid);
    const current = currentWrites(writes);
    const forDecision = current.filter((w) => w.ucCid === uc.cid && w.decisionId === r.latestId);
    const w = forDecision[forDecision.length - 1] ?? null;
    let state: KaneWriteState | 'none' = w ? w.state : 'none';
    if (state === 'pending' && w && !this.activeWrites.has(w.writeId)) state = 'unknown';
    const items = (snap.kaneReviews ?? []).filter((k) => k.ucCid === uc.cid);
    const lastItem = items[items.length - 1] ?? null;
    const recordInStore = state === 'verified' && !!w && !!lastItem && lastItem.seq === w.kaneSeq && lastItem.resolution === 'approved' && lastItem.recordHash === w.kaneHash;
    // An approval in Kane that no KaneVerity write accounts for. A record found for one
    // of KaneVerity's own writes that is not verified (unknown, written but not
    // verified) is reported through that write's state instead; it never counts.
    const claimed = new Set(current.filter((x) => x.ucCid === uc.cid && x.kaneSeq !== null).map((x) => x.kaneSeq));
    const externalApproval = items.some((k) => k.resolution === 'approved' && !claimed.has(k.seq));
    const status: KaneApprovalStatus = { state, recordInStore, kaneTrust: uc.kaneTrust, externalApproval };
    return { r, w, status };
  }

  /** The latest snapshot with each use case's review state, Kane approval and design eligibility (UI-safe). */
  async view(tutorialId: unknown, note: string | null = null) {
    if (!isTutorialId(tutorialId)) throw new AssuranceError(404, 'Tutorial not found.');
    const snap = await this.latest(tutorialId);
    const { decisions, kaneWrites } = await this.log(tutorialId);
    const reviewer = reviewerSetting();
    const blocking = blockingWrite(kaneWrites);
    const base = {
      tutorialId,
      mode: config.assurance.mode,
      reviewer: { label: reviewer.label, problem: reviewer.problem, selfDeclared: true as const },
      locked: blocking ? { state: blocking.state === 'pending' && !this.activeWrites.has(blocking.writeId) ? 'unknown' : blocking.state, ucCid: blocking.ucCid } : null,
      note,
    };
    if (!snap) return scrubDeep({ ...base, snapshot: null, useCases: [] });
    const current = await this.requirementsCurrent(snap);
    // V2: the latest design attempt per use-case version, and what it allows next.
    const designInfo = new Map<string, { job: JobRecord | null; prev: Awaited<ReturnType<AssuranceUseCases['previousDesign']>> }>();
    for (const uc of snap.useCases) designInfo.set(uc.cid, { job: (await this.designJobs(tutorialId, uc.cid))[0] ?? null, prev: await this.previousDesign(tutorialId, uc.cid) });
    const pub = scrubDeep({
      ...base,
      snapshot: { snapshot: snap.snapshot, retrievedAt: snap.retrievedAt, cliVersion: snap.cliVersion, integrity: snap.integrity, store: { records: snap.store.records, tipPrefix: snap.store.tipPrefix, tipHash: snap.store.tipHash ?? null }, fsck: snap.fsck, requirements: snap.requirements, requirementsCurrent: current },
      useCases: snap.useCases.map((uc) => {
        const { r, w, status } = this.kaneStatus(snap, uc, decisions, kaneWrites);
        const design = designEligibility({ state: r.state, integrityOk: snap.integrity.ok, inLatestSnapshot: true, requirementsCurrent: current, kane: status });
        const canWrite = r.state === 'approved' && (status.state === 'none' || status.state === 'not_written') && !blocking && config.assurance.mode !== 'off' && !!reviewer.label;
        return {
          ...uc,
          review: { state: r.state, history: r.history },
          kane: {
            state: status.state,
            writeId: w?.writeId ?? null,
            decisionId: w?.decisionId ?? null,
            kaneSeq: w?.kaneSeq ?? null,
            kaneHash: w?.kaneHash ?? null,
            kaneBy: w?.kaneBy ?? null,
            reviewer: w?.reviewer ?? null,
            via: w?.via ?? null,
            reason: w?.reason ?? null,
            at: w?.at ?? null,
            recordInStore: status.recordInStore,
            externalApproval: status.externalApproval,
            /** Rejected in KaneVerity while Kane still lists it as trusted (never archived). */
            trustedButRejected: r.state === 'rejected' && uc.kaneTrust === 'trusted',
            canWrite,
            canReconcile: status.state === 'unknown',
          },
          kaneWrites: groupWrites(kaneWrites.filter((x) => x.ucCid === uc.cid), this.activeWrites),
          design,
          testDesign: (() => {
            const d = designInfo.get(uc.cid)!;
            const j = d.job;
            const expired = !!j && j.state === 'paused' && !!j.pause?.expiresAt && Date.parse(j.pause.expiresAt) < Date.now();
            return {
              latestJob: j ? { jobId: j.jobId, kind: j.kind, state: expired ? 'expired' : j.state, reason: j.reason, createdAt: j.createdAt } : null,
              blockedBy: d.prev.block,
              needsAcknowledgement: d.prev.needsAck,
              canStart: design.eligible && config.assurance.mode === 'all' && !!reviewer.label && !d.prev.block && !blocking,
            };
          })(),
        };
      }),
    });
    const leaks = findLeaks(pub);
    if (leaks.length) throw new AssuranceError(500, `Use cases withheld: sensitive data detected (${leaks.join(', ')}).`);
    return pub;
  }

  /**
   * Record a human decision made in KaneVerity's review interface. An approval is
   * then written to Kane and verified (unless that is refused; the reason is
   * returned as a note and the decision stays recorded).
   */
  async review(tutorialId: unknown, ucHex: unknown, body: unknown): Promise<{ entry: ReviewEntry; note: string | null }> {
    if (!isTutorialId(tutorialId)) throw new AssuranceError(404, 'Tutorial not found.');
    if (typeof ucHex !== 'string' || !UC_HEX.test(ucHex)) throw new AssuranceError(404, 'Use case not found.');
    const cid = `sha256:${ucHex}`;
    this.refuseWhileWriting(tutorialId);
    return this.serial(`review:${tutorialId}`, async () => {
      const blocking = blockingWrite((await this.log(tutorialId)).kaneWrites);
      if (blocking) throw new AssuranceError(409, this.lockedMessage(blocking));
      const designing = await this.designActive(tutorialId);
      if (designing) throw new AssuranceError(409, `A test design for this tutorial is ${designing.state} (job ${designing.jobId}). Decisions are locked until it finishes.`);
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
      const reviewer = reviewerSetting();
      if (d.decision === 'approved' && !reviewer.label) throw new AssuranceError(409, reviewer.problem ?? 'No reviewer is set.');
      const s = uc.citationReport.summary;
      const entry: ReviewEntry = {
        id: newId('d'),
        ucCid: cid,
        decision: d.decision,
        reason: d.reason,
        acknowledgedGaps: d.acknowledgedGaps,
        gapsAtDecision: { invalid: s.invalid, stepsCited: s.stepsCited, steps: s.steps, outcomesCited: s.outcomesCited, outcomes: s.outcomes, hasGaps: s.hasGaps },
        snapshot: snap.snapshot,
        at: new Date().toISOString(),
        by: 'kaneverity-review',
        reviewer: reviewer.label,
      };
      await this.appendDecision(tutorialId, entry);
      if (d.decision === 'rejected') return { entry, note: uc.kaneTrust === 'trusted' ? 'Rejection recorded in KaneVerity. Kane still lists this use case as trusted: KaneVerity never archives it, and your rejection keeps it out of test design.' : null };
      try {
        const w = await this.writeLocked(tutorialId, cid);
        return { entry, note: w.reason };
      } catch (err) {
        if (err instanceof AssuranceError) return { entry, note: `Your approval is recorded in KaneVerity, but it was not written to Kane: ${err.message}` };
        throw err;
      }
    });
  }

  /** Write the latest KaneVerity approval of a use case to Kane (retry after "not written", or write later). */
  async writeToKane(tutorialId: unknown, ucHex: unknown): Promise<KaneWriteEntry> {
    if (!isTutorialId(tutorialId)) throw new AssuranceError(404, 'Tutorial not found.');
    if (typeof ucHex !== 'string' || !UC_HEX.test(ucHex)) throw new AssuranceError(404, 'Use case not found.');
    this.refuseWhileWriting(tutorialId);
    return this.serial(`review:${tutorialId}`, () => this.writeLocked(tutorialId, `sha256:${ucHex}`));
  }

  /** Settle an unknown write by reading Kane's store. Never runs the write again. */
  async reconcile(tutorialId: unknown, ucHex: unknown): Promise<KaneWriteEntry> {
    if (!isTutorialId(tutorialId)) throw new AssuranceError(404, 'Tutorial not found.');
    if (typeof ucHex !== 'string' || !UC_HEX.test(ucHex)) throw new AssuranceError(404, 'Use case not found.');
    const cid = `sha256:${ucHex}`;
    this.refuseWhileWriting(tutorialId);
    // Reconciling reads the store with free commands; with Assurance off it cannot,
    // so it is refused before anything is recorded.
    if (config.assurance.mode === 'off') throw new AssuranceError(403, "Kane Assurance commands are switched off, so Kane's store cannot be checked now. The write stays unknown and decisions stay locked.");
    return this.serial(`review:${tutorialId}`, async () => {
      const w = currentWrites((await this.log(tutorialId)).kaneWrites).filter((x) => x.ucCid === cid).pop();
      const state = w && w.state === 'pending' && !this.activeWrites.has(w.writeId) ? 'unknown' : w?.state;
      if (!w || state !== 'unknown') throw new AssuranceError(409, 'There is no write with an unknown outcome to check for this use case.');
      if (w.jobId) {
        const job = await this.jobs.get(w.jobId).catch(() => null);
        if (job && (job.state === 'queued' || job.state === 'running')) throw new AssuranceError(409, 'Kane is still running this write. Check again when it has finished.');
      }
      return this.settle(tutorialId, { ...w, state: 'unknown' }, null, 'reconcile');
    });
  }

  // ---------------------------------------------------------------------------
  // V2: test design, only for the latest KaneVerity approval verified in Kane.
  // ---------------------------------------------------------------------------

  /** Design jobs and design resumes for one tutorial (and use-case version), newest first. */
  private async designJobs(tutorialId: string, ucCid?: string): Promise<JobRecord[]> {
    return (await this.jobs.list(tutorialId)).filter((j) => {
      const p = j.params;
      const cid = p.kind === 'design' ? p.ucCid : p.kind === 'resume' && p.verb === 'design' ? p.ucCid : undefined;
      return cid !== undefined && (!ucCid || cid === ucCid);
    });
  }

  private async designActive(tutorialId: string): Promise<JobRecord | null> {
    return (await this.designJobs(tutorialId)).find((j) => j.state === 'queued' || j.state === 'running') ?? null;
  }

  /**
   * What the latest design attempt for this use-case version allows next:
   * - in progress (queued, running) or paused and not expired: nothing new (answer or abandon it);
   * - complete: already designed (re-design would need --force, which KaneVerity never passes);
   * - refused before doing anything: a new attempt (with a new paid confirmation);
   * - any other outcome (error, crash, interruption, cancellation, abandoned or expired
   *   session): unknown or partial, so a new attempt needs an explicit acknowledgement of
   *   that job id. Nothing is ever retried automatically.
   */
  private async previousDesign(tutorialId: string, ucCid: string): Promise<{ block: string | null; needsAck: string | null }> {
    const latest = (await this.designJobs(tutorialId, ucCid))[0];
    if (!latest) return { block: null, needsAck: null };
    const expired = latest.state === 'paused' && !!latest.pause?.expiresAt && Date.parse(latest.pause.expiresAt) < Date.now();
    if (latest.state === 'queued' || latest.state === 'running') return { block: `A test design for this use case is already ${latest.state} (job ${latest.jobId}).`, needsAck: null };
    if (latest.state === 'paused' && !expired) return { block: `A test design for this use case is paused with Kane's questions (job ${latest.jobId}). Answer it or abandon it first.`, needsAck: null };
    if (latest.state === 'complete') return { block: `This use case already has a test design (job ${latest.jobId}). Designing it again is not supported: it would need --force, which KaneVerity never passes.`, needsAck: null };
    if (latest.state === 'refused') return { block: null, needsAck: null };
    return { block: null, needsAck: latest.jobId };
  }

  /** Fresh read, then every design condition for the exact content id. Returns what the job binds to. */
  private async freshDesignChecks(tutorialId: string, cid: string) {
    const fresh = await this.retrieve(tutorialId);
    const ucNow = fresh.useCases.find((u) => u.cid === cid);
    if (!ucNow) throw new AssuranceError(409, 'Not started: this exact use-case version (content id) is not in Kane\'s store any more. Read the use cases again and review the current version.');
    const { decisions, kaneWrites } = await this.log(tutorialId);
    const { r, status } = this.kaneStatus(fresh, ucNow, decisions, kaneWrites);
    const reqCurrent = await this.requirementsCurrent(fresh);
    const elig = designEligibility({ state: r.state, integrityOk: fresh.integrity.ok, inLatestSnapshot: true, requirementsCurrent: reqCurrent, kane: status });
    if (!elig.eligible || !r.latestId) throw new AssuranceError(409, `Not started: ${elig.reasons.join(' ') || 'the use case is not eligible for test design.'}`);
    // The logical id Kane gives this version now must name exactly this version.
    if (fresh.useCases.filter((u) => u.logicalId === ucNow.logicalId).length !== 1) throw new AssuranceError(409, `Not started: Kane's id ${ucNow.logicalId} does not name exactly one use case.`);
    return { fresh, ucNow, decisionId: r.latestId };
  }

  /**
   * Start test design for one use-case version (V2). Paid: needs Assurance mode "all" and
   * {confirm: {paid: true}}. Optional {max: 1-8} (default 1) and, after an attempt with an
   * unknown outcome, {acknowledgePrevious: "<that job id>"}.
   */
  async design(tutorialId: unknown, ucHex: unknown, body: unknown): Promise<JobRecord> {
    if (!isTutorialId(tutorialId)) throw new AssuranceError(404, 'Tutorial not found.');
    if (typeof ucHex !== 'string' || !UC_HEX.test(ucHex)) throw new AssuranceError(404, 'Use case not found.');
    const cid = `sha256:${ucHex}`;
    const b = (body && typeof body === 'object' ? body : {}) as { confirm?: unknown; max?: unknown; acknowledgePrevious?: unknown };
    this.refuseWhileWriting(tutorialId);
    return this.serial(`review:${tutorialId}`, async () => {
      const reviewer = reviewerSetting();
      if (!reviewer.label) throw new AssuranceError(409, reviewer.problem ?? 'No reviewer is set.');
      // Checked before any Kane read, so a refused request costs nothing.
      if (config.assurance.mode !== 'all') throw new AssuranceError(403, 'Test design uses Kane credits, so it needs Assurance mode "all". Nothing was started.');
      const paidOk = !!b.confirm && typeof b.confirm === 'object' && (b.confirm as { paid?: unknown }).paid === true;
      if (!paidOk) throw new AssuranceError(400, 'This command uses Kane credits. Confirm it explicitly ({"confirm": {"paid": true}}).');
      const max = b.max === undefined ? 1 : b.max;
      if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > 8) throw new AssuranceError(400, 'max must be a whole number from 1 to 8.');
      const blocking = blockingWrite((await this.log(tutorialId)).kaneWrites);
      if (blocking) throw new AssuranceError(409, this.lockedMessage(blocking));
      const prev = await this.previousDesign(tutorialId, cid);
      if (prev.block) throw new AssuranceError(409, prev.block);
      if (prev.needsAck && b.acknowledgePrevious !== prev.needsAck) {
        throw new AssuranceError(409, `The previous design attempt for this use case (job ${prev.needsAck}) ended without a known result. Kane may hold part of a design. Check it, then start again with {"acknowledgePrevious": "${prev.needsAck}"}; it is never retried automatically.`);
      }
      const { fresh, ucNow, decisionId } = await this.freshDesignChecks(tutorialId, cid);
      return this.jobs.startDesign({
        tutorialId,
        ucCid: cid,
        useCase: ucNow.logicalId,
        max,
        reviewer: reviewer.label,
        decisionId,
        acknowledgedPrevious: prev.needsAck,
        requirements: fresh.requirements,
        confirm: b.confirm,
      });
    });
  }

  /** Answer a paused job. A design session is re-checked (fresh read) before its paid resume. */
  /** A design job (or design resume) of this tutorial and this exact use-case version, or 404. */
  private async boundDesignJob(tutorialId: unknown, ucHex: unknown, jobId: unknown) {
    if (!isTutorialId(tutorialId)) throw new AssuranceError(404, 'Tutorial not found.');
    if (typeof ucHex !== 'string' || !UC_HEX.test(ucHex)) throw new AssuranceError(404, 'Use case not found.');
    if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) throw new AssuranceError(404, 'Job not found.');
    const job = await this.jobs.get(jobId);
    const p = job.params;
    const bound = p.kind === 'design' ? p : p.kind === 'resume' && p.verb === 'design' ? p : null;
    if (!bound || job.tutorialId !== tutorialId || bound.ucCid !== `sha256:${ucHex}`) throw new AssuranceError(404, 'No test-design job with this id for this use case.');
    return { job, bound: bound as { ucCid: string; decisionId?: string; reviewer?: string }, tutorialId, cid: `sha256:${ucHex}` };
  }

  /**
   * Answer a paused test-design session (paid): the use case is read again and must still
   * be eligible, with the same KaneVerity decision the design started from.
   */
  async answerDesign(tutorialId: unknown, ucHex: unknown, jobId: unknown, body: unknown): Promise<JobRecord> {
    const { job, bound, tutorialId: t, cid } = await this.boundDesignJob(tutorialId, ucHex, jobId);
    this.refuseWhileWriting(t);
    return this.serial(`review:${t}`, async () => {
      const b = (body && typeof body === 'object' ? body : {}) as { confirm?: unknown };
      const paidOk = !!b.confirm && typeof b.confirm === 'object' && (b.confirm as { paid?: unknown }).paid === true;
      if (!paidOk) throw new AssuranceError(400, 'This command uses Kane credits. Confirm it explicitly ({"confirm": {"paid": true}}).');
      // Refused before any Kane read, like starting a design.
      if (config.assurance.mode !== 'all') throw new AssuranceError(403, 'Answering a test-design session uses Kane credits, so it needs Assurance mode "all". Nothing was started.');
      const reviewer = reviewerSetting();
      if (!reviewer.label || reviewer.label !== bound.reviewer) throw new AssuranceError(409, reviewer.label ? 'Not resumed: the reviewer setting changed since this design started. Abandon this session.' : (reviewer.problem ?? 'No reviewer is set.'));
      if (job.state !== 'paused') return this.jobs.answer(job.jobId, body, { internal: true }); // the runner's own refusal
      const { decisionId } = await this.freshDesignChecks(t, cid);
      if (decisionId !== bound.decisionId) throw new AssuranceError(409, 'Not resumed: the KaneVerity decision this design relies on has changed. Abandon this session.');
      return this.jobs.answer(job.jobId, body, { internal: true });
    });
  }

  /** Stop a running test design, or abandon a paused session (no Kane command; free). */
  async cancelDesign(tutorialId: unknown, ucHex: unknown, jobId: unknown): Promise<JobRecord> {
    const { job } = await this.boundDesignJob(tutorialId, ucHex, jobId);
    return this.jobs.cancel(job.jobId, { internal: true });
  }

  /**
   * Right before Kane starts a design or design resume (the job may have queued behind
   * other Kane work). No Kane command can run here (the Kane lock is held), so this checks
   * KaneVerity's own state against the latest retrieval. A reason means "do not start".
   */
  private async designPreflight(j: JobRecord): Promise<string | null> {
    const p = j.params;
    const bound = p.kind === 'design' ? p : p.kind === 'resume' && p.verb === 'design' ? p : null;
    if (!bound || !j.tutorialId || !bound.ucCid || !bound.decisionId) return 'the job is not bound to a reviewed use case.';
    try {
      const reviewer = reviewerSetting();
      if (!reviewer.label || reviewer.label !== bound.reviewer) return 'the reviewer setting changed since the design was requested.';
      const { decisions, kaneWrites } = await this.log(j.tutorialId);
      if (blockingWrite(kaneWrites)) return 'an approval write to Kane is pending or has an unknown outcome.';
      const snap = await this.latest(j.tutorialId);
      const uc = snap?.useCases.find((u) => u.cid === bound.ucCid);
      if (!snap || !uc) return 'this use-case version is not in the latest retrieval.';
      const { r, status } = this.kaneStatus(snap, uc, decisions, kaneWrites);
      if (r.latestId !== bound.decisionId) return 'the KaneVerity decision changed since the design was requested.';
      const elig = designEligibility({ state: r.state, integrityOk: snap.integrity.ok, inLatestSnapshot: true, requirementsCurrent: await this.requirementsCurrent(snap), kane: status });
      if (!elig.eligible) return elig.reasons.join(' ');
      if (p.kind === 'design' && uc.logicalId !== p.useCase) return `Kane's id for this use case changed (${p.useCase} is now ${uc.logicalId}).`;
      return null;
    } catch (err) {
      return `the checks could not be completed (${(err as Error).message}).`;
    }
  }

  private lockedMessage(w: KaneWriteEntry): string {
    const unknown = w.state === 'unknown' || !this.activeWrites.has(w.writeId);
    return unknown
      ? "An approval write to Kane has an unknown outcome. Check Kane's store for it first; decisions and writes for this tutorial are locked until then."
      : 'An approval is being written to Kane. Decisions and writes for this tutorial are locked until it finishes.';
  }

  /** Pre-write checks, the write, and its verification. Caller holds the tutorial's review lock. */
  private async writeLocked(tutorialId: string, cid: string): Promise<KaneWriteEntry> {
    const reviewer = reviewerSetting();
    if (!reviewer.label) throw new AssuranceError(409, reviewer.problem ?? 'No reviewer is set.');
    if (config.assurance.mode === 'off') throw new AssuranceError(403, 'Kane Assurance commands are switched off, so the approval cannot be written to Kane now. It stays recorded in KaneVerity; write it later from this page.');
    let log = await this.log(tutorialId);
    const blocking = blockingWrite(log.kaneWrites);
    if (blocking) throw new AssuranceError(409, this.lockedMessage(blocking));
    const rs = reviewState(log.decisions, cid);
    if (rs.state !== 'approved' || !rs.latest || !rs.latestId) throw new AssuranceError(409, 'Only a use case whose latest KaneVerity decision is an approval can be recorded in Kane.');
    const decisionId = rs.latestId;
    const prior = currentWrites(log.kaneWrites).filter((w) => w.decisionId === decisionId);
    if (prior.some((w) => w.state === 'verified')) throw new AssuranceError(409, 'This approval is already recorded in Kane and verified.');
    if (prior.some((w) => w.state === 'written_unverified')) throw new AssuranceError(409, 'Kane already holds a record for this approval that KaneVerity could not verify. It is not written again.');
    const decided = await this.snapshotNo(tutorialId, rs.latest.snapshot);
    if (!decided) throw new AssuranceError(409, 'The retrieval this decision was made on is missing.');

    // Fresh read of Kane's store, then every condition the decision was made under.
    const fresh = await this.retrieve(tutorialId);
    const changed: string[] = [];
    const ucNow = fresh.useCases.find((u) => u.cid === cid);
    if (!fresh.integrity.ok) changed.push(`the store failed its integrity checks (${fresh.integrity.problems.join(' ')})`);
    if (!ucNow) changed.push('this exact use-case version (content id) is no longer in Kane');
    if (fresh.source?.cid !== decided.source?.cid) changed.push('the source version changed');
    if (fresh.requirements?.reqSha256 !== decided.requirements?.reqSha256 || !(await this.requirementsCurrent(fresh))) changed.push('the requirements version changed or is no longer current');
    const decidedTip = decided.store.tipHash ?? null;
    const tipSame = decidedTip ? fresh.store.tipHash === decidedTip : fresh.store.tipPrefix === decided.store.tipPrefix;
    if (!tipSame) changed.push("Kane's store changed since your decision (its latest record is different)");
    log = await this.log(tutorialId);
    if (reviewState(log.decisions, cid).latestId !== decisionId) changed.push('a newer decision was recorded');
    if (changed.length) throw new AssuranceError(409, `Not written to Kane: ${changed.join('; ')}. Read the use cases again and decide again.`);

    if (ucNow!.kaneTrust === 'trusted') {
      // Already trusted: acceptable only if that trust is KaneVerity's own earlier
      // verified approval of this exact version, and nothing newer in Kane overrides it.
      const items = (fresh.kaneReviews ?? []).filter((k) => k.ucCid === cid);
      const last = items[items.length - 1];
      const earlier = currentWrites(log.kaneWrites).find((w) => w.state === 'verified' && w.ucCid === cid && last && w.kaneSeq === last.seq && w.kaneHash === last.recordHash && last.resolution === 'approved');
      if (!earlier) throw new AssuranceError(409, 'Kane already lists this use case as trusted, but not through an approval KaneVerity wrote and verified. KaneVerity does not accept that trust and does not write over it.');
      const entry: KaneWriteEntry = {
        type: 'kane_write',
        writeId: newId('w'),
        decisionId,
        ucCid: cid,
        state: 'verified',
        via: 'reuse',
        at: new Date().toISOString(),
        reason: `Kane already holds KaneVerity's earlier verified approval of this exact use case (record #${earlier.kaneSeq}). Kane accepts a verdict only for items waiting for review, so no new record was written; this decision relies on that record.`,
        baseTip: fresh.store.tipHash ?? null,
        baseRecords: fresh.store.records,
        sourceCid: fresh.source?.cid ?? null,
        reqSha256: fresh.requirements?.reqSha256 ?? null,
        jobId: null,
        kaneSeq: earlier.kaneSeq,
        kaneHash: earlier.kaneHash,
        kaneBy: earlier.kaneBy,
        reviewer: reviewer.label,
        reusedFromWriteId: earlier.writeId,
        by: 'kaneverity-review',
      };
      await this.appendWrite(tutorialId, entry);
      return entry;
    }
    if (ucNow!.kaneTrust !== 'derived') throw new AssuranceError(409, `Kane lists this use case as "${ucNow!.kaneTrust}", so an approval cannot be recorded.`);
    if ((fresh.kaneReviews ?? []).some((k) => k.ucCid === cid && k.resolution === 'approved')) throw new AssuranceError(409, 'Kane already holds an approval record for this use case that KaneVerity did not verify. It is not written again.');

    // Never start a Kane write unless this orchestrator still owns the data folder.
    this.guardInstance();
    // The write. From here on, every exit records a state.
    const writeId = newId('w');
    const pending: KaneWriteEntry = {
      type: 'kane_write',
      writeId,
      decisionId,
      ucCid: cid,
      state: 'pending',
      via: 'write',
      at: new Date().toISOString(),
      reason: 'Writing the approval to Kane.',
      baseTip: fresh.store.tipHash ?? null,
      baseRecords: fresh.store.records,
      sourceCid: fresh.source?.cid ?? null,
      reqSha256: fresh.requirements?.reqSha256 ?? null,
      jobId: null,
      kaneSeq: null,
      kaneHash: null,
      kaneBy: null,
      reviewer: reviewer.label,
      reusedFromWriteId: null,
      by: 'kaneverity-review',
    };
    this.activeWrites.add(writeId);
    this.writing.add(tutorialId);
    try {
      await this.appendWrite(tutorialId, pending);
      let job: JobRecord;
      try {
        await mkdir(writeDir(writeId), { recursive: true });
        // Private verdict file: one approval for one exact content id. Kane keeps the
        // reason only in its intent record, so KaneVerity's log holds the link.
        await writeFile(path.join(writeDir(writeId), 'verdicts.json'), JSON.stringify([{ ref: cid, resolution: 'approved', reason: `KaneVerity decision ${decisionId}, write ${writeId}. Reviewer self-declared as ${reviewer.label}.` }], null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
        job = await this.jobs.startReview({ tutorialId, writeId, ucCid: cid, reviewer: reviewer.label });
      } catch (err) {
        // Kane was never started.
        const e: KaneWriteEntry = { ...pending, state: 'not_written', at: new Date().toISOString(), reason: `Kane was not started: ${scrub((err as Error).message)}` };
        await this.appendWrite(tutorialId, e);
        return e;
      }
      await this.appendWrite(tutorialId, { ...pending, jobId: job.jobId, at: new Date().toISOString(), reason: 'Kane is recording the approval.' });
      const done = await this.waitJob(job, config.assurance.timeoutMs + 30_000);
      return await this.settle(tutorialId, { ...pending, jobId: job.jobId }, done, 'write');
    } catch (err) {
      const e: KaneWriteEntry = { ...pending, state: 'unknown', at: new Date().toISOString(), reason: `The write was interrupted (${scrub((err as Error).message)}). Its outcome is unknown; check Kane's store.` };
      await this.appendWrite(tutorialId, e);
      return e;
    } finally {
      this.activeWrites.delete(writeId);
      this.writing.delete(tutorialId);
    }
  }

  /**
   * Decide a write's state from Kane's store (and, right after a write, Kane's own
   * output). Only an exact match is "verified".
   */
  private async settle(tutorialId: string, w: KaneWriteEntry, job: JobRecord | null, via: 'write' | 'reconcile'): Promise<KaneWriteEntry> {
    const record = async (state: KaneWriteState, reason: string, extra: Partial<KaneWriteEntry> = {}) => {
      const e: KaneWriteEntry = { ...w, ...extra, state, via, at: new Date().toISOString(), reason };
      await this.appendWrite(tutorialId, e);
      return e;
    };
    const jobFinished = job ? !['queued', 'running'].includes(job.state) : true;
    if (!jobFinished) return record('unknown', "Kane did not finish within the time allowed. The outcome is unknown; check Kane's store.");

    let post: UseCaseSnapshot;
    try {
      post = await this.retrieve(tutorialId);
    } catch (err) {
      return record('unknown', `Kane's store could not be read after the write (${scrub((err as Error).message)}). The outcome is unknown.`);
    }

    // Kane's own confirmation (only right after a write): exactly one line for this content id.
    let outputConfirms: boolean | null = null;
    if (job) {
      const out = await readFile(jobStdoutPath(job.jobId), 'utf8').catch(() => '');
      const lines = out.split(/\r?\n/).filter((l) => l.trim());
      try {
        const objs = lines.map((l) => JSON.parse(l));
        outputConfirms = objs.length === 1 && objs[0].cid === w.ucCid && objs[0].resolution === 'approved';
      } catch {
        outputConfirms = false;
      }
    }

    const after = (post.kaneReviews ?? []).filter((k) => k.seq > w.baseRecords);
    const approvals = after.filter((k) => k.ucCid === w.ucCid && k.resolution === 'approved');
    if (approvals.length === 0) {
      if (!post.integrity.ok) return record('unknown', `Kane's store failed its integrity checks after the write (${post.integrity.problems.join(' ')}). The outcome is unknown.`);
      if (outputConfirms) return record('unknown', "Kane reported the approval, but no approval record for this use case is in its store. The outcome is unknown.");
      const unchanged = post.store.records === w.baseRecords && post.store.tipHash === w.baseTip;
      return record('not_written', unchanged ? `Kane did not record the approval; its store is unchanged.${job ? ` ${job.reason}` : ''}` : "Kane's store holds no approval record for this use case after the write, so it was not written. (Other records were added meanwhile.)");
    }

    const r = approvals[0];
    const ucAfter = post.useCases.find((u) => u.cid === w.ucCid);
    const base = await this.findSnapshotWithTip(tutorialId, w.baseTip);
    const ucBefore = base?.useCases.find((u) => u.cid === w.ucCid) ?? null;
    const expectedBy = `human:${kaneUserFor(w.reviewer)}`;
    const problems: string[] = [];
    if (!post.integrity.ok) problems.push(`the store failed its integrity checks (${post.integrity.problems.join(' ')})`);
    if (approvals.length !== 1) problems.push('Kane holds more than one new approval for this use case');
    if (r.seq !== w.baseRecords + 1 || post.store.records !== w.baseRecords + 1) problems.push(`the approval is not the single next record (record #${r.seq}; the store has ${post.store.records} records, ${w.baseRecords} before)`);
    if (!r.reviewOnly || r.itemsInRecord !== 1) problems.push('the record holds more than this one approval');
    if (r.prevHash !== w.baseTip) problems.push('the record does not follow the store tip the write started from');
    if (r.by !== expectedBy) problems.push(`Kane recorded it as "${r.by}", not "${expectedBy}"`);
    if (r.build !== config.assurance.pinnedVersion) problems.push(`it was written by Kane ${r.build ?? 'unknown'}, not ${config.assurance.pinnedVersion}`);
    if (!r.recordHash) problems.push("the record's hash could not be confirmed");
    if (!ucAfter) problems.push('the use case (same content id) is no longer listed');
    else {
      if (ucAfter.kaneTrust !== 'trusted') problems.push(`Kane lists it as "${ucAfter.kaneTrust}", not trusted`);
      if (ucBefore && citationsKey(ucBefore) !== citationsKey(ucAfter)) problems.push('its citations changed');
    }
    if (post.source?.cid !== w.sourceCid) problems.push('the source version changed');
    if (post.requirements?.reqSha256 !== w.reqSha256) problems.push('the requirements version changed');
    if (via === 'write' && outputConfirms === false) problems.push("Kane's output did not confirm this exact approval");
    const found = { kaneSeq: r.seq, kaneHash: r.recordHash, kaneBy: r.by };

    if (via === 'write' && job && job.state !== 'complete') {
      return record('unknown', `Kane wrote an approval record (#${r.seq}), but its process did not finish normally (${job.reason.replace(/\.$/, '')}). Check Kane's store to confirm it.`, found);
    }
    if (problems.length) return record('written_unverified', `Kane holds an approval record (#${r.seq}) that KaneVerity could not verify: ${problems.join('; ')}.`, found);
    return record('verified', `Verified in Kane: record #${r.seq} approves this exact use case, recorded as ${r.by}; Kane lists it as trusted.`, found);
  }

  /** The newest snapshot whose store tip was the given hash (the state the write started from). */
  private async findSnapshotWithTip(tutorialId: string, tip: string | null): Promise<UseCaseSnapshot | null> {
    if (!tip) return null;
    const files = (await readdir(snapDir(tutorialId)).catch(() => [] as string[])).filter((f) => /^snapshot-[0-9]{4}\.json$/.test(f)).sort().reverse();
    for (const f of files) {
      const s = await readJson<UseCaseSnapshot>(path.join(snapDir(tutorialId), f));
      if (s?.store.tipHash === tip) return s;
    }
    return null;
  }

  /** For test design (B5+): may this use case proceed? Uses the latest retrieval. */
  async eligibility(tutorialId: string, cid: string) {
    const snap = await this.latest(tutorialId);
    const uc = snap?.useCases.find((u) => u.cid === cid);
    const { decisions, kaneWrites } = await this.log(tutorialId);
    const state = reviewState(decisions, cid).state;
    const kane: KaneApprovalStatus = snap && uc ? this.kaneStatus(snap, uc, decisions, kaneWrites).status : { state: 'none', recordInStore: false, kaneTrust: 'unknown', externalApproval: false };
    return designEligibility({ state, integrityOk: !!snap?.integrity.ok, inLatestSnapshot: !!uc, requirementsCurrent: snap ? await this.requirementsCurrent(snap) : false, kane });
  }
}
