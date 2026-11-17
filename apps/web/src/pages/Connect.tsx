import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.ts';
import { Card, ErrorNote, ReadinessStrip } from '../components/ui.tsx';
import { useHealth } from '../health.tsx';

const DEMO_DOCS = 'http://127.0.0.1:5175/';
const DEMO_APP = 'http://127.0.0.1:5174/';

export function Connect() {
  const { health, refresh } = useHealth();
  const navigate = useNavigate();
  const [docsUrl, setDocsUrl] = useState(DEMO_DOCS);
  const [appUrl, setAppUrl] = useState(DEMO_APP);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Connect · KaneVerity';
  }, []);
  useEffect(() => {
    if (health?.project) {
      setDocsUrl(health.project.docsUrl);
      setAppUrl(health.project.appUrl);
    }
  }, [health?.project]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (!docsUrl.trim() || !appUrl.trim()) {
      setError('Enter both the documentation URL and the application URL.');
      return;
    }
    setBusy(true);
    try {
      await api.saveProject(docsUrl.trim(), appUrl.trim());
      await api.discover();
      await refresh();
      navigate('/tutorials');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-5">
      <h1 className="text-2xl font-bold">Connect project</h1>
      <div className="rounded-md border border-review/30 bg-review-soft px-4 py-3 text-sm text-review">
        <strong>MVP scope:</strong> live verification is limited to the controlled local AcmeDesk demo ({health?.liveVerificationScope.app.join(', ') ?? DEMO_APP}) and
        its documentation ({health?.liveVerificationScope.docs.join(', ') ?? DEMO_DOCS}). Arbitrary third-party documentation isn't supported for live runs yet.
      </div>
      <Card>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div>
            <label htmlFor="docs-url" className="block text-sm font-semibold">
              Documentation URL
            </label>
            <input id="docs-url" value={docsUrl} onChange={(e) => setDocsUrl(e.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm" autoComplete="off" />
          </div>
          <div>
            <label htmlFor="app-url" className="block text-sm font-semibold">
              Application URL
            </label>
            <input id="app-url" value={appUrl} onChange={(e) => setAppUrl(e.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm" autoComplete="off" />
          </div>
          <div>
            <span className="block text-sm font-semibold">Authentication / test session</span>
            <p className="mt-1 text-sm text-slate-600">None required: the AcmeDesk demo has no login and resets to the same seed data on every page load.</p>
          </div>
          <ErrorNote message={error} />
          <button type="submit" disabled={busy} className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">
            {busy ? 'Connecting and discovering…' : 'Save and discover tutorials'}
          </button>
        </form>
      </Card>
      <Card title="Readiness">
        <ReadinessStrip health={health} />
      </Card>
    </div>
  );
}
