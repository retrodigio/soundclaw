// A small WebSocket server side (RFC 6455): the handshake, text frames out, and text, ping and
// close frames in. The watch view only needs JSON messages, so this avoids a dependency.

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Largest message accepted from a page. Pages only send small control messages. */
const MAX_IN = 1 << 20;

export class WsConnection {
  private readonly socket: Duplex;
  private buf = Buffer.alloc(0);
  private parts: Buffer[] = [];
  private closed = false;
  onmessage: (text: string) => void = () => {};
  onclose: () => void = () => {};

  constructor(socket: Duplex) {
    this.socket = socket;
    socket.on('data', (d: Buffer) => this.read(d));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }

  get open(): boolean {
    return !this.closed;
  }

  send(text: string): void {
    if (!this.closed) this.socket.write(frame(0x1, Buffer.from(text, 'utf8')));
  }

  close(code = 1000): void {
    if (this.closed) return;
    const body = Buffer.alloc(2);
    body.writeUInt16BE(code);
    this.socket.end(frame(0x8, body));
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.onclose();
  }

  private read(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0]!;
      const b1 = this.buf[1]!;
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_IN)) return this.close(1009);
        len = Number(big);
        off = 10;
      }
      // Clients must mask every frame (RFC 6455 §5.1).
      if (!masked) return this.close(1002);
      if (len > MAX_IN) return this.close(1009);
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i & 3]!;
      this.buf = this.buf.subarray(off + 4 + len);
      if (op === 0x8) return this.close();
      if (op === 0x9) { if (!this.closed) this.socket.write(frame(0xa, payload)); continue; }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x0) {
        this.parts.push(payload);
        if (this.parts.reduce((n, p) => n + p.length, 0) > MAX_IN) return this.close(1009);
        if (fin) {
          const text = Buffer.concat(this.parts).toString('utf8');
          this.parts = [];
          this.onmessage(text);
        }
        continue;
      }
      return this.close(1003);
    }
  }
}

function frame(op: number, payload: Buffer): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  if (n >= 126 && n < 65536) {
    head[0] = 0x80 | op;
    head[1] = 126;
    head.writeUInt16BE(n, 2);
  } else if (n >= 65536) {
    head[0] = 0x80 | op;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, payload]);
}

/** Complete the handshake for an upgrade request; null (and the socket closed) if it isn't a valid one. */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex): WsConnection | null {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
  if (upgrade !== 'websocket' || typeof key !== 'string' || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  return new WsConnection(socket);
}
