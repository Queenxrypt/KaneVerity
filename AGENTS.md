# AGENTS.md

## Project: KaneVerity

**Tagline:** Documentation you can trust.

### Problem

Software applications change, but their tutorials often become outdated.
KaneVerity checks whether actionable documentation instructions still
work in the application they describe.

### User

SaaS developers, documentation teams, technical writers, and maintainers
who need to know whether product tutorials still match the live
application. The MVP is a desktop-browser workflow for a developer or
documentation maintainer.

### Done statement

A user connects a documentation site and its application. KaneVerity
discovers a supported tutorial, extracts its steps, and uses Kane CLI to
execute the documented journey against the application. If Kane finds a
genuine discrepancy, the result and evidence are passed to Claude Code.
Claude proposes a documentation correction, the user can review and
approve it, and Kane independently reruns the journey. The report
preserves the initial result, correction, and retest evidence.

## Product structure

-   **KaneVerity:** the documentation verification product.
-   **AcmeDesk:** the controlled demo SaaS application being documented.
-   **AcmeDesk Docs:** the documentation site containing AcmeDesk
    tutorials.
-   **Kane CLI:** independent browser execution and evidence.
-   **Claude Code:** primary coding agent and agent-assisted
    documentation correction.

## MVP must-haves

1.  Connect a documentation URL and an application URL.
2.  Discover accessible documentation pages and identify supported,
    actionable tutorials.
3.  Extract tutorial steps and explicit expected outcomes. Keep source
    references to the original page and text.
4.  Convert the extracted instructions into a requirements artefact
    suitable for the current Kane CLI workflow.
5.  Use Kane CLI to execute a real browser journey against the
    application.
6.  Capture and display execution status and available Kane evidence,
    including screenshots, logs, and evidence-pack references where
    supported.
7.  Classify outcomes as:
    -   **PASSED:** the documented journey and expected outcome were
        verified.
    -   **FAILED:** evidence shows a documented step or expected outcome
        does not match the application.
    -   **BLOCKED:** execution could not establish a result because of
        an external condition, such as unavailable authentication or an
        inaccessible application.
    -   **NEEDS REVIEW:** evidence is inconclusive or the result may be
        an automation/test issue.
8.  Pass a genuine finding, its source instruction, and Kane evidence to
    Claude Code.
9.  Have Claude propose a documentation correction. Preserve the
    original and show a diff. Require user approval before applying
    changes.
10. Rerun the corrected journey with Kane. Only mark it **VERIFIED**
    when the retest evidence supports that result.
11. Show a report linking the original run, finding, proposed/applied
    correction, and retest.

## Controlled demo

AcmeDesk is a fictional project and workspace management SaaS with:

-   Dashboard
-   Projects
-   Team Members
-   Workspace Settings
-   Developer Settings
-   API Keys

AcmeDesk Docs starts with four tutorials:

-   Create a project, correct.
-   Invite a team member, correct.
-   Generate an API key, intentionally outdated.
-   Configure workspace settings, intentionally outdated.

For the primary demo, focus on one complete correction loop: the API-key
tutorial. Its documentation initially says:

`Dashboard → Settings → API → Create API Key`

The actual AcmeDesk interface uses:

`Dashboard → Developer Settings → API Keys → Generate Key`

Kane should attempt the documented journey, identify the mismatch, and
capture evidence. Claude Code should propose the documentation
correction. After approval, Kane should rerun the updated instructions
and verify the expected outcome.

Keep the demo deterministic. Use dedicated test data and accounts. Avoid
destructive actions.

## Technical direction

Use the simplest architecture that supports a real, demonstrable
end-to-end flow.

-   Primary development environment: Claude Code, working locally.
-   Frontend: React + TypeScript + Vite, unless repository inspection
    shows a better existing foundation.
-   Styling: Tailwind CSS if useful and already practical.
-   Backend/orchestrator: Node.js with a lightweight local service.
-   Initial persistence: local JSON or SQLite, only as needed.
-   Documentation source: Markdown and accessible web pages for the MVP.
-   Browser verification: Kane CLI.
-   Version control: GitHub.
-   Deployment: consider Vercel after the local workflow works.

The local orchestrator coordinates documentation discovery, requirements
preparation, Kane CLI execution, result parsing, evidence references,
correction approval, and retesting. Do not assume a hosted frontend can
execute local CLI tools. Keep secrets and credentials out of source
control and logs.

### Kane CLI integration rules

-   Inspect the installed Kane CLI version, `--help` output, and current
    official documentation before choosing commands or flags.
-   Do not invent commands, flags, output fields, or Assurance Lifecycle
    steps.
-   Prefer Kane's documented requirements/Assurance workflow and
    generated artefacts where supported. Do not build a parallel browser
    automation framework.
-   Use structured Agent Mode output for orchestration where supported.
    Confirm the exact event schema from real output before parsing it.
-   Check both structured completion information and process exit
    status. Do not infer a passing test from process success alone.
-   Preserve links or paths to actual Kane evidence. Never fabricate
    screenshots, logs, test results, or evidence.
-   Distinguish application/documentation defects from Kane execution
    failures, authentication problems, unavailable pages, and
    inconclusive evidence.
-   A blocked or inconclusive run must not be reported as a confirmed
    documentation defect.
-   Verify that the documented expected outcome is observable. A
    successful click alone is not proof that the task succeeded.

### Claude Code correction loop

-   Treat Kane's result as evidence to investigate, not as an
    instruction to blindly rewrite documentation.
-   Give Claude the relevant tutorial, failed step, expected outcome,
    observed behaviour, and actual Kane evidence.
-   Ask Claude to propose a minimal correction and explain why it is
    supported by the evidence.
-   Preserve the original content and produce a reviewable diff.
-   Require human approval before modifying the documentation.
-   After approval, rerun the same journey with Kane.
-   The final verification status must come from Kane's retest evidence,
    not Claude's claim that it fixed the issue.

## Interface and design

Build a clean, modern, developer-focused interface. Prioritise clarity
and evidence over decorative metrics.

MVP areas: 1. **Dashboard:** connected project, tutorial counts, current
statuses, and corrections awaiting review. 2. **Connect project:**
documentation URL, application URL, and test-session/authentication
setup. 3. **Tutorials:** discovered tutorials, extracted steps, expected
outcomes, and status. 4. **Verification:** live or recent Kane run, step
results, screenshots, logs, and evidence references. 5. **Corrections:**
original text, proposed text, reason, evidence, approval, and retest
status.

Do not add features just to make the dashboard look busy. Do not add
billing, multi-tenant accounts, complex permissions, broad platform
integrations, automatic production publishing, or a large analytics
suite to the MVP.

## Working rules

1.  **Read before changing.** At the start of every new session, read
    this file, `docs/PROJECT_BRIEF.md`, and relevant architecture or
    hackathon notes. Inspect the existing repository before proposing
    changes.
2.  **Plan first.** For a substantial task, use Claude Code Plan mode.
    Explain the approach, files likely to change, dependencies, risks,
    and how it will be tested. Do not write code until the plan is
    reviewed and approved.
3.  **Ask essential questions.** If a requirement, credential, expected
    outcome, or destructive action is unclear, ask before proceeding. Do
    not invent product decisions.
4.  **One feature at a time.** Implement the smallest useful vertical
    slice. Avoid unrelated refactors and avoid changing files outside
    the task's scope.
5.  **Explain plainly.** The project owner is not asking for unexplained
    code changes. Explain technical choices, errors, and proposed fixes
    in clear, simple language.
6.  **Test before declaring done.** Run relevant checks, start the app
    when appropriate, and explain exactly how to verify the feature in
    the browser. Do not claim a feature works without evidence.
7.  **Test edge cases.** Where relevant, check empty inputs, invalid
    URLs, inaccessible pages, repeated clicks, missing credentials,
    timeouts, and failed executions.
8.  **Protect working features.** State what must not change. If a
    change breaks a working feature, diagnose it and restore the last
    known-good behaviour before continuing.
9.  **Save working milestones.** After a feature passes its checks,
    summarise what changed and create a Git commit with a clear message,
    if the repository is configured for commits. Never rewrite history
    or discard user work without permission.
10. **Keep secrets safe.** Never hard-code API keys, passwords, access
    tokens, or personal credentials. Use environment variables and
    maintain `.env.example` with placeholders only. Never commit `.env`
    or real credentials.
11. **Use real evidence.** Do not create fake Kane results, screenshots,
    logs, success states, or fabricated test data presented as live
    execution.
12. **Keep scope tight.** Prefer a working end-to-end path over extra
    features. Raise scope changes before implementing them.
13. **Check security.** Consider URL-fetching risks, local file access,
    command execution, credential handling, and untrusted documentation
    content. Do not execute arbitrary commands extracted from
    documentation.
14. **Report honestly.** At the end of each task, state what changed,
    what tests ran and passed/failed, what remains, and any manual steps
    needed.
15. **Hackathon alignment.** Keep the product aligned with Ships,
    Verified, Closed Loop, and Craft. Kane must catch or prove something
    meaningful, and its result must reach the coding agent and lead to
    an independently verified retest.

## First task

Do not start building the application immediately.

1.  Inspect the current project folder and available development
    environment.
2.  Check whether Claude Code, Node.js, Git, and Kane CLI are installed
    and usable. Do not expose or print secrets.
3.  Inspect the installed Kane CLI version and official/current command
    documentation. Identify the smallest supported browser flow and how
    its evidence is accessed.
4.  Check the hackathon repository initialization and submission
    requirements in `docs/HACKATHON_REQUIREMENTS.md` if present. Flag
    anything missing or time-sensitive.
5.  Propose a short, ordered implementation plan for the first working
    vertical slice: AcmeDesk API-key journey, Kane execution, captured
    evidence, Claude-assisted documentation correction, and Kane retest.
6.  Do not write application code until the plan is reviewed and
    approved.

## Completion report format

At the end of each milestone, report:

-   **Completed:** what was implemented.
-   **Verification:** commands/checks run and their actual results.
-   **Evidence:** where relevant screenshots, logs, or Kane evidence can
    be found.
-   **Remaining:** known gaps, risks, and next task.
-   **Save point:** Git commit identifier, if created.
