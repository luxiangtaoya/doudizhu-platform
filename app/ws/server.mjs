// 最小可用的 WebSocket 服务端，挂在已有的 http.Server 上。
// 支持：握手校验（可插入 cookie 鉴权）、JSON 文本消息、ping/pong 心跳、优雅关闭。
import crypto from 'node:crypto';
import { FrameDecoder, encodeFrame, OP } from './codec.mjs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function reject(socket, status, text) {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    /* ignore */
  }
  socket.destroy();
}

export function attachWs(server, opts = {}) {
  const {
    path = '/ws',
    verify = () => ({}),
    onConnect = () => {},
    onMessage = () => {},
    onClose = () => {},
    maxPayload = 256 * 1024,
    heartbeatMs = 25000,
  } = opts;

  const conns = new Set();

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return reject(socket, 400, 'Bad Request');
    }
    if (url.pathname !== path) return reject(socket, 404, 'Not Found');

    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    if (!key || upgrade !== 'websocket') return reject(socket, 400, 'Bad Request');

    let ctx = null;
    try {
      ctx = verify(req);
    } catch {
      ctx = null;
    }
    if (!ctx) return reject(socket, 401, 'Unauthorized');

    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    socket.setTimeout(0);

    const decoder = new FrameDecoder({ maxPayload, requireMask: true });
    let closed = false;
    let finalized = false;

    // 只跑一次：清理连接并通知上层（心跳踢人、客户端断开、主动关闭都走这里）
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      closed = true;
      conns.delete(conn);
      try {
        onClose(conn);
      } catch (err) {
        console.error('[ws] onClose 异常', err);
      }
    };

    const conn = {
      id: crypto.randomUUID(),
      ip: String(socket.remoteAddress || '').replace(/^::ffff:/, ''),
      ctx,
      alive: true,
      pid: null,
      get closed() {
        return closed;
      },
      send(obj) {
        if (closed) return false;
        const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
        try {
          return socket.write(encodeFrame(OP.TEXT, Buffer.from(text, 'utf8')));
        } catch {
          return false;
        }
      },
      close(code = 1000, reason = '') {
        if (closed) return;
        closed = true;
        try {
          const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
          payload.writeUInt16BE(code, 0);
          payload.write(reason, 2, 'utf8');
          socket.write(encodeFrame(OP.CLOSE, payload));
        } catch {
          /* ignore */
        }
        setImmediate(() => socket.destroy());
        finalize();
      },
    };

    conns.add(conn);

    const handle = (frame) => {
      if (frame.opcode === OP.TEXT) {
        conn.alive = true;
        let msg;
        try {
          msg = JSON.parse(frame.payload.toString('utf8'));
        } catch {
          conn.send({ t: 'error', code: 'bad_json', msg: '消息格式错误' });
          return;
        }
        try {
          onMessage(conn, msg);
        } catch (err) {
          console.error('[ws] 处理消息异常', err);
          conn.send({ t: 'error', code: 'server_error', msg: '服务器处理失败' });
        }
      } else if (frame.opcode === OP.PING) {
        if (!closed) socket.write(encodeFrame(OP.PONG, frame.payload));
      } else if (frame.opcode === OP.PONG) {
        conn.alive = true;
      } else if (frame.opcode === OP.CLOSE) {
        conn.close(1000, '');
      }
    };

    socket.on('data', (chunk) => {
      try {
        for (const frame of decoder.push(chunk)) handle(frame);
      } catch (err) {
        console.warn(`[ws] ${conn.ip} 协议错误：${err.message}`);
        conn.close(1002, 'protocol error');
      }
    });

    socket.on('error', () => {});
    socket.on('close', () => {
      finalize();
    });

    try {
      onConnect(conn);
    } catch (err) {
      console.error('[ws] onConnect 异常', err);
      conn.close(1011, 'server error');
      return;
    }

    // 握手包可能已捎带首帧
    if (head && head.length) {
      try {
        for (const frame of decoder.push(head)) handle(frame);
      } catch {
        conn.close(1002, 'protocol error');
      }
    }
  });

  const hb = setInterval(() => {
    for (const conn of [...conns]) {
      if (!conn.alive) {
        conn.close(1001, 'heartbeat timeout');
        continue;
      }
      conn.alive = false;
      try {
        conn.send({ t: 'ping' });
      } catch {
        /* ignore */
      }
    }
  }, heartbeatMs);
  hb.unref?.();

  return {
    conns,
    closeAll() {
      clearInterval(hb);
      for (const conn of [...conns]) conn.close(1001, 'server shutdown');
    },
  };
}
