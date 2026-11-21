import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.ts';
import { Card, ErrorNote, formatTime } from '../components/ui.tsx';
import type { CorrectionState, PublicCorrection } from '../types.ts';

export const STATE_LABEL: Record<CorrectionState, { label: string; cls: string }> = {
  analyzing: { label: 'Claude reviewing', cls: 'bg-brand-soft text-brand border-brand/30' },
  needs_exploration: { label: 'Needs Kane exploration', cls: 'bg-review-soft text-review border-review/30' },
  exploring: { label: 'Kane exploring', cls: 'bg-brand-soft text-brand border-brand/30' },
  route_confirmed: { label: 'Route confirmed', cls: 'bg-brand-soft text-brand border-brand/30' },
  route_uncertain: { label: 'Route uncertain', cls: 'bg-review-soft text-review border-review/30' },
  cannot_determine: { label: 'Cannot determine', cls: 'bg-review-soft text-review border-review/30' },
  proposal_rejected: { label: 'Proposal rejected by checks', cls: 'bg-review-soft text-review border-review/30' },
  proposed: { label: 'Awaiting your review', cls: 'bg-brand-soft text-brand border-brand/30' },
  rejected: { label: 'Rejected', cls: 'bg-blocked-soft text-blocked border-blocked/30' },
  applied: { label: 'Applied, retest not started', cls: 'bg-review-soft text-review border-review/30' },
  retesting: { label: 'Kane retesting', cls: 'bg-brand-soft text-brand border-brand/30' },
  verified: { label: 'VERIFIED', cls: 'bg-pass-soft text-pass border-pass/30' },
  not_verified: { label: 'Not verified (open)', cls: 'bg-fail-soft text-fail border-fail/30' },
  restored: { label: 'Original restored', cls: 'bg-blocked-soft text-blocked border-blocked/30' },
  error: { label: 'Error', cls: 'bg-fail-soft text-fail border-fail/30' },
};

export function CorrectionBadge({ state }: { state: CorrectionState }) {
  const s = STATE_LABEL[state];
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${s.cls}`}>{s.label}</span>;
}

export function Corrections() {
  const [list, setList] = useState<PublicCorrection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    document.title = 'Corrections · KaneVerity';
    api
      .corrections()
      .then(setList)
      .catch((e: Error) => setError(e.message));
  }, []);
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Corrections</h1>
      <p className="max-w-3xl text-sm text-slate-600">
        A confirmed documentation finding goes to Claude Code with sanitized Kane evidence. Claude may only propose a change once a Kane exploration has confirmed the route. You review the diff, and Kane retests
        the corrected tutorial independently. Only that retest can mark a correction VERIFIED.
      </p>
      <ErrorNote message={error} />
      <Card>
        {!list ? (
          <p className="text-sm text-slate-600">Loading…</p>
        ) : list.length === 0 ? (
          <p className="text-sm text-slate-600">
            No corrections yet. Open a FAILED run and choose <strong>Propose correction</strong>.
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-slate-500">
              <tr>
                <th className="py-2 pr-4">Tutorial</th>
                <th className="py-2 pr-4">State</th>
                <th className="py-2 pr-4">Updated</th>
                <th className="py-2">Correction</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id} className="border-t border-slate-100">
                  <td className="py-2 pr-4">{c.tutorialTitle}</td>
                  <td className="py-2 pr-4">
                    <CorrectionBadge state={c.state} />
                  </td>
                  <td className="py-2 pr-4 text-slate-600">{formatTime(c.updatedAt)}</td>
                  <td className="py-2">
                    <Link to={`/corrections/${c.id}`} className="font-mono text-xs text-brand hover:underline">
                      {c.id}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
