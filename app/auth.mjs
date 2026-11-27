// 口令门禁：会话 token + 按 IP 的失败次数限流。
// 这是「防同事手滑点进来」级别的门槛，不是堡垒机。
import crypto from 'node:crypto';
import { safeEqual } from './util.mjs';

export const COOKIE_NAME = 'dt_session';

export class Auth {
  constructor({ passphrase, sessionHours = 12, maxTries = 8, lockMs = 5 * 60 * 1000 }) {
    this.passphrase = String(passphrase ?? '');
    this.ttlMs = sessionHours * 3600 * 1000;
    this.maxTries = maxTries;
    this.lockMs = lockMs;
    /** token -> { exp, ip } */
    this.sessions = new Map();
    /** ip -> { fails, lockedUntil } */
    this.attempts = new Map();
  }

  _gate(ip) {
    const rec = this.attempts.get(ip);
    if (!rec) return { ok: true };
    if (rec.lockedUntil && rec.lockedUntil > Date.now()) {
      return { ok: false, code: 'locked', retryAfter: Math.ceil((rec.lockedUntil - Date.now()) / 1000) };
    }
    return { ok: true };
  }

  _fail(ip) {
    const rec = this.attempts.get(ip) || { fails: 0, lockedUntil: 0 };
    rec.fails += 1;
    if (rec.fails >= this.maxTries) {
      rec.lockedUntil = Date.now() + this.lockMs;
      rec.fails = 0;
    }
    this.attempts.set(ip, rec);
  }

  login(pass, ip) {
    const gate = this._gate(ip);
    if (!gate.ok) return gate;

    if (!safeEqual(pass, this.passphrase)) {
      this._fail(ip);
      return { ok: false, code: 'bad_pass' };
    }

    this.attempts.delete(ip);
    const token = crypto.randomBytes(24).toString('base64url');
    this.sessions.set(token, { exp: Date.now() + this.ttlMs, ip });
    this._gc();
    return { ok: true, token, cookie: this.cookieFor(token) };
  }

  cookieFor(token) {
    const maxAge = Math.floor(this.ttlMs / 1000);
    // HttpOnly 防止脚本读取；SameSite=Lax 让同站点跳转携带
    return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
  }

  clearCookie() {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  check(token) {
    if (!token) return null;
    const rec = this.sessions.get(token);
    if (!rec) return null;
    if (rec.exp < Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    rec.exp = Date.now() + this.ttlMs; // 滑动续期
    return rec;
  }

  logout(token) {
    if (token) this.sessions.delete(token);
  }

  _gc() {
    const t = Date.now();
    for (const [token, rec] of this.sessions) {
      if (rec.exp < t) this.sessions.delete(token);
    }
    for (const [ip, rec] of this.attempts) {
      if (!rec.lockedUntil || rec.lockedUntil < t) {
        if (rec.fails === 0) this.attempts.delete(ip);
      }
    }
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function clientIp(req) {
  const raw = req.socket?.remoteAddress || '';
  return String(raw).replace(/^::ffff:/, '');
}
