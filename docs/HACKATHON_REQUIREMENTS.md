# Kane CLI Online Hackathon

## Official rules, requirements and submission checklist

Source of truth: https://www.kaneclihack.sh/\
Organizer: TestMu AI\
Event dates: 12--19 November 2026\
Submission deadline: 11:59 PM IST, 19 November 2026

This document records the rules and requirements published on the
official hackathon website when this file was prepared. If the organizer
updates the website or full contest terms, the organizer's latest
published rules take precedence.

------------------------------------------------------------------------

## 1. Challenge

Build an app, agent or workflow using an AI coding agent, for web or
mobile, and verify it with Kane CLI.

The hackathon permits any agent, framework or technology stack. Examples
named by the organizer include Claude Code, Cursor, Copilot, Codex,
Windsurf, Kiro and custom MCP setups.

Kane CLI must be used to verify the project. The organizer encourages
wiring Kane into the agent loop through a hook, re-prompt or
specification.

Projects may be built solo or in teams of up to four people.

## 2. Eligibility

-   Anyone aged 18 or older may enter.
-   Participants may be located anywhere in the world.
-   Entries may be solo or teams of up to four.
-   There is no application cap.
-   Participants must be signed up on TestMu AI.
-   Participants must have run Kane CLI to be eligible for judging.
-   Employees of TestMu AI and participating partners are not eligible
    to win.

## 3. Required setup

Before building:

1.  Register on TestMu AI.
2.  Claim the 10,000 free Kane CLI credits.
3.  Use the same email address for TestMu AI registration and the credit
    claim.
4.  Install Kane CLI.
5.  Run at least one Kane CLI flow.

The official installation command shown on the event website is:

``` bash
npm install -g @testmuai/kane-cli
```

The website states that new TestMu AI accounts receive 10,000 free
credits, valid for one month. Participants who run low on credits are
asked to contact the organizers on Slack before the deadline.

## 4. Build-period requirement

The GitHub repository must be initialized on or after 12 November 2026.

The organizers state that they will check commit history. An older idea
may be used, but an older codebase may not.

The repository must be public.

## 5. Mandatory judging eligibility bars

A project must clear all three bars before judges can score the four
judging dimensions:

1.  **End-to-end working product:** The project must run through a real
    flow. Slides alone do not qualify.
2.  **Meaningful Kane verification:** Kane CLI must catch or prove
    something meaningful.
3.  **Agent communication:** The project's AI coding agent and Kane CLI
    must communicate with each other.

Missing any one of these bars means the judges cannot score the
remaining dimensions.

## 6. Judging criteria

The project is scored by three TestMu AI engineers across four equally
weighted dimensions.

  ------------------------------------------------------------------------
  Dimension                                   Weight What judges look for
  --------------------- ---------------------------- ---------------------
  Ships                                          25% A real flow that runs
                                                     end to end, rather
                                                     than slides.

  Verified                                       25% Kane CLI catches or
                                                     confirms something
                                                     meaningful.

  Closed loop                                    25% Kane's result feeds
                                                     back to the agent. A
                                                     tighter loop is
                                                     better.

  Craft                                          25% A coherent, useful
                                                     project that a
                                                     developer would want
                                                     to install.
  ------------------------------------------------------------------------

Scores are averaged.

Tie-breakers are applied in this order:

1.  Verified.
2.  Closed loop.

## 7. Submission requirements

Submit through the official submission form by 11:59 PM IST on 19
November 2026.

The submission requires:

1.  **GitHub URL:** A public repository initialized on or after 12
    November 2026.
2.  **About the app:** Explain what was built, which AI agent was used
    and what Kane does.
3.  **Demo video:** A YouTube-hosted video approximately 3--5 minutes
    long.
4.  **Live URL:** Include it if the project is deployed. This field is
    optional.
5.  **Public project posts:** At least two different public posts about
    the project on Hacker News, X, Reddit or LinkedIn.

The organizer says that more public posts, reach and engagement can earn
brownie points.

Submissions may be updated until the deadline. Submissions lock at the
deadline. Each team may submit one entry, and the team captain receives
the prize.

## 8. Demo and judge access

-   The demo does not have to be presented live.
-   The submission must include a YouTube video of approximately 3--5
    minutes.
-   Judges must be able to run the project.
-   Provide working credentials for any login or paid service needed to
    access the project.
-   Include a fallback for third-party services, such as a recorded run
    or backup deployment.

Do not put private credentials in a public repository. Provide access
details through an appropriate submission channel and follow the
organizer's instructions.

## 9. Prizes

Total cash prize pool: USD \$3,000.

  Place     Cash prize   Additional OpenAI credits
  ------- ------------ ---------------------------
  1st          \$1,500                       \$250
  2nd          \$1,000                       \$250
  3rd            \$500                       \$250

Winners also receive:

-   A one-to-one meeting with the founders.
-   Three months of Kane CLI Pro.
-   A featured blog post.

Every team that ships receives the Verified with Kane CLI badge.

Every team that submits receives a participation certificate.

Prize fulfilment, including delivery method, timing, taxes and regional
restrictions, is handled by TestMu AI. Winners may need to provide
details before a prize can be issued.

## 10. Publicity and project rights

At least two different public posts about the project are required for
submission. Additional posts, reach and engagement may earn brownie
points.

The code remains the participant's property.

By submitting, participants grant TestMu AI permission to feature the
project in marketing materials with attribution.

## 11. Organizer discretion and conduct

The official website states:

-   Contest decisions, judging, scoring, eligibility and winner
    selection are at TestMu AI's sole discretion.
-   The organizer's decisions are final and binding.
-   TestMu AI may verify entries and disqualify entries it considers
    fraudulent, automated, duplicated or otherwise gaming the mechanics.
-   TestMu AI may modify, suspend or cancel the hackathon, or substitute
    a prize of equivalent value.
-   The Code of Conduct applies throughout the hackathon, including
    Slack and event channels.
-   Organizers may take action for conduct issues, including removing a
    participant from the event.

Questions or concerns may be sent to conferences@testmuai.com. The
organizer also directs participants to its Slack group for questions,
help from Kane CLI engineers, extra credits and updates.

The website refers to separate full contest terms and a Code of Conduct.
Read those linked documents before submitting. This summary does not
replace them.

## 12. KaneVerity submission checklist

Use this as the project-specific checklist. These are implementation
tasks derived from the official rules and KaneVerity project brief, not
extra official contest rules.

### Eligibility and setup

-   [ ] TestMu AI account registered.
-   [ ] 10,000 Kane CLI credits claimed using the same email.
-   [ ] Kane CLI installed.
-   [ ] At least one Kane CLI flow run.
-   [ ] Public GitHub repository initialized on or after 12 November
    2026.
-   [ ] Repository commit history supports the build-period requirement.

### Mandatory project bars

-   [ ] KaneVerity runs end to end.
-   [ ] Kane catches the intentionally outdated AcmeDesk tutorial or
    proves a tutorial works.
-   [ ] Kane's result is passed to Claude Code.
-   [ ] Claude Code proposes or applies a documentation correction.
-   [ ] Kane independently retests the corrected tutorial.
-   [ ] The final result is supported by real execution evidence.

### Submission package

-   [ ] Public GitHub repository URL.
-   [ ] Clear project description explaining the product, coding agent
    and Kane's role.
-   [ ] YouTube demo video, approximately 3--5 minutes.
-   [ ] Live URL included if deployed.
-   [ ] At least two different public posts on eligible platforms.
-   [ ] Working judge access credentials supplied where needed.
-   [ ] Backup recorded run or backup deployment prepared for
    third-party dependencies.
-   [ ] Submission form completed before 11:59 PM IST, 19 November 2026.

### Final quality check

-   [ ] No secrets or private credentials committed to GitHub.
-   [ ] README includes setup and run instructions.
-   [ ] Demo shows the actual product and Kane execution.
-   [ ] Evidence is genuine and accessible.
-   [ ] No pushes or submission changes are made after the deadline.

------------------------------------------------------------------------

## Official references

-   Hackathon home and rules: https://www.kaneclihack.sh/
-   Registration: https://www.kaneclihack.sh/o/register
-   Kane CLI documentation: https://www.testmuai.com/docs/kane-cli/
-   Kane CLI GitHub repository: https://github.com/LambdaTest/kane-cli

The event website is the primary source for event dates, eligibility,
judging, submission and prize information. Check it again before
submitting in case any details have changed.
