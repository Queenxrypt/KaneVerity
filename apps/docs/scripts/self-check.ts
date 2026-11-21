// Self-check for AcmeDesk Docs: safe rendering, source-line mapping, server
// security and routing, and the exact tutorial content. No test framework.
// Run: npm run test:docs

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createDocsServer, DEFAULT_CONTENT_DIR, SECURITY_HEADERS } from '../server.ts';
import { loadPage } from '../src/content.ts';
import { parseDoc, type DocItem } from '../src/markdown.ts';

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = '') {
  if (ok) passed++;
  else failures.push(`${name}${detail ? ` (${detail})` : ''}`);
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${!ok && detail ? ` (${detail})` : ''}`);
}

/** Every item's data-source-line must point at that exact text in the source file. */
async function checkLines(label: string, contentDir: string, items: DocItem[], marker: (i: DocItem) => string) {
  for (const item of items) {
    const lines = (await readFile(path.join(contentDir, item.file), 'utf8')).replace(/\r\n?/g, '\n').split('\n');
    const actual = lines[item.line - 1] ?? '';
    const expected = `${marker(item)}${item.text}`;
    check(`${label} #${item.index} maps to ${item.file}:${item.line}`, actual === expected, `line is "${actual}"`);
  }
}

const EXPECTED: Record<string, { steps: string[]; outcomes: string[] }> = {
  'create-a-project': {
    steps: [
      'On the **Dashboard**, click **Projects** in the sidebar.',
      'Click **New project**.',
      'In **Project name**, enter `Docs Demo Project`.',
      'Click **Create project**.',
    ],
    outcomes: ['The message `Project "Docs Demo Project" created.` appears.', '**Docs Demo Project** is listed in the projects table.'],
  },
  'invite-a-team-member': {
    steps: [
      'On the **Dashboard**, click **Team Members** in the sidebar.',
      'Click **Invite member**.',
      'In **Email address**, enter `new.teammate@example.com`.',
      'In **Role**, select **Member**.',
      'Click **Send invite**.',
    ],
    outcomes: [
      'The message `Invitation sent to new.teammate@example.com as Member.` appears.',
      'The new member is listed in the team members table with the status **Invited**.',
    ],
  },
  'generate-an-api-key': {
    steps: ['On the **Dashboard**, click **Settings**.', 'Click **API**.', 'Click **Create API Key**.'],
    outcomes: [
      'The message `API key generated successfully.` appears.',
      'The new key is added to the API keys list.',
      'The key count below the list shows `2 keys`.',
    ],
  },
  'configure-workspace-settings': {
    steps: [
      'On the **Dashboard**, click **Settings**.',
      'Click **General**.',
      'In **Workspace name**, enter `Acme Docs Workspace`.',
      'Click **Save changes**.',
    ],
    outcomes: ['The message `Workspace settings saved.` appears.', 'The **Workspace name** field shows `Acme Docs Workspace`.'],
  },
};

// Corrections approved by a human and VERIFIED by an independent Kane retest
// (correction c20261119-131002-af5614, retest r20261121-151934-c23cad).
const APPROVED_CORRECTIONS: Record<string, { sha256: string; steps: string[] }> = {
  'generate-an-api-key': {
    sha256: '459c70b8b6a91282a0daddb76a1d24f902d6856f85ede471265dbe2808b8b8ff',
    steps: ['In the left navigation menu, click **Developer Settings**.', 'Click **API Keys**.', 'Click **Generate Key**.'],
  },
};

async function main() {
  console.log('1. Tutorial content and source-line mapping');
  for (const [slug, base] of Object.entries(EXPECTED)) {
    const doc = await loadPage(DEFAULT_CONTENT_DIR, 'tutorials', slug);
    check(`${slug}: loads as tutorial`, doc?.meta.type === 'tutorial' && doc.meta.id === slug);
    if (!doc) continue;
    // A tutorial may also be in one exact, human-approved and Kane-verified corrected
    // version (pinned by fingerprint). Any other content fails.
    const approved = APPROVED_CORRECTIONS[slug];
    const exp = approved && doc.sha256 === approved.sha256 ? { ...base, steps: approved.steps } : base;
    if (approved && doc.sha256 === approved.sha256) console.log(`  info ${slug}: approved corrected version ${approved.sha256.slice(0, 12)}`);
    check(`${slug}: steps exact`, JSON.stringify(doc.steps.map((s) => s.text)) === JSON.stringify(exp.steps));
    check(`${slug}: outcomes exact`, JSON.stringify(doc.outcomes.map((o) => o.text)) === JSON.stringify(exp.outcomes));
    check(`${slug}: notes/warnings are not steps`, !doc.steps.some((s) => /note|warning|tip/i.test(s.text)));
    await checkLines(`${slug} step`, DEFAULT_CONTENT_DIR, doc.steps, (i) => `${i.index}. `);
    await checkLines(`${slug} outcome`, DEFAULT_CONTENT_DIR, doc.outcomes, () => '- ');
  }
  const guide = await loadPage(DEFAULT_CONTENT_DIR, 'guides', 'acmedesk-overview');
  check('overview guide has no steps or outcomes', !!guide && guide.steps.length === 0 && guide.outcomes.length === 0);

  console.log('2. Line mapping survives edits');
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'acmedocs-check-'));
  try {
    await cp(DEFAULT_CONTENT_DIR, tmp, { recursive: true });
    const file = path.join(tmp, 'tutorials', 'generate-an-api-key.md');
    const before = await loadPage(tmp, 'tutorials', 'generate-an-api-key');
    const original = await readFile(file, 'utf8');
    await writeFile(file, original.replace('## Steps', 'An extra paragraph.\n\nAnother one.\n\n## Steps'));
    const after = await loadPage(tmp, 'tutorials', 'generate-an-api-key');
    check('steps shift by exactly 4 lines after inserting 4 lines', !!before && !!after && after.steps.every((s, i) => s.line === before.steps[i].line + 4));
    check('fingerprint changes after edit', before?.sha256 !== after?.sha256);
    if (after) await checkLines('edited step', tmp, after.steps, (i) => `${i.index}. `);
    await writeFile(file, original.replace(/\n/g, '\r\n'));
    const crlf = await loadPage(tmp, 'tutorials', 'generate-an-api-key');
    check('CRLF files map to the same lines', !!crlf && !!before && crlf.steps.every((s, i) => s.line === before.steps[i].line));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  console.log('3. Untrusted Markdown is rendered safely');
  const evil = [
    '---',
    'type: tutorial',
    'title: <script>alert(1)</script>',
    '---',
    '<script>alert("block")</script>',
    '',
    'Inline <img src=x onerror=alert(1)> and <iframe src="https://evil.example"></iframe>.',
    '',
    '## Steps',
    '1. Click [here](javascript:alert(1)) then [data](data:text/html,hi) and [proto](//evil.example/x).',
    '2. Visit <a href="https://evil.example" onclick="x()">site</a> and ![img](https://evil.example/t.png).',
    '3. Open [docs](/tutorials/create-a-project) and [ext](https://example.com).',
    '',
  ].join('\n');
  const doc = parseDoc(evil, 'tutorials/evil.md');
  const html = doc.bodyHtml + doc.steps.map((s) => s.html).join('');
  check('no <script> element', !/<script/i.test(html));
  check('no <img>/<iframe>/<a onclick> elements from raw HTML', !/<(img|iframe)\b/i.test(html) && !/<a [^>]*onclick/i.test(html));
  // Strip quoted attribute values first: escaped source text stored in
  // data-source-text="..." may legitimately contain the characters "onclick=".
  const tagsOnly = html.replace(/="[^"]*"/g, '=""');
  check('no event-handler attributes', !/<[^>]+\son[a-z]+=/i.test(tagsOnly));
  check('event-handler check still detects a real handler', /<[^>]+\son[a-z]+=/i.test('<a href="#" onclick="x()">'.replace(/="[^"]*"/g, '=""')));
  check('no javascript:/data: hrefs', !/href="\s*(javascript|data):/i.test(html));
  check('protocol-relative link dropped', !/href="\/\//.test(html));
  check('external image not loaded', !html.includes('src="https://evil.example'));
  check('raw HTML shown as escaped text', html.includes('&lt;script&gt;') && html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  check('safe relative and https links kept', html.includes('href="/tutorials/create-a-project"') && html.includes('href="https://example.com" rel="noopener noreferrer"'));
  check('steps still extracted from hostile page', doc.steps.length === 3);

  console.log('4. Server: headers, routes, 404, traversal, answer key');
  const server = createDocsServer(DEFAULT_CONTENT_DIR);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const home = await fetch(`${base}/`);
    check('GET / is 200', home.status === 200);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
      check(`header ${k}`, home.headers.get(k) === v, String(home.headers.get(k)));
    }
    const page = await fetch(`${base}/tutorials/generate-an-api-key`);
    const body = await page.text();
    check('tutorial page 200 with markers', page.status === 200 && body.includes('data-doc-type="tutorial"') && body.includes('data-kv="steps"') && body.includes('data-source-sha256="'));
    check('tutorial page has no <script>', !/<script/i.test(body));
    const guidePage = await (await fetch(`${base}/guides/acmedesk-overview`)).text();
    check('guide page is marked as guide, no steps', guidePage.includes('data-doc-type="guide"') && !guidePage.includes('data-kv="steps"'));
    const sitemap = await (await fetch(`${base}/sitemap.xml`)).text();
    check('sitemap lists home + 5 pages', (sitemap.match(/<loc>/g) ?? []).length === 6);
    check('stylesheet served as text/css', (await fetch(`${base}/styles.css`)).headers.get('content-type')?.startsWith('text/css') === true);

    const notFound = [
      '/tutorials/does-not-exist',
      '/tutorials/..%2F..%2Fpackage.json',
      '/tutorials/%2e%2e%2f%2e%2e%2fserver',
      '/tutorials/../../docs/DEMO_SCENARIO.md',
      '/docs/DEMO_SCENARIO.md',
      '/DEMO_SCENARIO',
      '/DEMO_SCENARIO.md',
      '/guides/..%5C..%5C..%5Cdocs%5CDEMO_SCENARIO',
      '/tutorials/Generate-An-API-Key',
      '/content/tutorials/generate-an-api-key.md',
      '/server.ts',
      '/package.json',
    ];
    for (const p of notFound) {
      const r = await fetch(base + p);
      const t = await r.text();
      check(`404 for ${p}`, r.status === 404 && !t.includes('answer key') && !t.includes('Developer Settings'));
    }
    const post = await fetch(`${base}/`, { method: 'POST' });
    check('POST is 405 with Allow header', post.status === 405 && post.headers.get('allow') === 'GET, HEAD');
    const head = await fetch(`${base}/tutorials/create-a-project`, { method: 'HEAD' });
    check('HEAD is 200', head.status === 200);
  } finally {
    server.close();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('Failures:\n - ' + failures.join('\n - '));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
