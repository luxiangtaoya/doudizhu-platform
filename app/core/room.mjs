// 房间：座位、观战、开始/再来一局、托管、机器人补位、聊天、结算。
import { gameMeta } from '../games/registry.mjs';
import { cleanText } from '../util.mjs';

export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const BOT_NAMES = ['阿飞', '小满', '老K', '豆豆', '老张'];
const CHAT_MAX = 60;
const CHAT_WINDOW_MS = 10000;
const CHAT_LIMIT = 6;

export class Room {
  constructor(hub, gameId, hostPid) {
    this.hub = hub;
    this.meta = gameMeta(gameId);
    this.id = hub.newRoomCode();
    this.gameId = gameId;
    this.hostPid = hostPid;
    this.seats = new Array(this.meta.seats).fill(null);
    /** pid -> {pid, nick, since} */
    this.spectators = new Map();
    this.state = 'waiting'; // waiting | playing | over
    this.game = null;
    this.chat = [];
    this.botAt = 0;
    this.overAt = 0;
    this.seq = 0;
    this.createdAt = Date.now();
    this.lastHumanAt = Date.now();
    this.chatLog = new Map();
  }

  // ---------- 座位 / 观战 ----------

  seatOf(pid) {
    return this.seats.findIndex((s) => s && s.pid === pid);
  }

  spectatorOf(pid) {
    return this.spectators.get(pid) || null;
  }

  isSpectator(pid) {
    return this.spectators.has(pid);
  }

  /** 返回座位号；坐满了或牌局进行中就变成观战，返回 -1 */
  addPlayer(pid, nick) {
    const existing = this.seatOf(pid);
    if (existing >= 0) {
      const s = this.seats[existing];
      s.online = true;
      s.leftAt = 0;
      if (this.state !== 'playing') s.auto = false;
      this.spectators.delete(pid);
      this.lastHumanAt = Date.now();
      return existing;
    }
    if (this.spectators.has(pid)) {
      this.spectators.get(pid).nick = nick;
      this.lastHumanAt = Date.now();
      return -1;
    }
    this.lastHumanAt = Date.now();
    if (this.state !== 'playing') {
      const idx = this.seats.findIndex((s) => s === null);
      if (idx >= 0) {
        this.seats[idx] = {
          seat: idx,
          pid,
          nick,
          isBot: false,
          online: true,
          auto: false,
          score: 0,
          leftAt: 0,
        };
        return idx;
      }
    }
    // 满员或已经开打：观战
    this.spectators.set(pid, { pid, nick, since: Date.now() });
    return -1;
  }

  removePlayer(pid) {
    if (this.spectators.has(pid)) {
      this.spectators.delete(pid);
      this.lastHumanAt = Date.now();
      return;
    }
    const idx = this.seatOf(pid);
    if (idx < 0) return;
    const s = this.seats[idx];
    if (this.state === 'playing') {
      // 局中离开：先留着位置，tick 里过了宽限期交给托管
      s.online = false;
      s.leftAt = Date.now();
    } else {
      this.seats[idx] = null;
    }
    if (this.hostPid === pid) {
      const nextHost = this.seats.find((x) => x && !x.isBot && x.online);
      this.hostPid = nextHost ? nextHost.pid : null;
    }
    this.lastHumanAt = Date.now();
    this._promote();
  }

  /** 有空位时，把最早的观战者拉上来坐下 */
  _promote() {
    if (this.state === 'playing') return;
    const idx = this.seats.findIndex((s) => s === null);
    if (idx < 0) return;
    const it = this.spectators.entries().next();
    if (it.done) return;
    const [pid, sp] = it.value;
    this.spectators.delete(pid);
    this.seats[idx] = { seat: idx, pid, nick: sp.nick, isBot: false, online: true, auto: false, score: 0, leftAt: 0 };
    this.lastHumanAt = Date.now();
  }

  humanSeats() {
    return this.seats.filter((s) => s && !s.isBot);
  }

  onlineHumans() {
    return this.seats.filter((s) => s && !s.isBot && s.online);
  }

  // ---------- 开局 ----------

  start(pid) {
    if (pid !== this.hostPid) throw new RoomError('not_host', '只有房主能开局');
    if (this.state === 'playing') throw new RoomError('busy', '牌局正在进行');
    const humans = this.onlineHumans();
    if (humans.length < 1) throw new RoomError('empty', '至少要有一个人');

    // 新一局：清掉上一局残留的托管标记；开局就不在线的人直接按托管处理
    for (const s of this.seats) {
      if (s && !s.isBot) s.auto = !s.online;
    }

    for (let i = 0; i < this.seats.length; i++) {
      if (this.seats[i]?.isBot) this.seats[i] = null;
    }
    const names = [...BOT_NAMES];
    for (let i = 0; i < this.seats.length; i++) {
      if (this.seats[i]) continue;
      const nick = names.shift() || `机器人${i + 1}`;
      this.seats[i] = { seat: i, pid: `bot:${this.id}:${i}`, nick, isBot: true, online: true, auto: true, score: 0, leftAt: 0 };
    }

    this.game = this.meta.create(
      this.seats.map((s) => ({ seat: s.seat, nick: s.nick, isBot: s.isBot })),
      {
        maxMultiplier: this.hub.cfg.maxMultiplier,
        turnMs: this._turnMs(),
        bidMs: this.hub.cfg.bidSeconds * 1000,
      },
    );
    this.state = 'playing';
    this.botAt = 0;
    this.overAt = 0;
    this.syncOnline();
    this.broadcast();
  }

  /** 每种棋的思考时间不一样：斗地主 30s，五子棋/象棋 60s */
  _turnMs() {
    const cfg = this.hub.cfg;
    if (this.gameId === 'gomoku') return (cfg.gomokuTurnSeconds || 60) * 1000;
    if (this.gameId === 'xiangqi') return (cfg.xiangqiTurnSeconds || 60) * 1000;
    return (cfg.turnSeconds || 30) * 1000;
  }

  // ---------- 操作 ----------

  act(pid, action) {
    if (this.state !== 'playing') throw new RoomError('idle', '牌局还没开始');
    const seat = this.seatOf(pid);
    if (seat < 0) {
      if (this.isSpectator(pid)) throw new RoomError('spectator', '观战状态下不能出牌');
      throw new RoomError('not_seated', '你不在这张桌上');
    }
    const s = this.seats[seat];
    if (s.auto) throw new RoomError('auto', '已进入托管状态，先点「取消托管」');
    this.game.act(seat, action);
    this.afterAction();
  }

  /** 改名后同步座位与对局里的昵称 */
  renameSeat(pid, nick) {
    const idx = this.seatOf(pid);
    if (idx >= 0) {
      this.seats[idx].nick = nick;
      if (this.game) {
        const s = this.game.seats.find((x) => x.seat === idx);
        if (s) s.nick = nick;
      }
    }
    const sp = this.spectators.get(pid);
    if (sp) sp.nick = nick;
  }

  setAuto(pid, on) {
    const seat = this.seatOf(pid);
    if (seat < 0) throw new RoomError('spectator', '观战状态不能托管');
    if (this.state !== 'playing') throw new RoomError('idle', '牌局还没开始');
    const s = this.seats[seat];
    s.auto = !!on;
    if (on) s.leftAt = 0;
    this.botAt = 0;
    this.syncOnline();
    this.broadcast();
  }

  afterAction() {
    this.syncOnline();
    if (this.game.phase === 'over') this.settle();
    this.botAt = 0;
    this.broadcast();
  }

  syncOnline() {
    if (!this.game) return;
    for (const s of this.game.seats) {
      const rec = this.seats[s.seat];
      s.online = rec ? rec.online && !rec.auto : false;
    }
  }

  settle() {
    if (this.state === 'over') return;
    this.state = 'over';
    this.overAt = Date.now();
    const res = this.game.result;
    if (!res) return;

    const winners = new Set();
    if (typeof res.landlordWin === 'boolean') {
      if (res.landlordWin) winners.add(res.landlordSeat);
      else for (const s of this.game.seats) if (s.role === 'farmer') winners.add(s.seat);
    } else if (res.winnerSeat >= 0) {
      winners.add(res.winnerSeat);
    }

    for (const d of res.deltas) {
      const rec = this.seats[d.seat];
      if (!rec) continue;
      rec.score += d.delta;
      if (!rec.isBot) this.hub.store.recordPlayer(rec.nick, d.delta, winners.has(d.seat));
    }

    // 局后清掉机器人和掉线玩家的座位，让观战的人能补上来
    for (const rec of this.seats) {
      if (!rec) continue;
      if (rec.isBot) {
        this.seats[rec.seat] = null;
        continue;
      }
      if (!rec.online) {
        this.seats[rec.seat] = null;
        this.hub.onEvict(rec.pid);
      }
    }

    this.hub.store.recordMatch({
      ts: Date.now(),
      room: this.id,
      game: this.gameId,
      summary: res.summary || (res.landlordWin ? '地主胜' : '农民胜'),
      multiplier: res.multiplier ?? null,
      bombs: res.bombs ?? null,
      winner: res.winnerSeat ?? null,
      players: res.deltas.map((d) => ({ nick: d.nick, delta: d.delta })),
    });

    const text = res.summary
      ? res.summary
      : `${res.landlordWin ? '地主' : '农民'}胜，${res.multiplier} 倍${res.spring ? '（春天）' : res.antiSpring ? '（反春天）' : ''}`;
    this.hub.pushSystem(this, `本局结束：${text}`);
    if (this.spectators.size) this._promote();
  }

  // ---------- 聊天 ----------

  chatSay(pid, text) {
    const seat = this.seatOf(pid);
    const rec = seat >= 0 ? this.seats[seat] : null;
    const spec = this.spectators.get(pid);
    const nick = rec ? rec.nick : spec?.nick;
    if (!nick) throw new RoomError('not_seated', '先坐下再说话');

    const msg = cleanText(text, CHAT_MAX);
    if (!msg) return;

    const now = Date.now();
    const win = this.chatLog.get(pid) || [];
    const recent = win.filter((t) => now - t < CHAT_WINDOW_MS);
    if (recent.length >= CHAT_LIMIT) throw new RoomError('flood', '说慢点，喝口水');
    recent.push(now);
    this.chatLog.set(pid, recent);

    this.chat.push({
      from: nick,
      seat: rec ? rec.seat : -1,
      fromSpectator: !rec,
      text: msg,
      ts: now,
      bot: false,
    });
    if (this.chat.length > 80) this.chat.splice(0, this.chat.length - 80);
    this.broadcast();
  }

  system(text) {
    this.chat.push({ from: '系统', system: true, text, ts: Date.now() });
    if (this.chat.length > 80) this.chat.splice(0, this.chat.length - 80);
  }

  // ---------- 循环 ----------

  tick(now = Date.now()) {
    if (this.state !== 'playing' || !this.game) return false;
    const g = this.game;

    for (const rec of this.seats) {
      if (!rec || rec.isBot || rec.auto) continue;
      if (!rec.online && rec.leftAt && now - rec.leftAt > this.hub.cfg.graceSeconds * 1000) {
        rec.auto = true;
        this.system(`${rec.nick} 掉线超时，本局由机器人代打`);
        this.syncOnline();
        this.broadcast();
      }
    }

    if (g.phase === 'over') return false;

    const actor = this.seats[g.turn];
    const needBot = !actor || actor.isBot || actor.auto;

    if (!needBot) {
      this.botAt = 0;
      if (g.deadline && now > g.deadline) {
        try {
          g.timeout();
        } catch (err) {
          console.warn('[room] 超时托管失败', err.message);
        }
        this.afterAction();
        return true;
      }
      return false;
    }

    if (!this.botAt) {
      this.botAt = now + this.hub.cfg.botDelayMs + Math.floor(Math.random() * (this.hub.cfg.botJitterMs ?? 400));
      return false;
    }
    if (now < this.botAt) return false;

    this.botAt = 0;
    try {
      g.act(g.turn, this.meta.bot(g, g.turn));
    } catch (err) {
      console.warn(`[room ${this.id}] 机器人出错，改用兜底：${err.message}`);
      try {
        g.timeout();
      } catch {
        /* ignore */
      }
    }
    this.afterAction();
    return true;
  }

  // ---------- 视图 ----------

  view(seat) {
    this.syncOnline();
    const youSeat = Number.isInteger(seat) ? seat : -1;
    const rec = youSeat >= 0 ? this.seats[youSeat] : null;
    return {
      id: this.id,
      gameId: this.gameId,
      gameName: this.meta.name,
      state: this.state,
      hostPid: this.hostPid,
      youSeat,
      spectator: youSeat < 0,
      auto: !!(rec && rec.auto),
      spectators: [...this.spectators.values()].map((s) => s.nick),
      seats: this.seats.map((s, i) =>
        s
          ? { seat: i, nick: s.nick, isBot: s.isBot, online: s.online, auto: s.auto, score: s.score }
          : null,
      ),
      game: this.game ? this.game.viewFor(youSeat) : null,
      chat: this.chat.slice(-30),
      seq: this.seq,
      now: Date.now(),
    };
  }

  broadcast() {
    this.seq += 1;
    for (const s of this.seats) {
      if (!s || s.isBot || !s.online) continue;
      this.hub.send(s.pid, { t: 'state', room: this.view(s.seat) });
    }
    for (const sp of this.spectators.values()) {
      this.hub.send(sp.pid, { t: 'state', room: this.view(null) });
    }
  }

  get isEmpty() {
    return this.seats.every((s) => !s) && this.spectators.size === 0;
  }

  get idleTooLong() {
    const quiet = this.onlineHumans().length === 0 && this.spectators.size === 0;
    return quiet && Date.now() - this.lastHumanAt > this.hub.cfg.roomIdleMinutes * 60 * 1000;
  }
}
