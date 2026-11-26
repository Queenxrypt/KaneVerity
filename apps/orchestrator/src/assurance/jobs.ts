// Kane Assurance job runner (Assurance B2).
//
// - One job at a time, and never alongside a verification run (shared Kane lock).
// - Each job checks the pinned Kane CLI version, then starts Kane directly
//   (node + kane-cli.cjs, no shell, stdin not a terminal) in the workspace under
//   data/assurance/workspace/, with KANE_CONTEXT_GITIGNORE=0.
// - Off by default: config.assurance.mode gates every command; paid commands also
//   need an explicit confirmation per job.
// - Raw output stays private (data/assurance/jobs/<id>/private/); the public job is
//   allow-listed, scrubbed and leak-checked.
// - A pause keeps Kane's questions; only the user's validated answers resume it.
// - Cost: Kane-reported usage when present; otherwise the balance difference
//   (measured); otherwise "unknown", never 0.
// - After a restart, a job that was running is marked interrupted; nothing paid is
//   ever retried automatically.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.ts';
import { kaneLock, type KaneLock } from '../kane/lock.ts';
import { addCredits, dataPath, readJson, writeJson, type CostBasis } from '../store.ts';
import { findLeaks, scrub, scrubDeep } from '../verify/redact.ts';
import { type CorrectiveInputs, type CorrectiveKeep, type EvolveInputs, type EvolveScopePrint, type RedesignPhase, buildArgs, CommandError, isJobKind, JOB_KINDS, kaneUserFor, parseBalance, parseIngestReceipt, requirementsFileFor, validateAnswers, type JobKind, type JobParams } from './commands.ts';
import { AssuranceError, RequirementsService } from './service.ts';
import { isTutorialId } from './store.ts';
import { applyAssuranceLine, emptyAssuranceStream, outcomeOf, type ParsedAssuranceStream, type PendingQuestion } from './stream.ts';

export type JobState = 'queued' | 'running' | 'complete' | 'paused' | 'answered' | 'refused' | 'error' | 'crashed' | 'interrupted' | 'cancelled' | 'abandoned';

export const JOB_ID_PATTERN = /^j[0-9]{8}-[0-9]{6}-[a-f0-9]{6}$/;

export interface JobRecord {
  jobId: string;
  kind: JobKind;
  params: JobParams;
  tutorialId: string | null;
  state: JobState;
  reason: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  args: string[];
  exitCode: number | null;
  cliVersion: string | null;
  verb: string | null;
  doneStatus: string | null;
  next: string[];
  pause: { sid: string; expiresAt: string | null; questions: PendingQuestion[]; crashed: boolean; held: number | null } | null;
  parentJobId: string | null;
  resumedBy: string | null;
  requirements: { version: number; reqSha256: string; docSha256: string } | null;
  credits: { amount: number | null; basis: CostBasis | null; reportedTotal: number | null; measured: number | null; balanceBefore: number | null; balanceAfter: number | null };
  summary: {
    ingested: { sourceId: string; status: string }[];
    commits: { counts: Record<string, number>; minted: string[] }[];
    warnings: string[];
    errors: string[];
    held: number;
    messages: string[];
    unknownEventTypes: string[];
    nonJsonLines: number;
    invalidLines: number;
  };
}

type Spawned = { exitCode: number | null; stdout: string; stderrTail: string; killed: boolean; cancelled: boolean; spawnError: string | null };

const jobDir = (id: string, ...p: string[]) => {
  if (!JOB_ID_PATTERN.test(id)) throw new AssuranceError(404, 'Job not found.');
  return dataPath('assurance', 'jobs', id, ...p);
};

/** A finished job's raw stdout (private; read only by orchestrator code such as B3 retrieval). */
export function jobStdoutPath(id: string): string {
  return jobDir(id, 'private', 'stdout.ndjson');
}

function newJobId(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const d = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const t = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `j${d}-${t}-${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`;
}

/**
 * B5: the evolve that uses up this use-case version's one evolve, or null. Every evolve counts,
 * whatever became of it (complete, paused, failed, crashed, interrupted, unknown), except one
 * KaneVerity refused before Kane started (state "refused", no exit code: Kane never ran).
 * Read from the job records on disk, so it survives restarts.
 */
export function usedEvolve(jobs: JobRecord[], ucCid: string): JobRecord | null {
  return jobs.find((j) => j.params.kind === 'evolve' && j.params.ucCid === ucCid && !j.params.corrective && !(j.state === 'refused' && j.exitCode === null)) ?? null;
}

/** B5: the one corrective evolve of this use-case version (section 13.13), or null. Counted like usedEvolve. */
export function usedCorrectiveEvolve(jobs: JobRecord[], ucCid: string): JobRecord | null {
  return jobs.find((j) => j.params.kind === 'evolve' && j.params.ucCid === ucCid && !!j.params.corrective && !(j.state === 'refused' && j.exitCode === null)) ?? null;
}

/** A test-design job, the resume of a design session (V2), or an evolve (B5): never answered or stopped from the generic jobs API. */
export function isDesignFamily(j: JobRecord): boolean {
  return j.params.kind === 'design' || j.params.kind === 'evolve' || (j.params.kind === 'resume' && j.params.verb === 'design');
}

const isExpired = (j: JobRecord, now: Date) => j.state === 'paused' && !!j.pause?.expiresAt && Date.parse(j.pause.expiresAt) < now.getTime();

/** UI-safe job: allow-listed, scrubbed, leak-checked; no paths, no raw output, no balances. */
export function publicJob(j: JobRecord, now = new Date()) {
  const info = JOB_KINDS[j.kind];
  const pub = scrubDeep({
    jobId: j.jobId,
    kind: j.kind,
    label: info.label,
    paid: info.paid,
    tutorialId: j.tutorialId,
    state: isExpired(j, now) ? 'expired' : j.state,
    reason: j.reason,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    exitCode: j.exitCode,
    cliVersion: j.cliVersion,
    doneStatus: j.doneStatus,
    next: j.next,
    params: j.params.kind === 'resume' ? { kind: 'resume', verb: j.params.verb, answers: j.params.answers, ...(j.params.ucCid ? { ucCid: j.params.ucCid } : {}) } : j.params,
    pause: j.pause && { expiresAt: j.pause.expiresAt, questions: j.pause.questions, crashed: j.pause.crashed, held: j.pause.held },
    parentJobId: j.parentJobId,
    resumedBy: j.resumedBy,
    requirements: j.requirements,
    credits: { amount: j.credits.amount, basis: j.credits.basis, reportedTotal: j.credits.reportedTotal, measured: j.credits.measured },
    summary: j.summary,
  });
  const leaks = findLeaks(pub);
  if (leaks.length) return { jobId: j.jobId, kind: j.kind, state: j.state, reason: `Details withheld: sensitive data detected (${leaks.join(', ')}).` };
  return pub;
}

export interface StartRequest {
  kind?: unknown;
  tutorialId?: unknown;
  useCase?: unknown;
  max?: unknown;
  inferred?: unknown;
  /** Paid commands need {confirm: {paid: true}} on every request. */
  confirm?: unknown;
}

export class AssuranceJobs extends EventEmitter {
  private queue: string[] = [];
  private records = new Map<string, JobRecord>();
  private active: { jobId: string; kill: (() => void) | null; cancelled: boolean } | null = null;
  private versionChecked: string | null = null;
  private entry: string | null;
  private lock: KaneLock;
  private requirements: RequirementsService;

  constructor(opts: { entry?: string | null; lock?: KaneLock; requirements?: RequirementsService } = {}) {
    super();
    this.entry = opts.entry === undefined ? config.kane.entry : opts.entry;
    this.lock = opts.lock ?? kaneLock;
    this.requirements = opts.requirements ?? new RequirementsService();
  }

  /** After a restart: a job that was queued or running is interrupted. Nothing is retried. */
  async init(): Promise<void> {
    const ids = await readdir(dataPath('assurance', 'jobs')).catch(() => [] as string[]);
    for (const id of ids) {
      if (!JOB_ID_PATTERN.test(id)) continue;
      const j = await readJson<JobRecord>(jobDir(id, 'job.json'));
      if (!j || (j.state !== 'queued' && j.state !== 'running')) continue;
      const wasRunning = j.state === 'running';
      j.state = 'interrupted';
      j.finishedAt ??= new Date().toISOString();
      j.reason = wasRunning
        ? "The orchestrator stopped while this job was running, so its outcome is unknown. Check Kane's sessions before starting anything paid again."
        : 'The orchestrator stopped before this job started. Nothing ran.';
      if (wasRunning && JOB_KINDS[j.kind].paid && j.credits.basis === null) {
        j.credits.basis = 'unknown';
        await addCredits({ runId: j.jobId, credits: 0, basis: 'unknown', kind: `assurance:${j.kind}`, at: j.finishedAt, note: 'Interrupted by an orchestrator restart; cost unknown.' });
      }
      await this.persist(j);
    }
  }

  async list(tutorialId: string | null = null): Promise<JobRecord[]> {
    const ids = await readdir(dataPath('assurance', 'jobs')).catch(() => [] as string[]);
    const out: JobRecord[] = [];
    for (const id of ids) {
      if (!JOB_ID_PATTERN.test(id)) continue;
      const j = this.records.get(id) ?? (await readJson<JobRecord>(jobDir(id, 'job.json')));
      if (j && (!tutorialId || j.tutorialId === tutorialId)) out.push(j);
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string): Promise<JobRecord> {
    if (!JOB_ID_PATTERN.test(id)) throw new AssuranceError(404, 'Job not found.');
    const j = this.records.get(id) ?? (await readJson<JobRecord>(jobDir(id, 'job.json')));
    if (!j) throw new AssuranceError(404, 'Job not found.');
    return j;
  }

  private gate(kind: JobKind, confirm: unknown) {
    const mode = config.assurance.mode;
    if (mode === 'off') throw new AssuranceError(403, 'Kane Assurance commands are switched off. They stay off until the validation runs are approved.');
    if (JOB_KINDS[kind].paid) {
      if (mode !== 'all') throw new AssuranceError(403, 'Only free Assurance commands are switched on. Commands that use credits are not allowed yet.');
      const ok = !!confirm && typeof confirm === 'object' && (confirm as { paid?: unknown }).paid === true;
      if (!ok) throw new AssuranceError(400, 'This command uses Kane credits. Confirm it explicitly ({"confirm": {"paid": true}}).');
    }
    if (!this.entry) throw new AssuranceError(409, 'Kane CLI was not found.');
  }

  /** Start a job of an allow-listed kind. */
  async start(req: StartRequest): Promise<JobRecord> {
    if (!isJobKind(req.kind) || req.kind === 'resume' || JOB_KINDS[req.kind].internal) throw new AssuranceError(400, 'Unknown job kind.');
    const kind = req.kind;
    this.gate(kind, req.confirm);
    let params: JobParams;
    let tutorialId: string | null = null;
    let requirements: JobRecord['requirements'] = null;
    try {
      if (kind === 'ingest' || kind === 'extract') {
        if (!isTutorialId(req.tutorialId)) throw new AssuranceError(404, 'Tutorial not found.');
        tutorialId = req.tutorialId;
        // Only current, intact requirements may reach Kane.
        const d = await this.requirements.get(tutorialId);
        if (d.state !== 'current' || !d.shown || !d.shown.intact || !d.shown.isLatest) {
          throw new AssuranceError(409, 'The requirements for this tutorial are not current. Generate them on the Verification material page first.');
        }
        requirements = { version: d.shown.version, reqSha256: d.shown.reqSha256, docSha256: d.shown.docSha256 };
        if (kind === 'extract') {
          const landed = (await this.list(tutorialId)).find((j) => j.kind === 'ingest' && j.state === 'complete' && j.requirements?.reqSha256 === requirements!.reqSha256);
          if (!landed) throw new AssuranceError(409, 'Land the current requirements in the Assurance store first.');
        }
        params = { kind, tutorialId };
      } else if (kind === 'list') {
        params = { kind, inferred: req.inferred === true };
      } else if (kind === 'view' || kind === 'fsck') {
        params = { kind };
      } else {
        params = { kind: 'cover' };
      }
    } catch (err) {
      if (err instanceof CommandError) throw new AssuranceError(400, err.message);
      throw err;
    }
    // Store-writing jobs never run twice for the same tutorial at once.
    if (JOB_KINDS[kind].writesStore && tutorialId) {
      const busy = [...this.records.values()].find((j) => j.tutorialId === tutorialId && (j.state === 'queued' || j.state === 'running'));
      if (busy) throw new AssuranceError(409, `A job for this tutorial is already ${busy.state}.`);
    }
    return this.enqueue(kind, params, tutorialId, requirements, null);
  }

  /**
   * B4: record one KaneVerity approval in Kane's store. Called only by the approval
   * workflow (usecases.ts), after its own checks and after it wrote the private
   * verdict file. Free; needs Assurance mode "free" or "all".
   */
  /**
   * V2: design tests for one exact use-case version. Called only by the use-case design
   * endpoint (usecases.ts) after its fresh checks. Paid: needs Assurance mode "all" and an
   * explicit confirmation, like every paid command. Just before Kane starts, the design
   * preflight re-checks KaneVerity's own state (the job may have waited in the queue).
   */
  async startDesign(p: { tutorialId: string; ucCid: string; useCase: string; max: number; reviewer: string; decisionId: string; acknowledgedPrevious: string | null; redesign?: { phase: RedesignPhase; acknowledgement: string } | null; requirements: JobRecord['requirements']; confirm: unknown }): Promise<JobRecord> {
    this.gate('design', p.confirm);
    if (!isTutorialId(p.tutorialId)) throw new AssuranceError(404, 'Tutorial not found.');
    const busy = [...this.records.values()].find((j) => j.tutorialId === p.tutorialId && (j.state === 'queued' || j.state === 'running'));
    if (busy) throw new AssuranceError(409, `A job for this tutorial is already ${busy.state}.`);
    const params: JobParams = { kind: 'design', tutorialId: p.tutorialId, ucCid: p.ucCid, useCase: p.useCase, max: p.max, reviewer: p.reviewer, decisionId: p.decisionId, acknowledgedPrevious: p.acknowledgedPrevious, ...(p.redesign ? { redesign: { phase: p.redesign.phase, acknowledgement: p.redesign.acknowledgement } } : {}) };
    return this.enqueue('design', params, p.tutorialId, p.requirements, null);
  }

  /**
   * B5: one `maintain evolve` of a use case (paid: Assurance mode "all" and an explicit
   * confirmation). Called only by the design service after its fresh checks; right before Kane
   * starts, the design preflight re-checks the use case, the decision and the reviewer.
   */
  async startEvolve(p: { tutorialId: string; ucCid: string; useCase: string; reviewer: string; decisionId: string; inputs: EvolveInputs; instruction: string; acknowledgement: string; scope?: EvolveScopePrint; corrective?: { inputs: CorrectiveInputs; keep: CorrectiveKeep }; requirements: JobRecord['requirements']; confirm: unknown }): Promise<JobRecord> {
    this.gate('evolve', p.confirm);
    if (!isTutorialId(p.tutorialId)) throw new AssuranceError(404, 'Tutorial not found.');
    const busy = [...this.records.values()].find((j) => j.tutorialId === p.tutorialId && (j.state === 'queued' || j.state === 'running'));
    if (busy) throw new AssuranceError(409, `A job for this tutorial is already ${busy.state}.`);
    const params: JobParams = { kind: 'evolve', tutorialId: p.tutorialId, ucCid: p.ucCid, useCase: p.useCase, reviewer: p.reviewer, decisionId: p.decisionId, inputs: p.inputs, instruction: p.instruction, acknowledgement: p.acknowledgement, ...(p.scope ? { scope: p.scope } : {}), ...(p.corrective ? { corrective: p.corrective } : {}) };
    return this.enqueue('evolve', params, p.tutorialId, p.requirements, null);
  }

  /**
   * Set by the design service: for an evolve, the last check right before Kane is spawned (after
   * the design preflight). It compares the job with its record on disk, rebuilds the arguments
   * from the stored parameters, and rebuilds the instruction from a fresh, integrity-checked
   * read of the store and requirements. A reason to refuse, or null. It never changes the job.
   */
  private evolveSpawnCheck: ((j: JobRecord) => Promise<string | null>) | null = null;
  setEvolveSpawnCheck(fn: (j: JobRecord) => Promise<string | null>) {
    this.evolveSpawnCheck = fn;
  }

  /** Set by the use-case service: a reason to refuse a design (or design resume) right before Kane starts, or null. */
  private designPreflight: ((j: JobRecord) => Promise<string | null>) | null = null;
  setDesignPreflight(fn: (j: JobRecord) => Promise<string | null>) {
    this.designPreflight = fn;
  }

  async startReview(p: { tutorialId: string; writeId: string; ucCid: string; reviewer: string }): Promise<JobRecord> {
    this.gate('review', undefined);
    if (!isTutorialId(p.tutorialId)) throw new AssuranceError(404, 'Tutorial not found.');
    const busy = [...this.records.values()].find((j) => j.tutorialId === p.tutorialId && (j.state === 'queued' || j.state === 'running'));
    if (busy) throw new AssuranceError(409, `A job for this tutorial is already ${busy.state}.`);
    return this.enqueue('review', { kind: 'review', tutorialId: p.tutorialId, writeId: p.writeId, ucCid: p.ucCid, reviewer: p.reviewer }, p.tutorialId, null, null);
  }

  /** B5: plan the approved tests (free). Called only by the design review service. */
  async startDryRun(p: { tutorialId: string; files: string[] }): Promise<JobRecord> {
    this.gate('dryrun', undefined);
    if (!isTutorialId(p.tutorialId)) throw new AssuranceError(404, 'Tutorial not found.');
    const busy = [...this.records.values()].find((j) => j.tutorialId === p.tutorialId && (j.state === 'queued' || j.state === 'running'));
    if (busy) throw new AssuranceError(409, `A job for this tutorial is already ${busy.state}.`);
    return this.enqueue('dryrun', { kind: 'dryrun', tutorialId: p.tutorialId, files: p.files }, p.tutorialId, null, null);
  }

  /**
   * B5: run the approved tests. Paid: Assurance mode "all" and an explicit confirmation.
   * Called only by the design execution endpoint after its fresh checks; right before Kane
   * starts, the run preflight re-checks KaneVerity's state against the readiness fingerprint.
   */
  async startTestRun(p: { tutorialId: string; ucCid: string; files: string[]; reviewer: string; readinessSha256: string; requirements: JobRecord['requirements']; confirm: unknown }): Promise<JobRecord> {
    this.gate('testrun', p.confirm);
    if (!isTutorialId(p.tutorialId)) throw new AssuranceError(404, 'Tutorial not found.');
    const busy = [...this.records.values()].find((j) => j.tutorialId === p.tutorialId && (j.state === 'queued' || j.state === 'running'));
    if (busy) throw new AssuranceError(409, `A job for this tutorial is already ${busy.state}.`);
    return this.enqueue('testrun', { kind: 'testrun', tutorialId: p.tutorialId, ucCid: p.ucCid, files: p.files, reviewer: p.reviewer, readinessSha256: p.readinessSha256 }, p.tutorialId, p.requirements, null);
  }

  /** Set by the design review service: a reason to refuse a test run right before Kane starts, or null. */
  private runPreflight: ((j: JobRecord) => Promise<string | null>) | null = null;
  setRunPreflight(fn: (j: JobRecord) => Promise<string | null>) {
    this.runPreflight = fn;
  }

  /** Answer a paused job's questions; starts a resume job (it uses credits). */
  /**
   * Answer a paused job. A test-design session (V2) is answered only through its use
   * case's design endpoint ({internal: true}), which re-checks the use case first.
   */
  async answer(id: string, body: unknown, opts: { internal?: boolean } = {}): Promise<JobRecord> {
    if (!opts.internal && isDesignFamily(await this.get(id))) throw new AssuranceError(409, "Test-design sessions are answered from their use case (POST /api/assurance/usecases/:tutorialId/:contentId/design/:jobId/answer), which re-checks the use case first.");
    const parent = await this.get(id);
    if (parent.state !== 'paused' || !parent.pause) throw new AssuranceError(409, 'Only a paused job can be answered.');
    if (isExpired(parent, new Date())) throw new AssuranceError(409, 'This Kane session has expired (sessions last 24 hours). Start again.');
    const verb = parent.verb === 'extract' || parent.verb === 'design' ? parent.verb : null;
    if (!verb) throw new AssuranceError(409, 'This kind of session cannot be resumed here.');
    const b = (body && typeof body === 'object' ? body : {}) as { answers?: unknown; confirm?: unknown };
    this.gate('resume', b.confirm);
    let answers: { id: string; value: string }[];
    try {
      answers = parent.pause.questions.length ? validateAnswers(parent.pause.questions, b.answers, config.assurance.maxAnswerLength) : [];
    } catch (err) {
      if (err instanceof CommandError) throw new AssuranceError(400, err.message);
      throw err;
    }
    // A design session keeps its binding: the same use-case version, decision and reviewer.
    const bound = parent.params.kind === 'design' ? parent.params : parent.params.kind === 'resume' && parent.params.verb === 'design' ? parent.params : null;
    const params: JobParams = bound && verb === 'design' ? { kind: 'resume', verb, sid: parent.pause.sid, answers, ucCid: bound.ucCid, decisionId: bound.decisionId, reviewer: bound.reviewer } : { kind: 'resume', verb, sid: parent.pause.sid, answers };
    const child = await this.enqueue('resume', params, parent.tutorialId, parent.requirements, parent.jobId);
    parent.state = 'answered';
    parent.resumedBy = child.jobId;
    parent.reason = `Answered; resumed as job ${child.jobId}.`;
    await this.persist(parent);
    return child;
  }

  /** Stop, cancel or abandon a job. A test-design job (V2) only through its use case's design endpoint ({internal: true}). */
  async cancel(id: string, opts: { internal?: boolean } = {}): Promise<JobRecord> {
    const j = await this.get(id);
    if (!opts.internal && isDesignFamily(j)) throw new AssuranceError(409, 'Test-design jobs are stopped or abandoned from their use case (POST /api/assurance/usecases/:tutorialId/:contentId/design/:jobId/cancel).');
    // An approval write (B4) is never stopped from the jobs API: stopping it mid-write
    // would only make its outcome unknown. It ends by itself or by the runner's timeout.
    if (JOB_KINDS[j.kind].cancellable === false) throw new AssuranceError(409, 'This job records an approval in Kane and cannot be cancelled here.');
    if (j.state === 'queued') {
      this.queue = this.queue.filter((x) => x !== id);
      j.state = 'cancelled';
      j.reason = 'Cancelled before it started. Nothing ran.';
      j.finishedAt = new Date().toISOString();
      await this.persist(j);
      return j;
    }
    if (j.state === 'running' && this.active?.jobId === id) {
      this.active.cancelled = true;
      this.active.kill?.();
      return j;
    }
    if (j.state === 'paused') {
      j.state = 'abandoned';
      j.reason = "Abandoned. Kane keeps the paused session until it expires (24 hours); KaneVerity won't resume it.";
      await this.persist(j);
      return j;
    }
    throw new AssuranceError(409, `A ${j.state} job cannot be cancelled.`);
  }

  private async enqueue(kind: JobKind, params: JobParams, tutorialId: string | null, requirements: JobRecord['requirements'], parentJobId: string | null): Promise<JobRecord> {
    let args: string[];
    try {
      args = buildArgs(params);
    } catch (err) {
      throw new AssuranceError(400, (err as Error).message);
    }
    const j: JobRecord = {
      jobId: newJobId(),
      kind,
      params,
      tutorialId,
      state: 'queued',
      reason: 'Waiting for any other Kane process to finish.',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      args,
      exitCode: null,
      cliVersion: null,
      verb: null,
      doneStatus: null,
      next: [],
      pause: null,
      parentJobId,
      resumedBy: null,
      requirements,
      credits: { amount: null, basis: null, reportedTotal: null, measured: null, balanceBefore: null, balanceAfter: null },
      summary: { ingested: [], commits: [], warnings: [], errors: [], held: 0, messages: [], unknownEventTypes: [], nonJsonLines: 0, invalidLines: 0 },
    };
    this.records.set(j.jobId, j);
    await this.persist(j);
    this.queue.push(j.jobId);
    void this.pump();
    return j;
  }

  private async persist(j: JobRecord): Promise<void> {
    this.records.set(j.jobId, j);
    await writeJson(jobDir(j.jobId, 'job.json'), j);
    this.emit('update', j.jobId);
  }

  private async pump(): Promise<void> {
    if (this.active || this.queue.length === 0) return;
    const id = this.queue.shift()!;
    const j = this.records.get(id)!;
    this.active = { jobId: id, kill: null, cancelled: false };
    const release = await this.lock.acquire(`assurance:${id}`);
    try {
      await this.execute(j);
    } catch (err) {
      j.state = 'error';
      j.reason = `Internal error: ${scrub((err as Error).message)}`;
    } finally {
      release();
      j.finishedAt ??= new Date().toISOString();
      await this.persist(j);
      this.active = null;
      void this.pump();
    }
  }

  /** Run Kane once; no shell, stdin closed (not a terminal), private output files. */
  private run(args: string[], cwd: string, outFile: string | null, track: boolean, extraEnv: Record<string, string> = {}): Promise<Spawned> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let killed = false;
      let spawnError: string | null = null;
      const child = spawn(process.execPath, [this.entry!, ...args], {
        cwd,
        env: { ...process.env, ...extraEnv, KANE_CONTEXT_GITIGNORE: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
      const out = outFile ? createWriteStream(outFile, { flags: 'a' }) : null;
      const kill = () => {
        killed = true;
        child.kill();
      };
      if (track && this.active) this.active.kill = kill;
      const timer = setTimeout(kill, config.assurance.timeoutMs);
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (c: string) => {
        if (stdout.length < 5_000_000) stdout += c;
        out?.write(c);
      });
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (c: string) => {
        stderr = (stderr + c).slice(-8000);
      });
      child.on('error', (e) => (spawnError = e.message));
      child.on('close', (code) => {
        clearTimeout(timer);
        const done = () => resolve({ exitCode: code, stdout, stderrTail: stderr, killed, cancelled: !!(track && this.active?.cancelled), spawnError });
        // Resolve only once the private output file is fully written: retrieval reads it
        // right after the job completes, and a partly flushed file could drop the last lines.
        if (out) out.end(done);
        else done();
      });
    });
  }

  private async balance(cwd: string): Promise<number | null> {
    const r = await this.run(['balance'], cwd, null, false);
    return r.exitCode === 0 ? parseBalance(r.stdout) : null;
  }

  private async execute(j: JobRecord): Promise<void> {
    const ws = config.assurance.workspaceDir;
    await mkdir(path.join(ws, 'requirements'), { recursive: true });
    await mkdir(jobDir(j.jobId, 'private'), { recursive: true });
    j.state = 'running';
    j.startedAt = new Date().toISOString();
    j.reason = 'Kane is running.';
    await this.persist(j);

    // The pinned version, checked once per orchestrator process.
    if (!this.versionChecked) {
      const v = await this.run(['--version'], ws, null, false);
      const version = v.stdout.trim().split(/\s+/).pop() ?? '';
      if (v.exitCode !== 0 || version !== config.assurance.pinnedVersion) {
        j.state = 'refused';
        j.reason = `Kane CLI ${version || 'version unknown'} is installed, but KaneVerity is pinned to ${config.assurance.pinnedVersion} for Assurance. Nothing ran.`;
        return;
      }
      this.versionChecked = version;
    }
    j.cliVersion = this.versionChecked;

    if (j.params.kind === 'ingest') {
      // Hand Kane exactly the stored, current requirements bytes.
      const d = await this.requirements.get(j.params.tutorialId);
      if (d.state !== 'current' || !d.shown || !d.shown.intact || d.shown.reqSha256 !== j.requirements?.reqSha256) {
        j.state = 'refused';
        j.reason = 'The requirements changed or became stale before the job started. Nothing ran.';
        return;
      }
      await writeFile(path.join(ws, requirementsFileFor(j.params.tutorialId)), d.shown.markdown, 'utf8');
    }

    // V2: a design (or design resume) re-checks KaneVerity's state right before Kane starts.
    const isDesign = j.params.kind === 'design' || j.params.kind === 'evolve' || (j.params.kind === 'resume' && j.params.verb === 'design');
    if (isDesign) {
      const refusal = this.designPreflight ? await this.designPreflight(j) : 'the design checks are not available in this process.';
      if (refusal) {
        j.state = 'refused';
        j.reason = scrub(`Not started: ${refusal} Kane's design did not start and no credits were used.`);
        return;
      }
    }

    // B5: an evolve is checked once more right before Kane is spawned; the stored arguments are
    // never replaced, and a refusal here means no Kane design command started.
    if (j.params.kind === 'evolve') {
      let refusal: string | null;
      try {
        refusal = this.evolveSpawnCheck ? await this.evolveSpawnCheck(j) : 'the evolve checks are not available in this process.';
      } catch (err) {
        refusal = `the evolve checks could not be completed (${(err as Error).message}).`;
      }
      if (refusal) {
        j.state = 'refused';
        j.reason = scrub(`Not started: ${refusal} No Kane design command started and no credits were used.`);
        return;
      }
    }

    // B5: a test run re-checks every pre-execution gate it can without Kane (fingerprints).
    if (j.params.kind === 'testrun') {
      const refusal = this.runPreflight ? await this.runPreflight(j) : 'the pre-execution checks are not available in this process.';
      if (refusal) {
        j.state = 'refused';
        j.reason = scrub(`Not started: ${refusal} No test ran and no credits were used.`);
        return;
      }
    }

    const paid = JOB_KINDS[j.kind].paid;
    if (paid) j.credits.balanceBefore = await this.balance(ws);

    // B4: Kane records the review as {kind: "human", id: $USER}; KaneVerity sets it to
    // the self-declared reviewer ("kaneverity:<name>"). It is not proof of identity.
    const reviewerForKane = j.params.kind === 'review' || j.params.kind === 'design' || j.params.kind === 'evolve' ? j.params.reviewer : j.params.kind === 'resume' ? j.params.reviewer : undefined;
    const extraEnv: Record<string, string> = reviewerForKane ? { USER: kaneUserFor(reviewerForKane) } : {};
    const r = await this.run(j.args, ws, jobDir(j.jobId, 'private', 'stdout.ndjson'), true, extraEnv);
    await writeFile(jobDir(j.jobId, 'private', 'stderr.log'), r.stderrTail, 'utf8');
    j.exitCode = r.exitCode;

    if (paid) {
      j.credits.balanceAfter = await this.balance(ws);
      if (j.credits.balanceBefore !== null && j.credits.balanceAfter !== null) j.credits.measured = Math.round((j.credits.balanceBefore - j.credits.balanceAfter) * 100) / 100;
    }

    if (r.spawnError) {
      j.state = 'error';
      j.reason = `Kane could not be started: ${scrub(r.spawnError)}`;
    } else if (JOB_KINDS[j.kind].output === 'ndjson') {
      const s = emptyAssuranceStream();
      for (const line of r.stdout.split(/\r?\n/)) applyAssuranceLine(s, line);
      this.absorb(j, s);
      const o = outcomeOf(s, r.exitCode, r.killed);
      j.state = r.cancelled ? 'cancelled' : o.outcome;
      j.reason = scrub(r.cancelled ? 'Cancelled while Kane was running. Its outcome is unknown.' : o.reason);
    } else if (j.kind === 'dryrun' || j.kind === 'testrun') {
      // B5: the outcome here is only whether Kane finished. What the plan or the run showed
      // is read from the output (dry run) or the evidence pack (run) by the design service.
      // A test run exits 1 when a test fails: that is a finished run, not an error.
      if (r.killed) {
        j.state = r.cancelled ? 'cancelled' : 'interrupted';
        j.reason = 'Stopped before Kane finished. Its outcome is unknown.';
      } else if (r.exitCode === 0 || (j.kind === 'testrun' && r.exitCode === 1)) {
        j.state = 'complete';
        j.reason = j.kind === 'dryrun' ? 'Planned; nothing ran.' : `Kane finished the run (exit ${r.exitCode}). KaneVerity checks the evidence next.`;
      } else {
        j.state = r.exitCode === 2 ? 'refused' : 'error';
        j.reason = scrub(`Kane exited with code ${r.exitCode}. ${r.stderrTail.trim().split(/\r?\n/).pop() ?? ''}`.trim());
      }
    } else if (j.kind === 'ingest') {
      const receipts = parseIngestReceipt(r.stdout);
      j.summary.ingested = receipts.map((x) => ({ sourceId: x.sourceId, status: x.status }));
      if (r.killed) {
        j.state = r.cancelled ? 'cancelled' : 'interrupted';
        j.reason = 'Stopped before Kane finished.';
      } else if (r.exitCode === 0) {
        j.state = 'complete';
        j.reason = receipts.length ? `Landed: ${receipts.map((x) => `${x.sourceId} (${x.status})`).join(', ')}.` : 'Kane exited successfully; no receipt line was recognised.';
      } else {
        j.state = r.exitCode === 2 ? 'refused' : 'error';
        j.reason = scrub(`Kane exited with code ${r.exitCode}. ${r.stderrTail.trim().split(/\r?\n/).pop() ?? ''}`.trim());
      }
    } else {
      // JSON reads (context list / view / fsck --json): outcome from the exit code only.
      // fsck exits 1 when it finds an issue; its JSON report is still read by the caller.
      j.state = r.killed ? 'interrupted' : r.exitCode === 0 ? 'complete' : r.exitCode === 2 ? 'refused' : 'error';
      j.reason = r.exitCode === 0 ? (j.kind === 'fsck' ? 'Store checked.' : j.kind === 'view' ? 'Store view read.' : j.kind === 'review' ? 'Kane accepted the verdict file. KaneVerity verifies the store next.' : 'Listed.') : scrub(`Kane exited with code ${r.exitCode}.`);
    }

    if (paid) {
      // Show the final state only once its cost is on the ledger (no await happens
      // between the outcome above and this point, so nothing observed it early).
      const final = { state: j.state, reason: j.reason };
      j.state = 'running';
      j.reason = 'Recording the cost.';
      await this.recordCost(j);
      j.state = final.state;
      j.reason = final.reason;
    }
  }

  private absorb(j: JobRecord, s: ParsedAssuranceStream) {
    j.verb = s.verb;
    j.doneStatus = s.done?.status ?? null;
    j.next = (s.done?.next ?? s.gateRefused?.next ?? []).map((n) => scrub(n.title ? `${n.title}: ${n.cmd}` : n.cmd)).slice(0, 20);
    j.pause = s.pause && s.pause.sid ? { sid: s.pause.sid, expiresAt: s.pause.expiresAt, questions: s.pause.questions, crashed: s.pause.crashed, held: s.pause.held } : null;
    j.credits.reportedTotal = s.credits.lastTotal ?? (s.credits.turns ? s.credits.sumOfTurns : null);
    j.summary = {
      ingested: s.ingested.map((x) => ({ sourceId: x.sourceId, status: x.status })),
      commits: s.commits.map((c) => ({ counts: c.counts, minted: c.minted.map((m) => m.logicalId) })),
      warnings: s.warnings.map((w) => (w.code ? `${w.code}: ${w.message}` : w.message)).slice(0, 50),
      errors: s.errors.map((e) => (e.code ? `${e.code}: ${e.message}` : e.message)).slice(0, 50),
      held: s.held.reduce((n, h) => n + h.count, 0),
      messages: s.messages.slice(-10),
      unknownEventTypes: s.unknownTypes,
      nonJsonLines: s.nonJsonLines,
      invalidLines: s.invalidLines,
    };
  }

  /** One ledger entry per paid job: reported, else measured, else unknown (never 0). */
  private async recordCost(j: JobRecord) {
    const c = j.credits;
    if (c.reportedTotal !== null) {
      c.amount = c.reportedTotal;
      c.basis = 'reported';
    } else if (c.measured !== null && c.measured >= 0) {
      c.amount = c.measured;
      c.basis = 'measured';
    } else {
      c.amount = null;
      c.basis = 'unknown';
    }
    await addCredits({
      runId: j.jobId,
      credits: c.amount ?? 0,
      basis: c.basis,
      kind: `assurance:${j.kind}`,
      at: new Date().toISOString(),
      note: c.basis === 'unknown' ? 'Kane reported no usage and the balance could not be compared.' : undefined,
    });
  }
}
