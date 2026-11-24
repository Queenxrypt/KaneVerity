// Use-case review (Assurance B3, B4). Shows what Kane extracted from the requirements,
// every citation checked against the requirements and traced to the
// documentation, which documented steps and outcomes are NOT cited, and Kane's own
// records (for information only). Approval and rejection happen only here, as
// explicit user actions. B4: an approval is then written to Kane's store and
// verified there; only the latest approval, verified in Kane, can go to test design.
// The reviewer name is self-declared (KANEVERITY_REVIEWER), never authenticated.

import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Card, ErrorNote, formatTime } from './ui.tsx';
import type { AssuranceStatus, CheckedCitation, ItemCoverage, KaneApprovalView, KaneWriteGroup, ReviewState, UseCasesResponse, UseCaseView } from '../types.ts';

type DecisionBody = { decision: 'approve' | 'reject'; reason?: string; acknowledgeGaps?: boolean };

const REVIEW_STYLE: Record<ReviewState, { label: string; cls: string }> = {
  awaiting_review: { label: 'AWAITING YOUR REVIEW', cls: 'border-review/40 bg-review-soft text-review' },
  approved: { label: 'APPROVED BY YOU', cls: 'border-pass/30 bg-pass-soft text-pass' },
  rejected: { label: 'REJECTED BY YOU', cls: 'border-fail/30 bg-fail-soft text-fail' },
};

const KANE_STYLE: Record<KaneApprovalView['state'], { label: string; cls: string }> = {
  none: { label: 'NOT IN KANE', cls: 'border-slate-300 bg-white text-slate-600' },
  pending: { label: 'WRITING TO KANE', cls: 'border-review/40 bg-review-soft text-review' },
  verified: { label: 'VERIFIED IN KANE', cls: 'border-pass/30 bg-pass-soft text-pass' },
  not_written: { label: 'NOT WRITTEN', cls: 'border-slate-300 bg-white text-slate-700' },
  unknown: { label: 'OUTCOME UNKNOWN', cls: 'border-fail/40 bg-fail-soft text-fail' },
  written_unverified: { label: 'IN KANE, NOT VERIFIED', cls: 'border-fail/40 bg-fail-soft text-fail' },
};

const VIA_TEXT: Record<string, string> = { write: 'written', reconcile: 'checked in the store', reuse: 'relies on an earlier verified record', startup: 'orchestrator restarted' };

const STEP_TEXT: Record<KaneWriteGroup['steps'][number]['step'], string> = {
  started: 'started',
  kane_running: 'Kane running',
  verified: 'verified',
  not_written: 'not written',
  unknown: 'outcome unknown',
  written_unverified: 'in Kane, not verified',
};

/** One line per write: its steps in order (every logged step is shown, none twice as a separate write). */
function WriteTrail({ w }: { w: KaneWriteGroup }) {
  return (
    <li className="text-slate-600" data-testid="kane-write-history">
      Kane write <span className="font-mono text-xs">{w.writeId}</span>:{' '}
      {w.steps.map((s, i) => (
        <span key={i} data-testid="kane-write-step">
          {i > 0 && ' → '}
          {STEP_TEXT[s.step]}
          {s.via !== 'write' ? ` (${VIA_TEXT[s.via]})` : ''} {formatTime(s.at)}
        </span>
      ))}
      {w.kaneSeq !== null && (
        <span>
          {' '}
          · record #{w.kaneSeq} {shortHash(w.kaneHash)}
        </span>
      )}
    </li>
  );
}

const PROBLEM_TEXT: Record<string, string> = {
  bad_anchor: 'unreadable anchor',
  out_of_range: 'anchor outside the requirements',
  quote_mismatch: 'quote not found in the cited lines',
  wrong_source: 'cites another source',
  empty_quote: 'empty quote',
};

const shortHash = (h: string | null) => (h ? `${h.slice(0, 19)}…` : '');

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

/** B4: the latest decision as recorded and verified in Kane's store. */
function KaneApproval({ uc, onWrite, onReconcile, busy }: { uc: UseCaseView; onWrite: () => void; onReconcile: () => void; busy: boolean }) {
  const k = uc.kane;
  // An older orchestrator (before B4) sends no Kane approval data: show nothing rather than fail.
  if (!k) return null;
  if (uc.review.state === 'awaiting_review' && k.state === 'none' && !k.externalApproval) return null;
  const st = KANE_STYLE[k.state];
  return (
    <div className="mt-3 rounded-md border border-slate-200 p-3 text-sm" data-testid="kane-approval">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase text-slate-500">Approval in Kane</span>
        <Badge cls={st.cls} testid="kane-write-state">{st.label}</Badge>
        {k.via && k.via !== 'write' && <span className="text-xs text-slate-500">({VIA_TEXT[k.via]})</span>}
      </div>
      {k.state === 'verified' && k.kaneSeq !== null && (
        <div className="mt-1" data-testid="kane-record">
          <p>
            Kane record <strong>#{k.kaneSeq}</strong>, hash <code className="break-all font-mono text-xs">{k.kaneHash}</code>
          </p>
          {k.kaneBy && <p className="text-xs text-slate-600">Kane recorded it as "{k.kaneBy}". Neither this nor the reviewer name proves who approved.</p>}
        </div>
      )}
      {k.reason && (
        <p className="mt-1 text-slate-700" data-testid="kane-reason">
          {k.reason}
        </p>
      )}
      {k.state === 'unknown' && <p className="mt-1 font-medium text-fail">Decisions and writes for this tutorial are locked until you check Kane's store. KaneVerity never retries this write by itself.</p>}
      {k.externalApproval && (
        <p className="mt-1 font-medium text-fail" data-testid="external-approval">
          Kane holds an approval for this use case that was not made and verified through KaneVerity. It is not accepted.
        </p>
      )}
      {k.trustedButRejected && (
        <p className="mt-1 text-review" data-testid="trusted-but-rejected">
          You rejected this use case. Kane still lists it as trusted: KaneVerity never archives use cases in Kane, and your rejection keeps it out of test design.
        </p>
      )}
      {(k.canWrite || k.canReconcile) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {k.canWrite && (
            <button type="button" onClick={onWrite} disabled={busy} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50" data-testid="kane-write">
              Record approval in Kane (free)
            </button>
          )}
          {k.canReconcile && (
            <button type="button" onClick={onReconcile} disabled={busy} className="rounded-md border border-fail/40 bg-white px-3 py-1.5 text-sm font-semibold text-fail hover:bg-fail-soft disabled:opacity-50" data-testid="kane-reconcile">
              Check Kane's store
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** V2: start test design for an approved, Kane-verified use case (paid; explicit confirmation). */
function TestDesign({ uc, mode, onDesign, busy }: { uc: UseCaseView; mode: string; onDesign: (acknowledge: string | null) => void; busy: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const t = uc.testDesign;
  if (!t || uc.review.state !== 'approved') return null;
  return (
    <div className="mt-3 rounded-md border border-slate-200 p-3 text-sm" data-testid="test-design">
      <p className="text-xs font-semibold uppercase text-slate-500">Test design (Kane, uses credits)</p>
      {t.latestJob && (
        <p className="mt-1 text-slate-700" data-testid="design-latest">
          Latest attempt: job <span className="font-mono text-xs">{t.latestJob.jobId}</span>, {t.latestJob.state}. {t.latestJob.reason} Follow it, and answer any questions from Kane, under Kane Assurance jobs above.
        </p>
      )}
      {t.blockedBy && <p className="mt-1 text-slate-700">{t.blockedBy}</p>}
      {!uc.design.eligible && <p className="mt-1 text-slate-700">Not eligible for test design (see the reasons above).</p>}
      {uc.design.eligible && mode !== 'all' && <p className="mt-1 text-slate-700">Test design uses Kane credits, so it needs Assurance mode "all" (KANEVERITY_ASSURANCE_MODE, then restart the orchestrator).</p>}
      {t.needsAcknowledgement && <p className="mt-1 text-review">The previous attempt (job {t.needsAcknowledgement}) ended without a known result; Kane may hold part of a design. Starting again records that you checked it.</p>}
      {t.canStart && !confirming && (
        <button type="button" disabled={busy} onClick={() => setConfirming(true)} className="mt-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50" data-testid="design-start">
          Design tests for {uc.logicalId}…
        </button>
      )}
      {confirming && (
        <div className="mt-2 rounded-md border border-review/40 bg-review-soft p-2" data-testid="design-confirm">
          <p>This uses Kane credits. There is no reliable estimate yet: design has not been run on this project before. KaneVerity reads the store again and starts only if this exact use case is still approved and verified in Kane. One scenario and its test are designed. Kane's questions are never answered automatically; answering them is a separate paid step.</p>
          <div className="mt-2 flex gap-2">
            <button type="button" disabled={busy} onClick={() => { setConfirming(false); onDesign(t.needsAcknowledgement); }} className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50" data-testid="design-confirm-start">
              Start design (uses credits)
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ReviewForm({ uc, onDecide, busy, locked, reviewerOk }: { uc: UseCaseView; onDecide: (body: DecisionBody) => void; busy: boolean; locked: boolean; reviewerOk: boolean }) {
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
        <button type="button" disabled={busy || locked || !reviewerOk || (gaps && !ack)} onClick={() => onDecide({ decision: 'approve', reason: reason.trim() || undefined, acknowledgeGaps: gaps ? ack : undefined })} className="rounded-md bg-pass px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50" data-testid="approve">
          Approve use case
        </button>
        <button type="button" disabled={busy || locked || !reason.trim()} onClick={() => onDecide({ decision: 'reject', reason: reason.trim() })} className="rounded-md border border-fail/40 bg-white px-3 py-1.5 text-sm font-semibold text-fail hover:bg-fail-soft disabled:opacity-50" data-testid="reject">
          Reject use case
        </button>
      </div>
      {locked && <p className="text-xs text-fail">Decisions are locked while an approval write to Kane is in progress or has an unknown outcome.</p>}
      {!reviewerOk && <p className="text-xs text-slate-600">Approving needs KANEVERITY_REVIEWER (see above). Rejecting does not.</p>}
      <p className="text-xs text-slate-500">Approving records your decision in KaneVerity, then writes it to Kane's store with a free command and verifies it there. A rejection stays in KaneVerity only.</p>
    </div>
  );
}

function UseCaseCard(props: { uc: UseCaseView; onDecide: (cid: string, body: DecisionBody) => void; onWrite: (cid: string) => void; onReconcile: (cid: string) => void; onDesign: (cid: string, acknowledge: string | null) => void; mode: string; busy: boolean; locked: boolean; reviewerOk: boolean }) {
  const { uc, onDecide, onWrite, onReconcile, onDesign, mode, busy, locked, reviewerOk } = props;
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
      <div className="mt-1 text-sm" data-testid="design-eligibility">
        {uc.design.eligible ? (
          <p className="font-medium text-pass">Ready for test design.</p>
        ) : (
          <>
            <p className="text-slate-700">Not ready for test design:</p>
            <ul className="list-disc pl-5 text-slate-700" data-testid="design-reasons">
              {uc.design.reasons.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </>
        )}
      </div>
      <KaneApproval uc={uc} onWrite={() => onWrite(uc.cid)} onReconcile={() => onReconcile(uc.cid)} busy={busy} />
      <TestDesign uc={uc} mode={mode} onDesign={(ack) => onDesign(uc.cid, ack)} busy={busy} />

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
            {h.reviewer ? ` by ${h.reviewer} (self-declared)` : ''}
            {h.reason ? ` — ${h.reason}` : ''}
            {h.acknowledgedGaps ? ' (citation gaps acknowledged)' : ''}
          </li>
        ))}
        {(uc.kaneWrites ?? []).map((w) => (
          <WriteTrail key={w.writeId} w={w} />
        ))}
        {uc.review.history.length === 0 && <li className="text-slate-600">No KaneVerity review decision yet.</li>}
      </ul>

      <div className="mt-4">
        <ReviewForm key={`${uc.cid}-${uc.review.history.length}`} uc={uc} onDecide={(body) => onDecide(uc.cid, body)} busy={busy} locked={locked} reviewerOk={reviewerOk} />
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

  async function act(fn: () => Promise<UseCasesResponse>, message: (d: UseCasesResponse) => string | null) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const d = await fn();
      setData(d);
      setNotice(message(d));
    } catch (e) {
      setError((e as Error).message);
      void load();
    } finally {
      setBusy(false);
    }
  }

  const retrieve = () => act(() => api.retrieveUseCases(tutorialId), () => 'Use cases read from the Assurance store (free, read-only).');
  const decide = (cid: string, body: DecisionBody) => act(() => api.reviewUseCase(tutorialId, cid, body), (d) => `${body.decision === 'approve' ? 'Approval' : 'Rejection'} recorded in KaneVerity.${d.note ? ` ${d.note}` : ''}`);
  const write = (cid: string) => act(() => api.kaneWrite(tutorialId, cid), (d) => d.note);
  const reconcile = (cid: string) => act(() => api.reconcileKaneWrite(tutorialId, cid), (d) => d.note);
  const designStart = (cid: string, acknowledge: string | null) =>
    act(
      async () => {
        const job = await api.designUseCase(tutorialId, cid, { confirm: { paid: true }, max: 1, ...(acknowledge ? { acknowledgePrevious: acknowledge } : {}) });
        setNotice(null);
        const d = await api.useCases(tutorialId);
        return { ...d, note: `Test design started (job ${job.jobId}). Follow it, and answer any questions from Kane, under Kane Assurance jobs above.` };
      },
      (d) => d.note,
    );

  const canRead = status?.mode === 'free' || status?.mode === 'all';
  const snap = data?.snapshot;
  return (
    <Card title="Use cases from Kane Assurance">
      <div data-testid="usecase-panel">
        <p className="text-sm text-slate-700">
          Kane proposes use cases from the requirements. Each one is checked here against the requirements Kane read, traced to the documentation, and shown with what is <strong>not</strong> cited. Only your decision below approves or rejects a use case; Kane's own trust state and records never count. An approval goes to test design only once it is recorded in Kane and verified there.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="button" onClick={retrieve} disabled={busy || !canRead} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50" data-testid="retrieve-usecases">
            {busy ? 'Working…' : 'Read use cases from Kane (free)'}
          </button>
          {!canRead && <span className="text-xs text-slate-500">Reading the store needs Assurance mode "free". The last retrieval is shown below.</span>}
        </div>
        {data?.reviewer && (
          <p className="mt-2 text-sm" data-testid="reviewer">
            {data.reviewer.label ? (
              <>
                Reviewer: <strong>{data.reviewer.label}</strong> <span className="text-slate-500">(self-declared in KANEVERITY_REVIEWER, not authenticated; passed to Kane as "kaneverity:{data.reviewer.label}")</span>
              </>
            ) : (
              <span className="text-review">{data.reviewer.problem}</span>
            )}
          </p>
        )}
        {data?.locked && (
          <p className="mt-2 rounded-md border border-fail/40 bg-fail-soft p-2 text-sm text-fail" data-testid="locked">
            {data.locked.state === 'pending' ? 'An approval is being written to Kane.' : "An approval write to Kane has an unknown outcome. Use \"Check Kane's store\" on the use case."} Decisions and writes for this tutorial are locked until then.
          </p>
        )}
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
                  <UseCaseCard key={uc.cid} uc={uc} onDecide={decide} onWrite={write} onReconcile={reconcile} onDesign={designStart} mode={data.mode ?? 'off'} busy={busy} locked={!!data.locked} reviewerOk={!!data.reviewer?.label} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
