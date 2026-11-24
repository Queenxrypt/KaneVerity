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
      nodes: [...ucs.map((u) => ({ cid: u.cid, label: 'usecase', trust: trust.get(u.cid) })), ...sources.map((s) => ({ cid: s.cid, label: 'source', trust: 'derived' }))],
      edges: [...grouped.values()],
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
const resumeIdx = argv.indexOf('--resume');
const keys = [resumeIdx >= 0 ? `resume:${argv[resumeIdx + 1]}` : null, `${argv[0]} ${argv[1]}`, argv[0]].filter(Boolean);
const reply = keys.map((k) => script[k]).find(Boolean);
if (!reply) {
  process.stderr.write(`fake-kane-assurance: no scripted reply for ${keys.join(' | ')}\n`);
  process.exit(2);
}

// Optionally land a file in the working directory, as `context ingest` would create its store.
if (reply.createStore) fs.mkdirSync(path.join(process.cwd(), '.context'), { recursive: true });

function finish() {
  for (const line of reply.stdout || []) process.stdout.write((typeof line === 'string' ? line : JSON.stringify(line)) + '\n');
  if (reply.stderr) process.stderr.write(reply.stderr);
  if (reply.hang) setInterval(() => {}, 1000);
  else process.exit(reply.exit ?? 0);
}
if (reply.delayMs) setTimeout(finish, reply.delayMs);
else finish();
