// Minimal helpers over parse5's tree. HTML is parsed as data only: nothing is
// executed, no resources are loaded.

import { parse, type DefaultTreeAdapterTypes as T } from 'parse5';

export type Element = T.Element;
export type Node = T.Node;

export function parseHtml(html: string): T.Document {
  return parse(html);
}

export function isElement(node: Node): node is Element {
  return 'tagName' in node;
}

export function attr(el: Element, name: string): string | null {
  const a = el.attrs.find((x) => x.name === name);
  return a ? a.value : null;
}

/** Depth-first walk in document order. Skips <template> contents. */
export function* walk(node: Node): Generator<Node> {
  yield node;
  if ('childNodes' in node && node.childNodes) {
    for (const child of node.childNodes) yield* walk(child);
  }
}

export function findAll(root: Node, pred: (el: Element) => boolean): Element[] {
  const out: Element[] = [];
  for (const n of walk(root)) if (isElement(n) && pred(n)) out.push(n);
  return out;
}

export function findFirst(root: Node, pred: (el: Element) => boolean): Element | null {
  for (const n of walk(root)) if (isElement(n) && pred(n)) return n;
  return null;
}

const SKIP_TEXT = new Set(['script', 'style', 'template', 'noscript']);

/** Visible text content, whitespace-collapsed. */
export function textOf(node: Node): string {
  const parts: string[] = [];
  for (const n of walk(node)) {
    if (n.nodeName === '#text') {
      let p = (n as T.TextNode).parentNode;
      let skip = false;
      while (p && 'tagName' in p) {
        if (SKIP_TEXT.has(p.tagName)) skip = true;
        p = p.parentNode;
      }
      if (!skip) parts.push((n as T.TextNode).value);
    }
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/**
 * Text with UI labels and values marked for Kane: <strong>/<b>/<code>/<kbd>
 * content becomes 'quoted'. Returns the text plus the list of quoted labels.
 */
export function labelledText(node: Node): { text: string; kaneText: string; labels: string[] } {
  const labels: string[] = [];
  const plain: string[] = [];
  const kane: string[] = [];
  const visit = (n: Node) => {
    if (n.nodeName === '#text') {
      const v = (n as T.TextNode).value;
      plain.push(v);
      kane.push(v);
      return;
    }
    if (!isElement(n) || SKIP_TEXT.has(n.tagName)) return;
    if (['strong', 'b', 'code', 'kbd'].includes(n.tagName)) {
      const inner = textOf(n);
      if (inner) {
        labels.push(inner);
        plain.push(inner);
        kane.push(`'${inner}'`);
      }
      return;
    }
    for (const c of n.childNodes) visit(c);
  };
  visit(node);
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  return { text: norm(plain.join('')), kaneText: norm(kane.join('')), labels };
}

export function headingLevel(el: Element): number | null {
  const m = /^h([1-6])$/.exec(el.tagName);
  return m ? Number(m[1]) : null;
}
