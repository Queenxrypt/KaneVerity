// AcmeDesk Docs server: Node built-in http, no framework.
// Pages are rendered from Markdown on every request, so an approved correction
// written to a .md file is visible immediately (no rebuild, no cache).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSection, listPages, loadPage, SLUG_PATTERN } from './src/content.ts';
import { renderDoc, renderIndex, renderNotFound, renderSitemap } from './src/layout.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONTENT_DIR = path.join(HERE, 'content');
const STYLES_PATH = path.join(HERE, 'public', 'styles.css');

export const HOST = '127.0.0.1';
export const PORT = 5175;

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

function send(req: IncomingMessage, res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, ...extra });
  res.end(req.method === 'HEAD' ? undefined : body);
}

export function createDocsServer(contentDir: string = DEFAULT_CONTENT_DIR, baseUrl = `http://${HOST}:${PORT}`): Server {
  return createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(req, res, 405, 'text/plain; charset=utf-8', 'Method not allowed', { Allow: 'GET, HEAD' });
      }
      const pathname = new URL(req.url ?? '/', 'http://docs.invalid').pathname;
      const pages = await listPages(contentDir);

      if (pathname === '/') return send(req, res, 200, 'text/html; charset=utf-8', renderIndex(pages));
      if (pathname === '/styles.css') {
        return send(req, res, 200, 'text/css; charset=utf-8', await readFile(STYLES_PATH, 'utf8'));
      }
      if (pathname === '/sitemap.xml') {
        return send(req, res, 200, 'application/xml; charset=utf-8', renderSitemap(baseUrl, pages));
      }

      // Only /<section>/<slug> with a strict slug pattern. Anything else (including
      // encoded "../" sequences) fails the pattern and gets a 404.
      const m = /^\/([a-z]+)\/([^/]+?)\/?$/.exec(pathname);
      if (m && isSection(m[1]) && SLUG_PATTERN.test(m[2])) {
        const doc = await loadPage(contentDir, m[1], m[2]);
        if (doc) return send(req, res, 200, 'text/html; charset=utf-8', renderDoc(doc, m[1], m[2], pages));
      }
      return send(req, res, 404, 'text/html; charset=utf-8', renderNotFound(pages));
    } catch (err) {
      console.error('[docs] request failed:', err instanceof Error ? err.message : err);
      return send(req, res, 500, 'text/plain; charset=utf-8', 'Internal server error');
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const server = createDocsServer();
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[docs] Port ${PORT} is already in use. Stop the other process and try again.`);
    } else {
      console.error('[docs] Server error:', err.message);
    }
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    console.log(`[docs] AcmeDesk Docs running at http://${HOST}:${PORT}/`);
  });
}
