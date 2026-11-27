// 中国象棋（9×10）。棋子用正负号区分颜色：正数红方，负数黑方。
// 1 帅/将 2 仕/士 3 相/象 4 马 5 车 6 炮 7 兵/卒
export class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const W = 9;
export const H = 10;
export const K = 1;
export const A = 2;
export const E = 3;
export const N = 4;
export const R = 5;
export const C = 6;
export const P = 7;

const INIT = [
  -5, -4, -3, -2, -1, -2, -3, -4, -5,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, -6, 0, 0, 0, 0, 0, -6, 0,
  -7, 0, -7, 0, -7, 0, -7, 0, -7,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  7, 0, 7, 0, 7, 0, 7, 0, 7,
  0, 6, 0, 0, 0, 0, 0, 6, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  5, 4, 3, 2, 1, 2, 3, 4, 5,
];

export const GLYPH = {
  1: ['帥', '將'],
  2: ['仕', '士'],
  3: ['相', '象'],
  4: ['傌', '馬'],
  5: ['俥', '車'],
  6: ['炮', '砲'],
  7: ['兵', '卒'],
};

const idx = (x, y) => y * W + x;
const inside = (x, y) => x >= 0 && x < W && y >= 0 && y < H;
const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
const inPalace = (x, y, color) =>
  x >= 3 && x <= 5 && (color > 0 ? y >= 7 && y <= 9 : y >= 0 && y <= 2);

/** 把棋盘上的伪合法走法全部列出来（不检查己方被将） */
export function pseudoMoves(board, x, y) {
  const v = board[idx(x, y)];
  if (!v) return [];
  const color = sign(v);
  const type = Math.abs(v);
  const out = [];
  const add = (nx, ny) => {
    if (!inside(nx, ny)) return false;
    const t = board[idx(nx, ny)];
    if (t && sign(t) === color) return false;
    out.push({ x: nx, y: ny });
    return !t; // 空位可以继续走
  };

  if (type === R || type === C) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let nx = x + dx;
      let ny = y + dy;
      let screen = 0;
      while (inside(nx, ny)) {
        const t = board[idx(nx, ny)];
        if (type === R) {
          if (!t) out.push({ x: nx, y: ny });
          else {
            if (sign(t) !== color) out.push({ x: nx, y: ny });
            break;
          }
        } else if (!screen) {
          // 炮：第一个挡路的子变成炮架，自己不能停在那儿
          if (!t) out.push({ x: nx, y: ny });
          else screen = 1;
        } else if (t) {
          // 隔着一个炮架，只能吃第一个子
          if (sign(t) !== color) out.push({ x: nx, y: ny });
          break;
        }
        nx += dx;
        ny += dy;
      }
    }
    return out;
  }

  if (type === N) {
    const legs = [
      [0, -1, -1, -2], [0, -1, 1, -2],
      [0, 1, -1, 2], [0, 1, 1, 2],
      [-1, 0, -2, -1], [-1, 0, -2, 1],
      [1, 0, 2, -1], [1, 0, 2, 1],
    ];
    for (const [lx, ly, mx, my] of legs) {
      if (!inside(x + mx, y + my)) continue;
      const legX = x + lx;
      const legY = y + ly;
      if (board[idx(legX, legY)]) continue; // 蹩马腿
      const t = board[idx(x + mx, y + my)];
      if (!t || sign(t) !== color) out.push({ x: x + mx, y: y + my });
    }
    return out;
  }

  if (type === E) {
    for (const [dx, dy] of [[2, 2], [2, -2], [-2, 2], [-2, -2]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inside(nx, ny)) continue;
      if (color > 0 ? ny < 5 : ny > 4) continue; // 象不过河
      const eye = board[idx(x + dx / 2, y + dy / 2)];
      if (eye) continue; // 塞象眼
      const t = board[idx(nx, ny)];
      if (!t || sign(t) !== color) out.push({ x: nx, y: ny });
    }
    return out;
  }

  if (type === A) {
    for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inside(nx, ny) || !inPalace(nx, ny, color)) continue;
      const t = board[idx(nx, ny)];
      if (!t || sign(t) !== color) out.push({ x: nx, y: ny });
    }
    return out;
  }

  if (type === K) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inside(nx, ny) || !inPalace(nx, ny, color)) continue;
      const t = board[idx(nx, ny)];
      if (!t || sign(t) !== color) out.push({ x: nx, y: ny });
    }
    return out;
  }

  if (type === P) {
    const fy = color > 0 ? -1 : 1;
    const ny = y + fy;
    if (inside(x, ny)) {
      const t = board[idx(x, ny)];
      if (!t || sign(t) !== color) out.push({ x, y: ny });
    }
    // 过河后才能横走
    const crossed = color > 0 ? y <= 4 : y >= 5;
    if (crossed) {
      for (const dx of [-1, 1]) {
        const nx = x + dx;
        if (!inside(nx, y)) continue;
        const t = board[idx(nx, y)];
        if (!t || sign(t) !== color) out.push({ x: nx, y });
      }
    }
    return out;
  }

  return out;
}

export function findKing(board, color) {
  const k = color > 0 ? K : -K;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (board[idx(x, y)] === k) return { x, y };
    }
  }
  return null;
}

/** 将帅照面（同一路且中间无子）——出现即非法 */
export function generalsFacing(board) {
  const r = findKing(board, 1);
  const b = findKing(board, -1);
  if (!r || !b || r.x !== b.x) return false;
  const y0 = Math.min(r.y, b.y);
  const y1 = Math.max(r.y, b.y);
  for (let y = y0 + 1; y < y1; y++) {
    if (board[idx(r.x, y)]) return false;
  }
  return true;
}

/** color 一方是否被将军 */
export function inCheck(board, color) {
  const king = findKing(board, color);
  if (!king) return true;
  if (generalsFacing(board)) return true;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = board[idx(x, y)];
      if (!v || sign(v) === color) continue;
      for (const m of pseudoMoves(board, x, y)) {
        if (m.x === king.x && m.y === king.y) return true;
      }
    }
  }
  return false;
}

export function applyMove(board, from, to) {
  const next = board.slice();
  next[idx(to.x, to.y)] = next[idx(from.x, from.y)];
  next[idx(from.x, from.y)] = 0;
  return next;
}

/** color 一方所有合法走法（过滤掉送将、照面） */
export function legalMoves(board, color) {
  const out = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = board[idx(x, y)];
      if (!v || sign(v) !== color) continue;
      for (const m of pseudoMoves(board, x, y)) {
        const next = applyMove(board, { x, y }, m);
        if (generalsFacing(next)) continue;
        if (inCheck(next, color)) continue;
        out.push({ from: { x, y }, to: m });
      }
    }
  }
  return out;
}

const VALUE = { 1: 10000, 2: 200, 3: 200, 4: 420, 5: 900, 6: 460, 7: 100 };

function evaluate(board, color) {
  let score = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = board[idx(x, y)];
      if (!v) continue;
      const s = sign(v);
      const t = Math.abs(v);
      let val = VALUE[t] || 0;
      if (t === P) {
        // 兵过河价值翻倍，越靠底越值钱
        const crossed = s > 0 ? y <= 4 : y >= 5;
        if (crossed) val = 150 + (s > 0 ? (4 - y) * 15 : (y - 5) * 15);
      }
      score += s === color ? val : -val;
    }
  }
  return score;
}

export class XiangqiGame {
  constructor(seats, { turnMs = 60000 } = {}) {
    this.turnMs = turnMs;
    this.seats = seats.slice(0, 2).map((s, i) => ({
      seat: s.seat,
      nick: s.nick,
      isBot: !!s.isBot,
      color: i === 0 ? 1 : -1, // 1 红 -1 黑
      online: true,
    }));
    this.board = INIT.slice();
    this.turn = this.seats[0].seat; // 红先
    this.phase = 'playing';
    this.winner = null;
    this.lastMove = null;
    this.result = null;
    this.ply = 0;
    this.deadline = Date.now() + this.turnMs;
  }

  colorOf(seat) {
    return this.seats.find((s) => s.seat === seat)?.color || 0;
  }

  act(seat, action) {
    if (this.phase === 'over') throw new GameError('over', '本局已结束');
    if (seat !== this.turn) throw new GameError('not_your_turn', '还没轮到你');
    if (!action || action.type !== 'move') throw new GameError('bad_action', '未知操作');

    const from = action.from;
    const to = action.to;
    if (!from || !to || !inside(from.x, from.y) || !inside(to.x, to.y)) {
      throw new GameError('bad_move', '位置不合法');
    }
    const color = this.colorOf(seat);
    const piece = this.board[idx(from.x, from.y)];
    if (!piece || sign(piece) !== color) throw new GameError('not_owned', '这不是你的棋子');

    const legal = legalMoves(this.board, color);
    const ok = legal.some(
      (m) => m.from.x === from.x && m.from.y === from.y && m.to.x === to.x && m.to.y === to.y,
    );
    if (!ok) throw new GameError('illegal', '这一步走不了');

    this.board = applyMove(this.board, from, to);
    this.lastMove = { from, to, seat };
    this.ply += 1;

    const other = this.seats.find((s) => s.seat !== seat);
    const otherColor = other ? other.color : -color;
    const replies = legalMoves(this.board, otherColor);
    if (!replies.length) {
      this._finish(seat, inCheck(this.board, otherColor) ? '将死' : '困毙');
      return;
    }
    this.turn = other.seat;
    this.deadline = Date.now() + this.turnMs;
  }

  _finish(winnerSeat, summary) {
    this.phase = 'over';
    this.winner = winnerSeat;
    this.deadline = 0;
    this.result = {
      kind: 'xiangqi',
      winnerSeat,
      draw: false,
      summary,
      deltas: this.seats.map((s) => ({
        seat: s.seat,
        nick: s.nick,
        delta: s.seat === winnerSeat ? 1 : -1,
      })),
    };
  }

  /** 超时兜底：随便走一步合法棋 */
  timeout() {
    if (this.phase === 'over') return;
    const color = this.colorOf(this.turn);
    const moves = legalMoves(this.board, color);
    if (!moves.length) return;
    const mv = moves[Math.floor(Math.random() * moves.length)];
    this.act(this.turn, { type: 'move', from: mv.from, to: mv.to });
  }

  viewFor(seat) {
    const color = this.colorOf(seat);
    const moves = this.phase === 'playing' ? legalMoves(this.board, this.colorOf(this.turn)) : [];
    return {
      youSeat: seat,
      kind: 'xiangqi',
      board: this.board,
      turn: this.turn,
      deadline: this.deadline,
      phase: this.phase,
      lastMove: this.lastMove,
      check: this.phase === 'playing' ? inCheck(this.board, this.colorOf(this.turn)) : false,
      legalMoves: moves.map((m) => ({ from: m.from, to: m.to })),
      yourColor: color,
      seats: this.seats.map((s) => ({
        seat: s.seat,
        nick: s.nick,
        isBot: s.isBot,
        color: s.color,
        online: s.online,
      })),
      result: this.result,
    };
  }
}

/** 机器人：两层搜索（自己走一步，对手最佳应对），吃子优先 */
export function chooseXiangqiMove(game, seat) {
  const color = game.colorOf(seat);
  const moves = legalMoves(game.board, color);
  if (!moves.length) return { type: 'pass' };

  let best = moves[0];
  let bestScore = -Infinity;

  for (const mv of moves) {
    const board = applyMove(game.board, mv.from, mv.to);
    const replies = legalMoves(board, -color);
    if (!replies.length) {
      // 直接将死，最优先
      return { type: 'move', from: mv.from, to: mv.to };
    }
    let worst = Infinity;
    for (const r of replies) {
      const after = applyMove(board, r.from, r.to);
      const score = evaluate(after, color);
      if (score < worst) worst = score;
    }
    const jitter = Math.random() * 1.5;
    if (worst + jitter > bestScore) {
      bestScore = worst + jitter;
      best = mv;
    }
  }
  return { type: 'move', from: best.from, to: best.to };
}
