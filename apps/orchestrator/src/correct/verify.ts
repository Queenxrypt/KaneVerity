// Gates computed from Kane evidence only. Claude's conclusions never count.
//
// External navigation: KaneVerity DETECTS unexpected origins in the evidence
// after a run (visitedOrigins). It cannot PREVENT the browser from visiting
// them. Any recorded unexpected origin rejects the exploration or retest.

import type { RunRecord } from '../kane/runner.ts';
import { ACTION_KINDS, stepKind } from '../verify/classify.ts';
import type { VerificationCheck } from './store.ts';

function check(name: string, ok: boolean, detail: string): VerificationCheck {
  return { name, ok, detail };
}

function originsOk(run: RunRecord): VerificationCheck {
  const visited = run.visitedOrigins ?? [];
  const unexpected = visited.filter((o) => o !== run.appOrigin);
  return check(
    'No unexpected origin recorded',
    visited.length > 0 && unexpected.length === 0,
    unexpected.length ? `Evidence records visits to ${unexpected.join(', ')} (detected after the run; not prevented).` : visited.length ? `Only ${run.appOrigin} was recorded.` : 'No visited URLs were recorded.',
  );
}

function packOk(run: RunRecord): VerificationCheck {
  const v = run.evidence.kaneValidation;
  return check(
    'Evidence pack valid and finalized',
    run.evidence.found && run.evidence.valid && v?.status === 'valid' && v.packStatus === 'finalized',
    `Captured: ${run.evidence.found}; readable: ${run.evidence.valid}; Kane validation: ${v?.status ?? 'not run'}${v?.packStatus ? ` (${v.packStatus})` : ''}.`,
  );
}

function outcomesOk(run: RunRecord): VerificationCheck {
  const c = run.classification;
  const results = c?.outcomeResults ?? [];
  const queries = results.map((r) => r.assertion?.query ?? '');
  const distinct = new Set(queries).size === results.length;
  const allPassed = results.length > 0 && results.every((r) => r.status === 'passed' && r.assertion?.passed === true);
  return check(
    'Every documented outcome matched to a distinct passing Kane assertion',
    c?.status === 'PASSED' && allPassed && distinct && results.length === run.tutorial.outcomes.length,
    `${results.filter((r) => r.status === 'passed').length} of ${run.tutorial.outcomes.length} outcomes proven${distinct ? '' : ' (assertions not distinct)'}; KaneVerity status ${c?.status ?? 'none'}.`,
  );
}

/** D4: did the exploration independently complete the route? */
export function assessExploration(run: RunRecord): { confirmed: boolean; reason: string; checks: VerificationCheck[] } {
  const actions = run.evidence.steps.filter((s) => s.status === 'passed' && ACTION_KINDS.has(stepKind(s)));
  const checks = [
    check('Exploration run finished', run.state === 'finished' && run.kind === 'exploration', `State ${run.state}, kind ${run.kind ?? 'verification'}.`),
    check('Kane process exited successfully', run.exitCode === 0, `Exit code ${run.exitCode}.`),
    check('run_end status passed', run.kane.status === 'passed', `run_end status ${run.kane.status ?? 'missing'}.`),
    outcomesOk(run),
    packOk(run),
    originsOk(run),
    check('Route actions recorded', actions.length > 0, `${actions.length} passed click/type actions recorded.`),
  ];
  const failed = checks.filter((c) => !c.ok);
  return {
    confirmed: failed.length === 0,
    reason: failed.length ? `Route not confirmed: ${failed.map((c) => c.name.toLowerCase()).join('; ')}.` : 'Kane completed the route and independently proved every documented outcome.',
    checks,
  };
}

/** D6: VERIFIED only if every check passes. */
export function verifyRetest(run: RunRecord, approvedSha256: string): { verified: boolean; checks: VerificationCheck[] } {
  const first = run.evidence.steps[0];
  let cleanStart = false;
  try {
    cleanStart = !!first?.url && new URL(first.url).href === new URL(run.appStartUrl).href;
  } catch {
    cleanStart = false;
  }
  const checks = [
    check('Retest is linked to this correction', run.kind === 'retest', `Run kind ${run.kind ?? 'verification'}.`),
    check(
      'Retest used the approved corrected document',
      run.expectedSourceSha256 === approvedSha256 && run.tutorial.sourceSha256 === approvedSha256,
      run.tutorial.sourceSha256 === approvedSha256 ? 'Live docs page fingerprint matched the approved document.' : 'Live docs page fingerprint did not match the approved document.',
    ),
    check('Clean start on the application start page', cleanStart && run.classification?.code !== 'app_unreachable', cleanStart ? 'First evidence step was a fresh load of the start URL.' : 'First evidence step was not the start URL.'),
    check('Kane process exited successfully', run.exitCode === 0, `Exit code ${run.exitCode}.`),
    check('run_end status passed', run.kane.status === 'passed', `run_end status ${run.kane.status ?? 'missing'}.`),
    outcomesOk(run),
    packOk(run),
    originsOk(run),
  ];
  return { verified: checks.every((c) => c.ok), checks };
}
