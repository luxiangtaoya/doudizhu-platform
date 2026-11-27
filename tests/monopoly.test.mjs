// 大富翁规则用例
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MonopolyGame,
  chooseMonopolyAction,
  START_CASH,
  SALARY,
  TILES,
  SIZE,
} from '../app/games/monopoly/engine.mjs';

const mk = (n = 4) =>
  new MonopolyGame(
    Array.from({ length: n }, (_, i) => ({ seat: i, nick: `P${i}` })),
    { maxRounds: 30 },
  );

const propAt = (name) => TILES.findIndex((t) => t.name === name);

test('大富翁：开局 4 人，现金一致，都在起点', () => {
  const g = mk();
  assert.equal(g.players.length, 4);
  assert.ok(g.players.every((p) => p.cash === START_CASH && p.pos === 0));
  assert.equal(g.phase, 'roll');
  assert.equal(g.turn, 0);
});

test('大富翁：掷骰子会移动 2~12 步，经过起点加钱', () => {
  const g = mk();
  const orig = Math.random;
  Math.random = () => 0; // 固定骰子为 1+1
  try {
    g.players[0].pos = 27; // 再走一步就经过起点
    const before = g.players[0].cash;
    g.act(0, { type: 'roll' });
    assert.deepEqual(g.dice, [1, 1]);
    assert.equal(g.players[0].pos, 1);
    assert.equal(g.players[0].cash, before + SALARY, '经过起点应当领工资');
    assert.equal(g.phase, 'buy', '落在无主地产上，应当可以买');
  } finally {
    Math.random = orig;
  }
});

test('大富翁：踩到无主地产可以买下，别人踩到要交租', () => {
  const g = mk();
  const idx = propAt('中山路');
  const price = TILES[idx].price;

  g.players[0].pos = idx;
  g._land(g.players[0], false);
  assert.equal(g.phase, 'buy', '应当进入购买决策');
  g.act(0, { type: 'buy', yes: true });
  assert.equal(g.owners[idx], 0);
  assert.equal(g.players[0].cash, START_CASH - price);

  // 换成 1 号玩家踩上去
  g.turn = 1;
  g.phase = 'roll';
  g.players[1].pos = idx;
  const before = g.players[1].cash;
  g._land(g.players[1], false);
  assert.equal(g.players[1].cash, before - g.rentOf(idx));
  assert.equal(g.players[0].cash, START_CASH - price + g.rentOf(idx));
});

test('大富翁：升级后租金翻倍，满级封顶', () => {
  const g = mk();
  const idx = propAt('西湖');
  g.owners[idx] = 0;
  const base = g.rentOf(idx);
  const cost = g.upgradeCost(idx);
  const before = g.players[0].cash;

  g.turn = 0;
  g.phase = 'end';
  g.act(0, { type: 'upgrade', tile: idx });
  assert.equal(g.levels[idx], 1);
  assert.equal(g.rentOf(idx), base * 2);
  assert.equal(g.players[0].cash, before - cost);

  g.act(0, { type: 'upgrade', tile: idx });
  g.act(0, { type: 'upgrade', tile: idx });
  assert.equal(g.levels[idx], 3);
  assert.throws(() => g.act(0, { type: 'upgrade', tile: idx }), /满级/);
});

test('大富翁：钱不够会破产，名下地产被收回', () => {
  const g = mk();
  const idx = propAt('春熙路');
  g.owners[idx] = 1;
  g.levels[idx] = 0;
  g.players[0].cash = 100; // 踩上去的人付不起租金
  g.players[0].pos = idx;
  g.turn = 0;
  g.phase = 'roll';
  g._land(g.players[0], false);
  assert.equal(g.players[0].bankrupt, true);
  assert.equal(g.players[0].cash, 0);
  // 破产后手牌/地产被释放，且不会卡在这个人的回合
  assert.notEqual(g.turn, 0, '破产后应当直接轮到下一位');
});

test('大富翁：只剩一个人时直接结束', () => {
  const g = mk(2);
  g.players[1].cash = 50;
  g.owners[propAt('鼓浪屿')] = 0;
  g.players[1].pos = propAt('鼓浪屿');
  g.turn = 1;
  g.phase = 'roll';
  g._land(g.players[1], false);
  assert.equal(g.phase, 'over');
  assert.equal(g.result.winnerSeat, 0);
  assert.equal(g.result.deltas.reduce((s, d) => s + (d.delta > 0 ? 1 : -1), 0) >= 0, true);
});

test('大富翁：机器人能自己打完整局不崩', () => {
  const g = mk(4);
  let guard = 0;
  while (g.phase !== 'over' && guard < 3000) {
    const seat = g.turn;
    const act = chooseMonopolyAction(g, seat);
    g.act(seat, act);
    guard += 1;
  }
  assert.ok(guard < 3000, '不该死循环');
  if (g.phase === 'over') {
    assert.ok(g.result);
    assert.equal(g.result.deltas.length, 4);
  }
});

test('大富翁：监狱会跳过一回合', () => {
  const g = mk(3);
  g.players[0].jail = 1;
  g.turn = 0;
  g.phase = 'roll';
  // 走完一圈回到 0 号时，他应该被跳过
  g._endTurn();
  assert.equal(g.turn, 1);
  g._endTurn();
  assert.equal(g.turn, 2);
  g._endTurn();
  // 正常应该轮回到 0，但他在监狱 → 跳过，直接到 1
  assert.equal(g.turn, 1, '在监狱里的人应当被跳过');
  assert.equal(g.players[0].jail, 0, '跳过之后监禁状态清除');
});
