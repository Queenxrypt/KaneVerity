// Verification material for one tutorial (Assurance B1): the requirements document
// KaneVerity generates for Kane Assurance, shown before Kane ever uses it, with its
// source references, fingerprints, versions and current/stale state.
// Generating is local and free: no Kane command runs.

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, ORCHESTRATOR_DOWN } from '../api.ts';
import { Card, ErrorNote, formatTime } from '../components/ui.tsx';
import { AssuranceJobsPanel } from '../components/AssuranceJobs.tsx';
import { useHealth } from '../health.tsx';
import { lineDiff } from '../../../orchestrator/src/assurance/lineDiff.ts';
import type { LineMapEntry, RequirementsDetail, RequirementsState } from '../types.ts';

const STATE_STYLE: Record<RequirementsState, { label: string; cls: string }> = {
  current: { label: 'CURRENT', cls: 'border-pass/30 bg-pass-soft text-pass' },
  stale: { label: 'STALE', cls: 'border-review/40 bg-review-soft text-review' },
  none: { label: 'NOT GENERATED', cls: 'border-slate-300 bg-white text-slate-600' },
};

export function RequirementsBadge({ state }: { state: RequirementsState }) {
  const s = STATE_STYLE[state];
  return (
    <span data-testid="requirements-state" className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold tracking-wide ${s.cls}`}>
      {s.label}
    </span>
  );
}

const short = (sha: string) => sha.slice(0, 12);

function safeDocsLink(url: string, docsOrigin: string | undefined): string | null {
  try {
    return docsOrigin && new URL(url).origin === docsOrigin ? url : null;
  } catch {
    return null;
  }
}

function Fingerprint({ label, sha }: { label: string; sha: string }) {
  return (
    <>
      <dt className="text-slate-500">{label}</dt>
      <dd>
        <code className="break-all font-mono text-xs text-slate-700" title={sha}>
          {short(sha)}…
        </code>
      </dd>
    </>
  );
}

/** The requirement items (steps and outcomes) with labels and traceable source references. */
function ItemList({ entries, markdown, docsLink, kind }: { entries: LineMapEntry[]; markdown: string; docsLink: string | null; kind: 'step' | 'outcome' }) {
  const lines = markdown.split('\n');
  const rows = entries.filter((e) => e.kind === kind);
  return (
    <ol className="divide-y divide-slate-100" aria-label={kind === 'step' ? 'Documented steps' : 'Expected outcomes'}>
      {rows.map((e) => {
        const text = (lines[e.reqLine - 1] ?? '').replace(/^[SO]\d+\. /, '');
        const src = e.source;
        return (
          <li key={e.item} className="grid gap-2 py-3 sm:grid-cols-[3rem_1fr]" data-testid={`req-item-${e.item}`}>
            <span className="font-mono text-xs font-semibold text-slate-500">{e.item}</span>
            <div className="min-w-0 space-y-1.5">
              <p className="text-sm">{text}</p>
              {e.labels.length > 0 && (
                <div className="flex flex-wrap gap-1.5" aria-label="Exact labels and values">
                  {e.labels.map((l, i) => (
                    <span key={`${l}-${i}`} className="rounded border border-brand/20 bg-brand-soft px-1.5 py-0.5 font-mono text-xs text-brand">
                      {l}
                    </span>
                  ))}
                </div>
              )}
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                <span>Source</span>
                {docsLink ? (
                  <a href={docsLink} target="_blank" rel="noopener noreferrer" className="font-mono text-brand hover:underline" data-testid="source-link">
                    {src.kind === 'markdown' ? `${src.file}:${src.line}` : `list ${src.list}, item ${src.item}`}
                  </a>
                ) : (
                  <code className="font-mono">{src.kind === 'markdown' ? `${src.file}:${src.line}` : `${src.url} list ${src.list}, item ${src.item}`}</code>
                )}
                <span className="text-slate-400">·</span>
                <span>requirements line {e.reqLine}</span>
              </p>
              <blockquote className="border-l-2 border-slate-200 pl-2 text-xs text-slate-600">{src.kind === 'markdown' ? src.text : src.quote}</blockquote>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function MarkdownView({ markdown, mapped }: { markdown: string; mapped: Set<number> }) {
  const lines = markdown.replace(/\n$/, '').split('\n');
  return (
    <pre className="max-h-[32rem] overflow-auto rounded-md border border-slate-200 bg-slate-50 py-2 font-mono text-xs leading-relaxed" aria-label="Requirements document" data-testid="requirements-markdown" tabIndex={0}>
      {lines.map((l, i) => (
        <div key={i} className={`grid grid-cols-[3rem_1fr] ${mapped.has(i + 1) ? 'bg-brand-soft/60' : ''}`}>
          <span className="select-none pr-3 text-right text-slate-400">{i + 1}</span>
          <span className="whitespace-pre-wrap break-words pr-3">{l || ' '}</span>
        </div>
      ))}
    </pre>
  );
}

function DiffView({ before, after }: { before: string; after: string }) {
  const diff = lineDiff(before.replace(/\n$/, ''), after.replace(/\n$/, ''));
  const changed = diff.filter((d) => d.kind !== 'same').length;
  return (
    <>
      <p className="mb-2 text-sm text-slate-600">{changed} line{changed === 1 ? '' : 's'} would change.</p>
      <pre className="max-h-[28rem] overflow-auto rounded-md border border-slate-200 bg-slate-50 py-2 font-mono text-xs leading-relaxed" data-testid="requirements-diff" tabIndex={0} aria-label="Changes from the current version">
        {diff.map((d, i) => (
          <div key={i} className={`grid grid-cols-[1.5rem_1fr] ${d.kind === 'add' ? 'bg-pass-soft text-pass' : d.kind === 'del' ? 'bg-fail-soft text-fail' : 'text-slate-600'}`}>
            <span className="select-none text-center">{d.kind === 'add' ? '+' : d.kind === 'del' ? '−' : ' '}</span>
            <span className="whitespace-pre-wrap break-words pr-3">{d.text || ' '}</span>
          </div>
        ))}
      </pre>
    </>
  );
}

function RequirementsBody({ markdown, lineMap, docsLink }: { markdown: string; lineMap: LineMapEntry[]; docsLink: string | null }) {
  const [tab, setTab] = useState<'structured' | 'markdown'>('structured');
  return (
    <div>
      <div role="tablist" aria-label="Requirements view" className="mb-3 inline-flex rounded-md border border-slate-200 bg-slate-50 p-0.5">
        {(['structured', 'markdown'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`rounded px-3 py-1 text-sm font-medium ${tab === t ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
          >
            {t === 'structured' ? 'Steps and outcomes' : 'Markdown document'}
          </button>
        ))}
      </div>
      {tab === 'structured' ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase text-slate-500">Documented steps</h3>
            <ItemList entries={lineMap} markdown={markdown} docsLink={docsLink} kind="step" />
          </section>
          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase text-slate-500">Expected outcomes</h3>
            <ItemList entries={lineMap} markdown={markdown} docsLink={docsLink} kind="outcome" />
          </section>
        </div>
      ) : (
        <MarkdownView markdown={markdown} mapped={new Set(lineMap.map((e) => e.reqLine))} />
      )}
    </div>
  );
}

export function VerificationMaterial() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const vParam = params.get('v');
  const version = vParam && /^[1-9][0-9]{0,5}$/.test(vParam) ? Number(vParam) : undefined;
  const { health } = useHealth();
  const [d, setD] = useState<RequirementsDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setD(await api.requirements(id, version));
      setError(null);
      setNotFound(false);
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 404) setNotFound(true);
      else setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [id, version]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);
  useEffect(() => {
    document.title = `Verification material · ${d?.title ?? id} · KaneVerity`;
  }, [d?.title, id]);

  async function generate() {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const r = await api.generateRequirements(id);
      setNotice(r.status === 'created' ? `Version ${r.version.version} saved.` : `No change: version ${r.version.version} already matches the documentation.`);
      if (version) setParams({});
      else await load();
    } catch (e) {
      setError((e as Error).message);
      await load();
    } finally {
      setBusy(false);
    }
  }

  const back = (
    <Link to="/tutorials" className="text-sm text-brand hover:underline">
      ← Tutorials
    </Link>
  );

  if (notFound) {
    return (
      <div className="space-y-4">
        {back}
        <Card title="Tutorial or version not found">
          <p className="text-sm text-slate-600">This tutorial isn't in the current discovery, or that requirements version doesn't exist.</p>
        </Card>
      </div>
    );
  }
  if (loading && !d) {
    return (
      <div className="space-y-4" aria-busy="true">
        {back}
        <p className="text-sm text-slate-600">Loading verification material…</p>
      </div>
    );
  }
  if (!d) {
    return (
      <div className="space-y-4">
        {back}
        {error === ORCHESTRATOR_DOWN ? <p className="text-sm text-slate-600">Waiting for the orchestrator…</p> : <ErrorNote message={error} />}
        {error && /Connect a project/.test(error) && (
          <Link to="/connect" className="text-sm font-medium text-brand hover:underline">
            Connect a project
          </Link>
        )}
      </div>
    );
  }

  const docsLink = safeDocsLink(d.docsUrl, health?.project?.docsOrigin);
  const latest = d.versions[d.versions.length - 1] ?? null;
  const shown = d.shown;
  const viewingOld = !!shown && !shown.isLatest;

  return (
    <div className="space-y-5">
      <div>
        {back}
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">Verification material</h1>
          <RequirementsBadge state={d.state} />
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600">
          <span className="font-medium text-slate-800" data-testid="tutorial-title">
            {d.title}
          </span>
          {docsLink && (
            <a href={docsLink} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
              Open docs page
            </a>
          )}
        </p>
      </div>

      <Card title="Requirements for Kane Assurance">
        <p className="text-sm text-slate-700">
          KaneVerity turns this tutorial into a requirements document: the documented steps and expected outcomes, in order, with their exact labels and a reference to each documentation line. Kane Assurance will read it in a later step, only after you approve that step. The application address appears only as <code className="font-mono text-xs">{'{{app_url}}'}</code>.
        </p>
        <div className="mt-4 rounded-md border border-slate-200 p-3 text-sm" data-testid="requirements-status">
          {d.state === 'none' && <p>No requirements have been generated for this tutorial yet. Review the preview below, then generate version 1.</p>}
          {d.state === 'current' && latest && (
            <p>
              Version {latest.version} is current: it was generated from the documentation discovery shows, and the live page still matches.
            </p>
          )}
          {d.state === 'stale' && (
            <>
              <p className="font-medium text-review">Version {latest?.version} is out of date.</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-slate-700" data-testid="stale-reasons">
                {d.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </>
          )}
          {!d.canGenerate && d.cannotGenerateReason && (
            <p className="mt-2 text-review" data-testid="cannot-generate">
              {d.freshness.status !== 'current' ? (
                <>
                  {/* The reason is already listed above when the requirements are stale. */}
                  {d.state === 'stale' ? "Requirements can't be regenerated until discovery is refreshed." : `Can't generate yet: ${d.cannotGenerateReason}`}{' '}
                  <Link to="/tutorials" className="font-semibold underline">
                    Discover again on the Tutorials page
                  </Link>
                </>
              ) : (
                <>Can't generate: {d.cannotGenerateReason}</>
              )}
            </p>
          )}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={generate}
            disabled={busy || !d.canGenerate || (d.state === 'current' && !d.preview)}
            className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
            data-testid="generate-requirements"
          >
            {busy ? 'Generating…' : d.state === 'none' ? 'Generate requirements' : 'Regenerate requirements'}
          </button>
          <span className="text-xs text-slate-500">Free and local: no Kane command runs and no credits are used.</span>
        </div>
        {notice && (
          <p className="mt-3 text-sm text-pass" role="status" data-testid="generate-notice">
            {notice}
          </p>
        )}
        <div className="mt-3">
          <ErrorNote message={error} />
        </div>
      </Card>

      <AssuranceJobsPanel tutorialId={d.tutorialId} requirementsState={d.state} requirementsSha={latest?.reqSha256 ?? null} />

      {d.preview && (
        <Card title={latest ? `What regenerating would change (version ${latest.version + 1})` : 'Preview of version 1'}>
          {latest && shown?.isLatest ? (
            <DiffView before={shown.markdown} after={d.preview.markdown} />
          ) : (
            <RequirementsBody markdown={d.preview.markdown} lineMap={d.preview.lineMap} docsLink={docsLink} />
          )}
          <dl className="mt-3 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[12rem_1fr]">
            <Fingerprint label="Document fingerprint" sha={d.preview.docSha256} />
            <Fingerprint label="Requirements fingerprint" sha={d.preview.reqSha256} />
          </dl>
        </Card>
      )}

      {shown && (
        <Card
          title={
            <span className="flex flex-wrap items-center gap-2">
              Requirements version {shown.version}
              {viewingOld && <span className="rounded-full border border-slate-300 px-2 py-0.5 text-xs font-medium text-slate-600">Earlier version</span>}
            </span>
          }
          actions={
            viewingOld ? (
              <button type="button" onClick={() => setParams({})} className="text-sm font-medium text-brand hover:underline">
                View latest
              </button>
            ) : undefined
          }
        >
          {!shown.intact && (
            <p className="mb-3 rounded-md border border-fail/30 bg-fail-soft p-3 text-sm text-fail" role="alert">
              This stored file no longer matches its fingerprint. It must not be used; generate a new version.
            </p>
          )}
          <dl className="mb-4 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[12rem_1fr]" data-testid="version-meta">
            <dt className="text-slate-500">Created</dt>
            <dd>{formatTime(shown.createdAt)}</dd>
            <Fingerprint label="Document fingerprint" sha={shown.docSha256} />
            <Fingerprint label="Requirements fingerprint" sha={shown.reqSha256} />
            <dt className="text-slate-500">Replaces</dt>
            <dd>{shown.supersedes ? `version ${shown.supersedes}` : 'nothing (first version)'}</dd>
            <dt className="text-slate-500">Format</dt>
            <dd className="font-mono text-xs">{shown.format}</dd>
          </dl>
          <RequirementsBody markdown={shown.markdown} lineMap={shown.lineMap} docsLink={docsLink} />
        </Card>
      )}

      {d.versions.length > 0 && (
        <Card title="Versions">
          <p className="mb-2 text-sm text-slate-600">Every version is kept. A new version is saved only when the generated requirements change.</p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="versions-table">
              <thead className="text-xs uppercase text-slate-500">
                <tr>
                  <th className="py-2 pr-4">Version</th>
                  <th className="py-2 pr-4">Created</th>
                  <th className="py-2 pr-4">Document</th>
                  <th className="py-2 pr-4">Requirements</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {[...d.versions].reverse().map((v) => (
                  <tr key={v.version} className={`border-t border-slate-100 ${shown?.version === v.version ? 'bg-slate-50' : ''}`}>
                    <td className="py-2 pr-4 font-medium">
                      {v.version}
                      {v.version === latest?.version && <span className="ml-2 text-xs font-normal text-slate-500">latest</span>}
                    </td>
                    <td className="py-2 pr-4 text-slate-600">{formatTime(v.createdAt)}</td>
                    <td className="py-2 pr-4 font-mono text-xs" title={v.docSha256}>
                      {short(v.docSha256)}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs" title={v.reqSha256}>
                      {short(v.reqSha256)}
                    </td>
                    <td className="py-2 text-right">
                      {shown?.version === v.version ? (
                        <span className="text-xs text-slate-500">Shown</span>
                      ) : (
                        <button type="button" aria-label={`View version ${v.version}`} className="text-sm font-medium text-brand hover:underline" onClick={() => setParams(v.version === latest?.version ? {} : { v: String(v.version) })}>
                          View
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
