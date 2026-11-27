// 斗地主牌型判定与出牌生成。
// 设计原则：判定（analyze）必须严格且唯一；生成（genAll）只需覆盖所有「合理」出法，
// 供机器人决策和「提示」按钮使用，不需要穷举组合。
import { valueOf } from './cards.mjs';

export const TYPE_NAME = {
  single: '单张',
  pair: '对子',
  triple: '三张',
  triple1: '三带一',
  triple2: '三带一对',
  straight: '顺子',
  pairs: '连对',
  plane: '飞机',
  plane1: '飞机带单',
  plane2: '飞机带对',
  four2: '四带二',
  four2p: '四带两对',
  bomb: '炸弹',
  rocket: '王炸',
};

const isRun = (vals) => {
  for (let i = 1; i < vals.length; i++) if (vals[i] !== vals[i - 1] + 1) return false;
  return true;
};

/**
 * 判定一组牌的牌型。
 * @returns {{type:string,len:number,main:number,size:number}|null}
 */
export function analyze(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return null;
  const n = ids.length;
  const counts = new Map();
  for (const id of ids) {
    const v = valueOf(id);
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  const groups = [...counts.entries()].sort((a, b) => a[0] - b[0]);
  const uniq = groups.length;
  const vals = groups.map((g) => g[0]);
  const maxV = vals[vals.length - 1];

  // 王炸（唯一的 2 张牌型）
  if (n === 2 && counts.has(16) && counts.has(17)) return { type: 'rocket', len: 1, main: 17, size: 2 };
  // 炸弹
  if (n === 4 && uniq === 1) return { type: 'bomb', len: 1, main: vals[0], size: 4 };
  if (n === 1) return { type: 'single', len: 1, main: vals[0], size: 1 };
  if (n === 2 && uniq === 1) return { type: 'pair', len: 1, main: vals[0], size: 2 };
  if (n === 3 && uniq === 1) return { type: 'triple', len: 1, main: vals[0], size: 3 };

  // 三带一 / 三带一对（三张必须恰好 3 张，避免炸弹拆用产生歧义）
  if (n === 4 && uniq === 2) {
    const t = groups.find((g) => g[1] === 3);
    if (t) return { type: 'triple1', len: 1, main: t[0], size: 4 };
  }
  if (n === 5 && uniq === 2) {
    const t = groups.find((g) => g[1] === 3);
    const p = groups.find((g) => g[1] === 2);
    if (t && p) return { type: 'triple2', len: 1, main: t[0], size: 5 };
  }

  // 顺子：≥5 张单牌连续，最高到 A
  if (n >= 5 && uniq === n && isRun(vals) && maxV <= 14) {
    return { type: 'straight', len: n, main: maxV, size: n };
  }
  // 连对：≥3 对连续
  if (n >= 6 && n % 2 === 0 && uniq === n / 2 && groups.every((g) => g[1] === 2) && isRun(vals) && maxV <= 14) {
    return { type: 'pairs', len: uniq, main: maxV, size: n };
  }
  // 飞机（不带）
  if (n >= 6 && n % 3 === 0 && uniq === n / 3 && groups.every((g) => g[1] === 3) && isRun(vals) && maxV <= 14) {
    return { type: 'plane', len: uniq, main: maxV, size: n };
  }

  // 飞机带单：k 组连续三张 + k 张散牌（k ≥ 2）
  if (n >= 8 && n % 4 === 0) {
    const k = n / 4;
    if (k >= 2) {
      const run = findRunWithCount(groups, k, 3, 14);
      if (run && run.values.length === k) {
        // 机身之外恰好剩 k 张
        const used = new Set(run.values);
        const restCount = groups.filter((g) => !used.has(g[0])).reduce((s, g) => s + g[1], 0);
        // groups 里被选中的值必须恰好 3 张，否则拆炸弹当机身
        const exact = run.values.every((v) => counts.get(v) === 3);
        if (restCount === k && exact) return { type: 'plane1', len: k, main: run.top, size: n };
      }
    }
  }
  // 飞机带对：k 组连续三张 + k 对
  if (n >= 10 && n % 5 === 0) {
    const k = n / 5;
    if (k >= 2) {
      const run = findRunWithCount(groups, k, 3, 14);
      if (run) {
        const used = new Set(run.values);
        const rest = groups.filter((g) => !used.has(g[0]));
        const exact = run.values.every((v) => counts.get(v) === 3);
        const pairTotal = rest.reduce((s, g) => s + g[1], 0);
        if (exact && pairTotal === 2 * k && rest.every((g) => g[1] === 2) && rest.length === k) {
          return { type: 'plane2', len: k, main: run.top, size: n };
        }
      }
    }
  }

  // 四带二：四张 + 两张单牌（可以是一对）
  if (n === 6) {
    const four = groups.find((g) => g[1] === 4);
    if (four) return { type: 'four2', len: 1, main: four[0], size: 6 };
  }
  // 四带两对：8 张
  if (n === 8) {
    const four = groups.find((g) => g[1] === 4);
    if (four) {
      const rest = groups.filter((g) => g[0] !== four[0]);
      const total = rest.reduce((s, g) => s + g[1], 0);
      if (total === 4 && rest.length === 2 && rest.every((g) => g[1] === 2)) {
        return { type: 'four2p', len: 1, main: four[0], size: 8 };
      }
    }
  }

  return null;
}

/** 在 groups 里找长度 k、每值至少 count 张、最高不超过 cap 的连续段；取最高的一段 */
function findRunWithCount(groups, k, count, cap) {
  const usable = groups.filter((g) => g[1] >= count && g[0] <= cap).map((g) => g[0]);
  let best = null;
  for (let i = 0; i <= usable.length - k; i++) {
    const seg = usable.slice(i, i + k);
    if (isRun(seg)) best = { values: seg, top: seg[seg.length - 1] };
  }
  return best;
}

/** a 能否压过 b */
export function beats(a, b) {
  if (!a) return false;
  if (!b) return true;
  if (a.type === 'rocket') return b.type !== 'rocket';
  if (b.type === 'rocket') return false;
  if (a.type === 'bomb' && b.type !== 'bomb') return true;
  if (b.type === 'bomb' && a.type !== 'bomb') return false;
  if (a.type !== b.type) return false;
  if (a.len !== b.len) return false;
  if (a.size !== b.size) return false;
  return a.main > b.main;
}

/** 手牌按点数分组，值 → 牌 id 数组（升序） */
export function groupHand(hand) {
  const m = new Map();
  for (const id of [...hand].sort((x, y) => valueOf(x) - valueOf(y) || x - y)) {
    const v = valueOf(id);
    if (!m.has(v)) m.set(v, []);
    m.get(v).push(id);
  }
  return m;
}

/**
 * 生成所有候选出法（每种 类型/长度/主牌 只留一个代表，翅膀取最小）。
 */
export function genAll(hand) {
  const g = groupHand(hand);
  const vals = [...g.keys()].sort((a, b) => a - b);
  const take = (v, n) => g.get(v).slice(0, n);
  const out = [];
  const seen = new Set();
  const push = (p) => {
    const key = `${p.type}:${p.len}:${p.main}:${p.size}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };

  const mk = (type, len, main, cards) => ({ type, len, main, size: cards.length, cards });

  for (const v of vals) {
    const c = g.get(v);
    push(mk('single', 1, v, take(v, 1)));
    if (c.length >= 2) push(mk('pair', 1, v, take(v, 2)));
    if (c.length >= 3) push(mk('triple', 1, v, take(v, 3)));
    if (c.length === 4) push(mk('bomb', 1, v, take(v, 4)));
  }
  if (g.has(16) && g.has(17)) push(mk('rocket', 1, 17, [...take(16, 1), ...take(17, 1)]));

  const others = (exclude, n) => {
    const ids = [];
    for (const v of vals) {
      if (exclude.has(v)) continue;
      for (const id of g.get(v)) ids.push(id);
    }
    ids.sort((a, b) => valueOf(a) - valueOf(b) || a - b);
    return ids.slice(0, n);
  };
  const othersPairs = (exclude, k) => {
    const ids = [];
    for (const v of vals) {
      if (exclude.has(v)) continue;
      const c = g.get(v);
      if (c.length >= 2) ids.push(c[0], c[1]);
      if (ids.length >= 2 * k) break;
    }
    return ids.slice(0, 2 * k);
  };

  // 三带
  for (const v of vals) {
    if (g.get(v).length !== 3) continue;
    const ex = new Set([v]);
    const w1 = others(ex, 1);
    if (w1.length === 1) push(mk('triple1', 1, v, [...take(v, 3), ...w1]));
    const w2 = othersPairs(ex, 1);
    if (w2.length === 2) push(mk('triple2', 1, v, [...take(v, 3), ...w2]));
  }

  // 四带二 / 四带两对
  for (const v of vals) {
    if (g.get(v).length !== 4) continue;
    const ex = new Set([v]);
    const w1 = others(ex, 2);
    if (w1.length === 2) push(mk('four2', 1, v, [...take(v, 4), ...w1]));
    const w2 = othersPairs(ex, 2);
    if (w2.length === 4) push(mk('four2p', 1, v, [...take(v, 4), ...w2]));
  }

  // 顺子 / 连对 / 飞机（连续段）
  const runsOf = (minCount, cap) => {
    const usable = vals.filter((v) => v <= cap && g.get(v).length >= minCount);
    const runs = [];
    let cur = [];
    for (const v of usable) {
      if (cur.length && v !== cur[cur.length - 1] + 1) {
        if (cur.length) runs.push(cur);
        cur = [];
      }
      cur.push(v);
    }
    if (cur.length) runs.push(cur);
    return runs;
  };

  for (const run of runsOf(1, 14)) {
    for (let len = 5; len <= run.length; len++) {
      for (let i = 0; i + len <= run.length; i++) {
        const seg = run.slice(i, i + len);
        push(mk('straight', len, seg[len - 1], seg.flatMap((v) => take(v, 1))));
      }
    }
  }
  for (const run of runsOf(2, 14)) {
    for (let len = 3; len <= run.length; len++) {
      for (let i = 0; i + len <= run.length; i++) {
        const seg = run.slice(i, i + len);
        push(mk('pairs', len, seg[len - 1], seg.flatMap((v) => take(v, 2))));
      }
    }
  }
  for (const run of runsOf(3, 14)) {
    for (let len = 2; len <= run.length; len++) {
      for (let i = 0; i + len <= run.length; i++) {
        const seg = run.slice(i, i + len);
        const body = seg.flatMap((v) => take(v, 3));
        // 机身必须恰好三张，避免拆炸弹
        if (!seg.every((v) => g.get(v).length === 3)) continue;
        push(mk('plane', len, seg[len - 1], body));
        const ex = new Set(seg);
        const w1 = others(ex, len);
        if (w1.length === len) push(mk('plane1', len, seg[len - 1], [...body, ...w1]));
        const w2 = othersPairs(ex, len);
        if (w2.length === 2 * len) push(mk('plane2', len, seg[len - 1], [...body, ...w2]));
      }
    }
  }

  return out;
}

/** 所有能压过 target 的出法（按大小升序） */
export function movesBeating(hand, target) {
  return genAll(hand)
    .filter((m) => beats(m, target))
    .sort((a, b) => a.size - b.size || rankOf(a) - rankOf(b));
}

export function rankOf(p) {
  if (!p) return 0;
  if (p.type === 'rocket') return 1000;
  if (p.type === 'bomb') return 500 + p.main;
  return p.main;
}
