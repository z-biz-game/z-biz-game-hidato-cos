// Zero-dependency static server. CommonJS on purpose: package.json is "type": "module"
// so `node --check` parses the browser sources as ES modules, while this file still has to be
// requirable by the phase-2 browser harness (CDP 9401) without an ESM/CJS interop dance.
//
// Two URL shapes, because GitHub Pages serves this repo under a path segment:
//   root    http://127.0.0.1:5401/                                   (PREFIX unset: repo = doc root)
//   prefix  http://127.0.0.1:5501/z-biz-game-hidato-cos/            (PREFIX=/z-biz-game-hidato-cos)
// The prefix shape is the only one that catches page-level absolute specifiers, so it is a real
// mode here rather than a footnote — a local server can guess its way through root mode and still
// 404 in production. With PREFIX set, a bare "/" is answered by a redirect into the prefix, so the
// browser always ends up on the shape production will actually serve.
const http = require('http');
const fs = require('fs');
const path = require('path');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** '/z-biz-game-hidato-cos' / 'z-biz-game-hidato-cos/' / 'z-biz-game-hidato-cos' → 同一段。 */
function prefixOf(env = process.env) {
  return String(env.PREFIX || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

function createServer(root = __dirname, prefix = prefixOf()) {
  return http.createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    if (prefix) {
      const head = `/${prefix}`;
      if (urlPath === head) { res.writeHead(301, { Location: `${head}/` }).end(); return; }
      if (urlPath.startsWith(`${head}/`)) urlPath = urlPath.slice(head.length) || '/';
      else { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`404: 前缀形态要 ${head}/`); return; }
    }
    if (urlPath === '/' || urlPath.endsWith('/')) urlPath += 'index.html';
    const file = path.join(root, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
        return;
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(file).pipe(res);
    });
  });
}

function startServer({ port = 5401, root = __dirname, prefix = prefixOf() } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer(root, prefix);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { createServer, startServer, prefixOf };

if (require.main === module) {
  const port = Number(process.argv[2]) || Number(process.env.PORT) || 5401;
  const prefix = prefixOf();
  startServer({ port, prefix })
    .then((server) => {
      const url = `http://127.0.0.1:${port}/${prefix ? `${prefix}/` : ''}`;
      console.log(`智渡 Hidato served at ${url}  (${prefix ? `PREFIX=/${prefix}` : 'root shape'})  ctrl+c to stop`);
      process.on('SIGINT', () => server.close(() => process.exit(0)));
    })
    .catch((err) => {
      console.error('failed to start:', err.message);
      process.exit(1);
    });
}
