// KaneVerity orchestrator API (local only).
//
// Security:
//  - listens on 127.0.0.1 only; Host header must be 127.0.0.1:4000/localhost:4000
//    (DNS-rebinding protection)
//  - every mutating request needs `X-KaneVerity: 1`, a JSON body, and, if the
//    browser sends an Origin, one of the KaneVerity UI origins. No CORS headers
//    are ever sent, so other websites cannot call this API.
//  - MVP: live verification only against the allow-listed local demo origins.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, estimateRange } from './src/config.ts';
import { checkAll, checkFreshness, refreshDiscovery } from './src/discovery/freshness.ts';
import { Runner, publicRecord } from './src/kane/runner.ts';
import { CorrectionError, CorrectionService, publicCorrection } from './src/correct/service.ts';
import { CORRECTION_ID_PATTERN } from './src/correct/store.ts';
import { EXPLORATION_MODES } from './src/correct/explore.ts';
import { AssuranceError, RequirementsService } from './src/assurance/service.ts';
import { AssuranceJobs, publicJob } from './src/assurance/jobs.ts';
import { AssuranceUseCases } from './src/assurance/usecases.ts';
import { AssuranceDesigns } from './src/assurance/designs.ts';
import { acquireInstanceLock } from './src/instanceLock.ts';
import { JOB_KINDS } from './src/assurance/commands.ts';
import { isTutorialId } from './src/assurance/store.ts';
import { dataPath, readJson, RUN_ID_PATTERN, runDir, writeJson } from './src/store.ts';
import type { Discovery, Project } from './src/types.ts';
import { isAllowedOrigin, originOf, UrlError } from './src/urls.ts';

const MAX_BODY = 64 * 1024;
const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json\b/i.test(type)) throw new HttpError(415, 'Content-Type must be application/json.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large.');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

/** Run `node <kane-cli> <cmd>` and return exit code + stdout (stdout is never sent to the UI raw). */
function kaneCommand(entry: string, cmd: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, cmd], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, shell: false });
    let out = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (c: string) => {
      if (out.length < 20_000) out += c;
    });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('error', () => resolve({ code: null, out: '' }));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

// The TestMu account balance and identity are never sent to the UI. The UI shows
// only KaneVerity's own run costs from the ledger (Kane-reported vs estimated).
let kaneStatusCache: { at: number; value: { installed: boolean; loggedIn: boolean } } | null = null;
async function kaneStatus() {
  if (kaneStatusCache && Date.now() - kaneStatusCache.at < 60_000) return kaneStatusCache.value;
  const entry = config.kane.entry;
  let value = { installed: !!entry, loggedIn: false };
  if (entry) {
    const who = await kaneCommand(entry, 'whoami'); // only the exit code is used; identity is never stored or shown
    value = { installed: true, loggedIn: who.code === 0 };
  }
  kaneStatusCache = { at: Date.now(), value };
  return value;
}

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(4000) });
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  }
}

function checkUrlPair(docsUrl: unknown, appUrl: unknown): Project {
  if (typeof docsUrl !== 'string' || typeof appUrl !== 'string' || !docsUrl.trim() || !appUrl.trim()) {
    throw new HttpError(400, 'Both the documentation URL and the application URL are required.');
  }
  let docsOrigin: string;
  let appOrigin: string;
  try {
    docsOrigin = originOf(docsUrl);
    appOrigin = originOf(appUrl);
  } catch (err) {
    throw new HttpError(400, (err as UrlError).message);
  }
  if (!isAllowedOrigin(docsOrigin, config.allowedDocsOrigins) || !isAllowedOrigin(appOrigin, config.allowedAppOrigins)) {
    throw new HttpError(
      400,
      `This MVP only runs live verification against the controlled local demo (docs ${config.allowedDocsOrigins.join(', ')}, app ${config.allowedAppOrigins.join(', ')}). Arbitrary third-party documentation is not supported for live execution yet.`,
    );
  }
  if (docsOrigin === appOrigin) throw new HttpError(400, 'The documentation and the application must be on different origins.');
  return { docsUrl: docsUrl.trim(), docsOrigin, appUrl: appUrl.trim(), appOrigin, savedAt: new Date().toISOString() };
}

export function createOrchestrator(runner = new Runner(), corrections = new CorrectionService(runner), requirements = new RequirementsService(), jobs = new AssuranceJobs({ requirements }), usecases = new AssuranceUseCases(jobs, requirements), designs = new AssuranceDesigns(usecases, jobs)): Server {
  return createServer(async (req, res) => {
    try {
      const host = (req.headers.host ?? '').toLowerCase();
      if (!config.allowedHosts.includes(host) && !host.startsWith('127.0.0.1:')) throw new HttpError(421, 'Unexpected Host header.');
      const url = new URL(req.url ?? '/', 'http://orchestrator.invalid');
      const method = req.method ?? 'GET';

      // Any request that carries a browser Origin must come from the KaneVerity UI.
      // (Same-origin GETs, EventSource and <img> requests from the UI send no Origin.)
      const origin = req.headers.origin;
      if (origin && !config.uiOrigins.includes(origin)) throw new HttpError(403, 'Origin not allowed.');
      if (method !== 'GET' && method !== 'HEAD') {
        if (req.headers['x-kaneverity'] !== '1') throw new HttpError(403, 'Missing X-KaneVerity header.');
      }

      const p = url.pathname;

      if (method === 'GET' && p === '/api/health') {
        const project = await readJson<Project>(dataPath('project.json'));
        const [docsOk, appOk, kane, costs] = await Promise.all([
          project ? reachable(project.docsUrl) : Promise.resolve(false),
          project ? reachable(project.appUrl) : Promise.resolve(false),
          kaneStatus(),
          runner.costs(),
        ]);
        return json(res, 200, {
          project,
          docsReachable: docsOk,
          appReachable: appOk,
          kane,
          credits: costs,
          liveVerificationScope: { docs: config.allowedDocsOrigins, app: config.allowedAppOrigins, note: 'Live verification is limited to the controlled local AcmeDesk demo.' },
          // Allow-listed exploration modes with the exact fixed rule each adds (no app labels).
          explorationModes: Object.entries(EXPLORATION_MODES).map(([id, m]) => ({ id, label: m.label, rule: m.rule })),
        });
      }

      if (method === 'POST' && p === '/api/project') {
        const body = (await readBody(req)) as Record<string, unknown>;
        const project = checkUrlPair(body.docsUrl, body.appUrl);
        await writeJson(dataPath('project.json'), project);
        return json(res, 200, { project });
      }

      if (method === 'POST' && p === '/api/discover') {
        await readBody(req);
        const project = await readJson<Project>(dataPath('project.json'));
        if (!project) throw new HttpError(409, 'Connect a project first.');
        return json(res, 200, await refreshDiscovery(project));
      }

      if (method === 'GET' && p === '/api/discovery/freshness') {
        const project = await readJson<Project>(dataPath('project.json'));
        const discovery = await readJson<Discovery>(dataPath('discovery.json'));
        if (!project || !discovery) return json(res, 200, { checkedAt: new Date().toISOString(), discoveredAt: null, tutorials: [] });
        return json(res, 200, { checkedAt: new Date().toISOString(), discoveredAt: discovery.discoveredAt, tutorials: await checkAll(discovery, project) });
      }

      if (method === 'GET' && p === '/api/discovery') {
        return json(res, 200, (await readJson<Discovery>(dataPath('discovery.json'))) ?? null);
      }

      if (method === 'POST' && p === '/api/runs') {
        const body = (await readBody(req)) as Record<string, unknown>;
        const ids = body.tutorialIds;
        if (!Array.isArray(ids) || ids.length === 0 || ids.length > 10 || !ids.every((x) => typeof x === 'string')) {
          throw new HttpError(400, 'tutorialIds must be a list of 1 to 10 tutorial ids.');
        }
        const project = await readJson<Project>(dataPath('project.json'));
        const discovery = await readJson<Discovery>(dataPath('discovery.json'));
        if (!project || !discovery) throw new HttpError(409, 'Connect a project and discover tutorials first.');
        if (discovery.appOrigin !== project.appOrigin) throw new HttpError(409, 'Discovery is out of date for this project. Discover again.');
        const tutorials = (ids as string[]).map((id) => discovery.tutorials.find((t) => t.id === id));
        if (tutorials.some((t) => !t)) throw new HttpError(404, 'Unknown tutorial id.');
        const notRunnable = tutorials.find((t) => t!.notRunnable);
        if (notRunnable) throw new HttpError(422, `"${notRunnable.title}" cannot be verified: ${notRunnable.notRunnable}`);
        // Stale-discovery protection: a run uses the discovered tutorial, so the live page
        // must still show exactly that content. Otherwise nothing starts and no credits are used.
        for (const t of tutorials) {
          const fresh = await checkFreshness(t!, project);
          if (fresh.status !== 'current') {
            throw new HttpError(409, `"${t!.title}" was not verified: ${fresh.reason} Discover again to refresh the tutorials, then verify. Nothing was run.`);
          }
        }
        const runIds: string[] = [];
        for (const t of tutorials) {
          try {
            runIds.push(await runner.enqueue(t!, project));
          } catch (err) {
            throw new HttpError(422, (err as Error).message);
          }
        }
        // No spending ceiling. The UI shows the typical cost and asks for confirmation before calling this.
        return json(res, 202, { runIds, estimatedCreditsPerRun: estimateRange('verification') });
      }

      if (method === 'GET' && p === '/api/runs') {
        const index = (await readJson<string[]>(dataPath('runs-index.json'))) ?? [];
        const list = [];
        for (const id of index.slice(-50).reverse()) {
          if (!RUN_ID_PATTERN.test(id)) continue;
          // Rebuild from the private record so current redaction rules always apply.
          const rec = await runner.load(id);
          if (rec) list.push(publicRecord(rec));
        }
        return json(res, 200, list);
      }

      const runMatch = /^\/api\/runs\/([^/]+)(?:\/(events|cancel|corrections|screens\/([^/]+)))?$/.exec(p);
      if (runMatch) {
        const runId = runMatch[1];
        if (!RUN_ID_PATTERN.test(runId)) throw new HttpError(404, 'Run not found.');
        const sub = runMatch[2];

        if (method === 'GET' && !sub) {
          // Always rebuilt from the private record so current redaction rules apply,
          // including to runs saved by older versions.
          const rec = await runner.load(runId);
          if (!rec) throw new HttpError(404, 'Run not found.');
          return json(res, 200, publicRecord(rec));
        }

        if (method === 'POST' && sub === 'corrections') {
          await readBody(req);
          const rec = await corrections.start(runId);
          return json(res, 202, publicCorrection(rec));
        }

        if (method === 'POST' && sub === 'cancel') {
          await readBody(req);
          return json(res, runner.cancel(runId) ? 202 : 409, { cancelled: true });
        }

        if (method === 'GET' && sub === 'events') {
          const initial = await runner.load(runId);
          if (!initial) throw new HttpError(404, 'Run not found.');
          res.writeHead(200, { ...HEADERS, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
          res.write(`data: ${JSON.stringify(publicRecord(initial))}\n\n`);
          const send = () => {
            const live = runner.get(runId);
            if (live) res.write(`data: ${JSON.stringify(publicRecord(live))}\n\n`);
          };
          const onEvent = (id: string) => id === runId && send();
          // Comment heartbeat keeps proxies from buffering or closing an idle stream.
          const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
          req.on('close', () => clearInterval(heartbeat));
          runner.on('progress', onEvent);
          runner.on('update', onEvent);
          req.on('close', () => {
            runner.off('progress', onEvent);
            runner.off('update', onEvent);
          });
          return;
        }

        if (method === 'GET' && sub?.startsWith('screens/')) {
          const file = runMatch[3];
          if (!/^[0-9]{1,4}\.jpg$/.test(file)) throw new HttpError(404, 'Not found.');
          const dir = runDir(runId, 'public', 'screens');
          const full = path.resolve(dir, file);
          if (!full.startsWith(path.resolve(dir) + path.sep)) throw new HttpError(404, 'Not found.');
          let data: Buffer;
          try {
            data = await readFile(full);
          } catch {
            throw new HttpError(404, 'Not found.');
          }
          res.writeHead(200, { ...HEADERS, 'Content-Type': 'image/jpeg' });
          return res.end(data);
        }
      }

      if (method === 'GET' && p === '/api/corrections') {
        return json(res, 200, (await corrections.list()).map(publicCorrection));
      }
      const cMatch = /^\/api\/corrections\/([^/]+)(?:\/(analyze|explore|approve|retest|reject|restore|dismiss))?$/.exec(p);
      if (cMatch) {
        const id = cMatch[1];
        if (!CORRECTION_ID_PATTERN.test(id)) throw new HttpError(404, 'Correction not found.');
        const action = cMatch[2];
        if (method === 'GET' && !action) return json(res, 200, publicCorrection(await corrections.get(id)));
        if (method === 'POST' && action) {
          const body = (await readBody(req)) as Record<string, unknown> | null;
          if (action === 'analyze') return json(res, 202, publicCorrection(await corrections.analyze(id)));
          // Exploration mode: only allow-listed ids are accepted (validated in the service); default if omitted.
          const mode = body && typeof body === 'object' && 'mode' in body ? body.mode : 'default';
          const rec =
            action === 'explore' ? await corrections.explore(id, mode) : action === 'approve' ? await corrections.approve(id) : action === 'retest' ? await corrections.retest(id) : action === 'reject' ? await corrections.reject(id) : action === 'dismiss' ? await corrections.dismiss(id) : await corrections.restore(id, body);
          return json(res, 202, publicCorrection(rec));
        }
      }

      // Assurance B5: test-design review. Reading runs the free use-case retrieval (B3); review
      // and the app_url approval are KaneVerity's own records. No Kane write, design or test run.
      // Pre-execution steps (Kane approval writes of design items, the run variables file, a
      // free dry run) and the paid test run are only here, bound to one use case's content id.
      const xMatch = /^\/api\/assurance\/designs\/([^/]+)\/([a-f0-9]{64})\/executions\/([^/]+)\/reconcile$/.exec(p);
      if (xMatch && method === 'POST') {
        const [, tutorialId, ucHex, executionId] = xMatch;
        await readBody(req);
        const e = await designs.reconcileExecution(tutorialId, ucHex, executionId);
        return json(res, 200, await designs.view(tutorialId, ucHex, e.reason));
      }
      const bMatch = /^\/api\/assurance\/designs\/([^/]+)\/([a-f0-9]{64})(?:\/(retrieve|review|app-url|run-variables|kane-write|kane-reconcile|dry-run|execute))?$/.exec(p);
      if (bMatch) {
        const [, tutorialId, ucHex, action] = bMatch;
        if (method === 'GET' && !action) return json(res, 200, await designs.view(tutorialId, ucHex));
        if (method === 'POST' && action) {
          const body = await readBody(req);
          if (action === 'retrieve') {
            await designs.retrieve(tutorialId, ucHex);
            return json(res, 200, await designs.view(tutorialId, ucHex));
          }
          if (action === 'run-variables') {
            await designs.writeRunVariables(tutorialId, ucHex, body);
            return json(res, 200, await designs.view(tutorialId, ucHex, 'Run variables file written. Read the design again before the dry run.'));
          }
          if (action === 'kane-write' || action === 'kane-reconcile') {
            const w = action === 'kane-write' ? await designs.kaneWrite(tutorialId, ucHex, body) : await designs.reconcileKaneWrite(tutorialId, ucHex, body);
            return json(res, 200, await designs.view(tutorialId, ucHex, w.reason));
          }
          if (action === 'dry-run') {
            const d = await designs.dryRun(tutorialId, ucHex);
            return json(res, 200, await designs.view(tutorialId, ucHex, d.reason));
          }
          if (action === 'execute') {
            const x = await designs.execute(tutorialId, ucHex, body);
            return json(res, 202, await designs.view(tutorialId, ucHex, x.reason));
          }
          const e = action === 'review' ? await designs.review(tutorialId, ucHex, body) : await designs.approveAppUrl(tutorialId, ucHex, body);
          return json(res, 200, await designs.view(tutorialId, ucHex, `Recorded: ${e.kind} ${e.decision}.`));
        }
      }

      // V2: a test-design job's answer (paid, re-checked) and stop/abandon, from its use case.
      const dMatch = /^\/api\/assurance\/usecases\/([^/]+)\/([a-f0-9]{64})\/design\/([^/]+)\/(answer|cancel)$/.exec(p);
      if (dMatch && method === 'POST') {
        const [, tutorialId, ucHex, jobId, dAction] = dMatch;
        const body = await readBody(req);
        return json(res, 202, publicJob(dAction === 'answer' ? await usecases.answerDesign(tutorialId, ucHex, jobId, body) : await usecases.cancelDesign(tutorialId, ucHex, jobId)));
      }

      // Assurance B3/B4: use cases. Retrieval runs free, read-only Kane commands; review is
      // KaneVerity's own; an approval is then written to Kane and verified, or reconciled.
      const uMatch = /^\/api\/assurance\/usecases\/([^/]+)(?:\/(retrieve)|\/([a-f0-9]{64})\/(review|kane-write|reconcile|design))?$/.exec(p);
      if (uMatch) {
        const [, tutorialId, retrieve, ucHex, action] = uMatch;
        if (method === 'GET' && !retrieve && !action) return json(res, 200, await usecases.view(tutorialId));
        if (method === 'POST' && retrieve) {
          await readBody(req);
          await usecases.retrieve(tutorialId);
          return json(res, 200, await usecases.view(tutorialId));
        }
        if (method === 'POST' && action === 'review') {
          const body = await readBody(req);
          const r = await usecases.review(tutorialId, ucHex, body);
          return json(res, 200, await usecases.view(tutorialId, r.note));
        }
        if (method === 'POST' && action === 'design') {
          // V2: paid; fresh checks first; the job then runs in the background.
          const body = await readBody(req);
          return json(res, 202, publicJob(await usecases.design(tutorialId, ucHex, body)));
        }
        if (method === 'POST' && (action === 'kane-write' || action === 'reconcile')) {
          await readBody(req);
          const w = action === 'kane-write' ? await usecases.writeToKane(tutorialId, ucHex) : await usecases.reconcile(tutorialId, ucHex);
          return json(res, 200, await usecases.view(tutorialId, w.reason));
        }
      }

      // Assurance B2: Kane Assurance jobs (off unless KANEVERITY_ASSURANCE_MODE enables them).
      if (method === 'GET' && p === '/api/assurance/status') {
        return json(res, 200, {
          mode: config.assurance.mode,
          pinnedVersion: config.assurance.pinnedVersion,
          kaneFound: !!config.kane.entry,
          kinds: Object.values(JOB_KINDS).filter((k) => !k.internal).map((k) => ({ kind: k.kind, label: k.label, paid: k.paid, enabled: config.assurance.mode === 'all' || (config.assurance.mode === 'free' && !k.paid) })),
        });
      }
      if (p === '/api/assurance/jobs') {
        if (method === 'GET') {
          const t = url.searchParams.get('tutorialId');
          if (t !== null && !isTutorialId(t)) throw new HttpError(400, 'Invalid tutorial id.');
          return json(res, 200, (await jobs.list(t)).map((j) => publicJob(j)));
        }
        if (method === 'POST') {
          const body = (await readBody(req)) as Record<string, unknown>;
          return json(res, 202, publicJob(await jobs.start(body ?? {})));
        }
      }
      const jMatch = /^\/api\/assurance\/jobs\/([^/]+)(?:\/(answer|cancel))?$/.exec(p);
      if (jMatch) {
        const [, jobId, jAction] = jMatch;
        if (method === 'GET' && !jAction) return json(res, 200, publicJob(await jobs.get(jobId)));
        if (method === 'POST' && jAction) {
          const body = await readBody(req);
          // Test-design jobs are refused here (V2): they are answered and stopped from their use case.
          return json(res, 202, publicJob(jAction === 'answer' ? await jobs.answer(jobId, body) : await jobs.cancel(jobId)));
        }
      }

      // Assurance B1: requirements artefacts (generation is local and free; no Kane command runs).
      if (method === 'GET' && p === '/api/assurance/requirements') {
        return json(res, 200, await requirements.list());
      }
      const rMatch = /^\/api\/assurance\/requirements\/([^/]+)$/.exec(p);
      if (rMatch) {
        const id = rMatch[1];
        if (method === 'GET') {
          const v = url.searchParams.get('version');
          if (v !== null && !/^[1-9][0-9]{0,5}$/.test(v)) throw new HttpError(400, 'version must be a positive whole number.');
          return json(res, 200, await requirements.get(id, v === null ? null : Number(v)));
        }
        if (method === 'POST') {
          await readBody(req);
          const out = await requirements.generate(id);
          return json(res, out.status === 'created' ? 201 : 200, out);
        }
      }

      throw new HttpError(404, 'Not found.');
    } catch (err) {
      if (err instanceof HttpError || err instanceof CorrectionError || err instanceof AssuranceError) return json(res, err.status, { error: err.message });
      console.error('[orchestrator] request failed:', (err as Error).message);
      return json(res, 500, { error: 'Internal error.' });
    }
  });
}

/** Keep an index of run ids so /api/runs can list them. */
export function trackRuns(runner: Runner): void {
  runner.on('update', async (runId: string) => {
    const index = (await readJson<string[]>(dataPath('runs-index.json'))) ?? [];
    if (!index.includes(runId)) {
      index.push(runId);
      await writeJson(dataPath('runs-index.json'), index);
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const runner = new Runner();
  trackRuns(runner);
  // One orchestrator per data folder: in-memory locks only protect one process.
  let instance: Awaited<ReturnType<typeof acquireInstanceLock>>;
  try {
    instance = await acquireInstanceLock(config.dataDir, config.port);
  } catch (err) {
    console.error(`[orchestrator] ${(err as Error).message}`);
    process.exit(1);
  }
  process.on('exit', () => instance.releaseSync());
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(sig, () => process.exit(0));
  setInterval(() => {
    if (!instance.stillMine()) {
      console.error('[orchestrator] The data folder lock is no longer held by this orchestrator (it was removed or taken by another one). Stopping, so two orchestrators never write the same data.');
      process.exit(1);
    }
  }, 5000).unref();
  const jobs = new AssuranceJobs();
  // A job that was running when the orchestrator stopped is marked interrupted (never retried).
  await jobs.init();
  const requirements = new RequirementsService();
  const usecases = new AssuranceUseCases(jobs, requirements);
  // An approval write that was pending when the orchestrator stopped becomes "unknown" (never retried).
  await usecases.init();
  const designs = new AssuranceDesigns(usecases, jobs);
  // A design-item approval write that was pending when the orchestrator stopped becomes "unknown".
  await designs.init();
  const server = createOrchestrator(runner, undefined, requirements, jobs, usecases, designs);
  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(err.code === 'EADDRINUSE' ? `[orchestrator] Port ${config.port} is already in use.` : `[orchestrator] ${err.message}`);
    process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    console.log(`[orchestrator] KaneVerity orchestrator on http://${config.host}:${config.port}/`);
    console.log(`[orchestrator] Kane CLI: ${config.kane.entry ? 'found' : 'NOT FOUND'}`);
  });
}
