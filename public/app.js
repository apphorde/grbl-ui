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

async function connectRelay(machineId, button) {
  if (connected && relaySocket) {
    await disconnect();
    button.textContent = "Connect";
    return;
  }
  if (connected) {
    await disconnect();
  }
  button.disabled = true;
  try {
    const ticketResponse = await fetch(`/api/machines/${encodeURIComponent(machineId)}/ticket`, { method: "POST" });
    if (!ticketResponse.ok) {
      throw new Error("Could not obtain connection ticket");
    }
    const { ticket } = await ticketResponse.json();
    const configuredRelay = document.querySelector('meta[name="relay-ws"]')?.content;
    if (!configuredRelay) {
      throw new Error("Remote relay is not configured.");
    }
    const socket = new WebSocket(`${configuredRelay.replace(/\/$/, "")}/${encodeURIComponent(machineId)}`);
    relaySocket = socket;
    socket.binaryType = "arraybuffer";
    let authorized = false;
    let authorizationTimer;
    socket.addEventListener(
      "open",
      () => {
        socket.send(JSON.stringify({ type: "authorize", ticket }));
        authorizationTimer = setTimeout(() => socket.close(), 4000);
      },
      { once: true },
    );
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        try {
          const control = JSON.parse(event.data);
          if (control.type === "authorized" && control.machineId === machineId) {
            authorized = true;
            clearTimeout(authorizationTimer);
            setConnected(true);
            button.textContent = "Disconnect";
            button.disabled = false;
            addLog("Connected to remote machine.");
            write("?");
            polling = setInterval(() => {
              write("?");
            }, 500);
            return;
          }
        } catch {
          /* GRBL frames are plain text, not JSON control messages. */
        }
      }
      if (!authorized) {
        return;
      }
      const bytes = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
      buffer += bytes;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      lines.filter(Boolean).forEach(parseLine);
    });
    socket.addEventListener("close", () => {
      clearTimeout(authorizationTimer);
      if (relaySocket === socket) {
        relaySocket = undefined;
        clearInterval(polling);
        setConnected(false);
        button.textContent = "Connect";
      }
      button.disabled = false;
    });
    socket.addEventListener("error", () => addLog("WebSocket relay connection failed.", "error"), { once: true });
  } catch (error) {
    addLog(error.message, "error");
    button.disabled = false;
  }
}

async function loadMachines() {
  const container = $("#machines");
  try {
    const response = await fetch("/api/machines");
    if (response.status === 401) {
      location.assign("/oidc/login");
      return;
    }
    if (!response.ok) {
      throw new Error("Could not load machines");
    }
    const machines = await response.json();
    container.replaceChildren();
    if (!machines.length) {
      container.textContent = "No available bridge connectors.";
      return;
    }
    for (const machine of machines) {
      const card = document.createElement("article");
      card.className = "machine-card";
      const label = document.createElement("span");
      label.textContent = `${machine.uuid} · ${machine.status}`;
      const button = document.createElement("button");
      button.className = machine.claimed ? "primary" : "secondary";
      button.textContent = machine.claimed ? "Connect" : "Claim";
      button.addEventListener("click", async () => {
        if (!machine.claimed) {
          button.disabled = true;
          const claim = await fetch(`/api/machines/${encodeURIComponent(machine.uuid)}/claim`, { method: "POST" });
          if (!claim.ok) {
            addLog("Claim failed; machine may belong to another account.", "error");
            button.disabled = false;
            return;
          }
          machine.claimed = true;
          button.textContent = "Connect";
          button.className = "primary";
          button.disabled = false;
        } else {
          connectRelay(machine.uuid, button);
        }
      });
      card.append(label, button);
      container.append(card);
    }
  } catch (error) {
    container.textContent = error.message;
  }
}

function stopJog() {
  clearTimeout(jogTimer);
  if (connected) {
    write("!");
  }
}

$("#connect").addEventListener("click", connect);
$("#logout").addEventListener("click", async () => {
  const response = await fetch("/api/logout", { method: "POST" });
  if (response.ok) {
    const { logoutUrl } = await response.json();
    location.assign(logoutUrl);
  } else {
    addLog("Sign-out failed. Please retry.", "error");
  }
});
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
loadMachines();
