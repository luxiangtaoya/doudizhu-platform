// 五子棋引擎 + 提示列表的用例
import test from 'node:test';
import assert from 'node:assert/strict';

import { GomokuGame, chooseGomokuMove } from '../app/games/gomoku/engine.mjs';
import { DdzGame } from '../app/games/ddz/engine.mjs';
import { hintMoves, chooseMove } from '../app/games/ddz/ai.mjs';

const c = (v, s = 0) => (v <= 15 ? (v - 3) * 4 + s : v === 16 ? 52 : 53);

const mk = () =>
  new GomokuGame([
    { seat: 0, nick: '黑' },
    { seat: 1, nick: '白' },
  ]);

test('五子棋：轮流落子，黑先', () => {
  const g = mk();
  assert.equal(g.turn, 0);
  g.act(0, { type: 'place', x: 7, y: 7 });
  assert.equal(g.grid[7 * 15 + 7], 1);
  assert.equal(g.turn, 1);
  g.act(1, { type: 'place', x: 8, y: 7 });
  assert.equal(g.grid[7 * 15 + 8], 2);
  assert.equal(g.turn, 0);
});

test('五子棋：横着连五判胜，分数守恒', () => {
  const g = mk();
  // 黑 (0..4,0)，白 (0..3,1)
  for (let i = 0; i < 5; i++) {
    g.act(0, { type: 'place', x: i, y: 0 });
    if (i < 4) g.act(1, { type: 'place', x: i, y: 1 });
  }
  assert.equal(g.phase, 'over');
  assert.equal(g.winner, 0);
  assert.equal(g.result.deltas.reduce((s, d) => s + d.delta, 0), 0);
});

test('五子棋：斜着连五也判胜', () => {
  const g = mk();
  for (let i = 0; i < 5; i++) {
    g.act(0, { type: 'place', x: i, y: i });
    if (i < 4) g.act(1, { type: 'place', x: i, y: i + 5 });
  }
  assert.equal(g.phase, 'over');
  assert.equal(g.winner, 0);
});

test('五子棋：重复落子 / 非法位置 / 抢手都会报错', () => {
  const g = mk();
  g.act(0, { type: 'place', x: 7, y: 7 });
  assert.throws(() => g.act(1, { type: 'place', x: 7, y: 7 }), /已经有子/);
  assert.throws(() => g.act(1, { type: 'place', x: -1, y: 3 }), /位置/);
  assert.throws(() => g.act(0, { type: 'place', x: 1, y: 1 }), /还没轮到你/);
});

test('五子棋：机器人会堵对手的四连', () => {
  const g = mk();
  // 黑在 (0..3,0) 连成四，白只有三子，轮到白必须堵 (4,0)
  for (let i = 0; i < 4; i++) {
    g.act(0, { type: 'place', x: i, y: 0 });
    if (i < 3) g.act(1, { type: 'place', x: i, y: 8 });
  }
  const mv = chooseGomokuMove(g, 1);
  assert.equal(mv.type, 'place');
  assert.deepEqual([mv.x, mv.y], [4, 0], `应堵在 (4,0)，实际 (${mv.x},${mv.y})`);
});

test('提示：队友压住时 AI 会 pass，但提示仍要列出可出的牌', () => {
  const g = new DdzGame([
    { seat: 0, nick: '地主' },
    { seat: 1, nick: '农民A' },
    { seat: 2, nick: '农民B' },
  ]);
  g.phase = 'playing';
  g.seats[0].role = 'landlord';
  g.seats[1].role = 'farmer';
  g.seats[2].role = 'farmer';
  g.turn = 2;
  g.lastPlay = { seat: 1, cards: [c(5)], pattern: { type: 'single', len: 1, main: 5, size: 1 } };
  g.seats[1].hand = [c(10), c(11), c(12)];
  g.seats[0].hand = [c(9), c(9, 1), c(13), c(14)];
  g.seats[2].hand = [c(6), c(7), c(8)];

  // AI 的策略：队友已经压住，选择不要
  assert.equal(chooseMove(g, 2).type, 'pass');

  // 提示必须如实给出可出的牌
  const moves = hintMoves(g, 2);
  assert.ok(moves.length >= 3, `应至少列出三张单牌，实际 ${moves.length}`);
  assert.ok(moves.every((cards) => cards.every((id) => g.seats[2].hand.includes(id))));
  // 最小的排在最前面
  assert.deepEqual(moves[0], [c(6)]);
});

test('提示：按从小到大排序，方便反复点击切换', () => {
  const g = new DdzGame([
    { seat: 0, nick: 'A' },
    { seat: 1, nick: 'B' },
    { seat: 2, nick: 'C' },
  ]);
  g.phase = 'playing';
  g.turn = 0;
  g.lastPlay = null;
  g.seats[0].hand = [c(6), c(6, 1), c(7), c(7, 1), c(9)];
  const moves = hintMoves(g, 0);
  const mains = moves.map((cards) => Math.max(...cards.map((id) => (id >= 52 ? 16 : Math.floor(id / 4) + 3))));
  const sorted = [...mains].sort((a, b) => a - b);
  assert.deepEqual(mains, sorted, '提示顺序应从小到大');
});
