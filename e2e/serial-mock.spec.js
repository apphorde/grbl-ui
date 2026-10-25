import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";

let server;
const baseURL = "http://127.0.0.1:18433";

test.beforeAll(async () => {
  server = spawn(process.execPath, ["server.mjs"], { env: { ...process.env, PORT: "18433" }, stdio: "ignore" });
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("UI server failed to start")), 5000);
    const poll = async () => {
      try {
        const response = await fetch(baseURL);
        if (response.ok) {
          clearTimeout(deadline);
          resolve();
          return;
        }
      } catch {
        /* Wait for startup. */
      }
      setTimeout(poll, 100);
    };
    poll();
  });
});

test.afterAll(() => {
  server?.kill("SIGTERM");
});

test("connects to mock Web Serial, sends GRBL commands and displays status", async ({ page }) => {
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.addInitScript(() => {
    window.__writes = [];
    let controller;
    const readable = new ReadableStream({
      start(value) {
        controller = value;
      },
    });
    const port = {
      readable,
      writable: new WritableStream({
        write(chunk) {
          window.__writes.push(new TextDecoder().decode(chunk));
        },
      }),
      async open(options) {
        window.__baud = options.baudRate;
      },
      async close() {},
      async getInfo() {
        return {};
      },
    };
    Object.defineProperty(navigator, "serial", {
      value: {
        async requestPort() {
          return port;
        },
        addEventListener() {},
      },
    });
    window.__mockRespond = (line) => controller.enqueue(new TextEncoder().encode(`${line}\r\n`));
  });
  await page.goto(baseURL);
  await page.getByRole("button", { name: "Connect USB" }).click();
  await expect(page.locator("#connection-label")).toHaveText("Connected");
  expect(await page.evaluate(() => window.__baud)).toBe(115200);
  await expect.poll(() => page.evaluate(() => window.__writes)).toContain("?\n");
  await page.evaluate(() => window.__mockRespond("<Idle|MPos:10.000,20.000,3.000|WPos:1.000,2.000,3.000|Pn:XYZ>"));
  await expect(page.locator("#machine-state")).toHaveText("Idle");
  await expect(page.locator("#pos-x")).toHaveText("1.000");
  await expect(page.locator("#pins")).toHaveText("XYZ");
  await page.getByRole("button", { name: "Unlock alarm ($X)" }).click();
  await expect.poll(() => page.evaluate(() => window.__writes)).toContain("$X\n");
  await page.getByRole("button", { name: "Jog Y positive" }).dispatchEvent("pointerdown", { pointerId: 1 });
  await expect.poll(() => page.evaluate(() => window.__writes.join(""))).toContain("$J=G91 G21 Y1 F1000\n");
  expect(browserErrors).toEqual([]);
});
