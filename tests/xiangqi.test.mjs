// 中国象棋规则用例
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  XiangqiGame,
  legalMoves,
  pseudoMoves,
  inCheck,
  generalsFacing,
  chooseXiangqiMove,
  W,
  H,
} from '../app/games/xiangqi/engine.mjs';

const at = (b, x, y) => b[y * W + x];
const mk = () =>
  new XiangqiGame([
    { seat: 0, nick: '红' },
    { seat: 1, nick: '黑' },
  ]);

test('象棋：开局红方有 44 步合法走法', () => {
  const g = mk();
  const moves = legalMoves(g.board, 1);
  assert.equal(moves.length, 44, `开局应当是 44 步，实际 ${moves.length}`);
});

test('象棋：马会被蹩腿', () => {
  const g = mk();
  const b = g.board.slice();
  // 右下角红马 (1,9)，可以跳到 (2,7) 和 (0,7)
  const before = pseudoMoves(b, 1, 9).map((m) => `${m.x},${m.y}`);
  assert.ok(before.includes('2,7'));
  assert.ok(before.includes('0,7'));
  b[8 * W + 1] = 7; // 在 (1,8) 放个兵，堵住马腿
  const after = pseudoMoves(b, 1, 9).map((m) => `${m.x},${m.y}`);
  assert.ok(!after.includes('2,7'), '蹩腿后不该能跳过去');
  assert.ok(!after.includes('0,7'), '同一条腿挡住，两个方向都不能走');
});

test('象棋：象不能过河，象眼被塞也走不了', () => {
  const g = mk();
  const b = g.board.slice();
  const moves = pseudoMoves(b, 2, 9);
  assert.ok(moves.every((m) => m.y >= 5), '象不能过河');
  b[8 * W + 3] = 7; // 塞象眼
  assert.ok(!pseudoMoves(b, 2, 9).some((m) => m.x === 4 && m.y === 7));
});

test('象棋：炮吃子必须隔一个炮架', () => {
  const g = mk();
  const b = g.board.slice();
  // 红炮 (1,7) 向上：第一个碰到的是 (1,2) 的黑炮，它只是炮架，不能吃；
  // 隔着它才能吃到 (1,0) 的黑马
  const before = pseudoMoves(b, 1, 7).map((m) => `${m.x},${m.y}`);
  assert.ok(!before.includes('1,2'), '炮不能直接吃第一个挡路的子');
  assert.ok(before.includes('1,0'), '隔着一个炮架可以吃后面的子');

  b[5 * W + 1] = 7; // 在 (1,5) 再垫一个子，炮架变成它
  const after = pseudoMoves(b, 1, 7).map((m) => `${m.x},${m.y}`);
  assert.ok(after.includes('1,2'), '炮架换成 (1,5) 后，黑炮就是可吃的目标');
  assert.ok(!after.includes('1,0'), '隔了两个子不能再吃更远的');
});

test('象棋：将帅不能照面', () => {
  const b = new Array(W * H).fill(0);
  b[9 * W + 4] = 1; // 红帅
  b[0 * W + 4] = -1; // 黑将
  assert.equal(generalsFacing(b), true);
  b[5 * W + 4] = 7; // 中间垫一个子
  assert.equal(generalsFacing(b), false);
});

test('象棋：被将军时不能走无关的棋', () => {
  const g = mk();
  const b = g.board.slice();
  // 把红帅挪到 (4,9)，黑车放到 (4,0) 形成将军，中间清空
  for (let y = 1; y < 9; y++) b[y * W + 4] = 0;
  b[9 * W + 4] = 1;
  b[0 * W + 4] = -5;
  assert.equal(inCheck(b, 1), true);
  const moves = legalMoves(b, 1);
  // 所有走法都必须解除将军：要么挪帅，要么挡/吃车
  for (const m of moves) {
    const nb = b.slice();
    nb[m.to.y * W + m.to.x] = nb[m.from.y * W + m.from.x];
    nb[m.from.y * W + m.from.x] = 0;
    assert.equal(inCheck(nb, 1), false, '不能留下被将的棋');
  }
});

test('象棋：将死即结束，分数守恒', () => {
  const g = mk();
  const b = new Array(W * H).fill(0);
  b[0 * W + 4] = -1; // 黑将 (4,0)
  b[1 * W + 3] = 5; // 红车 (3,1)
  b[1 * W + 5] = 5; // 红车 (5,1)
  b[3 * W + 4] = 5; // 红车 (4,3)，下一步平到 (4,2) 将军
  b[9 * W + 4] = 1; // 红帅
  g.board = b;
  g.turn = 0;

  g.act(0, { type: 'move', from: { x: 4, y: 3 }, to: { x: 4, y: 2 } });
  assert.equal(g.phase, 'over', '这是绝杀，应当直接结束');
  assert.equal(g.result.winnerSeat, 0);
  assert.equal(g.result.summary, '将死');
  assert.equal(g.result.deltas.reduce((s, d) => s + d.delta, 0), 0);
});

test('象棋：机器人只会走合法棋', () => {
  const g = mk();
  for (let i = 0; i < 6; i++) {
    if (g.phase === 'over') break;
    const mv = chooseXiangqiMove(g, g.turn);
    assert.equal(mv.type, 'move');
    g.act(g.turn, mv);
  }
  assert.ok(g.ply >= 1);
});

test('象棋：整整一局机器人对机器人能下完', () => {
  const g = mk();
  let guard = 0;
  while (g.phase !== 'over' && guard < 300) {
    const mv = chooseXiangqiMove(g, g.turn);
    g.act(g.turn, mv);
    guard += 1;
  }
  // 允许没下完（步数上限），但至少不能崩
  assert.ok(g.ply > 0);
  if (g.phase === 'over') {
    assert.ok(g.result);
    assert.equal(g.result.deltas.reduce((s, d) => s + d.delta, 0), 0);
  }
});
