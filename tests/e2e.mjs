// 端到端冒烟测试：真起服务、真连 WebSocket、三个人打一局、中途断线重连。
// 运行方式：先启动服务（PORT=8099），再 node tests/e2e.mjs
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { encodeFrame, FrameDecoder, OP } from '../app/ws/codec.mjs';

const PORT = Number(process.env.PORT || 8099);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSPHRASE = process.env.PASS || '95599';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 8000, label = '条件') {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`等待超时：${label}`);
    await sleep(60);
  }
}

async function login() {
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pass: PASSPHRASE }),
    redirect: 'manual',
  });
  assert.equal(res.status, 200, '登录应当成功');
  const raw = res.headers.getSetCookie?.()[0] || res.headers.get('set-cookie');
  return raw.split(';')[0];
}

function openWs(cookie) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: '/ws',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        Cookie: cookie,
      },
    });
    req.on('upgrade', (res, socket) => {
      const decoder = new FrameDecoder({ requireMask: false });
      const handlers = [];
      socket.on('data', (chunk) => {
        let frames;
        try {
          frames = decoder.push(chunk);
        } catch {
          return;
        }
        for (const f of frames) {
          if (f.opcode !== OP.TEXT) continue;
          let msg;
          try {
            msg = JSON.parse(f.payload.toString('utf8'));
          } catch {
            continue;
          }
          for (const fn of handlers) fn(msg);
        }
      });
      socket.on('error', () => {});
      resolve({
        socket,
        send(obj) {
          if (!socket.destroyed) socket.write(encodeFrame(OP.TEXT, Buffer.from(JSON.stringify(obj)), { mask: true }));
        },
        on(fn) {
          handlers.push(fn);
        },
        close() {
          socket.destroy();
        },
      });
    });
    req.on('response', (res) => reject(new Error(`升级失败：HTTP ${res.statusCode}`)));
    req.on('error', reject);
    req.end();
  });
}

function mkClient(cookie, pid, nick) {
  const c = { pid, nick, welcome: null, room: null, hint: null, lastActKey: '' };
  return openWs(cookie).then((ws) => {
    c.ws = ws;
    ws.on((msg) => {
      if (msg.t === 'welcome') c.welcome = msg;
      if (msg.t === 'state') c.room = msg.room;
      if (msg.t === 'hint') c.hint = msg.cards;
      if (msg.t === 'error') console.log(`[${nick}] 错误：${msg.msg}`);
      if (msg.t === 'ping') ws.send({ t: 'pong' });
    });
    ws.send({ t: 'hello', pid, nick });
    return c;
  });
}

function actKey(room) {
  const g = room.game;
  if (!g) return '';
  return `${room.id}:${g.dealNo}:${g.phase}:${g.turn}:${g.hand.length}:${g.lastPlay ? g.lastPlay.seat + ':' + g.lastPlay.cards.length : 'x'}`;
}

function valueOf(id) {
  if (id === 52) return 16;
  if (id === 53) return 17;
  return Math.floor(id / 4) + 3;
}

async function main() {
  console.log('1) 未登录时首页应该跳转到门禁页');
  const unauth = await fetch(BASE + '/', { redirect: 'manual', headers: { accept: 'text/html' } });
  assert.equal(unauth.status, 302);
  assert.equal(unauth.headers.get('location'), '/login');

  console.log('2) 口令错误应被拒绝');
  const bad = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pass: '00000' }),
  });
  assert.equal(bad.status, 401);

  const cookies = await Promise.all([login(), login(), login(), login()]);

  const clients = await Promise.all([
    mkClient(cookies[0], 'e2epid000001', '测试甲'),
    mkClient(cookies[1], 'e2epid000002', '测试乙'),
    mkClient(cookies[2], 'e2epid000003', '测试丙'),
  ]);
  await waitFor(() => clients.every((c) => c.welcome), 5000, 'welcome');
  console.log('3) 三个客户端已进大厅');

  clients[0].ws.send({ t: 'create' });
  const hostRoom = await waitFor(() => clients[0].room, 5000, '创建房间');
  const code = hostRoom.id;
  assert.equal(code.length, 4);

  clients[1].ws.send({ t: 'join', code });
  clients[2].ws.send({ t: 'join', code });
  await waitFor(() => clients.every((c) => c.room && c.room.seats.filter(Boolean).length === 3), 6000, '三人到齐');
  console.log(`4) 房间 ${code} 已坐满`);

  // 第四个人进来：应当自动变观战，桌上的人能看到他
  const spec = await mkClient(cookies[3], 'e2epid000004', '观战者');
  spec.ws.send({ t: 'join', code });
  await waitFor(() => spec.room && spec.room.spectator === true, 6000, '观战状态');
  assert.equal(spec.room.youSeat, -1, '观战者没有座位');
  await waitFor(
    () => clients[0].room && (clients[0].room.spectators || []).includes('观战者'),
    6000,
    '其他人能看到观战者',
  );
  console.log('4.1) 第四人自动进入观战，桌上能看到观战名单');

  // 断线重连：把乙踢掉再换同 pid 连回来
  const b = clients[1];
  b.ws.close();
  await sleep(600);
  const b2 = await mkClient(cookies[1], 'e2epid000002', '测试乙');
  clients[1] = b2;
  await waitFor(() => b2.room && b2.room.state === 'waiting', 5000, '重连回到房间');
  assert.equal(b2.room.seats.filter(Boolean).length, 3, '重连后座位仍在');
  console.log('5) 断线重连成功，座位保留');

  clients[0].ws.send({ t: 'start' });
  await waitFor(() => clients.every((c) => c.room && c.room.game), 5000, '开局');
  console.log('6) 开局，开始自动出牌');

  // 自动打：轮到自己就叫分/出牌，领出时打最小单张，否则不要
  const deadline = Date.now() + 25000;
  let dbg = 0;
  while (Date.now() < deadline) {
    const rooms = clients.map((c) => c.room).filter(Boolean);
    if (rooms.length && rooms.every((r) => r.state === 'over')) break;

    if (process.env.E2E_DEBUG && Date.now() - dbg > 1500) {
      dbg = Date.now();
      for (const c of clients) {
        const r = c.room;
        const g = r?.game;
        console.log(
          `   [debug ${c.nick}]`,
          'state=' + r?.state,
          'phase=' + g?.phase,
          'turn=' + g?.turn,
          'you=' + r?.youSeat,
          'hand=' + (g?.hand || []).length,
          'lastKey=' + c.lastActKey,
        );
      }
    }

    for (const c of clients) {
      const room = c.room;
      if (!room || !room.game || room.state !== 'playing') continue;
      const g = room.game;
      if (g.phase === 'over') continue;
      if (g.turn !== room.youSeat) continue;
      const key = `${room.id}:${room.seq}`;
      if (c.lastActKey === key) continue;
      c.lastActKey = key;

      if (g.phase === 'bid') {
        c.ws.send({ t: 'act', action: { type: 'bid', value: c === clients[0] ? 3 : 0 } });
      } else {
        const leading = !g.lastPlay || g.lastPlay.seat === room.youSeat;
        if (leading) {
          const lowest = [...g.hand].sort((x, y) => valueOf(x) - valueOf(y))[0];
          c.ws.send({ t: 'act', action: { type: 'play', cards: [lowest] } });
        } else {
          c.ws.send({ t: 'act', action: { type: 'pass' } });
        }
      }
    }
    await sleep(80);
  }

  const finalRoom = clients.map((c) => c.room).find((r) => r && r.state === 'over');
  assert.ok(finalRoom, '应该打完一局');
  const result = finalRoom.game.result;
  assert.ok(result, '应有结算');
  assert.equal(result.deltas.reduce((s, d) => s + d.delta, 0), 0, '分数守恒');
  console.log(`7) 一局结束：${result.landlordWin ? '地主' : '农民'}胜，${result.multiplier} 倍`);

  const health = await fetch(BASE + '/healthz');
  assert.equal(health.status, 200);
  console.log('8) 服务仍然健康 ✔');

  for (const c of clients) c.ws.close();
  spec.ws.close();
  console.log('\nE2E 全部通过');
}

main().catch((err) => {
  console.error('\nE2E 失败：', err);
  process.exit(1);
});
