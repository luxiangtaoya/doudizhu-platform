// 斗地主对局状态机。与网络层完全解耦，方便单测和将来换成别的传输。
import { makeDeck, sortHand } from './cards.mjs';
import { analyze, beats, TYPE_NAME } from './rules.mjs';
import { rotate, shuffle } from '../../util.mjs';

const nextSeat = (s) => (s + 1) % 3;

export class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class DdzGame {
  constructor(seats, { maxMultiplier = 16, turnMs = 30000, bidMs = 15000 } = {}) {
    this.maxMultiplier = maxMultiplier;
    this.turnMs = turnMs;
    this.bidMs = bidMs;
    this.seats = seats.map((s) => ({
      seat: s.seat,
      nick: s.nick,
      isBot: !!s.isBot,
      role: null,
      hand: [],
      bid: null,
      plays: 0,
      online: true,
    }));
    this.phase = 'bid';
    this.turn = 0;
    this.deadline = 0;
    this.bombs = 0;
    this.multiplier = 0;
    this.bidCurrent = 0;
    this.bidder = null;
    this.bidOrder = [];
    this.bidIdx = 0;
    this.redeals = 0;
    this.lastPlay = null;
    this.passCount = 0;
    /** 本轮每个座位最近一次动作：{kind:'play'|'pass', cards, type} */
    this.trickActions = [null, null, null];
    this.bottom = [];
    this.result = null;
    this.events = [];
    this.dealNo = 0;
    this._deal();
  }

  _event(text) {
    this.events.push({ ts: Date.now(), text });
    if (this.events.length > 60) this.events.splice(0, this.events.length - 60);
  }

  _deal() {
    this.dealNo += 1;
    const deck = shuffle(makeDeck());
    for (let i = 0; i < 3; i++) this.seats[i].hand = sortHand(deck.slice(i * 17, i * 17 + 17));
    this.bottom = deck.slice(51, 54);

    this.phase = 'bid';
    this.bombs = 0;
    this.multiplier = 0;
    this.bidCurrent = 0;
    this.bidder = null;
    this.lastPlay = null;
    this.passCount = 0;
    this.result = null;
    this.trickActions = [null, null, null];
    this.bidOrder = rotate([0, 1, 2], Math.floor(Math.random() * 3));
    this.bidIdx = 0;
    this.turn = this.bidOrder[0];
    this.deadline = Date.now() + this.bidMs;
    for (const s of this.seats) {
      s.bid = null;
      s.role = null;
      s.plays = 0;
    }
    this._event(`第 ${this.dealNo} 局：${this.seats[this.turn].nick} 先叫分`);
  }

  get actor() {
    return this.seats[this.turn];
  }

  act(seat, action) {
    if (this.phase === 'over') throw new GameError('over', '本局已结束');
    if (seat !== this.turn) throw new GameError('not_your_turn', '还没轮到你');
    if (this.phase === 'bid') return this._actBid(seat, action);
    return this._actPlay(seat, action);
  }

  _actBid(seat, action) {
    const value = Number(action?.value);
    if (![0, 1, 2, 3].includes(value)) throw new GameError('bad_bid', '叫分只能是 0-3');
    if (value > 0 && value <= this.bidCurrent) throw new GameError('bad_bid', `叫分必须高于 ${this.bidCurrent} 分`);

    const s = this.seats[seat];
    s.bid = value;
    if (value > 0) {
      this.bidCurrent = value;
      this.bidder = seat;
      this._event(`${s.nick} 叫 ${value} 分`);
    } else {
      this._event(`${s.nick} 不叫`);
    }

    if (value === 3) {
      this._finishBid(seat);
      return;
    }

    this.bidIdx += 1;
    if (this.bidIdx >= this.bidOrder.length) {
      if (this.bidder === null) {
        this.redeals += 1;
        // 连续流局会无限重发，第三次直接按 1 分给首位，保证牌局能往前走
        if (this.redeals >= 3) {
          this.bidCurrent = 1;
          this._event('连续三家不叫，强制 1 分');
          this._finishBid(this.bidOrder[0]);
          return;
        }
        this._event('三家都不叫，重新发牌');
        this._deal();
      } else {
        this._finishBid(this.bidder);
      }
      return;
    }
    this.turn = this.bidOrder[this.bidIdx];
    this.deadline = Date.now() + this.bidMs;
  }

  _finishBid(landlordSeat) {
    this.phase = 'playing';
    this.redeals = 0;
    const lord = this.seats[landlordSeat];
    lord.role = 'landlord';
    for (const s of this.seats) if (s.seat !== landlordSeat) s.role = 'farmer';
    lord.hand = sortHand([...lord.hand, ...this.bottom]);
    this.multiplier = this.bidCurrent;
    this.turn = landlordSeat;
    this.lastPlay = null;
    this.passCount = 0;
    this.deadline = Date.now() + this.turnMs;
    this.trickActions = [null, null, null];
    this._event(`${lord.nick} 成为地主（${this.bidCurrent} 分），底牌已亮`);
  }

  _actPlay(seat, action) {
    if (action?.type === 'pass') {
      if (!this.lastPlay || this.lastPlay.seat === seat) throw new GameError('must_play', '你是本轮首家，必须出牌');
      this.passCount += 1;
      this.trickActions[seat] = { kind: 'pass' };
      this._event(`${this.seats[seat].nick} 要不起`);
      if (this.passCount >= 2) {
        const lead = this.lastPlay.seat;
        this.lastPlay = null;
        this.passCount = 0;
        this.turn = lead;
        this.trickActions = [null, null, null];
      } else {
        this.turn = nextSeat(seat);
      }
      this.deadline = Date.now() + this.turnMs;
      return;
    }

    if (action?.type !== 'play') throw new GameError('bad_action', '未知操作');
    const cards = Array.isArray(action.cards) ? action.cards : [];
    const hand = this.seats[seat].hand;
    if (cards.length === 0) throw new GameError('empty', '请选择要出的牌');
    if (new Set(cards).size !== cards.length) throw new GameError('dup', '选牌重复');
    for (const id of cards) {
      if (!hand.includes(id)) throw new GameError('not_owned', '牌不在你的手里');
    }

    const pattern = analyze(cards);
    if (!pattern) throw new GameError('bad_pattern', '不是有效的牌型');

    if (this.lastPlay && this.lastPlay.seat !== seat) {
      if (!beats(pattern, this.lastPlay.pattern)) {
        throw new GameError('cannot_beat', `压不过上家的${TYPE_NAME[this.lastPlay.pattern.type] || '牌'}`);
      }
    }

    this.seats[seat].hand = hand.filter((id) => !cards.includes(id));
    this.seats[seat].plays += 1;
    if (pattern.type === 'bomb' || pattern.type === 'rocket') this.bombs += 1;

    this.lastPlay = { seat, cards: [...cards], pattern };
    this.trickActions[seat] = { kind: 'play', cards: [...cards], type: pattern.type };
    this.passCount = 0;
    this._event(`${this.seats[seat].nick} 出 ${TYPE_NAME[pattern.type]}`);

    if (this.seats[seat].hand.length === 0) {
      this._finish(seat);
      return;
    }

    this.turn = nextSeat(seat);
    this.deadline = Date.now() + this.turnMs;
  }

  _finish(winnerSeat) {
    this.phase = 'over';
    this.deadline = 0;
    const winner = this.seats[winnerSeat];
    const landlord = this.seats.find((s) => s.role === 'landlord');
    const farmers = this.seats.filter((s) => s.role === 'farmer');
    const landlordWin = winner.role === 'landlord';

    const farmersPlays = farmers.reduce((s, x) => s + x.plays, 0);
    const spring = landlordWin && farmersPlays === 0;
    const antiSpring = !landlordWin && landlord.plays === 1;

    let mult = Math.max(1, this.multiplier || this.bidCurrent || 1);
    mult *= 2 ** this.bombs;
    if (spring || antiSpring) mult *= 2;
    mult = Math.min(mult, this.maxMultiplier);

    const deltas = new Map();
    if (landlordWin) {
      deltas.set(landlord.seat, 2 * mult);
      for (const f of farmers) deltas.set(f.seat, -mult);
    } else {
      deltas.set(landlord.seat, -2 * mult);
      for (const f of farmers) deltas.set(f.seat, mult);
    }

    this.result = {
      winnerSeat,
      landlordSeat: landlord.seat,
      landlordWin,
      multiplier: mult,
      bombs: this.bombs,
      spring,
      antiSpring,
      deltas: this.seats.map((s) => ({ seat: s.seat, nick: s.nick, delta: deltas.get(s.seat) || 0, role: s.role })),
      remaining: this.seats.map((s) => ({ seat: s.seat, cards: s.hand.length })),
    };
    this._event(
      `${landlordWin ? '地主' : '农民'}获胜，${mult} 倍${spring ? '（春天）' : antiSpring ? '（反春天）' : ''}`,
    );
  }

  /** 超时自动托管：叫分阶段不叫，出牌阶段不要或出最小单张 */
  timeout() {
    if (this.phase === 'over') return;
    if (this.phase === 'bid') {
      this.act(this.turn, { type: 'bid', value: 0 });
      return;
    }
    if (!this.lastPlay || this.lastPlay.seat === this.turn) {
      const hand = sortHand(this.seats[this.turn].hand);
      this.act(this.turn, { type: 'play', cards: [hand[0]] });
    } else {
      this.act(this.turn, { type: 'pass' });
    }
  }

  viewFor(seat) {
    const me = this.seats.find((s) => s.seat === seat);
    return {
      youSeat: seat,
      phase: this.phase,
      turn: this.turn,
      deadline: this.deadline,
      multiplier: this.phase === 'bid' ? this.bidCurrent : this.multiplier,
      bombs: this.bombs,
      bid: { current: this.bidCurrent, idx: this.bidIdx, order: this.bidOrder },
      lastPlay: this.lastPlay
        ? { seat: this.lastPlay.seat, cards: this.lastPlay.cards, type: this.lastPlay.pattern.type }
        : null,
      trickActions: this.trickActions.map((a) =>
        a ? { kind: a.kind, cards: a.cards || [], type: a.type || null } : null,
      ),
      bottom: this.phase === 'playing' || this.phase === 'over' ? this.bottom : [],
      seats: this.seats.map((s) => ({
        seat: s.seat,
        nick: s.nick,
        isBot: s.isBot,
        role: s.role,
        cardCount: s.hand.length,
        bid: s.bid,
        plays: s.plays,
        online: s.online,
      })),
      hand: me ? me.hand : [],
      result: this.result,
      dealNo: this.dealNo,
      events: this.events.slice(-12),
    };
  }
}
