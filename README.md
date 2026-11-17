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
Human approves → docs updated → Kane retests → VERIFIED only on passing evidence
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
| Orchestrator (discovery, Kane runner, Claude correction, retest) | ⏳ Not started |
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

## Security notes

- Never commit `.env`, credentials or tokens. Kane authentication is stored by Kane outside this repo.
- Kane evidence packs (`.testmuai/`, `*.evidence`) and runtime data (`data/`) are git-ignored by default, because they can contain screenshots and network logs.
- KaneVerity does not run commands taken from documentation content.
- Known dev-only advisory: `npm audit` reports GHSA-fc5q-39xc-vjpf (picomatch ReDoS) through Vite's file watcher. No patched picomatch exists yet, it is not in any production bundle (`npm audit --omit=dev` reports 0), and the affected patterns come only from Vite's own configuration. Update once picomatch publishes a fix.

## Project documents

- [`AGENTS.md`](AGENTS.md): product definition and working rules for coding agents
- [`docs/PROJECT_BRIEF.md`](docs/PROJECT_BRIEF.md): full project brief
- [`docs/HACKATHON_REQUIREMENTS.md`](docs/HACKATHON_REQUIREMENTS.md): hackathon rules and submission checklist
