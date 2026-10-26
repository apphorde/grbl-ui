import { expect, request as requestFactory, test } from "@playwright/test";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const baseURL = "http://localhost:18433";
const issuer = "http://127.0.0.1:18432";
const machineId = "8d7e7cf3-377c-45c5-a5a9-13f748ae781b";
const clientId = "grbl-e2e-client";
const clientSecret = "test-client-secret";
const codes = new Map();
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "grbl-e2e-key", alg: "RS256", use: "sig" };
let appServer;
let providerServer;
let relayServer;
let claimedBy;
let providerLoggedOut = false;

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

function tokenFor(nonce) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iss: issuer, sub: "oidc-test-subject", aud: clientId, iat: now, exp: now + 300, nonce }),
  ).toString("base64url");
  const input = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
  return `${input}.${signature}`;
}

async function listen(server, port) {
  await new Promise((resolve) => server.listen(port, "0.0.0.0", resolve));
}

async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

test.beforeAll(async () => {
  providerServer = createServer(async (request, response) => {
    const url = new URL(request.url, issuer);
    if (url.pathname === "/.well-known/openid-configuration") {
      json(response, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        end_session_endpoint: `${issuer}/logout`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        grant_types_supported: ["authorization_code"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["openid", "profile"],
      });
      return;
    }
    if (url.pathname === "/jwks") {
      json(response, 200, { keys: [jwk] });
      return;
    }
    if (url.pathname === "/authorize") {
      if (providerLoggedOut) {
        response.writeHead(200, { "Content-Type": "text/html" }).end("Provider sign-in required");
        return;
      }
      const code = randomBytes(24).toString("base64url");
      codes.set(code, {
        nonce: url.searchParams.get("nonce"),
        challenge: url.searchParams.get("code_challenge"),
        redirectUri: url.searchParams.get("redirect_uri"),
        clientId: url.searchParams.get("client_id"),
      });
      const callback = new URL(url.searchParams.get("redirect_uri"));
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", url.searchParams.get("state"));
      response.writeHead(302, { Location: callback.href }).end();
      return;
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const form = new URLSearchParams(await bodyOf(request));
      const authorization = codes.get(form.get("code"));
      const challenge = createHash("sha256")
        .update(form.get("code_verifier") || "")
        .digest("base64url");
      if (
        !authorization ||
        form.get("client_id") !== clientId ||
        form.get("client_secret") !== clientSecret ||
        form.get("redirect_uri") !== authorization.redirectUri ||
        form.get("client_id") !== authorization.clientId ||
        challenge !== authorization.challenge
      ) {
        json(response, 400, { error: "invalid_grant" });
        return;
      }
      codes.delete(form.get("code"));
      json(response, 200, {
        access_token: "e2e-access-token",
        token_type: "Bearer",
        expires_in: 300,
        scope: "openid profile",
        id_token: tokenFor(authorization.nonce),
      });
      return;
    }
    if (url.pathname === "/logout") {
      providerLoggedOut = true;
      response.writeHead(302, { Location: url.searchParams.get("post_logout_redirect_uri") }).end();
      return;
    }
    response.writeHead(404).end();
  });
  relayServer = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.headers.authorization !== "Bearer relay-e2e-token") {
      response.writeHead(401).end();
      return;
    }
    if (url.pathname === "/_admin/machines" && request.method === "GET") {
      json(response, 200, [{ machineId, sessionId: machineId, claimedBy: claimedBy ?? null, online: true }]);
      return;
    }
    if (url.pathname === `/_admin/machines/${machineId}/claim` && request.method === "POST") {
      const payload = JSON.parse(await bodyOf(request));
      if (claimedBy && claimedBy !== payload.ownerSub) {
        response.writeHead(409).end();
        return;
      }
      claimedBy = payload.ownerSub;
      json(response, 200, { machineId, claimedBy });
      return;
    }
    if (url.pathname === `/_admin/machines/${machineId}/ticket` && request.method === "POST") {
      const payload = JSON.parse(await bodyOf(request));
      if (claimedBy !== payload.ownerSub) {
        response.writeHead(403).end();
        return;
      }
      json(response, 200, { ticket: "one-time-e2e-ticket", expiresIn: 60 });
      return;
    }
    response.writeHead(404).end();
  });
  await Promise.all([listen(providerServer, 18432), listen(relayServer, 18431)]);
  appServer = spawn(process.execPath, ["server.mjs"], {
    env: {
      ...process.env,
      PORT: "18433",
      APP_URL: baseURL,
      OIDC_ISSUER: issuer,
      OIDC_CLIENT_ID: clientId,
      OIDC_CLIENT_SECRET: clientSecret,
      RELAY_API_URL: "http://127.0.0.1:18431",
      RELAY_URL: "ws://127.0.0.1:18431",
      RELAY_API_TOKEN: "relay-e2e-token",
    },
    stdio: "ignore",
  });
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("UI server failed to start")), 10000);
    const poll = async () => {
      try {
        const response = await fetch(`${baseURL}/health`);
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

test.afterAll(async () => {
  appServer?.kill("SIGTERM");
  for (const server of [relayServer, providerServer]) {
    if (server?.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test("requires OIDC, binds callback to its browser, lists and claims connectors, and controls mock USB", async ({
  page,
  request,
}) => {
  const unauthorized = await request.get(baseURL, { maxRedirects: 0 });
  expect(unauthorized.status()).toBe(302);
  expect(new URL(unauthorized.headers().location, baseURL).pathname).toBe("/oidc/login");

  const loginRequest = await requestFactory.newContext({ baseURL });
  const loginStart = await loginRequest.get("/oidc/login", { maxRedirects: 0 });
  const state = new URL(loginStart.headers().location).searchParams.get("state");
  const otherBrowser = await requestFactory.newContext({ baseURL });
  const csrf = await otherBrowser.get(`/oidc/callback?code=attacker&state=${state}`, { maxRedirects: 0 });
  expect(csrf.status()).toBe(400);
  await loginRequest.dispose();
  await otherBrowser.dispose();

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
    class MockWebSocket extends EventTarget {
      static OPEN = 1;
      static CONNECTING = 0;
      static CLOSING = 2;
      static CLOSED = 3;

      constructor(url) {
        super();
        this.url = url;
        this.readyState = MockWebSocket.CONNECTING;
        this.sent = [];
        window.__relaySocket = this;
        setTimeout(() => {
          this.readyState = MockWebSocket.OPEN;
          this.dispatchEvent(new Event("open"));
        }, 0);
      }

      send(data) {
        this.sent.push(typeof data === "string" ? data : new TextDecoder().decode(data));
      }

      close() {
        this.readyState = MockWebSocket.CLOSED;
        this.dispatchEvent(new Event("close"));
      }
    }
    Object.defineProperty(window, "WebSocket", { value: MockWebSocket });
    window.__mockRelayMessage = (data) => window.__relaySocket.dispatchEvent(new MessageEvent("message", { data }));
  });
  const appResponse = await page.goto(baseURL);
  expect(await page.locator('meta[name="relay-ws"]').getAttribute("content")).toBe("ws://127.0.0.1:18431");
  expect(appResponse?.headers()["content-security-policy"]).toContain("connect-src 'self' ws://127.0.0.1:18431");
  await expect(page.locator("#machines")).toContainText(machineId);
  await page.getByRole("button", { name: "Claim" }).click();
  await expect(page.getByRole("button", { name: "Connect" })).toBeVisible();

  const machineButton = page.locator("#machines button");
  await machineButton.click();
  await expect.poll(() => page.evaluate(() => window.__relaySocket?.url)).toBe(`ws://127.0.0.1:18431/${machineId}`);
  await expect.poll(() => page.evaluate(() => window.__relaySocket?.sent?.[0])).toContain('"type":"authorize"');
  await expect(page.locator("#connection-label")).toHaveText("Disconnected");
  await page.evaluate(
    (id) => window.__mockRelayMessage(JSON.stringify({ type: "authorized", machineId: id })),
    machineId,
  );
  await expect(page.locator("#connection-label")).toHaveText("Connected");
  await expect.poll(() => page.evaluate(() => window.__relaySocket.sent)).toContain("?\n");
  await page.evaluate(() =>
    window.__mockRelayMessage("<Idle|MPos:10.000,20.000,3.000|WPos:1.000,2.000,3.000|Pn:XYZ>\r\n"),
  );
  await expect(page.locator("#machine-state")).toHaveText("Idle");
  await machineButton.click();
  await expect(page.locator("#connection-label")).toHaveText("Disconnected");

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
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:18432\/authorize/);
  await expect(page.locator("body")).toContainText("Provider sign-in required");
});
