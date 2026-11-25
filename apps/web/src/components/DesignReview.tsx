// Test-design review (Assurance B5). Shows Kane's test design for an approved use
// case next to the documented steps and outcomes, every deterministic check, and
// what still blocks test execution. Decisions here are KaneVerity's own records:
// nothing is written to Kane, nothing is designed and no test is run. A decision
// counts only while what it was made on is unchanged (content ids, the generated
// test file, the requirements); otherwise it is shown as stale.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { Card, ErrorNote, formatTime } from './ui.tsx';
import type { DesignDecisionView, DesignExecutionView, DesignReviewResponse, DesignTestView, UseCasesResponse } from '../types.ts';

const short = (cid: string | null | undefined) => (cid ? cid.replace(/^sha256:/, '').slice(0, 12) : '—');

function Badge({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return <span className={`rounded border px-1.5 py-0.5 text-xs font-semibold ${ok ? 'border-pass/30 bg-pass-soft text-pass' : 'border-fail/30 bg-fail-soft text-fail'}`}>{ok ? yes : no}</span>;
}

function DecisionState({ d }: { d: DesignDecisionView | undefined }) {
  if (!d || d.state === 'none') return <span className="text-xs text-slate-600">Not reviewed</span>;
  const cls = d.stale ? 'text-fail' : d.state === 'rejected' ? 'text-fail' : 'text-pass';
  return (
    <span className={`text-xs font-semibold ${cls}`} data-testid="design-decision-state">
      {d.state.toUpperCase()}
      {d.stale ? ' — STALE (what you reviewed has changed; this no longer counts)' : ''}
      {d.at ? <span className="font-normal text-slate-600"> · {formatTime(d.at)}</span> : null}
    </span>
  );
}

function Decide({ d, disabled, onDecide, ack }: { d: DesignDecisionView | undefined; disabled: boolean; onDecide: (decision: 'approve' | 'reject' | 'acknowledge', reason: string, acknowledgeStale: boolean) => void; ack?: { stale: boolean } }) {
  const [reason, setReason] = useState('');
  const [staleOk, setStaleOk] = useState(false);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <DecisionState d={d} />
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={ack ? 'Reason (required)' : 'Reason (required to reject)'} className="min-w-48 flex-1 rounded border border-slate-300 px-2 py-1 text-xs" maxLength={1000} disabled={disabled} />
      {ack ? (
        <>
          {ack.stale && (
            <label className="flex items-center gap-1 text-xs text-fail">
              <input type="checkbox" checked={staleOk} onChange={(e) => setStaleOk(e.target.checked)} disabled={disabled} /> I understand it points at a superseded or unknown item
            </label>
          )}
          <button type="button" disabled={disabled || !reason.trim() || (ack.stale && !staleOk)} onClick={() => onDecide('acknowledge', reason, staleOk)} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium hover:bg-slate-50 disabled:opacity-50">
            Acknowledge
          </button>
        </>
      ) : (
        <>
          <button type="button" disabled={disabled} onClick={() => onDecide('approve', reason, false)} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium hover:bg-slate-50 disabled:opacity-50">
            Approve
          </button>
          <button type="button" disabled={disabled || !reason.trim()} onClick={() => onDecide('reject', reason, false)} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium hover:bg-slate-50 disabled:opacity-50">
            Reject
          </button>
        </>
      )}
    </div>
  );
}

function TestCard({ t, data, disabled, decide }: { t: DesignTestView; data: DesignReviewResponse; disabled: boolean; decide: (kind: string, target: string) => (decision: 'approve' | 'reject' | 'acknowledge', reason: string, ack: boolean) => void }) {
  const fid = data.evaluation?.fidelity.find((f) => f.testCid === t.cid);
  const review = (kind: string, target: string) => data.reviews?.find((r) => r.kind === kind && r.target === target);
  return (
    <div className="rounded-md border border-slate-200 p-3" data-testid="design-test">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs">{t.slug}</span>
        <span className="text-sm font-medium">{t.title}</span>
        {fid && <Badge ok={fid.ok} yes="FOLLOWS THE DOCS" no="DOES NOT FOLLOW THE DOCS" />}
      </div>
      <p className="mt-1 text-xs text-slate-600">
        Structured check (design metadata, not evidence): {t.check ? `${t.check.kind} ${t.check.operator ?? ''} "${t.check.operand ?? ''}" against ${t.check.verifiedAgainst ?? 'nothing'}` : 'none'}
      </p>
      <p className="text-xs text-slate-600">
        File: {t.file ? `${t.file.path} · sha256 ${t.file.sha256.slice(0, 12)} · ${t.file.bodyMatches && t.file.basePin === t.definitionId ? 'matches the test Kane stored' : 'DIFFERS from the test Kane stored'}` : 'not found'}
      </p>
      <ol className="mt-2 space-y-1 text-sm">
        {t.steps.map((s) => {
          const cls = fid?.steps.find((x) => x.n === s.n);
          return (
            <li key={s.n} className="rounded bg-slate-50 px-2 py-1">
              <span className="font-mono text-xs">Step {s.n}</span> {cls && <span className="ml-1 text-xs uppercase text-slate-600">[{cls.kind}{cls.asserts ? ', states an assertion' : ''}{cls.captures ? ', captures' : ''}]</span>}
              {s.tags.length > 0 && <span className="ml-1 font-mono text-xs text-review">@verifies {s.tags.join(', ')}</span>}
              <div className="text-slate-800">{s.text}</div>
            </li>
          );
        })}
      </ol>
      {fid && fid.problems.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-xs text-fail">
          {fid.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {fid?.extraSteps.map((e) => (
        <div key={e.n} className="mt-2 rounded border border-review/40 bg-review-soft p-2 text-xs">
          Step {e.n} is not part of the documented journey: “{e.text}”. Approve it only if it changes nothing in the application.
          <Decide d={review('extra_step', `${t.cid}#${e.n}`)} disabled={disabled} onDecide={decide('extra_step', `${t.cid}#${e.n}`)} />
        </div>
      ))}
      <div className="mt-2 text-xs font-medium">Your review of this test</div>
      <Decide d={review('test', t.cid)} disabled={disabled} onDecide={decide('test', t.cid)} />
    </div>
  );
}

type Phase = 'authoring' | 'verification';
type Gates = { ready: boolean; items: { id: string; label: string; ok: boolean; reason: string }[] };
type OutcomeView = DesignExecutionView['outcomes'][number];

function GateList({ gates, testId }: { gates: Gates; testId: string }) {
  return (
    <ul className="mt-1 space-y-0.5 text-sm" data-testid={testId}>
      {gates.items.map((i) => (
        <li key={i.id}>
          <span className={i.ok ? 'text-pass' : 'text-fail'}>{i.ok ? '✓' : '✗'}</span> {i.label}
          {!i.ok && i.reason && <span className="text-slate-600"> — {i.reason}</span>}
        </li>
      ))}
    </ul>
  );
}

/** Kane's recordings: what an AUTHORED run recorded. Each is reviewed before any verification run. */
function RecordingsSection({ data, disabled, decide, onRead }: { data: DesignReviewResponse; disabled: boolean; onRead: () => void; decide: (kind: string, target: string) => (decision: 'approve' | 'reject' | 'acknowledge', reason: string, ack: boolean) => void }) {
  const recs = data.recordings ?? [];
  return (
    <section data-testid="design-recordings">
      <h3 className="text-sm font-semibold">Recorded steps (review after the authoring run)</h3>
      <p className="text-xs text-slate-600">
        The authoring run makes Kane record each approved test. Read what Kane recorded (its Result.md) and approve each recording. The approval is bound to this exact recording and test file: if either changes, it no longer counts.
      </p>
      {data.execution?.phase === 'authoring' && data.execution.verdict === 'AUTHORED' && !!data.design && data.design.retrievedAt < data.execution.at && (
        <div className="mt-1 flex flex-wrap items-center gap-2 rounded-md border border-review/40 bg-review-soft p-2 text-xs" data-testid="design-recordings-outdated">
          The latest authoring run finished after this design read, so the recordings below are not up to date.
          <button type="button" disabled={disabled} onClick={onRead} className="rounded-md border border-slate-300 bg-white px-2 py-1 font-medium hover:bg-slate-50 disabled:opacity-50">
            Read the design again (free)
          </button>
        </div>
      )}
      {recs.length === 0 && <p className="text-xs text-slate-700">No tests in this design.</p>}
      {recs.map((r) => {
        const d: DesignDecisionView | undefined = r.state === 'none' ? undefined : { kind: 'recording', target: r.testCid, label: r.slug ?? r.testCid, required: 'approved', state: r.state, stale: r.stale, at: r.at, reason: null };
        return (
          <div key={r.testCid} className="mt-2 rounded-md border border-slate-200 p-2 text-xs" data-testid="design-recording">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono font-semibold">{r.slug ?? short(r.testCid)}</span>
              {!r.exists ? (
                <span className="text-slate-600">No recording yet: run the authoring phase first.</span>
              ) : (
                <span className="font-mono text-slate-600">
                  {r.dir} · {r.files} files · sha256 {r.sha256?.slice(0, 12)}
                </span>
              )}
              {r.staging && <span className="text-fail">An unfinished recording (staging folder) is present.</span>}
              <Badge ok={r.ok} yes="OK" no="NOT READY" />
            </div>
            {!r.ok && r.reason && <p className="mt-1 text-slate-700">{r.reason}</p>}
            {r.exists &&
              (r.resultMd ? (
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 font-mono text-[11px]">{r.resultMd}</pre>
              ) : (
                <p className="mt-1 text-fail">Kane's Result.md is missing, so this recording cannot be reviewed.</p>
              ))}
            {r.exists && <Decide d={d} disabled={disabled || !r.resultMd} onDecide={decide('recording', r.testCid)} />}
          </div>
        );
      })}
    </section>
  );
}

/** The outcome's problems without repeating its own label ("O1 is not established…" under "O1"). */
function problemsText(o: OutcomeView) {
  return o.problems.map((p) => (p.startsWith(`${o.outcome} `) ? `it ${p.slice(o.outcome.length + 1)}` : p)).join(' ');
}

function evidenceText(o: OutcomeView) {
  const e = o.evidence;
  if (!e) return problemsText(o);
  const base = `assertion ${e.assertionId ?? '?'} on step ${e.stepOrdinal}: expected "${e.expected}", observed "${e.observed}", read from the page at ${e.locator ?? '?'}`;
  const b = e.baseline ? `; the same list read ${e.baseline.before.length} key(s) before the action (step ${e.baseline.beforeStep}) and ${e.baseline.after.length} after it (step ${e.baseline.afterStep}): every earlier key kept, added ${e.baseline.added.map((k) => `"${k}"`).join(', ')}` : '';
  return base + b + (o.problems.length ? ` — ${problemsText(o)}` : '');
}

/** The paid runs (mode "all", explicit confirmation): authoring records the tests; verification is a pure replay. */
function ExecutionSection({ data, busy, onRun, onReconcile }: { data: DesignReviewResponse; busy: boolean; onRun: (phase: Phase) => void; onReconcile: (executionId: string) => void }) {
  const [confirming, setConfirming] = useState<Phase | null>(null);
  const x = data.execution;
  const authorReady = !!data.readiness?.ready;
  const verifyReady = !!data.verificationReadiness?.ready;
  const n = data.design?.tests.length ?? 0;
  const text: Record<Phase, string> = {
    authoring: `The authoring run runs the ${n} approved tests in a browser so Kane records them. It uses Kane credits. Its result is AUTHORED at best, never VERIFIED: you review the recordings next.`,
    verification: `The verification run replays the ${n} approved recordings in a browser, with no re-recording. It uses Kane credits. It is VERIFIED only if Kane replayed every step and the evidence reads each documented outcome from the page.`,
  };
  return (
    <section data-testid="design-execution">
      <h3 className="text-sm font-semibold">Test runs</h3>
      {data.mode !== 'all' ? (
        <p className="text-xs text-slate-600">Running the tests uses Kane credits, so it needs Assurance mode "all" (KANEVERITY_ASSURANCE_MODE, then restart the orchestrator).</p>
      ) : confirming ? (
        <div className="mt-1 rounded-md border border-review/40 bg-review-soft p-2 text-xs" data-testid="design-execute-confirm">
          {text[confirming]} Every gate is checked again just before Kane starts. A run that ends without a known result is never re-run automatically.
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const ph = confirming;
                setConfirming(null);
                onRun(ph);
              }}
              className="rounded-md bg-slate-900 px-3 py-1.5 font-semibold text-white disabled:opacity-50"
            >
              Start the {confirming} run (uses credits)
            </button>
            <button type="button" onClick={() => setConfirming(null)} className="rounded-md border border-slate-300 bg-white px-3 py-1.5">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-1 flex flex-wrap gap-2">
          <button type="button" disabled={busy || !authorReady} onClick={() => setConfirming('authoring')} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50" data-testid="design-execute-authoring" title={authorReady ? '' : 'The authoring gates must pass first.'}>
            1. Authoring run…
          </button>
          <button type="button" disabled={busy || !verifyReady} onClick={() => setConfirming('verification')} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50" data-testid="design-execute-verification" title={verifyReady ? '' : 'The verification gates must pass first.'}>
            2. Verification run…
          </button>
        </div>
      )}
      {x && (
        <div className="mt-2 rounded-md border border-slate-200 p-2 text-xs" data-testid="design-execution-result">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold uppercase">{x.phase}</span>
            <span className="font-mono">{x.executionId}</span>
            <span className="uppercase text-slate-600">{x.state}</span>
            {x.verdict === 'AUTHORED' ? (
              <span className="rounded border border-slate-400 bg-slate-100 px-1.5 py-0.5 text-xs font-semibold text-slate-800" data-testid="design-verdict-authored">
                AUTHORED · RECORDING ONLY · NOT VERIFIED
              </span>
            ) : x.verdict ? (
              <Badge ok={x.verdict === 'VERIFIED'} yes="VERIFIED" no="NOT VERIFIED" />
            ) : null}
            {x.runKind && <span className="text-slate-600">Kane run kind: {x.runKind}</span>}
            <span className="text-slate-600">{formatTime(x.at)}</span>
          </div>
          {x.state === 'started' && x.kaneRunning && (
            <p className="mt-1 font-medium text-slate-700" role="status" data-testid="design-run-active">
              Kane is running the {x.phase} run. This status refreshes automatically every few seconds.
            </p>
          )}
          {x.state === 'started' && !x.kaneRunning && !x.canReconcile && (
            <p className="mt-1 font-medium text-slate-700" role="status" data-testid="design-run-checking">
              Kane has finished. KaneVerity is checking what the run left and its evidence…
            </p>
          )}
          <p className="mt-1 text-slate-700">{x.reason}</p>
          {x.mutation.length > 0 && <p className="mt-1 text-fail">Changed during the run: {x.mutation.join(' ')}</p>}
          {x.problems.length > 0 && <p className="mt-1 text-fail">{x.problems.join(' ')}</p>}
          {x.packProblems.length > 0 && <p className="mt-1 text-fail">Evidence pack: {x.packProblems.join(' ')}</p>}
          {x.outcomes.length > 0 &&
            (x.phase === 'authoring' ? (
              // An authoring run never verifies: what it saw per outcome is shown neutrally, as recording status.
              <div className="mt-1" data-testid="design-authoring-outcomes">
                <p className="text-slate-600">What Kane saw per outcome while recording. This is not verification: only a later verification run (a pure replay) can verify an outcome.</p>
                <ul className="mt-1 space-y-1 text-slate-700">
                  {x.outcomes.map((o) => (
                    <li key={o.outcome}>
                      <span className="text-slate-500">{o.evidence ? '●' : '○'}</span> <span className="font-mono">{o.outcome}</span> {o.evidence ? 'recorded' : 'not recorded'}: {evidenceText(o)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <ul className="mt-1 space-y-1" data-testid="design-verification-outcomes">
                {x.outcomes.map((o) => (
                  <li key={o.outcome}>
                    <span className={o.verified ? 'text-pass' : 'text-fail'}>{o.verified ? '✓' : '✗'}</span> <span className="font-mono">{o.outcome}</span> {o.verified ? 'verified:' : 'not verified:'} {evidenceText(o)}
                  </li>
                ))}
              </ul>
            ))}
          {x.canReconcile && !x.kaneRunning && (
            <button type="button" disabled={busy} onClick={() => onReconcile(x.executionId)} className="mt-2 rounded-md border border-fail/40 bg-white px-2 py-1 font-medium text-fail hover:bg-fail-soft disabled:opacity-50">
              Reconcile (check what it left; never re-runs)
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function DesignReviewCard({ tutorialId, ucCid, ucSlug }: { tutorialId: string; ucCid: string; ucSlug: string }) {
  const [data, setData] = useState<DesignReviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async (retry = false) => {
    setLoading(true);
    try {
      setData(await api.designReview(tutorialId, ucCid));
      if (retry) setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [tutorialId, ucCid]);
  useEffect(() => {
    void load();
  }, [load]);

  // While a run is in progress, refresh its status every 2 s; stop once it reaches a terminal
  // state. When an authoring run has just finished AUTHORED, read the design again (free,
  // read-only) so the new recordings are shown for review.
  const runState = data?.execution?.state ?? null;
  const runId = data?.execution?.executionId ?? null;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useEffect(() => {
    if (runState !== 'started' || !runId) return;
    let stopped = false;
    const timer = setInterval(async () => {
      if (stopped || busyRef.current) return;
      try {
        const next = await api.designReview(tutorialId, ucCid);
        if (stopped) return;
        const x = next.execution;
        if (x && x.executionId === runId && x.state !== 'started' && x.phase === 'authoring' && x.verdict === 'AUTHORED') {
          stopped = true;
          clearInterval(timer);
          setData(next);
          setBusy(true);
          try {
            setData(await api.retrieveDesign(tutorialId, ucCid));
            setNotice('The authoring run finished AUTHORED. The design was read again (free, read-only) to show the new recordings: review each one below.');
          } catch (e) {
            setError(`The authoring run finished, but reading the design again failed: ${(e as Error).message} Use "Read the test design" to try again.`);
          } finally {
            setBusy(false);
          }
          return;
        }
        setData(next);
      } catch {
        /* a failed refresh is retried on the next tick */
      }
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [runState, runId, tutorialId, ucCid]);

  async function act(fn: () => Promise<DesignReviewResponse>, message: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setData(await fn());
      setNotice(message);
    } catch (e) {
      setError((e as Error).message);
      void load();
    } finally {
      setBusy(false);
    }
  }
  const decide = (kind: string, target: string) => (decision: 'approve' | 'reject' | 'acknowledge', reason: string, acknowledgeStale: boolean) =>
    act(() => api.reviewDesignItem(tutorialId, ucCid, { kind, target, decision, ...(reason.trim() ? { reason: reason.trim() } : {}), ...(acknowledgeStale ? { acknowledgeStale } : {}) }), 'Decision recorded in KaneVerity (nothing was written to Kane).');
  const review = (kind: string, target: string) => data?.reviews?.find((r) => r.kind === kind && r.target === target);
  const d = data?.design;
  const ev = data?.evaluation;
  const disabled = busy || !data?.canReview;
  const slugOf = (cid: string | null) => (cid && d ? [...d.acs, ...d.scenarios, ...d.tests].find((x) => x.cid === cid)?.slug ?? short(cid) : '—');

  return (
    <div className="space-y-4" data-testid="design-review">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => act(() => api.retrieveDesign(tutorialId, ucCid), 'Design read from the Assurance store (free, read-only).')} disabled={busy || loading || (!!data && data.mode !== 'free' && data.mode !== 'all')} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50" data-testid="design-retrieve">
          Read the test design for {ucSlug} (free, read-only)
        </button>
        {d && (
          <span className="text-xs text-slate-600">
            Design read {d.snapshot}, {formatTime(d.retrievedAt)} · store records {d.store.records} · requirements v{d.requirements?.version ?? '?'}
          </span>
        )}
      </div>
      {notice && (
        <p className="text-sm text-pass" role="status">
          {notice}
        </p>
      )}
      <ErrorNote message={error} />
      {loading && !data && (
        <p className="text-sm text-slate-600" role="status" data-testid="design-loading">
          Loading the test design review…
        </p>
      )}
      {!loading && !data && error && (
        <button type="button" onClick={() => void load(true)} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50" data-testid="design-reload">
          Try loading again
        </button>
      )}
      {data && !d && <p className="text-sm text-slate-700">No design read yet. Reading runs only Kane's free, read-only store commands.</p>}
      {d && ev && data.readiness && (
        <>
          {!d.integrity.ok && (
            <div className="rounded border border-fail/40 bg-fail-soft p-2 text-sm text-fail" data-testid="design-integrity">
              This design read failed its integrity checks, so nothing in it can be reviewed: {d.integrity.problems.join(' ')}
            </div>
          )}

          <section>
            <h3 className="text-sm font-semibold">Ready for the authoring run? {data.readiness.ready ? <Badge ok yes="READY" no="" /> : <Badge ok={false} yes="" no="NOT READY" />}</h3>
            <p className="text-xs text-slate-600">Run-time evidence is not a pre-execution gate: it is what the run produces. A run is VERIFIED only after its evidence shows an independent, passed assertion for every documented outcome.</p>
            <GateList gates={data.readiness} testId="design-readiness" />
          </section>

          <section>
            <h3 className="text-sm font-semibold">Documented outcomes and how each is covered</h3>
            <p className="text-xs text-slate-600">“Specified” is a property of the design. It is never evidence: a step's wording, an @verifies tag, a verifies link and the structured check do not prove that anything was asserted when a test runs.</p>
            <div className="mt-1 overflow-x-auto">
            <table className="w-full text-left text-xs" data-testid="design-outcomes">
              <thead>
                <tr className="text-slate-600">
                  <th className="py-1">Outcome</th>
                  <th>Criterion</th>
                  <th>Scenario</th>
                  <th>Test</th>
                  <th>Specified</th>
                  <th>After the run</th>
                </tr>
              </thead>
              <tbody>
                {ev.outcomes.map((o) => (
                  <tr key={o.outcome} className="align-top border-t border-slate-200">
                    <td className="py-1 pr-2">
                      <span className="font-mono">{o.outcome}</span> {o.outcomeText}
                    </td>
                    <td className="font-mono">{o.acSlug ?? '—'}</td>
                    <td className="font-mono">{slugOf(o.scenarioCid)}</td>
                    <td className="font-mono">{slugOf(o.testCid)}</td>
                    <td>
                      <Badge ok={o.specified} yes={`YES (step ${o.assertStep})`} no="NO" />
                      {o.problems.length > 0 && <div className="mt-1 text-fail">{o.problems.join(' ')}</div>}
                    </td>
                    <td className="text-slate-600">{(() => {
                      const e = data.execution?.outcomes.find((x) => x.outcome === o.outcome);
                      return e ? <Badge ok={e.verified} yes="ASSERTED" no="NOT SHOWN" /> : 'Not run yet';
                    })()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            {!ev.structure.ok && <p className="mt-1 text-xs text-fail">{ev.structure.problems.join(' ')}</p>}
          </section>

          <section>
            <h3 className="text-sm font-semibold">Outcome-to-criterion mapping</h3>
            <p className="text-xs text-slate-600">KaneVerity proposes which criterion stands for each documented outcome. Approve or reject each one; a decision goes stale if the match or the criterion changes.</p>
            {!ev.mapping.ok && <p className="text-xs text-fail">{ev.mapping.problems.join(' ')}</p>}
            {ev.mapping.entries.map((m) => {
              const doc = data.documented?.outcomes.find((o) => o.item === m.outcome);
              const ac = d.acs.find((a) => a.cid === m.acCid);
              return (
                <div key={m.outcome} className="mt-2 rounded-md border border-slate-200 p-2 text-xs" data-testid={`design-mapping-${m.outcome}`}>
                  <div>
                    <span className="font-mono">{m.outcome}</span> “{doc?.text ?? ''}” ({doc?.source ?? ''})
                  </div>
                  <div className="text-slate-700">→ {ac ? <><span className="font-mono">{ac.slug}</span> “{ac.text}”</> : <span className="text-fail">{m.problem ?? 'no criterion'}</span>}</div>
                  <Decide d={review('mapping', m.outcome)} disabled={disabled} onDecide={decide('mapping', m.outcome)} />
                </div>
              );
            })}
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Acceptance criteria</h3>
            {d.acs.map((a) => (
              <div key={a.cid} className="rounded-md border border-slate-200 p-2 text-sm">
                <span className="font-mono text-xs">{a.slug}</span> {a.text}
                <div className="text-xs text-slate-600">
                  Kane trust: {a.trust} · made in record {a.mintedSeq} (generation {a.generation ?? '?'}) · traced to the documentation through {ucSlug}
                </div>
                <Decide d={review('ac', a.cid)} disabled={disabled} onDecide={decide('ac', a.cid)} />
              </div>
            ))}
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Scenarios</h3>
            {d.scenarios.map((s) => (
              <div key={s.cid} className="rounded-md border border-slate-200 p-2 text-sm">
                <span className="font-mono text-xs">{s.slug}</span> {s.title}
                <div className="text-xs text-slate-600">Exercises: {s.exercises.map(slugOf).join(', ') || 'nothing'} · generation {s.generation ?? '?'}</div>
                <Decide d={review('scenario', s.cid)} disabled={disabled} onDecide={decide('scenario', s.cid)} />
              </div>
            ))}
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Tests</h3>
            {d.tests.map((t) => (
              <TestCard key={t.cid} t={t} data={data} disabled={disabled} decide={decide} />
            ))}
            {!ev.files.ok && <p className="text-xs text-fail">{ev.files.problems.join(' ')}</p>}
            {ev.files.notes.length > 0 && (
              <p className="text-xs text-slate-600" data-testid="design-superseded-files">
                Superseded test files kept on disk (never run): {ev.files.notes.join(' ')}
              </p>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Gaps</h3>
            {d.gaps.length === 0 && <p className="text-xs text-slate-600">None.</p>}
            {d.gaps.map((g) => {
              const stale = g.refState === 'superseded' || g.refState === 'unknown';
              return (
                <div key={g.cid} className={`rounded-md border p-2 text-sm ${stale ? 'border-fail/40 bg-fail-soft' : 'border-slate-200'}`} data-testid="design-gap">
                  <span className="font-mono text-xs">{g.slug}</span> {g.header}: {g.prompt}
                  <div className="text-xs text-slate-700">
                    Points at {g.ref ?? 'nothing'}
                    {stale ? ` — ${g.refState.toUpperCase()}: the item it refers to is no longer live. The gap is kept and still needs your acknowledgement.` : ''}
                  </div>
                  <Decide d={review('gap', g.cid)} disabled={disabled} onDecide={decide('gap', g.cid)} ack={{ stale }} />
                </div>
              );
            })}
          </section>

          {data.appUrl && (
            <section>
              <h3 className="text-sm font-semibold">Application URL (Kane variable app_url)</h3>
              <p className="text-xs text-slate-700">
                Proposed value: <span className="font-mono">{data.appUrl.proposed ?? 'no project connected'}</span> (the connected application). KaneVerity never writes Kane's variables file ({d.variables.path}). Once approved, it is set for the run in KaneVerity's own file, <span className="font-mono">.testmuai/variables/{data.appUrl.runFile}</span>, which Kane loads after its own (a later file wins).
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className={`text-xs font-semibold ${data.appUrl.state === 'approved' && !data.appUrl.stale ? 'text-pass' : 'text-slate-600'}`}>
                  {data.appUrl.state === 'approved' ? `APPROVED: ${data.appUrl.value}${data.appUrl.stale ? ' — STALE' : ''}` : 'Not approved'}
                </span>
                <button type="button" disabled={disabled || !data.appUrl.proposed || !data.appUrl.declaredByKane} onClick={() => act(() => api.approveAppUrl(tutorialId, ucCid, data.appUrl!.proposed!), 'app_url value approved in KaneVerity (no file was changed).')} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium hover:bg-slate-50 disabled:opacity-50" data-testid="design-approve-app-url">
                  Approve this value
                </button>
                <span className="text-xs text-slate-600">Run file: {data.appUrl.runFileValue ?? 'not written'}</span>
                <button type="button" disabled={disabled || data.appUrl.state !== 'approved' || data.appUrl.stale || data.appUrl.runFileValue === data.appUrl.value} onClick={() => act(() => api.writeRunVariables(tutorialId, ucCid), 'Run variables file written. Read the design again, then run the dry run.')} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium hover:bg-slate-50 disabled:opacity-50" data-testid="design-write-run-variables">
                  Set it for the run
                </button>
              </div>
            </section>
          )}

          {data.kaneApprovals && (
            <section>
              <h3 className="text-sm font-semibold">Approvals recorded in Kane</h3>
              <p className="text-xs text-slate-600">Each approved criterion, scenario and test is written to Kane's store (free) and verified there, against its exact content id. A rejection stays in KaneVerity.</p>
              <ul className="mt-1 space-y-1 text-xs" data-testid="design-kane-approvals">
                {data.kaneApprovals.map((k) => (
                  <li key={k.target} className="flex flex-wrap items-center gap-2">
                    <span className={k.ok ? 'text-pass' : 'text-fail'}>{k.ok ? '✓' : '✗'}</span>
                    <span>{k.label}</span>
                    <span className="text-slate-600">{k.ok ? `verified in Kane (record #${k.kaneSeq})` : k.reason}</span>
                    {!k.ok && (k.state === 'none' || k.state === 'not_written') && (
                      <button type="button" disabled={disabled} onClick={() => act(() => api.kaneWriteItem(tutorialId, ucCid, k.target), `Approval of ${k.label} written to Kane and checked.`)} className="rounded-md border border-slate-300 bg-white px-2 py-0.5 font-medium hover:bg-slate-50 disabled:opacity-50">
                        Write to Kane
                      </button>
                    )}
                    {k.state === 'unknown' && (
                      <button type="button" disabled={busy} onClick={() => act(() => api.reconcileKaneItem(tutorialId, ucCid, k.target), "Kane's store checked.")} className="rounded-md border border-fail/40 bg-white px-2 py-0.5 font-medium text-fail hover:bg-fail-soft disabled:opacity-50">
                        Check Kane's store
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {data.dryRun && (
            <section>
              <h3 className="text-sm font-semibold">Dry run (free)</h3>
              <p className="text-xs text-slate-600">Kane plans and checks these exact test files and their variables without running anything.</p>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                <span className={data.dryRun.ok ? 'text-pass' : 'text-slate-700'}>
                  {data.dryRun.latest ? `${data.dryRun.latest.state.toUpperCase()}${data.dryRun.current ? '' : ' — OUT OF DATE'}: ${data.dryRun.latest.reason}` : 'No dry run yet.'}
                </span>
                <button type="button" disabled={busy || !data.canReview} onClick={() => act(() => api.dryRunDesign(tutorialId, ucCid), 'Dry run finished. Nothing ran.')} className="rounded-md border border-slate-300 bg-white px-2 py-1 font-medium hover:bg-slate-50 disabled:opacity-50" data-testid="design-dry-run">
                  Run the dry run
                </button>
              </div>
            </section>
          )}

          <RecordingsSection data={data} disabled={busy || !data.canReview} decide={decide} onRead={() => act(() => api.retrieveDesign(tutorialId, ucCid), 'Design read again (free, read-only): the recordings are up to date.')} />

          {data.verificationReadiness && (
            <section>
              <h3 className="text-sm font-semibold">Ready for the verification run? {data.verificationReadiness.ready ? <Badge ok yes="READY" no="" /> : <Badge ok={false} yes="" no="NOT READY" />}</h3>
              <p className="text-xs text-slate-600">Every authoring gate, plus approved recordings unchanged since, and a passed dry run made after the recording approvals.</p>
              <GateList gates={data.verificationReadiness} testId="design-verification-readiness" />
            </section>
          )}

          <ExecutionSection data={data} busy={busy} onRun={(phase) => act(() => api.executeDesign(tutorialId, ucCid, phase), `${phase === 'authoring' ? 'Authoring' : 'Verification'} run started. The result is checked from Kane's evidence.`)} onReconcile={(id) => act(() => api.reconcileExecution(tutorialId, ucCid, id), 'Run reconciled from what it left. It was not run again.')} />

          <section>
            <h3 className="text-sm font-semibold">Design records</h3>
            <ul className="text-xs text-slate-700">
              {d.designRecords.map((r) => (
                <li key={r.seq} className="font-mono">
                  #{r.seq} {r.phase} · generation {r.generation}
                  {r.supersedesGeneration ? ` (supersedes ${r.supersedesGeneration})` : ''} · {r.completeness} · {short(r.hash)}
                </li>
              ))}
            </ul>
            {ev.generation.problems.length > 0 && <p className="text-xs text-fail">{ev.generation.problems.join(' ')}</p>}
            {ev.generation.notes.length > 0 && <p className="text-xs text-slate-600">{ev.generation.notes.join(' ')}</p>}
          </section>
        </>
      )}
    </div>
  );
}

export function DesignReviewPanel({ tutorialId }: { tutorialId: string }) {
  const [ucs, setUcs] = useState<UseCasesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.useCases(tutorialId).then(setUcs, (e) => setError((e as Error).message));
  }, [tutorialId]);
  const approved = (ucs?.useCases ?? []).filter((u) => u.review.state === 'approved');
  return (
    <Card title="Test design review">
      <div data-testid="design-review-panel" className="space-y-4">
        <p className="text-sm text-slate-700">
          Kane's test design for an approved use case, checked against the documented steps and outcomes. Each documented outcome needs its own criterion, scenario and test, with a step that asserts it. Your decisions are recorded in KaneVerity. An approval reaches Kane only when you write it (free), and the tests run only when you start a run (uses credits, mode "all"): authoring first, then verification.
        </p>
        <ErrorNote message={error} />
        {ucs && approved.length === 0 && <p className="text-sm text-slate-600">No use case is approved yet.</p>}
        {approved.map((u) => (
          <DesignReviewCard key={u.cid} tutorialId={tutorialId} ucCid={u.cid} ucSlug={u.logicalId} />
        ))}
      </div>
    </Card>
  );
}
