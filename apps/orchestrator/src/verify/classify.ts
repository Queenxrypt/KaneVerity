// Result classification (docs/VERIFICATION_RULES.md). Pure function: no I/O.
//
// Conservative by design:
//  - PASSED needs exit 0, run_end "passed", and a distinct passing Kane
//    assertion matched to EVERY documented expected outcome, with no visits
//    outside the application origin.
//  - FAILED (documentation defect) needs exit 1, run_end "failed", an
//    assertion_error.* reason, and a failure that maps to EXACTLY ONE
//    documented step or outcome. Anything less confident is NEEDS REVIEW.
//  - BLOCKED covers external conditions; it is never a documentation defect.

import type { Classification, OutcomeResult, StepResult, Tutorial } from '../types.ts';
import type { EvidenceStep } from '../kane/evidence.ts';
import type { MemoryRecord, ProgressEvent, RunEnd } from '../kane/ndjson.ts';

export interface ClassifyInput {
  tutorial: Tutorial;
  appOrigin: string;
  preflight: { ok: boolean; detail?: string };
  spawnError?: string | null;
  cancelled?: boolean;
  timedOut?: boolean;
  exitCode: number | null;
  runEnd: RunEnd | null;
  progress: ProgressEvent[];
  evidenceSteps: EvidenceStep[];
  failureMessage?: string | null;
}

interface Assertion {
  source: 'memory' | 'evidence';
  text: string;
  extracted: string | null;
  passed: boolean;
}

const STOP = new Set(['the', 'and', 'that', 'this', 'with', 'from', 'into', 'then', 'than', 'are', 'was', 'is', 'be', 'on', 'in', 'of', 'to', 'a', 'an', 'it', 'its', 'for', 'by', 'shows', 'show', 'appears', 'appear', 'visible', 'message', 'text', 'whether', 'present', 'below', 'above']);

export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripEndPunct(s: string): string {
  return s.replace(/[.!?:;,\s]+$/, '');
}

/** Light plural folding so "keys"/"key" and "projects"/"project" compare equal. */
function fold(w: string): string {
  return w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
}

function words(s: string): Set<string> {
  return new Set(
    norm(s)
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map(fold),
  );
}

/** Words of an outcome outside its quoted values (what the outcome is about). */
function contextWords(outcomeKane: string): Set<string> {
  return words(outcomeKane.replace(/'[^']+'/g, ' '));
}

/** Quoted values in Kane text: 'Label' (single quotes are KaneVerity's convention). */
export function quotedValues(kaneText: string): string[] {
  const out: string[] = [];
  for (const m of kaneText.matchAll(/'([^']+)'/g)) out.push(m[1]);
  return out;
}

export function stepKind(s: { kind: string; summary: string }): string {
  if (s.kind) return s.kind.toLowerCase();
  const m = /^([a-z_]+):/i.exec(s.summary.trim());
  return m ? m[1].toLowerCase() : '';
}

export const ACTION_KINDS = new Set(['click', 'type', 'fill', 'select', 'press', 'hover', 'scroll', 'check', 'uncheck', 'upload', 'drag']);

function memoryAssertions(runEnd: RunEnd | null): Assertion[] {
  const mem = runEnd?.context?.memory;
  if (!mem || typeof mem !== 'object') return [];
  return Object.values(mem as Record<string, MemoryRecord>).map((r) => {
    const text = [r.query, r.condition, r.human_description].filter((x) => typeof x === 'string').join(' | ');
    const reasoning = String(r.reasoning ?? '');
    const passed = /->\s*PASS\b/.test(reasoning) && !/->\s*FAIL\b/.test(reasoning);
    const extracted = r.extracted_value === undefined || r.extracted_value === null ? null : String(r.extracted_value).slice(0, 200);
    return { source: 'memory' as const, text, extracted, passed };
  });
}

function evidenceAssertions(steps: EvidenceStep[]): Assertion[] {
  return steps
    .filter((s) => stepKind(s) === 'assert')
    .map((s) => ({ source: 'evidence' as const, text: s.summary.replace(/^assert:\s*/i, ''), extracted: null, passed: s.status === 'passed' }));
}

/** Compare values ignoring quote marks and spacing, e.g. 'Project "X" created.' == Project X created */
function valueForm(s: string): string {
  return norm(s).replace(/["']/g, '').replace(/\s+/g, ' ').trim();
}

/** Assertion text with its own quoted values removed (what the check is about). */
function outsideQuotes(s: string): string {
  return norm(s).replace(/'[^']*'/g, ' ').replace(/"[^"]*"/g, ' ');
}

/** Score how well an assertion covers an outcome. 0 = no match. */
function matchScore(outcomeKane: string, assertion: Assertion): number {
  const raw = `${assertion.text} ${assertion.extracted ?? ''}`;
  const hay = norm(raw);
  const quoted = quotedValues(outcomeKane).map((q) => stripEndPunct(valueForm(q)));
  if (quoted.length) {
    // Every quoted value must appear word for word (quote marks ignored)...
    const hayValues = valueForm(raw);
    if (!quoted.every((q) => hayValues.includes(q))) return 0;
    // ...and, if the outcome says where/what (e.g. "listed in the projects
    // table"), at least one of those context words must appear too. This stops
    // one assertion about a value from also "proving" a different outcome that
    // mentions the same value.
    const ctx = contextWords(outcomeKane);
    if (ctx.size === 0) return 10 + quoted.length;
    // Context must come from the assertion's own wording, not from inside a
    // quoted value it checks (e.g. "project" inside 'Project "X" created.').
    const aw = words(outsideQuotes(raw));
    let hits = 0;
    for (const w of ctx) if (aw.has(w)) hits++;
    return hits === 0 ? 0 : 10 + quoted.length + hits;
  }
  const ow = words(outcomeKane);
  if (ow.size === 0) return 0;
  const aw = words(hay);
  let common = 0;
  for (const w of ow) if (aw.has(w)) common++;
  const ratio = common / ow.size;
  return ratio >= 0.6 ? Math.round(ratio * 10) : 0;
}

/**
 * Match each outcome to a distinct assertion, conservatively:
 *  - an outcome's best-scoring assertion must be unique (no ties);
 *  - an assertion that is the best match for two outcomes proves neither.
 * Anything ambiguous is left unmatched, which prevents a PASSED result.
 */
function matchOutcomes(t: Tutorial, assertions: Assertion[], notes: string[]): (Assertion | null)[] {
  const best = t.outcomes.map((o) => {
    const row = assertions.map((a) => matchScore(o.kaneText, a));
    const max = Math.max(0, ...row);
    if (max === 0) return { ai: -1, score: 0, reason: 'none' as const };
    const top = row.flatMap((s, ai) => (s === max ? [ai] : []));
    return top.length === 1 ? { ai: top[0], score: max, reason: 'ok' as const } : { ai: -1, score: max, reason: 'tie' as const };
  });
  const claims = new Map<number, number>();
  for (const b of best) if (b.ai >= 0) claims.set(b.ai, (claims.get(b.ai) ?? 0) + 1);
  return best.map((b, i) => {
    const o = t.outcomes[i];
    if (b.reason === 'none') {
      notes.push(`Outcome ${o.index}: no Kane assertion matched "${o.text}".`);
      return null;
    }
    if (b.reason === 'tie') {
      notes.push(`Outcome ${o.index}: more than one Kane assertion matched equally well; not matched.`);
      return null;
    }
    if ((claims.get(b.ai) ?? 0) > 1) {
      notes.push(`Outcome ${o.index}: its best Kane assertion is also the best match for another outcome; not matched.`);
      return null;
    }
    notes.push(`Outcome ${o.index}: matched Kane assertion "${assertions[b.ai].text.slice(0, 120)}" (score ${b.score}).`);
    return assertions[b.ai];
  });
}

/** Which documented step does this failure text refer to? Exactly one, or null. */
function attributeStep(t: Tutorial, failureText: string, notes: string[]): number | null {
  const hay = norm(failureText);
  const scores = t.steps.map((s) => {
    const labels = quotedValues(s.kaneText).map((l) => norm(l));
    // Prefer the action target (last label) and count whole-label mentions.
    let score = 0;
    labels.forEach((l, k) => {
      const exactQuoted = hay.includes(`'${l}'`) || hay.includes(`"${l}"`);
      const present = new RegExp(`(^|[^a-z0-9])${l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(hay);
      if (exactQuoted) score += k === labels.length - 1 ? 3 : 2;
      else if (present) score += 1;
    });
    return { index: s.index, score };
  });
  const best = Math.max(0, ...scores.map((x) => x.score));
  const top = scores.filter((x) => x.score === best && best > 0);
  notes.push(`Step attribution scores: ${scores.map((x) => `${x.index}=${x.score}`).join(', ')}.`);
  if (top.length !== 1) {
    notes.push(top.length === 0 ? 'Failure text names no documented label.' : 'Failure text matches more than one documented step equally.');
    return null;
  }
  return top[0].index;
}

function outsideOrigin(urls: (string | null | undefined)[], appOrigin: string): string[] {
  const bad: string[] = [];
  for (const u of urls) {
    if (!u || u === 'about:blank') continue;
    try {
      const o = new URL(u);
      if (o.origin !== appOrigin) bad.push(o.origin === 'null' ? o.protocol : o.origin);
    } catch {
      bad.push('unparseable URL');
    }
  }
  return [...new Set(bad)];
}

export function classify(input: ClassifyInput): Classification {
  const { tutorial: t, runEnd } = input;
  const notes: string[] = [];
  const steps = (status: StepResult['status']): StepResult[] => t.steps.map((s) => ({ index: s.index, status }));
  const outcomesNotChecked = (): OutcomeResult[] => t.outcomes.map((o) => ({ index: o.index, status: 'not_checked', assertion: null }));
  const result = (status: Classification['status'], code: string, explanation: string, extra: Partial<Classification> = {}): Classification => ({
    status,
    code,
    explanation,
    documentationDefect: false,
    failedStep: null,
    failedOutcome: null,
    stepResults: steps('unknown'),
    outcomeResults: outcomesNotChecked(),
    matchingNotes: notes,
    ...extra,
  });

  // ---- BLOCKED: external conditions ----
  if (!input.preflight.ok) return result('BLOCKED', 'app_unreachable', `The application could not be reached before the run${input.preflight.detail ? ` (${input.preflight.detail})` : ''}.`);
  if (input.spawnError) return result('BLOCKED', 'kane_not_started', `Kane CLI could not be started: ${input.spawnError}`);
  if (input.cancelled) return result('BLOCKED', 'cancelled', 'The run was cancelled before Kane finished.');
  if (input.timedOut) return result('BLOCKED', 'timeout', 'Kane did not finish within the time limit.');
  if (input.exitCode === 2) return result('BLOCKED', 'kane_setup_error', 'Kane reported a setup, authentication, browser or network error (exit code 2).');
  if (input.exitCode === 3) return result('BLOCKED', 'kane_timeout', 'Kane reported a timeout or cancellation (exit code 3).');
  if (!runEnd) return result('BLOCKED', 'no_result', 'Kane ended without a structured result.');

  const visited = [...input.evidenceSteps.map((s) => s.url), typeof runEnd.final_state?.url === 'string' ? (runEnd.final_state.url as string) : null];
  if (visited.some((u) => u && /^chrome-error:/i.test(u))) return result('BLOCKED', 'browser_error_page', 'The browser showed an error page; the application may have been unreachable.');
  const offOrigin = outsideOrigin(visited, input.appOrigin);

  const assertions = [...memoryAssertions(runEnd), ...evidenceAssertions(input.evidenceSteps)];
  const reasonCode = String(runEnd.reason_code ?? '');

  // ---- PASSED path ----
  if (input.exitCode === 0 && runEnd.status === 'passed') {
    if (offOrigin.length) {
      return result('NEEDS_REVIEW', 'left_app_origin', `Kane reported success but visited pages outside the application (${offOrigin.join(', ')}).`, { stepResults: steps('passed') });
    }
    // Use ONE source of assertions, never both: memory records and evidence
    // assert steps describe the same checks, so combining them would create
    // duplicates that could make one check appear to prove two outcomes.
    // Memory records are preferred (they carry extracted values).
    const memory = assertions.filter((a) => a.source === 'memory');
    const pool = memory.length > 0 ? memory : assertions.filter((a) => a.source === 'evidence');
    notes.push(`Assertion source: ${memory.length > 0 ? `${memory.length} Kane memory record(s)` : `${pool.length} evidence assert step(s)`} for ${t.outcomes.length} documented outcome(s).`);
    const matched = matchOutcomes(t, pool, notes);
    const outcomeResults: OutcomeResult[] = t.outcomes.map((o, i) => {
      const a = matched[i];
      return { index: o.index, status: a ? (a.passed ? 'passed' : 'failed') : 'not_checked', assertion: a ? { query: a.text.slice(0, 300), extracted: a.extracted, passed: a.passed } : null };
    });
    const unchecked = outcomeResults.filter((r) => r.status === 'not_checked').map((r) => r.index);
    const failed = outcomeResults.filter((r) => r.status === 'failed').map((r) => r.index);
    if (unchecked.length || failed.length) {
      const parts = [];
      if (unchecked.length) parts.push(`expected outcome${unchecked.length > 1 ? 's' : ''} ${unchecked.join(', ')} ${unchecked.length > 1 ? 'were' : 'was'} not explicitly checked`);
      if (failed.length) parts.push(`the check for outcome ${failed.join(', ')} did not pass`);
      return result('NEEDS_REVIEW', 'outcomes_not_proven', `Kane reported success, but ${parts.join(' and ')}. A run cannot pass without a passing assertion for every documented outcome.`, {
        stepResults: steps('passed'),
        outcomeResults,
      });
    }
    return result('PASSED', 'all_outcomes_asserted', `Kane followed all ${t.steps.length} documented steps and a passing assertion was recorded for each of the ${t.outcomes.length} expected outcomes.`, {
      stepResults: steps('passed'),
      outcomeResults,
    });
  }

  // ---- FAILED path ----
  if (input.exitCode === 1 && runEnd.status === 'failed') {
    if (offOrigin.length) return result('NEEDS_REVIEW', 'left_app_origin', `The run failed after visiting pages outside the application (${offOrigin.join(', ')}).`);
    if (!reasonCode.startsWith('assertion_error.')) {
      return result('NEEDS_REVIEW', 'failure_not_assertion', `Kane failed with "${reasonCode || 'no reason code'}", which may be an automation problem rather than a documentation mismatch.`);
    }
    const failedEv = input.evidenceSteps.find((s) => s.status === 'failed' || s.status === 'broken');
    const failedProgress = input.progress.find((p) => p.status === 'failed');
    const failText = [failedEv?.summary, failedProgress?.remark, runEnd.reason, runEnd.one_liner, input.failureMessage].filter(Boolean).join(' || ');
    const failedKind = failedEv ? stepKind(failedEv) : '';

    // A failed assertion maps to an expected outcome; anything else to a step.
    if (failedKind === 'assert' || failedKind === 'analyze') {
      const pool: Assertion[] = [{ source: 'evidence', text: failText, extracted: null, passed: false }];
      const matched = matchOutcomes(t, pool, notes);
      const hits = matched.map((m, i) => (m ? t.outcomes[i].index : null)).filter((x): x is number => x !== null);
      if (hits.length !== 1) {
        return result('NEEDS_REVIEW', 'failure_not_attributable', 'An expected-outcome check failed, but it could not be matched to exactly one documented outcome.', { stepResults: steps('passed') });
      }
      const outcomeResults = outcomesNotChecked().map((r) => (r.index === hits[0] ? { ...r, status: 'failed' as const } : r));
      return result('FAILED', 'doc_outcome_not_met', `All documented steps were completed, but expected outcome ${hits[0]} was not observed: ${runEnd.reason ?? 'see evidence'}.`, {
        documentationDefect: true,
        failedOutcome: hits[0],
        stepResults: steps('passed'),
        outcomeResults,
      });
    }

    const stepIndex = attributeStep(t, failText, notes);
    if (stepIndex === null) {
      return result('NEEDS_REVIEW', 'failure_not_attributable', 'Kane reported a failure, but it could not be traced to exactly one documented step. The matching details are kept for review.');
    }
    // Corroborate with position: the documented steps before the failing one need
    // at most two browser actions each (e.g. click a field, then type). If Kane
    // completed more actions than that, the label match is suspicious.
    const completedActions = input.evidenceSteps.filter((s) => s.status === 'passed' && ACTION_KINDS.has(stepKind(s))).length;
    notes.push(`Completed Kane actions before failure: ${completedActions}; attributed to documented step ${stepIndex}.`);
    if (completedActions > 2 * (stepIndex - 1)) {
      return result('NEEDS_REVIEW', 'failure_position_mismatch', 'The failure names a documented step that does not fit how far Kane got. Review needed.');
    }
    const stepResults: StepResult[] = t.steps.map((s) => ({ index: s.index, status: s.index < stepIndex ? 'passed' : s.index === stepIndex ? 'failed' : 'not_reached' }));
    const doc = t.steps.find((s) => s.index === stepIndex)!;
    return result('FAILED', 'doc_step_not_achievable', `Step ${stepIndex} could not be completed as documented ("${doc.text}"). Kane: ${runEnd.reason ?? 'see evidence'}`, {
      documentationDefect: true,
      failedStep: stepIndex,
      stepResults,
    });
  }

  // ---- Everything else ----
  return result('NEEDS_REVIEW', 'inconsistent_result', `Kane's exit code (${input.exitCode}) and reported status ("${runEnd.status}") do not agree.`);
}
