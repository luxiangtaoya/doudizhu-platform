// 牌型判定的关键用例。命名规则：c(点数, 花色)
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyze, beats } from '../app/games/ddz/rules.mjs';
import { DdzGame } from '../app/games/ddz/engine.mjs';
import { chooseMove, chooseBid } from '../app/games/ddz/ai.mjs';

const c = (v, s = 0) => (v <= 15 ? (v - 3) * 4 + s : v === 16 ? 52 : 53);

const T = (label, ids, expected) =>
  test(`牌型：${label}`, () => {
    const p = analyze(ids);
    if (expected === null) assert.equal(p, null);
    else {
      assert.ok(p, `应识别为 ${expected.type}，实际 null`);
      assert.equal(p.type, expected.type);
      if (expected.len !== undefined) assert.equal(p.len, expected.len);
      if (expected.main !== undefined) assert.equal(p.main, expected.main);
    }
  });

T('单张', [c(3)], { type: 'single', main: 3 });
T('对子', [c(5), c(5, 1)], { type: 'pair', main: 5 });
T('三张', [c(7), c(7, 1), c(7, 2)], { type: 'triple', main: 7 });
T('三带一', [c(7), c(7, 1), c(7, 2), c(9)], { type: 'triple1', main: 7 });
T('三带一对', [c(7), c(7, 1), c(7, 2), c(9), c(9, 1)], { type: 'triple2', main: 7 });
T('顺子 3-7', [3, 4, 5, 6, 7].map((v) => c(v)), { type: 'straight', len: 5, main: 7 });
T('顺子不能带 2', [11, 12, 13, 14, 15].map((v) => c(v)), null);
T('顺子不能有重复', [3, 3, 4, 5, 6].map((v) => c(v)), null);
T('连对 334455', [3, 3, 4, 4, 5, 5].map((v, i) => c(v, i % 2)), { type: 'pairs', len: 3, main: 5 });
T('连对至少三对', [3, 3, 4, 4].map((v, i) => c(v, i % 2)), null);
T('飞机 333444', [3, 3, 3, 4, 4, 4].map((v, i) => c(v, i % 3)), { type: 'plane', len: 2, main: 4 });
T('飞机带单', [3, 3, 3, 4, 4, 4, 5, 6].map((v, i) => c(v, i % 3)), { type: 'plane1', len: 2, main: 4 });
T('飞机带对', [3, 3, 3, 4, 4, 4, 5, 5, 6, 6].map((v, i) => c(v, i % 3)), { type: 'plane2', len: 2, main: 4 });
T('四带二', [3, 3, 3, 3, 5, 9].map((v, i) => c(v, i % 4)), { type: 'four2', main: 3 });
T('四带两对', [3, 3, 3, 3, 5, 5, 9, 9].map((v, i) => c(v, i % 4)), { type: 'four2p', main: 3 });
T('炸弹', [c(8), c(8, 1), c(8, 2), c(8, 3)], { type: 'bomb', main: 8 });
T('王炸', [52, 53], { type: 'rocket' });
T('非法：334', [c(3), c(3, 1), c(4)], null);
T('非法：四带一', [c(6), c(6, 1), c(6, 2), c(6, 3), c(9)], null);
T('非法：拆炸弹当飞机机身', [c(3), c(3, 1), c(3, 2), c(3, 3), c(4), c(4, 1), c(4, 2), c(5), c(5, 1)], null);

test('压牌：同型比大小', () => {
  const p4 = analyze([c(4), c(4, 1)]);
  const p5 = analyze([c(5), c(5, 1)]);
  assert.equal(beats(p5, p4), true);
  assert.equal(beats(p4, p5), false);
});

test('压牌：炸弹压普通牌，王炸压炸弹', () => {
  const straight = analyze([3, 4, 5, 6, 7].map((v) => c(v)));
  const bomb = analyze([c(3), c(3, 1), c(3, 2), c(3, 3)]);
  const rocket = analyze([52, 53]);
  assert.equal(beats(bomb, straight), true);
  assert.equal(beats(straight, bomb), false);
  assert.equal(beats(rocket, bomb), true);
  assert.equal(beats(bomb, rocket), false);
});

test('压牌：长度不同不能压', () => {
  const s5 = analyze([3, 4, 5, 6, 7].map((v) => c(v)));
  const s6 = analyze([4, 5, 6, 7, 8, 9].map((v) => c(v)));
  assert.equal(beats(s6, s5), false);
});

test('叫分：三家不叫会重新发牌', () => {
  const g = new DdzGame([
    { seat: 0, nick: 'A' },
    { seat: 1, nick: 'B' },
    { seat: 2, nick: 'C' },
  ]);
  const first = g.dealNo;
  for (let i = 0; i < 3; i++) g.act(g.turn, { type: 'bid', value: 0 });
  assert.equal(g.phase, 'bid');
  assert.equal(g.dealNo, first + 1, '应该重新发牌');
});

test('叫三分直接成为地主并拿底牌', () => {
  const g = new DdzGame([
    { seat: 0, nick: 'A' },
    { seat: 1, nick: 'B' },
    { seat: 2, nick: 'C' },
  ]);
  const landlord = g.turn;
  g.act(landlord, { type: 'bid', value: 3 });
  assert.equal(g.phase, 'playing');
  assert.equal(g.seats.find((s) => s.seat === landlord).hand.length, 20);
  assert.equal(g.seats.find((s) => s.role === 'landlord').seat, landlord);
});

test('连续流局三次后强制 1 分，不会无限重发', () => {
  const g = new DdzGame([
    { seat: 0, nick: 'A' },
    { seat: 1, nick: 'B' },
    { seat: 2, nick: 'C' },
  ]);
  let guard = 0;
  while (g.phase === 'bid' && guard < 30) {
    g.act(g.turn, { type: 'bid', value: 0 });
    guard += 1;
  }
  assert.equal(g.phase, 'playing', '应当强制成局');
  assert.ok(guard <= 12, `不该无限重发（用了 ${guard} 次叫分）`);
  const landlord = g.seats.find((s) => s.role === 'landlord');
  assert.ok(landlord, '应当有地主');
  assert.equal(landlord.hand.length, 20);
  assert.equal(g.bidCurrent, 1, '强制局底分为 1');
});

test('整局：三个机器人能打完，分数守恒', () => {
  let finished = 0;
  for (let round = 0; round < 20; round++) {
    const g = new DdzGame([
      { seat: 0, nick: 'B1', isBot: true },
      { seat: 1, nick: 'B2', isBot: true },
      { seat: 2, nick: 'B3', isBot: true },
    ]);
    // 强制叫到地主，避免全部不叫导致重发
    g.act(g.turn, { type: 'bid', value: 3 });

    let steps = 0;
    while (g.phase !== 'over' && steps < 400) {
      const mv = chooseMove(g, g.turn);
      g.act(g.turn, mv);
      steps += 1;
    }
    assert.equal(g.phase, 'over', `第 ${round} 局没打完（${steps} 步）`);
    assert.ok(g.result, '应有结算结果');
    const sum = g.result.deltas.reduce((s, d) => s + d.delta, 0);
    assert.equal(sum, 0, '分数变化必须守恒');
    assert.ok(g.result.multiplier >= 1 && g.result.multiplier <= 16);
    assert.ok(g.result.winnerSeat >= 0);
    finished += 1;
  }
  assert.equal(finished, 20);
});

test('机器人叫分不会超过当前叫分', () => {
  let checked = 0;
  for (let i = 0; i < 50; i++) {
    const g = new DdzGame([
      { seat: 0, nick: 'B1', isBot: true },
      { seat: 1, nick: 'B2', isBot: true },
      { seat: 2, nick: 'B3', isBot: true },
    ]);
    const v = chooseBid(g.seats[g.turn].hand, 2);
    assert.ok(v === 0 || v === 3, `当前 2 分时只能叫 3 分或不叫，得到 ${v}`);
    checked += 1;
  }
  assert.equal(checked, 50);
});
