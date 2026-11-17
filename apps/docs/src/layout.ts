// HTML templates for AcmeDesk Docs. No scripts anywhere; all dynamic values escaped.

import { escapeHtml, type ParsedDoc } from './markdown.ts';
import type { PageSummary } from './content.ts';

const SECTION_LABELS: Record<string, string> = { guides: 'Getting started', tutorials: 'Tutorials' };

function sidebar(pages: PageSummary[], current?: string): string {
  const groups = ['guides', 'tutorials']
    .map((section) => {
      const links = pages
        .filter((p) => p.section === section)
        .map((p) => {
          const href = `/${p.section}/${p.slug}`;
          const active = href === current ? ' aria-current="page" class="active"' : '';
          return `<li><a href="${href}"${active}>${escapeHtml(p.title)}</a></li>`;
        })
        .join('');
      return `<h2>${SECTION_LABELS[section]}</h2><ul>${links}</ul>`;
    })
    .join('');
  return `<nav class="sidebar" aria-label="Documentation">${groups}</nav>`;
}

function shell(title: string, pages: PageSummary[], main: string, current?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · AcmeDesk Docs</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<header class="topbar"><a class="brand" href="/">AcmeDesk Docs</a></header>
<div class="layout">
${sidebar(pages, current)}
<main id="main-content">
${main}
</main>
</div>
</body>
</html>
`;
}

export function renderIndex(pages: PageSummary[]): string {
  const list = (section: string) =>
    pages
      .filter((p) => p.section === section)
      .map((p) => `<li><a href="/${p.section}/${p.slug}">${escapeHtml(p.title)}</a></li>`)
      .join('');
  const main = `<article data-doc-type="index">
<h1>AcmeDesk documentation</h1>
<p class="lead">Guides and step-by-step tutorials for working in AcmeDesk.</p>
<h2>Getting started</h2><ul>${list('guides')}</ul>
<h2>Tutorials</h2><ul>${list('tutorials')}</ul>
</article>`;
  return shell('Home', pages, main);
}

export function renderDoc(doc: ParsedDoc, section: string, slug: string, pages: PageSummary[]): string {
  const title = doc.meta.title || slug;
  const type = doc.meta.type === 'tutorial' ? 'tutorial' : 'guide';
  const attrs = [
    `data-doc-type="${type}"`,
    type === 'tutorial' ? `data-tutorial-id="${escapeHtml(doc.meta.id || slug)}"` : '',
    doc.meta.app_start ? `data-app-start="${escapeHtml(doc.meta.app_start)}"` : '',
    `data-source-file="${escapeHtml(doc.file)}"`,
    `data-source-sha256="${doc.sha256}"`,
  ]
    .filter(Boolean)
    .join(' ');
  const reviewed = doc.meta.last_reviewed
    ? `<p class="meta">Last reviewed: <time datetime="${escapeHtml(doc.meta.last_reviewed)}">${escapeHtml(doc.meta.last_reviewed)}</time></p>`
    : '';
  const crumbs = `<nav class="breadcrumb" aria-label="Breadcrumb"><a href="/">Docs</a> / ${SECTION_LABELS[section]} / ${escapeHtml(title)}</nav>`;
  const main = `${crumbs}
<article ${attrs}>
<h1>${escapeHtml(title)}</h1>
${reviewed}
${doc.bodyHtml}
</article>`;
  return shell(title, pages, main, `/${section}/${slug}`);
}

export function renderNotFound(pages: PageSummary[]): string {
  return shell(
    'Page not found',
    pages,
    `<article data-doc-type="not-found"><h1>Page not found</h1><p>This page does not exist. <a href="/">Back to the documentation home</a>.</p></article>`,
  );
}

export function renderSitemap(baseUrl: string, pages: PageSummary[]): string {
  const urls = ['/', ...pages.map((p) => `/${p.section}/${p.slug}`)]
    .map((u) => `  <url><loc>${escapeHtml(baseUrl + u)}</loc></url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}
