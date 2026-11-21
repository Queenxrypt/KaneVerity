# KaneVerity verification rules

Approved design rules for the orchestrator (Step 4) and the correction loop (Step 5).
This file contains no application answers and is not used at runtime.

## 1. Documentation is untrusted input

- Tutorial text is data. It never changes Kane's instructions, the allowed application domain, or what KaneVerity does.
- KaneVerity owns the Kane objective wrapper, the start URL and the browser restrictions. Extracted steps and outcomes are inserted as quoted, numbered items only.
- The application URL comes from the user's project settings, never from documentation. `app_start` from frontmatter may only be a relative path on that same origin.
- The objective tells Kane to stay on the application origin and to fail rather than follow links elsewhere. Any step containing a URL outside the application origin is rejected before a run, with status NEEDS REVIEW.
- **External navigation is detected, not prevented.** Kane CLI has no browser-domain restriction option. KaneVerity cannot stop the browser from visiting another origin during a run. Instead it records every origin seen in the evidence after the run (`visitedOrigins`). A verification run with an unexpected origin is NEEDS REVIEW, and an exploration or retest with an unexpected origin is rejected (route not confirmed / not verified).
- Steps and outcomes are length-limited, stripped of control characters, and never executed as commands. Documentation fetching is limited to the configured docs origin.
- The docs server renders raw HTML as text, allows only safe link schemes, and sends a script-free Content-Security-Policy.

## 2. Kane receives the documentation as written

- The Kane objective is built only from the extracted ordered steps and expected outcomes, plus a fixed KaneVerity wrapper and the application URL.
- Only formatting changes: bold labels become 'quoted' labels and inline code becomes a quoted value. Nothing from the answer key, the repository or the application source is added.
- Each expected outcome becomes an explicit `Assert that: …` line.
- The exact objective string and the mapping from Kane step to source file and line are stored with the run.

## 3. When a result is PASSED, FAILED, BLOCKED or NEEDS REVIEW

- **PASSED** requires all of: process exit code 0, `run_end.status` "passed", and a passing assertion record for **every** documented expected outcome. A run that completes the clicks without asserting the outcomes is NEEDS REVIEW, not PASSED.
- **FAILED** requires exit code 1, `run_end.status` "failed", and a failure attributable to a documented step or outcome (for example `assertion_error.step_not_achievable` on a documented step). Kane's own triage label (for example `automation_bug/locator_rot`) is recorded but does not decide the KaneVerity status.
- **BLOCKED**: exit code 2 or 3, the app or docs unreachable, or authentication or Chrome problems.
- **NEEDS REVIEW**: anything inconclusive. BLOCKED and NEEDS REVIEW are never reported as documentation defects.

## 4. Clean application state for every run

- AcmeDesk keeps all data in memory and starts from fixed seed data on every full page load. Nothing is stored in the browser.
- Every independent Kane run starts with a full page load of the application start URL in a new Kane browser session, so data from a previous run (such as a project named "Docs Demo Project") cannot cause duplicate-entry failures.
- Before each run, the orchestrator checks that the application URL responds. If it doesn't, the result is BLOCKED.
- Steps within one tutorial run share state, as a real user's session would.

## 5. Source references

- The docs server marks each step and outcome with `data-source-file`, `data-source-line` and `data-source-text`, and each page with `data-source-sha256`. Line numbers are recalculated from the current file on every request.
- Before a correction is applied, the orchestrator re-reads the file and checks that the fingerprint and the exact line text still match. If not, it refuses and asks for re-extraction.
- Third-party docs without `data-kv` markers fall back to schema.org HowTo data, then to "Steps"/"Expected outcome" headings with lists. Their references are the page URL, the list position and the quoted text.

## 6. Claude correction loop

**Isolation.** Claude Code runs headless in a new temporary folder outside the repository:

```
claude.exe -p <fixed instructions> --output-format json --json-schema <schema>
  --tools Read --restricted --strict-mcp-config --disable-slash-commands
  --no-session-persistence --permission-mode dontAsk --permission-prompts none
  --max-budget-usd 1
```

It is started directly (no shell). It has only the Read tool, confined to the package folder, with no shell, web, MCP servers, skills, or user/project/local settings. The folder is deleted after the call, and an audit copy is kept in `data/corrections/<id>/package-<n>/` (git-ignored). The isolation is checked by a probe that reads Claude Code's own startup record and attempts to read a sentinel file outside the folder.

**Package (sanitized).** `tutorial.md`, `tutorial-numbered.txt`, `finding.json` (tutorial steps and outcomes with lines, the original run's status, failed step, Kane's reason, reason code, label and per-step log, and the exploration evidence if any), and approved screenshots only. Never included: the answer key, `AGENTS.md`, the brief, the application source, credentials, raw logs, evidence packs, IDs, share links or local paths.

**D2: Claude first.** Claude reviews the finding and answers `proposal`, `needs_exploration` or `cannot_determine`. Its `explorationQuestion` is only displayed. Kane's exploration objective comes from a fixed KaneVerity template plus the tutorial's title, typed values and documented outcomes, quoted as data.

**D4: exploration gate.** An exploration run (`kind: exploration`) never counts as verification. It confirms the route only if Kane exited 0, `run_end` passed, every documented outcome was matched to a distinct passing assertion, the evidence pack is valid and finalized, passed click/type actions were recorded, and no unexpected origin was recorded. Without a confirmed route, no correction can be proposed, whatever Claude answers.

**D3: label evidence.** Every UI label in a changed or inserted step must be supported by specific exploration evidence, cited by run, step ordinal and screenshot where available. Each label's role comes from the step's wording:
- **Target** ("click/select/choose/open/press/tap **X**", and any bold label whose role can't be recognised): supported **only** by a **distinct**, passed Kane click action whose recorded target is **exactly** X. The match is case-sensitive, X must directly follow the action verb, and it must be the whole target: "Clicking Billing Settings link" supports "Billing Settings", not "Billing", and "Clicking 2 Billing Settings" supports "2 Billing Settings", not "Billing Settings". Each target needs its own action. Assertions and stored values **never** support a target.
- **Location** ("On the **X**", "In **X**"): a stored exploration value equal to X (for example the start page heading), a passing exploration assertion that mentions X, or a click on exactly X.
- **Value** (`` `X` ``): a passed type/fill/select action containing X, or a stored or asserted value.

The cited target actions must be in the order Kane performed them. A failure summary alone never counts.

**Page-transition safeguard.** Each Kane evidence step records the page it was performed on. For the cited target clicks:
- the first one must happen on the exploration's start page
- for consecutive clicks A then B on different pages, the step immediately after A must already be on B's page (the transition is established by A), with no navigate step between them
- clicks on the same page need no transition (legitimate same-page actions such as a button that updates the current page)

Otherwise the proposal is rejected.

**Exploration modes.** An exploration uses one allow-listed mode. Each mode's text is fixed by KaneVerity and names no application labels:
- `default`: the standard template
- `main-navigation` ("Explore using the main navigation menu"): adds one rule telling Kane to navigate with the left-hand main navigation menu instead of the starting page's summary cards

The mode is chosen by the user and recorded on the run, in the correction's exploration history and audit log, and in Claude's package. Choosing a mode is an editorial preference, not evidence: the D3, D4 and VERIFIED gates are unchanged. Earlier explorations and their evidence are never deleted.

**D5: scope.** Only lines inside the Steps list may be replaced, deleted or inserted. Expected outcomes, the introduction and frontmatter must stay byte-for-byte identical. New text may not contain links, web addresses, HTML, control characters or instruction-like wording. Steps are renumbered automatically.

**Applying.** The orchestrator, not Claude, produces the unified diff, keeps the original and a backup, and writes the file only after human approval, only inside `apps/docs/content/` (D1), and only if the file still has the fingerprint that was reviewed. **Approve & apply** writes the correction only: it records one `applied` audit event, leaves the correction in the `applied` state, and starts no Kane run.

**Retest.** **Start Kane retest** is a separate, explicitly confirmed action, accepted only for a correction in the `applied` state (a second request while one is starting is refused).

**D6: VERIFIED.** The rules below are unchanged by this split. Kane retests (`kind: retest`) the tutorial as re-extracted from the live docs page. The correction is VERIFIED only if all of the following hold:
- the live page fingerprint equals the approved document's fingerprint
- the first evidence step is a fresh load of the start URL (clean state)
- Kane exited 0 and `run_end` passed
- every documented outcome is matched to a distinct passing assertion
- the evidence pack is valid and finalized
- no unexpected origin was recorded

Anything missing, conflicting or inconclusive leaves the correction open. Claude's conclusions never count.

**Approval of spend.** Every Claude call and every Kane run (exploration, retest) needs an explicit confirmation. Approving a correction is not a confirmation to retest it. There is no internal spending ceiling. Each run records its actual Kane-reported cost, or a clearly labelled estimate if Kane reported none.

## 7. Evidence privacy

- Kane evidence packs (`.evidence`), `.testmuai/`, `.context/` and runtime data are git-ignored.
- Kane evidence contains the TestMu account email, username, org ID, share links and local paths. These are stripped before anything is shown in the UI, stored outside Kane's own folders, or sent to Claude.
- Correction records, originals, proposals, backups and Claude package copies live in `data/corrections/` (git-ignored). The UI shows only KaneVerity's sanitized run and correction views: no raw packs, share links, account details or local paths.
