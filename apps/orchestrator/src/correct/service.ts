// Correction workflow. State changes come only from KaneVerity's own checks
// on Kane evidence; Claude's answers are validated and can never mark anything
// verified.

import { readFile, rm, writeFile } from 'node:fs/promises';
import { fetchText } from '../discovery/crawl.ts';
import { refreshDiscovery } from '../discovery/freshness.ts';
import { extractPage } from '../discovery/extract.ts';
import type { Runner, RunRecord } from '../kane/runner.ts';
import { readJson, dataPath } from '../store.ts';
import type { Project, Tutorial } from '../types.ts';
import { scrub, scrubDeep, findLeaks } from '../verify/redact.ts';
import { ANSWER_SCHEMA, claudeArgs, correctionPrompt, parseResult, runClaude } from './claude.ts';
import { buildExplorationObjective, EXPLORATION_MODES, isExplorationMode } from './explore.ts';
import { buildPackage } from './package.ts';
import { guardedWrite, readDocFile, sha256 } from './patch.ts';
import { correctionPath, listCorrections, loadCorrection, logEvent, newCorrectionId, saveCorrection, type CorrectionRecord, type CorrectionState } from './store.ts';
import { attemptFromAnswer, parseAnswer, validateProposal, type ExplorationEvidence } from './validate.ts';
import { assessExploration, verifyRetest } from './verify.ts';

export class CorrectionError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * States in which a correction is still in progress for its tutorial: no second
 * correction may start. 'applied' (written, retest not started) and 'error'
 * (recoverable) are open too; only rejected, closed, restored and verified are not.
 */
export const OPEN_STATES: readonly CorrectionState[] = ['analyzing', 'needs_exploration', 'exploring', 'route_confirmed', 'route_uncertain', 'cannot_determine', 'proposal_rejected', 'proposed', 'applied', 'retesting', 'not_verified', 'error'];
const OPEN = OPEN_STATES;

/** The exact confirmation required to restore (and so invalidate) a VERIFIED correction. */
export const CONFIRM_INVALIDATE_VERIFIED = 'invalidate-verified';

/** UI-safe view: allow-listed fields, scrubbed, leak-checked. */
export function publicCorrection(r: CorrectionRecord) {
  const pub = scrubDeep({
    id: r.id,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    state: r.state,
    stateReason: r.stateReason,
    runId: r.runId,
    tutorialId: r.tutorialId,
    tutorialTitle: r.tutorialTitle,
    file: r.file,
    failedStep: r.failedStep,
    attempts: r.attempts.map((a) => ({
      at: a.at,
      decision: a.decision,
      rationale: a.rationale,
      confidence: a.confidence,
      evidenceCited: a.evidenceCited,
      explorationQuestion: a.explorationQuestion,
      model: a.model,
      costUsd: a.costUsd,
      validation: a.validation,
      error: a.error,
    })),
    explorationRunId: r.explorationRunId,
    exploration: r.exploration,
    explorations: r.explorations ?? (r.explorationRunId ? [{ runId: r.explorationRunId, mode: r.exploration?.mode ?? 'default', startedAt: r.createdAt, confirmed: r.exploration?.confirmed ?? null }] : []),
    proposal: r.proposal,
    approvedAt: r.approvedAt,
    appliedAt: r.appliedAt,
    retestRunId: r.retestRunId,
    retestRuns: r.retestRuns ?? (r.retestRunId ? [r.retestRunId] : []),
    verification: r.verification,
    restoredAt: r.restoredAt,
    log: r.log,
  });
  const leaks = findLeaks(pub);
  if (leaks.length) return { id: r.id, state: r.state, stateReason: `Details withheld: sensitive data detected (${leaks.join(', ')}).` };
  return pub;
}

export class CorrectionService {
  private runner: Runner;
  private busy = new Set<string>();

  constructor(runner: Runner) {
    this.runner = runner;
    runner.on('update', (runId: string) => void this.onRunUpdate(runId).catch(() => undefined));
  }

  list() {
    return listCorrections();
  }

  async get(id: string): Promise<CorrectionRecord> {
    const r = await loadCorrection(id);
    if (!r) throw new CorrectionError(404, 'Correction not found.');
    return r;
  }

  private set(rec: CorrectionRecord, state: CorrectionState, reason: string) {
    rec.state = state;
    rec.stateReason = scrub(reason).slice(0, 1000);
    logEvent(rec, state, rec.stateReason);
  }

  private async project(): Promise<Project> {
    const p = await readJson<Project>(dataPath('project.json'));
    if (!p) throw new CorrectionError(409, 'Connect a project first.');
    return p;
  }

  // No spending ceiling: exploration and retest runs are started only by an
  // explicit, confirmed request, and their actual cost is recorded per run.

  /** Start a correction for a FAILED documentation-defect run, then ask Claude. */
  async start(runId: string): Promise<CorrectionRecord> {
    const run = await this.runner.load(runId);
    if (!run || run.state !== 'finished') throw new CorrectionError(404, 'Run not found or not finished.');
    const c = run.classification;
    if ((run.kind ?? 'verification') === 'exploration') throw new CorrectionError(422, 'Exploration runs cannot start a correction.');
    if (!c || c.status !== 'FAILED' || !c.documentationDefect) throw new CorrectionError(422, 'Only a FAILED run with a confirmed documentation defect can start a correction.');
    const ref = run.tutorial.steps[0]?.ref;
    if (!ref || ref.kind !== 'markdown') throw new CorrectionError(422, 'This tutorial has no Markdown source reference, so it cannot be corrected here.');
    const open = (await listCorrections()).find((x) => x.tutorialId === run.tutorial.id && OPEN.includes(x.state));
    if (open) throw new CorrectionError(409, `A correction for this tutorial is already open (${open.id}).`);

    let text: string;
    try {
      text = await readDocFile(ref.file);
    } catch (err) {
      throw new CorrectionError(422, (err as Error).message);
    }
    const sha = sha256(text);
    if (run.tutorial.sourceSha256 && sha !== run.tutorial.sourceSha256) {
      throw new CorrectionError(409, 'The documentation file changed since this run. Verify the tutorial again before correcting it.');
    }
    const now = new Date().toISOString();
    const rec: CorrectionRecord = {
      id: newCorrectionId(),
      createdAt: now,
      updatedAt: now,
      state: 'analyzing',
      stateReason: '',
      runId,
      tutorialId: run.tutorial.id,
      tutorialTitle: run.tutorial.title,
      tutorialUrl: run.tutorial.url,
      appStart: run.tutorial.appStart,
      file: ref.file,
      failedStep: c.failedStep,
      originalSha256: sha,
      attempts: [],
      explorationRunId: null,
      exploration: null,
      proposal: null,
      approvedAt: null,
      appliedAt: null,
      retestRunId: null,
      verification: null,
      restoredAt: null,
      log: [],
    };
    this.set(rec, 'analyzing', 'Claude is reviewing the finding.');
    await saveCorrection(rec); // creates the correction folder
    await writeFile(correctionPath(rec.id, 'original.md'), text, 'utf8');
    this.busy.add(rec.id);
    void this.runAnalysis(rec).catch(() => undefined);
    return rec;
  }

  /**
   * Ask Claude (restricted, sanitized package). One call per request. The state
   * check and the switch to "analyzing" happen before this returns; the Claude
   * call itself runs in the background.
   */
  async analyze(id: string): Promise<CorrectionRecord> {
    if (this.busy.has(id)) throw new CorrectionError(409, 'Claude is already reviewing this correction.');
    const rec = await this.get(id);
    if (!['route_confirmed', 'proposal_rejected', 'cannot_determine', 'needs_exploration', 'error'].includes(rec.state)) {
      throw new CorrectionError(409, `Claude can't be asked in state "${rec.state}".`);
    }
    this.busy.add(id);
    this.set(rec, 'analyzing', 'Claude is reviewing the finding.');
    await saveCorrection(rec);
    void this.runAnalysis(rec).catch(() => undefined);
    return rec;
  }

  private async runAnalysis(rec: CorrectionRecord): Promise<void> {
    const id = rec.id;
    let pkgDir: string | null = null;
    try {
      const original = await this.runner.load(rec.runId);
      if (!original) throw new Error('Original run not found.');
      const originalText = await readDocFile(rec.file);
      if (sha256(originalText) !== rec.originalSha256) throw new Error('The documentation file changed since the correction started.');
      const exploration = rec.explorationRunId ? await this.runner.load(rec.explorationRunId) : null;
      const confirmed = exploration ? assessExploration(exploration).confirmed : null;
      const pkg = await buildPackage(rec, original, originalText, exploration, confirmed);
      pkgDir = pkg.dir;

      const res = await runClaude(pkg.dir, claudeArgs(correctionPrompt(), { schema: ANSWER_SCHEMA }));
      const parsed = parseResult(res.stdout);
      const base = { model: parsed.model, costUsd: parsed.costUsd, durationMs: res.durationMs };
      if (res.spawnError || res.timedOut || !parsed.ok) {
        const msg = res.spawnError ?? (res.timedOut ? 'Claude did not answer within the time limit.' : parsed.error ?? 'Claude failed.');
        rec.attempts.push(attemptFromAnswer(null, { ...base, ok: false, error: scrub(msg), validation: { ok: false, problems: [] } }));
        this.set(rec, 'error', `Claude could not complete the review: ${msg}`);
        return;
      }
      const { answer, problems } = parseAnswer(parsed.structured);
      if (!answer) {
        rec.attempts.push(attemptFromAnswer(null, { ...base, ok: false, error: 'Invalid answer format.', validation: { ok: false, problems } }));
        this.set(rec, 'error', `Claude's answer was rejected: ${problems.join(' ')}`);
        return;
      }
      if (answer.decision === 'needs_exploration') {
        rec.attempts.push(attemptFromAnswer(answer, { ...base, validation: { ok: true, problems: [] } }));
        this.set(rec, 'needs_exploration', 'Claude says the evidence does not establish the correct route. A Kane exploration run is needed.');
        return;
      }
      if (answer.decision === 'cannot_determine') {
        rec.attempts.push(attemptFromAnswer(answer, { ...base, validation: { ok: true, problems: [] } }));
        this.set(rec, 'cannot_determine', 'Claude could not determine a correction from the evidence. Nothing was changed.');
        return;
      }
      const ev: ExplorationEvidence | null = exploration
        ? { runId: exploration.runId, confirmed: confirmed === true, steps: exploration.evidence.steps, assertions: exploration.assertions ?? [], screenshots: exploration.evidence.screenshots }
        : null;
      const check = validateProposal(answer, originalText, rec.file, ev);
      rec.attempts.push(attemptFromAnswer(answer, { ...base, validation: { ok: check.ok, problems: check.problems } }));
      if (!check.ok) {
        if (!ev || !ev.confirmed) this.set(rec, 'needs_exploration', 'Claude proposed edits, but no Kane exploration has confirmed the route, so no correction may be proposed (D4).');
        else this.set(rec, 'proposal_rejected', `KaneVerity rejected the proposal: ${check.problems.join(' ')}`);
        return;
      }
      await writeFile(correctionPath(rec.id, 'proposed.md'), check.newText!, 'utf8');
      rec.proposal = { edits: answer.edits, diff: check.diff, proposedSha256: check.proposedSha256!, citations: check.citations };
      this.set(rec, 'proposed', 'A validated correction is ready for review.');
    } catch (err) {
      this.set(rec, 'error', (err as Error).message);
    } finally {
      this.busy.delete(id);
      if (pkgDir) await rm(pkgDir, { recursive: true, force: true }).catch(() => undefined);
      await saveCorrection(rec);
    }
  }

  /** Kane exploration (fixed KaneVerity template; Claude's text never reaches Kane). */
  /**
   * Kane exploration (fixed KaneVerity template; Claude's text never reaches Kane).
   * `mode` must be one of the allow-listed EXPLORATION_MODES. A new exploration
   * may also be run from route_confirmed (e.g. to explore a different route);
   * earlier explorations and their evidence are kept in the history.
   */
  async explore(id: string, mode: unknown = 'default'): Promise<CorrectionRecord> {
    if (!isExplorationMode(mode)) throw new CorrectionError(400, `Unknown exploration mode. Allowed: ${Object.keys(EXPLORATION_MODES).join(', ')}.`);
    const rec = await this.get(id);
    if (!['needs_exploration', 'route_uncertain', 'route_confirmed', 'proposal_rejected', 'cannot_determine', 'error'].includes(rec.state)) throw new CorrectionError(409, `Exploration is not available in state "${rec.state}".`);
    const original = await this.runner.load(rec.runId);
    if (!original) throw new CorrectionError(404, 'Original run not found.');
    const project = await this.project();
    const objective = buildExplorationObjective(project.appOrigin, original.tutorial, mode);
    const runId = await this.runner.enqueue(original.tutorial, project, { kind: 'exploration', objective, correctionId: rec.id, explorationMode: mode });
    rec.explorations ??= rec.explorationRunId ? [{ runId: rec.explorationRunId, mode: 'default', startedAt: rec.createdAt, confirmed: rec.exploration?.confirmed ?? null }] : [];
    rec.explorations.push({ runId, mode, startedAt: new Date().toISOString(), confirmed: null });
    rec.explorationRunId = runId;
    rec.exploration = null;
    logEvent(rec, 'exploration_started', `Run ${runId}, mode "${mode}" (${EXPLORATION_MODES[mode].label}).`);
    this.set(rec, 'exploring', `Kane is exploring the application to find the current route (${EXPLORATION_MODES[mode].label.toLowerCase()}).`);
    await saveCorrection(rec);
    return rec;
  }

  async reject(id: string): Promise<CorrectionRecord> {
    const rec = await this.get(id);
    if (rec.state !== 'proposed') throw new CorrectionError(409, 'Only a proposed correction can be rejected.');
    this.set(rec, 'rejected', 'The proposal was rejected. Nothing was changed.');
    await saveCorrection(rec);
    return rec;
  }

  /**
   * Apply the approved proposal (fingerprint-guarded). This only writes the
   * document: the Kane retest is a separate, separately confirmed action.
   */
  async approve(id: string): Promise<CorrectionRecord> {
    const rec = await this.get(id);
    if (rec.state !== 'proposed' || !rec.proposal) throw new CorrectionError(409, 'Only a proposed correction can be approved.');
    const proposed = await readFile(correctionPath(rec.id, 'proposed.md'), 'utf8');
    if (sha256(proposed) !== rec.proposal.proposedSha256) throw new CorrectionError(409, 'The stored proposal does not match its fingerprint.');
    try {
      await guardedWrite(rec.file, rec.originalSha256, proposed, correctionPath(rec.id));
    } catch (err) {
      throw new CorrectionError(409, (err as Error).message);
    }
    rec.approvedAt = new Date().toISOString();
    rec.appliedAt = rec.approvedAt;
    // One audit event per application: the state change records what was written.
    this.set(rec, 'applied', `Wrote ${rec.file} (fingerprint ${rec.proposal.proposedSha256.slice(0, 12)}). A Kane retest has not been started.`);
    await saveCorrection(rec);
    await this.refreshAfterWrite(rec);
    return rec;
  }

  /** Start the independent Kane retest of an applied correction (needs its own confirmation). */
  async retest(id: string): Promise<CorrectionRecord> {
    if (this.busy.has(id)) throw new CorrectionError(409, 'A retest is already being started for this correction.');
    const rec = await this.get(id);
    // From 'not_verified' a retest may be tried again (for example after a blocked run);
    // the live page must still show exactly the approved document.
    if (!['applied', 'not_verified'].includes(rec.state) || !rec.proposal || !rec.appliedAt || rec.restoredAt) throw new CorrectionError(409, 'Only an applied correction can be retested.');
    this.busy.add(id);
    try {
      return await this.startRetest(rec, rec.proposal);
    } finally {
      this.busy.delete(id);
    }
  }

  private async startRetest(rec: CorrectionRecord, proposal: NonNullable<CorrectionRecord['proposal']>): Promise<CorrectionRecord> {
    const project = await this.project();
    // Retest from the LIVE docs page, which must now show the approved document.
    let live: Tutorial | null = null;
    try {
      const html = await fetchText(rec.tutorialUrl, project.docsOrigin, /^text\/html\b/i);
      const page = extractPage(html, rec.tutorialUrl, project.appOrigin);
      live = page.kind === 'tutorial' ? page.tutorial : null;
    } catch (err) {
      this.set(rec, 'not_verified', `The corrected docs page could not be read for the retest: ${(err as Error).message}`);
      await saveCorrection(rec);
      return rec;
    }
    if (!live || live.sourceSha256 !== proposal.proposedSha256) {
      this.set(rec, 'not_verified', 'The live docs page does not show the approved document (fingerprint mismatch). No retest was run.');
      await saveCorrection(rec);
      return rec;
    }
    if (live.notRunnable) {
      this.set(rec, 'not_verified', `The corrected tutorial cannot be verified: ${live.notRunnable}`);
      await saveCorrection(rec);
      return rec;
    }
    const runId = await this.runner.enqueue(live, project, { kind: 'retest', correctionId: rec.id, expectedSourceSha256: proposal.proposedSha256 });
    // Keep every retest (older records only have retestRunId), then point at the new one.
    rec.retestRuns = [...(rec.retestRuns ?? (rec.retestRunId ? [rec.retestRunId] : [])), runId];
    rec.retestRunId = runId;
    this.set(rec, 'retesting', 'Kane is retesting the corrected tutorial independently.');
    await saveCorrection(rec);
    return rec;
  }

  /** Put the original document back (only if the file is exactly the applied proposal). */
  async restore(id: string, body: unknown = null): Promise<CorrectionRecord> {
    const rec = await this.get(id);
    if (!rec.appliedAt || !rec.proposal) throw new CorrectionError(409, 'Nothing was applied, so there is nothing to restore.');
    if (rec.restoredAt || rec.state === 'restored') throw new CorrectionError(409, 'The original document was already restored.');
    if (rec.state === 'retesting') throw new CorrectionError(409, 'Wait for the retest to finish.');
    const wasVerified = rec.state === 'verified';
    const confirm = body && typeof body === 'object' && 'confirm' in body ? (body as { confirm: unknown }).confirm : null;
    if (wasVerified && confirm !== CONFIRM_INVALIDATE_VERIFIED) {
      throw new CorrectionError(409, `This correction is VERIFIED. Restoring the original document puts the outdated tutorial back and invalidates that VERIFIED result. Confirm explicitly to continue.`);
    }
    const original = await readFile(correctionPath(rec.id, 'original.md'), 'utf8');
    if (sha256(original) !== rec.originalSha256) throw new CorrectionError(409, 'The stored original does not match its fingerprint.');
    try {
      await guardedWrite(rec.file, rec.proposal.proposedSha256, original, correctionPath(rec.id));
    } catch (err) {
      throw new CorrectionError(409, (err as Error).message);
    }
    rec.restoredAt = new Date().toISOString();
    this.set(rec, 'restored', wasVerified
      ? 'The original document was restored. The earlier VERIFIED result no longer applies: the live tutorial is the original version again.'
      : 'The original document was restored.');
    await saveCorrection(rec);
    await this.refreshAfterWrite(rec);
    return rec;
  }

  /** Close a correction that stopped with an error. Nothing was written to the documentation. */
  async dismiss(id: string): Promise<CorrectionRecord> {
    const rec = await this.get(id);
    if (rec.state !== 'error') throw new CorrectionError(409, 'Only a correction that stopped with an error can be closed.');
    if (rec.appliedAt && !rec.restoredAt) throw new CorrectionError(409, 'A correction is applied; restore the original first.');
    this.set(rec, 'closed', 'Closed after an error. The documentation was not changed.');
    await saveCorrection(rec);
    return rec;
  }

  /**
   * After the documentation file changes (apply or restore), refresh discovery so
   * verification runs use the live content. A failure is recorded, never hidden:
   * the stale-discovery guard still refuses runs until discovery is refreshed.
   */
  private async refreshAfterWrite(rec: CorrectionRecord): Promise<void> {
    try {
      const project = await this.project();
      await refreshDiscovery(project);
    } catch (err) {
      logEvent(rec, 'discovery_refresh_failed', `Discovery could not be refreshed: ${scrub((err as Error).message)}. Use Discover again before verifying.`);
      await saveCorrection(rec);
    }
  }

  /** React to finished exploration/retest runs. */
  async onRunUpdate(runId: string): Promise<void> {
    const run: RunRecord | undefined = this.runner.get(runId);
    if (!run || run.state !== 'finished' || !run.correctionId) return;
    const rec = await loadCorrection(run.correctionId);
    if (!rec) return;
    if (run.kind === 'exploration' && rec.explorationRunId === runId && rec.state === 'exploring') {
      const a = assessExploration(run);
      rec.exploration = { confirmed: a.confirmed, reason: a.reason, mode: run.explorationMode ?? 'default' };
      const h = rec.explorations?.find((e) => e.runId === runId);
      if (h) h.confirmed = a.confirmed;
      if (a.confirmed) this.set(rec, 'route_confirmed', `${a.reason} Claude can now be asked again.`);
      else this.set(rec, 'route_uncertain', `${a.reason} No correction may be proposed.`);
      await saveCorrection(rec);
    }
    if (run.kind === 'retest' && rec.retestRunId === runId && rec.state === 'retesting' && rec.proposal) {
      rec.verification = verifyRetest(run, rec.proposal.proposedSha256);
      if (rec.verification.verified) this.set(rec, 'verified', 'Kane independently verified the corrected tutorial. Every VERIFIED requirement passed.');
      else this.set(rec, 'not_verified', `The retest did not meet every VERIFIED requirement: ${rec.verification.checks.filter((c) => !c.ok).map((c) => c.name).join('; ')}. The issue stays open.`);
      await saveCorrection(rec);
    }
  }
}
