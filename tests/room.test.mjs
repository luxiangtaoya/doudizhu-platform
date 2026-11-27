// 房间层测试：单人对两个机器人能打完；掉线后自动托管也能打完。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Hub } from '../app/core/hub.mjs';
import { Room } from '../app/core/room.mjs';
import { Store } from '../app/store.mjs';
import { valueOf } from '../app/games/ddz/cards.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeHub(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddz-room-'));
  const store = new Store(dir);
  const cfg = {
    maxMultiplier: 16,
    turnSeconds: 30,
    bidSeconds: 15,
    graceSeconds: 15,
    roomIdleMinutes: 10,
    botDelayMs: 10,
    botJitterMs: 0,
    ...overrides,
  };
  const hub = new Hub({ cfg, store });
  hub.send = () => {}; // 测试里不真的推消息
  return { hub, store, dir };
}

function humanAct(room, pid) {
  const g = room.game;
  const seat = room.seatOf(pid);
  if (!g || g.phase === 'over' || g.turn !== seat) return false;
  if (g.phase === 'bid') {
    room.act(pid, { type: 'bid', value: 3 });
    return true;
  }
  const leading = !g.lastPlay || g.lastPlay.seat === seat;
  if (leading) {
    const hand = [...g.seats[seat].hand].sort((a, b) => valueOf(a) - valueOf(b));
    room.act(pid, { type: 'play', cards: [hand[0]] });
  } else {
    room.act(pid, { type: 'pass' });
  }
  return true;
}

test('房间里 1 个人 + 2 个机器人可以打完一局', async () => {
  const { hub, dir } = makeHub();
  const room = new Room(hub, 'ddz', 'p1');
  room.addPlayer('p1', '我');
  room.start('p1');

  assert.equal(room.seats.filter(Boolean).length, 3);
  assert.equal(room.seats.filter((s) => s && s.isBot).length, 2, '应自动补两个机器人');
  assert.equal(room.state, 'playing');

  let guard = 0;
  while (room.state !== 'over' && guard < 600) {
    humanAct(room, 'p1');
    room.tick();
    await sleep(8);
    guard += 1;
  }
  assert.equal(room.state, 'over', '牌局应当结束');
  assert.ok(room.game.result, '应当有结算结果');
  assert.equal(room.game.result.deltas.reduce((s, d) => s + d.delta, 0), 0);

  hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('人掉线超过宽限期后由机器人接管，牌局仍能结束', async () => {
  const { hub, dir } = makeHub({ graceSeconds: 1 });
  const room = new Room(hub, 'ddz', 'p1');
  room.addPlayer('p1', '我');
  room.addPlayer('p2', '同事');
  room.start('p1');
  assert.equal(room.seats.filter((s) => s && s.isBot).length, 1, '两个真人 + 一个机器人');

  // 真人 p2 掉线
  room.removePlayer('p2');
  assert.equal(room.seats[1].online, false);
  assert.equal(room.seats[1].auto, false, '宽限期内还不托管');

  await sleep(1200);
  room.tick();
  assert.equal(room.seats[1].auto, true, '过了宽限期应托管');

  let guard = 0;
  while (room.state !== 'over' && guard < 800) {
    humanAct(room, 'p1');
    room.tick();
    await sleep(8);
    guard += 1;
  }
  assert.equal(room.state, 'over', '托管后牌局应当结束');
  assert.ok(room.game.result);

  hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('没有能压的牌时，提示返回空并标记 pass', () => {
  const { hub, dir } = makeHub();
  const room = new Room(hub, 'ddz', 'p1');
  room.addPlayer('p1', '我');
  room.start('p1');

  const g = room.game;
  g.bidCurrent = 3;
  g._finishBid(0);
  // 假装上家刚出了王炸，谁也压不过
  g.turn = 0;
  g.lastPlay = { seat: 1, cards: [52, 53], pattern: { type: 'rocket', len: 1, main: 17, size: 2 } };
  g.deadline = Date.now() + 30000;

  const captured = [];
  const conn = { pid: 'p1', send: (m) => captured.push(m) };
  hub.players.set('p1', { pid: 'p1', nick: '我', conn, roomId: room.id });
  hub.rooms.set(room.id, room);

  hub.onMessage(conn, { t: 'hint' });
  const hint = captured.pop();
  assert.equal(hint.t, 'hint');
  assert.equal(hint.pass, true);
  assert.equal(hint.moves.length, 0);

  hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('一局结束后机器人让位，别的人能进房间', () => {
  const { hub, dir } = makeHub();
  const room = new Room(hub, 'ddz', 'p1');
  room.addPlayer('p1', '我');
  room.start('p1');
  assert.equal(room.seats.filter((s) => s && s.isBot).length, 2);

  // 直接让 p1 出完最后一张，触发结算
  const g = room.game;
  g.bidCurrent = 3;
  g._finishBid(0);
  g.turn = 0;
  g.lastPlay = null;
  g.passCount = 0;
  g.seats[0].hand = [g.seats[0].hand[0]];
  room.act('p1', { type: 'play', cards: [g.seats[0].hand[0]] });
  assert.equal(room.state, 'over');

  assert.equal(room.seats.filter((s) => s && s.isBot).length, 0, '机器人应当退出座位');
  const seat = room.addPlayer('p2', '同事');
  assert.ok(seat >= 0, '第二个人应该能坐下');

  hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('新一局会清掉上一局残留的托管状态', () => {
  const { hub, dir } = makeHub();
  const room = new Room(hub, 'ddz', 'p1');
  room.addPlayer('p1', '我');
  room.start('p1');
  room.state = 'over';
  room.seats[0].auto = true;
  room.start('p1');
  assert.equal(room.seats[0].auto, false, '重新开局不该继续托管');
  hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('满员后进来的人变成观战，且能看到观战列表', () => {
  const { hub, dir } = makeHub();
  const room = new Room(hub, 'ddz', 'p1');
  room.addPlayer('p1', '甲');
  room.addPlayer('p2', '乙');
  room.addPlayer('p3', '丙');
  const seat = room.addPlayer('p4', '丁');
  assert.equal(seat, -1, '第四个人应当是观战');
  assert.ok(room.isSpectator('p4'));

  const view = room.view(null);
  assert.equal(view.spectator, true);
  assert.equal(view.youSeat, -1);
  assert.deepEqual(view.spectators, ['丁']);

  room.start('p1');
  assert.throws(() => room.act('p4', { type: 'pass' }), /观战/);

  hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('有人离开后观战的人自动补位', () => {
  const { hub, dir } = makeHub();
  const room = new Room(hub, 'ddz', 'p1');
  room.addPlayer('p1', '甲');
  room.addPlayer('p2', '乙');
  room.addPlayer('p3', '丙');
  room.addPlayer('p4', '丁');
  assert.ok(room.isSpectator('p4'));

  room.removePlayer('p2');
  assert.equal(room.spectators.size, 0, '观战的人应当坐下来');
  assert.ok(room.seatOf('p4') >= 0);
  assert.equal(room.view(room.seatOf('p4')).spectator, false);

  hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('托管开关会写进房间状态，取消后恢复', () => {
  const { hub, dir } = makeHub();
  const room = new Room(hub, 'ddz', 'p1');
  room.addPlayer('p1', '我');
  room.start('p1');
  room.setAuto('p1', true);
  assert.equal(room.view(0).auto, true);
  assert.throws(() => room.act('p1', { type: 'pass' }), /托管/);
  room.setAuto('p1', false);
  assert.equal(room.view(0).auto, false);

  hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('五子棋房间只有两个座位', () => {
  const { hub, dir } = makeHub();
  const room = new Room(hub, 'gomoku', 'p1');
  assert.equal(room.seats.length, 2);
  room.addPlayer('p1', '甲');
  room.addPlayer('p2', '乙');
  const third = room.addPlayer('p3', '丙');
  assert.equal(third, -1, '五子棋第三个人是观战');
  room.start('p1');
  assert.equal(room.game.seats.length, 2);

  hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('改名会同步座位昵称，并把战绩并到新名字上', () => {
  const { hub, store, dir } = makeHub();
  store.recordPlayer('老王', 10, true);

  const room = new Room(hub, 'ddz', 'p1');
  room.addPlayer('p1', '老王');
  const sent = [];
  hub.players.set('p1', { pid: 'p1', nick: '老王', conn: { send: (m) => sent.push(m) }, roomId: room.id });
  hub.rooms.set(room.id, room);

  hub.rename(hub.players.get('p1'), '老李');

  assert.equal(room.seats[0].nick, '老李');
  assert.equal(hub.players.get('p1').nick, '老李');
  assert.equal(store.stats('老李').score, 10, '战绩应当跟着新名字');
  assert.ok(sent.some((m) => m.t === 'nick' && m.nick === '老李'));

  hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('房主退出后房主身份转移给另一个人', () => {
  const { hub, dir } = makeHub();
  const room = new Room(hub, 'ddz', 'p1');
  room.addPlayer('p1', '甲');
  room.addPlayer('p2', '乙');
  assert.equal(room.hostPid, 'p1');
  room.removePlayer('p1');
  assert.equal(room.hostPid, 'p2');
  hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('非法出牌返回可读原因，而不是「服务器开小差了」', () => {
  const { hub, dir } = makeHub();
  const room = new Room(hub, 'ddz', 'p1');
  room.addPlayer('p1', '我');
  room.start('p1');

  // 直接推进到「p1 当地主、轮到他出牌」
  const g = room.game;
  g.bidCurrent = 3;
  g._finishBid(0);
  g.turn = 0;
  g.deadline = Date.now() + 30000;

  // 找两张点数不同的牌，凑一个非法牌型
  const hand = g.seats[0].hand;
  const a = hand[0];
  const b = hand.find((id) => valueOf(id) !== valueOf(a));
  assert.ok(b !== undefined, '手牌里应该有两种点数');

  const captured = [];
  const conn = { pid: 'p1', send: (m) => captured.push(m) };
  hub.players.set('p1', { pid: 'p1', nick: '我', conn, roomId: room.id });
  hub.rooms.set(room.id, room);

  // 提示接口不应抛异常，返回的牌必须在自己手里
  hub.onMessage(conn, { t: 'hint' });
  const hintMsg = captured.pop();
  assert.equal(hintMsg?.t, 'hint');
  assert.ok(Array.isArray(hintMsg.moves));
  for (const cards of hintMsg.moves) {
    for (const id of cards) assert.ok(hand.includes(id), '提示的牌必须在自己手里');
  }

  hub.onMessage(conn, { t: 'act', action: { type: 'play', cards: [a, b] } });
  assert.equal(captured[0]?.t, 'error');
  assert.notEqual(captured[0].msg, '服务器开小差了');
  assert.match(captured[0].msg, /牌型/);

  hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
