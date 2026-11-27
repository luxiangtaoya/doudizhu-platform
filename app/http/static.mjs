// 静态文件服务：只读 web/ 目录，防目录穿越，带基本缓存头。
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function contentType(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * @returns {boolean} 是否已处理（false 表示需要上层继续路由）
 */
export function serveStatic(rootDir, req, res, pathname) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  const target = path.resolve(rootDir, rel || 'index.html');
  const rootResolved = path.resolve(rootDir);

  // 目录穿越防护
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('403');
    return true;
  }

  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return false;
  }

  const file = stat.isDirectory() ? path.join(target, 'index.html') : target;
  let body;
  try {
    body = fs.readFileSync(file);
  } catch {
    return false;
  }

  const ext = path.extname(file).toLowerCase();
  const immutable = ext !== '.html';
  res.writeHead(200, {
    'content-type': contentType(file),
    'content-length': body.length,
    'cache-control': immutable ? 'public, max-age=300' : 'no-store',
    'x-content-type-options': 'nosniff',
  });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
  return true;
}
