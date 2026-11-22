# KaneVerity: Kane Assurance integration plan

Approved B0 research and architecture (Phase B). This is the reference for phases B1-B7.
It adds to the original build brief (`docs/PROJECT_BRIEF.md`) and `AGENTS.md`; it never replaces
or narrows them. The existing correction loop, evidence handling, privacy controls, audit history
and VERIFIED gate (`docs/VERIFICATION_RULES.md`) stay in force.

Sources: the installed Kane CLI **0.10.5** (`--help` of every command) and the official
documentation at the **`0.10.5` tag** of `LambdaTest/kane-cli` (`docs/user-guide/assurance/*`,
`.claude/skills/kane-cli/references/*`). Statements are marked **[help]** (installed CLI),
**[docs]** (official docs at 0.10.5) or **[UNVERIFIED]** (needs a controlled validation run).

## 0. Confirmed decisions

1. **Storage:** a local Assurance store under `data/assurance/` (git-ignored), created with an
   explicit `--local`, run with `KANE_CONTEXT_GITIGNORE=0` so Kane never edits the repository's
   `.gitignore`.
2. **Engines:** direct `kane-cli run` stays for correction explorations and as a fallback.
   Assurance becomes the primary verification engine as the integration progresses.
3. **Version:** Kane CLI is pinned to **0.10.5** for B1-B6. An upgrade (0.10.7 exists) needs the
   contract re-read first.

## 1. The Assurance lifecycle

```
context ingest -> context extract -> context review -> design tests -> context review
   -> testmd run / testrun run (author once, then replay) -> evidence pack -> cover -> maintain reconcile
```

- **Source:** an ingested document. Same id with new bytes = a new **version**; everything built
  from the old version becomes `stale` [docs].
- **Use case:** something a user must accomplish, extracted with citations to exact source lines.
- **Acceptance criterion (AC):** one checkable promise with an oracle.
- **Scenario:** one path through a use case. Exactly **one test per scenario**, a `*_test.md` file.
- **Trust:** agent output starts `derived`; human review makes it `trusted` or `archived`.
- **Gaps:** recorded, ranked missing coverage.
- **Coverage:** two axes, **proven** (from an evidence pack) and **designed** (from the graph).

## 2. Command reference

| Command | Purpose and key inputs | Outputs / storage | Agent work / credits |
|---|---|---|---|
| `context ingest <src...>` | Snapshot files, then extract. `--as <id>`, `--mode interactive/agent/ci/override`, `--plan`, `--force`, `--trust auto/hold`, `--local`, `--project <id>` [help] | `.context/` store; `ingested` events [docs] | `--mode ci` lands only: **free**. `--mode agent` also extracts: **credits** [docs] |
| `context extract` | Propose use cases. `--mode`, `--plan`, `--resume`, `--answer id=v`, `--message`, `--with-source`, `--trust`, `--local` [help] | `derived` use cases with citations; `commit`, `receipt` [docs] | **Credits** (`usage` events) |
| `context review` | `--verdicts <file>` (`[{ref, resolution}]`, approved/edited/rejected/skipped/supersede, all or nothing), `--approve/--skip/--defer`, `--allow-archive --because` [help, docs] | Trust changes | **Free** |
| `context list` / `explain` | `--json`, `--inferred`, `--stale` [help] | Rows; full history and citations | **Free** |
| `design tests` | `--use-case`, `--max <n>` (pairs, not credits), `--mode agent`, `--phase`, `--allow-unreviewed`, `--force`, `--plan` [help] | ACs, scenarios, gaps, `.testmuai/tests/t-*_test.md` with `assurance:{id, base}` and `@verifies ac-...`; variable stubs in `.testmuai/variables/assurance.json` [docs] | **Credits** |
| `testmd run <file>` | Author once, then replay. `--agent`, `--headless`, `--url`, `--no-adaptive-heal`, `--author`, `--policy`, `--push` [help] | `output-<stem>/`, `Result.md`, sealed pack; ends with `test_md_done` [docs] | Authoring: credits; replay: a few [docs] |
| `testrun run [paths]` | One execution of many tests. `--from-context <t-ids>`, `--match`, `--tags`, `--dry-run`, `--no-adaptive-heal`, `--parallel`, `--agent` [help] | One sealed pack; `testrun_plan`, `testrun_member_end`, `testrun_summary`, `testrun_done{overall_status, coverage}`; exit 0/1/2/3 [docs] | Authoring "about 30-85 credits per test", replay "a few" [docs]. The local stream has **no credit total**: measure by balance before/after |
| `cover [--from <pack>]` | `--json`, `--mode agent/ci` [help] | Proven coverage of one pack + completeness; one `coverage` event then `done` [docs] | **Free** |
| `cover gaps [uc]` | `--stage`, `--top`, `--json`, `--mode` [help] | Per use case: designed, proven, debt, ready commands [docs] | **Free**; refused in a shared project |
| `maintain reconcile` | `--from <new file>`, `--source-id`, `--plan`, `--apply [path]`, `--mode agent/ci` [help] | Rows ADD / MODIFY / ARCHIVE; `reconcile_*` events. **ARCHIVE is never applied headless**: exit 3, a human runs `--apply` in a terminal [docs] | **Credits** |
| `maintain evolve [ref]` | `--from-stale`, `--because`, `--mode agent`, `--answer evolve:<uc>=1/2` [help] | `evolve_target`, `evolve_paused`, `evolve_diff` [docs] | **Credits** |
| `explore` | Map an app's screens and flows [help] | Cloud (HyperExecute), needs a Test Manager project and an LT tunnel for localhost [docs] | **Credits**; not adopted (out of MVP scope) |

Shared agent-mode rules [docs, `assurance-parsing.md`]: strict NDJSON `{"type","v":1,"verb",...}`;
an open vocabulary (tolerate unknown events); exactly one terminal `done{status, exit_code, next?}`;
exit `3` = **paused** (resumable), not failed; no `done` = crash. `session_paused` carries `sid`, a
verbatim `resume`, a 24 h expiry and `pending_questions[{id, text, risk, rationale, options[{label,
detail, input?}], recommended_index, allow_free_text}]`. Since 0.8.8 every question pauses in agent
mode. The store is single-writer: never two store-writing commands at once.

## 3. Mapping the 12 stages onto KaneVerity

| # | Stage | Kane | KaneVerity |
|---|---|---|---|
| 1 | Extract tutorial | - | Existing discovery + Phase A freshness guard |
| 2 | Requirements with references | - | **B1:** deterministic requirements Markdown per tutorial, each line mapped to `file:line` + document fingerprint. Must be a **file**: Kane fetches URLs server-side and refuses private addresses [docs] |
| 3 | Ingest | `context ingest req.md --as kv-<tutorialId> --local` | Stable source id per tutorial; each document version = a source version |
| 4 | Use cases with references | `context extract --mode agent` | Citations mapped back to documentation lines |
| 5 | Use-case review | `context list --json --inferred`, `explain --json`, `review --verdicts` | Review screen; only the user's decisions become verdicts |
| 6 | ACs and scenarios | `design tests --use-case ... --mode agent --max <n>` | Kane's questions shown to the user, never auto-answered |
| 7 | Design review | `context review --verdicts` | Design-review screen + **fidelity check** (section 7.3) |
| 8 | Test files | `t-*_test.md` from design | Stored with their `base` pin and `@verifies` tags |
| 9 | Execute | `testrun run --from-context <t-id> --agent --headless` | Replaces direct `run` for verification and retest |
| 10 | Evidence | Sealed pack | Existing validation, redaction, screenshot and origin checks reused |
| 11 | Coverage | `cover --from <pack>`, `cover gaps` | Shown on runs and tutorials; part of the VERIFIED gate |
| 12 | Documentation change | `maintain reconcile --from req-v2.md --source-id kv-<id>` | Joins the correction loop after approval (section 7.7) |

## 4. Documented vs UNVERIFIED

Documented: the envelope, `done`, `session_paused`, the pause/answer/resume loop, exit codes, event
names for extract/design/reconcile/evolve/cover, testrun events and exit codes, the test-file format,
the store layout, which commands are free.

**[UNVERIFIED]:** exact payloads of `commit` / `receipt` / `ingested`; row shapes of
`context list --json` and `explain --json`; the full `cover --json` / `gaps` documents and the
pack's `coverage/usecases.yaml` fields; whether `design tests` keeps **exact UI labels and step
order**; whether authored tests replay from a clean start in a fresh session; how a failing
`step_index` maps to a documentation step; real credit costs of extract and design; whether
testmd/testrun report credits per step; `--local` store creation without prompts on this machine;
reconcile's ARCHIVE pause in practice; whether `--no-adaptive-heal` fully prevents re-authoring.

## 5. Storage (decided: local store)

| | Local store (`--local`) | Test Manager shared project |
|---|---|---|
| Lives | `.context/` on disk, append-only, single writer | Cloud project |
| Human review | `context review` + verdicts available | **No `context review`**; design needs `--allow-unreviewed` |
| Coverage | `cover gaps` available | `cover gaps` refused |
| Reconcile | `--plan` / `--apply` available | refused |
| Fresh clone | Starts empty; re-ingest; extract/design cost credits again (or `context sync`) | Join the project |
| Privacy | Requirements go to KaneAI for extract/design (public docs, no secrets) | Same, plus stored in the cloud |

Workspace: `data/assurance/<project>/` (git-ignored), `KANE_CONTEXT_GITIGNORE=0`, one assurance job
at a time sharing the existing Kane run queue.

## 6. Costs

| Stage | Credits | Estimation |
|---|---|---|
| ingest `--mode ci`, review, list, explain, cover, cover gaps, `testrun --dry-run`, evidence validate | Free | "no credits" |
| extract, design, reconcile, evolve | Yes, per turn (`usage`, `total_credits`) | "Unknown until measured" until validation runs; record the reported total |
| testrun / testmd authoring | "About 30-85 per test" [docs] | Balance before/after (jobs run one at a time) |
| Replay | "A few" | Balance before/after |

Every paid step needs explicit approval with its estimate. No internal ceiling.

## 7. Architecture

### 7.1 Backend (`apps/orchestrator/src/assurance/`)
- `requirements.ts` (**B1**): deterministic requirements Markdown; documented steps and outcomes
  only, quoted; fixed KaneVerity framing; application URL only as `{{app_url}}`; no answer key,
  source code or project files.
- `job.ts` (B2): allow-listed spawn, no shell, workspace cwd; NDJSON parser per the documented
  contract (unknown events tolerated, missing `done` = crash); pause/answer/resume; `next[]`
  display-only; redaction; private raw streams.
- `workspace.ts` (B2): store and `.testmuai/` location; variables file (application URL only).
- `review.ts` (B3), `execute.ts` (B5).

### 7.2 Data models
- `RequirementsArtifact` (**B1**): `{tutorialId, version, docSha256, reqSha256, sourceRefs, lineMap,
  createdAt, generatorVersion}`; versions append-only.
- `AssuranceJob` (B2): `{jobId, kind, args, state, sid, pendingQuestions, answers(by user),
  exitCode, doneStatus, credits{reported, basis}, balanceBefore/After, eventsPath(private)}`.
- `ReviewRecord` (B3), `DesignedTest` (B4), run-record additions (B5), correction additions (B6).

### 7.3 Fidelity check (the documentation as written)
A designed test for the documented journey must keep every quoted UI label, exactly and in order;
each documented outcome needs an assert step whose `@verifies` AC maps to it; no undocumented actions
on the main path. A failing test cannot be approved for verification.

### 7.4 Classification (kept)
- **PASSED:** exit 0, `testrun_done.overall_status=passed`, member passed, **not healed**, valid and
  finalized pack, every documented outcome's AC `execution: passed` (each its own AC), only expected
  origins.
- **FAILED:** exit 1 with a failed member whose failure maps (fidelity step map) to a documented
  step or outcome.
- **BLOCKED:** exit 2/3, refusals, authentication, or ACs `blocked` with none failed.
- **NEEDS REVIEW:** anything else, **including any healed or re-authored replay**.

### 7.5 VERIFIED gate (added to, never weakened)
All existing conditions stay. With an Assurance retest, also: the store's source version is the
requirements generated from the approved document fingerprint; the designed test passed the fidelity
check and was human-approved for that version; the pack's `definition_id` matches it; every
documented outcome's AC is `execution: passed` in the retest's own pack; the replay was not healed.

### 7.6 Stays on direct `run`
Correction explorations (Claude's D3 evidence). `explore` is cloud-only and general-purpose
exploration, out of MVP scope.

### 7.7 Corrections through reconcile (B6)
Approve & apply (unchanged) -> requirements v2 from the new fingerprint -> confirmed
`maintain reconcile --from req-v2.md --source-id kv-<id> --mode agent` (ADD/MODIFY apply; ARCHIVE
pauses for a terminal `--apply`) -> re-design and design review -> confirmed retest -> VERIFIED per 7.5.

### 7.8 API and UI
- `GET /api/assurance/requirements`, `GET/POST /api/assurance/requirements/:tutorialId` (**B1**).
- `POST /api/assurance/jobs`, `GET /api/assurance/jobs/:id`, `POST .../:id/answer` (B2).
- `GET/POST /api/assurance/review` (B3), `GET /api/assurance/coverage` (B5), `engine: 'assurance'` on runs (B5).
- UI: Verification material per tutorial (**B1**: requirements; later use cases, design, questions),
  coverage on runs, reconcile and design review on corrections, coverage on the Dashboard.

## 8. Human approval points
Requirements generation (free, reviewed preview); ingest + extract (credits); use-case review;
design (credits); design review (fidelity must pass); authoring/execution (credits); correction
approval (unchanged); reconcile (credits, ARCHIVE in a terminal); retest (credits). Kane's questions
are answered by the user only; `next` is never auto-run; no `--allow-unreviewed`, `--allow-archive`
or `--force` without the user's instruction.

## 9. Security and privacy
Requirements contain only extracted documentation text, treated as untrusted (quoted, length-limited,
URLs rejected, variable syntax neutralised); they are sent to KaneAI for extract and design. Authored
tests sync to the user's Test Manager [docs]. Redaction of account email, org id, share links and
paths before storing publicly, showing or sending to Claude. Variables file: application URL only.
Allow-listed arguments, no shell. `.context/`, `.testmuai/` and packs stay under `data/`. Single
writer; locks never deleted; no destructive store commands unless the user asks.

## 10. Risks
Fidelity of designed tests (high); healing masking defects (high; `--no-adaptive-heal`, healed =
NEEDS REVIEW); ARCHIVE needs a terminal; credit uncertainty; version drift (pinned 0.10.5); store
portability; unobserved event fields.

## 11. Phases
| Phase | Content | Credits |
|---|---|---|
| **B1** | Requirements generator, line map, versioned store, stale detection, preview UI, tests | None |
| B2 | Job runner: spawn, NDJSON parser, pause/answer loop, redaction, serialization, credit tracking; tested against a fake CLI built from the documented contract | None, then V0 |
| B3 | Ingest, extract, use-case review | V1 |
| B4 | Design, design review, fidelity check | V2 |
| B5 | Execution via testrun, classification, evidence, coverage | V3, V4 |
| B6 | Corrections: reconcile, re-design, Assurance retest, extended VERIFIED gate | V5 |
| B7 | Reporting: coverage, history, docs | None |

Visual identity and UI/UX run on a separate track.

## 12. Validation runs (each needs the user's approval)
Workspace `data/assurance/acmedesk/`, `KANE_CONTEXT_GITIGNORE=0`, API-key tutorial.

| ID | Command | Purpose | Credits |
|---|---|---|---|
| V0 | `context ingest req-generate-an-api-key.md --as kv-generate-an-api-key --mode ci --local`; `context list --json`; later `testrun run --dry-run` | Store creation, `--local`, real `ingested` and list shapes | Free (local store only) |
| V1 | `context extract --mode agent --local` | Extract stream, questions, citations | Yes, unknown (measured) |
| V2 | `design tests --use-case <uc> --mode agent --max 1` | Test file, **label fidelity**, variables | Yes, unknown |
| V3 | `testrun run --from-context <t-id> --agent --headless` (corrected tutorial) | Authoring, pack, coverage YAML; expect PASSED | ~30-85 |
| V4 | Same flow on the outdated tutorial (or Configure workspace settings) | Does Assurance catch the defect? Expect FAILED | Extract + design + authoring |
| V5 | `maintain reconcile --from req-v2.md --source-id kv-<id> --mode agent`, then replay with `--no-adaptive-heal` | Reconcile rows, ARCHIVE pause, retest | Yes |
| - | `cover --from <pack> --mode agent`, `cover gaps --mode agent`, `evidence validate` | Coverage and pack checks | Free |
