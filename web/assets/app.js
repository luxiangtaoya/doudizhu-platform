// 前端主逻辑：大厅 + 牌桌 + 聊天 + 断线重连。
// 单文件、无框架、无构建，浏览器直接跑。

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const RANK_LABEL = {
  3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王',
};
const SUITS = ['♠', '♥', '♣', '♦'];
const TYPE_NAME = {
  single: '单张', pair: '对子', triple: '三张', triple1: '三带一', triple2: '三带一对',
  straight: '顺子', pairs: '连对', plane: '飞机', plane1: '飞机带单', plane2: '飞机带对',
  four2: '四带二', four2p: '四带两对', bomb: '炸弹', rocket: '王炸',
};

const QUICK = [
  '你的牌打得太好了！',
  '快点吧，我等到花儿都谢了',
  '不好意思，我又赢了',
  '不要走，决战到天亮',
  '大家好，很高兴见到各位',
  '这牌打得漂亮',
  '你怎么又输了',
  '我先走一步',
];

function valueOf(id) {
  if (id === 52) return 16;
  if (id === 53) return 17;
  return Math.floor(id / 4) + 3;
}
function cardInfo(id) {
  const v = valueOf(id);
  const joker = id >= 52;
  const suit = joker ? -1 : id % 4;
  return {
    id,
    v,
    joker,
    label: RANK_LABEL[v],
    suitLabel: suit >= 0 ? SUITS[suit] : '',
    red: suit === 1 || suit === 3 || id === 53,
  };
}
function sortDesc(ids) {
  return [...ids].sort((a, b) => valueOf(b) - valueOf(a) || b - a);
}

// ---------------- 状态 ----------------
const state = {
  pid: localStorage.getItem('dt_pid') || '',
  nick: localStorage.getItem('dt_nick') || '',
  screen: 'lobby',
  lobby: null,
  room: null,
  selected: new Set(),
  pending: false,
  hintKey: '',
  hintIdx: -1,
  xqSel: null,
  xqPly: -1,
  xqAnim: null,
  monoPos: {},
  dealNo: -1,
  dealUntil: 0,
  resultKey: '',
  resultAt: 0,
  offset: 0,
  mySeat: -1,
  busy: false,
};

// ---------------- 提示 ----------------
function toast(text, ms = 2200) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  $('#toastWrap').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ---------------- 连接 ----------------
class Net {
  constructor() {
    this.ws = null;
    this.handlers = new Map();
    this.retry = 0;
    this.manualClose = false;
  }
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }
  emit(type, payload) {
    for (const fn of this.handlers.get(type) || []) fn(payload);
  }
  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.emit('open');
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      this.emit(msg.t, msg);
    };
    ws.onclose = () => {
      this.emit('close');
      if (this.manualClose) return;
      const delay = Math.min(6000, 400 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => {};
  }
  send(obj) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }
}

const net = new Net();

function showConn(text) {
  $('#connText').textContent = text || '正在连接…';
  $('#connMask').classList.add('show');
}
function hideConn() {
  $('#connMask').classList.remove('show');
}

net.on('open', () => {
  net.send({ t: 'hello', pid: state.pid, nick: state.nick });
});

net.on('welcome', (msg) => {
  state.pid = msg.pid;
  state.nick = msg.nick;
  localStorage.setItem('dt_pid', msg.pid);
  localStorage.setItem('dt_nick', msg.nick);
  hideConn();
  $('#myNick').textContent = msg.nick;
  if (msg.lobby) renderLobby(msg.lobby);
});

net.on('lobby', (msg) => {
  state.lobby = msg.lobby;
  renderLobby(msg.lobby);
});

net.on('state', (msg) => {
  const changed = msg.room.id !== state.room?.id;
  state.room = msg.room;
  state.mySeat = msg.room.youSeat;
  state.offset = msg.room.now - Date.now();
  if (changed) state.selected.clear();
  // 自己刚出的牌被服务端接受了：这时候才清空选中
  if (state.pending) {
    state.pending = false;
    state.selected.clear();
  }
  showScreen('table');
  renderTable(msg.room);
});

net.on('nick', (msg) => {
  state.nick = msg.nick;
  localStorage.setItem('dt_nick', msg.nick);
  $('#myNick').textContent = msg.nick;
  toast(`名字改成「${msg.nick}」了`);
});

net.on('ping', () => net.send({ t: 'pong' }));
net.on('error', (msg) => {
  // 出牌被拒：保留玩家原来的选牌，只把按钮恢复，方便就地改牌重试
  state.pending = false;
  state.busy = false;
  renderHand();
  updatePlayButton();
  toast(msg.msg || '操作失败');
});
net.on('hint', (msg) => {
  const moves = msg.moves || [];
  if (!moves.length) {
    state.selected.clear();
    renderHand();
    updatePlayButton();
    toast(msg.pass ? '没有能压过的牌，点「不出」就行' : '没有能出的牌');
    return;
  }
  const g = state.room?.game;
  const key = `${g?.turn}|${g?.hand?.length}|${g?.lastPlay ? `${g.lastPlay.seat}:${g.lastPlay.cards.length}` : 'x'}`;
  if (state.hintKey !== key) {
    state.hintKey = key;
    state.hintIdx = -1;
  }
  state.hintIdx = (state.hintIdx + 1) % moves.length;
  state.selected = new Set(moves[state.hintIdx]);
  renderHand();
  updatePlayButton();
});
net.on('close', () => {
  if (state.screen === 'table') showConn('连接断开，正在重连…');
});

// ---------------- 屏幕切换 ----------------
function showScreen(name) {
  state.screen = name;
  $('#screen-lobby').classList.toggle('active', name === 'lobby');
  $('#screen-table').classList.toggle('active', name === 'table');
}

// ---------------- 大厅 ----------------
function renderLobby(lobby) {
  if (!lobby) return;
  $('#onlineCount').textContent = lobby.online ?? 0;
  const me = lobby.me;
  if (me) {
    $('#myNick').textContent = me.nick;
    $('#myScore').textContent = me.stats?.score ?? 0;
  }

  const catalog = $('#catalog');
  catalog.innerHTML = '';
  for (const g of lobby.catalog || []) {
    const card = document.createElement('div');
    card.className = `game-card ${g.status === 'ready' ? 'ready' : ''}`;
    card.innerHTML = `
      <div>
        <div class="name">${g.name}</div>
        <div class="desc">${g.desc || ''}</div>
      </div>
      <span class="badge">${g.status === 'ready' ? '可玩' : '敬请期待'}</span>`;
    if (g.status === 'ready') {
      card.style.cursor = 'pointer';
      card.addEventListener('click', () => sendCreate(g.id));
    }
    catalog.appendChild(card);
  }

  const list = $('#roomList');
  const rooms = lobby.rooms || [];
  $('#roomCountHint').textContent = rooms.length ? `${rooms.length} 桌` : '';
  list.innerHTML = '';
  if (!rooms.length) {
    list.innerHTML = '<div class="empty">还没有人开房，点右上角“创建房间”。</div>';
  } else {
    for (const r of rooms) {
      const item = document.createElement('div');
      item.className = 'room-item';
      item.innerHTML = `
        <div class="code">${r.id}</div>
        <div class="meta">${r.gameName} · ${r.humans}/${r.capacity} 人${r.spectators ? ` · ${r.spectators} 观战` : ''}</div>
        <div class="status ${r.state === 'playing' ? 'playing' : ''}">${r.state === 'playing' ? '进行中' : '等待中'}</div>
        <button class="ghost small">加入</button>`;
      item.querySelector('button').addEventListener('click', () => sendJoin(r.id));
      list.appendChild(item);
    }
  }

  const board = $('#board');
  const top = lobby.top || [];
  board.innerHTML = top.length
    ? top
        .map((p, i) => {
          const crown = i === 0 ? '<span class="crown">♛</span>' : '';
          return `<li class="rank-${i + 1}"><span class="idx">${i + 1}</span><span class="nick">${crown}${escapeHtml(p.nick)}</span>
          <span class="score">${p.score > 0 ? '+' : ''}${p.score}</span></li>`;
        })
        .join('')
    : '<li class="empty-line">还没有战绩，打完一局就上榜。</li>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------- 牌桌 ----------------
function seatIndexes(you) {
  return { me: you, right: (you + 1) % 3, left: (you + 2) % 3 };
}

function renderTable(room) {
  const g = room.game;
  const felt = document.querySelector('.felt');
  felt.classList.toggle('felt--gomoku', room.gameId === 'gomoku');
  felt.classList.toggle('felt--xiangqi', room.gameId === 'xiangqi');
  felt.classList.toggle('felt--monopoly', room.gameId === 'monopoly');
  felt.classList.toggle('felt--spectator', !!room.spectator);

  $('#roomCode').textContent = room.id;
  $('#waitCode').textContent = room.id;
  renderSpec(room);

  if (!g) {
    showWaiting(room);
    return;
  }
  hideWaiting();

  if (room.gameId === 'gomoku') {
    renderGomoku(room);
  } else if (room.gameId === 'xiangqi') {
    renderXiangqi(room);
  } else if (room.gameId === 'monopoly') {
    renderMonopoly(room);
  } else {
    $('#multiVal').textContent = g.multiplier || 1;
    $('#bombVal').textContent = g.bombs || 0;
    const idx = seatIndexes(room.youSeat);
    renderSeat($('#seatLeft'), idx.left, g, room);
    renderSeat($('#seatRight'), idx.right, g, room);
    renderSeat($('#seatMe'), idx.me, g, room);
    renderBottom(g);
    renderHand();
    renderPlays(g);
    renderActions(g, room);
    renderBid(g, room);
  }
  renderAuto(room);
  handleChat(room);
  renderResult(g, room, room.youSeat);
  updateClock();
}

/** 观战信息条 */
function renderSpec(room) {
  const el = $('#specInfo');
  if (!el) return;
  const list = room.spectators || [];
  if (room.spectator) {
    el.textContent = list.length > 1 ? `观战中 · 同场 ${list.length} 人在看` : '观战中';
    el.classList.add('on', 'me');
  } else if (list.length) {
    el.textContent = `观战 ${list.length} 人：${list.join('、')}`;
    el.classList.add('on');
    el.classList.remove('me');
  } else {
    el.textContent = '';
    el.classList.remove('on', 'me');
  }
}

/** 托管按钮状态 */
function renderAuto(room) {
  const btn = $('#btnAuto');
  if (!btn) return;
  const active = !!room.auto;
  btn.textContent = active ? '取消托管' : '托管';
  btn.classList.toggle('on', active);
  btn.disabled = !!room.spectator || room.gameId === 'gomoku' || room.state !== 'playing';
}

function renderSeat(el, seatIdx, g, room) {
  if (!el) return;
  const s = g.seats.find((x) => x.seat === seatIdx);
  if (!s) {
    el.innerHTML = '';
    return;
  }
  const roomSeat = (room.seats || [])[seatIdx];
  const online = roomSeat ? roomSeat.online : true;
  const auto = roomSeat ? roomSeat.auto : false;
  const isTurn = g.turn === seatIdx && g.phase !== 'over';
  const roleText = s.role === 'landlord' ? '地主' : s.role === 'farmer' ? '农民' : '';
  const roleCls = s.role === 'landlord' ? 'landlord' : s.role === 'farmer' ? 'farmer' : '';
  const initial = (s.nick || '?').slice(0, 1);
  const score = roomSeat ? roomSeat.score : 0;
  const bidText = g.phase === 'bid' && s.bid !== null ? (s.bid === 0 ? '不叫' : `叫${s.bid}分`) : '';

  el.className = `seat ${el.classList.contains('seat-left') ? 'seat-left' : el.classList.contains('seat-right') ? 'seat-right' : 'seat-me'} ${isTurn ? 'turn' : ''} ${online ? '' : 'offline'}`;

  el.innerHTML = `
    <div class="avatar"><div class="ring"></div><span>${escapeHtml(initial)}</span></div>
    <div class="seat-info">
      <div class="seat-name">${escapeHtml(s.nick)}${s.isBot ? ' <span class="seat-role">AI</span>' : ''}
        ${roleText ? `<span class="seat-role ${roleCls}">${roleText}</span>` : ''}
        ${auto && !s.isBot ? '<span class="badge-auto">托管</span>' : ''}
        ${online ? '' : '<span class="badge-auto">离线</span>'}
      </div>
      <div class="seat-sub">${isTurn ? '<span class="thinking">思考中 · </span>' : ''}${bidText ? `<span>${bidText}</span> · ` : ''}剩 <b>${s.cardCount}</b> 张 · ${score > 0 ? '+' : ''}${score} 分</div>
      <div class="card-count">${'<span class="back"></span>'.repeat(Math.min(8, s.cardCount))}<span class="n">${s.cardCount}</span></div>
    </div>`;
}

/** 三家本轮出的牌，各自朝桌子中央摊开 */
function renderPlays(g) {
  const idx = seatIndexes(state.mySeat);
  const zones = [
    ['#playLeft', idx.left],
    ['#playRight', idx.right],
    ['#playMe', idx.me],
  ];
  for (const [sel, seat] of zones) {
    const box = $(sel);
    if (!box) continue;
    box.innerHTML = '';
    const act = (g.trickActions || [])[seat];
    if (!act) continue;
    if (act.kind === 'pass') {
      const pill = document.createElement('span');
      pill.className = 'pass-pill';
      pill.textContent = '不出';
      box.appendChild(pill);
      continue;
    }
    if (!act.cards || !act.cards.length) continue;
    const shown = sortDesc(act.cards);
    const cap = 12;
    for (const id of shown.slice(0, cap)) box.appendChild(cardEl(id, 'small'));
    if (shown.length > cap) {
      const more = document.createElement('span');
      more.className = 'more-cards';
      more.textContent = `+${shown.length - cap}`;
      box.appendChild(more);
    }
  }
}

function renderBottom(g) {
  const box = $('#bottomCards');
  box.innerHTML = '';
  if (!g.bottom || !g.bottom.length) return;
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = '底牌';
  box.appendChild(label);
  for (const id of sortDesc(g.bottom)) box.appendChild(cardEl(id, 'mini'));
}

function renderHand() {
  const g = state.room?.game;
  const box = $('#hand');
  box.innerHTML = '';
  if (!g) return;

  // 新一局：让手牌一张张飞进来，给个"发牌"的过程感
  const dealKey = `${state.room.id}:${g.dealNo ?? 0}`;
  if (g.dealNo && state.dealNo !== dealKey) {
    state.dealNo = dealKey;
    state.dealUntil = Date.now() + 950;
    setTimeout(() => {
      if (state.room?.game?.dealNo) renderHand();
    }, 1000);
  }
  const dealing = Date.now() < state.dealUntil;

  for (const id of sortDesc(g.hand || [])) {
    const el = cardEl(id, '');
    el.dataset.id = id;
    if (state.selected.has(id)) el.classList.add('selected');
    el.addEventListener('click', () => {
      if (!canAct()) return;
      if (state.selected.has(id)) state.selected.delete(id);
      else state.selected.add(id);
      el.classList.toggle('selected');
      updatePlayButton();
    });
    box.appendChild(el);
  }
  if (dealing) {
    [...box.children].forEach((el, i) => {
      el.style.animation = `dealIn .3s ease-out ${Math.min(i * 28, 520)}ms both`;
    });
  }
}

function canAct() {
  const g = state.room?.game;
  return !!g && g.phase === 'playing' && g.turn === state.mySeat;
}

function updatePlayButton() {
  $('#btnPlay').disabled = !canAct() || state.selected.size === 0 || state.pending;
}

// ---------------- 五子棋 ----------------
let gomokuGeom = { margin: 0, step: 0, n: 15 };

function renderGomoku(room) {
  const g = room.game;
  const seats = g.seats || [];
  for (let i = 0; i < 2; i++) {
    const el = $(`#gp${i}`);
    if (!el) continue;
    const s = seats[i];
    if (!s) {
      el.innerHTML = '';
      continue;
    }
    const active = g.turn === s.seat && g.phase === 'playing';
    el.className = `gp ${active ? 'active' : ''}`;
    el.innerHTML = `<span class="stone ${s.color === 1 ? 'black' : 'white'}"></span>
      <span class="gp-text"><b>${escapeHtml(s.nick)}</b><i>${s.color === 1 ? '执黑' : '执白'} · ${s.stones} 子</i></span>`;
  }
  drawBoard(g);
  const tip = $('#gomokuTip');
  if (tip) {
    if (g.phase === 'over') tip.textContent = '';
    else if (room.spectator) tip.textContent = '观战中';
    else if (g.turn === room.youSeat) tip.textContent = '轮到你了，点棋盘落子';
    else tip.textContent = '等对手落子…';
  }
}

function drawBoard(g) {
  const canvas = $('#gomokuBoard');
  if (!canvas) return;
  const stage = $('#gomokuStage');
  if (!stage) return;
  const box = stage.getBoundingClientRect();
  const size = Math.max(260, Math.min(box.width - 64, box.height - 170));
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const n = g.size || 15;
  const margin = size * 0.05 + 10;
  const step = (size - margin * 2) / (n - 1);
  gomokuGeom = { margin, step, n };

  ctx.fillStyle = '#f2e2c4';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = '#cbb08a';
  ctx.lineWidth = 1;
  for (let i = 0; i < n; i++) {
    const p = margin + i * step;
    ctx.beginPath();
    ctx.moveTo(margin, p);
    ctx.lineTo(size - margin, p);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p, margin);
    ctx.lineTo(p, size - margin);
    ctx.stroke();
  }

  const mid = Math.floor(n / 2);
  const stars = n >= 15 ? [[3, 3], [n - 4, 3], [3, n - 4], [n - 4, n - 4], [mid, mid]] : [[mid, mid]];
  ctx.fillStyle = '#b59a72';
  for (const [sx, sy] of stars) {
    ctx.beginPath();
    ctx.arc(margin + sx * step, margin + sy * step, Math.max(2, step * 0.09), 0, Math.PI * 2);
    ctx.fill();
  }

  const grid = g.grid || [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = grid[y * n + x];
      if (v) drawStone(ctx, margin + x * step, margin + y * step, step * 0.44, v);
    }
  }

  if (g.lastMove) {
    ctx.strokeStyle = '#e05252';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(margin + g.lastMove.x * step, margin + g.lastMove.y * step, step * 0.13, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawStone(ctx, cx, cy, r, color) {
  const grad = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.2, cx, cy, r);
  if (color === 1) {
    grad.addColorStop(0, '#5a6068');
    grad.addColorStop(1, '#1c2126');
  } else {
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(1, '#dfe4e1');
  }
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = color === 1 ? 'rgba(0,0,0,.35)' : 'rgba(150,160,155,.55)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

// ---------------- 中国象棋 ----------------
const XQ_GLYPH = { 1: ['帥', '將'], 2: ['仕', '士'], 3: ['相', '象'], 4: ['傌', '馬'], 5: ['俥', '車'], 6: ['炮', '砲'], 7: ['兵', '卒'] };
let xqGeom = { cell: 0, mx: 0, my: 0 };

function renderXiangqi(room) {
  const g = room.game;
  // 局面变了就清掉选中，并给落子加一段滑行，不然根本看不清对方走了哪
  if (state.xqPly !== g.ply) {
    state.xqPly = g.ply;
    state.xqSel = null;
    if (g.lastMove && g.lastMove.to) {
      const piece = g.board[g.lastMove.to.y * 9 + g.lastMove.to.x];
      state.xqAnim = { from: g.lastMove.from, to: g.lastMove.to, start: performance.now(), dur: 480, piece };
    }
  }
  const seats = g.seats || [];
  for (let i = 0; i < 2; i++) {
    const el = $(`#xq${i}`);
    if (!el) continue;
    const s = seats[i];
    if (!s) {
      el.innerHTML = '';
      continue;
    }
    const active = g.turn === s.seat && g.phase === 'playing';
    const red = s.color > 0;
    el.className = `gp ${active ? 'active' : ''}`;
    el.innerHTML = `<span class="xq-dot ${red ? 'red' : 'black'}"></span>
      <span class="gp-text"><b>${escapeHtml(s.nick)}</b><i>${red ? '执红' : '执黑'}${g.check && g.turn === s.seat ? ' · 被将军' : ''}</i></span>`;
  }
  drawXiangqi(g, room);
  if (state.xqAnim) scheduleXqFrame();
  const tip = $('#xiangqiTip');
  if (tip) {
    if (g.phase === 'over') tip.textContent = '';
    else if (room.spectator) tip.textContent = '观战中';
    else if (g.turn === room.youSeat) tip.textContent = g.check ? '你被将军了，必须应将' : '点自己的棋子，再点目标位置';
    else tip.textContent = '等对手走棋…';
  }
}

let xqRaf = 0;
function scheduleXqFrame() {
  if (xqRaf) return;
  xqRaf = requestAnimationFrame(() => {
    xqRaf = 0;
    const a = state.xqAnim;
    const room = state.room;
    if (!a || !room || room.gameId !== 'xiangqi' || !room.game) return;
    const t = (performance.now() - a.start) / a.dur;
    drawXiangqi(room.game, room);
    if (t >= 1) {
      state.xqAnim = null;
      drawXiangqi(room.game, room);
      return;
    }
    scheduleXqFrame();
  });
}

function drawXiangqi(g, room) {
  const canvas = $('#xiangqiBoard');
  const stage = $('#xiangqiStage');
  if (!canvas || !stage) return;
  const box = stage.getBoundingClientRect();
  // 棋盘实际占 10 格宽（8 格 + 两侧留白）、11 格高（9 格 + 两侧留白），
  // 所以格子尺寸要按 10/11 来算，否则宽屏上会上下溢出把玩家信息顶出视野
  const cell = Math.max(20, Math.min((box.width - 100) / 10, (box.height - 200) / 11));
  const width = cell * 8;
  const height = cell * 9;
  const pad = cell * 1.0;
  const w = width + pad * 2;
  const h = height + pad * 2;
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  xqGeom = { cell, mx: pad, my: pad };

  ctx.fillStyle = '#f3e3c3';
  ctx.fillRect(0, 0, w, h);
  const X = (x) => pad + x * cell;
  const Y = (y) => pad + y * cell;

  ctx.strokeStyle = '#a98d63';
  ctx.lineWidth = 1;
  for (let y = 0; y < 10; y++) {
    ctx.beginPath();
    ctx.moveTo(X(0), Y(y));
    ctx.lineTo(X(8), Y(y));
    ctx.stroke();
  }
  for (let x = 0; x < 9; x++) {
    if (x === 0 || x === 8) {
      ctx.beginPath();
      ctx.moveTo(X(x), Y(0));
      ctx.lineTo(X(x), Y(9));
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(X(x), Y(0));
      ctx.lineTo(X(x), Y(4));
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(X(x), Y(5));
      ctx.lineTo(X(x), Y(9));
      ctx.stroke();
    }
  }
  for (const y0 of [0, 7]) {
    ctx.beginPath();
    ctx.moveTo(X(3), Y(y0));
    ctx.lineTo(X(5), Y(y0 + 2));
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(X(5), Y(y0));
    ctx.lineTo(X(3), Y(y0 + 2));
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(120, 90, 50, 0.5)';
  ctx.font = `${Math.round(cell * 0.42)}px "KaiTi", "STKaiti", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('楚 河', X(2), (Y(4) + Y(5)) / 2);
  ctx.fillText('漢 界', X(6), (Y(4) + Y(5)) / 2);

  const sel = state.xqSel;
  if (sel) {
    ctx.strokeStyle = '#0f8a5f';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(X(sel.x), Y(sel.y), cell * 0.46, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (sel && g.legalMoves) {
    for (const m of g.legalMoves) {
      if (m.from.x !== sel.x || m.from.y !== sel.y) continue;
      ctx.fillStyle = 'rgba(23, 166, 115, 0.35)';
      ctx.beginPath();
      ctx.arc(X(m.to.x), Y(m.to.y), cell * 0.14, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (g.lastMove) {
    ctx.strokeStyle = 'rgba(224, 82, 82, 0.7)';
    ctx.lineWidth = 2;
    for (const p of [g.lastMove.from, g.lastMove.to]) {
      ctx.strokeRect(X(p.x) - cell * 0.42, Y(p.y) - cell * 0.42, cell * 0.84, cell * 0.84);
    }
  }

  const anim = state.xqAnim;
  const t = anim ? Math.min(1, (performance.now() - anim.start) / anim.dur) : 1;

  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 9; x++) {
      const v = g.board[y * 9 + x];
      if (!v) continue;
      if (anim && t < 1 && x === anim.to.x && y === anim.to.y) continue; // 动画期间不在终点画
      drawXqPiece(ctx, X(x), Y(y), cell * 0.42, v);
    }
  }

  // 落子滑行：起点留个淡影，棋子沿直线滑到终点
  if (anim && t < 1) {
    const ease = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
    const px = anim.from.x + (anim.to.x - anim.from.x) * ease;
    const py = anim.from.y + (anim.to.y - anim.from.y) * ease;
    ctx.save();
    ctx.globalAlpha = 0.28 * (1 - t);
    drawXqPiece(ctx, X(anim.from.x), Y(anim.from.y), cell * 0.42, anim.piece);
    ctx.restore();
    drawXqPiece(ctx, X(px), Y(py), cell * 0.42, anim.piece);
    // 终点画个圈，落地后一眼能看到
    ctx.strokeStyle = 'rgba(23, 166, 115, 0.75)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(X(anim.to.x), Y(anim.to.y), cell * 0.5, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawXqPiece(ctx, cx, cy, r, v) {
  const red = v > 0;
  const glyph = (XQ_GLYPH[Math.abs(v)] || ['?', '?'])[red ? 0 : 1];
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#fbf3e2';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = red ? '#b93a2f' : '#2f3437';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.82, 0, Math.PI * 2);
  ctx.strokeStyle = red ? 'rgba(185, 58, 47, .45)' : 'rgba(47, 52, 55, .45)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = red ? '#b93a2f' : '#2f3437';
  ctx.font = `600 ${Math.round(r * 1.12)}px "KaiTi", "STKaiti", "Microsoft YaHei", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(glyph, cx, cy + r * 0.04);
}

function onXiangqiClick(e) {
  const room = state.room;
  if (!room || room.gameId !== 'xiangqi' || !room.game) return;
  const g = room.game;
  if (g.phase !== 'playing' || room.spectator || g.turn !== room.youSeat) return;

  const rect = e.currentTarget.getBoundingClientRect();
  const { cell, mx, my } = xqGeom;
  const x = Math.round((e.clientX - rect.left - mx) / cell);
  const y = Math.round((e.clientY - rect.top - my) / cell);
  if (x < 0 || y < 0 || x > 8 || y > 9) return;

  const v = g.board[y * 9 + x];
  const mine = v !== 0 && Math.sign(v) === Math.sign(g.yourColor);
  const sel = state.xqSel;

  if (sel) {
    const ok = (g.legalMoves || []).some(
      (m) => m.from.x === sel.x && m.from.y === sel.y && m.to.x === x && m.to.y === y,
    );
    if (ok) {
      net.send({ t: 'act', action: { type: 'move', from: { x: sel.x, y: sel.y }, to: { x, y } } });
      state.xqSel = null;
      return;
    }
    state.xqSel = mine ? { x, y } : null;
    renderXiangqi(room);
    return;
  }
  if (mine) {
    state.xqSel = { x, y };
    renderXiangqi(room);
  }
}

function onBoardClick(e) {
  const room = state.room;
  if (!room || room.gameId !== 'gomoku' || !room.game) return;
  const g = room.game;
  if (g.phase !== 'playing' || room.spectator || g.turn !== room.youSeat) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const { margin, step, n } = gomokuGeom;
  const x = Math.round((e.clientX - rect.left - margin) / step);
  const y = Math.round((e.clientY - rect.top - margin) / step);
  if (x < 0 || y < 0 || x >= n || y >= n) return;
  if (g.grid[y * n + x] !== 0) return;
  net.send({ t: 'act', action: { type: 'place', x, y } });
}

// ---------------- 大富翁 ----------------
let monoBuilt = false;
let monoTiles = [];
let monoTokens = [];
let monoAnim = null;
const MONO_SIZE = 28;

function buildMonoBoard(g) {
  if (monoBuilt) return;
  const board = $('#monoBoard');
  if (!board || !g.tiles) return;
  const center = board.querySelector('.mono-center');
  monoTiles = [];
  monoTokens = [];
  for (const t of g.tiles) {
    const wrap = document.createElement('div');
    wrap.className = 'mono-tile';
    wrap.style.left = `${t.x * 12.5}%`;
    wrap.style.top = `${t.y * 12.5}%`;
    wrap.dataset.i = String(t.i);
    wrap.innerHTML = `<div class="mono-face"><div class="bar"></div><div class="body">
        <div class="nm"></div><div class="pr"></div><div class="lv"></div></div>
        <div class="mono-tokens"></div></div>`;
    board.insertBefore(wrap, center);
    monoTiles[t.i] = wrap;
    monoTokens[t.i] = wrap.querySelector('.mono-tokens');
  }
  monoBuilt = true;
}

function faceOf(i) {
  return monoTiles[i]?.querySelector('.mono-face');
}

function updateMonoTiles(g, room) {
  for (const t of g.tiles) {
    const face = faceOf(t.i);
    if (!face) continue;
    const nm = face.querySelector('.nm');
    const pr = face.querySelector('.pr');
    const bar = face.querySelector('.bar');
    const lv = face.querySelector('.lv');
    const owner = g.owners[t.i];

    face.classList.toggle('corner', ['start', 'jail', 'parking', 'gojail'].includes(t.type));
    nm.textContent = t.name;
    pr.textContent = t.type === 'prop' ? `¥${t.price}` : '';
    bar.style.setProperty('--g', t.group || 'transparent');
    face.querySelectorAll('.ic').forEach((el) => el.remove());

    if (t.type === 'prop') {
      lv.innerHTML = '';
      for (let k = 0; k < 3; k++) {
        const d = document.createElement('i');
        if (k < g.levels[t.i]) d.className = 'on';
        lv.appendChild(d);
      }
    } else {
      lv.innerHTML = '';
      const ic = document.createElement('div');
      ic.className = 'ic';
      ic.textContent = t.type === 'start' ? '🏁' : t.type === 'jail' ? '🔒' : t.type === 'parking' ? '🅿️' : t.type === 'gojail' ? '🚔' : t.type === 'chance' ? '❓' : '$';
      face.querySelector('.body').appendChild(ic);
    }

    if (owner != null && g.players[owner]) {
      const c = g.players[owner].color;
      face.classList.add('owned');
      face.style.setProperty('--own', c);
      face.style.setProperty('--own-tint', `${c}33`);
      let dot = face.querySelector('.own-dot');
      if (!dot) {
        dot = document.createElement('span');
        dot.className = 'own-dot';
        face.appendChild(dot);
      }
      dot.style.setProperty('--own', c);
    } else {
      face.classList.remove('owned');
      face.querySelector('.own-dot')?.remove();
    }
    face.title = t.type === 'prop' ? `${t.name}｜价 ${t.price}｜租金 ${t.rent * 2 ** g.levels[t.i]}` : t.name;
  }
}

function placeMonoTokens(g, room) {
  for (const holder of monoTokens) if (holder) holder.innerHTML = '';
  for (const p of g.players) {
    const idx = state.monoPos[p.seat] ?? p.pos;
    const holder = monoTokens[idx];
    if (!holder) continue;
    const el = document.createElement('span');
    el.className = 'mono-token';
    if (p.seat === room.youSeat) el.classList.add('me');
    if (monoAnim && monoAnim.seat === p.seat) el.classList.add('hop');
    el.style.setProperty('--c', p.color);
    holder.appendChild(el);
  }
}

function hopToken(seat, from, to, paint) {
  monoAnim = { seat, cur: from };
  const step = () => {
    if (!monoAnim) return;
    monoAnim.cur = (monoAnim.cur + 1) % MONO_SIZE;
    state.monoPos[seat] = monoAnim.cur;
    paint();
    if (monoAnim.cur === to) {
      monoAnim = null;
      paint();
      return;
    }
    setTimeout(step, 110);
  };
  setTimeout(step, 50);
}

function renderMonoDice(g) {
  const box = $('#monoDice');
  if (!box) return;
  const [a, b] = g.dice || [0, 0];
  box.innerHTML = '';
  if (!a && !b) {
    box.innerHTML = '<div class="mono-die"></div><div class="mono-die"></div>';
    return;
  }
  box.appendChild(dieEl(a));
  box.appendChild(dieEl(b));
}

function dieEl(v) {
  const dots = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  const el = document.createElement('div');
  el.className = 'mono-die';
  const on = dots[v] || [];
  for (let i = 0; i < 9; i++) {
    const d = document.createElement('i');
    if (on.includes(i)) d.className = 'on';
    el.appendChild(d);
  }
  return el;
}

function renderMonoStatus(g, room) {
  const box = $('#monoStatus');
  const round = $('#monoRound');
  if (!box) return;
  if (round) round.textContent = `第 ${g.round || 1} / ${g.maxRounds || 20} 回合`;
  const actor = g.players.find((p) => p.seat === g.turn);
  const mine = g.turn === room.youSeat;

  if (g.phase === 'over') {
    box.textContent = '本局结束';
    return;
  }
  if (room.spectator) {
    box.innerHTML = `观战中 · 轮到 ${actor ? actor.nick : '—'}`;
    return;
  }
  if (g.phase === 'roll') {
    box.innerHTML = mine ? '轮到你，掷骰子吧' : `等 ${actor?.nick || ''} 掷骰子…`;
    return;
  }
  if (g.phase === 'buy') {
    const t = g.tiles.find((x) => x.i === actor.pos);
    box.innerHTML = mine
      ? `可以买下 ${t.name}<span class="sub">价格 ¥${t.price}，买下后别人踩到要付 ¥${t.rent}</span>`
      : `${actor.nick} 正在考虑买 ${t.name}…`;
    return;
  }
  if (g.phase === 'end') {
    box.innerHTML = mine ? '可以升级自己的地产，或结束回合' : `${actor?.nick || ''} 行动中…`;
  }
}

function renderMonoActions(g, room) {
  const box = $('#monoActions');
  if (!box) return;
  box.innerHTML = '';
  if (room.spectator || g.phase === 'over') return;
  const mine = g.turn === room.youSeat;
  if (!mine) return;

  const mk = (label, cls, fn, disabled) => {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.disabled = !!disabled;
    b.addEventListener('click', fn);
    box.appendChild(b);
    return b;
  };

  if (g.phase === 'roll') {
    mk('掷骰子', 'primary', () => net.send({ t: 'act', action: { type: 'roll' } }));
  } else if (g.phase === 'buy') {
    const t = g.tiles.find((x) => x.i === g.players.find((p) => p.seat === room.youSeat).pos);
    const me = g.players.find((p) => p.seat === room.youSeat);
    mk(`买下 ¥${t.price}`, 'primary', () => net.send({ t: 'act', action: { type: 'buy', yes: true } }), me.cash < t.price);
    mk('放弃', 'ghost', () => net.send({ t: 'act', action: { type: 'buy', yes: false } }));
  } else if (g.phase === 'end') {
    mk('结束回合', 'primary', () => net.send({ t: 'act', action: { type: 'end' } }));
  }
}

function renderMonoLog(g) {
  const box = $('#monoLog');
  if (!box) return;
  box.innerHTML = '';
  for (const item of g.log || []) {
    const d = document.createElement('div');
    d.textContent = item.text;
    box.appendChild(d);
  }
}

function renderMonoSide(g, room) {
  const box = $('#monoSide');
  if (!box) return;
  box.innerHTML = '';
  for (const p of g.players) {
    const el = document.createElement('div');
    el.className = 'mono-player';
    if (p.seat === g.turn && g.phase !== 'over') el.classList.add('active');
    if (p.bankrupt) el.classList.add('out');
    el.innerHTML = `<span class="mp-dot" style="--c:${p.color}"></span>
      <div class="mp-main"><b>${escapeHtml(p.nick)}${p.seat === room.youSeat ? '（你）' : ''}</b>
      <i>${p.props} 块地${p.jail ? ' · 狱中' : ''}${p.bankrupt ? ' · 已破产' : ''}</i></div>
      <span class="mp-cash ${p.cash < 2000 ? 'low' : ''}">¥${p.cash}</span>`;
    box.appendChild(el);
  }
}

function renderMonopoly(room) {
  const g = room.game;
  buildMonoBoard(g);
  updateMonoTiles(g, room);
  // 新一局所有人都在起点，把上一局记住的位置清掉
  if (g.players.every((p) => p.pos === 0) && Object.values(state.monoPos).some((v) => v !== 0)) {
    state.monoPos = {};
  }
  for (const p of g.players) if (state.monoPos[p.seat] == null) state.monoPos[p.seat] = p.pos;
  if (!monoAnim) {
    const mover = g.players.find((p) => state.monoPos[p.seat] !== p.pos);
    if (mover) {
      const from = state.monoPos[mover.seat];
      const dist = (mover.pos - from + MONO_SIZE) % MONO_SIZE;
      if (dist > 0 && dist <= 12) {
        hopToken(mover.seat, from, mover.pos, () => placeMonoTokens(g, room));
      } else {
        state.monoPos[mover.seat] = mover.pos;
      }
    }
  }
  placeMonoTokens(g, room);
  renderMonoDice(g);
  renderMonoStatus(g, room);
  renderMonoActions(g, room);
  renderMonoLog(g);
  renderMonoSide(g, room);
}

function onMonoClick(e) {
  const room = state.room;
  if (!room || room.gameId !== 'monopoly' || !room.game) return;
  const g = room.game;
  if (g.phase !== 'end' || room.spectator || g.turn !== room.youSeat) return;
  const tileEl = e.target.closest('.mono-tile');
  if (!tileEl) return;
  const i = Number(tileEl.dataset.i);
  if (g.owners[i] !== room.youSeat || g.levels[i] >= 3) return;
  net.send({ t: 'act', action: { type: 'upgrade', tile: i } });
}

function renderActions(g, room) {
  const mine = g.turn === state.mySeat && g.phase !== 'over';
  const bar = $('#actions');
  const wait = $('#waitHint');

  if (g.phase === 'over') {
    $('#btnPlay').disabled = true;
    $('#btnPass').disabled = true;
    $('#btnHint').disabled = true;
    wait.textContent = '本局结束';
    return;
  }
  if (g.phase === 'bid') {
    $('#btnPlay').disabled = true;
    $('#btnPass').disabled = true;
    $('#btnHint').disabled = true;
    $('#actions').style.visibility = 'hidden';
    wait.textContent = mine ? '轮到你叫分' : '等待其他玩家叫分…';
    return;
  }
  $('#actions').style.visibility = '';

  const leading = !g.lastPlay || g.lastPlay.seat === state.mySeat;
  $('#btnHint').disabled = !mine;
  $('#btnPass').disabled = !mine || leading;
  updatePlayButton();
  wait.textContent = mine ? '' : `${nameOf(g.turn, g)} 正在出牌…`;
}

function nameOf(seat, g) {
  const s = g.seats.find((x) => x.seat === seat);
  return s ? s.nick : '';
}

function renderBid(g, room) {
  const overlay = $('#bidOverlay');
  const mine = g.phase === 'bid' && g.turn === state.mySeat;
  if (!mine) {
    overlay.classList.remove('show');
    return;
  }
  overlay.classList.add('show');
  $('#bidDesc').textContent = g.bid.current ? `当前最高 ${g.bid.current} 分` : '还没人叫分';
  const box = $('#bidActions');
  box.innerHTML = '';
  const mk = (label, value) => {
    const b = document.createElement('button');
    b.className = value === 0 ? 'ghost' : 'primary';
    b.textContent = label;
    b.disabled = value > 0 && value <= g.bid.current;
    b.addEventListener('click', () => {
      if (state.busy) return;
      state.busy = true;
      overlay.classList.remove('show');
      net.send({ t: 'act', action: { type: 'bid', value } });
      setTimeout(() => (state.busy = false), 400);
    });
    box.appendChild(b);
  };
  mk('不叫', 0);
  mk('1 分', 1);
  mk('2 分', 2);
  mk('3 分', 3);
}

function renderResult(g, room, youSeat) {
  const overlay = $('#resultOverlay');
  if (g.phase !== 'over' || !g.result) {
    state.resultKey = '';
    overlay.classList.remove('show');
    return;
  }

  // 别急着盖结算：先让人看清最后这一手
  if (state.resultKey !== 'over') {
    state.resultKey = 'over';
    state.resultAt = Date.now() + 1800;
    setTimeout(() => {
      if (state.room) renderTable(state.room);
    }, 1850);
  }
  if (Date.now() < state.resultAt) {
    overlay.classList.remove('show');
    return;
  }

  const r = g.result;
  overlay.classList.add('show');

  const ddz = typeof r.landlordWin === 'boolean';
  const iWon = r.draw
    ? false
    : ddz
      ? r.landlordWin
        ? r.landlordSeat === youSeat
        : r.landlordSeat !== youSeat
      : r.winnerSeat === youSeat;

  const title = $('#resultTitle');
  if (room.spectator) {
    title.textContent = '本局结束';
    title.className = 'result-title';
  } else {
    title.textContent = r.draw ? '和棋' : iWon ? '你赢了' : '你输了';
    title.className = `result-title ${iWon ? '' : 'lose'}`;
  }

  const tags = [];
  if (ddz) {
    tags.push(r.landlordWin ? '地主胜' : '农民胜');
    tags.push(`${r.multiplier} 倍`);
    if (r.bombs) tags.push(`${r.bombs} 个炸弹`);
    if (r.spring) tags.push('春天');
    if (r.antiSpring) tags.push('反春天');
  } else if (r.summary) {
    tags.push(r.summary);
  }
  $('#resultSub').textContent = tags.join(' · ');

  const rows = $('#resultRows');
  rows.innerHTML = '';
  for (const d of r.deltas) {
    const el = document.createElement('div');
    el.className = 'result-row';
    el.innerHTML = `<span class="nick">${escapeHtml(d.nick)} ${d.role === 'landlord' ? '<b>地主</b>' : '农民'}</span>
      <span class="delta ${d.delta >= 0 ? 'plus' : 'minus'}">${d.delta > 0 ? '+' : ''}${d.delta}</span>`;
    rows.appendChild(el);
  }

  const actions = $('#resultActions');
  actions.innerHTML = '';
  if (room.spectator) {
    const tip = document.createElement('button');
    tip.className = 'ghost';
    tip.textContent = '观战中';
    tip.disabled = true;
    actions.appendChild(tip);
    const out = document.createElement('button');
    out.className = 'ghost';
    out.textContent = '离开房间';
    out.addEventListener('click', doLeave);
    actions.appendChild(out);
    return;
  }
  const isHost = room.hostPid === state.pid;
  const again = document.createElement('button');
  again.className = 'primary';
  again.textContent = isHost ? '再来一局' : '等待房主';
  again.disabled = !isHost;
  again.addEventListener('click', () => net.send({ t: 'start' }));
  actions.appendChild(again);

  // 不管是不是房主，都要能离开这桌去换一间
  const leave = document.createElement('button');
  leave.className = 'ghost';
  leave.textContent = '离开房间';
  leave.addEventListener('click', doLeave);
  actions.appendChild(leave);
}

function showWaiting(room) {
  $('#waitingOverlay').classList.remove('hide');
  $('#actions').style.visibility = 'hidden';
  const slots = $('#seatPreview');
  slots.innerHTML = '';
  for (let i = 0; i < room.seats.length; i++) {
    const s = room.seats[i];
    const el = document.createElement('div');
    el.className = `seat-slot ${s ? 'filled' : ''}`;
    el.innerHTML = s
      ? `<div class="who">${escapeHtml(s.nick)}</div><div class="tag">${s.isBot ? '机器人' : s.pid === state.pid ? '你' : '玩家'}</div>`
      : '<div class="who">空位</div><div class="tag">等人</div>';
    slots.appendChild(el);
  }
  const isHost = room.hostPid === state.pid;
  const btn = $('#btnStart');
  btn.disabled = !isHost;
  btn.textContent = isHost ? '开始游戏' : '等待房主开始';
  $('#waitHintText').textContent = isHost ? '人不齐会补机器人' : '';
  $('#bidOverlay').classList.remove('show');
  $('#resultOverlay').classList.remove('show');
  $('#hand').innerHTML = '';
}

function hideWaiting() {
  $('#waitingOverlay').classList.add('hide');
  $('#actions').style.visibility = '';
}

// ---------------- 计时 ----------------
setInterval(() => {
  if (state.screen === 'table') updateClock();
}, 250);

function updateClock() {
  const g = state.room?.game;
  if (!g || !g.deadline) {
    $('#turnHint').classList.add('idle');
    const idleText = state.room?.state === 'waiting' ? '等待开局' : '本局结束';
    $('#turnHint').textContent = idleText;
    return;
  }
  const now = Date.now() + state.offset;
  const left = Math.max(0, g.deadline - now);
  const total = (g.phase === 'bid' ? 15 : 30) * 1000;
  const pct = Math.max(0, Math.min(100, (left / total) * 100));

  const actor = g.seats.find((s) => s.seat === g.turn);
  const hint = $('#turnHint');
  hint.classList.remove('idle');
  const secs = Math.ceil(left / 1000);
  hint.textContent = g.turn === state.mySeat ? `轮到你 ${secs}s` : `${actor ? actor.nick : ''} ${secs}s`;

  const rings = [
    ['#seatLeft', seatIndexes(state.mySeat).left],
    ['#seatRight', seatIndexes(state.mySeat).right],
    ['#seatMe', state.mySeat],
  ];
  for (const [sel, seat] of rings) {
    const ring = $(`${sel} .ring`);
    if (ring) ring.style.setProperty('--p', String(seat === g.turn ? pct : 0));
  }
}

// ---------------- 卡牌元素 ----------------
function cardEl(id, cls = '') {
  const c = cardInfo(id);
  const el = document.createElement('div');
  el.className = `card ${cls} ${c.red ? 'red' : 'black'}${c.joker ? ' joker' : ''}`;
  el.dataset.id = id;
  if (c.joker) {
    el.innerHTML = `<span class="c-joker ${c.red ? 'red' : 'black'}">${c.label}</span>`;
  } else {
    el.innerHTML = `<span class="c-rank">${c.label}</span><span class="c-suit">${c.suitLabel}</span><span class="c-pip">${c.suitLabel}</span>`;
  }
  return el;
}

// ---------------- 聊天：从说话人头上冒出的气泡 ----------------
function seatAnchor(seat) {
  const idx = seatIndexes(state.mySeat);
  if (seat === idx.me) return { el: $('#seatMe'), side: 'me' };
  if (seat === idx.left) return { el: $('#seatLeft'), side: 'left' };
  if (seat === idx.right) return { el: $('#seatRight'), side: 'right' };
  return null;
}

function showBubble(seat, text, from) {
  const layer = $('#bubbleLayer');
  const anchor = seatAnchor(seat);
  if (!layer || !anchor || !anchor.el) {
    toast(from ? `${from}：${text}` : text);
    return;
  }
  const old = layer.querySelector(`.bubble[data-seat="${seat}"]`);
  if (old) old.remove();

  const b = document.createElement('div');
  b.className = 'bubble';
  b.dataset.seat = String(seat);
  b.dataset.side = anchor.side;
  b.textContent = text;
  layer.appendChild(b);

  const lr = layer.getBoundingClientRect();
  const avatar = anchor.el.querySelector('.avatar') || anchor.el;
  const ar = avatar.getBoundingClientRect();
  const bw = b.offsetWidth;
  const bh = b.offsetHeight;
  let left = ar.left + ar.width / 2 - bw / 2 - lr.left;
  let top = ar.top - lr.top - bh - 14;
  left = Math.max(6, Math.min(left, lr.width - bw - 6));
  top = Math.max(6, top);
  b.style.left = `${left}px`;
  b.style.top = `${top}px`;
  requestAnimationFrame(() => b.classList.add('show'));

  setTimeout(() => {
    b.classList.add('out');
    setTimeout(() => b.remove(), 320);
  }, 4600);
}

function handleChat(room) {
  const list = room.chat || [];
  if (state.chatRoomId !== room.id) {
    state.chatRoomId = room.id;
    state.lastChatTs = list.reduce((m, x) => Math.max(m, x.ts || 0), 0);
    return;
  }
  for (const m of list) {
    const ts = m.ts || 0;
    if (ts <= (state.lastChatTs || 0)) continue;
    state.lastChatTs = ts;
    if (m.system) toast(m.text, 3200);
    else showBubble(m.seat, m.text, m.from);
  }
}

function sendChat(text) {
  const msg = String(text || '').trim();
  if (!msg) return;
  net.send({ t: 'chat', text: msg });
  $('#chatInput').value = '';
  closeQuick();
}

function closeQuick() {
  $('#quickPop').classList.remove('show');
}

function renderQuick() {
  const box = $('#quickPop');
  box.innerHTML = '';
  for (const q of QUICK) {
    const b = document.createElement('button');
    b.textContent = q;
    b.addEventListener('click', () => sendChat(q));
    box.appendChild(b);
  }
}

// ---------------- 操作 ----------------
function sendCreate(gameId) {
  if (state.busy) return;
  state.busy = true;
  net.send({ t: 'create', gameId: gameId || 'ddz' });
  setTimeout(() => (state.busy = false), 600);
}
function sendJoin(code) {
  if (state.busy) return;
  const c = String(code || '').trim().toUpperCase();
  if (!c) {
    toast('先输入房间号');
    return;
  }
  state.busy = true;
  net.send({ t: 'join', code: c });
  setTimeout(() => (state.busy = false), 600);
}
function doLeave() {
  net.send({ t: 'leave' });
  state.room = null;
  state.selected.clear();
  state.pending = false;
  state.chatRoomId = null;
  $('#bubbleLayer').innerHTML = '';
  closeQuick();
  showScreen('lobby');
}

function bindUI() {
  $('#btnCreate').addEventListener('click', sendCreate);
  $('#btnJoin').addEventListener('click', () => sendJoin($('#joinCode').value));
  $('#joinCode').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendJoin($('#joinCode').value);
  });
  $('#btnLeave').addEventListener('click', doLeave);
  $('#btnLeaveWaiting').addEventListener('click', doLeave);
  $('#btnStart').addEventListener('click', () => net.send({ t: 'start' }));
  $('#btnLogout').addEventListener('click', async () => {
    // 先退房间再退出登录，否则下次进来又会自动回到这桌
    net.send({ t: 'leave' });
    await new Promise((r) => setTimeout(r, 120));
    await fetch('/api/logout', { method: 'POST' }).catch(() => {});
    location.href = '/login';
  });

  $('#btnPlay').addEventListener('click', () => {
    if (!canAct() || state.selected.size === 0 || state.pending) return;
    state.pending = true;
    updatePlayButton();
    net.send({ t: 'act', action: { type: 'play', cards: [...state.selected] } });
  });
  $('#btnPass').addEventListener('click', () => {
    if (!canAct() || state.pending) return;
    state.pending = true;
    updatePlayButton();
    net.send({ t: 'act', action: { type: 'pass' } });
  });
  $('#btnHint').addEventListener('click', () => {
    if (!canAct()) return;
    net.send({ t: 'hint' });
  });
  $('#btnAuto').addEventListener('click', () => {
    if (!state.room) return;
    net.send({ t: 'auto', on: !state.room.auto });
  });
  $('#gomokuBoard').addEventListener('click', onBoardClick);
  $('#xiangqiBoard').addEventListener('click', onXiangqiClick);
  $('#monoBoard').addEventListener('click', onMonoClick);

  $('#btnSend').addEventListener('click', () => sendChat($('#chatInput').value));
  $('#chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat($('#chatInput').value);
    if (e.key === 'Escape') closeQuick();
  });
  $('#btnQuick').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#quickPop').classList.toggle('show');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#quickPop') && e.target.id !== 'btnQuick') closeQuick();
  });

  $('#btnNickOk').addEventListener('click', submitNick);
  $('#nickInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitNick();
  });
  $('#myPill').addEventListener('click', () => {
    $('#modalNick').querySelector('h3').textContent = '改个名字';
    $('#modalNick').querySelector('p').textContent = '名字会立刻同步到牌桌上，战绩跟着新名字走。';
    $('#btnNickOk').textContent = '保存';
    $('#nickInput').value = state.nick || '';
    $('#modalNick').classList.add('show');
    $('#nickInput').focus();
  });
  $('#myNick').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#myPill').click();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      state.selected.clear();
      renderHand();
      updatePlayButton();
    }
    if (e.key === 'Enter' && state.screen === 'table' && canAct() && document.activeElement.tagName !== 'INPUT') {
      $('#btnPlay').click();
    }
  });
}

function submitNick() {
  const v = $('#nickInput').value.trim();
  if (!v) {
    toast('名字不能为空');
    return;
  }
  $('#modalNick').classList.remove('show');
  // 已经连上了就是改名，否则是第一次进站
  if (net.ws && net.ws.readyState === 1) {
    net.send({ t: 'nick', nick: v.slice(0, 12) });
    return;
  }
  state.nick = v.slice(0, 12);
  localStorage.setItem('dt_nick', state.nick);
  showConn('正在连接…');
  net.connect();
}

// ---------------- 启动 ----------------
/** 按窗口宽度整体缩放：1440 为基准，超宽屏放大到最多 1.75 倍 */
function applyScale() {
  const k = Math.max(1, Math.min(1.75, window.innerWidth / 1440));
  document.documentElement.style.setProperty('--k', k.toFixed(3));
}

function init() {
  bindUI();
  renderQuick();
  applyScale();
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      applyScale();
      if (state.room?.gameId === 'gomoku' && state.room.game) renderGomoku(state.room);
      if (state.room?.gameId === 'xiangqi' && state.room.game) renderXiangqi(state.room);
    }, 150);
  });
  showScreen('lobby');
  if (!state.nick) {
    $('#modalNick').querySelector('h3').textContent = '给自己起个名字';
    $('#modalNick').querySelector('p').textContent = '会显示给牌桌上的同事，12 个字以内。';
    $('#btnNickOk').textContent = '进入大厅';
    $('#modalNick').classList.add('show');
    $('#nickInput').focus();
    return;
  }
  showConn('正在连接…');
  net.connect();
}

init();
