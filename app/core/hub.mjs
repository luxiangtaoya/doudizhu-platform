// 大厅 + 连接管理：玩家身份、房间匹配、消息路由。
import { CATALOG } from '../games/registry.mjs';
import { Room, RoomError } from './room.mjs';
import { cleanText, rid } from '../util.mjs';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PID_RE = /^[A-Za-z0-9_-]{6,64}$/;

export class Hub {
  constructor({ cfg, store }) {
    this.cfg = cfg;
    this.store = store;
    /** pid -> { pid, nick, conn, roomId, lastSeen } */
    this.players = new Map();
    /** code -> Room */
    this.rooms = new Map();
    this.timer = setInterval(() => this.tick(), 200);
    this.timer.unref?.();
  }

  // ---------- 连接 ----------

  attach(conn) {
    conn.pid = null;
  }

  disconnect(conn) {
    const pid = conn.pid;
    if (!pid) return;
    const p = this.players.get(pid);
    if (!p || p.conn !== conn) return;
    p.conn = null;
    p.lastSeen = Date.now();
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (room) {
      room.removePlayer(pid);
      room.broadcast();
      if (room.state !== 'playing') p.roomId = null;
    }
    this.broadcastLobby();
  }

  onMessage(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    const t = String(msg.t || '');
    if (process.env.DEBUG_MSG) console.log(`[msg] ${t} pid=${conn.pid || '-'}`);

    if (t === 'hello') return this.hello(conn, msg);
    if (t === 'ping') return conn.send({ t: 'pong' });
    if (t === 'pong') return;

    const p = conn.pid ? this.players.get(conn.pid) : null;
    if (!p) return conn.send({ t: 'error', code: 'no_session', msg: '连接已失效，请刷新页面' });

    try {
      switch (t) {
        case 'lobby':
          return conn.send({ t: 'lobby', lobby: this.lobby(p.pid) });
        case 'create':
          return this.create(p, msg);
        case 'join':
          return this.join(p, msg.code);
        case 'leave':
          return this.leave(p);
        case 'start':
          return this.start(p);
        case 'act':
          return this.act(p, msg.action);
        case 'hint':
          return this.hint(p);
        case 'auto':
          return this.setAuto(p, msg.on);
        case 'nick':
          return this.rename(p, msg.nick);
        case 'chat':
          return this.chat(p, msg.text);
        default:
          return conn.send({ t: 'error', code: 'unknown', msg: `未知消息 ${t}` });
      }
    } catch (err) {
      // RoomError / GameError 都带 code，属于"可预期"的业务错误，直接把原因回给玩家
      if (err && typeof err.code === 'string') {
        return conn.send({ t: 'error', code: err.code, msg: err.message });
      }
      console.error('[hub] 处理消息失败', err);
      return conn.send({ t: 'error', code: 'server_error', msg: '服务器开小差了' });
    }
  }

  hello(conn, msg) {
    let pid = String(msg.pid || '');
    if (!PID_RE.test(pid)) pid = rid(16);
    let nick = cleanText(msg.nick, 12) || '无名氏';

    let p = this.players.get(pid);
    if (p) {
      p.conn = conn;
      p.lastSeen = Date.now();
      if (nick && nick !== p.nick && !this.nickTaken(nick, pid)) p.nick = nick;
    } else {
      if (this.nickTaken(nick, pid)) nick = this.uniqueNick(nick);
      p = { pid, nick, conn, roomId: null, lastSeen: Date.now() };
      this.players.set(pid, p);
    }
    conn.pid = pid;

    conn.send({
      t: 'welcome',
      pid,
      nick: p.nick,
      catalog: CATALOG,
      lobby: this.lobby(pid),
    });

    // 断线重连：如果之前还在桌上，把座位恢复
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (room) {
      try {
        room.addPlayer(p.pid, p.nick);
        room.broadcast();
        conn.send({ t: 'state', room: room.view(room.seatOf(p.pid)) });
      } catch {
        p.roomId = null;
      }
    }
    this.broadcastLobby();
  }

  nickTaken(nick, exceptPid) {
    const key = nick.toLowerCase();
    for (const p of this.players.values()) {
      if (p.pid !== exceptPid && p.conn && p.nick.toLowerCase() === key) return true;
    }
    return false;
  }

  uniqueNick(base) {
    for (let i = 2; i < 100; i++) {
      const candidate = `${base}·${i}`;
      if (!this.nickTaken(candidate, null)) return candidate;
    }
    return `${base}·${Math.floor(Math.random() * 999)}`;
  }

  // ---------- 房间 ----------

  create(p, msg) {
    if (p.roomId) this.leave(p);
    const gameId = msg.gameId && CATALOG.some((c) => c.id === msg.gameId && c.status === 'ready') ? msg.gameId : 'ddz';
    const room = new Room(this, gameId, p.pid);
    this.rooms.set(room.id, room);
    room.addPlayer(p.pid, p.nick);
    p.roomId = room.id;
    room.broadcast();
    this.broadcastLobby();
    p.conn.send({ t: 'state', room: room.view(room.seatOf(p.pid)) });
  }

  join(p, rawCode) {
    const code = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    const room = this.rooms.get(code);
    if (!room) throw new RoomError('not_found', '房间号不存在');
    if (p.roomId === room.id) {
      p.conn.send({ t: 'state', room: room.view(room.seatOf(p.pid)) });
      return;
    }
    if (p.roomId) this.leave(p);
    room.addPlayer(p.pid, p.nick);
    p.roomId = room.id;
    room.broadcast();
    this.broadcastLobby();
    p.conn.send({ t: 'state', room: room.view(room.seatOf(p.pid)) });
  }

  leave(p) {
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    p.roomId = null;
    if (room) {
      room.removePlayer(p.pid);
      if (room.isEmpty) this.rooms.delete(room.id);
      else room.broadcast();
    }
    p.conn?.send({ t: 'lobby', lobby: this.lobby(p.pid) });
    this.broadcastLobby();
  }

  start(p) {
    const room = this.roomOf(p);
    room.start(p.pid);
    this.broadcastLobby();
  }

  act(p, action) {
    const room = this.roomOf(p);
    room.act(p.pid, action);
  }

  hint(p) {
    const room = this.roomOf(p);
    const seat = room.seatOf(p.pid);
    if (seat < 0) throw new RoomError('spectator', '观战状态下没有提示');
    if (!room.game) return;
    const moves = room.meta.hints ? room.meta.hints(room.game, seat) : [];
    p.conn.send({ t: 'hint', moves, pass: moves.length === 0 });
  }

  chat(p, text) {
    const room = this.roomOf(p);
    room.chatSay(p.pid, text);
  }

  setAuto(p, on) {
    const room = this.roomOf(p);
    room.setAuto(p.pid, !!on);
  }

  rename(p, raw) {
    const nick = cleanText(raw, 12);
    if (!nick) throw new RoomError('bad_nick', '名字不能为空');
    if (nick === p.nick) return;

    // 重名自动加后缀，避免桌上两个"老王"
    const finalNick = this.nickTaken(nick, p.pid) ? this.uniqueNick(nick) : nick;
    const oldNick = p.nick;
    p.nick = finalNick;
    this.store.renamePlayer(oldNick, finalNick);

    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (room) {
      room.renameSeat(p.pid, finalNick);
      room.broadcast();
    }
    p.conn?.send({ t: 'nick', nick: finalNick });
    this.broadcastLobby();
  }

  roomOf(p) {
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) throw new RoomError('no_room', '你还没进房间');
    return room;
  }

  newRoomCode() {
    for (let i = 0; i < 200; i++) {
      let code = '';
      for (let j = 0; j < 4; j++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    return rid(6).toUpperCase();
  }

  // ---------- 广播 ----------

  lobby(pid) {
    const me = pid ? this.players.get(pid) : null;
    return {
      online: [...this.players.values()].filter((p) => p.conn).length,
      catalog: CATALOG,
      rooms: [...this.rooms.values()].map((r) => ({
        id: r.id,
        gameId: r.gameId,
        gameName: r.meta.name,
        humans: r.humanSeats().length,
        capacity: r.seats.length,
        spectators: r.spectators.size,
        state: r.state,
      })),
      top: this.store.top(8),
      me: me ? { pid: me.pid, nick: me.nick, stats: this.store.stats(me.nick) } : null,
    };
  }

  broadcastLobby() {
    for (const p of this.players.values()) {
      if (!p.conn) continue;
      p.conn.send({ t: 'lobby', lobby: this.lobby(p.pid) });
    }
  }

  send(pid, obj) {
    const p = this.players.get(pid);
    if (p?.conn) p.conn.send(obj);
  }

  pushSystem(room, text) {
    room.system(text);
  }

  onEvict(pid) {
    const p = this.players.get(pid);
    if (p) p.roomId = null;
    this.broadcastLobby();
  }

  // ---------- 定时 ----------

  tick() {
    for (const room of [...this.rooms.values()]) {
      try {
        room.tick();
      } catch (err) {
        console.error(`[hub] 房间 ${room.id} tick 失败`, err);
      }
      if (room.isEmpty || room.idleTooLong) {
        this.rooms.delete(room.id);
        for (const p of this.players.values()) if (p.roomId === room.id) p.roomId = null;
      }
    }
    // 清理长时间掉线且不在房间里的玩家记录
    const cutoff = Date.now() - 3600 * 1000;
    for (const [pid, p] of this.players) {
      if (!p.conn && !p.roomId && p.lastSeen < cutoff) this.players.delete(pid);
    }
  }

  close() {
    clearInterval(this.timer);
    for (const room of this.rooms.values()) room.destroy?.();
    this.rooms.clear();
  }
}
