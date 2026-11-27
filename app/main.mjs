// 入口：HTTP + 静态页 + 口令门禁 + WebSocket。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.mjs';
import { Store } from './store.mjs';
import { Auth, COOKIE_NAME, parseCookies, clientIp } from './auth.mjs';
import { serveStatic } from './http/static.mjs';
import { attachWs } from './ws/server.mjs';
import { Hub } from './core/hub.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(here);
const webDir = path.join(rootDir, 'web');

const cfg = loadConfig(rootDir);
const store = new Store(cfg.dataDir);
const auth = new Auth({ passphrase: cfg.passphrase, sessionHours: cfg.sessionHours });
const hub = new Hub({ cfg, store });

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store',
  });
  res.end(data);
}

function readJson(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const ip = clientIp(req);
  let pathname = '/';
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    res.writeHead(400).end();
    return;
  }

  try {
    if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('ok');
    }

    // 门禁页本身不鉴权
    if (pathname === '/login' || pathname === '/login.html') {
      if (serveStatic(webDir, req, res, '/login.html')) return;
      res.writeHead(500).end('login.html missing');
      return;
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await readJson(req);
      const result = auth.login(body?.pass, ip);
      if (!result.ok) {
        if (result.code === 'locked') {
          return json(res, 429, { ok: false, code: 'locked', msg: `尝试次数过多，请 ${result.retryAfter} 秒后再试` });
        }
        return json(res, 401, { ok: false, code: 'bad_pass', msg: '口令不正确' });
      }
      res.setHeader('set-cookie', result.cookie);
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      const token = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
      auth.logout(token);
      res.setHeader('set-cookie', auth.clearCookie());
      return json(res, 200, { ok: true });
    }

    // 以下全部需要口令
    const token = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
    if (!auth.check(token)) {
      if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) {
        res.writeHead(302, { location: '/login' });
        return res.end();
      }
      return json(res, 401, { ok: false, code: 'need_login', msg: '需要口令' });
    }

    if (pathname === '/api/session') {
      const online = [...hub.players.values()].filter((p) => p.conn).length;
      return json(res, 200, { ok: true, online });
    }

    if (pathname === '/' || pathname === '/index.html') {
      if (serveStatic(webDir, req, res, '/index.html')) return;
    }

    if (serveStatic(webDir, req, res, pathname)) return;

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  } catch (err) {
    console.error('[http] 请求处理失败', err);
    if (!res.headersSent) json(res, 500, { ok: false, msg: 'internal error' });
    else res.end();
  }
});

// WebSocket 同样要求有效会话，防止绕过门禁直连
const ws = attachWs(server, {
  path: '/ws',
  verify: (req) => {
    const t = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
    const session = auth.check(t);
    return session ? { ip: clientIp(req) } : null;
  },
  onConnect: (conn) => hub.attach(conn),
  onMessage: (conn, msg) => hub.onMessage(conn, msg),
  onClose: (conn) => hub.disconnect(conn),
  heartbeatMs: cfg.wsHeartbeatMs,
});

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  out.sort((a, b) => {
    const score = (x) => (x.address.startsWith('192.168.') ? 0 : x.address.startsWith('10.') ? 1 : 2);
    return score(a) - score(b);
  });
  return out;
}

function banner() {
  const ips = lanAddresses();
  const lines = [];
  lines.push('');
  lines.push('  ==============================================');
  lines.push('        牌桌 · 内网联机平台  （斗地主）');
  lines.push('  ==============================================');
  lines.push(`  本机访问 : http://127.0.0.1:${cfg.port}`);
  if (ips.length) {
    for (const ip of ips.slice(0, 3)) {
      lines.push(`  同事访问 : http://${ip.address}:${cfg.port}   (${ip.name})`);
    }
  } else {
    lines.push('  同事访问 : 未检测到局域网地址，请检查网络连接');
  }
  lines.push(`  访问口令 : ${cfg.passphrase}`);
  lines.push(`  数据目录 : ${cfg.dataDir}`);
  lines.push('  关闭这个窗口即停止服务。');
  lines.push('');
  return lines.join('\n');
}

server.listen(cfg.port, cfg.host, () => {
  console.log(banner());
  try {
    const ips = lanAddresses();
    const url = ips.length ? `http://${ips[0].address}:${cfg.port}` : `http://127.0.0.1:${cfg.port}`;
    fs.writeFileSync(path.join(rootDir, '访问地址.txt'), `${url}\n口令：${cfg.passphrase}\n`, 'utf8');
  } catch {
    /* ignore */
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n端口 ${cfg.port} 被占用了。改 config.json 里的 port，或关掉占用的程序。\n`);
  } else {
    console.error('服务启动失败：', err);
  }
  process.exit(1);
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n收到 ${signal}，正在关闭…`);
  ws.closeAll();
  hub.close();
  store.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1200).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('[fatal]', err);
  store.flush();
});
