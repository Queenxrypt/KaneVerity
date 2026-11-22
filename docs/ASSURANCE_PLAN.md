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
| B4 | Design, design review, fidelity check | V2 |
| B5 | Execution via testrun, classification, evidence, coverage | V3, V4 |
| B6 | Corrections: reconcile, re-design, Assurance retest, extended VERIFIED gate | V5 |
| B7 | Reporting: coverage, history, docs | None |

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
