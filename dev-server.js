// Local development server: `npm run dev`, then open http://localhost:3000
// Serves the static files and runs api/*.js the same way Vercel does. No dependencies.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = +process.env.PORT || 3000;

// load .env (KEY=value lines) without any package
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8' };

function shim(res) {
  res.status = code => { res.statusCode = code; return res; };
  res.json = obj => { if (!res.getHeader('content-type')) res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); return res; };
  return res;
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const name = url.pathname.slice(5).replace(/[^a-z0-9_-]/gi, '');
    const file = path.join(ROOT, 'api', name + '.js');
    if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('Not found'); }
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      try { req.body = raw ? JSON.parse(raw) : undefined; } catch (e) { req.body = raw; }
      try { await require(file)(req, shim(res)); } catch (e) { shim(res).status(500).json({ error: e.message }); }
    });
    return;
  }
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT) || /\.env|dev-server|node_modules/.test(file) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('Not found'); }
  res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`Sponsor Growth Center running at http://localhost:${PORT}`);
  console.log(`AI analyst: ${process.env.GEMINI_API_KEY ? 'on (' + (process.env.GEMINI_MODEL || 'gemini-3.8-flash') + ')' : 'off — add GEMINI_API_KEY to .env'}`);
  console.log(`Shared database: ${process.env.SUPABASE_URL ? 'Supabase' : 'off — changes save in the browser (demo mode)'}`);
});
