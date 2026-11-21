import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, ORCHESTRATOR_DOWN, subscribeRun, type Transport } from '../api.ts';
import { Card, Collapsible, ConfirmDialog, ErrorNote, formatTime, RunCost, SourceRef, StatusBadge } from '../components/ui.tsx';
import type { PublicRun } from '../types.ts';

const STEP_STYLE: Record<string, string> = {
  passed: 'text-pass',
  failed: 'text-fail font-semibold',
  not_reached: 'text-slate-500',
  unknown: 'text-slate-500',
  not_checked: 'text-slate-500',
};
const STEP_LABEL: Record<string, string> = { passed: 'Passed', failed: 'Failed', not_reached: 'Not reached', unknown: 'Unknown', not_checked: 'Not checked' };

function Screenshots({ run }: { run: PublicRun }) {
  const [open, setOpen] = useState<string | null>(null);
  const ev = run.evidence;
  if (!ev) return null;
  const failed = new Set(ev.steps.filter((s) => s.status === 'failed' || s.status === 'broken').map((s) => s.ordinal));
  return (
    <div>
      {ev.screenshots.length === 0 ? (
        <p className="text-sm text-slate-600">No screenshots available for display.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
          {ev.screenshots.map((s) => {
            const step = ev.steps.find((x) => x.ordinal === s.ordinal);
            const src = `/api/runs/${encodeURIComponent(run.runId)}/screens/${encodeURIComponent(s.file)}`;
            const isFail = failed.has(s.ordinal);
            return (
              <figure key={s.file} className={`overflow-hidden rounded-md border bg-white ${isFail ? 'border-fail ring-2 ring-fail/40' : 'border-slate-200'}`}>
                <button type="button" onClick={() => setOpen(src)} className="block w-full" aria-label={`Enlarge screenshot of Kane step ${s.ordinal}`}>
                  <img src={src} alt={`Kane step ${s.ordinal}: ${step?.summary ?? ''}`} loading="lazy" className="aspect-video w-full object-cover object-top" />
                </button>
                <figcaption className="px-2 py-1.5 text-xs">
                  <span className={isFail ? 'font-semibold text-fail' : 'text-slate-600'}>
                    Step {s.ordinal}
                    {isFail ? ' · failed' : ''}
                  </span>
                  <span className="block truncate text-slate-500" title={step?.summary}>
                    {step?.summary}
                  </span>
                </figcaption>
              </figure>
            );
          })}
        </div>
      )}
      {ev.withheldScreenshots > 0 && <p className="mt-2 text-xs text-slate-500">{ev.withheldScreenshots} screenshot(s) withheld: not shown to be on the demo application.</p>}
      {open && (
        <div role="dialog" aria-label="Screenshot" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 p-4" onClick={() => setOpen(null)}>
          <img src={open} alt="Enlarged Kane screenshot" className="max-h-full max-w-full rounded-md border border-white/20 bg-white" />
        </div>
      )}
    </div>
  );
}

export function RunDetail() {
  const { runId = '' } = useParams();
  const [params] = useSearchParams();
  const forcePoll = params.get('transport') === 'poll';
  const [run, setRun] = useState<PublicRun | null>(null);
  const [transport, setTransport] = useState<Transport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [confirmCorrection, setConfirmCorrection] = useState(false);
  const [starting, setStarting] = useState(false);
  const navigate = useNavigate();

  async function startCorrection() {
    setStarting(true);
    setError(null);
    try {
      const c = await api.startCorrection(runId);
      navigate(`/corrections/${c.id}`);
    } catch (e) {
      setError((e as Error).message);
      setConfirmCorrection(false);
    } finally {
      setStarting(false);
    }
  }

  useEffect(() => {
    let unsub: (() => void) | null = null;
    let cancelled = false;
    api
      .run(runId)
      .then((r) => {
        if (cancelled) return;
        setRun(r);
        if (r.state !== 'finished') unsub = subscribeRun(runId, setRun, setTransport, setError, forcePoll);
      })
      .catch((e: ApiError) => (e.status === 404 ? setNotFound(true) : setError(e.message)));
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [runId, forcePoll]);

  useEffect(() => {
    document.title = `${run?.tutorial?.title ?? 'Run'} · KaneVerity`;
  }, [run?.tutorial?.title]);

  if (notFound) {
    return (
      <Card title="Run not found">
        <Link to="/" className="text-sm text-brand hover:underline">
          Back to the dashboard
        </Link>
      </Card>
    );
  }
  if (!run) return error ? (error === ORCHESTRATOR_DOWN ? <p className="text-sm text-slate-600">Waiting for the orchestrator…</p> : <ErrorNote message={error} />) : <p className="text-sm text-slate-600">Loading…</p>;

  const c = run.classification;
  const t = run.tutorial;
  const active = run.state !== 'finished';

  async function cancel() {
    setCancelling(true);
    try {
      await api.cancel(run!.runId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <Link to="/tutorials" className="text-sm text-brand hover:underline">
          ← Tutorials
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">{t?.title ?? 'Verification run'}</h1>
          {run.kind === 'exploration' ? (
            <span className="inline-flex items-center rounded-full border border-brand/30 bg-brand-soft px-3 py-1 text-sm font-semibold text-brand">EXPLORATION</span>
          ) : (
            <StatusBadge run={run} large />
          )}
          {run.kind === 'exploration' && (
            <span data-testid="exploration-mode" className="rounded-full border border-slate-300 px-2 py-0.5 text-xs font-medium text-slate-600">
              mode: {run.explorationMode ?? 'default'}
            </span>
          )}
          {run.kind === 'retest' && <span className="rounded-full border border-slate-300 px-2 py-0.5 text-xs font-medium text-slate-600">Retest</span>}
          {active && (
            <button type="button" onClick={cancel} disabled={cancelling} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50">
              {cancelling ? 'Cancelling…' : 'Cancel run'}
            </button>
          )}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-600">
          <span>
            Run <span className="font-mono" data-testid="run-reference">{run.runId}</span>
          </span>
          {run.startedAt && <span>Started {formatTime(run.startedAt)}</span>}
          {run.durationSec != null && <span>{run.durationSec}s</span>}
          {run.state === 'finished' && <span data-testid="run-cost"><RunCost run={run} /></span>}
          {run.cliVersion && <span>Kane CLI {run.cliVersion}</span>}
          {active && transport && <span data-testid="transport">Updates: {transport === 'live' ? 'live stream' : 'polling every 3s'}</span>}
        </div>
      </div>
      <ErrorNote message={error} />

      {active && (
        <Card title="Kane is running">
          <p className="mb-3 text-sm text-slate-600">Kane is following the documented steps in a real browser. This usually takes 2-3 minutes.</p>
          <ol className="space-y-1 font-mono text-xs" data-testid="live-feed">
            {(run.progress ?? []).map((p, i) => (
              <li key={i} className={p.status === 'failed' ? 'text-fail' : p.status === 'done' ? 'text-pass' : 'text-slate-600'}>
                [{p.status}] {p.remark}
              </li>
            ))}
            {(run.progress ?? []).length === 0 && <li className="text-slate-500">Waiting for Kane to start…</li>}
          </ol>
        </Card>
      )}

      {c && (
        <Card title={run.kind === 'exploration' ? 'Exploration result' : 'Why this status'}>
          {run.kind === 'exploration' ? (
            <p className="text-sm" data-testid="explanation">
              This was a Kane <strong>exploration</strong> run for a correction. It does not verify documentation. It only records how the task is done today and whether every documented outcome was reached.
              {c.status === 'PASSED' ? ' Every documented outcome was reached with a distinct passing assertion.' : ` Outcomes not all proven (${c.explanation})`}
            </p>
          ) : (
            <>
              <p className="text-sm" data-testid="explanation">
                {c.explanation}
              </p>
              <p className="mt-2 text-sm">
                Documentation defect: <strong>{c.documentationDefect ? 'Yes' : 'No'}</strong>
                {c.status === 'BLOCKED' && ' (an external condition prevented a result)'}
                {c.status === 'NEEDS_REVIEW' && ' (the evidence is inconclusive)'}
              </p>
            </>
          )}
          {run.correctionId && (
            <p className="mt-2 text-sm">
              Part of correction{' '}
              <Link to={`/corrections/${run.correctionId}`} className="font-mono text-xs text-brand hover:underline">
                {run.correctionId}
              </Link>
            </p>
          )}
          {c.documentationDefect && run.kind !== 'exploration' && (
            <button type="button" onClick={() => setConfirmCorrection(true)} className="mt-3 rounded-md bg-brand px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90">
              Propose correction
            </button>
          )}
        </Card>
      )}

      {t && c && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card title="Documented steps">
            <ol className="space-y-2 text-sm">
              {t.steps.map((s) => {
                const st = c.stepResults.find((r) => r.index === s.index)?.status ?? 'unknown';
                return (
                  <li key={s.index} className={`rounded-md p-2 ${st === 'failed' ? 'bg-fail-soft' : ''}`} data-testid={`step-${s.index}`}>
                    <div className="flex items-start gap-2">
                      <span className="w-5 shrink-0 text-right text-slate-500">{s.index}.</span>
                      <span className="flex-1">{s.text}</span>
                      <span className={`shrink-0 text-xs ${STEP_STYLE[st]}`}>{STEP_LABEL[st]}</span>
                    </div>
                    <div className="mt-1 pl-7">
                      <SourceRef ref={s.ref} />
                    </div>
                  </li>
                );
              })}
            </ol>
          </Card>
          <Card title="Expected outcomes">
            <ul className="space-y-2 text-sm">
              {t.outcomes.map((o) => {
                const r = c.outcomeResults.find((x) => x.index === o.index);
                const st = r?.status ?? 'not_checked';
                return (
                  <li key={o.index} className={`rounded-md p-2 ${st === 'failed' ? 'bg-fail-soft' : ''}`} data-testid={`outcome-${o.index}`}>
                    <div className="flex items-start gap-2">
                      <span className="flex-1">{o.text}</span>
                      <span className={`shrink-0 text-xs ${STEP_STYLE[st]}`}>{STEP_LABEL[st]}</span>
                    </div>
                    <div className="mt-1">
                      <SourceRef ref={o.ref} />
                    </div>
                    {r?.assertion && (
                      <div className="mt-1 text-xs text-slate-600">
                        Kane check: <span className="italic">{r.assertion.query}</span>
                        {r.assertion.extracted != null && <> · observed: <code className="font-mono">{r.assertion.extracted}</code></>}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        </div>
      )}

      {run.kane?.reason && (
        <Card title="Kane's finding">
          <p className="text-sm">{run.kane.reason}</p>
          {run.kane.triage && <p className="mt-1 text-xs text-slate-500">Kane label: {run.kane.triage} (recorded, but it does not decide the KaneVerity status)</p>}
          {run.kane.reasonCode && <p className="mt-1 font-mono text-xs text-slate-500">{run.kane.reasonCode}</p>}
        </Card>
      )}

      {run.evidence && (
        <Card title="Evidence">
          <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-sm" data-testid="evidence-status">
            <span>
              Evidence pack: <strong>{run.evidence.found ? 'captured' : 'not produced'}</strong>
            </span>
            <span>
              KaneVerity check: <strong>{run.evidence.valid ? 'readable' : 'not readable'}</strong>
            </span>
            <span>
              Kane validation:{' '}
              <strong>
                {run.evidence.kaneValidation.status === 'valid'
                  ? `valid${run.evidence.kaneValidation.packStatus ? ` (${run.evidence.kaneValidation.packStatus})` : ''}`
                  : run.evidence.kaneValidation.status === 'invalid'
                    ? 'invalid'
                    : 'not recorded for this run'}
              </strong>
              {run.evidence.kaneValidation.warnings > 0 && <span className="text-slate-500"> · {run.evidence.kaneValidation.warnings} warning(s)</span>}
            </span>
            <span className="text-slate-500">
              Reference: run <span className="font-mono">{run.evidence.runReference}</span>
            </span>
          </div>
          {run.evidence.problems.length > 0 && (
            <ul className="mb-3 list-disc pl-5 text-xs text-review">
              {run.evidence.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {run.visitedOrigins && run.visitedOrigins.length > 0 && (
            <p className="mb-3 text-xs text-slate-600" data-testid="visited-origins">
              Origins recorded in the evidence: <span className="font-mono">{run.visitedOrigins.join(', ')}</span>. External navigation is <strong>detected after the run</strong> from this evidence; it is not prevented during the run.
            </p>
          )}
          <Screenshots run={run} />
        </Card>
      )}

      {run.warnings.length > 0 && (
        <Card title="Warnings">
          <ul className="list-disc pl-5 text-sm text-review">
            {run.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Card>
      )}

      {run.objective && (
        <Collapsible title="Exact instructions sent to Kane">
          <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed" data-testid="objective">
            {run.objective}
          </pre>
          <p className="mt-2 text-xs text-slate-500">Start URL: {run.appStartUrl}</p>
        </Collapsible>
      )}
      {c && c.matchingNotes.length > 0 && (
        <Collapsible title="Matching notes">
          <ul className="list-disc space-y-1 pl-5 text-xs text-slate-700">
            {c.matchingNotes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </Collapsible>
      )}
      {run.evidence && run.evidence.steps.length > 0 && (
        <Collapsible title="Kane step log">
          <ol className="space-y-1 font-mono text-xs">
            {run.evidence.steps.map((s) => (
              <li key={s.ordinal} className={s.status === 'failed' || s.status === 'broken' ? 'text-fail' : ''}>
                {s.ordinal}. [{s.status}] {s.kind ? `${s.kind}: ` : ''}
                {s.summary}
              </li>
            ))}
          </ol>
        </Collapsible>
      )}
      <ConfirmDialog
        open={confirmCorrection}
        title="Ask Claude to review this finding?"
        confirmLabel="Ask Claude"
        busy={starting}
        onCancel={() => setConfirmCorrection(false)}
        onConfirm={() => void startCorrection()}
      >
        <p>Claude Code reviews a sanitized package (this tutorial, the failed step and Kane's evidence) in an isolated folder, with read-only access to that folder only.</p>
        <p>It may only propose a correction once a Kane exploration has confirmed the route. Nothing changes without your approval, and only a Kane retest can mark it VERIFIED.</p>
        <p>This makes a real Claude Code call (capped at $1). No Kane credits are used at this stage.</p>
      </ConfirmDialog>
    </div>
  );
}
