// Runs Kane CLI, one job at a time.
//
// - Kane's JS entry is started with `node` directly (no shell): documentation
//   text is passed as a single argv value and can never become a command.
// - Each run gets its own working directory under data/runs/<id>/work, so
//   Kane's .testmuai/ output and evidence stay inside git-ignored data/.
// - Every run starts with a full page load of the app start URL in a fresh
//   Kane browser session; AcmeDesk resets to seed data on every load.
// - Raw output, stderr and the evidence pack are private. The UI only gets
//   publicRecord(), built from allow-listed fields and scrubbed.

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { copyFile, mkdir, readdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { config, estimateRange, unreportedEstimate } from '../config.ts';
import { addCredits, creditLedger, newRunId, readJson, runDir, summarizeCosts, writeJson, type CostBasis, type CostSummary } from '../store.ts';
import type { Classification, Project, RunState, Tutorial } from '../types.ts';
import { resolveAppStart } from '../urls.ts';
import { classify } from '../verify/classify.ts';
import { findLeaks, scrub, scrubDeep } from '../verify/redact.ts';
import { readEvidence, type EvidenceStep } from './evidence.ts';
import { applyLine, emptyStream, type ParsedStream } from './ndjson.ts';
import { buildObjective } from './objective.ts';

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_PUBLIC_SCREENSHOT_BYTES = 3 * 1024 * 1024;

/**
 * verification: checks a tutorial as documented.
 * exploration:  Kane finds how a documented goal is done today. NEVER counts as verification.
 * retest:       verification of a corrected tutorial, linked to a correction.
 */
export type RunKind = 'verification' | 'exploration' | 'retest';

/** One Kane memory/assertion record, sanitized (no ids, no paths). */
export interface AssertionRecord {
  key: string;
  query: string;
  extracted: string | null;
  passed: boolean;
  isCheck: boolean;
}

export interface EnqueueOptions {
  kind?: RunKind;
  /** Exploration runs supply their own KaneVerity-built objective. */
  objective?: { objective: string; mapping: RunRecord['objectiveMapping'] };
  correctionId?: string;
  /** Retest: fingerprint of the approved corrected document the docs page must match. */
  expectedSourceSha256?: string;
  /** Exploration: the allow-listed exploration mode used to build the objective. */
  explorationMode?: string;
}

export interface RunRecord {
  runId: string;
  kind?: RunKind;
  correctionId?: string;
  expectedSourceSha256?: string;
  /** Exploration runs: allow-listed mode (e.g. "default", "main-navigation"). */
  explorationMode?: string;
  state: RunState;
  tutorial: Tutorial;
  appOrigin: string;
  appStartUrl: string;
  objective: string;
  objectiveMapping: { objectiveLine: number; kind: 'step' | 'outcome'; index: number }[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  cliVersion: string | null;
  durationSec: number | null;
  /** Actual credits reported by Kane in run_end (null if Kane reported none). */
  credits: number | null;
  /** reported | estimated | none (see store.ts CostBasis); absent while queued/running. */
  costBasis?: CostBasis;
  /** KaneVerity estimate, only when Kane reported no cost but did agent work. */
  estimatedCredits?: number | null;
  kane: { status: string | null; reasonCode: string | null; reason: string | null; summary: string | null; triage: string | null };
  /** Sanitized Kane memory records (assertions and stored values). */
  assertions?: AssertionRecord[];
  /**
   * Origins seen in the evidence after the run. KaneVerity DETECTS unexpected
   * origins after the fact; it cannot PREVENT the browser from visiting them.
   */
  visitedOrigins?: string[];
  progress: { step: number; status: string; remark: string }[];
  evidence: {
    found: boolean;
    valid: boolean;
    problems: string[];
    steps: EvidenceStep[];
    screenshots: { ordinal: number; file: string; url: string | null }[];
    withheldScreenshots: number;
    /** Result of Kane's documented `kane-cli evidence validate --json` on the pack. */
    kaneValidation?: { status: 'valid' | 'invalid' | 'not_run'; packStatus: string | null; warnings: number; errors: number };
  };
  classification: Classification | null;
  warnings: string[];
}

/** Fields the UI may see. Built explicitly, then scrubbed, then leak-checked. */
export function publicRecord(r: RunRecord) {
  const pub = scrubDeep({
    runId: r.runId,
    kind: r.kind ?? 'verification',
    correctionId: r.correctionId ?? null,
    explorationMode: r.kind === 'exploration' ? (r.explorationMode ?? 'default') : null,
    state: r.state,
    tutorial: {
      id: r.tutorial.id,
      title: r.tutorial.title,
      url: r.tutorial.url,
      method: r.tutorial.method,
      steps: r.tutorial.steps,
      outcomes: r.tutorial.outcomes,
    },
    appStartUrl: r.appStartUrl,
    objective: r.objective,
    objectiveMapping: r.objectiveMapping,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    exitCode: r.exitCode,
    cliVersion: r.cliVersion,
    durationSec: r.durationSec,
    credits: r.credits,
    costBasis: r.costBasis ?? (r.state !== 'finished' ? null : r.credits !== null ? 'reported' : r.exitCode === null && r.progress.length === 0 ? 'not_started' : 'none'),
    estimatedCredits: r.estimatedCredits ?? null,
    kane: r.kane,
    assertions: (r.assertions ?? []).map((a) => ({ query: a.query, extracted: a.extracted, passed: a.passed, isCheck: a.isCheck })),
    visitedOrigins: r.visitedOrigins ?? [],
    progress: r.progress,
    evidence: {
      found: r.evidence.found,
      valid: r.evidence.valid,
      problems: r.evidence.problems,
      steps: r.evidence.steps.map((s) => ({ ordinal: s.ordinal, kind: s.kind, status: s.status, summary: s.summary, url: s.url })),
      screenshots: r.evidence.screenshots.map((s) => ({ ordinal: s.ordinal, file: s.file })),
      withheldScreenshots: r.evidence.withheldScreenshots,
      // No file paths: only a safe reference to the run and validation status.
      runReference: r.runId,
      kaneValidation: r.evidence.kaneValidation ?? { status: 'not_run', packStatus: null, warnings: 0, errors: 0 },
    },
    classification: r.classification,
    warnings: r.warnings,
  });
  const leaks = findLeaks(pub);
  if (leaks.length) {
    // Should never happen (allow-list + scrub). Fail closed: withhold free text.
    return { runId: r.runId, state: r.state, classification: r.classification && { ...r.classification, explanation: 'Result withheld: sensitive data detected.', matchingNotes: [] }, warnings: [`Public record withheld (${leaks.join(', ')}).`] };
  }
  return pub;
}

export class Runner extends EventEmitter {
  private queue: string[] = [];
  private records = new Map<string, RunRecord>();
  private active: { runId: string; child: ChildProcess | null; cancelled: boolean } | null = null;

  private kaneEntry: string | null;

  constructor(kaneEntry: string | null = config.kane.entry) {
    super();
    this.kaneEntry = kaneEntry;
  }

  get(runId: string): RunRecord | undefined {
    return this.records.get(runId);
  }

  async load(runId: string): Promise<RunRecord | null> {
    return this.records.get(runId) ?? (await readJson<RunRecord>(runDir(runId, 'private', 'run.json')));
  }

  /** Number of runs queued or running (their cost is not known yet). */
  pendingRuns(): number {
    return this.queue.length + (this.active ? 1 : 0);
  }

  /**
   * Cost accounting for KaneVerity's own Kane runs. There is NO spending
   * ceiling: actual (Kane-reported) and estimated costs are tracked and shown
   * separately, and every real run still needs an explicit confirmation.
   */
  async costs(): Promise<CostSummary & { pendingRuns: number; estimatedByKind: Record<RunKind, [number, number]> }> {
    return {
      ...summarizeCosts(await creditLedger()),
      pendingRuns: this.pendingRuns(),
      estimatedByKind: { verification: estimateRange('verification'), exploration: estimateRange('exploration'), retest: estimateRange('retest') },
    };
  }

  async enqueue(tutorial: Tutorial, project: Project, opts: EnqueueOptions = {}): Promise<string> {
    const appStartUrl = resolveAppStart(project.appOrigin, tutorial.appStart);
    const kind = opts.kind ?? 'verification';
    if (kind === 'exploration' && !opts.objective) throw new Error('Exploration runs need a KaneVerity-built objective.');
    const built = opts.objective ?? buildObjective(project.appOrigin, tutorial);
    const runId = newRunId();
    const rec: RunRecord = {
      runId,
      kind,
      correctionId: opts.correctionId,
      expectedSourceSha256: opts.expectedSourceSha256,
      explorationMode: kind === 'exploration' ? (opts.explorationMode ?? 'default') : undefined,
      state: 'queued',
      tutorial,
      appOrigin: project.appOrigin,
      appStartUrl,
      objective: built.objective,
      objectiveMapping: built.mapping,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      cliVersion: null,
      durationSec: null,
      credits: null,
      kane: { status: null, reasonCode: null, reason: null, summary: null, triage: null },
      progress: [],
      evidence: { found: false, valid: false, problems: [], steps: [], screenshots: [], withheldScreenshots: 0 },
      classification: null,
      warnings: [...tutorial.warnings],
    };
    this.records.set(runId, rec);
    await this.persist(rec);
    this.queue.push(runId);
    this.emit('update', runId);
    void this.pump();
    return runId;
  }

  cancel(runId: string): boolean {
    const qi = this.queue.indexOf(runId);
    const rec = this.records.get(runId);
    if (qi !== -1 && rec) {
      this.queue.splice(qi, 1);
      rec.state = 'finished';
      rec.finishedAt = new Date().toISOString();
      rec.classification = classify({ tutorial: rec.tutorial, appOrigin: rec.appOrigin, preflight: { ok: true }, cancelled: true, exitCode: null, runEnd: null, progress: [], evidenceSteps: [] });
      void this.persist(rec).then(() => this.emit('update', runId));
      return true;
    }
    if (this.active?.runId === runId) {
      this.active.cancelled = true;
      this.active.child?.kill();
      return true;
    }
    return false;
  }

  private async persist(rec: RunRecord): Promise<void> {
    await writeJson(runDir(rec.runId, 'private', 'run.json'), rec);
    await writeJson(runDir(rec.runId, 'public.json'), publicRecord(rec));
  }

  private async pump(): Promise<void> {
    if (this.active || this.queue.length === 0) return;
    const runId = this.queue.shift()!;
    const rec = this.records.get(runId)!;
    this.active = { runId, child: null, cancelled: false };
    try {
      await this.execute(rec);
    } catch (err) {
      rec.warnings.push(`Internal error: ${scrub((err as Error).message)}`);
      rec.classification ??= classify({ tutorial: rec.tutorial, appOrigin: rec.appOrigin, preflight: { ok: true }, spawnError: 'internal error', exitCode: null, runEnd: null, progress: [], evidenceSteps: [] });
    } finally {
      rec.state = 'finished';
      rec.finishedAt ??= new Date().toISOString();
      await this.persist(rec);
      this.emit('update', runId);
      this.active = null;
      void this.pump();
    }
  }

  private async preflight(url: string): Promise<{ ok: boolean; detail?: string }> {
    try {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      return res.status >= 200 && res.status < 300 ? { ok: true } : { ok: false, detail: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).name === 'TimeoutError' ? 'timed out' : 'connection failed' };
    }
  }

  private async execute(rec: RunRecord): Promise<void> {
    rec.state = 'running';
    rec.startedAt = new Date().toISOString();
    await this.persist(rec);
    this.emit('update', rec.runId);

    const preflight = await this.preflight(rec.appStartUrl);
    if (!preflight.ok || !this.kaneEntry) {
      rec.classification = classify({
        tutorial: rec.tutorial,
        appOrigin: rec.appOrigin,
        preflight,
        spawnError: this.kaneEntry ? null : 'Kane CLI is not installed or could not be found.',
        exitCode: null,
        runEnd: null,
        progress: [],
        evidenceSteps: [],
      });
      return;
    }

    const work = runDir(rec.runId, 'work');
    const priv = runDir(rec.runId, 'private');
    await mkdir(work, { recursive: true });
    await mkdir(priv, { recursive: true });
    const name = `kv_${rec.tutorial.id.replace(/[^a-z0-9]/g, '_').slice(0, 40)}_${rec.runId.slice(-6)}`;
    const args = [
      this.kaneEntry,
      'run',
      rec.objective,
      '--url',
      rec.appStartUrl,
      '--agent',
      '--headless',
      '--timeout',
      String(config.kane.timeoutSec),
      '--max-steps',
      String(config.kane.maxSteps),
      '--name',
      name,
    ];
    await writeFile(path.join(priv, 'objective.txt'), rec.objective, 'utf8');

    const stream: ParsedStream = emptyStream();
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let spawnError: string | null = null;
    let timedOut = false;
    const t0 = Date.now();

    const exitCode = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, args, { cwd: work, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
      this.active!.child = child;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, config.kane.timeoutSec * 1000 + config.kane.graceMs);
      let buffer = '';
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => {
        if (stdoutBytes < MAX_LOG_BYTES) void appendFile(path.join(priv, 'kane.ndjson'), chunk);
        stdoutBytes += chunk.length;
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          const before = stream.progress.length;
          applyLine(stream, line);
          if (stream.progress.length > before) {
            const p = stream.progress[stream.progress.length - 1];
            rec.progress.push({ step: p.step, status: p.status, remark: scrub(p.remark).slice(0, 300) });
            this.emit('progress', rec.runId);
          }
        }
      });
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (chunk: string) => {
        if (stderrBytes < MAX_LOG_BYTES) void appendFile(path.join(priv, 'stderr.log'), chunk);
        stderrBytes += chunk.length;
      });
      child.on('error', (err) => {
        spawnError = err.message;
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (buffer.trim()) applyLine(stream, buffer);
        resolve(code);
      });
    });

    rec.exitCode = exitCode;
    rec.cliVersion = stream.cliVersion;
    rec.durationSec = Math.round((Date.now() - t0) / 1000);
    if (stream.cliVersion && stream.cliVersion !== config.kane.testedVersion) {
      rec.warnings.push(`Kane CLI ${stream.cliVersion} differs from the tested version ${config.kane.testedVersion}.`);
    }
    if (stream.badLines) rec.warnings.push(`${stream.badLines} unreadable output line(s) from Kane were ignored.`);
    const re = stream.runEnd;
    if (re) {
      rec.kane = {
        status: String(re.status ?? ''),
        reasonCode: re.reason_code ? String(re.reason_code) : null,
        reason: re.reason ? scrub(String(re.reason)).slice(0, 600) : null,
        summary: re.summary ? scrub(String(re.summary)).slice(0, 1200) : null,
        triage: null,
      };
      const credits = Number(re.credits_consumed ?? re.credits);
      rec.credits = Number.isFinite(credits) ? Math.round(credits * 100) / 100 : null;
      rec.assertions = Object.entries(re.context?.memory ?? {})
        .slice(0, 50)
        .map(([key, m]) => {
          const reasoning = String(m.reasoning ?? '');
          const query = [m.query, m.condition, m.human_description].filter((x) => typeof x === 'string').join(' | ');
          return {
            key: scrub(key).slice(0, 80),
            query: scrub(query).slice(0, 400),
            extracted: m.extracted_value === undefined || m.extracted_value === null ? null : scrub(String(m.extracted_value)).slice(0, 200),
            passed: /->\s*PASS\b/.test(reasoning) && !/->\s*FAIL\b/.test(reasoning),
            isCheck: /->\s*(PASS|FAIL)\b/.test(reasoning),
          };
        });
    }
    // Ledger: Kane's reported credits are the actual cost. If Kane reported none
    // but its agent did work (progress events, e.g. a timeout or cancellation
    // mid-run), record a clearly-labelled estimate. If Kane stopped before any
    // agent work (e.g. a setup error), record 0 with basis "none".
    const basis: CostBasis = rec.credits !== null ? 'reported' : stream.progress.length > 0 ? 'estimated' : 'none';
    const ledgerCredits = basis === 'reported' ? rec.credits! : basis === 'estimated' ? unreportedEstimate(rec.kind ?? 'verification') : 0;
    rec.costBasis = basis;
    rec.estimatedCredits = basis === 'estimated' ? ledgerCredits : null;
    if (exitCode !== null || re || stream.progress.length > 0) {
      await addCredits({ runId: rec.runId, credits: ledgerCredits, basis, kind: rec.kind ?? 'verification', at: new Date().toISOString() });
    }

    // Evidence: prefer the copy Kane wrote inside this run's working directory.
    const evidence = await this.collectEvidence(rec, work, priv, stream.packPath);

    // Origins seen in the evidence (detected after the run; not prevented).
    const origins = new Set<string>();
    for (const u of [...(evidence?.steps ?? []).map((s) => s.url), typeof re?.final_state?.url === 'string' ? (re.final_state.url as string) : null]) {
      if (!u || u === 'about:blank') continue;
      try {
        const o = new URL(u);
        origins.add(o.origin === 'null' ? o.protocol : o.origin);
      } catch {
        origins.add('unparseable URL');
      }
    }
    rec.visitedOrigins = [...origins];

    // Exploration runs are judged only on the documented OUTCOMES (did Kane
    // independently reach them?), never as verification of the documented steps.
    const judged = rec.kind === 'exploration' ? { ...rec.tutorial, steps: [] } : rec.tutorial;
    rec.classification = classify({
      tutorial: judged,
      appOrigin: rec.appOrigin,
      preflight,
      spawnError,
      cancelled: this.active?.cancelled,
      timedOut,
      exitCode,
      runEnd: re,
      progress: stream.progress,
      evidenceSteps: evidence?.steps ?? [],
      failureMessage: evidence?.failureMessage ?? null,
    });
    rec.classification.matchingNotes = rec.classification.matchingNotes.map((n) => scrub(n));
    if (rec.kind === 'exploration') {
      rec.classification.documentationDefect = false;
      rec.classification.stepResults = [];
    }
  }

  /** Run Kane's documented `evidence validate <pack> --json`; only counts are kept. */
  private kaneValidate(pack: string): Promise<NonNullable<RunRecord['evidence']['kaneValidation']>> {
    const notRun = { status: 'not_run' as const, packStatus: null, warnings: 0, errors: 0 };
    if (!this.kaneEntry) return Promise.resolve(notRun);
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [this.kaneEntry!, 'evidence', 'validate', pack, '--json'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, shell: false });
      let out = '';
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (c: string) => {
        if (out.length < 200_000) out += c;
      });
      const timer = setTimeout(() => child.kill(), 60_000);
      child.on('error', () => resolve(notRun));
      child.on('close', (code) => {
        clearTimeout(timer);
        try {
          const j = JSON.parse(out.trim().split('\n').pop() ?? '') as { valid?: boolean; status?: string; diagnostics?: { severity?: string }[] };
          const diags = Array.isArray(j.diagnostics) ? j.diagnostics : [];
          resolve({
            status: j.valid === true && code === 0 ? 'valid' : 'invalid',
            packStatus: typeof j.status === 'string' ? j.status.slice(0, 40) : null,
            warnings: diags.filter((d) => d.severity === 'warning').length,
            errors: diags.filter((d) => d.severity === 'error').length,
          });
        } catch {
          resolve(code === 0 ? { ...notRun, status: 'valid' } : notRun);
        }
      });
    });
  }

  private async collectEvidence(rec: RunRecord, work: string, priv: string, reportedPack: string | null) {
    let pack: string | null = null;
    const local = path.join(work, '.testmuai', 'evidence');
    try {
      const files = (await readdir(local)).filter((f) => /^[a-f0-9-]+\.evidence$/.test(f));
      if (files.length === 1) pack = path.join(local, files[0]);
      else if (files.length > 1) rec.warnings.push('More than one evidence pack was found; using the one Kane reported.');
    } catch {
      // no local copy
    }
    if (!pack && reportedPack && /\.evidence$/.test(reportedPack)) pack = reportedPack;
    if (!pack) {
      rec.evidence.problems.push('No evidence pack was produced.');
      return null;
    }
    const target = path.join(priv, 'evidence.evidence');
    try {
      await copyFile(pack, target);
    } catch {
      rec.evidence.problems.push('Evidence pack could not be copied.');
      return null;
    }
    const ev = await readEvidence(target);
    rec.evidence.kaneValidation = await this.kaneValidate(target);
    rec.evidence.found = true;
    rec.evidence.valid = ev.valid;
    rec.evidence.problems.push(...ev.problems.map(scrub));
    rec.evidence.steps = ev.steps.map((s) => ({ ...s, summary: scrub(s.summary).slice(0, 300), url: s.url }));
    if (ev.failureTitle) rec.kane.triage = scrub(ev.failureTitle).slice(0, 200);

    // Screenshots: raw copies stay private. A copy is published only when the
    // step was on the configured app origin, that origin is the allow-listed
    // controlled demo (synthetic data only), and the file is a small JPEG.
    const privShots = path.join(priv, 'screens');
    const pubShots = runDir(rec.runId, 'public', 'screens');
    await mkdir(privShots, { recursive: true });
    const demoApp = config.allowedAppOrigins.includes(rec.appOrigin);
    for (const shot of ev.screenshots) {
      const file = `${shot.ordinal}.jpg`;
      await writeFile(path.join(privShots, file), shot.data);
      const step = ev.steps.find((s) => s.ordinal === shot.ordinal);
      let onApp = false;
      try {
        onApp = !!step?.url && new URL(step.url).origin === rec.appOrigin;
      } catch {
        onApp = false;
      }
      if (demoApp && onApp && shot.data.length <= MAX_PUBLIC_SCREENSHOT_BYTES) {
        await mkdir(pubShots, { recursive: true });
        await writeFile(path.join(pubShots, file), shot.data);
        rec.evidence.screenshots.push({ ordinal: shot.ordinal, file, url: step?.url ?? null });
      } else {
        rec.evidence.withheldScreenshots++;
      }
    }
    return ev;
  }
}
