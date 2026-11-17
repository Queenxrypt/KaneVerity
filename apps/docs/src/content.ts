// Loads documentation pages from the content directory.
// Only two sections exist, and page names must match SLUG_PATTERN, so a request
// can never reach a file outside the content directory.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDoc, splitFrontmatter, type ParsedDoc } from './markdown.ts';

export const SECTIONS = ['guides', 'tutorials'] as const;
export type Section = (typeof SECTIONS)[number];

export const SLUG_PATTERN = /^[a-z0-9-]+$/;

export interface PageSummary {
  section: Section;
  slug: string;
  title: string;
  type: string;
  order: number;
}

export function isSection(value: string): value is Section {
  return (SECTIONS as readonly string[]).includes(value);
}

function resolveInside(contentDir: string, section: Section, slug: string): string | null {
  if (!SLUG_PATTERN.test(slug)) return null;
  const root = path.resolve(contentDir);
  const full = path.resolve(root, section, `${slug}.md`);
  return full.startsWith(root + path.sep) ? full : null;
}

export async function loadPage(contentDir: string, section: Section, slug: string): Promise<ParsedDoc | null> {
  const full = resolveInside(contentDir, section, slug);
  if (!full) return null;
  let source: string;
  try {
    source = await readFile(full, 'utf8');
  } catch {
    return null;
  }
  return parseDoc(source, `${section}/${slug}.md`);
}

export async function listPages(contentDir: string): Promise<PageSummary[]> {
  const pages: PageSummary[] = [];
  for (const section of SECTIONS) {
    let names: string[] = [];
    try {
      names = await readdir(path.join(contentDir, section));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const slug = name.slice(0, -3);
      const full = resolveInside(contentDir, section, slug);
      if (!full) continue;
      const { meta } = splitFrontmatter((await readFile(full, 'utf8')).replace(/\r\n?/g, '\n'));
      pages.push({
        section,
        slug,
        title: meta.title || slug,
        type: meta.type || 'page',
        order: Number(meta.order) || 999,
      });
    }
  }
  return pages.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}
