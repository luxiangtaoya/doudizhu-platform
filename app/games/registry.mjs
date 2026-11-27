// 游戏注册表：平台扩展点。
//
// 接一个新游戏只需要：
//   1. 在 games/<id>/ 下实现一个类，暴露 act(seat, action) / viewFor(seat) /
//      timeout() / phase / turn / result / seats；
//   2. 在下面的 GAMES 里注册一行（可选提供 bot / hints）。
// 房间、座位、观战、重连、计时、聊天、积分、大厅都不用改。
import { DdzGame } from './ddz/engine.mjs';
import { chooseBid, chooseMove, hintMoves } from './ddz/ai.mjs';
import { GomokuGame, chooseGomokuMove } from './gomoku/engine.mjs';
import { XiangqiGame, chooseXiangqiMove } from './xiangqi/engine.mjs';

export const GAMES = {
  ddz: {
    id: 'ddz',
    name: '斗地主',
    seats: 3,
    create(seats, opts) {
      return new DdzGame(seats, opts);
    },
    /** 机器人一手：叫分阶段叫分，出牌阶段按策略出 */
    bot(game, seat) {
      if (game.phase === 'bid') {
        return { type: 'bid', value: chooseBid(game.seats[seat].hand, game.bidCurrent) };
      }
      return chooseMove(game, seat);
    },
    /** 提示：返回所有合法出法（从最小开始） */
    hints(game, seat) {
      return hintMoves(game, seat);
    },
  },
  gomoku: {
    id: 'gomoku',
    name: '五子棋',
    seats: 2,
    create(seats, opts) {
      return new GomokuGame(seats, opts);
    },
    bot(game, seat) {
      return chooseGomokuMove(game, seat);
    },
  },
  xiangqi: {
    id: 'xiangqi',
    name: '中国象棋',
    seats: 2,
    create(seats, opts) {
      return new XiangqiGame(seats, opts);
    },
    bot(game, seat) {
      return chooseXiangqiMove(game, seat);
    },
  },
};

/** 大厅展示用：已上线 + 预留位 */
export const CATALOG = [
  { id: 'ddz', name: '斗地主', status: 'ready', desc: '经典 54 张 · 三人 · 叫分制' },
  { id: 'gomoku', name: '五子棋', status: 'ready', desc: '15×15 无禁手 · 双人' },
  { id: 'xiangqi', name: '中国象棋', status: 'ready', desc: '9×10 全规则 · 双人' },
  { id: 'monopoly', name: '大富翁', status: 'planned', desc: '扩展位：多回合经营类' },
];

export function gameMeta(id) {
  const g = GAMES[id];
  if (!g) throw new Error(`未知游戏：${id}`);
  return g;
}
