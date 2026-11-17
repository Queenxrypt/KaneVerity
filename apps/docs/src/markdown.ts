// Safe Markdown rendering with source-line mapping.
//
// Documentation content is UNTRUSTED. Raw HTML is shown as text, never inserted
// as markup; only safe link schemes survive; and every page is served under a
// Content-Security-Policy that allows no scripts at all (see server.ts).
//
// Line numbers are computed from the current file on every render (marked's
// token `raw` strings concatenate back to the exact source), so they stay
// correct after edits without being stored anywhere.

import { createHash } from 'node:crypto';
import { Marked, type Token, type Tokens } from 'marked';

export interface Frontmatter {
  [key: string]: string;
}

/** One extracted, actionable line from a tutorial, with its source reference. */
export interface DocItem {
  /** 1-based position within its list. */
  index: number;
  /** Source file, relative to the content directory (e.g. "tutorials/x.md"). */
  file: string;
  /** 1-based line number in the source file. */
  line: number;
  /** Original Markdown text of the item, exactly as written. */
  text: string;
  /** Safe rendered inline HTML. */
  html: string;
}

export interface ParsedDoc {
  meta: Frontmatter;
  file: string;
  sha256: string;
  bodyHtml: string;
  steps: DocItem[];
  outcomes: DocItem[];
}

const STEPS_HEADING = 'steps';
const OUTCOME_HEADING = 'expected outcome';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Allow http(s), mailto, same-site relative paths and fragments. Reject everything else. */
export function isSafeHref(href: string): boolean {
  const value = href.trim();
  if (value.startsWith('//')) return false; // protocol-relative: treat as external/unsafe
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value);
  if (!scheme) return true; // relative path or #fragment
  return ['http', 'https', 'mailto'].includes(scheme[1].toLowerCase());
}

const md = new Marked({
  gfm: true,
  renderer: {
    // Raw HTML (block or inline) is displayed as text, never executed or rendered.
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }: Tokens.Link) {
      const inner = this.parser.parseInline(tokens);
      if (!isSafeHref(href)) return inner;
      const external = /^https?:/i.test(href.trim());
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      const rel = external ? ' rel="noopener noreferrer"' : '';
      return `<a href="${escapeHtml(href.trim())}"${titleAttr}${rel}>${inner}</a>`;
    },
    image({ href, text }: Tokens.Image) {
      const src = href.trim();
      if (src.startsWith('/') && !src.startsWith('//')) {
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text)}">`;
      }
      return escapeHtml(text);
    },
  },
});

export function renderInline(markdown: string): string {
  return md.parseInline(markdown) as string;
}

function countNewlines(value: string): number {
  let n = 0;
  for (const ch of value) if (ch === '\n') n++;
  return n;
}

/** Split "---\nkey: value\n---\n" frontmatter from the body. Values are plain strings. */
export function splitFrontmatter(source: string): { meta: Frontmatter; body: string; bodyStartLine: number } {
  const meta: Frontmatter = {};
  if (!source.startsWith('---\n')) return { meta, body: source, bodyStartLine: 1 };
  const end = source.indexOf('\n---\n', 4);
  if (end === -1) return { meta, body: source, bodyStartLine: 1 };
  const block = source.slice(4, end);
  for (const line of block.split('\n')) {
    const m = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
    if (m) meta[m[1]] = m[2].trim();
  }
  const head = source.slice(0, end + 5);
  return { meta, body: source.slice(end + 5), bodyStartLine: countNewlines(head) + 1 };
}

function itemsWithLines(list: Tokens.List, listStartLine: number, file: string): DocItem[] {
  const items: DocItem[] = [];
  let cursor = 0;
  list.items.forEach((item, i) => {
    const pos = list.raw.indexOf(item.raw, cursor);
    const offset = pos === -1 ? cursor : pos;
    cursor = offset + item.raw.length;
    const text = item.text.trim();
    items.push({
      index: i + 1,
      file,
      line: listStartLine + countNewlines(list.raw.slice(0, offset)),
      text,
      html: renderInline(text),
    });
  });
  return items;
}

function renderItems(kind: 'steps' | 'outcomes', items: DocItem[], ordered: boolean): string {
  const tag = ordered ? 'ol' : 'ul';
  const itemKind = kind === 'steps' ? 'step' : 'outcome';
  const lis = items
    .map(
      (it) =>
        `<li data-kv="${itemKind}" data-${itemKind}="${it.index}" data-source-file="${escapeHtml(it.file)}" ` +
        `data-source-line="${it.line}" data-source-text="${escapeHtml(it.text)}">${it.html}</li>`,
    )
    .join('\n');
  return `<${tag} class="${kind}" data-kv="${kind}">\n${lis}\n</${tag}>\n`;
}

function renderCallout(tok: Tokens.Blockquote): string | null {
  const m = /^\*\*(Note|Warning|Tip):\*\*/i.exec(tok.text.trim());
  if (!m) return null;
  const kind = m[1].toLowerCase();
  return `<aside class="callout callout-${kind}" data-kv="${kind}">${md.parser(tok.tokens)}</aside>\n`;
}

/**
 * Parse one Markdown document. Steps are the first list under "## Steps";
 * outcomes are the first list under "## Expected outcome". Notes and warnings
 * are blockquotes starting with **Note:** / **Warning:** and are never steps.
 */
export function parseDoc(source: string, file: string): ParsedDoc {
  const sha256 = createHash('sha256').update(source, 'utf8').digest('hex');
  const normalized = source.replace(/\r\n?/g, '\n');
  const { meta, body, bodyStartLine } = splitFrontmatter(normalized);

  const tokens: Token[] = md.lexer(body);
  const out: string[] = [];
  const steps: DocItem[] = [];
  const outcomes: DocItem[] = [];
  let line = bodyStartLine;
  let section = '';

  for (const tok of tokens) {
    const startLine = line;
    line += countNewlines(tok.raw);

    if (tok.type === 'heading') {
      if (tok.depth === 2) section = tok.text.trim().toLowerCase();
      out.push(md.parser([tok]));
      continue;
    }
    if (tok.type === 'list') {
      const list = tok as Tokens.List;
      if (section === STEPS_HEADING && list.ordered && steps.length === 0) {
        steps.push(...itemsWithLines(list, startLine, file));
        out.push(renderItems('steps', steps, true));
        continue;
      }
      if (section === OUTCOME_HEADING && outcomes.length === 0) {
        outcomes.push(...itemsWithLines(list, startLine, file));
        out.push(renderItems('outcomes', outcomes, list.ordered));
        continue;
      }
    }
    if (tok.type === 'blockquote') {
      const callout = renderCallout(tok as Tokens.Blockquote);
      if (callout) {
        out.push(callout);
        continue;
      }
    }
    out.push(md.parser([tok]));
  }

  return { meta, file, sha256, bodyHtml: out.join(''), steps, outcomes };
}
