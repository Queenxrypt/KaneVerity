// Test double for Claude Code (-p --output-format json). Records its argv, cwd
// and the files it can see, then prints a result built from FAKE_CLAUDE_ANSWER.
// FAKE_CLAUDE_ANSWER: path to JSON {"structured": {...}} | {"raw": "..."} | {"error": true}
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function list(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...list(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

if (process.env.FAKE_CLAUDE_ARGS_OUT) {
  const finding = fs.existsSync('finding.json') ? fs.readFileSync('finding.json', 'utf8') : '';
  fs.writeFileSync(process.env.FAKE_CLAUDE_ARGS_OUT, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), files: list(process.cwd()), finding }));
}
const spec = JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_ANSWER, 'utf8'));
if (spec.error) {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 1.0 }) + '\n');
  process.exit(1);
}
const out = { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.0123, modelUsage: { 'fake-claude-model': {} } };
if (spec.structured) out.structured_output = spec.structured;
else out.result = spec.raw;
process.stdout.write(JSON.stringify(out) + '\n');
process.exit(0);
