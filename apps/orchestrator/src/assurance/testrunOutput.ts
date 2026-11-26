// Kane's structured output of one `testrun` (Agent Mode NDJSON), as Kane 0.10.5 wrote it in
// KaneVerity's real authoring run of 2026-11-26 (job j20261126-112315-2666b1). Pure.
//
// Events of a run of N tests:
//   stream_start                     cli_version, surface: "testrun"
//   testrun_plan                     members[{path}]                      (absolute paths)
//   testrun_authored_member_start    path, session_id, log_path           (one per test)
//   testrun_authored_member_end      path, test_id, status, duration_s    (one per test)
//   testrun_evidence_ingest          status: "ok", evidence_id            (the combined pack)
//   coverage                         pack: <workspace>/.testmuai/evidence/<evidence_id>.evidence
//   testrun_summary                  execution {id, status, evidence_id}, authored[{path, test_id,
//                                    execution_id, source_execution_id, status}], totals, cancelled
//   testrun_done                     execution_id, overall_status
//
// Kane wrote N + 1 evidence packs: one per test (`source_execution_id`) and one combined pack
// (`evidence_id` = `execution.id` = `testrun_done.execution_id`) whose run.yaml lists the
// per-test packs in `merged_from`. KaneVerity verifies only the combined pack it names.
//
// Fail closed: any line that is not a JSON event, a missing or repeated event, an id that is not
// a UUID, ids that disagree, a pack outside the evidence folder, or members that are not exactly
// the approved test files, and no pack is accepted. Nothing private is returned: no log or
// session paths, no event text; only ids, workspace-relative test paths and statuses.

import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface TestrunMember {
  /** Workspace-relative test file, e.g. .testmuai/tests/x_test.md. */
  path: string;
  /** Kane's test id (e.g. generate-key-and-compare-the-complete-ap-1e27cf54). */
  testId: string;
  status: string;
  durationS: number | null;
  /** The per-test pack Kane reported (`source_execution_id`), or null in a single-pack run. */
  sourcePack: string | null;
}

export interface TestrunReport {
  ok: boolean;
  problems: string[];
  /** The combined pack's id, as Kane reported it (only when every check passed). */
  evidenceId: string | null;
  /** `<evidenceId>.evidence` */
  packFile: string | null;
  /** The per-test packs Kane reported, as file names (empty in a single-pack run). */
  testPacks: string[];
  /** One per approved test file, in the order of `files`. */
  members: TestrunMember[];
  overallStatus: string | null;
  totals: { tests: number; passed: number; failed: number; broken: number; skipped: number } | null;
}

const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown) => (typeof v === 'string' ? v : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A path Kane printed, relative to the workspace with forward slashes; null if outside it. */
function workspaceRelative(p: unknown, workspaceDir: string): string | null {
  if (typeof p !== 'string' || !p) return null;
  // Kane runs on this machine, so its paths use this platform's conventions.
  const abs = path.isAbsolute(p) ? p : path.join(workspaceDir, p);
  const rel = path.relative(workspaceDir, abs);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * Read a test run's output and check it against the approved test files (workspace-relative,
 * as passed to Kane). `ok` only when every rule above holds.
 */
export function parseTestrunOutput(stdout: string, opts: { workspaceDir: string; files: string[] }): TestrunReport {
  const problems: string[] = [];
  const res: TestrunReport = { ok: false, problems, evidenceId: null, packFile: null, testPacks: [], members: [], overallStatus: null, totals: null };
  const events: Record<string, unknown>[] = [];
  const lines = stdout.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      problems.push(`Line ${i + 1} of Kane's output is not a JSON event.`);
      return;
    }
    if (!obj(e) || typeof (e as { type?: unknown }).type !== 'string') {
      problems.push(`Line ${i + 1} of Kane's output is not a Kane event.`);
      return;
    }
    events.push(e as Record<string, unknown>);
  });
  const all = (type: string) => events.filter((e) => e.type === type);
  const one = (type: string): Record<string, unknown> | null => {
    const found = all(type);
    if (found.length !== 1) {
      problems.push(found.length === 0 ? `Kane's output has no ${type} event.` : `Kane's output has ${found.length} ${type} events; exactly one was expected.`);
      return null;
    }
    return found[0];
  };
  const plan = one('testrun_plan');
  const ingest = one('testrun_evidence_ingest');
  const coverage = one('coverage');
  const summary = one('testrun_summary');
  const done = one('testrun_done');

  // The combined pack: one id, reported the same way everywhere.
  const id = str(done?.execution_id);
  if (done && (!id || !UUID.test(id))) problems.push('testrun_done has no valid execution id.');
  res.overallStatus = str(done?.overall_status);
  if (done && !res.overallStatus) problems.push('testrun_done has no overall status.');
  if (ingest) {
    if (str(ingest.status) !== 'ok') problems.push(`Kane did not ingest the evidence (status: ${str(ingest.status) ?? 'missing'}).`);
    if (str(ingest.evidence_id) !== id) problems.push('The evidence id Kane ingested is not the run id in testrun_done.');
  }
  const exec = obj(summary?.execution);
  if (summary) {
    if (str(exec?.id) !== id) problems.push('The execution id in testrun_summary is not the run id in testrun_done.');
    if (str(exec?.evidence_id) !== id) problems.push('The evidence id in testrun_summary is not the run id in testrun_done.');
    if (summary.cancelled !== false) problems.push('Kane does not report the run as complete (cancelled is not false).');
    const t = obj(summary.totals);
    const n = (k: string) => num(t?.[k]);
    if (t && [n('tests'), n('passed'), n('failed'), n('broken'), n('skipped')].every((x) => x !== null)) res.totals = { tests: n('tests')!, passed: n('passed')!, failed: n('failed')!, broken: n('broken')!, skipped: n('skipped')! };
    else problems.push('testrun_summary has no complete totals.');
    if (res.totals && res.totals.tests !== opts.files.length) problems.push(`Kane counted ${res.totals.tests} tests; ${opts.files.length} were approved for this run.`);
  }
  if (coverage) {
    const rel = workspaceRelative(coverage.pack, opts.workspaceDir);
    if (!id || rel !== `.testmuai/evidence/${id}.evidence`) problems.push("The coverage event's evidence pack is not the pack named by the run id in the workspace's evidence folder.");
  }

  // Members: exactly the approved files, in the plan, the member ends and the summary.
  const approved = [...opts.files].sort();
  const sameSet = (label: string, paths: (string | null)[]) => {
    if (paths.some((p) => p === null)) problems.push(`${label} names a test outside the workspace or without a path.`);
    const got = (paths.filter(Boolean) as string[]).sort();
    if (new Set(got).size !== got.length) problems.push(`${label} names a test more than once.`);
    if (JSON.stringify(got) !== JSON.stringify(approved)) problems.push(`${label} is not exactly the approved test files.`);
  };
  const planMembers = Array.isArray(plan?.members) ? (plan!.members as unknown[]) : null;
  if (plan) {
    if (!planMembers) problems.push('testrun_plan has no members.');
    else sameSet('The run plan', planMembers.map((m) => workspaceRelative(obj(m)?.path, opts.workspaceDir)));
  }
  const ends = all('testrun_authored_member_end');
  sameSet("Kane's finished tests", ends.map((e) => workspaceRelative(e.path, opts.workspaceDir)));
  const authored = Array.isArray(summary?.authored) ? (summary!.authored as unknown[]).map(obj) : null;
  if (summary && !authored) problems.push('testrun_summary lists no authored tests.');
  if (authored) {
    if (authored.some((a) => !a)) problems.push('testrun_summary has an authored entry that is not an object.');
    sameSet('testrun_summary', authored.map((a) => workspaceRelative(a?.path, opts.workspaceDir)));
    const sources = authored.map((a) => (a && 'source_execution_id' in a ? a.source_execution_id : undefined));
    const withSource = sources.filter((s) => s !== undefined);
    if (withSource.length && withSource.length !== authored.length) problems.push('Kane reported a per-test evidence pack for some tests but not for others.');
    if (withSource.some((s) => typeof s !== 'string' || !UUID.test(s))) problems.push('A per-test evidence pack id is not a valid id.');
    if (new Set(withSource).size !== withSource.length) problems.push('Two tests report the same per-test evidence pack.');
    if (id && withSource.includes(id)) problems.push('A per-test evidence pack has the combined pack id.');
    for (const a of authored) {
      if (!a) continue;
      if (str(a.execution_id) !== id) problems.push('An authored test in testrun_summary belongs to another run id.');
      if (!str(a.test_id)) problems.push('An authored test in testrun_summary has no test id.');
      if (!str(a.status)) problems.push('An authored test in testrun_summary has no status.');
    }
  }
  // One member per approved file, consistent between the member end and the summary.
  for (const f of opts.files) {
    const a = authored?.find((x) => workspaceRelative(x?.path, opts.workspaceDir) === f) ?? null;
    const e = ends.find((x) => workspaceRelative(x.path, opts.workspaceDir) === f) ?? null;
    if (!a || !e) continue;
    if (str(e.status) !== str(a.status)) problems.push(`Kane reports two different statuses for ${f}.`);
    if (str(e.test_id) !== str(a.test_id)) problems.push(`Kane reports two different test ids for ${f}.`);
    const src = typeof a.source_execution_id === 'string' ? a.source_execution_id : null;
    res.members.push({ path: f, testId: str(a.test_id) ?? '', status: str(a.status) ?? '', durationS: num(e.duration_s), sourcePack: src ? `${src}.evidence` : null });
  }
  if (!problems.length && res.members.length !== opts.files.length) problems.push('Not every approved test has a consistent result in Kane\'s output.');

  res.ok = problems.length === 0;
  if (res.ok) {
    res.evidenceId = id;
    res.packFile = `${id}.evidence`;
    res.testPacks = res.members.map((m) => m.sourcePack).filter((x): x is string => !!x).sort();
  } else res.members = [];
  return res;
}
