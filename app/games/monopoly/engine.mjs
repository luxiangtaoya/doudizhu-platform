// 大富翁（简化版）：28 格环形棋盘，2~4 人。
// 规则取舍：只做“买地 / 收租 / 升级 / 机会卡 / 破产”，不做抵押、拍卖、盖房分级。
export class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const SIZE = 28;
export const START_CASH = 10000;
export const SALARY = 2000;
export const JAIL_INDEX = 7;
export const GO_TO_JAIL = 21;
export const MAX_LEVEL = 3;

const G = {
  orange: '#f2a25c',
  blue: '#5b9bd5',
  green: '#3fae7a',
  purple: '#9b7ede',
  red: '#e0615c',
  teal: '#3fb6b0',
  gold: '#d9a521',
  pink: '#e07fa8',
};

// 顺时针：左上角(0,0) 起点 → 上边 → 右上角监狱 → 右边 → 右下角免费停车 → 下边 → 左下角入狱 → 左边
export const TILES = [
  { i: 0, x: 0, y: 0, type: 'start', name: '起点' },
  { i: 1, x: 1, y: 0, type: 'prop', name: '鼓浪屿', price: 600, rent: 60, group: G.orange },
  { i: 2, x: 2, y: 0, type: 'prop', name: '曾厝垵', price: 600, rent: 60, group: G.orange },
  { i: 3, x: 3, y: 0, type: 'chance', name: '机会' },
  { i: 4, x: 4, y: 0, type: 'prop', name: '中山路', price: 800, rent: 80, group: G.blue },
  { i: 5, x: 5, y: 0, type: 'tax', name: '缴税', amount: 800 },
  { i: 6, x: 6, y: 0, type: 'prop', name: '环岛路', price: 800, rent: 80, group: G.blue },
  { i: 7, x: 7, y: 0, type: 'jail', name: '监狱' },
  { i: 8, x: 7, y: 1, type: 'prop', name: '西湖', price: 1000, rent: 100, group: G.green },
  { i: 9, x: 7, y: 2, type: 'prop', name: '灵隐寺', price: 1000, rent: 100, group: G.green },
  { i: 10, x: 7, y: 3, type: 'chance', name: '机会' },
  { i: 11, x: 7, y: 4, type: 'prop', name: '外滩', price: 1200, rent: 120, group: G.purple },
  { i: 12, x: 7, y: 5, type: 'prop', name: '南京路', price: 1200, rent: 120, group: G.purple },
  { i: 13, x: 7, y: 6, type: 'prop', name: '城隍庙', price: 1200, rent: 120, group: G.purple },
  { i: 14, x: 7, y: 7, type: 'parking', name: '免费停车' },
  { i: 15, x: 6, y: 7, type: 'prop', name: '黄鹤楼', price: 1400, rent: 140, group: G.red },
  { i: 16, x: 5, y: 7, type: 'prop', name: '户部巷', price: 1400, rent: 140, group: G.red },
  { i: 17, x: 4, y: 7, type: 'chance', name: '机会' },
  { i: 18, x: 3, y: 7, type: 'prop', name: '橘子洲', price: 1600, rent: 160, group: G.teal },
  { i: 19, x: 2, y: 7, type: 'tax', name: '缴税', amount: 800 },
  { i: 20, x: 1, y: 7, type: 'prop', name: '岳麓山', price: 1600, rent: 160, group: G.teal },
  { i: 21, x: 0, y: 7, type: 'gojail', name: '入狱' },
  { i: 22, x: 0, y: 6, type: 'prop', name: '大雁塔', price: 1800, rent: 180, group: G.gold },
  { i: 23, x: 0, y: 5, type: 'prop', name: '兵马俑', price: 1800, rent: 180, group: G.gold },
  { i: 24, x: 0, y: 4, type: 'chance', name: '机会' },
  { i: 25, x: 0, y: 3, type: 'prop', name: '天府广场', price: 2200, rent: 220, group: G.pink },
  { i: 26, x: 0, y: 2, type: 'prop', name: '宽窄巷子', price: 2200, rent: 220, group: G.pink },
  { i: 27, x: 0, y: 1, type: 'prop', name: '春熙路', price: 2200, rent: 220, group: G.pink },
];

export const PLAYER_COLORS = ['#e0615c', '#5b9bd5', '#3fae7a', '#d9a521'];

const card = (text, apply) => ({ text, apply });

const CHANCE = [
  card('银行分红，收入 1500', (g, p) => g._gain(p, 1500)),
  card('缴纳物业费，支出 800', (g, p) => g._pay(p, 800)),
  card('中了个小奖，收入 3000', (g, p) => g._gain(p, 3000)),
  card('直接回到起点，并领取工资', (g, p) => {
    p.pos = 0;
    g._gain(p, SALARY);
  }),
  card('后退 3 格', (g, p) => g._jump(p, -3)),
  card('所有对手各给你 500', (g, p) => {
    for (const q of g.players) {
      if (q !== p && !q.bankrupt) {
        g._pay(q, 500, p.seat);
      }
      if (g.phase === 'over') break;
    }
  }),
  card('你给每个对手 500', (g, p) => {
    for (const q of g.players) {
      if (q !== p && !q.bankrupt) g._transfer(p, q, 500);
      if (p.bankrupt) break;
    }
  }),
  card('免费升级你的一处地产', (g, p) => g._freeUpgrade(p)),
  card('违规经营，直接入狱', (g, p) => {
    p.pos = JAIL_INDEX;
    p.jail = 1;
  }),
  card('前进到下一个机会格', (g, p) => g._jump(p, 5)),
];

export class MonopolyGame {
  constructor(seats, { maxRounds = 20, turnMs = 30000 } = {}) {
    this.maxRounds = maxRounds;
    this.rollMs = Math.min(30000, turnMs);
    this.players = seats.slice(0, 4).map((s, i) => ({
      seat: s.seat,
      nick: s.nick,
      isBot: !!s.isBot,
      color: PLAYER_COLORS[i % PLAYER_COLORS.length],
      pos: 0,
      cash: START_CASH,
      jail: 0,
      bankrupt: false,
      laps: 0,
      online: true,
    }));
    // 房间层会读写 game.seats 上的 online，这里直接复用 players
    this.seats = this.players;
    this.owners = new Array(SIZE).fill(null);
    this.levels = new Array(SIZE).fill(0);
    this.turn = this.players[0].seat;
    this.phase = 'roll';
    this.dice = [0, 0];
    this.lastRoll = null;
    this.log = [];
    this.turns = 0;
    this.result = null;
    this.deadline = Date.now() + this.rollMs;
    this._log(`${this.players[0].nick} 先手`);
  }

  // ---------- 工具 ----------

  _log(text) {
    this.log.push({ ts: Date.now(), text });
    if (this.log.length > 60) this.log.splice(0, this.log.length - 60);
  }

  get actor() {
    return this.players.find((p) => p.seat === this.turn);
  }

  playerOf(seat) {
    return this.players.find((p) => p.seat === seat);
  }

  tile(i) {
    return TILES[i];
  }

  rentOf(i) {
    return TILES[i].rent * 2 ** this.levels[i];
  }

  upgradeCost(i) {
    return Math.round(TILES[i].price * 0.6);
  }

  _alive() {
    return this.players.filter((p) => !p.bankrupt);
  }

  _gain(p, amount) {
    p.cash += amount;
    this._log(`${p.nick} 收入 ${amount}`);
  }

  _pay(p, amount, toSeat = null) {
    p.cash -= amount;
    if (toSeat != null) {
      const q = this.playerOf(toSeat);
      if (q) q.cash += amount;
    }
    this._log(`${p.nick} 支出 ${amount}`);
    if (p.cash < 0) this._bankrupt(p);
  }

  _transfer(from, to, amount) {
    from.cash -= amount;
    to.cash += amount;
    this._log(`${from.nick} 付给 ${to.nick} ${amount}`);
    if (from.cash < 0) this._bankrupt(from);
  }

  _bankrupt(p) {
    p.cash = 0;
    p.bankrupt = true;
    for (let i = 0; i < SIZE; i++) {
      if (this.owners[i] === p.seat) {
        this.owners[i] = null;
        this.levels[i] = 0;
      }
    }
    this._log(`${p.nick} 破产了，名下地产被收回`);
    this._checkOver();
  }

  _freeUpgrade(p) {
    const mine = [];
    for (let i = 0; i < SIZE; i++) if (this.owners[i] === p.seat && this.levels[i] < MAX_LEVEL) mine.push(i);
    if (!mine.length) {
      this._log('没有可升级的地产');
      return;
    }
    const pick = mine[Math.floor(Math.random() * mine.length)];
    this.levels[pick] += 1;
    this._log(`${p.nick} 免费把 ${TILES[pick].name} 升到 ${this.levels[pick]} 级`);
  }

  _jump(p, steps) {
    const dir = steps > 0 ? 1 : -1;
    for (let k = 0; k < Math.abs(steps); k++) p.pos = (p.pos + dir + SIZE) % SIZE;
    this._log(`${p.nick} 移动到 ${TILES[p.pos].name}`);
    this._cardMoved = true;
    this._land(p, false);
  }

  // ---------- 回合 ----------

  act(seat, action) {
    if (this.phase === 'over') throw new GameError('over', '本局已结束');
    if (seat !== this.turn) throw new GameError('not_your_turn', '还没轮到你');
    const p = this.playerOf(seat);
    // 兜底：万一破产的人还拿着回合，直接跳过去，别把整局卡死
    if (!p || p.bankrupt) {
      this._log('跳过已出局的玩家');
      this._endTurn();
      return;
    }
    const type = action?.type;

    if (this.phase === 'roll' && type === 'roll') return this._doRoll(p);
    if (this.phase === 'buy' && type === 'buy') return this._decideBuy(p, !!action.yes);
    if (this.phase === 'end' && type === 'end') return this._endTurn();
    if (this.phase === 'end' && type === 'upgrade') return this._upgrade(p, Number(action.tile));
    throw new GameError('bad_phase', '现在不能做这个操作');
  }

  _doRoll(p) {
    const d1 = 1 + Math.floor(Math.random() * 6);
    const d2 = 1 + Math.floor(Math.random() * 6);
    this.dice = [d1, d2];
    const steps = d1 + d2;
    const from = p.pos;
    this.lastRoll = { seat: p.seat, from, steps, to: (from + steps) % SIZE };
    this._log(`${p.nick} 掷出 ${d1}+${d2}=${steps}`);

    for (let k = 0; k < steps; k++) {
      p.pos = (p.pos + 1) % SIZE;
      if (p.pos === 0) {
        p.laps += 1;
        this._gain(p, SALARY);
      }
    }
    this._land(p, false);
  }

  _land(p, fromChance) {
    const t = TILES[p.pos];
    if (t.type === 'start') {
      this._toEnd();
      return;
    }
    if (t.type === 'prop') {
      const owner = this.owners[t.i];
      if (owner === null) {
        if (p.cash >= t.price && this.phase !== 'over') {
          this.phase = 'buy';
          this.deadline = Date.now() + 20000;
          this._log(`${p.nick} 走到 ${t.name}，可以买下`);
          return;
        }
        this._log(`${p.nick} 走到 ${t.name}，钱不够，跳过`);
        this._toEnd();
        return;
      }
      if (owner === p.seat) {
        this._log(`${p.nick} 回到自己的 ${t.name}`);
        this._toEnd();
        return;
      }
      const q = this.playerOf(owner);
      if (!q) {
        this._toEnd();
        return;
      }
      const rent = this.rentOf(t.i);
      this._log(`${p.nick} 踩到 ${q.nick} 的 ${t.name}，付租金 ${rent}`);
      this._transfer(p, q, rent);
      if (this.phase === 'over') return;
      // 付租破产：本回合直接结束，不能再停在"等待出牌"状态
      if (p.bankrupt) {
        this._endTurn();
        return;
      }
      this._toEnd();
      return;
    }
    if (t.type === 'chance') {
      const c = CHANCE[Math.floor(Math.random() * CHANCE.length)];
      this._log(`机会卡：${c.text}`);
      this._cardMoved = false;
      c.apply(this, p);
      if (this.phase === 'over') return;
      if (this._cardMoved) {
        this._cardMoved = false;
        return; // 卡片把棋子挪走了，落脚点已经在 _jump 里处理完
      }
      if (p.bankrupt) {
        this._endTurn();
        return;
      }
      this._toEnd();
      return;
    }
    if (t.type === 'tax') {
      this._log(`${p.nick} 缴纳 ${t.amount} 税费`);
      this._pay(p, t.amount);
      if (this.phase === 'over') return;
      if (p.bankrupt) {
        this._endTurn();
        return;
      }
      this._toEnd();
      return;
    }
    if (t.type === 'gojail') {
      p.pos = JAIL_INDEX;
      p.jail = 1;
      this._log(`${p.nick} 被送进监狱，下回合暂停一次`);
      this._toEnd();
      return;
    }
    this._toEnd();
  }

  _decideBuy(p, yes) {
    const t = TILES[p.pos];
    if (!yes) {
      this._log(`${p.nick} 放弃购买 ${t.name}`);
      this._toEnd();
      return;
    }
    if (p.cash < t.price) throw new GameError('poor', '钱不够');
    p.cash -= t.price;
    this.owners[t.i] = p.seat;
    this._log(`${p.nick} 买下 ${t.name}（-${t.price}）`);
    this._toEnd();
  }

  _upgrade(p, i) {
    if (!Number.isInteger(i) || i < 0 || i >= SIZE) throw new GameError('bad_tile', '位置不对');
    if (this.owners[i] !== p.seat) throw new GameError('not_owner', '这不是你的地产');
    if (this.levels[i] >= MAX_LEVEL) throw new GameError('max', '已经满级了');
    const cost = this.upgradeCost(i);
    if (p.cash < cost) throw new GameError('poor', '钱不够');
    p.cash -= cost;
    this.levels[i] += 1;
    this._log(`${p.nick} 把 ${TILES[i].name} 升到 ${this.levels[i]} 级（-${cost}）`);
  }

  _toEnd() {
    if (this.phase === 'over') return;
    this.phase = 'end';
    this.deadline = Date.now() + 15000;
  }

  _endTurn() {
    this.turns += 1;
    this._advance();
  }

  _advance() {
    if (this.phase === 'over') return;
    const alive = this._alive();
    if (alive.length <= 1) {
      this._checkOver();
      return;
    }
    let idx = this.players.findIndex((p) => p.seat === this.turn);
    for (let guard = 0; guard < this.players.length * 3; guard++) {
      idx = (idx + 1) % this.players.length;
      const next = this.players[idx];
      if (next.bankrupt) continue;
      this.turn = next.seat;
      if (next.jail > 0) {
        next.jail -= 1;
        this._log(`${next.nick} 在监狱中，跳过一回合`);
        continue;
      }
      this._startTurn(next);
      return;
    }
    this._checkOver();
  }

  _startTurn(p) {
    this.phase = 'roll';
    // 骰子保留上一次的点数，轮到自己时界面不空着
    this.lastRoll = null;
    this.deadline = Date.now() + this.rollMs;
    const round = Math.floor(this.turns / Math.max(1, this._alive().length)) + 1;
    if (round > this.maxRounds) {
      this._finishByWealth();
      return;
    }
    this._log(`轮到 ${p.nick}`);
  }

  _checkOver() {
    if (this.phase === 'over') return;
    const alive = this._alive();
    if (alive.length <= 1) {
      const winner = alive[0] || this.players[0];
      this._finish(winner.seat, '其他人都破产了');
    }
  }

  _finishByWealth() {
    const alive = this._alive().sort((a, b) => b.cash - a.cash);
    this._finish(alive[0].seat, `${this.maxRounds} 回合结束，现金最多`);
  }

  _finish(winnerSeat, summary) {
    this.phase = 'over';
    this.deadline = 0;
    this.result = {
      kind: 'monopoly',
      winnerSeat,
      draw: false,
      summary,
      deltas: this.players.map((p) => ({
        seat: p.seat,
        nick: p.nick,
        delta: p.bankrupt ? -1 : p.seat === winnerSeat ? 1 : -1,
        cash: p.cash,
      })),
    };
    this._log(`本局结束：${this.playerOf(winnerSeat)?.nick} 获胜（${summary}）`);
  }

  timeout() {
    if (this.phase === 'over') return;
    const p = this.actor;
    if (!p) return;
    // 破产的人不该还拿着回合，直接下一位
    if (p.bankrupt) {
      this._endTurn();
      return;
    }
    if (this.phase === 'roll') this._doRoll(p);
    else if (this.phase === 'buy') this._decideBuy(p, false);
    else if (this.phase === 'end') this._endTurn();
  }

  viewFor(seat) {
    return {
      youSeat: seat,
      kind: 'monopoly',
      phase: this.phase,
      turn: this.turn,
      deadline: this.deadline,
      dice: this.dice,
      lastRoll: this.lastRoll,
      round: Math.floor(this.turns / Math.max(1, this._alive().length)) + 1,
      maxRounds: this.maxRounds,
      tiles: TILES,
      owners: this.owners,
      levels: this.levels,
      players: this.players.map((p) => ({
        seat: p.seat,
        nick: p.nick,
        isBot: p.isBot,
        color: p.color,
        pos: p.pos,
        cash: p.cash,
        jail: p.jail,
        bankrupt: p.bankrupt,
        props: this.owners.filter((o) => o === p.seat).length,
      })),
      log: this.log.slice(-12),
      result: this.result,
    };
  }
}

/** 机器人：买得起且留有余钱就买，钱多就升级 */
export function chooseMonopolyAction(game, seat) {
  const p = game.playerOf(seat);
  if (!p) return { type: 'end' };
  if (game.phase === 'roll') return { type: 'roll' };
  if (game.phase === 'buy') {
    const t = TILES[p.pos];
    return { type: 'buy', yes: p.cash >= t.price * 1.5 };
  }
  if (game.phase === 'end') {
    // 挑一块最便宜且能升级的地
    let best = -1;
    let bestCost = Infinity;
    for (let i = 0; i < SIZE; i++) {
      if (game.owners[i] !== seat || game.levels[i] >= MAX_LEVEL) continue;
      const cost = game.upgradeCost(i);
      if (cost < bestCost && p.cash >= cost * 2.5) {
        bestCost = cost;
        best = i;
      }
    }
    if (best >= 0) return { type: 'upgrade', tile: best };
    return { type: 'end' };
  }
  return { type: 'end' };
}
