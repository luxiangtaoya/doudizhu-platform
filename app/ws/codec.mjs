// 极简 RFC6455 帧编解码。
// 只实现本项目需要的部分：文本帧、分片、ping/pong、close。
// 自己实现而不是引 ws，是为了让交付物真正做到「零 npm 依赖」。
import crypto from 'node:crypto';

export const OP = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

export function encodeFrame(opcode, payload = Buffer.alloc(0), { mask = false } = {}) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN=1, RSV=0

  if (!mask) return Buffer.concat([header, payload]);

  header[1] |= 0x80;
  const key = crypto.randomBytes(4);
  const body = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ key[i & 3];
  return Buffer.concat([header, key, body]);
}

export function encodeText(str, opts) {
  return encodeFrame(OP.TEXT, Buffer.from(str, 'utf8'), opts);
}

/**
 * 增量解码器。服务端要求客户端帧必须带 mask。
 * push(chunk) 返回已完成的 { opcode, payload } 列表。
 */
export class FrameDecoder {
  constructor({ maxPayload = 1 << 20, requireMask = true } = {}) {
    this.buf = Buffer.alloc(0);
    this.maxPayload = maxPayload;
    this.requireMask = requireMask;
    this.frag = null;
    this.fragOpcode = 0;
  }

  push(chunk) {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const frames = [];
    for (;;) {
      const res = this._next();
      if (res === null) break; // 数据不够
      if (res.frame) frames.push(res.frame);
    }
    return frames;
  }

  _next() {
    const b = this.buf;
    if (b.length < 2) return null;

    const b0 = b[0];
    const b1 = b[1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;

    if (rsv !== 0) throw new Error('未协商的扩展位');
    if (this.requireMask && !masked) throw new Error('客户端帧未按协议加掩码');

    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('帧长度非法');
      len = Number(big);
      off = 10;
    }
    if (len > this.maxPayload) throw new Error('帧超过上限');

    const need = off + (masked ? 4 : 0) + len;
    if (b.length < need) return null;

    let key = null;
    if (masked) {
      key = b.subarray(off, off + 4);
      off += 4;
    }
    const payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) {
      payload[i] = key ? b[off + i] ^ key[i & 3] : b[off + i];
    }
    this.buf = b.subarray(off + len);

    return { frame: this._assemble(fin, opcode, payload) };
  }

  _assemble(fin, opcode, payload) {
    // 控制帧：不能分片，长度 ≤125
    if (opcode >= 0x8) {
      if (!fin) throw new Error('控制帧不可分片');
      if (payload.length > 125) throw new Error('控制帧过长');
      return { opcode, payload };
    }

    if (opcode === OP.CONTINUATION) {
      if (!this.frag) throw new Error('意外的续帧');
      this.frag = Buffer.concat([this.frag, payload]);
      if (this.frag.length > this.maxPayload) throw new Error('分片消息超过上限');
      if (!fin) return null; // 仍在收集中，但字节已消费
      const frame = { opcode: this.fragOpcode, payload: this.frag };
      this.frag = null;
      return frame;
    }

    if (opcode === OP.TEXT || opcode === OP.BINARY) {
      if (this.frag) throw new Error('分片消息未结束就开启新消息');
      if (fin) return { opcode, payload };
      this.frag = payload;
      this.fragOpcode = opcode;
      return null;
    }

    throw new Error(`未知 opcode ${opcode}`);
  }
}
