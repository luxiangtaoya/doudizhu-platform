// 中国象棋界面截图：创建房间 → 开局（1 人 + 1 机器人）→ 走一步 → 截图
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { encodeFrame, FrameDecoder, OP } from '../app/ws/codec.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8131';
const CDP = Number(process.env.CDP_PORT || 9370);
const OUT = path.join(process.cwd(), 'shots');
const PASS = process.env.PASS || '95599';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHttp(url, timeout = 15000) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {
      /* not ready */
    }
    if (Date.now() - start > timeout) throw new Error('CDP 未就绪');
    await sleep(200);
  }
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const req = http.request({
      host: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13',
      },
    });
    req.on('upgrade', (res, socket) => {
      const dec = new FrameDecoder({ requireMask: false });
      const pending = new Map();
      let seq = 0;
      socket.on('data', (chunk) => {
        let frames;
        try {
          frames = dec.push(chunk);
        } catch {
          return;
        }
        for (const f of frames) {
          if (f.opcode !== OP.TEXT) continue;
          const msg = JSON.parse(f.payload.toString('utf8'));
          if (msg.id && pending.has(msg.id)) {
            const { resolve: res2, reject: rej } = pending.get(msg.id);
            pending.delete(msg.id);
            msg.error ? rej(new Error(JSON.stringify(msg.error))) : res2(msg.result);
          }
        }
      });
      const api = {
        send(method, params = {}) {
          const id = ++seq;
          socket.write(encodeFrame(OP.TEXT, Buffer.from(JSON.stringify({ id, method, params })), { mask: true }));
          return new Promise((res2, rej) => {
            pending.set(id, { resolve: res2, reject: rej });
            setTimeout(() => {
              if (pending.has(id)) {
                pending.delete(id);
                rej(new Error('CDP 超时: ' + method));
              }
            }, 45000);
          });
        },
        close: () => socket.destroy(),
      };
      resolve(api);
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const login = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pass: PASS }),
  });
  const raw = login.headers.getSetCookie?.()[0] || login.headers.get('set-cookie');
  const token = raw.split(';')[0].split('=')[1];

  const list = await waitHttp(`http://127.0.0.1:${CDP}/json/list`);
  const page = list.find((t) => t.type === 'page');
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('Runtime.enable');
  const [vw, vh] = String(process.env.VIEW || '1440x900').split('x').map(Number);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: vw, height: vh, deviceScaleFactor: 1, mobile: false });

  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r?.result?.value;
  };
  const shot = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
    fs.writeFileSync(path.join(OUT, `${name}.jpg`), Buffer.from(data, 'base64'));
    console.log('已保存', path.join(OUT, `${name}.jpg`));
  };

  await cdp.send('Page.navigate', { url: `${BASE}/login` });
  await sleep(600);
  const u = new URL(BASE);
  await cdp.send('Network.setCookie', { name: 'dt_session', value: token, domain: u.hostname, path: '/' });
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await sleep(700);
  await evalJs(
    `localStorage.setItem('dt_nick','老王'); localStorage.setItem('dt_pid','xq${Date.now().toString(36)}'); location.reload();`,
  );
  await sleep(1400);
  await shot('15-xiangqi-lobby');

  await evalJs(`(() => {
    const cards = [...document.querySelectorAll('.game-card')];
    const c = cards.find(el => el.textContent.includes('中国象棋'));
    if (c) c.click();
    return !!c;
  })()`);
  await sleep(1000);
  await evalJs("document.querySelector('#btnStart').click();");
  await sleep(1400);
  console.log(
    'probe:',
    await evalJs(
      "JSON.stringify({vw: innerWidth, vh: innerHeight, k: getComputedStyle(document.documentElement).getPropertyValue('--k'), stage: document.querySelector('#xiangqiStage').getBoundingClientRect().toJSON(), canvas: document.querySelector('#xiangqiBoard').getBoundingClientRect().toJSON()})",
    ),
  );
  await shot('16-xiangqi-board');

  // 点红炮 (1,7)，再点 (1,4)
  const clickFn = `(x, y) => {
    const cv = document.querySelector('#xiangqiBoard');
    const r = cv.getBoundingClientRect();
    const cell = r.width / 10;
    const pad = cell;
    cv.dispatchEvent(new MouseEvent('click', {
      clientX: r.left + pad + x * cell,
      clientY: r.top + pad + y * cell,
      bubbles: true
    }));
  }`;
  await evalJs(`(${clickFn})(1, 7)`);
  await sleep(450);
  await evalJs(`(${clickFn})(1, 4)`);
  await sleep(1200);
  await shot('17-xiangqi-moved');
  await sleep(2400);
  await shot('18-xiangqi-later');

  try {
    await cdp.send('Browser.close');
  } catch {
    /* ignore */
  }
  cdp.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});







