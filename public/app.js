const $ = (selector) => document.querySelector(selector);
const log = $("#log");
let port;
let reader;
let writer;
let connected = false;
let relaySocket;
let polling;
let buffer = "";
let jogTimer;

function addLog(text, type = "") {
  const line = document.createElement("div");
  line.className = `log-line ${type}`;
  line.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  log.prepend(line);
  while (log.children.length > 80) {
    log.lastElementChild.remove();
  }
}

function setConnected(value) {
  connected = value;
  $("#led").classList.toggle("on", value);
  $("#connection-label").textContent = value ? "Connected" : "Disconnected";
  $("#connect").textContent = value && !relaySocket ? "Disconnect" : "Connect USB";
  $("#machine-state").textContent = value ? "Ready" : "Not connected";
}

async function write(command) {
  if (!connected || (!writer && relaySocket?.readyState !== WebSocket.OPEN)) {
    addLog("Connect to a machine first.", "error");
    return false;
  }
  try {
    const bytes = new TextEncoder().encode(`${command}\n`);
    if (relaySocket?.readyState === WebSocket.OPEN) {
      relaySocket.send(bytes);
    } else {
      await writer.write(bytes);
    }
    addLog(`> ${command}`, "sent");
    return true;
  } catch (error) {
    addLog(`Write failed: ${error.message}`, "error");
    return false;
  }
}

function parseLine(line) {
  if (line.startsWith("<") && line.endsWith(">")) {
    const state = line.slice(1, -1).split("|");
    $("#machine-state").textContent = state[0] ?? "Unknown";
    for (const item of state.slice(1)) {
      const [key, value] = item.split(":");
      if (key === "WPos" || key === "MPos") {
        const coords = value.split(",");
        if (key === "WPos") {
          ["x", "y", "z"].forEach((axis, index) => {
            $(`#pos-${axis}`).textContent = coords[index] ?? "—";
          });
        }
        if (key === "MPos") {
          $("#machine-pos").textContent = `MPos ${coords.join(", ")}`;
        }
      }
      if (key === "WCO") {
        $("#machine-pos").textContent += ` · WCO ${value}`;
      }
      if (key === "Pn") {
        $("#pins").textContent = value || "none";
      }
    }
  }
  addLog(line, line.startsWith("error:") || line === "ALARM" ? "error" : "");
}

async function readLoop() {
  const decoder = new TextDecoder();
  try {
    while (connected) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      lines.filter(Boolean).forEach(parseLine);
    }
  } catch (error) {
    if (connected) {
      addLog(`Serial read failed: ${error.message}`, "error");
    }
  } finally {
    if (connected) {
      await disconnect();
    }
  }
}

async function disconnect() {
  if (!connected) {
    return;
  }
  setConnected(false);
  if (relaySocket) {
    relaySocket.close();
    relaySocket = undefined;
  }
  clearInterval(polling);
  clearTimeout(jogTimer);
  try {
    await reader?.cancel();
  } catch {
    /* Port may already have closed. */
  }
  try {
    await port?.close();
  } catch {
    /* Port may already have closed. */
  }
  reader = undefined;
  writer = undefined;
  port = undefined;
}

async function connect() {
  if (connected) {
    await disconnect();
    return;
  }
  if (!("serial" in navigator)) {
    addLog("Web Serial is unavailable. Use Chrome or Edge in a secure context (HTTPS or localhost).", "error");
    return;
  }
  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });
    reader = port.readable.getReader();
    writer = port.writable.getWriter();
    setConnected(true);
    addLog("Serial connected at 115200 baud.");
    readLoop();
    await write("?");
    polling = setInterval(() => {
      write("?");
    }, 500);
  } catch (error) {
    addLog(`Connection failed: ${error.message}`, "error");
    await disconnect();
  }
}

function newSessionId() {
  $("#session-id").value = crypto.randomUUID();
  updateBridgeCommand();
}

function updateBridgeCommand() {
  const id = $("#session-id").value.trim();
  $("#bridge-command").textContent =
    `RELAY_URL=wss://ws.api.apphor.de/${id} SERIAL_PORT=/dev/ttyUSB0 npm run serial-bridge`;
}

function connectRelay() {
  if (connected) {
    disconnect();
    return;
  }
  const sessionId = $("#session-id").value.trim();
  if (!sessionId || /[/?#\s]/.test(sessionId)) {
    addLog("Enter a valid relay session ID.", "error");
    return;
  }
  relaySocket = new WebSocket(`wss://ws.api.apphor.de/${encodeURIComponent(sessionId)}`);
  relaySocket.binaryType = "arraybuffer";
  relaySocket.addEventListener(
    "open",
    () => {
      setConnected(true);
      $("#connect-relay").textContent = "Disconnect relay";
      addLog(`Connected to relay session ${sessionId}.`);
      write("?");
      polling = setInterval(() => {
        write("?");
      }, 500);
    },
    { once: true },
  );
  relaySocket.addEventListener("message", (event) => {
    const bytes = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
    buffer += bytes;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    lines.filter(Boolean).forEach(parseLine);
  });
  relaySocket.addEventListener("close", () => {
    if (relaySocket) {
      relaySocket = undefined;
    }
    clearInterval(polling);
    setConnected(false);
    $("#connect-relay").textContent = "Connect relay";
  });
  relaySocket.addEventListener("error", () => addLog("WebSocket relay connection failed.", "error"), { once: true });
}

function stopJog() {
  clearTimeout(jogTimer);
  if (connected) {
    write("!");
  }
}

$("#connect").addEventListener("click", connect);
$("#connect-relay").addEventListener("click", connectRelay);
$("#new-session").addEventListener("click", newSessionId);
$("#session-id").addEventListener("input", updateBridgeCommand);
$("#poll").addEventListener("click", () => write("?"));
$("#unlock").addEventListener("click", () => write("$X"));
$("#clear-log").addEventListener("click", () => {
  log.replaceChildren();
});
$("#command-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#command");
  const command = input.value.trim();
  if (command && (await write(command))) {
    input.value = "";
  }
});
document.querySelectorAll(".jog[data-axis]").forEach((button) => {
  button.addEventListener("pointerdown", async (event) => {
    event.preventDefault();
    if (!connected) {
      addLog("Connect to a machine first.", "error");
      return;
    }
    button.setPointerCapture(event.pointerId);
    const axis = button.dataset.axis;
    const distance = Number($("#step").value) * Number(button.dataset.dir);
    const feed = Math.max(1, Math.min(20000, Number($("#feed").value) || 1000));
    const sent = await write(`$J=G91 G21 ${axis}${distance} F${feed}`);
    if (sent) {
      clearTimeout(jogTimer);
      jogTimer = setTimeout(stopJog, 750);
    }
  });
  button.addEventListener("pointerup", stopJog);
  button.addEventListener("pointercancel", stopJog);
  button.addEventListener("lostpointercapture", stopJog);
});
navigator.serial?.addEventListener("disconnect", (event) => {
  if (event.target === port) {
    addLog("USB serial device disconnected.", "error");
    disconnect();
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && connected) {
    addLog("Page hidden. Polling continues; close the tab or disconnect to stop.");
  }
});
newSessionId();
