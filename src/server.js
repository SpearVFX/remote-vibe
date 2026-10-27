import { createServer } from 'node:http';
import { createReadStream, statSync, readdirSync } from 'node:fs';
import { timingSafeEqual, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, normalize, extname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { SessionManager } from './sessions.js';

const require = createRequire(import.meta.url);
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Browser-facing paths for the vendored xterm files, resolved from node_modules.
const VENDOR = {
  'xterm.js': require.resolve('@xterm/xterm/lib/xterm.js'),
  'xterm.css': require.resolve('@xterm/xterm/css/xterm.css'),
  'addon-fit.js': require.resolve('@xterm/addon-fit/lib/addon-fit.js'),
  'addon-web-links.js': require.resolve('@xterm/addon-web-links/lib/addon-web-links.js'),
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
};

// Only loopback names and Tailscale MagicDNS names may address the server,
// which blocks DNS-rebinding attacks from arbitrary websites.
function hostAllowed(hostHeader, cfg) {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, '').toLowerCase();
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host.endsWith('.ts.net') ||
    cfg.extraHosts.includes(host)
  );
}

function tokenDigest(t) {
  return createHash('sha256').update(String(t)).digest();
}

// Global failure limiter: behind `tailscale serve` every client appears as 127.0.0.1,
// so per-IP tracking would be meaningless.
const limiter = { failures: [], lockedUntil: 0 };
function checkToken(candidate, cfg) {
  const now = Date.now();
  if (now < limiter.lockedUntil) return false;
  const ok = candidate != null && timingSafeEqual(tokenDigest(candidate), tokenDigest(cfg.token));
  if (!ok) {
    limiter.failures = limiter.failures.filter((t) => now - t < 60_000);
    limiter.failures.push(now);
    if (limiter.failures.length >= 10) {
      limiter.lockedUntil = now + 60_000;
      limiter.failures = [];
      console.warn('[remote-vibe] too many bad tokens, locking auth for 60s');
    }
  }
  return ok;
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string';
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isJson ? 'application/json' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function serveFile(res, filePath) {
  let st;
  try {
    st = statSync(filePath);
  } catch {
    return send(res, 404, 'not found');
  }
  if (!st.isFile()) return send(res, 404, 'not found');
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'no-cache',
  });
  createReadStream(filePath).pipe(res);
}

async function readJson(req, limit = 16 * 1024) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error('body too large');
  }
  return body ? JSON.parse(body) : {};
}

function listProjects(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => ({ name: d.name, path: join(root, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function resolveCwd(requested, cfg) {
  if (requested?.startsWith('~')) requested = homedir() + requested.slice(1);
  const cwd = requested
    ? (isAbsolute(requested) ? normalize(requested) : resolve(cfg.projectsRoot, requested))
    : cfg.projectsRoot;
  try {
    if (statSync(cwd).isDirectory()) return cwd;
  } catch {}
  return null;
}

export function startServer(cfg) {
  const sessions = new SessionManager(cfg);

  const server = createServer(async (req, res) => {
    if (!hostAllowed(req.headers.host, cfg)) return send(res, 421, 'host not allowed');
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (path.startsWith('/api/')) {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!checkToken(token, cfg)) return send(res, 401, { error: 'unauthorized' });

      try {
        if (path === '/api/sessions' && req.method === 'GET') {
          return send(res, 200, sessions.list());
        }
        if (path === '/api/sessions' && req.method === 'POST') {
          const { kind = 'shell', cwd } = await readJson(req);
          if (kind !== 'shell' && kind !== 'agent') return send(res, 400, { error: 'bad kind' });
          const dir = resolveCwd(cwd, cfg);
          if (!dir) return send(res, 400, { error: 'directory not found' });
          return send(res, 201, sessions.create(kind, dir));
        }
        const m = path.match(/^\/api\/sessions\/([\w-]+)$/);
        if (m && req.method === 'DELETE') {
          return sessions.remove(m[1]) ? send(res, 204, '') : send(res, 404, { error: 'no such session' });
        }
        if (path === '/api/projects' && req.method === 'GET') {
          return send(res, 200, { root: cfg.projectsRoot, projects: listProjects(cfg.projectsRoot) });
        }
        if (path === '/api/ping') return send(res, 200, { ok: true });
        return send(res, 404, { error: 'not found' });
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');

    if (path.startsWith('/vendor/')) {
      const file = VENDOR[path.slice('/vendor/'.length)];
      return file ? serveFile(res, file) : send(res, 404, 'not found');
    }

    const rel = path === '/' ? 'index.html' : decodeURIComponent(path).replace(/^\/+/, '');
    const filePath = normalize(join(PUBLIC_DIR, rel));
    if (!filePath.startsWith(PUBLIC_DIR + sep)) return send(res, 403, 'forbidden');
    return serveFile(res, filePath);
  });

  // Browsers can't set headers on WebSockets, so the token travels as a subprotocol:
  // new WebSocket(url, ['remote-vibe', 'token.<token>'])
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    handleProtocols: (protocols) => (protocols.has('remote-vibe') ? 'remote-vibe' : false),
  });

  server.on('upgrade', (req, socket, head) => {
    const reject = (code, msg) => {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (!hostAllowed(req.headers.host, cfg)) return reject(421, 'Misdirected Request');
    const origin = req.headers.origin;
    if (origin) {
      let originHost;
      try { originHost = new URL(origin).host; } catch {}
      if (originHost !== req.headers.host) return reject(403, 'Forbidden');
    }
    const protocols = (req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim());
    const tokenProto = protocols.find((p) => p.startsWith('token.'));
    if (!checkToken(tokenProto?.slice(6), cfg)) return reject(401, 'Unauthorized');

    const m = new URL(req.url, 'http://localhost').pathname.match(/^\/ws\/([\w-]+)$/);
    const session = m && sessions.get(m[1]);
    if (!session) return reject(404, 'Not Found');

    wss.handleUpgrade(req, socket, head, (ws) => {
      session.attach(ws);
      ws.on('message', (data, isBinary) => {
        const str = data.toString('utf8');
        // Text frames starting with \x00 are JSON control messages; everything else is input.
        if (!isBinary && str.charCodeAt(0) === 0) {
          try {
            const msg = JSON.parse(str.slice(1));
            if (msg.type === 'resize') session.resize(msg.cols, msg.rows);
          } catch {}
          return;
        }
        session.write(str);
      });
      ws.on('close', () => session.detach(ws));
      ws.on('error', () => session.detach(ws));
    });
  });

  // Keep idle WebSockets alive through mobile NATs and detect dead phones.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 25_000);
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
  });

  server.listen(cfg.port, cfg.host, () => {
    console.log(`[remote-vibe] listening on http://${cfg.host}:${cfg.port}`);
  });

  const shutdown = () => {
    clearInterval(heartbeat);
    sessions.killAll();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { server, sessions };
}
