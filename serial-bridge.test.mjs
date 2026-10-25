import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import { createBridge } from "./serial-bridge.mjs";

class FakePort extends EventEmitter {
  isOpen = true;
  writes = [];

  write(data, callback) {
    this.writes.push(Buffer.from(data));
    callback();
  }

  close(callback) {
    this.isOpen = false;
    callback();
  }
}

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  sent = [];

  send(data, options, callback) {
    this.sent.push({ data: Buffer.from(data), options });
    callback();
  }

  close() {
    this.readyState = WebSocket.CLOSED;
  }
}

test("forwards serial as binary and preserves relay text and binary bytes", async () => {
  const port = new FakePort();
  const socket = new FakeSocket();
  const close = createBridge(port, socket);

  port.emit("data", Buffer.from([0x00, 0xff]));
  socket.emit("message", Buffer.from("G0 X1"), false);
  socket.emit("message", Buffer.from([0x00, 0xff]), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(socket.sent[0].data, Buffer.from([0x00, 0xff]));
  assert.equal(socket.sent[0].options.binary, true);
  assert.deepEqual(port.writes, [Buffer.from("G0 X1"), Buffer.from([0x00, 0xff])]);
  close();
  assert.equal(port.isOpen, false);
});

test("closes both ends when relay buffering exceeds the configured limit", () => {
  const port = new FakePort();
  const socket = new FakeSocket();
  socket.bufferedAmount = 11;
  const close = createBridge(port, socket, { maxBufferedBytes: 10 });

  port.emit("data", Buffer.from("x"));

  assert.equal(port.isOpen, false);
  assert.equal(socket.readyState, WebSocket.CLOSED);
  close();
});
