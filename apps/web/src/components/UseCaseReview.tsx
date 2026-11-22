// Use-case review (Assurance B3). Shows what Kane extracted from the requirements,
// every citation checked against the requirements and traced to the
// documentation, which documented steps and outcomes are NOT cited, and Kane's own
// records (for information only). Approval and rejection happen only here, as
// explicit user actions, and only an approved use case can go to test design.

import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Card, ErrorNote, formatTime } from './ui.tsx';
import type { AssuranceStatus, CheckedCitation, ItemCoverage, ReviewState, UseCasesResponse, UseCaseView } from '../types.ts';

const REVIEW_STYLE: Record<ReviewState, { label: string; cls: string }> = {
  awaiting_review: { label: 'AWAITING YOUR REVIEW', cls: 'border-review/40 bg-review-soft text-review' },
  approved: { label: 'APPROVED BY YOU', cls: 'border-pass/30 bg-pass-soft text-pass' },
  rejected: { label: 'REJECTED BY YOU', cls: 'border-fail/30 bg-fail-soft text-fail' },
};

const PROBLEM_TEXT: Record<string, string> = {
  bad_anchor: 'unreadable anchor',
  out_of_range: 'anchor outside the requirements',
  quote_mismatch: 'quote not found in the cited lines',
  wrong_source: 'cites another source',
  empty_quote: 'empty quote',
};

function Badge({ children, cls, testid }: { children: string; cls: string; testid?: string }) {
  return (
    <span data-testid={testid} className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold tracking-wide ${cls}`}>
      {children}
    </span>
  );
}

function CoverageTable({ coverage }: { coverage: ItemCoverage[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm" data-testid="coverage-table">
        <thead className="text-xs uppercase text-slate-500">
          <tr>
            <th className="py-1.5 pr-3">Item</th>
            <th className="py-1.5 pr-3">Documentation</th>
            <th className="py-1.5 pr-3">Citation</th>
            <th className="py-1.5">Exact labels named</th>
          </tr>
        </thead>
        <tbody>
          {coverage.map((c) => (
            <tr key={c.item} className="border-t border-slate-100" data-testid={`coverage-${c.item}`}>
              <td className="py-1.5 pr-3 font-mono text-xs">
                {c.item} <span className="font-sans text-slate-500">{c.kind}</span>
              </td>
              <td className="py-1.5 pr-3 font-mono text-xs">{c.docRef}</td>
              <td className="py-1.5 pr-3">
                {c.citedBy > 0 ? <span className="text-pass">cited ({c.citedBy})</span> : <span className="font-semibold text-fail">NOT CITED</span>}
              </td>
              <td className="py-1.5">{c.labelsNamed ? <span className="text-slate-700">yes</span> : <span className="text-review">missing: {c.missingLabels.join(', ')}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CitationsTable({ citations }: { citations: CheckedCitation[] }) {
  if (citations.length === 0) return <p className="text-sm font-semibold text-fail">Kane recorded no citations for this use case.</p>;
  return (
    <ol className="space-y-2" data-testid="citations">
      {citations.map((c, i) => (
        <li key={i} className={`rounded-md border p-2 text-sm ${c.ok ? 'border-slate-200' : 'border-fail/40 bg-fail-soft/40'}`} data-testid={`citation-${i + 1}`}>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-mono font-semibold">C{i + 1}</span>
            <span className="font-mono">{c.anchor || '(no anchor)'}</span>
            {c.ok ? <Badge cls="border-pass/30 bg-pass-soft text-pass">VALID</Badge> : <Badge cls="border-fail/30 bg-fail-soft text-fail">INVALID</Badge>}
            {!c.ok && <span className="text-fail">{c.problems.map((p) => PROBLEM_TEXT[p] ?? p).join(', ')}</span>}
            {c.ok && c.items.length > 0 && (
              <span className="text-slate-600">
                evidences {c.items.join(', ')} → <span className="font-mono">{c.docRefs.join(', ')}</span>
              </span>
            )}
            {c.framingOnly && <span className="text-review">cites KaneVerity's framing text only (no documentation line)</span>}
          </div>
          <blockquote className="mt-1 border-l-2 border-slate-200 pl-2 text-slate-700">{c.quote || '(empty)'}</blockquote>
          {c.claim && <p className="mt-1 text-xs text-slate-600">Supports: {c.claim}</p>}
        </li>
      ))}
    </ol>
  );
}

function ReviewForm({ uc, onDecide, busy }: { uc: UseCaseView; onDecide: (body: { decision: 'approve' | 'reject'; reason?: string; acknowledgeGaps?: boolean }) => void; busy: boolean }) {
  const [reason, setReason] = useState('');
  const [ack, setAck] = useState(false);
  const gaps = uc.citationReport.summary.hasGaps;
  return (
    <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3" data-testid="review-form">
      <label className="block text-sm font-medium" htmlFor={`reason-${uc.cid}`}>
        Reason <span className="font-normal text-slate-500">(required to reject; optional note when approving)</span>
      </label>
      <textarea id={`reason-${uc.cid}`} rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm" disabled={busy} />
      {gaps && (
        <label className="flex items-start gap-2 text-sm text-review" data-testid="ack-gaps">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-1" disabled={busy} />
          <span>I have checked the citation gaps above (uncited or invalid items). Approving records this acknowledgement; uncited items stay marked as not cited.</span>
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy || (gaps && !ack)} onClick={() => onDecide({ decision: 'approve', reason: reason.trim() || undefined, acknowledgeGaps: gaps ? ack : undefined })} className="rounded-md bg-pass px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50" data-testid="approve">
          Approve use case
        </button>
        <button type="button" disabled={busy || !reason.trim()} onClick={() => onDecide({ decision: 'reject', reason: reason.trim() })} className="rounded-md border border-fail/40 bg-white px-3 py-1.5 text-sm font-semibold text-fail hover:bg-fail-soft disabled:opacity-50" data-testid="reject">
          Reject use case
        </button>
      </div>
    </div>
  );
}

function UseCaseCard({ uc, onDecide, busy }: { uc: UseCaseView; onDecide: (cid: string, body: { decision: 'approve' | 'reject'; reason?: string; acknowledgeGaps?: boolean }) => void; busy: boolean }) {
  const s = uc.citationReport.summary;
  const r = REVIEW_STYLE[uc.review.state];
  return (
    <article className="rounded-lg border border-slate-200 p-4" data-testid={`usecase-${uc.logicalId}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold">{uc.title}</h3>
        <span className="font-mono text-xs text-slate-500">{uc.logicalId}</span>
        <Badge cls={r.cls} testid="review-state">{r.label}</Badge>
        <Badge cls="border-slate-300 bg-white text-slate-600" testid="kane-trust">{`Kane: ${uc.kaneTrust}`}</Badge>
        {uc.risk && <Badge cls={uc.risk === 'high' ? 'border-fail/30 bg-fail-soft text-fail' : 'border-slate-300 bg-white text-slate-600'}>{`${uc.risk} risk`}</Badge>}
      </div>
      <p className="mt-1 text-sm" data-testid="design-eligibility">
        {uc.design.eligible ? <span className="font-medium text-pass">Ready for test design.</span> : <span className="text-slate-700">Not ready for test design: {uc.design.reasons.join(' ')}</span>}
      </p>

      <dl className="mt-3 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[8rem_1fr]">
        <dt className="text-slate-500">Description</dt>
        <dd>{uc.description}</dd>
        {uc.summary && (
          <>
            <dt className="text-slate-500">Summary</dt>
            <dd>{uc.summary}</dd>
          </>
        )}
        {uc.value && (
          <>
            <dt className="text-slate-500">Value</dt>
            <dd>{uc.value}</dd>
          </>
        )}
        <dt className="text-slate-500">Actors</dt>
        <dd>{uc.actors.join(', ') || '—'}</dd>
      </dl>

      <h4 className="mb-1 mt-4 text-xs font-semibold uppercase text-slate-500">Criteria (hints for test design, not test checks)</h4>
      <ol className="list-decimal space-y-1 pl-5 text-sm" data-testid="criteria">
        {uc.criteria.map((c, i) => (
          <li key={i}>
            {c.text}{' '}
            {c.citations.length ? <span className="font-mono text-xs text-slate-500">[{c.citations.map((n) => `C${n + 1}`).join(', ')}]</span> : <span className="text-xs font-semibold text-fail">[no citation]</span>}
          </li>
        ))}
      </ol>

      <h4 className="mb-1 mt-4 text-xs font-semibold uppercase text-slate-500">Documented steps and outcomes</h4>
      <p className="mb-1 text-sm" data-testid="citation-summary">
        {s.stepsCited}/{s.steps} steps and {s.outcomesCited}/{s.outcomes} outcomes cited · {s.valid}/{s.total} citations valid
        {s.hasGaps && <span className="ml-2 font-semibold text-fail">Citation gaps: not verified by citation.</span>}
      </p>
      <CoverageTable coverage={uc.citationReport.coverage} />

      <h4 className="mb-1 mt-4 text-xs font-semibold uppercase text-slate-500">Citations, checked against the requirements</h4>
      <CitationsTable citations={uc.citationReport.citations} />

      <h4 className="mb-1 mt-4 text-xs font-semibold uppercase text-slate-500">History</h4>
      <ul className="space-y-1 text-sm" data-testid="history">
        <li>Extracted by Kane in store record {uc.mintedSeq}{uc.proposalId ? ` (proposal ${uc.proposalId})` : ''}.</li>
        {uc.kaneVerdicts.map((v, i) => (
          <li key={i} className="text-slate-600" data-testid="kane-verdict">
            Kane recorded “{v.resolution}” itself (attributed to {v.attributedTo}). This is Kane's own record, not a KaneVerity review, and never counts as approval.
          </li>
        ))}
        {uc.review.history.map((h, i) => (
          <li key={`k${i}`} data-testid="kaneverity-decision">
            {formatTime(h.at)}: <strong>{h.decision === 'approved' ? 'Approved' : 'Rejected'} in KaneVerity</strong>
            {h.reason ? ` — ${h.reason}` : ''}
            {h.acknowledgedGaps ? ' (citation gaps acknowledged)' : ''}
          </li>
        ))}
        {uc.review.history.length === 0 && <li className="text-slate-600">No KaneVerity review decision yet.</li>}
      </ul>

      <div className="mt-4">
        <ReviewForm key={`${uc.cid}-${uc.review.history.length}`} uc={uc} onDecide={(body) => onDecide(uc.cid, body)} busy={busy} />
      </div>
    </article>
  );
}

export function UseCaseReviewPanel({ tutorialId }: { tutorialId: string }) {
  const [data, setData] = useState<UseCasesResponse | null>(null);
  const [status, setStatus] = useState<AssuranceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([api.useCases(tutorialId), api.assuranceStatus()]);
      setData(d);
      setStatus(s);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [tutorialId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function retrieve() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setData(await api.retrieveUseCases(tutorialId));
      setNotice('Use cases read from the Assurance store (free, read-only).');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function decide(cid: string, body: { decision: 'approve' | 'reject'; reason?: string; acknowledgeGaps?: boolean }) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setData(await api.reviewUseCase(tutorialId, cid, body));
      setNotice(body.decision === 'approve' ? 'Approval recorded in KaneVerity.' : 'Rejection recorded in KaneVerity.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const canRead = status?.mode === 'free' || status?.mode === 'all';
  const snap = data?.snapshot;
  return (
    <Card title="Use cases from Kane Assurance">
      <div data-testid="usecase-panel">
        <p className="text-sm text-slate-700">
          Kane proposes use cases from the requirements. Each one is checked here against the requirements Kane read, traced to the documentation, and shown with what is <strong>not</strong> cited. Only your decision below approves or rejects a use case; Kane's own trust state and records never count.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="button" onClick={retrieve} disabled={busy || !canRead} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50" data-testid="retrieve-usecases">
            {busy ? 'Working…' : 'Read use cases from Kane (free)'}
          </button>
          {!canRead && <span className="text-xs text-slate-500">Reading the store needs Assurance mode "free". The last retrieval is shown below.</span>}
        </div>
        {notice && (
          <p className="mt-2 text-sm text-pass" role="status">
            {notice}
          </p>
        )}
        <div className="mt-2">
          <ErrorNote message={error} />
        </div>

        {data === null ? (
          <p className="mt-3 text-sm text-slate-600">Loading use cases…</p>
        ) : !snap ? (
          <p className="mt-3 text-sm text-slate-600" data-testid="no-usecases">
            No use cases have been read from the Assurance store yet.
          </p>
        ) : (
          <>
            <div className={`mt-3 rounded-md border p-3 text-sm ${snap.integrity.ok ? 'border-slate-200' : 'border-fail/40 bg-fail-soft'}`} data-testid="retrieval-status">
              <p>
                Retrieval {snap.snapshot}, {formatTime(snap.retrievedAt)}, Kane CLI {snap.cliVersion}:{' '}
                {snap.integrity.ok ? <strong className="text-pass">integrity checks passed</strong> : <strong className="text-fail">integrity checks FAILED: nothing here can be approved</strong>}
                {' · '}store check {snap.fsck.ok ? 'ok' : 'failed'} ({snap.store.records} records)
                {' · '}requirements {snap.requirements ? `version ${snap.requirements.version}` : 'not matched'}
                {snap.requirements && !snap.requirementsCurrent && <span className="font-semibold text-review"> (no longer current)</span>}
              </p>
              {!snap.integrity.ok && (
                <ul className="mt-1 list-disc pl-5 text-fail">
                  {snap.integrity.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
            </div>
            {data.useCases.length === 0 ? (
              <p className="mt-3 text-sm text-slate-600">Kane has not extracted any use case for this tutorial.</p>
            ) : (
              <div className="mt-3 space-y-3">
                {data.useCases.map((uc) => (
                  <UseCaseCard key={uc.cid} uc={uc} onDecide={decide} busy={busy} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
