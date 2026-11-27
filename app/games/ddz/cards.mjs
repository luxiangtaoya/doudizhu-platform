// 牌的基础表示：id 0..53。
// 0..51 按 (点数-3)*4 + 花色 编码；52 = 小王；53 = 大王。
export const SUITS = ['♠', '♥', '♣', '♦'];
export const RANK_LABEL = {
  3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王',
};

export const MIN_VALUE = 3;
export const MAX_VALUE = 17;
export const JOKER_SMALL = 16;
export const JOKER_BIG = 17;

export function makeDeck() {
  const deck = [];
  for (let id = 0; id < 52; id++) deck.push(id);
  deck.push(52, 53);
  return deck;
}

export function valueOf(id) {
  if (id === 52) return JOKER_SMALL;
  if (id === 53) return JOKER_BIG;
  return Math.floor(id / 4) + MIN_VALUE;
}

export function suitOf(id) {
  if (id >= 52) return -1;
  return id % 4;
}

export function isJoker(id) {
  return id >= 52;
}

export function cardInfo(id) {
  const value = valueOf(id);
  const suit = suitOf(id);
  return {
    id,
    value,
    suit,
    label: RANK_LABEL[value] ?? '?',
    suitLabel: suit >= 0 ? SUITS[suit] : '',
    red: suit === 1 || suit === 3 || id === 53,
    joker: id >= 52,
  };
}

/** 手牌排序：按点数升序，同点数按花色升序 */
export function sortHand(ids) {
  return [...ids].sort((a, b) => valueOf(a) - valueOf(b) || a - b);
}

/** 降序（前端展示用，大牌在左） */
export function sortHandDesc(ids) {
  return [...ids].sort((a, b) => valueOf(b) - valueOf(a) || b - a);
}

export function cardsText(ids) {
  return sortHand(ids)
    .map((id) => {
      const c = cardInfo(id);
      return c.joker ? c.label : c.label + c.suitLabel;
    })
    .join(' ');
}
