#!/usr/bin/env node
// Test double for Kane CLI's Assurance commands. It never contacts any service.
// Its output follows only what the official 0.10.5 docs show
// (docs/user-guide/assurance/automation.md and the skill's assurance-parsing.md).
//
// Environment:
//   FAKE_ASSURANCE_LOG      append one JSON line per invocation: {argv, cwd, env subset}
//   FAKE_ASSURANCE_SCRIPT   path to a JSON file mapping a scenario key to a reply:
//                           {"<key>": {"stdout": [lines...], "stderr": "...", "exit": 0, "delayMs": 0, "hang": false}}
//                           The key is the first of: "resume:<sid>", "<cmd> <sub>", "<cmd>".
//   FAKE_ASSURANCE_VERSION  printed for --version (default 0.10.5)
//   FAKE_ASSURANCE_BALANCE  a JSON array of balances returned by successive `balance` calls
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
if (process.env.FAKE_ASSURANCE_LOG) {
  fs.appendFileSync(
    process.env.FAKE_ASSURANCE_LOG,
    JSON.stringify({ argv, cwd: process.cwd(), env: { KANE_CONTEXT_GITIGNORE: process.env.KANE_CONTEXT_GITIGNORE ?? null, USER: process.env.USER ?? null }, stdinIsTTY: !!process.stdin.isTTY }) + '\n',
  );
}

if (argv[0] === '--version') {
  process.stdout.write((process.env.FAKE_ASSURANCE_VERSION || '0.10.5') + '\n');
  process.exit(0);
}

if (argv[0] === 'balance') {
  const file = process.env.FAKE_ASSURANCE_BALANCE_STATE;
  const list = JSON.parse(process.env.FAKE_ASSURANCE_BALANCE || '[1000]');
  let i = 0;
  if (file) {
    try {
      i = Number(fs.readFileSync(file, 'utf8')) || 0;
    } catch {}
    fs.writeFileSync(file, String(i + 1));
  }
  process.stdout.write(`credits: ${list[Math.min(i, list.length - 1)]}\n`);
  process.exit(0);
}

const script = process.env.FAKE_ASSURANCE_SCRIPT ? JSON.parse(fs.readFileSync(process.env.FAKE_ASSURANCE_SCRIPT, 'utf8')) : {};

// ---------------------------------------------------------------------------
// Dynamic mode (B4): fsck/list/view are computed from the real files in
// ./.context, and `context review --verdicts` appends a record in exactly the
// shape Kane 0.10.5 wrote in the V-B4a validation (record 3):
//   {seq, prev_hash, ts, proposal_id: null, nodes: [], edges: [],
//    review: [{id, kind: "review-item", resolution, edit: null, reason: null,
//              by: {kind: "human", id: $USER ?? "operator"}}],
//    supersessions: [], source_head_moves: {}, schema_version, parents,
//    intent_verb: "review", created_by: {build, by}}
// Full record hashes live in .context/fake-hashes.json ({seq: "sha256:<hex>"}).
// script.review.mode: ok | refuse | crashBefore | crashAfter | hang | byOverride | extraItem | badOutput | notReviewOnly
// ---------------------------------------------------------------------------
if (script.dynamic && argv[0] === 'context' && ['fsck', 'list', 'view', 'review'].includes(argv[1])) {
  const crypto = require('node:crypto');
  const ctx = path.join(process.cwd(), '.context');
  const files = fs.readdirSync(path.join(ctx, 'commits')).filter((f) => f.endsWith('.json')).sort();
  const records = files.map((f) => JSON.parse(fs.readFileSync(path.join(ctx, 'commits', f), 'utf8')));
  const hashesFile = path.join(ctx, 'fake-hashes.json');
  const hashes = JSON.parse(fs.readFileSync(hashesFile, 'utf8'));
  const nodes = new Map();
  const edges = [];
  const trust = new Map();
  for (const r of records) {
    for (const n of r.nodes || []) {
      nodes.set(n.cid, n);
      if (n.label === 'usecase') trust.set(n.cid, 'derived');
    }
    for (const e of r.edges || []) if (e.type === 'DERIVES') edges.push(e);
    for (const it of r.review || []) if (trust.has(it.id)) trust.set(it.id, it.resolution === 'approved' ? 'trusted' : it.resolution === 'rejected' ? 'archived' : trust.get(it.id));
  }
  const ucs = [...nodes.values()].filter((n) => n.label === 'usecase');
  const sources = [...nodes.values()].filter((n) => n.label === 'source');
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  // B5: test-design items, as 0.10.5 lists and views them (real store, records 4-7):
  // list rows {id: <short id>, cid, label, title, trust, fresh}; view nodes {cid, slug,
  // label, trust, superseded}; view edges {type, src, dst} for the design links.
  const DESIGN = new Set(['ac', 'scenario', 'test', 'gap']);
  const LINKS = new Set(['scoped_to', 'belongs_to', 'exercises', 'automates', 'verifies']);
  const slugOf = new Map();
  const superseded = new Set();
  const retired = new Set();
  const designEdges = [];
  for (const r of records) {
    for (const nm of r.names || []) slugOf.set(nm.cid, nm.slug);
    for (const s of r.supersessions || []) {
      if (s.kind === 'node') superseded.add(s.old);
      if (s.kind === 'edge') retired.add(s.ecid);
    }
    for (const e of r.edges || []) if (LINKS.has(e.type)) designEdges.push(e);
    for (const it of r.review || []) if (nodes.has(it.id) && DESIGN.has(nodes.get(it.id).label)) trust.set(it.id, it.resolution === 'approved' ? 'trusted' : trust.get(it.id));
  }
  const design = [...nodes.values()].filter((n) => DESIGN.has(n.label) && !superseded.has(n.cid));
  for (const n of design) if (!trust.has(n.cid)) trust.set(n.cid, 'derived');
  const live = (c) => nodes.has(c) && !superseded.has(c);
  const liveLinks = designEdges.filter((e) => !retired.has(e.ecid) && live(e.src) && (live(e.dst) || ucs.some((u) => u.cid === e.dst)));
  const titleOf = (n) => String(n.content.title ?? n.content.text ?? (n.content.question && n.content.question.header) ?? '');
  if (argv[1] === 'fsck') {
    out({ ok: true, issues: [], records: records.length });
    process.exit(0);
  }
  if (argv[1] === 'list') {
    const inferred = argv.includes('--inferred');
    if (!inferred) for (const s of sources) out({ id: s.content.source_id, cid: s.cid, label: 'source', title: s.content.source_id, trust: '-', fresh: 'fresh' });
    ucs.forEach((u, i) => {
      if (inferred && trust.get(u.cid) !== 'derived') return;
      // script.listDropLast: simulate a list read that lost its last use-case row.
      if (script.listDropLast && i === ucs.length - 1) return;
      out({ id: `uc-${i + 1}`, cid: u.cid, label: 'usecase', title: u.content.title, trust: trust.get(u.cid), fresh: 'fresh' });
    });
    if (!inferred) for (const n of design) out({ id: slugOf.get(n.cid), cid: n.cid, label: n.label, title: titleOf(n), trust: trust.get(n.cid), fresh: 'fresh' });
    process.exit(0);
  }
  if (argv[1] === 'view') {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/'/g, '&#39;');
    const grouped = new Map();
    for (const e of edges) {
      const k = `${e.src}|${e.dst}`;
      if (!grouped.has(k)) grouped.set(k, { src: e.src, dst: e.dst, anchors: [] });
      grouped.get(k).anchors.push(e.props.anchor);
    }
    out({
      meta: { schema: 'assurance/context@1', tipHash: hashes[String(records.length)], storePath: 'C:\\Users\\someone\\private\\.context' },
      // Real 0.10.5 view nodes carry their label (V1, V-B4a).
      nodes: [
        ...ucs.map((u) => ({ cid: u.cid, label: 'usecase', trust: trust.get(u.cid) })),
        ...sources.map((s) => ({ cid: s.cid, label: 'source', trust: 'derived' })),
        ...design.map((n) => ({ cid: n.cid, slug: slugOf.get(n.cid), label: n.label, trust: trust.get(n.cid), superseded: false })),
      ],
      edges: [...grouped.values(), ...(script.viewDropLink ? liveLinks.slice(1) : liveLinks).map((e) => ({ type: e.type, src: e.src, dst: e.dst }))],
      contentHtml: Object.fromEntries(ucs.map((u) => [u.cid, `<ul class="crit">${u.content.criteria.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`])),
    });
    process.exit(0);
  }
  // context review --verdicts <file> --mode ci --json
  const cfg = script.review || { mode: 'ok' };
  if (cfg.mode === 'refuse') {
    process.stderr.write('error: --verdicts: nothing committed (the verdicts file is atomic)\n');
    process.exit(2);
  }
  if (cfg.mode === 'crashBefore') {
    process.stderr.write('fatal: simulated crash before writing\n');
    process.exit(1);
  }
  if (cfg.mode === 'hang') {
    setInterval(() => {}, 1000);
    return;
  }
  const vf = argv[argv.indexOf('--verdicts') + 1];
  const verdicts = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), vf), 'utf8'));
  const by = { kind: 'human', id: cfg.mode === 'byOverride' ? 'operator' : process.env.USER ?? 'operator' };
  const items = verdicts.map((v) => ({ id: v.ref, kind: 'review-item', resolution: v.resolution, edit: null, reason: null, by }));
  if (cfg.mode === 'extraItem') items.push({ ...items[0], id: 'sha256:' + 'f'.repeat(64) });
  const seq = records.length + 1;
  const rec = {
    seq,
    prev_hash: hashes[String(records.length)],
    ts: new Date().toISOString(),
    proposal_id: null,
    nodes: cfg.mode === 'notReviewOnly' ? [{ cid: 'sha256:' + 'e'.repeat(64), label: 'note', content: {} }] : [],
    edges: [],
    review: items,
    supersessions: [],
    source_head_moves: {},
    schema_version: 'assurance/context@1',
    parents: [hashes[String(records.length)]],
    intent_verb: 'review',
    created_by: { build: '0.10.5', by },
  };
  const body = JSON.stringify(rec);
  const hex = crypto.createHash('sha256').update(body).digest('hex');
  fs.writeFileSync(path.join(ctx, 'commits', `${String(seq).padStart(6, '0')}-${hex.slice(0, 12)}.json`), body);
  hashes[String(seq)] = `sha256:${hex}`;
  fs.writeFileSync(hashesFile, JSON.stringify(hashes));
  if (cfg.mode === 'crashAfter') {
    process.stderr.write('fatal: simulated crash after writing\n');
    process.exit(1);
  }
  if (cfg.mode === 'badOutput') out({ ref: 'uc-1', cid: 'sha256:' + '0'.repeat(64), resolution: 'approved' });
  else for (const v of verdicts) out({ ref: 'uc-1', cid: v.ref, resolution: v.resolution });
  process.exit(0);
}
// ---------------------------------------------------------------------------
// B5: `testrun run <files...>`. With --dry-run it prints the plan as 0.10.5 does
// (testrun_plan, and an unresolved_variables warning), computing unresolved variables
// the way Kane's loader does: every *.json in .testmuai/variables/, alphabetically, a
// later file winning; a variable is resolved only with a non-empty value. Without
// --dry-run it "runs": script.testrun {mode: ok|hang, delayMs, exit, pack (the combined pack:
// a file copied to .testmuai/evidence/<packId>.evidence), packId, testPackIds (one per test, in
// argv order: Kane 0.10.5 also writes one pack per test and reports it as source_execution_id;
// omitted = a single-pack run), mutateTest, appendRecord (intent verb)}.
// Its output has the event shapes of Kane 0.10.5's real authoring run (2026-11-26). Faults:
// memberStatus, overallStatus, events [{type, drop, duplicate, set: {dotted.path: value}}],
// rawLines (appended as-is), skipPackFile, skipTestPack (index), extraPack (unreported file name).
// ---------------------------------------------------------------------------
if (argv[0] === 'testrun' && argv[1] === 'run') {
  const cfg = script.testrun || {};
  const files = argv.slice(2).filter((a) => !a.startsWith('--'));
  const cwd = process.cwd();
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  if (argv.includes('--dry-run')) {
    const used = new Set();
    for (const f of files) for (const m of fs.readFileSync(path.join(cwd, f), 'utf8').matchAll(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g)) used.add(m[1]);
    const vars = {};
    const vdir = path.join(cwd, '.testmuai', 'variables');
    for (const n of (fs.existsSync(vdir) ? fs.readdirSync(vdir) : []).filter((x) => x.endsWith('.json')).sort()) {
      const o = JSON.parse(fs.readFileSync(path.join(vdir, n), 'utf8'));
      for (const [k, v] of Object.entries(o)) if (v && typeof v === 'object' && 'value' in v) vars[k] = v;
    }
    const unresolved = [...used].filter((n) => !(vars[n] && String(vars[n].value).trim()));
    out({ type: 'stream_start', cli_version: '0.10.5', surface: 'testrun', v: 1 });
    out({ type: 'testrun_plan', members: files.map((f) => ({ path: path.join(cwd, f), tags: [], ...(unresolved.length ? { unresolved: unresolved.map((n) => ({ name: n, reason: 'value_missing' })) } : {}) })) });
    if (unresolved.length) out({ type: 'warning', code: 'unresolved_variables', message: `${unresolved.length} variable(s) have no value`, variables: unresolved.map((n) => ({ name: n, reason: 'value_missing' })), v: 1 });
    process.exit(0);
  }
  if (cfg.mode === 'hang') {
    setInterval(() => {}, 1000);
    return;
  }
  // A run that takes a while (to watch a UI refresh while Kane "runs").
  if (cfg.delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(Number(cfg.delayMs), 20000));
  if (cfg.mutateTest) fs.appendFileSync(path.join(cwd, files[0]), '\n## Step 9\n\nhealed step\n');
  // Any other workspace file the run changes (e.g. a superseded test's kept file).
  if (cfg.touchFile) fs.appendFileSync(path.join(cwd, cfg.touchFile), '\ntouched during the run\n');
  // Recordings, as 0.10.5 keeps them next to each test: output-<stem>/Result.md and
  // .internal/steps/<n>-<md5>/flows/... A test without a recording is authored (written);
  // with one it is replayed (untouched) unless cfg.reauthor rewrites it (a replay miss that
  // re-authored, which --no-adaptive-heal is meant to prevent).
  for (const f of files) {
    const dir = path.join(cwd, path.dirname(f), `output-${path.basename(f).replace(/_test\.md$/, '')}`);
    if (fs.existsSync(dir) && !cfg.reauthor) continue;
    fs.mkdirSync(path.join(dir, '.internal', 'steps', '1-abcdef12', 'flows', '1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Result.md'), `# Result\n\n1. navigate {{app_url}}/ - passed\n2. click Developer Settings - passed\n3. click API Keys - passed\n4. click Generate Key - passed\n\nrecorded ${cfg.reauthor ? 'again' : 'once'} (${f})\n`);
    fs.writeFileSync(path.join(dir, '.internal', 'steps', '1-abcdef12', 'flows', '1', 'flow.json'), JSON.stringify({ step: 1, recordedAt: cfg.reauthor ? 'second' : 'first' }));
  }
  const crypto = require('node:crypto');
  const evDir = path.join(cwd, '.testmuai', 'evidence');
  const packId = cfg.packId || crypto.randomUUID();
  const testPackIds = Array.isArray(cfg.testPackIds) ? cfg.testPackIds : null;
  fs.mkdirSync(evDir, { recursive: true });
  // One pack per test first (as Kane writes them while each test ends), then the combined pack.
  if (testPackIds) testPackIds.forEach((id, i) => {
    if (cfg.skipTestPack !== i) fs.writeFileSync(path.join(evDir, `${id}.evidence`), `per-test pack ${i + 1} (synthetic)\n`);
  });
  // Written fresh, as Kane writes it during the run (copyFileSync would keep the source's time on
  // Windows, and KaneVerity checks that every pack was written while the job ran).
  if (cfg.pack && !cfg.skipPackFile) fs.writeFileSync(path.join(evDir, `${packId}.evidence`), fs.readFileSync(cfg.pack));
  if (cfg.extraPack) fs.writeFileSync(path.join(evDir, cfg.extraPack), 'unreported pack (synthetic)\n');
  if (cfg.appendRecord) {
    const crypto = require('node:crypto');
    const ctx = path.join(cwd, '.context');
    const hashes = JSON.parse(fs.readFileSync(path.join(ctx, 'fake-hashes.json'), 'utf8'));
    const seq = fs.readdirSync(path.join(ctx, 'commits')).length + 1;
    const body = JSON.stringify({ seq, prev_hash: hashes[String(seq - 1)], ts: new Date().toISOString(), proposal_id: null, nodes: [], edges: [], review: [], supersessions: [], executions: [{ verdict: 'passed' }], source_head_moves: {}, schema_version: 'assurance/context@1', parents: [hashes[String(seq - 1)]], intent_verb: cfg.appendRecord, created_by: { build: '0.10.5', by: { kind: 'ai', id: 'exec-sync' } } });
    const hex = crypto.createHash('sha256').update(body).digest('hex');
    fs.writeFileSync(path.join(ctx, 'commits', `${String(seq).padStart(6, '0')}-${hex.slice(0, 12)}.json`), body);
    hashes[String(seq)] = `sha256:${hex}`;
    fs.writeFileSync(path.join(ctx, 'fake-hashes.json'), JSON.stringify(hashes));
  }
  // The run's structured output, in Kane 0.10.5's real event shapes (synthetic ids and paths).
  const ms = cfg.memberStatus || 'passed';
  const overall = cfg.overallStatus || 'passed';
  const testId = (f) => `${path.basename(f).replace(/_test\.md$/, '').slice(0, 40)}-${crypto.createHash('sha256').update(f).digest('hex').slice(0, 8)}`;
  const sessions = files.map(() => crypto.randomUUID());
  const ts = () => new Date().toISOString();
  const events = [{ type: 'stream_start', cli_version: '0.10.5', surface: 'testrun', pid: process.pid, v: 1, ts: ts() }, { type: 'testrun_plan', members: files.map((f) => ({ path: path.join(cwd, f), tags: [] })), valid: true, parallel: 1, v: 1, ts: ts() }];
  files.forEach((f, i) => {
    const log = path.join(cwd, '.testmuai', 'kaneai', 'sessions', sessions[i], 'events.ndjson');
    events.push({ type: 'testrun_authored_member_start', path: path.join(cwd, f), session_id: sessions[i], log_path: log, v: 1, ts: ts() });
    events.push({ type: 'testrun_authored_member_end', path: path.join(cwd, f), test_id: testId(f), status: ms, duration_s: 100 + i, session_id: sessions[i], log_path: log, v: 1, ts: ts() });
  });
  const passed = ms === 'passed' ? files.length : 0;
  events.push({ type: 'testrun_evidence_ingest', status: 'ok', evidence_id: packId, v: 1, ts: ts() });
  events.push({ type: 'coverage', status: 'written', computed_by: 'local', coverage_version: 2, scope: 'run', pct: 100, pack: path.join(evDir, `${packId}.evidence`), v: 1, ts: ts() });
  events.push({
    type: 'testrun_summary',
    execution: { id: packId, status: overall, evidence_id: packId },
    authored: files.map((f, i) => ({ path: path.join(cwd, f), test_id: testId(f), commit_id: sessions[i], execution_id: packId, ...(testPackIds ? { source_execution_id: testPackIds[i] } : {}), status: ms, published: 'yes' })),
    totals: { tests: files.length, passed, failed: files.length - passed, broken: 0, skipped: 0, authored: files.length },
    duration_s: 300,
    upload: 'ok',
    cancelled: false,
    v: 1,
    ts: ts(),
  });
  events.push({ type: 'testrun_done', execution_id: packId, overall_status: overall, coverage: { status: 'written', pct: 100 }, v: 1, ts: ts() });
  // Faults: drop, duplicate or change events (dotted paths), then raw lines.
  let shown = events;
  for (const op of cfg.events || []) {
    shown = shown.flatMap((e) => {
      if (e.type !== op.type) return [e];
      if (op.drop) return [];
      const c = JSON.parse(JSON.stringify(e));
      for (const [k, v] of Object.entries(op.set || {})) {
        const keys = k.split('.');
        let o = c;
        for (const kk of keys.slice(0, -1)) o = o[kk] = o[kk] ?? {};
        if (v === null) delete o[keys[keys.length - 1]];
        else o[keys[keys.length - 1]] = v;
      }
      return op.duplicate ? [c, c] : [c];
    });
  }
  for (const e of shown) out(e);
  for (const l of cfg.rawLines || []) process.stdout.write(l + '\n');
  process.exit(cfg.exit ?? 0);
}

const resumeIdx = argv.indexOf('--resume');
const keys = [resumeIdx >= 0 ? `resume:${argv[resumeIdx + 1]}` : null, `${argv[0]} ${argv[1]}`, argv[0]].filter(Boolean);
const reply = keys.map((k) => script[k]).find(Boolean);
if (!reply) {
  process.stderr.write(`fake-kane-assurance: no scripted reply for ${keys.join(' | ')}\n`);
  process.exit(2);
}

// Optionally land a file in the working directory, as `context ingest` would create its store.
if (reply.createStore) fs.mkdirSync(path.join(process.cwd(), '.context'), { recursive: true });
// What a design (or an evolve) commits: whole records appended to the store with a correct
// hash chain (fake-hashes.json), and files written in the workspace (generated test files).
if (Array.isArray(reply.appendCommits) && reply.appendCommits.length) {
  const crypto = require('node:crypto');
  const ctx = path.join(process.cwd(), '.context');
  const hashes = JSON.parse(fs.readFileSync(path.join(ctx, 'fake-hashes.json'), 'utf8'));
  for (const rec of reply.appendCommits) {
    const seq = fs.readdirSync(path.join(ctx, 'commits')).length + 1;
    const body = JSON.stringify({ seq, prev_hash: hashes[String(seq - 1)], ts: new Date().toISOString(), proposal_id: null, nodes: [], edges: [], review: [], supersessions: [], source_head_moves: {}, schema_version: 'assurance/context@1', parents: [hashes[String(seq - 1)]], ...rec });
    const hex = crypto.createHash('sha256').update(body).digest('hex');
    fs.writeFileSync(path.join(ctx, 'commits', `${String(seq).padStart(6, '0')}-${hex.slice(0, 12)}.json`), body);
    hashes[String(seq)] = `sha256:${hex}`;
  }
  fs.writeFileSync(path.join(ctx, 'fake-hashes.json'), JSON.stringify(hashes));
}
for (const [rel, text] of Object.entries(reply.writeFiles || {})) {
  fs.mkdirSync(path.dirname(path.join(process.cwd(), rel)), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), rel), text);
}
// Files the command removes (e.g. an evolve that deletes a kept test file it should not touch).
for (const rel of reply.deleteFiles || []) fs.rmSync(path.join(process.cwd(), rel), { force: true });

function finish() {
  for (const line of reply.stdout || []) process.stdout.write((typeof line === 'string' ? line : JSON.stringify(line)) + '\n');
  if (reply.stderr) process.stderr.write(reply.stderr);
  if (reply.hang) setInterval(() => {}, 1000);
  else process.exit(reply.exit ?? 0);
}
if (reply.delayMs) setTimeout(finish, reply.delayMs);
else finish();
