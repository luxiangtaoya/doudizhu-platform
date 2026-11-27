// 机器人：规则型策略，够用来补位。
// 目标不是「强」，而是「不犯傻、会跟牌、留着炸弹、残局知道收」。
import { valueOf } from './cards.mjs';
import { genAll, movesBeating, rankOf } from './rules.mjs';

export function handPower(hand) {
  let p = 0;
  const counts = new Map();
  for (const id of hand) {
    const v = valueOf(id);
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  for (const [v, n] of counts) {
    if (v === 17) p += 4;
    else if (v === 16) p += 3;
    else if (v === 15) p += 1.6 * n;
    else if (v === 14) p += 0.7 * n;
    else if (v === 13) p += 0.4 * n;
    if (n === 4) p += 4;
  }
  if (counts.has(16) && counts.has(17)) p += 3;
  return p;
}

export function chooseBid(hand, current) {
  const p = handPower(hand) + Math.random() * 1.5;
  let want = 0;
  if (p >= 11) want = 3;
  else if (p >= 8) want = 2;
  else if (p >= 5.5) want = 1;
  if (want <= current) return 0;
  return want;
}

/** 候选出法是否会拆掉手里的炸弹 */
function breaksBomb(candidate, hand) {
  if (candidate.type === 'bomb' || candidate.type === 'rocket') return false;
  const counts = new Map();
  for (const id of hand) counts.set(valueOf(id), (counts.get(valueOf(id)) || 0) + 1);
  const used = new Map();
  for (const id of candidate.cards) used.set(valueOf(id), (used.get(valueOf(id)) || 0) + 1);
  for (const [v, n] of used) {
    if (counts.get(v) === 4 && n < 4) return true;
  }
  return false;
}

function play(cards) {
  return { type: 'play', cards };
}

export function chooseMove(game, seat) {
  const me = game.seats.find((s) => s.seat === seat);
  if (!me) return { type: 'pass' };
  const hand = me.hand;
  if (!hand.length) return { type: 'pass' };

  const last = game.lastPlay;
  const leading = !last || last.seat === seat;

  if (leading) return chooseLead(hand, me, game);

  const cands = movesBeating(hand, last.pattern);
  if (!cands.length) return { type: 'pass' };

  const landlordSeat = game.seats.find((s) => s.role === 'landlord')?.seat;
  const lastSeat = game.seats.find((s) => s.seat === last.seat);
  const iAmFarmer = me.role === 'farmer';
  const teammateWinning = iAmFarmer && lastSeat && lastSeat.role === 'farmer' && last.seat !== seat;

  const others = game.seats.filter((s) => s.seat !== seat);
  const foes = others.filter((s) => s.role !== me.role);
  const minFoeCards = foes.length ? Math.min(...foes.map((s) => s.hand.length)) : 99;
  const finish = cands.find((c) => c.cards.length === hand.length);
  if (finish) return play(finish.cards);

  // 队友已经压住了，别抢；除非对手快走完了
  if (teammateWinning && minFoeCards > 2) return { type: 'pass' };

  const nonBomb = cands.filter((c) => c.type !== 'bomb' && c.type !== 'rocket');
  const bombs = cands.filter((c) => c.type === 'bomb' || c.type === 'rocket');
  const safe = nonBomb.filter((c) => !breaksBomb(c, hand));

  if (safe.length) {
    // 自己牌少时优先用大牌收，否则尽量用最小的牌压
    const sorted = [...safe].sort((a, b) => rankOf(a) - rankOf(b));
    if (hand.length <= 5) return play(sorted[sorted.length - 1].cards);
    return play(sorted[0].cards);
  }

  if (bombs.length) {
    const danger = minFoeCards <= 3 || hand.length <= 6;
    if (danger) return play(bombs[0].cards);
  }
  if (nonBomb.length) return play(nonBomb[0].cards);
  return { type: 'pass' };
}

function chooseLead(hand, me, game) {
  const all = genAll(hand);
  if (!all.length) return { type: 'pass' };

  // 能一把走完就走完
  const finish = all.find((c) => c.cards.length === hand.length);
  if (finish) return play(finish.cards);

  const others = game.seats.filter((s) => s.seat !== me.seat);
  const foes = others.filter((s) => s.role !== me.role);
  const mates = others.filter((s) => s.role === me.role);
  const minFoe = foes.length ? Math.min(...foes.map((s) => s.hand.length)) : 99;
  const minMate = mates.length ? Math.min(...mates.map((s) => s.hand.length)) : 99;
  const iAmFarmer = me.role === 'farmer';

  const isBomb = (c) => c.type === 'bomb' || c.type === 'rocket';
  const nonBomb = all.filter((c) => !isBomb(c) && !breaksBomb(c, hand));
  const pool = nonBomb.length ? nonBomb : all.filter((c) => !isBomb(c));

  if (!pool.length) {
    // 只剩炸弹了
    return play(all[0].cards);
  }

  // 对手只剩一两张时，先出大单张逼他接不上
  if (minFoe <= 2) {
    const big = pool.filter((c) => c.main >= 12 && c.cards.length === 1).sort((a, b) => rankOf(b) - rankOf(a));
    if (big.length) return play(big[0].cards);
  }

  // 农民队友手里牌少时，尽量出小牌让他走
  if (iAmFarmer && minMate <= 4) {
    const low = pool.filter((c) => c.main <= 10).sort((a, b) => rankOf(a) - rankOf(b));
    if (low.length) return play(low[0].cards);
  }

  // 常规：先甩长牌型（顺子/连对/飞机），再出小单张
  const chains = pool.filter((c) => ['straight', 'pairs', 'plane', 'plane1', 'plane2'].includes(c.type));
  if (chains.length) {
    chains.sort((a, b) => b.cards.length - a.cards.length || rankOf(a) - rankOf(b));
    return play(chains[0].cards);
  }

  const lowPlays = pool.filter((c) => c.main <= 11);
  const use = lowPlays.length ? lowPlays : pool;
  use.sort((a, b) => rankOf(a) - rankOf(b));
  return play(use[0].cards);
}

/** 给人类玩家的「提示」：优先最小可压，其次最小出法 */
export function suggest(game, seat) {
  return chooseMove(game, seat);
}

/**
 * 提示用的候选列表：把所有合法出法按从小到大排好。
 * 和 chooseMove 的区别是它不做任何策略取舍（比如"队友在赢就别抢"），
 * 只会如实告诉玩家"你现在能出哪些牌"。
 */
export function hintMoves(game, seat) {
  const me = game.seats.find((s) => s.seat === seat);
  if (!me || !me.hand || !me.hand.length) return [];
  const last = game.lastPlay;
  const leading = !last || last.seat === seat;
  const list = leading ? genAll(me.hand) : movesBeating(me.hand, last.pattern);

  const seen = new Set();
  const uniq = [];
  for (const m of list) {
    const key = [...m.cards].sort((a, b) => a - b).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(m);
  }
  uniq.sort((a, b) => rankOf(a) - rankOf(b) || a.cards.length - b.cards.length);
  return uniq.slice(0, 80).map((m) => m.cards);
}
