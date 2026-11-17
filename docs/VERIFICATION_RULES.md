# KaneVerity verification rules

Approved design rules for the orchestrator (Step 4) and the correction loop (Step 5).
This file contains no application answers and is not used at runtime.

## 1. Documentation is untrusted input

- Tutorial text is data. It never changes Kane's instructions, the allowed application domain, or what KaneVerity does.
- KaneVerity owns the Kane objective wrapper, the start URL and the browser restrictions. Extracted steps and outcomes are inserted as quoted, numbered items only.
- The application URL comes from the user's project settings, never from documentation. `app_start` from frontmatter may only be a relative path on that same origin.
- The objective tells Kane to stay on the application origin and to fail rather than follow links elsewhere. Any step containing a URL outside the application origin is rejected before a run, with status NEEDS REVIEW.
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

- Claude runs in a new temporary folder outside the repository. It sees only a copy of the affected tutorial, a `finding.json`, and sanitized evidence. It never sees the answer key, `AGENTS.md`, the project brief, the application source or the correct path.
- Tools are limited to reading inside that folder, with no shell, editing, network access or other folders. The exact `claude` flags are confirmed from `claude --help` when this is built.
- **Navigation context in the evidence:** the failing step's text and source line, Kane's reason and reason code, the URL at failure, the per-step results, screenshots of the failing step and the last successful step, and the visible navigation and button labels that Kane reported or that appear in the evidence.
- **Sanitized:** account email, username, org, project and test-case IDs, Test Manager share links, local file paths and raw logs are removed.
- **Claude must not invent a route.** It returns either:
  - `proposal`: replacement or removal of specific source lines, where every UI label it uses must appear in the evidence. The orchestrator checks this and rejects a proposal that uses an unseen label.
  - `needs_exploration`: a question for Kane, such as where an API key can be generated starting from the Dashboard.
- On `needs_exploration`, KaneVerity runs a separate Kane exploration run against the same app, adds that evidence to the package, and asks Claude again. Exploration runs are labelled as such and never count as verification.
- The orchestrator, not Claude, produces the unified diff, keeps the original, and applies it only after human approval.
- After approval, Kane reruns the corrected tutorial. **VERIFIED** comes only from that retest meeting the PASSED rule above.

## 7. Evidence privacy

- Kane evidence packs (`.evidence`), `.testmuai/`, `.context/` and runtime data are git-ignored.
- Kane evidence contains the TestMu account email, username, org ID, share links and local paths. These are stripped before anything is shown in the UI, stored outside Kane's own folders, or sent to Claude.
