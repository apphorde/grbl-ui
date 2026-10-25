import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { SerialPort } from "serialport";
import WebSocket from "ws";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BUFFERED_BYTES = 1024 * 1024;

export async function getMachineId(path, uuid = randomUUID()) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (!UUID.test(existing)) {
      throw new Error("MACHINE_ID_PATH does not contain a valid UUID");
    }
    return existing;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  if (!UUID.test(uuid)) {
    throw new Error("Generated machine ID is not a valid UUID");
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  let fileClosed = false;
  try {
    await file.writeFile(`${uuid}\n`);
    await file.sync();
    await file.close();
    fileClosed = true;
    try {
      await rename(temporary, path);
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      await rm(temporary, { force: true });
      return getMachineId(path);
    }
  } catch (error) {
    if (!fileClosed) {
      await file.close().catch(() => {});
    }
    await rm(temporary, { force: true });
    throw error;
  }
  return uuid;
}

export function createBridge(port, socket, { maxBufferedBytes = MAX_BUFFERED_BYTES, onClose = () => {} } = {}) {
  let closed = false;
  let writeQueue = Promise.resolve();
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    } catch {
      /* Already closing. */
    }
    if (port.isOpen) {
      port.close(() => {});
    }
    onClose();
  };
  port.on("data", (chunk) => {
    if (closed || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (socket.bufferedAmount > maxBufferedBytes) {
      console.error("Relay backpressure limit exceeded; closing bridge.");
      close();
      return;
    }
    socket.send(chunk, { binary: true }, (error) => {
      if (error) {
        console.error("Relay send failed; closing bridge.");
        close();
      }
    });
  });
  port.on("error", () => {
    console.error("Serial port error; closing bridge.");
    close();
  });
  port.on("close", close);
  socket.on("message", (data, isBinary) => {
    if (closed) {
      return;
    }
    const bytes = isBinary ? Buffer.from(data) : Buffer.from(data.toString(), "utf8");
    writeQueue = writeQueue
      .then(
        () =>
          new Promise((resolve, reject) => {
            if (!port.isOpen || closed) {
              resolve();
              return;
            }
            port.write(bytes, (error) => (error ? reject(error) : resolve()));
          }),
      )
      .catch(() => {
        console.error("Serial write failed; closing bridge.");
        close();
      });
  });
  socket.on("close", close);
  socket.on("error", () => {
    console.error("Relay connection error; closing bridge.");
    close();
  });
  return close;
}

export function registerSocket(socket, machineId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("open", onOpen);
      socket.off("message", onMessage);
      socket.off("error", onFailure);
      socket.off("close", onFailure);
    };
    const fail = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      socket.close();
      reject(new Error("Relay registration failed"));
    };
    const onFailure = () => fail();
    const onMessage = (data, isBinary) => {
      if (isBinary) {
        fail();
        return;
      }
      let acknowledgement;
      try {
        acknowledgement = JSON.parse(data.toString());
      } catch {
        fail();
        return;
      }
      if (
        acknowledgement?.type !== "registered" ||
        acknowledgement.machineId !== machineId ||
        acknowledgement.sessionId !== machineId
      ) {
        fail();
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };
    const onOpen = () => {
      socket.send(JSON.stringify({ type: "register", machineId }), (error) => {
        if (error) {
          fail();
        }
      });
    };
    const timer = setTimeout(fail, 5000);
    socket.once("error", onFailure);
    socket.once("close", onFailure);
    socket.once("open", onOpen);
    socket.once("message", onMessage);
  });
}

export async function startBridge({ socket, port, machineId }) {
  await new Promise((resolve, reject) => port.open((error) => (error ? reject(error) : resolve())));
  try {
    await registerSocket(socket, machineId);
  } catch (error) {
    if (port.isOpen) {
      await new Promise((resolve) => port.close(resolve));
    }
    throw error;
  }
  return createBridge(port, socket);
}

async function main() {
  const token = process.env.BRIDGE_REGISTRATION_TOKEN?.trim();
  if (!token) {
    throw new Error("Missing required environment variable BRIDGE_REGISTRATION_TOKEN");
  }
  const relayAddress = process.env.RELAY_URL?.trim() || "wss://ws.api.apphor.de";
  const serialPath = process.env.SERIAL_PORT?.trim();
  if (!serialPath) {
    throw new Error("Missing required environment variable SERIAL_PORT");
  }
  const baudRate = Number(process.env.BAUD_RATE ?? 115200);
  if (!Number.isInteger(baudRate) || baudRate <= 0) {
    throw new Error("BAUD_RATE must be a positive integer");
  }
  const relayUrl = new URL(relayAddress);
  if (!["ws:", "wss:"].includes(relayUrl.protocol)) {
    throw new Error("RELAY_URL must use ws:// or wss://");
  }
  relayUrl.pathname = "/bridge/register";
  relayUrl.search = "";
  const machineId = await getMachineId(process.env.MACHINE_ID_PATH || "/var/lib/grbl-bridge/machine-id");
  const socket = new WebSocket(relayUrl, { headers: { Authorization: `Bearer ${token}` } });
  const port = new SerialPort({ path: serialPath, baudRate, autoOpen: false });
  let closeBridge = () => socket.close();
  const shutdown = () => closeBridge();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    closeBridge = await startBridge({ socket, port, machineId });
  } catch (error) {
    socket.close();
    if (port.isOpen) {
      await new Promise((resolve) => port.close(resolve));
    }
    throw error;
  }
  console.log(`Serial bridge registered at ${baudRate} baud.`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
