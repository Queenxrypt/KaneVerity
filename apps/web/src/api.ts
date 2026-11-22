// Client for the local KaneVerity orchestrator (via the Vite /api proxy).
// Every request carries X-KaneVerity: 1; mutating requests send JSON.

import type { Discovery, FreshnessReport, Health, Project, PublicCorrection, PublicRun } from './types.ts';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const ORCHESTRATOR_DOWN = 'The KaneVerity orchestrator is not reachable. Start it in a terminal with: npm run dev:orchestrator';

async function request<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init.method ?? 'GET',
      headers: { 'X-KaneVerity': '1', ...(init.method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
      body: init.method === 'POST' ? JSON.stringify(init.body ?? {}) : undefined,
    });
  } catch {
    throw new ApiError(0, ORCHESTRATOR_DOWN);
  }
  // The Vite proxy answers 502/504 when the orchestrator is down.
  if (res.status === 502 || res.status === 504) throw new ApiError(res.status, ORCHESTRATOR_DOWN);
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    if (!res.ok) throw new ApiError(res.status, ORCHESTRATOR_DOWN);
  }
  if (!res.ok) {
    const msg = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : `Request failed (${res.status}).`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export const api = {
  health: () => request<Health>('/health'),
  saveProject: (docsUrl: string, appUrl: string) => request<{ project: Project }>('/project', { method: 'POST', body: { docsUrl, appUrl } }),
  discover: () => request<Discovery>('/discover', { method: 'POST', body: {} }),
  discovery: () => request<Discovery | null>('/discovery'),
  freshness: () => request<FreshnessReport>('/discovery/freshness'),
  startRuns: (tutorialIds: string[]) => request<{ runIds: string[]; estimatedCredits: number }>('/runs', { method: 'POST', body: { tutorialIds } }),
  runs: () => request<PublicRun[]>('/runs'),
  run: (id: string) => request<PublicRun>(`/runs/${encodeURIComponent(id)}`),
  cancel: (id: string) => request<{ cancelled: boolean }>(`/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} }),
  startCorrection: (runId: string) => request<PublicCorrection>(`/runs/${encodeURIComponent(runId)}/corrections`, { method: 'POST', body: {} }),
  corrections: () => request<PublicCorrection[]>('/corrections'),
  correction: (id: string) => request<PublicCorrection>(`/corrections/${encodeURIComponent(id)}`),
  correctionAction: (id: string, action: 'analyze' | 'explore' | 'approve' | 'retest' | 'reject' | 'restore' | 'dismiss', body: Record<string, unknown> = {}) => request<PublicCorrection>(`/corrections/${encodeURIComponent(id)}/${action}`, { method: 'POST', body }),
};

export type Transport = 'live' | 'polling';

/**
 * Follow a run: Server-Sent Events first, falling back to polling every 3 s if
 * the stream fails (or when `forcePoll` is set). Stops when the run finishes.
 */
export function subscribeRun(
  runId: string,
  onUpdate: (run: PublicRun) => void,
  onTransport: (t: Transport) => void,
  onError: (message: string) => void,
  forcePoll = false,
): () => void {
  let stopped = false;
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const poll = async () => {
    if (stopped) return;
    try {
      const run = await api.run(runId);
      onUpdate(run);
      if (run.state === 'finished') return;
    } catch (err) {
      onError((err as Error).message);
    }
    timer = setTimeout(poll, 3000);
  };

  const startPolling = () => {
    source?.close();
    source = null;
    onTransport('polling');
    void poll();
  };

  if (forcePoll || typeof EventSource === 'undefined') {
    startPolling();
  } else {
    source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
    onTransport('live');
    source.onmessage = (ev) => {
      try {
        const run = JSON.parse(ev.data) as PublicRun;
        onUpdate(run);
        if (run.state === 'finished') {
          source?.close();
          source = null;
        }
      } catch {
        // ignore malformed event
      }
    };
    source.onerror = () => {
      if (!stopped && source) startPolling();
    };
  }

  return () => {
    stopped = true;
    source?.close();
    if (timer) clearTimeout(timer);
  };
}
