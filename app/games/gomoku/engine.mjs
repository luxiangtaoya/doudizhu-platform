// 五子棋（无禁手，15×15）。与斗地主共用房间/座位/重连/聊天/积分。
import { randInt } from '../../util.mjs';

export class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const DIRS = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

export class GomokuGame {
  constructor(seats, { size = 15, turnMs = 60000 } = {}) {
    this.size = size;
    this.turnMs = turnMs;
    this.seats = seats.slice(0, 2).map((s, i) => ({
      seat: s.seat,
      nick: s.nick,
      isBot: !!s.isBot,
      color: i === 0 ? 1 : 2, // 1 黑 2 白
      online: true,
      stones: 0,
    }));
    this.grid = new Array(size * size).fill(0);
    this.turn = this.seats[0].seat;
    this.phase = 'playing';
    this.winner = null;
    this.draw = false;
    this.lastMove = null;
    this.result = null;
    this.moves = 0;
    this.deadline = Date.now() + this.turnMs;
  }

  colorOf(seat) {
    return this.seats.find((s) => s.seat === seat)?.color || 0;
  }

  _at(x, y) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return -1;
    return this.grid[y * this.size + x];
  }

  act(seat, action) {
    if (this.phase === 'over') throw new GameError('over', '本局已结束');
    if (seat !== this.turn) throw new GameError('not_your_turn', '还没轮到你');
    if (!action || action.type !== 'place') throw new GameError('bad_action', '未知操作');

    const x = Number(action.x);
    const y = Number(action.y);
    if (!Number.isInteger(x) || !Number.isInteger(y) || !this._inBoard(x, y)) {
      throw new GameError('bad_move', '落子位置不合法');
    }
    const idx = y * this.size + x;
    if (this.grid[idx] !== 0) throw new GameError('occupied', '这里已经有子了');

    const color = this.colorOf(seat);
    this.grid[idx] = color;
    this.moves += 1;
    const rec = this.seats.find((s) => s.seat === seat);
    if (rec) rec.stones += 1;
    this.lastMove = { x, y, seat, color };

    if (this._wins(x, y, color)) {
      this._finish(seat);
      return;
    }
    if (this.moves >= this.size * this.size) {
      this._draw();
      return;
    }
    const other = this.seats.find((s) => s.seat !== seat);
    this.turn = other ? other.seat : this.turn;
    this.deadline = Date.now() + this.turnMs;
  }

  _inBoard(x, y) {
    return x >= 0 && y >= 0 && x < this.size && y < this.size;
  }

  _wins(x, y, color) {
    for (const [dx, dy] of DIRS) {
      let n = 1;
      for (const sign of [1, -1]) {
        let cx = x + dx * sign;
        let cy = y + dy * sign;
        while (this._at(cx, cy) === color) {
          n += 1;
          cx += dx * sign;
          cy += dy * sign;
        }
      }
      if (n >= 5) return true;
    }
    return false;
  }

  _finish(winnerSeat) {
    this.phase = 'over';
    this.winner = winnerSeat;
    this.deadline = 0;
    this.result = {
      kind: 'gomoku',
      winnerSeat,
      draw: false,
      summary: '五子连珠',
      deltas: this.seats.map((s) => ({
        seat: s.seat,
        nick: s.nick,
        delta: s.seat === winnerSeat ? 1 : -1,
      })),
    };
  }

  _draw() {
    this.phase = 'over';
    this.draw = true;
    this.deadline = 0;
    this.result = {
      kind: 'gomoku',
      winnerSeat: -1,
      draw: true,
      summary: '棋盘满了，和棋',
      deltas: this.seats.map((s) => ({ seat: s.seat, nick: s.nick, delta: 0 })),
    };
  }

  /** 超时兜底：先占中心，否则随便找个空位 */
  timeout() {
    if (this.phase === 'over') return;
    const mid = Math.floor(this.size / 2);
    let x = mid;
    let y = mid;
    if (this.grid[y * this.size + x] !== 0) {
      const empty = [];
      for (let i = 0; i < this.grid.length; i++) if (this.grid[i] === 0) empty.push(i);
      const pick = empty[randInt(0, empty.length - 1)];
      x = pick % this.size;
      y = Math.floor(pick / this.size);
    }
    this.act(this.turn, { type: 'place', x, y });
  }

  viewFor(seat) {
    return {
      youSeat: seat,
      kind: 'gomoku',
      size: this.size,
      grid: this.grid,
      turn: this.turn,
      deadline: this.deadline,
      phase: this.phase,
      lastMove: this.lastMove,
      seats: this.seats.map((s) => ({
        seat: s.seat,
        nick: s.nick,
        isBot: s.isBot,
        color: s.color,
        stones: s.stones,
        online: s.online,
      })),
      result: this.result,
    };
  }
}

/** 棋型分：连子越多、两头越空，越值得下 */
function scoreRun(n, openEnds) {
  if (n >= 5) return 100000;
  if (n === 4) return openEnds >= 1 ? 12000 : 3000;
  if (n === 3) return openEnds === 2 ? 1200 : 180;
  if (n === 2) return openEnds === 2 ? 90 : 20;
  if (n === 1) return openEnds === 2 ? 6 : 2;
  return 0;
}

function potentialAt(game, x, y, color) {
  const { size, grid } = game;
  let total = 0;
  for (const [dx, dy] of DIRS) {
    let count = 0;
    let open = 0;
    for (const sign of [1, -1]) {
      let cx = x + dx * sign;
      let cy = y + dy * sign;
      while (cx >= 0 && cy >= 0 && cx < size && cy < size && grid[cy * size + cx] === color) {
        count += 1;
        cx += dx * sign;
        cy += dy * sign;
      }
      if (cx >= 0 && cy >= 0 && cx < size && cy < size && grid[cy * size + cx] === 0) open += 1;
    }
    total += scoreRun(count, open);
  }
  return total;
}

/** 某个空位上，某颜色在四个方向里最长的一条相邻连子数（不含落点本身） */
function maxRun(game, x, y, color) {
  const { size, grid } = game;
  let best = 0;
  for (const [dx, dy] of DIRS) {
    let count = 0;
    for (const sign of [1, -1]) {
      let cx = x + dx * sign;
      let cy = y + dy * sign;
      while (cx >= 0 && cy >= 0 && cx < size && cy < size && grid[cy * size + cx] === color) {
        count += 1;
        cx += dx * sign;
        cy += dy * sign;
      }
    }
    if (count > best) best = count;
  }
  return best;
}

export function chooseGomokuMove(game, seat) {
  const me = game.seats.find((s) => s.seat === seat);
  if (!me) return { type: 'pass' };
  const foeColor = me.color === 1 ? 2 : 1;
  const mid = (game.size - 1) / 2;

  const cands = [];
  let winMove = null;
  let blockMove = null;

  for (let y = 0; y < game.size; y++) {
    for (let x = 0; x < game.size; x++) {
      if (game.grid[y * game.size + x] !== 0) continue;
      // 自己能连五，直接赢
      if (maxRun(game, x, y, me.color) + 1 >= 5) {
        winMove = { x, y };
        break;
      }
      // 对手能连五，必须堵
      if (!blockMove && maxRun(game, x, y, foeColor) + 1 >= 5) blockMove = { x, y };
      cands.push({ x, y });
    }
    if (winMove) break;
  }
  if (winMove) return { type: 'place', ...winMove };
  if (blockMove) return { type: 'place', ...blockMove };

  let best = null;
  let bestScore = -Infinity;
  for (const { x, y } of cands) {
    const mine = potentialAt(game, x, y, me.color);
    const theirs = potentialAt(game, x, y, foeColor);
    const center = 1 - (Math.abs(x - mid) + Math.abs(y - mid)) / (game.size * 1.5);
    const score = mine * 1.05 + theirs + center * 2 + Math.random() * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = { x, y };
    }
  }
  return best ? { type: 'place', x: best.x, y: best.y } : { type: 'pass' };
}
