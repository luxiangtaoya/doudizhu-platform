// 用 Chrome DevTools Protocol 截图，检查真实渲染效果（不需要装 puppeteer）。
// 用法：先起服务，再 node tests/shot.mjs http://127.0.0.1:8102
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { encodeFrame, FrameDecoder, OP } from '../app/ws/codec.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8102';
const CDP = Number(process.env.CDP_PORT || 9333);
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
      const events = [];
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
          } else if (msg.method) {
            events.push(msg);
          }
        }
      });
      const api = {
        send(method, params = {}) {
          const id = ++seq;
          const payload = JSON.stringify({ id, method, params });
          socket.write(encodeFrame(OP.TEXT, Buffer.from(payload), { mask: true }));
          return new Promise((res2, rej) => {
            pending.set(id, { resolve: res2, reject: rej });
            setTimeout(() => {
              if (pending.has(id)) {
                pending.delete(id);
                rej(new Error('CDP 超时: ' + method));
              }
            }, 20000);
          });
        },
        events,
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

  // 1. 拿门禁口令换会话
  const login = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pass: PASS }),
  });
  const raw = login.headers.getSetCookie?.()[0] || login.headers.get('set-cookie');
  const cookie = raw.split(';')[0];
  const token = cookie.split('=')[1];

  const list = await waitHttp(`http://127.0.0.1:${CDP}/json/list`);
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('没有可用的页面 target');

  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('Runtime.enable');
  const [vw, vh] = String(process.env.VIEW || '1440x900').split('x').map(Number);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: vw,
    height: vh,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const shot = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    console.log('已保存', file);
  };

  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r?.result?.value;
  };

  // 2. 门禁页
  await cdp.send('Page.navigate', { url: `${BASE}/login` });
  await sleep(900);
  await shot('01-login');

  // 3. 写入会话与昵称，进大厅
  const u = new URL(BASE);
  await cdp.send('Network.setCookie', { name: 'dt_session', value: token, domain: u.hostname, path: '/' });
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await sleep(900);
  const freshPid = 'shot' + Date.now().toString(36);
  await evalJs(
    `localStorage.setItem('dt_nick','老王'); localStorage.setItem('dt_pid','${freshPid}'); location.reload();`,
  );
  await sleep(1600);
  await shot('02-lobby');

  // 点昵称改名
  await evalJs("document.querySelector('#myPill').click();");
  await sleep(400);
  await shot('02b-rename');
  await evalJs("document.querySelector('#modalNick').classList.remove('show');");
  await sleep(300);

  // 4. 创建房间 → 开局（机器人补位）→ 出牌界面
  await evalJs("document.querySelector('#btnCreate').click();");
  await sleep(900);
  await shot('03-waiting');

  await evalJs("document.querySelector('#btnStart').click();");

  // 等叫分面板出现，叫 3 分
  const bidClicked = await evalJs(`(async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 9000) {
      const b = [...document.querySelectorAll('#bidActions button')].find(x => x.textContent.includes('3') && !x.disabled);
      if (b) { b.click(); return true; }
      await new Promise(r => setTimeout(r, 200));
    }
    return false;
  })()`);
  console.log('叫分点击:', bidClicked);
  await sleep(1200);
  await shot('04-table');

  // 先故意出一手非法牌，确认不会把手牌选中状态搞乱
  const invalidProbe = await evalJs(`(async () => {
    for (let i = 0; i < 10; i++) {
      const hb = document.querySelector('#btnHint');
      if (hb && !hb.disabled) break;
      await new Promise(r => setTimeout(r, 400));
    }
    const cards = [...document.querySelectorAll('#hand .card')];
    if (cards.length < 2) return 'no-cards';
    const valueOf = (el) => Math.floor(Number(el.dataset.id) / 4);
    const a = cards[0];
    const b = cards.find((el) => valueOf(el) !== valueOf(a));
    if (!b) return 'same-value-only';
    a.click();
    b.click();
    await new Promise(r => setTimeout(r, 150));
    document.querySelector('#btnPlay').click();
    await new Promise(r => setTimeout(r, 700));
    return JSON.stringify({
      toast: document.querySelector('#toastWrap').textContent.trim(),
      stillSelected: document.querySelectorAll('#hand .card.selected').length,
      canPlay: !document.querySelector('#btnPlay').disabled
    });
  })()`);
  console.log('非法出牌自检:', invalidProbe);

  // 轮到自己时先点「提示」，检查选中后出牌按钮是否可用
  const hintProbe = await evalJs(`(async () => {
    for (let i = 0; i < 10; i++) {
      const hb = document.querySelector('#btnHint');
      if (hb && !hb.disabled) break;
      await new Promise(r => setTimeout(r, 400));
    }
    const hb = document.querySelector('#btnHint');
    if (!hb || hb.disabled) return 'not-my-turn';
    const sel = () => [...document.querySelectorAll('#hand .card.selected')].map((e) => e.dataset.id).join(',');
    hb.click();
    await new Promise(r => setTimeout(r, 500));
    const first = sel();
    hb.click();
    await new Promise(r => setTimeout(r, 500));
    const second = sel();
    return JSON.stringify({
      first, second,
      differs: first !== second,
      playDisabled: document.querySelector('#btnPlay').disabled
    });
  })()`);
  console.log('提示自检:', hintProbe);

  // 提示选中了牌就直接出；否则退回手点一张
  const playedByHint = await evalJs(`(() => {
    const btn = document.querySelector('#btnPlay');
    if (btn && !btn.disabled) { btn.click(); return true; }
    return false;
  })()`);
  if (!playedByHint) {
    await evalJs(`(async () => {
      for (let i = 0; i < 10; i++) {
        const cards = [...document.querySelectorAll('#hand .card')];
        if (!cards.length) return 'no-cards';
        const last = cards[cards.length - 1];
        last.click();
        await new Promise(r => setTimeout(r, 150));
        const btn = document.querySelector('#btnPlay');
        if (btn && !btn.disabled) { btn.click(); return 'played'; }
        last.click();
        await new Promise(r => setTimeout(r, 600));
      }
      return 'timeout';
    })()`);
  }
  await sleep(1800);
  await shot('05-table-later');

  // 快捷语 + 气泡
  await evalJs("document.querySelector('#btnQuick').click();");
  await sleep(300);
  await evalJs("document.querySelector('#quickPop button').click();");
  await sleep(700);
  await shot('06-chat');

  // 等机器人动几手，看看"不出"是什么样
  await sleep(4500);
  await shot('08-pass');

  // 结算浮层样式（注入一份示例数据，仅用于检查排版）
  await evalJs(`(() => {
    document.querySelector('#resultTitle').textContent = '你赢了';
    document.querySelector('#resultTitle').className = 'result-title';
    document.querySelector('#resultSub').textContent = '地主胜 · 6 倍 · 1 个炸弹 · 春天';
    document.querySelector('#resultRows').innerHTML = [
      ['老王', '地主', +12], ['小满', '农民', -6], ['阿飞', '农民', -6]
    ].map(([n, r, d]) => '<div class="result-row"><span class="nick">' + n + ' ' + r +
      '</span><span class="delta ' + (d >= 0 ? 'plus' : 'minus') + '">' + (d > 0 ? '+' : '') + d + '</span></div>').join('');
    document.querySelector('#resultActions').innerHTML = '<button class="primary">再来一局</button><button class="ghost">离开</button>';
    document.querySelector('#resultOverlay').classList.add('show');
  })()`);
  await sleep(400);
  await shot('07-result');
  await evalJs("document.querySelector('#resultOverlay').classList.remove('show');");

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
