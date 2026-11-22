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
    JSON.stringify({ argv, cwd: process.cwd(), env: { KANE_CONTEXT_GITIGNORE: process.env.KANE_CONTEXT_GITIGNORE ?? null }, stdinIsTTY: !!process.stdin.isTTY }) + '\n',
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
