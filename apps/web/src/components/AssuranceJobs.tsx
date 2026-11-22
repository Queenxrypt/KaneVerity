// Kane Assurance jobs for one tutorial (Assurance B2): what ran, what it cost, and
// Kane's questions when a session pauses. Every command is allow-listed on the
// server and switched off unless the orchestrator enables it; anything that uses
// credits asks for an explicit confirmation here first.

import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Card, ConfirmDialog, ErrorNote, formatTime } from './ui.tsx';
import type { AssuranceStatus, JobAnswer, JobQuestion, JobState, PublicJob, RequirementsState } from '../types.ts';

const ACTIVE: JobState[] = ['queued', 'running'];

const STATE_STYLE: Record<JobState, { label: string; cls: string }> = {
  queued: { label: 'QUEUED', cls: 'border-brand/30 bg-brand-soft text-brand' },
  running: { label: 'RUNNING', cls: 'border-brand/30 bg-brand-soft text-brand' },
  complete: { label: 'COMPLETE', cls: 'border-pass/30 bg-pass-soft text-pass' },
  paused: { label: 'WAITING FOR YOU', cls: 'border-review/40 bg-review-soft text-review' },
  answered: { label: 'ANSWERED', cls: 'border-slate-300 bg-white text-slate-600' },
  refused: { label: 'REFUSED', cls: 'border-blocked/30 bg-blocked-soft text-blocked' },
  error: { label: 'ERROR', cls: 'border-fail/30 bg-fail-soft text-fail' },
  crashed: { label: 'OUTCOME UNKNOWN', cls: 'border-fail/30 bg-fail-soft text-fail' },
  interrupted: { label: 'INTERRUPTED', cls: 'border-blocked/30 bg-blocked-soft text-blocked' },
  cancelled: { label: 'CANCELLED', cls: 'border-slate-300 bg-white text-slate-600' },
  abandoned: { label: 'ABANDONED', cls: 'border-slate-300 bg-white text-slate-600' },
  expired: { label: 'EXPIRED', cls: 'border-slate-300 bg-white text-slate-600' },
};

function JobStateBadge({ state }: { state: JobState }) {
  const s = STATE_STYLE[state] ?? STATE_STYLE.error;
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold tracking-wide ${s.cls}`}>{s.label}</span>;
}

function JobCost({ job }: { job: PublicJob }) {
  if (!job.paid) return <span className="text-slate-500">no credits</span>;
  const c = job.credits;
  if (c.basis === 'reported') return <span>{c.amount} credits (reported by Kane)</span>;
  if (c.basis === 'measured') return <span>{c.amount} credits (measured from your balance)</span>;
  if (c.basis === 'unknown') return <span className="text-review">cost unknown (Kane reported none)</span>;
  return <span className="text-slate-500">cost not known yet</span>;
}

type Draft = Record<string, { choice: number | 'free' | null; text: string }>;

function toAnswers(questions: JobQuestion[], draft: Draft): Record<string, JobAnswer> | string {
  const out: Record<string, JobAnswer> = {};
  for (const q of questions) {
    const d = draft[q.id];
    if (!d || d.choice === null) return `Answer every question ("${q.text.slice(0, 60)}…").`;
    if (d.choice === 'free') {
      if (!d.text.trim()) return 'Type your answer, or choose an option.';
      out[q.id] = d.text.trim();
    } else if (q.options[d.choice - 1]?.input) {
      if (!d.text.trim()) return `The option "${q.options[d.choice - 1].label}" needs a value.`;
      out[q.id] = { option: d.choice, text: d.text.trim() };
    } else out[q.id] = d.choice;
  }
  return out;
}

function Questions({ job, disabled, onAnswer }: { job: PublicJob; disabled: boolean; onAnswer: (answers: Record<string, JobAnswer>) => void }) {
  const qs = job.pause?.questions ?? [];
  const [draft, setDraft] = useState<Draft>(() => Object.fromEntries(qs.map((q) => [q.id, { choice: null, text: '' }])));
  const [problem, setProblem] = useState<string | null>(null);
  const set = (id: string, v: Partial<Draft[string]>) => setDraft((d) => ({ ...d, [id]: { ...d[id], ...v } }));

  if (job.pause?.crashed) return <p className="text-sm text-slate-700">Kane paused this session after a crash. Resuming re-enters the conversation; there is nothing to answer first.</p>;
  if (job.pause?.held) return <p className="text-sm text-slate-700">Kane is holding {job.pause.held} item(s) for review. Reviewing held items arrives in a later phase.</p>;

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const a = toAnswers(qs, draft);
        if (typeof a === 'string') return setProblem(a);
        setProblem(null);
        onAnswer(a);
      }}
      aria-label="Kane's questions"
    >
      {qs.map((q, qi) => (
        <fieldset key={q.id} className="rounded-md border border-slate-200 p-3" data-testid={`question-${q.id}`}>
          <legend className="px-1 text-sm font-semibold">
            Question {qi + 1}
            {q.risk && <span className={`ml-2 rounded-full border px-1.5 py-0.5 text-xs font-semibold ${q.risk === 'high' ? 'border-fail/30 bg-fail-soft text-fail' : 'border-slate-300 text-slate-600'}`}>{q.risk} risk</span>}
          </legend>
          <p className="text-sm">{q.text}</p>
          {q.rationale && <p className="mt-1 text-xs text-slate-600">Why Kane asks: {q.rationale}</p>}
          <div className="mt-2 space-y-1.5">
            {q.options.map((o, i) => (
              <label key={i} className="flex cursor-pointer items-start gap-2 text-sm">
                <input type="radio" name={`q-${q.id}`} className="mt-1" checked={draft[q.id]?.choice === i + 1} onChange={() => set(q.id, { choice: i + 1 })} disabled={disabled} />
                <span>
                  <span className="font-medium">{o.label}</span>
                  {q.recommendedIndex === i && <span className="ml-2 rounded bg-brand-soft px-1.5 py-0.5 text-xs font-medium text-brand">Kane recommends</span>}
                  {o.detail && o.detail !== '...' && <span className="block text-xs text-slate-600">{o.detail}</span>}
                  {o.input && draft[q.id]?.choice === i + 1 && (
                    <input
                      type="text"
                      aria-label={`Value for ${o.label}`}
                      className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
                      maxLength={500}
                      value={draft[q.id]?.text ?? ''}
                      onChange={(e) => set(q.id, { text: e.target.value })}
                      disabled={disabled}
                    />
                  )}
                </span>
              </label>
            ))}
            {q.allowFreeText && (
              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <input type="radio" name={`q-${q.id}`} className="mt-1" checked={draft[q.id]?.choice === 'free'} onChange={() => set(q.id, { choice: 'free' })} disabled={disabled} />
                <span className="flex-1">
                  <span className="font-medium">Answer in my own words</span>
                  {draft[q.id]?.choice === 'free' && (
                    <input
                      type="text"
                      aria-label="Your answer"
                      className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
                      maxLength={500}
                      value={draft[q.id]?.text ?? ''}
                      onChange={(e) => set(q.id, { text: e.target.value })}
                      disabled={disabled}
                    />
                  )}
                </span>
              </label>
            )}
          </div>
        </fieldset>
      ))}
      {problem && (
        <p className="text-sm text-fail" role="alert">
          {problem}
        </p>
      )}
      <button type="submit" disabled={disabled} className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50" data-testid="answer-resume">
        Answer and resume…
      </button>
    </form>
  );
}

type Pending = null | { title: string; body: string; paid: boolean; run: () => Promise<unknown> };

export function AssuranceJobsPanel({ tutorialId, requirementsState, requirementsSha }: { tutorialId: string; requirementsState: RequirementsState; requirementsSha: string | null }) {
  const [status, setStatus] = useState<AssuranceStatus | null>(null);
  const [jobs, setJobs] = useState<PublicJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending>(null);

  const load = useCallback(async () => {
    try {
      const [s, j] = await Promise.all([api.assuranceStatus(), api.jobs(tutorialId)]);
      setStatus(s);
      setJobs(j);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [tutorialId]);
  useEffect(() => {
    void load();
  }, [load]);
  const anyActive = !!jobs?.some((j) => ACTIVE.includes(j.state));
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [anyActive, load]);

  async function act(p: NonNullable<Pending>) {
    setBusy(true);
    setError(null);
    try {
      await p.run();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  const enabled = (kind: string) => !!status?.kinds.find((k) => k.kind === kind)?.enabled;
  const landed = !!jobs?.some((j) => j.kind === 'ingest' && j.state === 'complete' && j.requirements?.reqSha256 === requirementsSha);
  const current = requirementsState === 'current';

  return (
    <Card title="Kane Assurance">
      <div data-testid="assurance-panel">
        {status?.mode === 'off' && (
          <p className="mb-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700" data-testid="assurance-off">
            Kane Assurance commands are <strong>switched off</strong>. They stay off until the validation runs are approved, so nothing here can start Kane or use credits.
          </p>
        )}
        {status?.mode === 'free' && <p className="mb-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">Only commands that use no credits are switched on.</p>}
        <p className="text-sm text-slate-700">
          Next, Kane Assurance reads these requirements: KaneVerity lands them in a local Assurance store, then Kane's agent proposes use cases with citations. Kane CLI is pinned to {status?.pinnedVersion ?? '0.10.5'}.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
            disabled={busy || anyActive || !enabled('ingest') || !current}
            onClick={() => setPending({ title: 'Land the requirements in the Assurance store?', body: 'Kane snapshots the current requirements into the local store under data/assurance/. This uses no credits.', paid: false, run: () => api.startJob({ kind: 'ingest', tutorialId }) })}
            data-testid="start-ingest"
          >
            Land requirements (free)
          </button>
          <button
            type="button"
            className="rounded-md bg-brand px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
            disabled={busy || anyActive || !enabled('extract') || !landed || !current}
            onClick={() =>
              setPending({
                title: 'Extract use cases with Kane? This uses credits.',
                body: "Kane's agent reads the landed requirements and proposes use cases, citing the lines it read. Kane publishes no fixed price for this; KaneVerity records the cost Kane reports, or measures it from your balance. Kane may pause with questions for you.",
                paid: true,
                run: () => api.startJob({ kind: 'extract', tutorialId, confirm: { paid: true } }),
              })
            }
            data-testid="start-extract"
          >
            Extract use cases…
          </button>
          {!current && <span className="text-xs text-review">Generate current requirements first.</span>}
          {current && enabled('extract') && !landed && <span className="text-xs text-slate-500">Land the current requirements first.</span>}
        </div>
        <div className="mt-3">
          <ErrorNote message={error} />
        </div>

        <h3 className="mb-1 mt-4 text-xs font-semibold uppercase text-slate-500">Jobs</h3>
        {jobs === null ? (
          <p className="text-sm text-slate-600">Loading jobs…</p>
        ) : jobs.length === 0 ? (
          <p className="text-sm text-slate-600" data-testid="no-jobs">
            No Kane Assurance job has run for this tutorial.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100" data-testid="job-list">
            {jobs.map((j) => (
              <li key={j.jobId} className="space-y-2 py-3" data-testid={`job-${j.jobId}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{j.label}</span>
                  <JobStateBadge state={j.state} />
                  {j.paid && <span className="rounded-full border border-slate-300 px-2 py-0.5 text-xs text-slate-600">uses credits</span>}
                  <span className="text-xs text-slate-500">{formatTime(j.createdAt)}</span>
                  <span className="text-xs text-slate-600">
                    <JobCost job={j} />
                  </span>
                </div>
                <p className="text-sm text-slate-700">{j.reason}</p>
                {j.summary.commits.length > 0 && (
                  <p className="text-xs text-slate-600">Saved by Kane: {j.summary.commits.flatMap((c) => c.minted).join(', ') || 'items'} (unreviewed until you review them).</p>
                )}
                {j.summary.warnings.length > 0 && <p className="text-xs text-review">Kane warnings: {j.summary.warnings.join(' · ')}</p>}
                {j.next.length > 0 && <p className="text-xs text-slate-500">Kane suggests next (not run automatically): {j.next.join(' · ')}</p>}
                {j.state === 'paused' && (
                  <div className="rounded-md border border-review/30 bg-review-soft/40 p-3">
                    <p className="mb-2 text-sm font-medium">Kane is waiting for your answer{(j.pause?.questions.length ?? 0) === 1 ? '' : 's'}. The session expires {j.pause?.expiresAt ? formatTime(j.pause.expiresAt) : 'after 24 hours'}.</p>
                    <Questions
                      job={j}
                      disabled={busy || !enabled('resume')}
                      onAnswer={(answers) =>
                        setPending({
                          title: 'Send your answers and resume? This uses credits.',
                          body: 'Kane resumes the same session with your answers. Kane may ask again.',
                          paid: true,
                          run: () => api.answerJob(j.jobId, answers),
                        })
                      }
                    />
                    <button type="button" className="mt-2 text-sm font-medium text-slate-600 hover:underline" disabled={busy} onClick={() => setPending({ title: 'Abandon this session?', body: "KaneVerity won't resume it. Kane keeps it until it expires.", paid: false, run: () => api.cancelJob(j.jobId) })}>
                      Abandon session
                    </button>
                  </div>
                )}
                {ACTIVE.includes(j.state) && (
                  <button type="button" className="text-sm font-medium text-slate-600 hover:underline" disabled={busy} onClick={() => setPending({ title: 'Stop this job?', body: 'Stopping a running Kane job leaves its outcome unknown.', paid: false, run: () => api.cancelJob(j.jobId) })}>
                    Stop
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <ConfirmDialog open={!!pending} title={pending?.title ?? ''} confirmLabel={pending?.paid ? 'Use credits and continue' : 'Continue'} busy={busy} onCancel={() => setPending(null)} onConfirm={() => pending && void act(pending)}>
        <p>{pending?.body}</p>
        {pending?.paid && <p className="font-medium">This is a paid Kane command. Continue only if you've approved it.</p>}
      </ConfirmDialog>
    </Card>
  );
}
