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
| AcmeDesk demo app | ⏳ Not started |
| AcmeDesk Docs | ⏳ Not started |
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

## Security notes

- Never commit `.env`, credentials or tokens. Kane authentication is stored by Kane outside this repo.
- Kane evidence packs (`.testmuai/`, `*.evidence`) and runtime data (`data/`) are git-ignored by default, because they can contain screenshots and network logs.
- KaneVerity does not run commands taken from documentation content.

## Project documents

- [`AGENTS.md`](AGENTS.md): product definition and working rules for coding agents
- [`docs/PROJECT_BRIEF.md`](docs/PROJECT_BRIEF.md): full project brief
- [`docs/HACKATHON_REQUIREMENTS.md`](docs/HACKATHON_REQUIREMENTS.md): hackathon rules and submission checklist
