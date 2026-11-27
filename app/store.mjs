// 轻量持久化：一个 JSON 文件 + 追加式对局日志。
// 刻意不用 SQLite / 原生模块：单进程、十来个人，JSON 足够，而且拷走就能看。
import fs from 'node:fs';
import path from 'node:path';

const EMPTY = () => ({ players: {}, matches: [], updatedAt: 0 });

export class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'store.json');
    this.logFile = path.join(dataDir, 'matches.ndjson');
    this.data = EMPTY();
    this._timer = null;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
    } catch (err) {
      console.error('[store] 创建数据目录失败', err);
    }
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = { ...EMPTY(), ...parsed, players: parsed.players || {}, matches: parsed.matches || [] };
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[store] 读取 ${this.file} 失败，将从空库开始：${err.message}`);
    }
  }

  _scheduleSave() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, 300);
    this._timer.unref?.();
  }

  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this.data.updatedAt = Date.now();
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] 保存失败', err.message);
    }
  }

  player(nick) {
    const key = String(nick || '').toLowerCase();
    let p = this.data.players[key];
    if (!p) {
      p = { nick, score: 0, games: 0, wins: 0, lastSeen: 0 };
      this.data.players[key] = p;
    }
    return p;
  }

  /** 记一局结果：delta 为积分变化，win 标记是否赢家 */
  recordPlayer(nick, delta, win) {
    const p = this.player(nick);
    p.score += delta;
    p.games += 1;
    if (win) p.wins += 1;
    p.lastSeen = Date.now();
    this._scheduleSave();
    return p;
  }

  recordMatch(match) {
    this.data.matches.push(match);
    if (this.data.matches.length > 500) this.data.matches.splice(0, this.data.matches.length - 500);
    this._scheduleSave();
    try {
      fs.appendFileSync(this.logFile, JSON.stringify(match) + '\n', 'utf8');
    } catch (err) {
      console.warn('[store] 写对局日志失败', err.message);
    }
  }

  /** 改名：把旧名字的积分合并到新名字上，避免"改了名战绩就没了" */
  renamePlayer(oldNick, newNick) {
    const fromKey = String(oldNick || '').toLowerCase();
    const toKey = String(newNick || '').toLowerCase();
    if (!fromKey || !toKey || fromKey === toKey) return;
    const from = this.data.players[fromKey];
    if (!from) return;
    const to = this.data.players[toKey];
    if (to) {
      to.score += from.score;
      to.games += from.games;
      to.wins += from.wins;
      to.lastSeen = Date.now();
    } else {
      this.data.players[toKey] = { ...from, nick: newNick, lastSeen: Date.now() };
    }
    delete this.data.players[fromKey];
    this._scheduleSave();
  }

  top(limit = 10) {
    return Object.values(this.data.players)
      .filter((p) => p.games > 0)
      .sort((a, b) => b.score - a.score || b.wins - a.wins)
      .slice(0, limit)
      .map((p) => ({ nick: p.nick, score: p.score, games: p.games, wins: p.wins }));
  }

  stats(nick) {
    const p = this.player(nick);
    return { nick: p.nick, score: p.score, games: p.games, wins: p.wins };
  }
}
