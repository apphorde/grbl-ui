import { SerialPort } from "serialport";
import WebSocket from "ws";

const MAX_BUFFERED_BYTES = 1024 * 1024;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
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
      /* Socket may already be closing. */
    }
    if (port.isOpen) {
      port.close(() => {});
    }
    onClose();
  };

  const forwardSerial = (chunk) => {
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
  };

  port.on("data", forwardSerial);
  port.on("error", () => {
    console.error("Serial port error; closing bridge.");
    close();
  });
  port.on("close", close);
  socket.on("message", (data, isBinary) => {
    if (closed) {
      return;
    }
    // Preserve relay text frames as UTF-8 and binary frames byte-for-byte.
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

async function main() {
  const relayAddress = required("RELAY_URL");
  const serialPath = required("SERIAL_PORT");
  const baudRate = Number(process.env.BAUD_RATE ?? 115200);
  const relayUrl = new URL(relayAddress);
  if (!["ws:", "wss:"].includes(relayUrl.protocol)) {
    throw new Error("RELAY_URL must use ws:// or wss://");
  }
  if (!Number.isInteger(baudRate) || baudRate <= 0) {
    throw new Error("BAUD_RATE must be a positive integer");
  }

  const socket = new WebSocket(relayUrl);
  const port = new SerialPort({ path: serialPath, baudRate, autoOpen: false });
  let closeBridge = () => {};
  const shutdown = () => closeBridge();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  socket.once("open", () => {
    port.open((error) => {
      if (error) {
        console.error("Unable to open serial port; closing bridge.");
        socket.close();
        return;
      }
      closeBridge = createBridge(port, socket);
      console.log(`Serial bridge connected at ${baudRate} baud.`);
    });
  });
  socket.once("error", () => {
    console.error("Unable to connect to relay.");
    if (port.isOpen) {
      port.close(() => {});
    }
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
