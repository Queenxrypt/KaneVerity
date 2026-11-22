import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api.ts';
import { Card, Collapsible, ConfirmDialog, CostSummary, ErrorNote, formatTime } from '../components/ui.tsx';
import { useHealth } from '../health.tsx';
import type { PublicCorrection } from '../types.ts';
import { CorrectionBadge } from './Corrections.tsx';

const ACTIVE = new Set(['analyzing', 'exploring', 'retesting']);

function Diff({ diff }: { diff: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-xs leading-relaxed" data-testid="diff">
      {diff.split('\n').map((l, i) => (
        <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'bg-pass-soft text-pass' : l.startsWith('-') && !l.startsWith('---') ? 'bg-fail-soft text-fail' : l.startsWith('@@') ? 'text-brand' : ''}>
          {l || ' '}
        </div>
      ))}
    </pre>
  );
}

type Pending = null | { action: 'analyze' | 'explore' | 'approve' | 'retest' | 'reject' | 'restore' | 'dismiss'; title: string; body: string; kane: false | 'exploration' | 'retest'; ack?: string };

export function CorrectionDetail() {
  const { id = '' } = useParams();
  const { health, refresh } = useHealth();
  const [c, setC] = useState<PublicCorrection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [acked, setAcked] = useState(false);
  const [exploreMode, setExploreMode] = useState('default');
  const modes = health?.explorationModes ?? [];
  const modeLabel = (id: string) => modes.find((m) => m.id === id)?.label ?? id;

  const load = useCallback(async () => {
    try {
      setC(await api.correction(id));
    } catch (e) {
      if ((e as ApiError).status === 404) setNotFound(true);
      else setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    document.title = `Correction · ${c?.tutorialTitle ?? ''} · KaneVerity`;
    if (!c || !ACTIVE.has(c.state)) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [c, load]);

  async function run(p: NonNullable<Pending>) {
    setBusy(true);
    setError(null);
    try {
      const body = p.action === 'explore' ? { mode: exploreMode } : p.action === 'restore' && p.ack ? { confirm: 'invalidate-verified' } : {};
      setC(await api.correctionAction(id, p.action, body));
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setPending(null);
      setAcked(false);
    }
  }

  if (notFound) return <Card title="Correction not found">The correction does not exist.</Card>;
  if (!c) return error ? <ErrorNote message={error} /> : <p className="text-sm text-slate-600">Loading…</p>;
  const last = c.attempts[c.attempts.length - 1];
  const s = c.state;

  return (
    <div className="space-y-5">
      <div>
        <Link to="/corrections" className="text-sm text-brand hover:underline">
          ← Corrections
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">{c.tutorialTitle}</h1>
          <CorrectionBadge state={s} />
        </div>
        <p className="mt-1 text-sm text-slate-600">
          Correction <span className="font-mono">{c.id}</span> · source <code className="font-mono">{c.file}</code>
          {c.failedStep != null && <> · finding at step {c.failedStep}</>}
        </p>
      </div>
      <ErrorNote message={error} />

      <Card title="Status">
        <p className="text-sm" data-testid="state-reason">
          {c.stateReason}
        </p>
        {ACTIVE.has(s) && <p className="mt-2 text-xs text-slate-500">Updating automatically…</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          {(s === 'needs_exploration' || s === 'route_uncertain' || s === 'route_confirmed' || s === 'proposal_rejected' || s === 'cannot_determine' || s === 'error') && (
            <button type="button" className="rounded-md bg-brand px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={busy} onClick={() => setPending({ action: 'explore', title: 'Run a Kane exploration?', body: 'Kane explores the application from the Dashboard to find how this documented task is done today, then checks every documented outcome. Exploration never counts as verification.', kane: 'exploration' })}>
              Run Kane exploration
            </button>
          )}
          {(s === 'route_confirmed' || s === 'proposal_rejected' || s === 'needs_exploration' || s === 'cannot_determine' || s === 'error') && (c.attempts.length > 0 || s === 'error') && (
            <button type="button" className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium disabled:opacity-50" disabled={busy} onClick={() => setPending({ action: 'analyze', title: 'Ask Claude again?', body: 'Claude reviews the finding again with any new exploration evidence. It reads only the sanitized package and cannot change anything.', kane: false })}>
              Ask Claude again
            </button>
          )}
          {s === 'proposed' && (
            <>
              <button type="button" className="rounded-md bg-brand px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={busy} onClick={() => setPending({ action: 'approve', title: 'Approve and apply?', body: 'KaneVerity writes the corrected tutorial (the original is kept). No Kane retest starts: you start it separately.', kane: false })}>
                Approve & apply
              </button>
              <button type="button" className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium disabled:opacity-50" disabled={busy} onClick={() => setPending({ action: 'reject', title: 'Reject this proposal?', body: 'Nothing is changed.', kane: false })}>
                Reject
              </button>
            </>
          )}
          {(s === 'applied' || s === 'not_verified') && !c.restoredAt && (
            <button
              type="button"
              className="rounded-md bg-brand px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
              disabled={busy}
              onClick={() =>
                setPending(
                  s === 'applied'
                    ? { action: 'retest', title: 'Start the Kane retest?', body: 'Kane retests the corrected tutorial independently from the live docs page. Only that retest can mark it VERIFIED.', kane: 'retest' }
                    : { action: 'retest', title: 'Retest again?', body: 'The last retest did not meet every VERIFIED requirement. Kane retests the same corrected tutorial again, independently, from the live docs page. Earlier retests stay in the history.', kane: 'retest' },
                )
              }
            >
              {s === 'applied' ? 'Start Kane retest' : 'Retest again'}
            </button>
          )}
          {s === 'error' && (
            <button
              type="button"
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium disabled:opacity-50"
              disabled={busy}
              onClick={() => setPending({ action: 'dismiss', title: 'Close this correction?', body: 'Closes the correction after the error. Nothing was written to the documentation, and its history is kept. A new correction can then be started from a FAILED run.', kane: false })}
            >
              Close correction
            </button>
          )}
          {c.appliedAt && !c.restoredAt && s !== 'retesting' && (
            <button
              type="button"
              className={`rounded-md border bg-white px-3 py-2 text-sm font-medium disabled:opacity-50 ${s === 'verified' ? 'border-fail/40 text-fail' : 'border-slate-300'}`}
              disabled={busy}
              onClick={() =>
                setPending(
                  s === 'verified'
                    ? {
                        action: 'restore',
                        title: 'Restore the original and invalidate VERIFIED?',
                        body: 'This correction is VERIFIED. Restoring puts the original, outdated tutorial back on the live docs site. The VERIFIED result then no longer applies, and the tutorial shows its original FAILED result again. The correction history and all evidence are kept.',
                        kane: false,
                        ack: 'I understand this invalidates the VERIFIED result.',
                      }
                    : { action: 'restore', title: 'Restore the original tutorial?', body: 'Puts the original document back (only if the file is exactly the applied correction).', kane: false },
                )
              }
            >
              Restore original
            </button>
          )}
        </div>
      </Card>

      <Card title="Timeline">
        <ol className="space-y-1 text-sm">
          <li>
            Original run:{' '}
            <Link to={`/runs/${c.runId}`} className="font-mono text-xs text-brand hover:underline">
              {c.runId}
            </Link>{' '}
            (FAILED, documentation defect)
          </li>
          {c.attempts.map((a, i) => (
            <li key={i}>
              Claude review {i + 1}: <strong>{a.decision ?? 'no answer'}</strong>
              {a.validation.problems.length > 0 && <span className="text-review"> · rejected by KaneVerity checks</span>}
              <span className="text-slate-500"> · {formatTime(a.at)}</span>
            </li>
          ))}
          {(c.explorations ?? []).map((e, i) => (
            <li key={e.runId} data-testid={`exploration-${i + 1}`}>
              Kane exploration {i + 1}{' '}
              <span className="text-slate-500">({modeLabel(e.mode)})</span>:{' '}
              <Link to={`/runs/${e.runId}`} className="font-mono text-xs text-brand hover:underline">
                {e.runId}
              </Link>
              {e.confirmed === null ? (
                <span className="text-slate-500"> · {e.runId === c.explorationRunId && s === 'exploring' ? 'running' : 'result pending'}</span>
              ) : (
                <strong className={e.confirmed ? 'text-pass' : 'text-review'}> · {e.confirmed ? 'route confirmed' : 'route not confirmed'}</strong>
              )}
              {e.runId === c.explorationRunId && <span className="text-slate-500"> · used for the next Claude review</span>}
            </li>
          ))}
          {c.approvedAt && <li>Approved and applied · {formatTime(c.approvedAt)}</li>}
          {c.retestRunId && (
            <li>
              Kane retest:{' '}
              <Link to={`/runs/${c.retestRunId}`} className="font-mono text-xs text-brand hover:underline">
                {c.retestRunId}
              </Link>
            </li>
          )}
          {c.verification && <li className={c.verification.verified ? 'font-semibold text-pass' : 'font-semibold text-fail'}>{c.verification.verified ? 'VERIFIED by Kane retest' : 'Not verified: the issue stays open'}</li>}
          {c.restoredAt && (
            <li className="font-semibold text-slate-700" data-testid="restored-note">
              Original restored · {formatTime(c.restoredAt)}
              {c.verification?.verified ? ' (the VERIFIED result no longer applies)' : ''}
            </li>
          )}
          {c.restoredAt && <li>Original restored · {formatTime(c.restoredAt)}</li>}
        </ol>
      </Card>

      {last && (
        <Card title="Claude's latest review">
          <dl className="grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-slate-500">Decision</dt>
            <dd>
              <strong>{last.decision ?? 'none'}</strong>
              {last.confidence && <span className="text-slate-500"> · confidence {last.confidence}</span>}
            </dd>
            {last.rationale && (
              <>
                <dt className="text-slate-500">Rationale</dt>
                <dd className="whitespace-pre-wrap">{last.rationale}</dd>
              </>
            )}
            {last.explorationQuestion && (
              <>
                <dt className="text-slate-500">Claude asks</dt>
                <dd className="italic">{last.explorationQuestion}</dd>
              </>
            )}
            {last.evidenceCited.length > 0 && (
              <>
                <dt className="text-slate-500">Evidence cited</dt>
                <dd>
                  <ul className="list-disc pl-5">
                    {last.evidenceCited.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
            {last.validation.problems.length > 0 && (
              <>
                <dt className="text-slate-500">KaneVerity checks</dt>
                <dd className="text-review">
                  <ul className="list-disc pl-5">
                    {last.validation.problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
            {last.error && (
              <>
                <dt className="text-slate-500">Error</dt>
                <dd className="text-fail">{last.error}</dd>
              </>
            )}
            <dt className="text-slate-500">Claude run</dt>
            <dd className="text-slate-600">
              {last.model ?? 'model unknown'}
              {last.costUsd != null && ` · $${last.costUsd.toFixed(4)}`}
            </dd>
          </dl>
          <p className="mt-3 text-xs text-slate-500">Claude's answer is advisory. KaneVerity validates every edit, and only a Kane retest can mark the correction VERIFIED.</p>
        </Card>
      )}

      {c.proposal && (
        <Card title="Proposed change">
          <Diff diff={c.proposal.diff} />
          <h3 className="mt-4 text-sm font-semibold">Evidence for each new UI label</h3>
          <table className="mt-2 w-full text-left text-xs">
            <thead className="uppercase text-slate-500">
              <tr>
                <th className="py-1 pr-3">Label</th>
                <th className="py-1 pr-3">Kane evidence</th>
                <th className="py-1">Source</th>
              </tr>
            </thead>
            <tbody>
              {c.proposal.citations.map((ct, i) => (
                <tr key={i} className="border-t border-slate-100 align-top">
                  <td className="py-1 pr-3 font-semibold">{ct.label}</td>
                  <td className="py-1 pr-3">{ct.evidence}</td>
                  <td className="py-1">
                    <Link to={`/runs/${ct.runId}`} className="text-brand hover:underline">
                      {ct.kind === 'action' ? `exploration step ${ct.ordinal}` : 'exploration assertion'}
                    </Link>
                    {ct.screenshot && (
                      <a href={`/api/runs/${encodeURIComponent(ct.runId)}/screens/${encodeURIComponent(ct.screenshot)}`} target="_blank" rel="noopener noreferrer" className="ml-2 text-brand hover:underline">
                        screenshot
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {c.verification && (
        <Card title={c.verification.verified ? (c.restoredAt ? 'Retest: VERIFIED (no longer current: original restored)' : 'Retest: VERIFIED') : 'Retest: not verified'}>
          <ul className="space-y-1 text-sm" data-testid="verification-checks">
            {c.verification.checks.map((ch) => (
              <li key={ch.name} className="flex gap-2">
                <span className={ch.ok ? 'font-bold text-pass' : 'font-bold text-fail'} aria-hidden="true">
                  {ch.ok ? '✓' : '✕'}
                </span>
                <span>
                  <strong>{ch.name}</strong>
                  <span className="text-slate-600"> · {ch.detail}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-slate-500">External navigation is detected from the evidence after the run. It is not prevented during the run.</p>
        </Card>
      )}

      <Collapsible title="Event log">
        <ul className="space-y-1 font-mono text-xs">
          {c.log.map((l, i) => (
            <li key={i}>
              {formatTime(l.at)} · {l.event} {l.detail && `· ${l.detail}`}
            </li>
          ))}
        </ul>
      </Collapsible>

      <ConfirmDialog
        open={!!pending}
        title={pending?.title ?? ''}
        confirmLabel="Confirm"
        busy={busy}
        confirmDisabled={!!pending?.ack && !acked}
        onCancel={() => {
          setPending(null);
          setAcked(false);
        }}
        onConfirm={() => pending && (!pending.ack || acked) && void run(pending)}
      >
        <p>{pending?.body}</p>
        {pending?.ack && (
          <label className="flex items-start gap-2 rounded-md border border-fail/30 bg-fail-soft p-3 text-sm" data-testid="restore-ack">
            <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} className="mt-0.5" />
            <span>{pending.ack}</span>
          </label>
        )}
        {pending?.action === 'explore' && (
          <fieldset className="rounded-md border border-slate-200 p-3" data-testid="exploration-mode">
            <legend className="px-1 text-xs font-semibold uppercase text-slate-500">Exploration mode</legend>
            {modes.map((m) => (
              <label key={m.id} className="flex cursor-pointer items-start gap-2 py-1">
                <input type="radio" name="exploration-mode" value={m.id} checked={exploreMode === m.id} onChange={() => setExploreMode(m.id)} className="mt-1" />
                <span>
                  <span className="font-medium">{m.label}</span>
                  <span className="block text-xs text-slate-600">{m.rule ? <>Adds this fixed KaneVerity rule: <em>{m.rule.replace(/^- /, '')}</em></> : 'No extra rule: the standard exploration template.'}</span>
                </span>
              </label>
            ))}
            <p className="mt-1 text-xs text-slate-500">Modes are fixed by KaneVerity and never name application labels. The mode is recorded with the run and shown to Claude.</p>
          </fieldset>
        )}
        {pending?.kane && (
          <>
            <p>
              This starts a real Kane run. Estimated cost for this {pending.kane} run: about <strong data-testid="estimate">{(health?.credits.estimatedByKind[pending.kane] ?? (pending.kane === 'exploration' ? [20, 40] : [12, 35])).join('-')} credits</strong>. This is an estimate; the actual cost Kane reports is recorded for the run.
            </p>
            <CostSummary health={health} />
          </>
        )}
        {pending?.action === 'analyze' && <p>This makes a real Claude Code call (capped at $1).</p>}
      </ConfirmDialog>
    </div>
  );
}
