# KaneVerity

**Documentation you can trust.**

KaneVerity checks whether software tutorials still work in the application they describe. It extracts the steps from a tutorial, uses [Kane CLI](https://github.com/LambdaTest/kane-cli) to run that journey in a real browser against the live app, and captures the evidence. When Kane finds a genuine mismatch, the finding goes to Claude Code, which proposes a minimal documentation fix. After a human approves the fix, Kane reruns the journey on its own. A tutorial is marked **VERIFIED** only when Kane's retest evidence supports it.

Built for the [Kane CLI Online Hackathon](https://www.kaneclihack.sh/) (12–19 November 2026).

## How it works

```
Docs URL + App URL
      │
      ▼
Discover tutorials → extract steps + expected outcome (with source refs)
      │
      ▼
Kane CLI runs the documented journey (real Chrome) → status + evidence pack
      │
      ├── PASSED / BLOCKED / NEEDS REVIEW → reported, no correction
      ▼
FAILED (genuine doc mismatch) → Claude Code proposes a correction (diff)
      │
      ▼
Human approves & applies → docs updated
      │
      ▼
Human starts Kane retest (separate confirmation) → VERIFIED only on passing evidence
```

## Demo setup

| Component | Role |
|---|---|
| **KaneVerity** | The verification product: UI and local orchestrator |
| **AcmeDesk** | A fictional SaaS app used as a controlled demo target |
| **AcmeDesk Docs** | Tutorials for AcmeDesk, including deliberately outdated ones |
| **Kane CLI** | Independent browser execution and evidence |
| **Claude Code** | Coding agent and documentation correction agent |

The main demo uses the API-key tutorial. The docs say `Dashboard → Settings → API → Create API Key`, but the app actually uses `Dashboard → Developer Settings → API Keys → Generate Key`.

## Proposed stack

- **Frontend:** React, TypeScript, Vite, Tailwind CSS
- **Orchestrator:** Node.js with a lightweight local HTTP service
- **Storage:** local JSON files (MVP)
- **Docs source:** Markdown served as plain web pages
- **Browser verification:** Kane CLI (`kane-cli run --agent`, with evidence packs)
- **Correction agent:** Claude Code (headless)

The orchestrator runs Kane CLI and Claude Code as local processes, so the full workflow runs on a developer machine. A hosted frontend alone cannot run them.

## Setup status

| Item | Status |
|---|---|
| Project brief and agent rules | ✅ `AGENTS.md`, `docs/` |
| Kane CLI install, login and spike runs | ✅ Verified locally (Kane CLI 0.10.5) |
| Repository scaffolding | ✅ This commit |
| AcmeDesk demo app | ✅ Built (`apps/acmedesk`) |
| AcmeDesk Docs | ✅ Built (`apps/docs`) |
| Orchestrator: discovery, extraction, Kane runner, evidence, classification (4a) | ✅ Built (`apps/orchestrator`) |
| KaneVerity interface (4b) | ✅ Built (`apps/web`) |
| Claude correction loop (exploration, review, independent retest) | ✅ Built and run for real: the API-key correction was VERIFIED by an independent Kane retest (`apps/orchestrator/src/correct`) |
| KaneVerity UI | ⏳ Not started |

## Prerequisites

- Node.js 18 or later
- Git
- Google Chrome (Kane CLI drives a local Chrome)
- [Kane CLI](https://github.com/LambdaTest/kane-cli): `npm install -g @testmuai/kane-cli`
- [Claude Code](https://claude.com/claude-code)
- A TestMu AI account with Kane CLI credits

## Getting started (so far)

```bash
npm install -g @testmuai/kane-cli
kane-cli login --oauth     # authenticate yourself; credentials stay in Kane's own profile
kane-cli whoami            # confirm you are logged in
cp .env.example .env       # then set KANE_CLI_CHROME_PATH if Chrome isn't auto-detected
```

Run and demo instructions will be added as each part is built.

## AcmeDesk (demo app)

AcmeDesk is a fictional SaaS workspace app and the controlled target that Kane verifies. It has no login, no backend and no destructive actions. All data is fixed seed data held in memory, so every fresh browser session starts from the same state.

```bash
npm install
npm run dev:acmedesk        # http://127.0.0.1:5174
npm run typecheck:acmedesk
npm run build:acmedesk
```

| Section | URL | Verifiable action → confirmation |
|---|---|---|
| Dashboard | `/` | — |
| Projects | `/projects` | New project → Create project → `Project "<name>" created.` |
| Team Members | `/team` | Invite member → Send invite → `Invitation sent to <email> as <role>.` (simulated, no email sent) |
| Workspace Settings | `/workspace-settings` | Save changes → `Workspace settings saved.` |
| Developer Settings | `/developer` | — |
| API Keys | `/developer/api-keys` | Generate Key → `API key generated successfully.` |

The real API-key path is **Dashboard → Developer Settings → API Keys → Generate Key**. There is deliberately no menu item labelled just "Settings" or "API", so the outdated tutorial path fails.

Generated keys look like `demo_fake_key_0002`. They are fake placeholder values, not credentials, and cannot be used anywhere.

Confirmations appear in a persistent `role="status"` region (with a `data-testid`) and do not auto-dismiss, so Kane has time to observe them. Unknown URLs, such as old documented paths, show a "Page not found" page.

## AcmeDesk Docs (demo documentation)

A small documentation site for AcmeDesk, rendered from Markdown on every request so approved corrections show up immediately. It uses Node's built-in `http` module and one dependency, [`marked`](https://github.com/markedjs/marked).

```bash
npm run dev:docs            # http://127.0.0.1:5175
npm run typecheck:docs
npm run test:docs           # safety, line-mapping and routing self-check
```

- **Content:** `apps/docs/content/guides/*.md` (concept pages) and `apps/docs/content/tutorials/*.md` (four tutorials, two of them deliberately outdated).
- **Tutorial format:** frontmatter (`type: tutorial`, `id`, `title`, `app_start`, `last_reviewed`), then `## Steps` (one action per numbered item, UI labels in **bold**, typed values in `code`), then `## Expected outcome` (a bullet list of observable results). Notes and warnings are blockquotes starting with `**Note:**`, `**Warning:**` or `**Tip:**` and are never treated as steps.
- **Machine-readable markers:** each step and outcome is rendered with `data-kv`, `data-source-file`, `data-source-line` and `data-source-text`. Each page carries `data-source-sha256`. Line numbers are recalculated from the current file on every request.
- **Safety:** documentation is treated as untrusted. Raw HTML is shown as text, only `http`, `https`, `mailto` and relative links are allowed, and every response sends a script-free Content-Security-Policy plus `nosniff`, `no-referrer` and `no-store` headers. Only GET and HEAD are accepted, and only `/guides/<slug>` and `/tutorials/<slug>` pages are served.

The answer key for the demo is in [`docs/DEMO_SCENARIO.md`](docs/DEMO_SCENARIO.md). It is for humans only and is never served, read by the orchestrator, or given to Kane or Claude. Verification design rules are in [`docs/VERIFICATION_RULES.md`](docs/VERIFICATION_RULES.md).

## KaneVerity orchestrator (local API)

The orchestrator is a local service on `http://127.0.0.1:4000`. It discovers tutorials, builds the Kane instructions, runs Kane CLI one job at a time, reads the evidence, and classifies each run. It uses Node's built-in `http` module and one dependency, [`parse5`](https://github.com/inikulin/parse5), to parse documentation HTML as data.

```bash
npm run dev:docs            # docs on :5175
npm run dev:acmedesk        # app on :5174
npm run dev:orchestrator    # API on :4000
npm run test:orchestrator   # unit, security and fake-Kane end-to-end tests (no credits)
```

> **Start the orchestrator from a normal terminal.** When it was launched by an IDE or app "preview" runner, Kane CLI could not resolve your logged-in Test Manager credentials and exited at setup ("Project and folder must be configured", exit 2). KaneVerity correctly reported that run as BLOCKED, with 0 credits used. Started with `npm run dev:orchestrator` in a terminal, the same run worked.

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Docs and app reachability, Kane installed and logged in (exit code only), KaneVerity run costs (Kane-reported vs estimated) |
| `POST /api/project` | Connect a docs URL and an app URL |
| `POST /api/discover` | Discover tutorials (sitemap and links, same origin only) |
| `POST /api/runs` | Queue Kane runs for tutorial ids |
| `GET /api/runs/:id` | UI-safe run record. `/events` streams it live, `/screens/<n>.jpg` serves approved screenshots, `/cancel` cancels |
| `GET /api/assurance/requirements` | Requirements state per discovered tutorial (`none`, `current` or `stale`) |
| `GET /api/assurance/requirements/:tutorialId` | One tutorial's requirements: state and reasons, the latest (or `?version=n`) document with its line map, every version, and a preview of what would be generated |
| `POST /api/assurance/requirements/:tutorialId` | Generate requirements from the current documentation; a new version only if the content changed. Local and free: no Kane command runs |
| `GET /api/assurance/status` | Whether Kane Assurance commands are switched on (`off` by default), the pinned Kane version, and which job kinds are enabled |
| `GET/POST /api/assurance/jobs` | List jobs (`?tutorialId=`) or start an allow-listed job (`ingest`, `extract`, `design`, `list`, `cover`); paid kinds need `{"confirm": {"paid": true}}` |
| `GET /api/assurance/jobs/:id`, `POST …/answer`, `POST …/cancel` | One job; answer a paused session's questions (validated against what Kane asked); stop, cancel or abandon. The internal approval-write job (`review`) cannot be started, listed as a kind, or cancelled here |
| `GET /api/assurance/usecases/:tutorialId` | The latest use-case retrieval with citation checks, KaneVerity review state, Kane approval state, write history and design eligibility (B3, B4) |
| `POST /api/assurance/usecases/:tutorialId/retrieve` | Read use cases from Kane with free, read-only commands (mode `free` or `all`) |
| `POST /api/assurance/usecases/:tutorialId/:ucHex/review` | Record your decision (`approve`, or `reject` with a reason); an approval is then written to Kane and verified |
| `POST …/:ucHex/kane-write`, `POST …/:ucHex/reconcile` | Write the latest approval to Kane again after "not written", or settle an unknown write by reading the store (never re-runs the write) |

- **MVP scope:** live verification runs **only** against the controlled local AcmeDesk demo (`127.0.0.1:5174`) and its docs (`127.0.0.1:5175`). Arbitrary third-party documentation is **not** supported for live execution yet. Kane's instructions ask it to stay on the app, and every origin seen in the evidence is checked **after** the run. External navigation is **detected, not prevented**: Kane CLI offers no browser-domain restriction. Any unexpected origin makes a verification NEEDS REVIEW and rejects an exploration or retest.
- **Kane receives the documentation as written:** a fixed KaneVerity rules header, then the extracted steps word for word, then one `Assert that:` line per documented expected outcome. Kane is started as `node <kane-cli.cjs> run …`, with no shell.
- **Classification** follows [`docs/VERIFICATION_RULES.md`](docs/VERIFICATION_RULES.md). PASSED needs a passing Kane assertion matched to every documented outcome. FAILED needs a failure traced to exactly one documented step or outcome. Anything less certain is NEEDS REVIEW, and external problems are BLOCKED.
- **Privacy:** raw Kane output, stderr and evidence packs stay in `data/runs/<id>/private/` (git-ignored, never served). The UI gets an allow-listed, scrubbed record, and a screenshot is shown only if its step was on the demo app origin.
- **Credits:** one Kane run at a time, and every real run needs an explicit confirmation showing its estimated cost (about 12–35 credits for a verification or retest, 20–40 for an exploration; estimates only, from observed runs). There is no internal spending ceiling. Each run records its cost in `data/credits.json`: the actual cost Kane reports, a clearly labelled estimate if Kane reported none after doing agent work (for example a timeout), or 0 if Kane stopped before any agent work.
- **API protection:** loopback only, a Host-header check, and every mutating request needs `X-KaneVerity: 1`, a JSON body and an allowed Origin. No CORS headers are sent.
- **One orchestrator per data folder:** at startup the orchestrator takes `data/orchestrator.lock` (created atomically, with its process id and a random token). A second orchestrator on the same data folder, even on another port, refuses to start, because KaneVerity's review and job locks live in one process's memory.
  - **Stale locks:** a lock left by a process that no longer exists (a crash) is taken over.
  - **Lost locks:** the orchestrator re-checks ownership every 5 seconds and before every review-history append and Kane approval write. If the lock was removed or taken, it stops writing and exits.
  - **Limits:** if a stale lock's process id has been reused by another program, it reads as held. Delete the file if no orchestrator is running. Orchestrators from before this change take no lock.

## Kane Assurance integration (in progress)

KaneVerity is adopting Kane CLI's Assurance lifecycle (requirements → use cases → reviewed test design → execution → coverage → reconcile) as its primary verification engine. The approved architecture and phases are in [`docs/ASSURANCE_PLAN.md`](docs/ASSURANCE_PLAN.md); Kane CLI is pinned to 0.10.5.

**B1 (done): requirements.** Each discovered tutorial gets a deterministic requirements document (Tutorials → **Verification material**): the documented steps and expected outcomes in order, exact labels and values, each item's documentation `file:line`, and the document fingerprint. The application address appears only as `{{app_url}}`. Versions are append-only under `data/assurance/requirements/<tutorialId>/` and become **stale** when the documentation changes. Generating runs no Kane command and uses no credits; later phases (ingest, use cases, design, execution) each need explicit approval.

**B2 (built, switched off): the Assurance job runner.** KaneVerity can run allow-listed Kane Assurance commands (land requirements, extract use cases, design tests, list, coverage) and answer Kane's questions when a session pauses. Safeguards:

- **Off by default.** `KANEVERITY_ASSURANCE_MODE` is `off` unless set to `free` (only commands that use no credits) or `all`. Every paid command also needs an explicit confirmation.
- **One Kane process at a time**, shared with verification runs (Kane's Assurance store is single-writer), and only one store-writing job per tutorial.
- **Pinned version:** each orchestrator process checks `kane-cli --version` is 0.10.5 before the first job.
- **No shell, no terminal:** Kane runs directly in `data/assurance/workspace/` with `KANE_CONTEXT_GITIGNORE=0`. Only fixed argument lists, validated ids and your validated answers reach Kane; Kane's suggested `next` commands are shown, never run.
- **Stream rules** from Kane's documented contract: unknown events tolerated, a missing final `done` means the outcome is unknown, and `done` must agree with the exit code.
- **Cost:** Kane-reported usage, or the balance difference measured around the job, or **unknown** (never shown as 0).
- **Recovery:** timeouts and cancels stop the process; a job running when the orchestrator stopped is marked interrupted and never retried. Expired sessions can't be answered.
- **Privacy:** raw Kane output stays in `data/assurance/jobs/<id>/private/`; the UI gets a scrubbed, leak-checked view.

**Validation runs so far** (details in [`docs/ASSURANCE_PLAN.md`](docs/ASSURANCE_PLAN.md) section 12):

- **V0 (free):** the API-key requirements landed in a local Assurance store (`data/assurance/workspace/.context/`), 0 credits.
- **V1 (paid, approved once):** Kane extracted one use case, "Generate an API key", from those requirements through the KaneVerity runner, for **4.83 credits** (Kane-reported, matching the balance difference). It is **unreviewed**: nothing was approved. Its citations trace every documented expected outcome back to the documentation lines; the documented steps are named correctly but not cited, so step coverage still depends on KaneVerity's own fidelity check. Assurance mode was switched back to `off` right after.
**B3 (built): use-case review in KaneVerity.** On the Verification material page, **Read use cases from Kane (free)** runs three free, read-only Kane commands through the runner (`context fsck --json`, `context list --json --inferred`, `context view --json`). It needs Assurance mode `free` or `all`. KaneVerity also reads the committed store records, because citation quotes are only there. The retrieval is accepted only when every cross-check agrees:

- the store check passes, and its record count matches;
- the store was written by the pinned Kane 0.10.5, with an unbroken commit chain;
- the source blob is byte-identical to a stored requirements version;
- each use case's title, trust, anchors and criteria agree between the commands and the records.

Each retrieval is saved append-only under `data/assurance/usecases/<tutorialId>/`. Kane's store is never written.

- **Citations are checked**, not trusted: each anchor must be in range, its quote must be on the cited requirements lines, and it must name the right source and version. Valid citations are traced through the line map to documentation `file:line`. Uncited steps and outcomes are shown as **NOT CITED** and are never treated as verified.
- **Review is KaneVerity's own.** Approve, or reject with a reason, from the page. Decisions are stored append-only in `data/assurance/reviews/<tutorialId>.json`, per exact use-case version. Approving with citation gaps needs an explicit acknowledgement. Kane's own auto-recorded "skipped" verdict (attributed to `human:owner`) is shown for information and never counts.
- **States:** derived by Kane → awaiting your review → approved / rejected (Kane's `trusted` is shown separately and never counts). A use case can go to test design only when it is approved in KaneVerity, its retrieval passed the integrity checks, it is in the latest retrieval, and its requirements are still current. Test design itself is B4 and not built.
- The actual V1 use case `uc-1` reads cleanly, with 6/6 citations valid, 3/3 outcomes cited, 0/3 steps cited, awaiting review, and not ready for test design.
- **Limitations:**
  - A valid citation proves only where Kane's text came from, not that the application behaves that way. That still needs a Kane run.
  - The record format KaneVerity reads is not documented by Kane. It is accepted only exactly as validated on 0.10.5, and anything else fails the integrity checks.
  - KaneVerity decisions are not written to Kane's store, so Kane still lists `uc-1` as `derived`. How approvals reach test design is the B4 decision.
  - Reading needs Assurance mode `free`. Reviewing works in any mode, from the last saved retrieval.

**B4 (built): approvals recorded in Kane and verified.** Approving a use case in KaneVerity now also writes that approval into Kane's store and checks it there. Validated first on a disposable copy of the store (V-B4a, see the plan's section 12.4).

- **Reviewer name:** set `KANEVERITY_REVIEWER` (a short handle, see `.env.example`) and restart the orchestrator. It is **self-declared, not authenticated**: KaneVerity has no login, and Kane records whatever `USER` it is given. Kane receives `USER=kaneverity:<reviewer>`. Without the setting, approving is disabled; rejecting still works.
- **The write:** one free command, `context review --verdicts <private file> --mode ci --json`, run through the job runner (mode `free` or `all`, shared Kane lock). The private verdict file holds exactly one approval for the exact use-case content id. `--mode ci` means Kane never archives anything. `--allow-unreviewed`, `--allow-archive` and `--force` are refused for every command.
- **Before writing,** KaneVerity reads the store again and refuses if anything changed since your decision: the use-case content id, source, requirements version, store tip, or the latest decision. It also refuses if Kane already trusts the use case without a verified KaneVerity approval (approved outside KaneVerity).
- **After writing,** KaneVerity reads the store again. The write is **verified** only when all of these hold:
  - exactly one new review-only record approves this content id, attributed to `human:kaneverity:<reviewer>`;
  - the record links to the previous tip and was written by Kane 0.10.5;
  - Kane lists the use case as trusted;
  - its content id, citations, source and requirements are unchanged;
  - Kane's own output confirms it.

  KaneVerity records the Kane record number and full hash.
- **When it isn't clean:**
  - nothing in the store means **not written** (a retry is allowed);
  - a record that doesn't match exactly is **written but not verified** (never written again);
  - anything unproven, such as a crash, timeout or orchestrator restart mid-write, is **unknown**.

  An unknown write locks decisions and writes for the tutorial until you press **Check Kane's store**, which only reads the store. KaneVerity never retries an unknown write by itself.
- **History:** decisions and every write step are append-only in `data/assurance/reviews/<tutorialId>.json`. The page shows one line per write with its steps (started, Kane running, outcome). The file is read fail-closed: if it exists but can't be read or has the wrong shape, nothing is shown as unreviewed or unlocked and nothing is written over it.
- **Rejections** stay in KaneVerity only. Nothing is archived in Kane. A rejected use case that Kane still trusts is shown as such and kept out of test design. Re-approving relies on the same verified Kane record (Kane accepts verdicts only for items waiting for review).
- **Design gate:** test design is allowed only when the latest KaneVerity decision is an approval and a verified Kane record backs that exact content id. Kane must also list the use case as trusted, with the retrieval intact and the requirements current. Kane's own trust or `by` field never counts on its own.
- **The real `uc-1`** is still unreviewed. Nothing has been written to the real store.
- **Limitations:**
  - **Who approved is unproven.** Someone with local access could run Kane directly with `USER=kaneverity:<name>`; such a record would be accepted only through a store check after an unknown write.
  - **History edits go undetected.** The history file is append-only in code but not tamper-evident: a hand edit isn't detected (no hash chain).
  - **Design must re-check.** The design gate reflects the latest retrieval, so test design must read Kane's store again just before it starts.
  - **Untested against real Kane.** The write and verification have been exercised only with a fake Kane CLI and a disposable store copy; the first real write needs a real decision on `uc-1`.

- Next: test design (V2), with its own approval.

## Correction loop: Claude review and independent Kane retest

A FAILED run with a confirmed documentation defect can start a correction (Run page, **Propose correction**):

1. **Claude reviews** a sanitized package in an isolated temporary folder: the tutorial, the failed step, Kane's evidence and approved screenshots. Claude Code runs headless with `--tools Read --restricted --strict-mcp-config --disable-slash-commands --no-session-persistence`, so it has read-only access to that folder only, with no shell, web, MCP, skills or project files. It answers `needs_exploration`, `proposal` or `cannot_determine`.
2. **Kane explores** (on request, with credit confirmation) using a fixed KaneVerity template: it finds how the documented task is done today and must independently prove every documented outcome. Exploration never counts as verification. You choose an allow-listed **exploration mode**: the standard template, or **"Explore using the main navigation menu"**, which adds one fixed, label-free rule to use the main navigation menu instead of dashboard shortcuts. The mode is recorded on the run, in the audit trail and in Claude's package.
3. **Gate:** a correction can only be proposed once exploration has confirmed the route. Every UI label in the proposal must be the target of a specific exploration action (or a stored or asserted exploration value), cited by run and step, in the order Kane performed them. Only the Steps list may change, never the expected outcomes.
4. **You review** the diff, rationale and evidence citations, then reject or choose **Approve & apply**. Approving only writes the Markdown (fingerprint-guarded, original and backup kept in `data/corrections/`) and records one `applied` audit event. It does not start Kane or spend credits; the correction waits in the **applied** state.
5. **Start Kane retest** is a separate action with its own credit confirmation, available only for an applied correction. Kane retests the tutorial as re-extracted from the live docs page. **VERIFIED** requires all of: the approved document's fingerprint, a clean start, exit 0 and `run_end` passed, every outcome matched to a distinct passing assertion, a valid finalized evidence pack, and no unexpected origin (these rules are unchanged by the split). Otherwise the correction stays open. Claude's answer never decides it.

**Restore original** puts the tutorial back for repeat demos. Restoring a VERIFIED correction needs an explicit confirmation, because it invalidates that VERIFIED result.

**Status and safeguards.**
- Before every verification run, KaneVerity checks the live docs page against what was discovered. If the page changed, the run is refused (no credits used) until you **Discover again**. Discovery is refreshed automatically after a correction is applied or restored.
- Only verification and retest runs set a tutorial's status; exploration runs never do. The Dashboard and Tutorials page use the same rules, show VERIFIED tutorials, open and resolved findings, and corrections awaiting review.
- Only one correction per tutorial can be in progress. A correction that stopped with an error can be retried or closed; one that was not verified can be retested again or restored.

Full rules: [`docs/VERIFICATION_RULES.md`](docs/VERIFICATION_RULES.md).

## KaneVerity interface

A React, TypeScript, Vite and Tailwind app at `http://127.0.0.1:5173`. It calls the orchestrator through the Vite `/api` proxy.

```bash
npm run dev:acmedesk        # terminal 1: app on :5174
npm run dev:docs            # terminal 2: docs on :5175
npm run dev:orchestrator    # terminal 3: API on :4000 (start it from a normal terminal)
npm run dev:web             # terminal 4: UI on :5173
```

- **Dashboard:** connected project, readiness (docs, app, Kane logged in), **KaneVerity run costs** (credits Kane reported, plus any labelled estimates; no limit and no account balance), status counts, the latest finding and recent runs. The TestMu account balance and identity are never shown.
- **Connect:** docs and app URLs. Live verification is limited to the local AcmeDesk demo.
- **Tutorials:** discovered tutorials with extracted steps, expected outcomes and source lines. Select tutorials, then confirm the credit reservation, and Kane runs one at a time.
- **Run:** live progress (Server-Sent Events, falling back to polling; `?transport=poll` forces polling), the status with a plain-language explanation, documented steps and outcomes with source references and matched Kane checks, approved screenshots, evidence validation status, and the exact instructions sent to Kane. Evidence pack paths are never shown, only a run reference.
- **Security:** Vite's default CORS is turned off, and the orchestrator rejects any request that carries a non-UI Origin, so other local pages can't call or read the API.

## Security notes

- Never commit `.env`, credentials or tokens. Kane authentication is stored by Kane outside this repo.
- Kane evidence packs (`.testmuai/`, `*.evidence`) and runtime data (`data/`) are git-ignored by default, because they can contain screenshots and network logs.
- KaneVerity does not run commands taken from documentation content.
- Known dev-only advisory: `npm audit` reports GHSA-fc5q-39xc-vjpf (picomatch ReDoS) through Vite's file watcher. No patched picomatch exists yet, it is not in any production bundle (`npm audit --omit=dev` reports 0), and the affected patterns come only from Vite's own configuration. Update once picomatch publishes a fix.

## Project documents

- [`AGENTS.md`](AGENTS.md): product definition and working rules for coding agents
- [`docs/PROJECT_BRIEF.md`](docs/PROJECT_BRIEF.md): full project brief
- [`docs/HACKATHON_REQUIREMENTS.md`](docs/HACKATHON_REQUIREMENTS.md): hackathon rules and submission checklist
