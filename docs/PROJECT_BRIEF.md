# KANEVERITY

### Documentation you can trust.

Project: KaneVerity\
Demo application: AcmeDesk\
Demo documentation: AcmeDesk Docs\
Primary coding agent: Claude Code\
Verification engine: Kane CLI\
Competition: KaneCLI Online Hackathon, November 12--19, 2026

------------------------------------------------------------------------

## 01. Project overview

KaneVerity is an AI-powered documentation verification platform that
checks whether software documentation accurately reflects how an
application works.

It takes documentation instructions, converts them into verifiable user
journeys, and uses Kane CLI to execute those journeys against the actual
application.

When Kane discovers outdated or incorrect instructions, Claude Code
investigates the findings and proposes documentation corrections. Kane
then runs the journey again to independently verify the updated
instructions.

KaneVerity creates a continuous relationship between software changes
and documentation accuracy.

Core promise:

Documentation should be tested against the software it describes.

## 02. The problem

Software products evolve constantly.

Developers change navigation, rename buttons, move settings, update
workflows and introduce new features.

Documentation doesn't always keep pace.

As a result:

-   Tutorials contain outdated navigation paths.
-   Screenshots show interfaces that no longer exist.
-   Instructions refer to renamed buttons or settings.
-   Users follow steps that no longer work.
-   Documentation teams discover problems through customer complaints.
-   Developers spend time investigating issues caused by outdated
    instructions.

Most documentation workflows focus on writing, editing and publishing
content.

KaneVerity focuses on whether the instructions can actually be followed
in the current application.

## 03. The proposed solution

KaneVerity connects three things:

1.  Software documentation.
2.  The actual application described by that documentation.
3.  An independent browser verification engine.

The platform discovers actionable tutorials, extracts their
instructions, prepares verification requirements and uses Kane CLI to
execute them.

When a discrepancy is found, Claude Code receives the evidence and helps
correct the documentation.

The corrected instructions are tested again.

The result is an evidence-backed documentation verification workflow.

## 04. Target users

Primary users:

-   SaaS companies.
-   Developer documentation teams.
-   Technical writers.
-   Developer relations teams.
-   Software engineers maintaining product documentation.

Secondary users:

-   Open-source maintainers.
-   API platform teams.
-   Product support teams.
-   Agencies maintaining client documentation.

## 05. Product structure

### A. KaneVerity

The main product.

Responsibilities:

-   Accept documentation and application URLs.
-   Discover documentation pages.
-   Identify actionable tutorials.
-   Extract instructions.
-   Prepare requirements for Kane.
-   Initiate verification runs.
-   Collect and present execution results.
-   Send relevant findings to Claude Code.
-   Track documentation corrections.
-   Initiate retests.
-   Present evidence-backed reports.

### B. AcmeDesk

Our fictional SaaS application.

It gives Kane a controlled environment in which to execute documented
workflows.

Initial application sections:

-   Dashboard
-   Projects
-   Team Members
-   Workspace Settings
-   Developer Settings
-   API Keys

### C. AcmeDesk Docs

The documentation website for AcmeDesk.

It contains tutorials describing how to use the application.

Some tutorials will intentionally contain outdated instructions so that
KaneVerity can demonstrate its ability to detect and resolve
documentation problems.

## 06. Core user journey

The main user journey consists of seven stages.

### Stage 1: Connect documentation

The user enters the URL of a documentation website.

KaneVerity retrieves accessible documentation pages and identifies
relevant tutorial content.

### Stage 2: Connect the application

The user supplies the URL of the application described by the
documentation.

Where authentication is required, the user supplies an appropriate test
account or session.

### Stage 3: Discover and extract instructions

KaneVerity identifies actionable tutorials and extracts:

-   Tutorial title.
-   Description.
-   Step-by-step instructions.
-   Expected outcome.
-   Relevant links.
-   Referenced application pages.

The system initially supports structured tutorials and straightforward
documentation websites.

It does not attempt to verify every sentence on a documentation website.

### Stage 4: Prepare verification requirements

The extracted instructions are converted into a structured requirements
document.

The document describes what a user should be able to accomplish and the
expected result.

Kane CLI's Assurance Lifecycle is used to ingest the requirements,
extract use cases, and design acceptance criteria and test scenarios.

Generated requirements and tests must be reviewed before they become
trusted verification material.

### Stage 5: Execute with Kane CLI

Kane runs the designed browser journeys against the actual application.

It checks whether the documented instructions can be followed and
whether the expected outcome occurs.

The execution produces a result and evidence.

Possible outcomes:

-   PASSED: The documented journey was completed and the expected
    outcome was verified.
-   FAILED: The documented journey could not be completed or its
    expected outcome was not satisfied.
-   BLOCKED: Execution could not establish the result because of an
    external condition, such as unavailable authentication or an
    inaccessible application.
-   NEEDS REVIEW: The result requires human investigation because the
    evidence is inconclusive.

A blocked execution must never be reported as a confirmed documentation
defect.

### Stage 6: Agent-assisted correction

When a genuine documentation discrepancy is identified, KaneVerity
prepares a correction task.

Claude Code receives:

-   Original tutorial.
-   Relevant instruction.
-   Failed step.
-   Kane execution result.
-   Screenshot and supporting evidence.
-   Observed application behaviour.
-   Expected outcome.

Claude Code investigates the discrepancy and proposes an updated
instruction.

The original documentation is preserved.

The user can review and approve the proposed change before it is
applied.

### Stage 7: Independent retest

After the correction, KaneVerity prepares an updated verification
requirement.

Kane executes the journey again against the actual application.

If the expected outcome is established, the tutorial receives a VERIFIED
status.

If it fails again, the issue remains open.

The system retains the original result, correction and retest evidence.

## 07. MVP feature scope

The first release will focus on the following features.

### Documentation connection

-   Documentation URL input.
-   Application URL input.
-   Documentation page discovery.
-   Tutorial identification.
-   Instruction extraction.

### Verification preparation

-   Structured tutorial representation.
-   Expected outcome extraction.
-   Requirements document generation.
-   Kane Assurance integration.
-   Review of generated verification material.

### Execution

-   Kane CLI integration.
-   Real browser execution.
-   Test status tracking.
-   Screenshot and evidence collection.
-   Execution logs.
-   Failure classification.

### Agent correction

-   Failure context preparation.
-   Claude Code integration.
-   Proposed documentation corrections.
-   Original and revised content comparison.
-   Human approval before applying changes.

### Retesting

-   Re-execution of corrected tutorials.
-   Comparison of initial and final results.
-   Verification status.
-   Evidence history.

### Reporting

-   Documentation overview.
-   Discovered tutorials.
-   Passed and failed journeys.
-   Blocked executions.
-   Suggested corrections.
-   Retest results.
-   Evidence access.

## 08. Kane CLI integration

Kane CLI is the independent verification engine and a core part of the
product.

We will use its actual capabilities rather than building a separate
browser automation framework.

Relevant capabilities include:

-   Browser automation through plain-language instructions.
-   Structured Agent Mode output.
-   Requirements ingestion.
-   Use-case extraction.
-   Acceptance criteria and scenario design.
-   Runnable test generation.
-   Evidence packs.
-   Test execution and replay.
-   Coverage measurement.

### Proposed Assurance workflow

1.  KaneVerity extracts actionable documentation instructions.
2.  It creates a requirements file.
3.  Kane ingests the requirements.
4.  Kane extracts use cases with source references.
5.  The use cases are reviewed.
6.  Kane designs acceptance criteria and test scenarios.
7.  The generated design is reviewed.
8.  Kane authors and executes the browser tests.
9.  Evidence is collected.
10. Kane measures what the execution proved.

We will use the current documented Assurance commands and generated test
files. We will not hand-write a parallel test framework.

### Evidence requirements

Each verification result should retain:

-   Kane execution status.
-   Test identifier.
-   Relevant acceptance criteria.
-   Failed or successful step.
-   Screenshots.
-   Execution logs.
-   Evidence pack reference.
-   Timestamp.
-   Retest relationship.

Kane's structured completion events and process exit status must both be
checked. A process ending successfully does not automatically mean the
documentation passed.

## 09. Claude Code integration

Claude Code is the development and correction agent.

Its responsibilities:

-   Implementing the platform.
-   Helping prepare documentation requirements.
-   Investigating Kane findings.
-   Proposing documentation corrections.
-   Applying approved changes.
-   Coordinating retests.

### Communication loop

Kane's structured results are passed to the orchestration layer.

The orchestration layer prepares a focused correction request for Claude
Code.

Claude Code examines the documentation and available evidence.

It proposes a correction.

After approval, the correction is applied.

Kane is then instructed to execute the updated journey.

The final status is determined by Kane's execution evidence, not Claude
Code's explanation.

This communication is essential to the hackathon's Closed Loop
criterion.

## 10. Technical architecture

### Development approach

Claude Code will be the primary development environment.

The initial implementation will run locally, with deployment considered
after the complete workflow works.

### Proposed stack

-   Frontend: React and TypeScript.
-   Build tooling: Vite.
-   Styling: Tailwind CSS.
-   Backend: Node.js.
-   API layer: lightweight local server.
-   Storage: local JSON or SQLite initially.
-   Documentation: Markdown and accessible web pages.
-   Verification: Kane CLI.
-   Coding agent: Claude Code.
-   Version control: GitHub.
-   Deployment: Vercel where appropriate.

These are proposed implementation choices, subject to checking the
existing environment and Kane CLI requirements.

### Local execution architecture

The browser interface communicates with a local orchestration service.

The orchestration service manages:

-   Documentation discovery.
-   Requirements preparation.
-   Kane CLI processes.
-   Claude Code processes.
-   Execution events.
-   Evidence references.
-   Correction approval.
-   Retest coordination.

Kane CLI and Claude Code must run in an environment with the required
filesystem and process access.

A deployed frontend alone cannot execute commands installed on a
developer's laptop.

For the hackathon demonstration, the local runner will coordinate the
actual workflow.

## 11. Interface structure

The MVP should have five main areas.

### 1. Dashboard

Displays:

-   Connected documentation project.
-   Application URL.
-   Tutorials discovered.
-   Verified tutorials.
-   Failed tutorials.
-   Corrections awaiting review.

### 2. Connect Project

Allows the user to enter:

-   Documentation URL.
-   Application URL.
-   Authentication or test-session details where required.

### 3. Tutorials

Displays discovered tutorials, extracted instructions and verification
status.

### 4. Verification

Shows:

-   Current Kane execution.
-   Individual steps.
-   Screenshots.
-   Failure details.
-   Evidence references.

### 5. Corrections

Displays:

-   Original instruction.
-   Proposed correction.
-   Reason for correction.
-   Supporting evidence.
-   Approval action.
-   Retest status.

The design should be clean, modern and developer-focused. Avoid
excessive dashboards and decorative metrics.

## 12. Demo environment

AcmeDesk will be our controlled testing environment.

It will contain four initial tutorials.

  Tutorial                       Initial state
  ------------------------------ ------------------------
  Create a project               Correct
  Invite a team member           Correct
  Generate an API key            Intentionally outdated
  Configure workspace settings   Intentionally outdated

### Demonstration defect 1

The documentation says:

Dashboard → Settings → API → Create API Key.

The actual application uses:

Dashboard → Developer Settings → API Keys → Generate Key.

Kane should discover that the documented navigation no longer matches
the application.

### Demonstration defect 2

The documentation describes an old workspace configuration path.

The actual application has moved those settings.

Kane should identify the discrepancy and capture evidence.

The first demonstration should focus on one complete correction loop
rather than attempting to fix every discovered issue.

## 13. Security and reliability safeguards

KaneVerity must distinguish actual documentation problems from execution
problems.

Important safeguards:

-   Never treat a blocked run as a confirmed defect.
-   Preserve original documentation.
-   Show proposed changes before applying them.
-   Avoid destructive actions in the demo application.
-   Use dedicated test accounts.
-   Keep credentials out of logs and public repositories.
-   Store evidence references with the relevant verification.
-   Require independent Kane retesting before marking a correction
    verified.

The system must not claim that documentation is fully correct simply
because a browser journey passed. It verifies the specific scenarios and
expected outcomes that were tested.

## 14. MVP acceptance criteria

The MVP is complete when the following can be demonstrated:

1.  A user can connect documentation and application URLs.
2.  The system can discover relevant tutorial pages.
3.  It can extract actionable instructions.
4.  It can prepare requirements for Kane CLI.
5.  Kane can generate and execute a relevant browser test.
6.  Kane can identify an intentionally outdated instruction.
7.  The result includes meaningful execution evidence.
8.  Kane's result is communicated to Claude Code.
9.  Claude Code can propose and apply a documentation correction.
10. Kane can independently retest the updated instructions.
11. The final report shows the original result and retest result.

These are acceptance targets, not claims that the implementation already
supports them.

## 15. Hackathon judging alignment

### Ships: 25%

Demonstrate a working journey from documentation input through
verification and reporting.

### Verified: 25%

Kane must independently catch an outdated instruction or prove that a
tutorial works.

The judges should see the actual browser execution and evidence.

### Closed Loop: 25%

Kane's result must reach Claude Code.

Claude must act on the finding, and Kane must verify the correction.

### Craft: 25%

The product should feel coherent, useful and installable.

Prioritise reliable execution, clear reporting, evidence and a focused
interface.

### Mandatory eligibility bars

KaneVerity must satisfy all three:

-   End-to-end working product.
-   Kane catches or proves something meaningful.
-   Claude Code and Kane CLI communicate.

## 16. Demonstration plan

Target duration: approximately four minutes.

-   00:00--00:35: Introduce KaneVerity and explain the documentation
    problem.
-   00:35--01:05: Connect AcmeDesk Docs and AcmeDesk.
-   01:05--01:40: Show discovered tutorials and extracted instructions.
-   01:40--02:25: Run Kane against the outdated API key tutorial. Show
    the failure and evidence.
-   02:25--03:15: Show Claude Code receiving the finding and correcting
    the documentation.
-   03:15--03:50: Run Kane again and show the successful verification.
-   03:50--04:00: Show the final report and explain the closed loop.

The video must show the real product running. We should record a backup
execution in case the live environment becomes unreliable.

## 17. Out of scope for the MVP

To protect delivery time, the first version will not include:

-   Billing or subscriptions.
-   Multi-tenant customer accounts.
-   Complex team permissions.
-   Support for every documentation platform.
-   Full API documentation testing.
-   General-purpose website exploration.
-   A complete security or accessibility audit.
-   Automatic publishing to production documentation.
-   A large analytics platform.
-   Mobile application verification.

These can be considered after the core product works.

## 18. Build sequence

### Phase 1: Foundation

-   Create the public GitHub repository.
-   Confirm Kane CLI installation and authentication.
-   Verify a basic Kane browser flow.
-   Establish the project structure.

### Phase 2: Demo environment

-   Build AcmeDesk.
-   Build AcmeDesk Docs.
-   Create the four tutorials.
-   Introduce the two controlled documentation defects.

### Phase 3: KaneVerity core

-   Build the interface.
-   Implement documentation discovery.
-   Extract tutorial instructions.
-   Prepare requirements.
-   Connect the Kane Assurance workflow.

### Phase 4: Verification

-   Execute browser tests.
-   Parse Kane results.
-   Collect evidence.
-   Display verification reports.

### Phase 5: Closed loop

-   Connect Claude Code.
-   Prepare correction requests.
-   Review and apply corrections.
-   Trigger independent Kane retests.

### Phase 6: Submission

-   Test the complete workflow.
-   Polish the interface.
-   Prepare README and setup instructions.
-   Record the YouTube demonstration.
-   Publish at least two public project posts.
-   Submit before the deadline.

------------------------------------------------------------------------

## Final product definition

KaneVerity is a documentation verification platform that turns software
tutorials into executable browser journeys. It uses Kane CLI to
independently test instructions against the actual application and
Claude Code to help correct discrepancies. Every correction is retested
by Kane before it can be marked verified.

The central product principle:

**If the software changes, the documentation should be tested.**
