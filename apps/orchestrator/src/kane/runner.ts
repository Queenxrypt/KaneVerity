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
import { config } from '../config.ts';
import { addCredits, creditsSpent, newRunId, readJson, runDir, writeJson } from '../store.ts';
import type { Classification, Project, RunState, Tutorial } from '../types.ts';
import { resolveAppStart } from '../urls.ts';
import { classify } from '../verify/classify.ts';
import { findLeaks, scrub, scrubDeep } from '../verify/redact.ts';
import { readEvidence, type EvidenceStep } from './evidence.ts';
import { applyLine, emptyStream, type ParsedStream } from './ndjson.ts';
import { buildObjective } from './objective.ts';

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_PUBLIC_SCREENSHOT_BYTES = 3 * 1024 * 1024;

export interface RunRecord {
  runId: string;
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
  credits: number | null;
  kane: { status: string | null; reasonCode: string | null; reason: string | null; summary: string | null; triage: string | null };
  progress: { step: number; status: string; remark: string }[];
  evidence: {
    found: boolean;
    valid: boolean;
    problems: string[];
    steps: EvidenceStep[];
    screenshots: { ordinal: number; file: string; url: string | null }[];
    withheldScreenshots: number;
  };
  classification: Classification | null;
  warnings: string[];
}

/** Fields the UI may see. Built explicitly, then scrubbed, then leak-checked. */
export function publicRecord(r: RunRecord) {
  const pub = scrubDeep({
    runId: r.runId,
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
    kane: r.kane,
    progress: r.progress,
    evidence: {
      found: r.evidence.found,
      valid: r.evidence.valid,
      problems: r.evidence.problems,
      steps: r.evidence.steps.map((s) => ({ ordinal: s.ordinal, kind: s.kind, status: s.status, summary: s.summary, url: s.url })),
      screenshots: r.evidence.screenshots.map((s) => ({ ordinal: s.ordinal, file: s.file })),
      withheldScreenshots: r.evidence.withheldScreenshots,
      reference: r.evidence.found ? `data/runs/${r.runId}/private/evidence.evidence` : null,
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

  /** Credits that queued/active runs may still use (estimate). */
  pendingEstimate(): number {
    return (this.queue.length + (this.active ? 1 : 0)) * config.kane.estimatedCreditsPerRun;
  }

  async budget(): Promise<{ limit: number; spent: number; reserved: number; available: number }> {
    const spent = await creditsSpent();
    const reserved = this.pendingEstimate();
    return { limit: config.credits.hardLimit, spent, reserved, available: Math.max(0, config.credits.hardLimit - spent - reserved) };
  }

  async enqueue(tutorial: Tutorial, project: Project): Promise<string> {
    const appStartUrl = resolveAppStart(project.appOrigin, tutorial.appStart);
    const built = buildObjective(project.appOrigin, tutorial);
    const runId = newRunId();
    const rec: RunRecord = {
      runId,
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
    }
    // Ledger: Kane's reported credits when available. If Kane reported none but
    // its agent did work (progress events), record the conservative estimate.
    // If Kane stopped before any agent work (e.g. a setup error), record 0.
    const ledgerCredits = rec.credits ?? (stream.progress.length > 0 ? config.kane.estimatedCreditsPerRun : 0);
    if (exitCode !== null || re) {
      await addCredits({ runId: rec.runId, credits: ledgerCredits, at: new Date().toISOString() });
    }

    // Evidence: prefer the copy Kane wrote inside this run's working directory.
    const evidence = await this.collectEvidence(rec, work, priv, stream.packPath);

    rec.classification = classify({
      tutorial: rec.tutorial,
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
