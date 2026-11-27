// 通用小工具：只依赖 Node 内置模块，保证零外部依赖。
import crypto from 'node:crypto';

export const now = () => Date.now();

/** 生成 URL 安全随机串 */
export function rid(n = 12) {
  return crypto.randomBytes(n).toString('base64url').slice(0, n);
}

/** Fisher-Yates，使用 crypto 随机源，避免 Math.random 的可预测性 */
export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function pick(arr) {
  return arr[crypto.randomInt(arr.length)];
}

export function randInt(min, max) {
  return crypto.randomInt(min, max + 1);
}

/** 定长比较，防口令枚举的时序侧信道 */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 去掉首尾空白并限制长度，防止昵称/聊天刷屏 */
export function cleanText(s, max = 20) {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function rotate(list, start) {
  return [...list.slice(start), ...list.slice(0, start)];
}
