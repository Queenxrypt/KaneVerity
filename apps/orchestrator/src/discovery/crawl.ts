// Documentation discovery: sitemap first, then links on the docs home page.
// Same-origin only, manual redirects (never to another origin), size and time
// limits, HTML/XML content types only.

import { config } from '../config.ts';
import type { Discovery, OtherPage, Tutorial } from '../types.ts';
import { originOf } from '../urls.ts';
import { extractPage } from './extract.ts';
import { attr, findAll, parseHtml } from './html.ts';

export class FetchError extends Error {}

export async function fetchText(url: string, origin: string, accept: RegExp): Promise<string> {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    if (new URL(current).origin !== origin) throw new FetchError(`Refused to fetch outside the documentation site: ${current}`);
    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(config.discovery.timeoutMs),
      headers: { Accept: 'text/html, application/xml;q=0.9' },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new FetchError(`Redirect without location from ${current}`);
      current = new URL(loc, current).href;
      continue;
    }
    if (!res.ok) throw new FetchError(`HTTP ${res.status} for ${current}`);
    const type = res.headers.get('content-type') ?? '';
    if (!accept.test(type)) throw new FetchError(`Unsupported content type "${type}" for ${current}`);
    const declared = Number(res.headers.get('content-length'));
    if (declared > config.discovery.maxBytes) throw new FetchError(`Page too large: ${current}`);
    const reader = res.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > config.discovery.maxBytes) {
        await reader.cancel();
        throw new FetchError(`Page too large: ${current}`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  throw new FetchError(`Too many redirects for ${url}`);
}

const ASSET = /\.(css|js|mjs|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|pdf|zip|xml|json|txt)$/i;

function normalisePageUrl(href: string, base: string, origin: string): string | null {
  try {
    const u = new URL(href, base);
    if (u.origin !== origin) return null;
    if (ASSET.test(u.pathname)) return null;
    u.hash = '';
    u.search = '';
    return u.href;
  } catch {
    return null;
  }
}

export async function discover(docsUrl: string, appOrigin: string): Promise<Discovery> {
  const origin = originOf(docsUrl);
  const errors: string[] = [];
  const urls: string[] = [];
  const add = (u: string | null) => {
    if (u && !urls.includes(u) && urls.length < config.discovery.maxPages) urls.push(u);
  };

  try {
    const xml = await fetchText(new URL('/sitemap.xml', origin).href, origin, /^(application|text)\/xml\b/i);
    for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
      add(normalisePageUrl(m[1].replace(/&amp;/g, '&'), origin + '/', origin));
    }
  } catch (err) {
    errors.push(`Sitemap not used: ${(err as Error).message}`);
  }

  let homeHtml: string | null = null;
  try {
    homeHtml = await fetchText(docsUrl, origin, /^text\/html\b/i);
    for (const a of findAll(parseHtml(homeHtml), (e) => e.tagName === 'a')) add(normalisePageUrl(attr(a, 'href') ?? '', docsUrl, origin));
  } catch (err) {
    errors.push(`Docs home page could not be read: ${(err as Error).message}`);
  }
  if (urls.length === 0) add(normalisePageUrl(docsUrl, docsUrl, origin));

  const tutorials: Tutorial[] = [];
  const others: OtherPage[] = [];
  for (const url of urls) {
    try {
      const html = url === normalisePageUrl(docsUrl, docsUrl, origin) && homeHtml !== null ? homeHtml : await fetchText(url, origin, /^text\/html\b/i);
      const result = extractPage(html, url, appOrigin);
      if (result.kind === 'tutorial') {
        if (!tutorials.some((t) => t.id === result.tutorial.id)) tutorials.push(result.tutorial);
      } else {
        others.push(result.page);
      }
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  return { docsUrl, appOrigin, discoveredAt: new Date().toISOString(), tutorials, others, errors };
}
