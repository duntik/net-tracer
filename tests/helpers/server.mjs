// Minimal static file server for the e2e tests (serves the repo root).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './analyze-node.mjs';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.pdf': 'application/pdf', '.png': 'image/png', '.css': 'text/css' };
export function serve(root = ROOT) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); let p = path.join(root, decodeURIComponent(u.pathname));
    if (!p.startsWith(root)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
    if (!fs.existsSync(p)) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}
