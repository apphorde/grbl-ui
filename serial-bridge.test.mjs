import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import { createBridge, getMachineId, registerSocket } from "./serial-bridge.mjs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

class FakePort extends EventEmitter {
  isOpen = true;
  writes = [];

  write(data, callback) {
    this.writes.push(Buffer.from(data));
    callback?.();
  }

  close(callback) {
    this.isOpen = false;
    callback?.();
  }
}

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  sent = [];

  send(data, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    this.sent.push({ data: Buffer.from(data), options });
    callback?.();
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

test("registers only after matching acknowledgement", async () => {
  const socket = new FakeSocket();
  const id = "8d7e7cf3-377c-45c5-a5a9-13f748ae781b";
  const registered = registerSocket(socket, id);
  socket.emit("open");
  assert.deepEqual(JSON.parse(socket.sent[0].data.toString()), { type: "register", machineId: id });
  const didRegister = registered.then(
    () => true,
    () => false,
  );
  socket.emit("message", Buffer.from(JSON.stringify({ type: "registered", machineId: id, sessionId: "wrong" })), false);
  await assert.rejects(registered, /Relay registration failed/);
  assert.equal(await didRegister, false);
});

test("accepts a matching registration acknowledgement", async () => {
  const socket = new FakeSocket();
  const id = "8d7e7cf3-377c-45c5-a5a9-13f748ae781b";
  const registered = registerSocket(socket, id);
  socket.emit("open");
  socket.emit("message", Buffer.from(JSON.stringify({ type: "registered", machineId: id, sessionId: id })), false);
  await registered;
});

test("creates and reuses a persistent machine UUID", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-"));
  const path = join(dir, "nested", "id");
  try {
    const first = await getMachineId(path);
    assert.match(first, /^[0-9a-f-]{36}$/i);
    assert.equal(await getMachineId(path), first);
    assert.equal(await readFile(path, "utf8"), `${first}\n`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
