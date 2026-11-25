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

**[VALIDATED by V0]** (section 12.1): `context ingest --mode ci --local` creates the local store
without prompts on this machine and lands the file only; the `--mode ci` receipt line; the
`context list --json` row shape for a **source** row.

**[VALIDATED by V1]** (section 12.2): the `context extract --mode agent` stream for a clean
completion (`run_start`, `corpus`, `source_start`, `agent_activity`, `usage`, `commit`, `done`); the
`commit` payload (counts + `minted[]` + `source_id` + `proposal_id`); per-turn `usage` with a
running `total_credits` that matches the balance difference; `--local` accepted on `extract` in a
folder that already has a store; the `context list --json` row for a **use case**; the shape of
`context explain --json` (history only).

**[VALIDATED in B3]** (section 12.3): `context view --json` returns the full graph payload and is
read-only; `context fsck --json` returns `{ok, issues, records}` and is read-only; citation quotes
and claims exist only on the committed `DERIVES` edges (`props.anchor/quote/claim`), not in `view`.

**[UNVERIFIED]:** the extract stream when Kane pauses with questions, crashes or holds items (V1
completed without any of these); `receipt` and `ingested` payloads (not emitted in V1); row shapes of
`context list --json` for AC, scenario and test rows;
the full `cover --json` / `gaps` documents and the pack's `coverage/usecases.yaml` fields; whether
`design tests` keeps **exact UI labels and step order**; whether authored tests replay from a clean
start in a fresh session; how a failing `step_index` maps to a documentation step; credit costs of
design and of larger or multi-source extractions (one small extraction cost 4.83, section 12.2);
whether testmd/testrun report credits per step; reconcile's
ARCHIVE pause in practice; whether `--no-adaptive-heal` fully prevents re-authoring.

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
- **B3 (built):** `storeReader.ts` (strict read-only reader for the committed records), `citations.ts`
  (citation checks and documentation tracing), `review.ts` (KaneVerity review rules and the design
  gate), `usecases.ts` (retrieval, cross-checks, snapshots, decisions). Later: `execute.ts` (B5).

### 7.2 Data models
- `RequirementsArtifact` (**B1**): `{tutorialId, version, docSha256, reqSha256, sourceRefs, lineMap,
  createdAt, generatorVersion}`; versions append-only.
- `AssuranceJob` (B2): `{jobId, kind, args, state, sid, pendingQuestions, answers(by user),
  exitCode, doneStatus, credits{reported, basis}, balanceBefore/After, eventsPath(private)}`.
- `ReviewEntry` (**B3**): `{ucCid, decision, reason, acknowledgedGaps, gapsAtDecision, snapshot, at,
  by: "kaneverity-review"}`, append-only per tutorial; use-case snapshots append-only per retrieval.
- `DesignedTest` (B4), run-record additions (B5), correction additions (B6).

### 7.3 Fidelity check (the documentation as written)
A designed test for the documented journey must keep every quoted UI label, exactly and in order;
each documented outcome needs an assert step whose `@verifies` AC maps to it; no undocumented actions
on the main path. A failing test cannot be approved for verification. Built in B5 (section 13.4),
with one criterion, scenario and test per outcome; it checks the design only and is never evidence.

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
- `GET /api/assurance/usecases/:tutorialId`, `POST .../retrieve` (free reads; needs mode `free` or
  `all`), `POST .../:ucHex/review` (**B3**).
- `GET /api/assurance/coverage` (B5), `engine: 'assurance'` on runs (B5).
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
| **B3** | Ingest, extract, use-case review (built; review in KaneVerity only, section 12.3) | V1 |
| **B4** | Use-case approvals recorded in Kane and verified; extended design gate (built, section 12.4). Design, design review and the fidelity check follow with their own approval | V-B4a (free), then V2 |
| **B5** | Test-design review: design read, deterministic checks, review history, app_url approval, readiness (built, section 13) | V2 (done), then a forced redesign |
| B6 | Execution via testrun, classification, evidence, coverage | V3, V4 |
| B7 | Corrections: reconcile, re-design, Assurance retest, extended VERIFIED gate | V5 |
| B8 | Reporting: coverage, history, docs | None |

Visual identity and UI/UX run on a separate track.

## 12. Validation runs (each needs the user's approval)
Workspace `data/assurance/workspace/` (git-ignored), `KANE_CONTEXT_GITIGNORE=0`, API-key tutorial,
source id `kv-generate-an-api-key`.

| ID | Command | Purpose | Credits |
|---|---|---|---|
| V0 | `context ingest requirements/generate-an-api-key.md --as kv-generate-an-api-key --mode ci --local`; `context list --json` | Store creation, `--local`, receipt and list shapes | Free. **Done 2026-11-22: passed, 0 credits** (12.1) |
| V1 | `context extract --mode agent --local --source kv-generate-an-api-key` | Extract stream, questions, citations | **Done 2026-11-22: complete, 4.83 credits** (12.2) |
| V2 | `design tests --use-case <uc> --mode agent --max 1` | Test file, **label fidelity**, variables | Yes, unknown |
| V3 | `testrun run --from-context <t-id> --agent --headless` (corrected tutorial) | Authoring, pack, coverage YAML; expect PASSED | ~30-85 |
| V4 | Same flow on the outdated tutorial (or Configure workspace settings) | Does Assurance catch the defect? Expect FAILED | Extract + design + authoring |
| V5 | `maintain reconcile --from req-v2.md --source-id kv-<id> --mode agent`, then replay with `--no-adaptive-heal` | Reconcile rows, ARCHIVE pause, retest | Yes |
| - | `cover --from <pack> --mode agent`, `cover gaps --mode agent`, `evidence validate` | Coverage and pack checks | Free |

The V0 plan also listed `testrun run --dry-run`; it was left out (no designed tests exist yet) and
moves to after V2.

### 12.1 V0 results (validated 2026-11-22, Kane CLI 0.10.5)

Run directly (no shell) from `data/assurance/workspace/`, stdin closed, `KANE_CONTEXT_GITIGNORE=0`.
The input was requirements version 1 (`b210e73c…`, state current, intact).

| Command | Exit | Result |
|---|---|---|
| `kane-cli --version` | 0 | `0.10.5` |
| `kane-cli balance` (before / after) | 0 / 0 | `Available credits: 10965.5197` both times: **0 credits used** |
| `context ingest requirements/generate-an-api-key.md --as kv-generate-an-api-key --mode ci --local` | 0 | Receipt `created  kv-generate-an-api-key  source sha256:6ee2d0e7…  blob sha256:55709884…`; stderr `landed 1 source(s) — run kane-cli context extract to extract them` |
| `context list --json` | 0 | One row (below) |

**Validated against the docs:** the store is created on the first ingest; `meta.json`
(`{"schema":"assurance/context@1","canonicalizer":"v1"}`), `store.json` (lineage and instance ids,
creation time), `commits/` (one append-only ingest commit, `created_by.build: 0.10.5`), `blobs/`
and `derived/` exist; `--mode ci` lands only and nothing is extracted; the receipt and stderr
guidance match the documented `--mode ci` contract. Not created yet, consistent with no
extraction: `proposals/`, `sessions/`, `locks/`, `logs/`, `design/`, `reconcile/plans/`.

**Findings to keep in mind:**

1. **`context list --json` source row** (one JSON object per line, observed):
   `{"id":"kv-generate-an-api-key","cid":"sha256:6ee2d0e7…","label":"source","title":"kv-generate-an-api-key","trust":"-","fresh":"fresh"}`.
   A source row has `trust: "-"`. Use-case and design rows are still UNVERIFIED.
2. **Extra ingest notice.** Before the documented receipt line, `--mode ci` printed
   `✓ Working locally` / `this folder now has its own context store; its work stays on this machine`.
   Receipt parsing must scan every line (B2's parser does) and never assume the receipt is first.
3. **Undocumented `.context/intents/` directory** (one intent per write, e.g. the ingest intent with
   its source id, blob, label and media). It is Kane's internal store state: never edited, merged or
   relied on by KaneVerity.
4. **Kane's blob id is not the requirements SHA-256.** The stored blob is byte-identical to
   requirements v1, but its id is `sha256:55709884…` while the file's SHA-256 is `b210e73c…`
   (the canonicalizer applies). KaneVerity must compare **content** (or its own fingerprints), never
   Kane's internal ids against KaneVerity fingerprints.
5. **Kane-managed profile state outside the project.** Kane also wrote under `~/.testmuai/kaneai/`:
   `assurance/bindings.json` (the binding of this folder to its store), a manifest for this store's
   instance (`assurance/ctx-<instance id>/manifest.ndjson`), `assurance/no-context/manifest.ndjson`,
   `assurance/identity-prod.json` and a TLS certificate file. This is Kane's own profile state:
   KaneVerity never reads its account files, never edits or deletes it, and treats it as outside the
   project. Consequence: deleting the workspace alone may leave Kane's binding record behind; any
   clean-up of profile state is the user's decision, done with Kane's own commands.
6. Kane offered an upgrade (0.10.5 → 0.10.7) and its agent skill; neither was installed (version pin).

Unchanged by V0 (fingerprinted before and after): all 133 tracked repository files, `.gitignore`,
all 187 project data files outside the workspace (run evidence, correction data, requirements,
credit ledger). No personal data in the store.

### 12.2 V1 results (validated 2026-11-22, Kane CLI 0.10.5)

**Preceded by a free landing through the runner** (orchestrator in `free` mode): job
`j20261122-143953-4bb934`, `context ingest requirements/generate-an-api-key.md --as kv-generate-an-api-key --mode ci --local`,
exit 0, receipt `unchanged  kv-generate-an-api-key  source sha256:6ee2d0e7…  blob sha256:55709884…`
(no "Working locally" notice and no stderr line on an unchanged landing), store byte-for-byte
unchanged, 0 credits. This gave the runner the landing record it requires before extract.

**The approved extraction** (orchestrator in `all` mode only for this job, returned to `off`
immediately after): job `j20261122-150605-508b2c`, started once from the Verification material
page with the paid confirmation.

- Command (B2 runner, `--local` kept): `kane-cli context extract --mode agent --local --source kv-generate-an-api-key`,
  run in `data/assurance/workspace/` with no terminal and `KANE_CONTEXT_GITIGNORE=0`.
- Lifecycle: queued → running (15:06:05Z) → complete (15:06:47Z, ~42 s). Exit 0, `done{status: "complete", exit_code: 0}`.
  No pause, no questions, no warnings, no errors, nothing held, no unknown event types, no non-JSON
  lines, empty stderr. `--local` was accepted on a folder that already had a store.
- Stream (20 NDJSON lines): `run_start` (trace path and support id, kept private) → `corpus`
  (1 source) → `source_start` (`resumed: false`) → `agent_activity` (tool and decision labels) →
  `usage` 3.75 → `usage` 1.08 (`total_credits` 4.83) → `commit` → `done`. **Not emitted**, unlike the
  documented example: `session_complete` and `receipt`. The runner depends on neither.
- `commit` payload: `{source_id, proposal_id: "20261122T150616-kv-generate-an-api-key", trusted: 0, derived: 1, archived: 0, superseded: 0, assumed: 0, evidence_matched: 0, minted: [{cid, logical_id: "uc-1"}]}`.
- **Cost: 4.83 credits, reported by Kane**, and matched by the balance difference
  (10965.5197 → 10960.6855 = 4.8342). Ledger entry `{basis: "reported", kind: "assurance:extract"}`.

**Store changes** (all inside the workspace): `commits/000002-…` (one use-case node and six
`DERIVES` edges from the source), `derived/` caches (`index.json`, a node file for `uc-1`), a new
`intents/` entry, and `proposals/20261122T150616-kv-generate-an-api-key/` (`proposal.json`,
`review.json`). Not created: `sessions/`, `locks/` (transient), `logs/` (the trace is outside the
store), `signals.ndjson`. The source head is unchanged (`sha256:6ee2d0e7…`).

**The use case `uc-1` "Generate an API key"** (read with free commands and from the committed
record): risk high; actor "application user"; description and four criteria that name the
documented labels exactly and in order ('Developer Settings', 'API Keys', 'Generate Key') and the
three documented outcomes. `trust: "derived"` (unreviewed): `context list --json --inferred` lists it,
and nothing was approved.

**Citations** (each a `DERIVES` edge with `anchor` and `quote`): every quote matches the cited
requirements line exactly. Mapped through the requirements line map:

| Anchor | Quote | Requirements item | Documentation |
|---|---|---|---|
| L23 | the use-case sentence | KaneVerity framing | (no documentation line) |
| L19 (range L18-L19) | "The journey starts at {{app_url}}/ in a fresh browser session." | KaneVerity framing | (no documentation line) |
| L37 | O1 | O1 | `tutorials/generate-an-api-key.md:24` |
| L38 | O2 | O2 | `tutorials/generate-an-api-key.md:25` |
| L39 (and a range L37-L39) | O3 / O2 | O3 / O2 | `:26` / `:25` |

**Findings and limitations:**

1. **The documented steps are not cited.** No citation points at S1-S3 (requirements lines 29-31,
   documentation lines 18-20). The criterion "select 'Developer Settings', 'API Keys', and 'Generate
   Key' in that order" is cited only to line 19, which contains none of those labels. The labels and
   order are correct, but their provenance is not cited. B3/B4 must treat step coverage as **not
   proven by citation** and check it with the fidelity check (section 7.3), not trust it.
2. **`context explain --json` returns history only** (`target` + `entries[]`: minted, named), not
   content or citations. Use-case content and citations were read from the committed record and
   `proposal.json`. B3 needs a supported read path for content (to confirm: `context view --no-open
   --out`, or the `proposal.json` artefact) before displaying use cases. *(Resolved in B3: section 12.3.)*
3. **Kane auto-recorded a "skipped" review verdict** in `review.json`, attributed to
   `{"kind": "human", "id": "owner"}`, although no person reviewed anything (headless `--trust auto`).
   A skip leaves the item queued (`derived`). KaneVerity must never treat Kane's attribution as a human
   decision; approvals come only from KaneVerity's own recorded review.
4. **Use-case and requirements criteria are hints, not oracles** (docs): the four criteria restate
   the outcomes; acceptance criteria are minted only by design (V2).
5. The Dashboard cost line now includes this Assurance job but still says "verifications,
   explorations and retests": wording to correct (follow-up). *(Fixed in B3.)*

**Unchanged by V1** (fingerprinted): all 133 tracked repository files; all project data outside the
Assurance workspace and job records except `data/credits.json`, which gained exactly one entry (the
earlier six untouched); requirements version 1 (`b210e73c…`) and its workspace copy; the source head;
the verified API-key correction (13 log entries, 2 attempts, 2 explorations).

### 12.3 B3 retrieval findings (2026-11-22, Kane CLI 0.10.5, free commands only)

- **Read path chosen:** three free, read-only commands run through the B2 runner (`context fsck
  --json`, `context list --json --inferred`, `context view --json`), plus a strict read of the
  committed records in `.context/commits/`. `explain` is not used (history only).
- **`context view --json`:** `meta` (schema, `tipHash`, and the absolute `storePath`, which is
  private and never shown), `nodes` (with trust and `contentHtml`), `edges` (with `anchors` but **no
  quotes**), and lineage. The store fingerprint was identical before and after.
- **`context fsck --json`:** `{"ok": true, "issues": [], "records": 2}` on the V1 store; exit 1 when
  there are issues. Read-only.
- **Quotes and claims** are only on the commit record's `DERIVES` edges
  (`props: {source_id, source_cid, anchor: "Lx-Ly", quote, claim?}`). KaneVerity reads them with
  strict schema checks and cross-checks them against `view` (anchors) and `list` (titles, source).
- **Kane's blob id is not the requirements file's SHA-256**, so the blob bytes are compared with the
  stored requirements version instead.
- **Real UI check** (orchestrator in `free` mode only for this check, then back to `off`): retrieval
  1 passed every integrity check. `uc-1` shows awaiting review, Kane trust derived, 6/6
  citations valid (2 cite KaneVerity framing only), outcomes O1-O3 cited, and steps S1-S3 **NOT
  CITED** (labels named exactly). Kane's "skipped" verdict is shown as never counting, and the use
  case is not ready for test design. Nothing was approved or rejected. The credits total stayed at
  114.81, and the store fingerprint was unchanged.
- **Still open for B4:** whether to record KaneVerity approvals into Kane's store (`context review
  --verdicts`, free) or design with `--allow-unreviewed` from KaneVerity-approved items only. B3
  writes nothing to Kane.

### 12.4 V-B4a and B4 (2026-11-22 to 2026-11-24, Kane CLI 0.10.5, free commands only)

**V-B4a (disposable copy, accepted).** `context review --verdicts <file> --mode ci --json` was run
once against a byte-identical copy of the V1 store under a git-ignored folder, with a temporary home
folder so the real Kane profile could not change. The real store, data and profile were confirmed
unchanged, and the copy was deleted afterwards. Validated:

- The verdict file is `[{ref, resolution, reason?, edit?, supersede_target?}]`; `ref` takes a slug or
  a content id. One line of `--json` output: `{"ref":"uc-1","cid":"sha256:…","resolution":"approved"}`.
- The new record is review-only: `{seq, prev_hash, ts, proposal_id: null, nodes: [], edges: [],
  review: [{id, kind: "review-item", resolution, edit: null, reason: null, by: {kind: "human", id}}],
  supersessions: [], source_head_moves: {}, schema_version, parents, intent_verb: "review",
  created_by: {build, by}}`. **The reason is not committed** (only the intent file keeps it).
- `by.id` is `$USER`, or "operator" when it is unset. Kane does not verify it.
- Trust went from `derived` to `trusted`; the content id, anchors and citations were unchanged.
- `context fsck --json` gave `{ok: true, issues: [], records: 3}`. `context list --json` shows
  `trusted`; `--inferred` lists only items waiting for review, so it no longer lists the use case.
  `context view --json` reports the new tip, `commits[]` gains
  `{kind: "review", reviewedNodeCids, trustDelta}`, and the lineage gains `{kind: "review",
  detail: "approved"}`. Neither view nor list shows who approved or the reason.
- Kane refuses verdicts for items not waiting for review. A rejection archives the item, which needs
  `--allow-archive` without a terminal; `--mode ci` refuses archives. `design tests` refuses an
  unapproved use case (`UC_UNREVIEWED`) unless `--allow-unreviewed` is given.
- A copied store registers in the profile's `bindings.json`. Never run Kane in a copied store with the
  real profile: a later run on the real store could rewrite its `store.json`.

**B4 (built).**

- **Reviewer setting:** `KANEVERITY_REVIEWER` is self-declared and passed as
  `USER=kaneverity:<reviewer>`. Approving needs it.
- **Reader:** `storeReader.ts` reads `review[]` items strictly (any other key, kind, resolution or
  `by` shape fails the integrity check), with the record's `prev_hash` and its full hash taken from
  the next record (or from `view` for the tip).
- **The write:** `usecases.ts` writes the approval through the internal `review` job, after fresh
  pre-write checks, then verifies it by reading the store again. Write states (append-only
  `kane_write` entries) are pending, verified, not_written, written_unverified and unknown.
  Unknown is never retried and locks the tutorial until reconciled by a read-only store check.
  A pending write left by a restart becomes unknown.
- **Design gate:** the latest KaneVerity approval, a verified Kane record for the same content id
  still at the top of that use case's review history, Kane trust `trusted`, an intact retrieval and
  current requirements. An approval in Kane that no KaneVerity write accounts for is reported and
  never accepted.
- **Rejections** stay in KaneVerity. Re-approving after a rejection relies on the earlier verified
  record (via "reuse"); no new record is written.
- **Tests:** 19 end-to-end B4 cases with the fake Kane CLI modelled on record 3, plus a reader test on
  a copy of the real V1 store with the real record 3 appended.
- **Review fixes (2026-11-24):**
  - The review history and latest retrieval are read fail-closed (an unreadable file was
    previously read as empty, so the next append could have erased the history and unlocked an
    unknown write).
  - Reconcile is refused with Assurance off, and records nothing.
  - The internal write job cannot be cancelled from the jobs API.
  - The history is shown as one line per write with its steps.
  - The panel tolerates an older orchestrator's response.
  - A controlled restart (real processes, disposable copy, fake Kane hanging mid-write) confirmed:
    pending becomes unknown at startup, the job is marked interrupted, decisions stay locked, and
    reconcile settles it read-only as not written. Kane's write ran once.
- **Pre-commit review (2026-11-24):**
  - **One orchestrator per data folder.** The per-tutorial review locks, the "write in progress"
    refusal and the Kane process lock are in-memory, so a second orchestrator on the same data
    folder could have appended to the same history and started concurrent writes.
    `src/instanceLock.ts` now takes `data/orchestrator.lock` atomically at startup; a second
    orchestrator refuses to start, and a stale lock (dead process) is taken over. Ownership is
    re-checked every 5 seconds and before every history append and Kane write; an orchestrator
    that lost its lock writes nothing more and exits. Tested with real orchestrator processes on
    a temporary folder.
  - The reviewer pattern is now defined once (`commands.ts`), shared by the setting and the Kane
    `USER` value.
  - `--force` is refused for every command, so a later re-design (Kane suggests
    `design tests --force`) needs an explicit decision then.
- **For test design (next):** the gate uses the latest retrieval. Design must read the store again
  immediately before it starts and re-check eligibility, because Kane can change after the last
  retrieval.
- **Not done:** no review was written to the real store; the real `uc-1` is unreviewed. Test design
  (V2) is not started.

### 12.5 V2 preparation: test design safety (2026-11-24, built; real run: section 13.1)

**Findings that led to it.** The B2 `design` job could be started from the generic jobs API with
mode `all`. It had no tutorial binding, no design-gate check and no fresh read of the store, and it
passed only Kane's logical id (`uc-1`), not the approved content id.

**What Kane 0.10.5 shows** (help and bundled code; design not yet run here):

- Command: `design tests --use-case <id> --mode agent --max <n>`.
- Store choice: a `.context` folder in the working folder and no `.testmuai/assurance.json` project
  link means the local store; both means `BOTH_STORES` refused.
- Refusal codes: `UC_UNREVIEWED`, `UC_ARCHIVED`, `UC_HELD`, `UC_TIP_MOVED` (on resume) and
  `DESIGN_FAILED`. A use case that already has a design needs `--force`.
- Credits are used (agent turns; `usage` events), with no cost cap flag.

**Built:**

- **Isolation:** `design` is internal like `review`: not listed and not startable from
  `/api/assurance/jobs`. It is started only by `POST /api/assurance/usecases/:t/:ucHex/design`
  (`usecases.ts`).
- **Before any Kane read:** the reviewer setting, mode `all`, the paid confirmation and `max`
  (1–8, default 1) are checked.
- **Write lock:** no design while an approval write is pending or unknown.
- **Earlier attempt for this content id:**
  - queued, running or paused blocks a new one;
  - complete means already designed, with no re-design;
  - refused allows a new attempt;
  - any other outcome needs `acknowledgePrevious: <jobId>`. Nothing is retried automatically, and
    an interrupted paid job's cost is "unknown".
- **Fresh checks:** a free retrieval, then the content id must be present; the full design gate must
  pass (latest decision approved, Kane write verified and still the newest record for the use case,
  Kane trust `trusted`, no outside approval, integrity intact, requirements current); and Kane's
  logical id must name exactly that version.
- **Binding:** the job is bound to `{tutorialId, ucCid, useCase, decisionId, reviewer}`, with
  `USER=kaneverity:<reviewer>`.
- **Run-time preflight:** right before Kane starts (the Kane lock is held, so no Kane read), the
  decision, reviewer, Kane id and eligibility are re-checked against KaneVerity's state. A
  mismatch means "refused", with nothing run or charged.
- **Pauses:** questions are never answered automatically. Answering is paid, through
  `POST /api/assurance/usecases/:t/:ucHex/design/:jobId/answer` (mode `all`, confirmation, the same
  reviewer, the job bound to this use case). It runs the fresh checks again, keeps the same binding,
  and is refused if the decision changed. Decisions are locked while a design is queued or running;
  they stay allowed while it is paused.
- **Stopping:** a running design is stopped, or a paused one abandoned, only through
  `…/design/:jobId/cancel`. The generic jobs API refuses to start, list, answer or cancel any design
  job or design resume (the approval write stays non-cancellable anywhere).
- **Tests:** 16 cases with the fake Kane CLI in `tests/assurance-design.test.ts`.
- **Final review (2026-11-24):** one test failed once in a full run (a second use case missing
  from a retrieval that still passed integrity). Two real gaps explain it, both fixed:
  - **Output file race:** the runner reported a Kane job finished without waiting for its private
    output file to be flushed, so a read could in principle lose its last lines. It now waits.
  - **No list/view comparison:** nothing compared Kane's `list` with its `view`. A retrieval now
    fails integrity if they name different use cases (a regression test simulates the lost line).
  - **Not reproduced:** in five full runs or a stress run of four parallel copies, so the link
    between these gaps and that one failure is inferred, not proven.
  - **Test isolation:** tests no longer load the developer's `.env` (see the README).

**Still open for V2 (real run)** (answered in section 13):

- the real event stream and record shapes of design;
- whether designed tests keep the exact labels and order (the fidelity check, section 7.3, built
  in B5);
- the review of acceptance criteria and scenarios;
- the cost.

## 13. B5: test-design review (built 2026-11-25; no paid command, no Kane write, no test run)

### 13.1 V2 real design run (2026-11-24, approved by the user)

- One run of `design tests --use-case uc-1 --mode agent --max 1` through the use-case endpoint
  (mode `all` only for that run, then back to `free`). Job `j20261124-224630-cfed4c`: complete, exit 0,
  no pause, 62 s, **9.78 credits** (Kane's report and the balance difference agree).
- Records #4–#7 (`ai:design-agent`, design generation 1): ac-1..3 (#4), sc-1 (#5), the
  scenario-to-criteria links (#6), and gap-1 plus t-1 (#7). Kane also wrote
  `.testmuai/tests/<name>_test.md` and `.testmuai/variables/assurance.json` (`app_url` declared,
  empty). Records #1–#3 are unchanged.
- **Mapping:** ac-1 is O2 (key in the list), ac-2 is O3 (`2 keys`), ac-3 is O1 (success message).
- **Assertions:** t-1 has one structured check (ac-1); O1 and O3 appear only in the wording of
  step 3. One scenario covers all three criteria.
- **No `BOTH_STORES`:** that needs `.testmuai/assurance.json` (a project link), which doesn't
  exist. Kane itself chooses `.testmuai/variables/assurance.json` when a `.context` store is present.

### 13.2 Kane 0.10.5 behaviour verified for B5

From the help text, the installed code and free reads; none of it from a paid run.

- **Review:** `context review --verdicts` accepts any item whose trust is `derived` or `archived`
  (criteria, scenarios, tests, gaps), by short id or content id, all-or-nothing.
  - An `edited` verdict changes only `title`, `summary` and `risk`, so review cannot change a
    test's steps.
  - A rejection archives the item, so it needs `--allow-archive` and is refused in `--mode ci`.
  - The review queue needs a terminal (`TTY_REQUIRED`).
- **Test design:**
  - **One check per test:** a test has exactly one structured `check`, attached to the step
    tagged with its criterion. Check kinds: `presence`, `forbidden-presence`, `count`, `delta`,
    `state-transition`, `absolute`, `bound`, `propagation`, `latency`, `graded`. `delta` and
    `state-transition` need a baseline-capture step.
  - **One-to-one:** scenario and test are strictly one-to-one (`CARDINALITY_VIOLATION`).
  - **Already designed:** a use case with a live design generation is refused without `--force`
    (`GENERATION_LIVE`). `--phase <p>` gets past the "already designed" refusal but not this one.
  - **What `--force` retires:** its scope is the use case's live scenarios and the tests that
    automate them; criteria are never in it. Only items whose type is in the committing phase
    are retired, so `--force --phase scenarios` keeps ac-1..3 and supersedes sc-1, then t-1.
    Successors are matched by `reuse_of`, then same criteria, then title, then paired test
    (`lineage: 2`, always); unmatched items are superseded with no successor.
  - **Generations:** a forced redesign starts a new generation (`supersedes_generation`); records
    are never rewritten.
  - **Gaps:** only `unmeasurable` and `budget-evicted` gaps can be retired, so an `incomplete` gap
    keeps its `ref` even when the item it names is superseded.
- **Execution:**
  - **No approval check:** `testmd run` and `testrun run` do not check approval or trust; the only
    signal is a design-time warning.
  - **Per-criterion verdicts:** each criterion gets the worst status of the run's steps tagged
    `@verifies` with it (read from the evidence pack's `result.yaml`).
  - **Metadata, not evidence:** `oracle_mode` is the test's design-time `expected_mode`, and
    `via_parent` marks a fact inherited from an importing test.
  - **Coverage:** Kane counts a criterion as covered through the `verifies` link
    (`live_verifies_edge`), not the check.
  - **Dry run:** `testrun run --dry-run` builds the plan and stops before authentication; nothing
    is written (checked on a disposable copy). An empty variable is only a warning ("typed as
    written"); `testrun run` has no `--variables` option.
  - **Variable loading:** global folder, then `.testmuai/variables/`, then `--variables-file`,
    then inline `--variables` (`testmd run` only).
  - **Hidden `--local`:** skips Test Manager uploads only.
  - **Run-time writes:** a run writes `execution` records. A test file edited on disk is recorded
    as a new version (`exec-supersede`), and its `base:` pin is rewritten.

### 13.3 Questions resolved before building, and the fail-closed rules

- **Design generations:** KaneVerity reads `design_phase` and `design_generation` from the records.
  - The latest generation must have a complete tests phase.
  - Every live scenario and test must come from it; criteria may be carried forward from an
    earlier generation, which is shown as a note.
  - Each test must automate exactly one live scenario, and each scenario must have exactly one
    live test.
  - Every design record's full hash must be known.
- **Gaps:** every live gap of the use case is shown and must be acknowledged; none is ever dropped.
  A gap whose `ref` names a superseded or unknown item is marked stale, and acknowledging it
  needs `acknowledgeStale: true`.
- **Execution evidence:** an earlier version of B5 made run-time evidence a pre-execution gate,
  which no design could ever pass (a circular dependency). Corrected in section 13.8: evidence is
  what a run produces, so it is checked **after** the run, and nothing is VERIFIED without it.

### 13.4 Built

- **`designGraph.ts`:** a read-only reader for design records (nodes, links, short ids,
  supersessions, phases, generations). Unknown shapes are reported, never guessed.
- **`designCheck.ts`** (pure):
  - **Requirements:** S1–Sn and O1–On come from the stored requirements (line map and labels).
  - **Outcome-to-criterion mapping:** by exact quoted values, then word overlap; an ambiguous or
    missing match blocks.
  - **Structure:** one criterion, one scenario and one test per outcome.
  - **Per-outcome specification** (design level only, never evidence):
    - a scenario that exercises only that criterion, and one test that verifies only it;
    - a structured check aimed at it, of a kind that fits: an exact value for O1 and O3, or a
      change from a captured baseline for O2;
    - exactly one step tagged with it, stating an assertion and quoting the exact values;
    - for O2, a baseline captured before that step.
  - **Fidelity per test:**
    - step 1 starts at `{{app_url}}/`;
    - each documented label is acted on exactly once, in order (a label is "acted on" when an
      action verb introduces it in the same clause);
    - no undocumented quoted label and no other variable;
    - any capture, or a step that is neither navigation nor an assertion, is an extra step that
      needs approval.
  - **Generated files:** each test's file must match Kane's stored test byte for byte and be
    pinned to its definition. Any `*_test.md` that belongs to no live test blocks, because a run
    could select it.
- **`designs.ts`:**
  - **Reading** (`POST /api/assurance/designs/:t/:ucHex/retrieve`): a fresh B3 retrieval (free
    `fsck`, `list` and `view`), then the design graph, the generated files and the variables file.
    It is accepted only if the records, `context list` and `context view` agree on items, short
    ids, trust and links. It is saved as an append-only snapshot in `data/assurance/designs/<t>/`.
  - **Reviewing** (`POST …/review`): decisions on criteria, scenarios, tests, each outcome's
    mapping (target `O1`, `O2`, ...: bound to the outcome and the matched criterion's exact
    content) and extra steps (all approve or reject), and on gaps (acknowledge only).
    - A gap acknowledgement records the reason and the gap's reference as it was (`ref`,
      `refState`, `refCid`). It resolves nothing: the gap stays in Kane and in every design read,
      still marked stale, and a change to its reference makes the acknowledgement stale.
    - The history is append-only in `data/assurance/design-reviews/<t>.json`, read fail-closed,
      and written only while this orchestrator holds the data-folder lock.
    - Each decision stores what it was made on (content ids and hashes, the minting record and its
      hash, the test file's sha256 and pin, the links, the requirements and source) plus a hash
      of that. When anything changes, the decision is stale and doesn't count.
    - Decisions are refused while the read failed integrity, after a newer store read, while a
      design or a Kane write is in progress, or without a reviewer. A test whose file differs
      cannot be approved.
  - **`app_url`** (`POST …/app-url`, `{value, confirm: true}`): only the connected project's
    application origin, on loopback, with no path. The approval is bound to the variables file's
    fingerprint. KaneVerity never writes Kane's file; the value is set for the run in KaneVerity's
    own file (section 13.8).
  - **Readiness:** pre-execution gates and post-execution verification, section 13.8.
- **UI:** a "Test design review" card on the tutorial's material page shows readiness, the outcome
  table (with run-time evidence "not available"), the mapping, criteria, scenarios, tests (each step
  labelled navigation, capture, assertion or other), gaps, the `app_url` approval and the design
  records.
- **Tests:** `tests/assurance-design-check.test.ts` (9 pure cases) and
  `tests/assurance-design-review.test.ts` (7 API cases with the fake Kane CLI, which now lists and
  views design items as 0.10.5 does).

### 13.5 Limitations

- **Text rules:** natural-language steps are checked with exact rules (quotes, verbs, tags). A
  paraphrase these rules can't recognise is left to the human review, which every item needs.
- **Mapping:** the outcome-to-criterion mapping uses word overlap for an outcome without an exact
  value (O2), so it needs your approval.
- **History edits:** the history is append-only in code but not tamper-evident.
- **Untested against real data:** the three-scenario structure exists only in tests. The real
  design still has one scenario and one test, so readiness correctly blocks on structure and
  outcomes.

### 13.6 Next (each needs its own approval)

1. **Forced redesign** for one scenario per outcome (sequence in section 13.7):
   `design tests --use-case uc-1 --mode agent --max 3 --force --phase acs` (revised in section
   13.10: `acs`, not `scenarios`, so O2's criterion can be replaced).
   Paid; it needs a one-off, recorded exception to the rule that `--force` is never passed, and
   KaneVerity's design runner does not pass `--force` or `--phase` today, so that exception has to
   be built and approved first. The agent may still not produce three single-outcome scenarios;
   the B5 checks decide.
2. **Then, through KaneVerity** (section 13.8): review, Kane approval writes, `app_url`, the dry
   run, and the first paid run of the three tests. Its evidence decides VERIFIED.

### 13.7 The redesign sequence (verified in Kane 0.10.5's code; not run)

- **One command, not one per phase.** A design session ends ("complete") only when a commit
  contains tests and every live scenario has a live test (`parity.missing` is empty). A
  scenarios-phase commit alone does not end it; the agent goes on to wiring and tests in the same
  command, as the V2 run did for all four phases.
- **Entry:** `--phase scenarios` passes the phase-order check, because generation 1 has `acs`.
  `--force` passes the live-generation check, and generation 2 starts with
  `supersedes_generation: 1`. `--because` is not an option of `design tests`; in agent mode the
  saved reason is "forced redesign (--force)".
- **Paused for questions:** answered through the same session (`--resume <sid>`, KaneVerity's
  design answer endpoint). The same generation continues: no new `--force`, and the remaining force
  scope is kept in the session.
- **Stopped before the tests phase** (error, crash, expiry): do **not** run `--phase tests`. The
  phase-order check reads only the latest generation (2), which has no `acs` record, so it refuses
  (`PHASE_ORDER`). A fresh `--force` would start generation 3. Either recovery needs its own
  decision. Meanwhile the B5 checks block (no complete tests phase, an orphaned t-1, or a scenario
  with no test).
- **Expected records if it completes:**
  - **Scenarios:** generation-2 marker, about three new scenarios, sc-1 superseded (by a
    title-matched successor or by none).
  - **Wiring:** each scenario linked to its criterion. If the agent re-sends a criterion with
    changed text, it is superseded by a new id, and B5 then marks reviews of the old one stale.
  - **Tests:** about three tests, t-1 superseded (by a paired successor or by none), and links
    moved to the successors.
  - **Kept:** gap-1 (`incomplete`) stays live and points at the superseded sc-1, so it shows as a
    stale gap. Records #1–#7 are never rewritten.
  - **Files:** new `*_test.md` files. Whether Kane removes t-1's old file is not known; if it stays,
    B5 blocks on it as a stray file.

### 13.8 Pre-execution readiness and post-execution verification (corrected 2026-11-25)

The first B5 version required run-time assertion evidence **before** a run, so no run could ever
start. Evidence is what a run produces; it now decides the result **after** the run, and nothing
is VERIFIED without it.

**State transitions** (each step is KaneVerity's own record, append-only, in
`data/assurance/design-reviews/<t>.json`):

1. **Design read:** a free retrieval and the B5 checks.
2. **KaneVerity review:** each outcome's mapping, each criterion, scenario and test, extra steps,
   and gaps (acknowledged).
3. **Kane approval write per item** (`kane-write`, free): pending, then one of verified,
   not_written, unknown or written_unverified.
   - An unknown write blocks everything (use-case decisions too) until it is reconciled from the
     store. It is never retried.
4. **`app_url`:** approved, then set for the run (`run-variables`).
5. **Dry run** (free): passed or failed, bound to the exact test files and every variables file.
   - Any change to them makes it out of date.
6. **Pre-execution ready:** all gates pass.
   - Integrity and freshness, including the requirements matching the documentation.
   - The use case is approved and verified (B4).
   - The generation is complete, with one pair per outcome.
   - Each mapping is approved, each outcome is specified, fidelity passes (extra steps
     approved) and the files match Kane's stored tests.
   - Reviews are done, gaps are acknowledged and Kane approvals are verified.
   - `app_url` is approved and set, the dry run passed, and nothing else is active or unresolved.
7. **Run** (`execute`, paid: mode `all` and `{confirm: {paid: true}}`):
   - A fresh read first; every gate is re-checked, then fingerprinted.
   - Right before Kane starts, the run preflight compares the test files, the variables files and
     the set of test files with that fingerprint (no Kane read); any change refuses the run at no
     cost.
   - The run then moves from started to finished, refused or unknown.
8. **Post-execution verification** (when the job ends): see below. The result is VERIFIED or
   NOT_VERIFIED.
   - A run that ends unknown (interrupted, crashed, timed out) blocks everything until it is
     reconciled.
   - Reconciling runs the same checks on what the run left, never runs it again, and is never
     VERIFIED.

**Post-execution verification, from Kane's evidence** (the format was checked on KaneVerity's own
0.10.5 pack, `r20261121-151934-c23cad`):

- **Nothing changed:**
  - the test files are byte-identical;
  - the set of `*_test.md` files and the variables files are unchanged;
  - only `execution` records were added to the store (an `exec-supersede`, a node, a supersession
    or a review is a mutation).
- **The pack:**
  - exactly one new pack in `.testmuai/evidence/`;
  - `run.yaml` `status: finalized`, producer `kane-cli 0.10.5`;
  - every surface and step URL on the application origin.
- **Each outcome independently:**
  - in the member whose `result.yaml` `definition_id` is the approved test's definition, an
    `assert` step tagged (`verifies`) with that outcome's criterion only;
  - the `ASSERTION` operation in `auteur/execution.json` whose `operation_id` is that step's
    `action_id`, with `assertion_status: true`, `assertion_tree.status: passed` and every
    sub-result passed;
  - an **observed value recorded** (`variable_refs`) that equals the documented value, and the
    DOM read that produced it (section 13.9). A yes/no analyzer result no longer counts.
- **Never counted:** step status, wording, `@verifies` tags alone, `verifies` links, the
  design-time `check`, `oracle_mode`, `via_parent` or Kane's coverage.

**Kane facts verified for this** (installed 0.10.5 code):

- **Variable loading:**
  - Kane loads every `*.json` in `.testmuai/variables/` alphabetically, and a later file wins; the
    run-time loader does the same (global folder, then local folder, `--variables-file`, inline;
    local always beats global, proved in section 13.9).
  - So `kaneverity-run.json` (after `assurance.json`) sets `app_url` for both the dry run and the
    run, without touching Kane's file.
  - `testrun run` has no `--variables` option.
- **`--no-adaptive-heal`** (documented): a replay miss becomes terminal instead of re-authoring.
  It does not stop a test's first run from authoring its steps, nor local execution records.
- **`--local`** (hidden on `testmd run`/`testrun run`): skips Test Manager uploads only.
  **`--no-testmd-sync`** (hidden; the coordinator passes it to members): skips the cloud bundle
  push only. Neither stops local writes.
  - KaneVerity uses neither. The run is `testrun run <files> --agent --headless
    --no-adaptive-heal`; never `--force`, `--author` or `--push`.
  - Local writes are detected afterwards instead.
- **The dry run:** stops before authentication and writes nothing (checked on a disposable copy).
  An empty variable is only a warning there, so KaneVerity treats it as a failure.

**Not yet seen on a real run (fail-closed):** the `testrun` pack layout with several members, and
`verifies` on `result.yaml` steps. Kane's code reads both, but if a real pack lacks them, every
outcome is NOT VERIFIED until the reader is extended from that real evidence.

**Tests:**

- `assurance-run-evidence.test.ts`: 5 cases on the verifier (9 since 13.9).
- `assurance-design-check.test.ts`: readiness with no evidence is ready; each missing gate blocks.
- `assurance-design-execution.test.ts`: 3 end-to-end cases in mode `all` with the fake Kane CLI.
  The fake's `testrun` plans and resolves variables like Kane's loader, and its packs follow the
  0.10.5 shape.
  - The whole path to ready, with refused and unknown Kane writes, the reconcile step and the
    `app_url` dry-run failure along the way.
  - No generic-API bypass, and the paid confirmation.
  - VERIFIED from three independent assertions; NOT VERIFIED when O1's assertion is missing or
    when the run superseded the design.
  - A test file changed by the run: NOT VERIFIED, and the next run blocked.
  - An interrupted run: blocked until reconciled, never re-run, never VERIFIED.

### 13.9 Authoring and replay, DOM evidence, global variables, restarts (built 2026-11-25; no paid command run)

The audit of 13.8 found four gaps. Kane records (authors) a test the first time it runs it, so
the first run is never a replay. It also showed that an assertion's `observed` value alone does
not prove the value was read from the page. Two other gaps were the global variables folder and
runs left "started" across a restart. All four are now closed, and tested with the fake Kane CLI
only.

**Kane 0.10.5 authoring, verified in its code:**

- A step is replayed only when `output-<test>/Result.md` has it passed, the step text's md5
  matches, and a recording exists in `.internal/steps/<n>-<md5>/flows`. Otherwise it is authored.
- `run.yaml` `environment.run_kind` is `author` if any step was authored, else `replay`.
- The local recording (`output-<test>/`) is replaced only when a step was authored.

**Two explicit phases** (`execute` needs `phase: "authoring"` or `"verification"`, else 400):

1. **Authoring run** (paid; the pre-execution gates of 13.8): Kane records each approved test.
   - The best result is **AUTHORED**, never VERIFIED, even with complete evidence.
   - AUTHORED needs no mutation, a valid pack, and every recording present with no staging
     folder. Otherwise it is NOT_VERIFIED ("Authoring failed: …").
2. **Recording review** (KaneVerity decision, kind `recording`): the page shows Kane's
   `Result.md` and the recording's fingerprint.
   - An approval is accepted only when the **latest** authoring run was AUTHORED, its result
     lists this exact recording (folder and sha256 over every file), and its pre-run fingerprint
     has the same test file sha256.
   - It binds the test file sha256 and the recording fingerprint, so any later change makes it
     stale.
   - A later failed authoring run, or a hand edit to the recording, makes approval impossible.
3. **A fresh dry run** after the recording approvals (the dry-run binding includes the recording
   fingerprints).
4. **Verification run** (paid). Its own readiness is every authoring gate, plus approved current
   recordings, plus a passed dry run newer than the last recording approval.
   - The recordings are compared with the fingerprint before Kane starts and after it ends.
   - Any change ("Kane re-recorded steps") is a mutation: NOT VERIFIED, and the approvals go
     stale, which blocks the next verification.
   - **VERIFIED requires `run_kind: replay`.** `--no-adaptive-heal` makes a replay miss terminal,
     so a miss fails instead of silently authoring. If Kane still authors, `run_kind` and the
     changed recordings both refuse VERIFIED.

**DOM evidence per outcome** (`logs/*-actions.ndjson` in each pack member): the passed `ASSERTION`
of 13.8 is still required. In addition, the analyzer action that produced the asserted variable
must agree:

- the same key, `status: success`, `code_js` present, locators present, and `output_value`
  equal to the assertion's observed value;
- **O1 (message):** the exact documented message (`API key generated successfully.`), read from a
  `role=status` or `role=alert` region;
- **O3 (value):** exactly `2 keys`, read with `innerText` or `textContent` from a non-text locator
  (the count element). It must not be a boolean, and must not be a locator that contains the
  expected text;
- **O2 (before/after list):** the asserted value is the new key. In the **same execution** (the
  same action log of the same pack member), the **same list** (the same locator as the asserted
  read) must be read in full **before** the action and in full **after** it. Then:
  - the before list is the original API-key list (not empty);
  - every key from before is still listed afterwards (nothing replaced or lost);
  - at least one key is new, and the asserted value is one of the new keys.

  A list read is a JSON array of strings or one key per line. Empty, blank, repeated or
  malformed entries, before (or after) reads that disagree with each other, a read of another
  list, or a read only in another execution's log all refuse the outcome. A plain yes/no never
  counts.

There are no `analyzer_judgement` results any more.

**Limitation, seen in the real 0.10.5 pack (`r20261121-151934-c23cad`):** O1 was found with a text
locator (`internal:text="API key generated"i`) as a boolean, and O2 had no baseline read. Under
these rules that run would be NOT VERIFIED. A real verification needs Kane to design the reads
this way, which may need a redesign. That needs its own approval.

**Global variables, proved with Kane's own loaders:**

- The run-time loader (`chunk-TPCW5OU5` `Y`) merges `{...global, ...local}`, then the variables
  file, inline values and parameters. Local files are sorted, and a later file wins.
- The dry-run planner (`chunk-EHB55V23` `I`) does the same.
- So a local definition always beats a global one, and `kaneverity-run.json` sorts after
  `assurance.json`.
- KaneVerity's readiness checks the **effective local winner** (`effectiveLocalAppUrl`). The
  `app_url` gate passes only if the winner is `kaneverity-run.json` with the approved value.
- With no local definition, a global value would apply. KaneVerity sees no local value, so the
  gate stays closed.
- A later local file that redefines `app_url` is detected as the winner and blocks.
- The global folder is never read or fingerprinted: it cannot change the result while the local
  winner is KaneVerity's file.
- Regression test: `assurance-kane-variables.test.ts` calls the installed 0.10.5 loaders directly
  (pure functions, no Kane command). It is skipped when 0.10.5 is not installed.

**Restarts:** on start-up, an execution left `started` whose job is no longer queued or running
becomes `unknown`. It then blocks everything until it is reconciled (never re-run, never
VERIFIED).

**Watching a run:** while a run is `started`, the page refreshes its status every 2 seconds and
stops at a terminal state. Reconcile is offered only when Kane is no longer running it and the run
is not about to be checked (the job is neither queued, running nor complete); the server refuses
it while Kane runs. When an authoring run finishes AUTHORED, the page reads the design again (free,
read-only) so the new recordings can be reviewed; a page opened later says when its recordings are
older than the latest AUTHORED run. An AUTHORED run's outcomes are shown neutrally as recording
status, never as verified.

**Tests:**

- `assurance-run-evidence.test.ts`: 12 cases on the verifier, 4 of them for O2 (a valid new key;
  a list that loses an earlier key or is unchanged; missing, malformed, ambiguous or incomplete
  reads; reads of another list or from another execution).
- `assurance-kane-variables.test.ts`: 3 cases.
- `assurance-design-execution.test.ts`: 3 cases.
  - The gates and phases, AUTHORED and never VERIFIED.
  - Recording review: a hand-edited recording is refused, and the dry run is required again.
  - VERIFIED only from a pure replay with DOM evidence.
  - NOT VERIFIED for weak O1 evidence, a superseded design, or a re-authoring replay miss (which
    also blocks the next verification).
  - A test file changed by an authoring run blocks, and its recordings cannot be approved.
  - Interrupted and restarted runs.

### 13.10 Redesign preparation: the O2 criterion, superseded test files, the `--force` exception (built 2026-11-25; no paid command run)

Read-only inspection of the real store (on a disposable copy, free `context list` and
`context view` only) and of Kane 0.10.5's installed code. Nothing was written to the real store.

**The real design today (records #1–#7):** ac-1 (O2) is a `presence` criterion
(`exists · the newly generated key in the API keys list`), ac-2 (O3) is `absolute equals '2 keys'`,
ac-3 (O1) is `presence`. One scenario (sc-1) exercises all three; one test (t-1) verifies all
three, with one `presence` check against ac-1. B5 blocks it on structure (1 scenario and 1 test
for 3 outcomes) and on every outcome.

**How Kane replaces criteria (verified in its design committer):**

- `--force` retires only the use case's live scenarios, the tests that automate them, and some
  blocker gaps. **Criteria are never in its scope.**
- In any design commit, Kane compares the use case's live criteria with the ones the agent
  sends, by **normalised text** (lower case, trimmed, spaces collapsed). If exactly one live
  criterion and one new criterion have the same text but different content (for example a new
  kind), the old one is **superseded** by the new one ("AC re-emitted with changed content
  (text-matched successor)").
- If the text differs, the new criterion is added and the old one **stays live**: two live
  criteria for one outcome. A criterion re-sent unchanged keeps its content id (no new item).
- `context review` cannot change a criterion's kind (an `edited` verdict changes only title,
  summary and risk), and archiving one needs `--allow-archive`, which stays forbidden.

**So the redesign starts at the acs phase**, where the agent sends the criteria again. B5 now
refuses anything that is not a clean before/after criterion for O2:

- O2's criterion must be a `delta` or `state-transition` criterion. A `presence` criterion
  (ac-1 today) is refused, and so is a criterion with no recorded kind.
- Every test's check kind must equal its criterion's kind, so a criterion and its test cannot
  contradict each other. `count` is no longer accepted for O2: it cannot show that every earlier
  key is still listed.
- Duplicates are already refused: exactly one live criterion per outcome (structure), and every
  live criterion must map to exactly one outcome (mapping).
- So only the text-matched successor path passes: ac-1 re-sent with the same text as a delta
  criterion, superseded by its successor (ac-4 in the tests). ac-1 and its history stay in the
  store; the approved use case, records #1–#7 and every KaneVerity history are untouched.

**Superseded test files (verified in Kane's code):** Kane never deletes a replaced test's
`*_test.md`. After a design it reports them (`replaced: [{test, file, replaced_by}]`, "test files
here were replaced and won't run any more"). B5 now distinguishes:

- **Superseded and kept:** a file whose pin names a test of this use case that the store marks
  superseded, exactly (its `id` is that test's short id and its `base` is that test's
  definition). Listed as a note with its record and successor; never passed to Kane; not a stray
  file.
- **Stray:** any other file no live test claims (including a file with a superseded test's id
  but another definition). It blocks, as before.
- **Fingerprinted:** kept files are part of the dry-run binding (a change needs a new dry run),
  the run's pre-execution fingerprint, the preflight right before Kane starts, and the
  post-run mutation check. The set of files on disk must be exactly the approved files plus the
  kept files.
- **Never deleted by KaneVerity.** Removing one needs an explicit, recorded cleanup decision,
  which is not part of B5.

**The `--force` exception (built, tested with the fake Kane CLI only):**

- `POST …/usecases/:tutorialId/:ucHex/design` accepts
  `{"confirm": {"paid": true}, "max": 3, "redesign": {"phase": "acs" | "scenarios", "acknowledgement": "<exact text>"}}`.
- The acknowledgement is bound to the use-case version and the phase:
  `I approve a forced redesign of use case <first 12 hex of its content id> from the <phase>
  phase: Kane supersedes its live scenarios and tests, and no record is deleted.`
- Refused before any Kane command: another phase (`grounding`, `wiring`, `tests`), a missing or
  altered acknowledgement, no paid confirmation, mode not `all`, or no complete design to
  replace. Every existing gate still applies (approved and verified use case, fresh read,
  current requirements, no unknown write, nothing in progress, the run-time preflight).
- `buildArgs` passes `--force` only for such a design job, once, as `--force --phase <phase>` at
  the very end. `--allow-unreviewed` and `--allow-archive` stay forbidden everywhere.

**Tests:** `assurance-design.test.ts` (the exception's gates and exact arguments),
`assurance-design-check.test.ts` (criterion kinds, contradictions, superseded vs stray files),
`assurance-design-review.test.ts` (the acs-phase successor path, the scenarios path refused, a
re-sent criterion with new text refused as a duplicate, a mis-pinned copy refused as stray),
`assurance-design-execution.test.ts` (a kept file is never run, never blocks, and any change to
it blocks).
