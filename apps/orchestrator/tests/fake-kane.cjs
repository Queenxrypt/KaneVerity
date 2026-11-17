// Test double for Kane CLI. Replays a sanitized fixture as --agent NDJSON,
// deliberately adding sensitive-looking fields so redaction can be tested.
// Env: FAKE_KANE_FIXTURE (json), FAKE_KANE_PACK (zip to "produce"),
//      FAKE_KANE_ARGS_OUT (where to record argv), FAKE_KANE_EXIT (override).
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const [cmd] = process.argv.slice(2);
if (cmd === 'whoami') {
  process.stdout.write('Authenticated as someone@private-domain.test\n');
  process.exit(0);
}
if (cmd === 'balance') {
  process.stdout.write('Available credits: 999.5\n');
  process.exit(0);
}
if (cmd !== 'run') process.exit(2);

if (process.env.FAKE_KANE_ARGS_OUT) {
  fs.writeFileSync(process.env.FAKE_KANE_ARGS_OUT, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
}
const fx = JSON.parse(fs.readFileSync(process.env.FAKE_KANE_FIXTURE, 'utf8'));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ type: 'stream_start', cli_version: fx.cliVersion || '0.10.5', surface: 'run', pid: process.pid, v: 1 });
for (const p of fx.progress) out(p);
let pack = null;
if (process.env.FAKE_KANE_PACK) {
  const dir = path.join(process.cwd(), '.testmuai', 'evidence');
  fs.mkdirSync(dir, { recursive: true });
  pack = path.join(dir, '3a688ad5-f594-4e9a-b258-cd315d2b7b1b.evidence');
  fs.copyFileSync(process.env.FAKE_KANE_PACK, pack);
}
out({ type: 'coverage', status: 'skipped', pack });
process.stdout.write('this line is not json\n');
if (!fx.runEnd) {
  process.stderr.write('Project and folder must be configured.\n');
  process.exit(fx.exitCode);
}
out({
  ...fx.runEnd,
  summary: `${fx.runEnd.summary || ''} Contact owner@private-domain.test. Saved to C:\\Users\\SomeUser\\.testmuai\\kaneai\\sessions\\abc`,
  test_url: 'https://test-manager.lambdatest.com/projects/01ABC/test-cases/01DEF/dashboard/share/US_SECRET',
  session_dir: 'C:\\Users\\SomeUser/.testmuai/kaneai/sessions\\abc',
  user_email: 'owner@private-domain.test',
});
process.stderr.write('stderr noise with C:\\Users\\SomeUser\\secret\n');
process.exit(process.env.FAKE_KANE_EXIT ? Number(process.env.FAKE_KANE_EXIT) : fx.exitCode);
