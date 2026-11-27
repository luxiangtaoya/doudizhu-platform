import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { encodeFrame, FrameDecoder, OP } from '../app/ws/codec.mjs';
import { Auth } from '../app/auth.mjs';
import { attachWs } from '../app/ws/server.mjs';
import { Store } from '../app/store.mjs';

test('WS 帧：带掩码的文本帧可以原样解回', () => {
  const text = JSON.stringify({ t: 'hello', nick: '老王' });
  const payload = Buffer.from(text, 'utf8');
  const frame = encodeFrame(OP.TEXT, payload, { mask: true });

  const decoder = new FrameDecoder({ requireMask: true });
  const out = decoder.push(frame);
  assert.equal(out.length, 1);
  assert.equal(out[0].opcode, OP.TEXT);
  assert.equal(out[0].payload.toString('utf8'), text);
});

test('WS 帧：分片消息能拼起来', () => {
  const a = encodeFrame(OP.TEXT, Buffer.from('你'), { mask: true });
  // 手工构造：首帧 FIN=0，续帧 FIN=1
  const first = Buffer.from(a);
  first[0] = 0x01; // FIN=0, opcode=TEXT
  const second = encodeFrame(OP.CONTINUATION, Buffer.from('好'), { mask: true });

  const decoder = new FrameDecoder({ requireMask: true });
  const out1 = decoder.push(Buffer.concat([first, second]));
  assert.equal(out1.length, 1);
  assert.equal(out1[0].payload.toString('utf8'), '你好');
});

test('WS 帧：未加掩码的客户端帧应报错', () => {
  const frame = encodeFrame(OP.TEXT, Buffer.from('x'), { mask: false });
  const decoder = new FrameDecoder({ requireMask: true });
  assert.throws(() => decoder.push(frame), /掩码/);
});

test('门禁：口令正确才发会话', () => {
  const auth = new Auth({ passphrase: '95599' });
  const bad = auth.login('12345', '10.0.0.1');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'bad_pass');

  const good = auth.login('95599', '10.0.0.1');
  assert.equal(good.ok, true);
  assert.ok(auth.check(good.token));
  assert.equal(auth.check('forged-token'), null);
});

test('门禁：连续输错会锁定', () => {
  const auth = new Auth({ passphrase: '95599', maxTries: 3, lockMs: 60000 });
  for (let i = 0; i < 3; i++) auth.login('bad', '10.0.0.2');
  const locked = auth.login('95599', '10.0.0.2');
  assert.equal(locked.ok, false);
  assert.equal(locked.code, 'locked');
});

test('门禁：会话可登出', () => {
  const auth = new Auth({ passphrase: '95599' });
  const { token } = auth.login('95599', '10.0.0.3');
  assert.ok(auth.check(token));
  auth.logout(token);
  assert.equal(auth.check(token), null);
});

test('积分文件重启后能读回来', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddz-store-'));
  fs.writeFileSync(
    path.join(dir, 'store.json'),
    JSON.stringify({
      players: { 老王: { nick: '老王', score: 24, games: 6, wins: 4, lastSeen: 1 } },
      matches: [],
      updatedAt: 1,
    }),
    'utf8',
  );
  const store = new Store(dir);
  assert.equal(store.stats('老王').score, 24, '重启后积分不该丢');
  assert.equal(store.top(5)[0].nick, '老王');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('心跳踢掉的连接也会触发 onClose（否则在线人数会一直挂着）', async () => {
  const server = http.createServer();
  let closed = 0;
  attachWs(server, {
    path: '/ws',
    heartbeatMs: 150,
    verify: () => ({}),
    onConnect: () => {},
    onMessage: () => {},
    onClose: () => {
      closed += 1;
    },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const socket = net.connect(port, '127.0.0.1');
  await new Promise((r) => socket.on('connect', r));
  socket.write(
    'GET /ws HTTP/1.1\r\n' +
      'Host: 127.0.0.1\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Key: ' +
      crypto.randomBytes(16).toString('base64') +
      '\r\n' +
      'Sec-WebSocket-Version: 13\r\n\r\n',
  );
  // 这个客户端故意不回 pong，等心跳把它踢掉
  await new Promise((r) => setTimeout(r, 900));
  assert.ok(closed >= 1, '服务端关闭连接时必须通知上层');
  socket.destroy();
  await new Promise((r) => server.close(r));
});
