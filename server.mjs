import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as oidc from "openid-client";
import { randomBytes } from "node:crypto";

const root = fileURLToPath(new URL("./public/", import.meta.url));
const publicRoot = resolve(root);
const sessions = new Map();
const pending = new Map();
const maxAge = 8 * 60 * 60 * 1000;
const cookieName = "grbl_session";
const transactionCookieName = "grbl_oidc_state";
const issuer = process.env.OIDC_ISSUER;
const clientId = process.env.OIDC_CLIENT_ID;
const clientSecret = process.env.OIDC_CLIENT_SECRET;
function configuredUrl(value, protocols, requireOrigin = false) {
  if (!value?.trim()) {
    return undefined;
  }
  try {
    const url = new URL(value.trim());
    if (
      !protocols.includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (requireOrigin && url.pathname !== "/")
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

let appUrl;
const isLoopback = (hostname) => hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
try {
  const configuredAppUrl = new URL(process.env.APP_URL);
  if (
    (configuredAppUrl.protocol !== "https:" && !isLoopback(configuredAppUrl.hostname)) ||
    configuredAppUrl.username ||
    configuredAppUrl.password ||
    configuredAppUrl.pathname !== "/" ||
    configuredAppUrl.search ||
    configuredAppUrl.hash
  ) {
    throw new Error("APP_URL must be an HTTPS origin without path, query, or credentials");
  }
  appUrl = configuredAppUrl.origin;
} catch {
  appUrl = undefined;
}
const relayApiUrl = configuredUrl(process.env.RELAY_API_URL, ["http:", "https:"]);
const relayApi = relayApiUrl?.href.replace(/\/$/, "");
const relayWsOrigin = configuredUrl(process.env.RELAY_URL, ["ws:", "wss:"], true)?.origin;
let oidcConfig;
let configError;
if (issuer && clientId && clientSecret && appUrl) {
  try {
    const issuerUrl = new URL(issuer);
    const localOidc = issuerUrl.protocol === "http:" && isLoopback(issuerUrl.hostname);
    oidcConfig = await oidc.discovery(
      issuerUrl,
      clientId,
      clientSecret,
      undefined,
      localOidc ? { execute: [oidc.allowInsecureRequests] } : undefined,
    );
  } catch {
    configError = "OIDC discovery failed";
  }
} else {
  configError = "OIDC configuration missing";
}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

function sessionFor(request) {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expires <= now) {
      sessions.delete(id);
    }
  }
  const cookie = request.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`));
  const session = cookie && sessions.get(cookie.slice(cookieName.length + 1));
  if (!session || session.expires <= now) {
    return undefined;
  }
  return session;
}

async function relay(path, method, payload) {
  if (!relayApi || !process.env.RELAY_API_TOKEN) {
    throw new Error("Relay unavailable");
  }
  const response = await fetch(`${relayApi}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.RELAY_API_TOKEN}`,
      ...(payload ? { "Content-Type": "application/json" } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await response.text();
  let result;
  try {
    result = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("Relay returned invalid data");
  }
  if (!response.ok) {
    const error = new Error("Relay request failed");
    error.status = response.status;
    throw error;
  }
  return result;
}

const server = createServer(async (request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "serial=(self)");
  response.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'${relayWsOrigin ? ` ${relayWsOrigin}` : ""}; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'`,
  );
  if (appUrl?.startsWith("https://")) {
    response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  const url = new URL(request.url, appUrl ?? "http://localhost");
  if (url.pathname === "/health") {
    const ready = !configError && Boolean(relayApi && relayWsOrigin && process.env.RELAY_API_TOKEN);
    json(response, ready ? 200 : 503, { ready });
    return;
  }
  if (url.pathname === "/oidc/login" && request.method === "GET") {
    if (configError) {
      response.writeHead(503).end("Authentication unavailable");
      return;
    }
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const verifier = oidc.randomPKCECodeVerifier();
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    const now = Date.now();
    for (const [key, value] of pending) {
      if (value.expires <= now) {
        pending.delete(key);
      }
    }
    if (pending.size >= 2048) {
      response.writeHead(503).end("Authentication temporarily unavailable");
      return;
    }
    pending.set(state, { nonce, verifier, expires: now + 5 * 60_000 });
    const authorizationUrl = oidc.buildAuthorizationUrl(oidcConfig, {
      redirect_uri: `${appUrl.replace(/\/$/, "")}/oidc/callback`,
      scope: "openid profile",
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    response
      .writeHead(302, {
        Location: authorizationUrl.href,
        "Set-Cookie": `${transactionCookieName}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`,
        "Cache-Control": "no-store",
      })
      .end();
    return;
  }
  if (url.pathname === "/oidc/callback" && request.method === "GET") {
    if (configError) {
      response.writeHead(503).end("Authentication unavailable");
      return;
    }
    const state = url.searchParams.get("state");
    const cookieState = request.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${transactionCookieName}=`))
      ?.slice(transactionCookieName.length + 1);
    const transaction = state && pending.get(state);
    if (!state || state !== cookieState || !transaction || transaction.expires < Date.now()) {
      response
        .writeHead(400, {
          "Set-Cookie": `${transactionCookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
          "Cache-Control": "no-store",
        })
        .end("Invalid login response");
      return;
    }
    pending.delete(state);
    try {
      const tokens = await oidc.authorizationCodeGrant(oidcConfig, new URL(request.url, appUrl), {
        pkceCodeVerifier: transaction.verifier,
        expectedState: state,
        expectedNonce: transaction.nonce,
      });
      const claims = tokens.claims();
      if (!claims?.sub) {
        throw new Error("Missing subject");
      }
      const id = randomBytes(32).toString("base64url");
      sessions.set(id, { sub: claims.sub, expires: Date.now() + maxAge });
      response
        .writeHead(303, {
          Location: "/",
          "Set-Cookie": [
            `${cookieName}=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge / 1000}`,
            `${transactionCookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
          ],
          "Cache-Control": "no-store",
        })
        .end();
    } catch {
      response
        .writeHead(400, {
          "Set-Cookie": `${transactionCookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
          "Cache-Control": "no-store",
        })
        .end("Login failed");
    }
    return;
  }
  if (url.pathname === "/api/logout" && request.method === "POST") {
    const session = sessionFor(request);
    if (!session) {
      json(response, 401, { error: "Unauthorized" });
      return;
    }
    if (request.headers.origin !== appUrl) {
      json(response, 403, { error: "Invalid origin" });
      return;
    }
    const cookie = request.headers.cookie?.match(new RegExp(`${cookieName}=([^;]+)`))?.[1];
    if (cookie) {
      sessions.delete(cookie);
    }
    const logoutUrl = new URL(oidcConfig.serverMetadata().end_session_endpoint);
    logoutUrl.searchParams.set("client_id", clientId);
    logoutUrl.searchParams.set("post_logout_redirect_uri", `${appUrl}/`);
    response
      .writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
        "Cache-Control": "no-store",
      })
      .end(JSON.stringify({ logoutUrl: logoutUrl.href }));
    return;
  }
  const session = sessionFor(request);
  if (!session) {
    response.writeHead(302, { Location: "/oidc/login" }).end();
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    if (!["GET", "HEAD"].includes(request.method) && request.headers.origin !== appUrl) {
      json(response, 403, { error: "Invalid origin" });
      return;
    }
    try {
      if (url.pathname === "/api/machines" && request.method === "GET") {
        const result = await relay("/_admin/machines", "GET");
        const machines = Array.isArray(result) ? result : result.machines;
        json(
          response,
          200,
          (machines ?? [])
            .filter((machine) => {
              const owner = machine.ownerSub ?? machine.claimedBy;
              return !owner || owner === session.sub;
            })
            .map(({ uuid, machineId, status, online, ownerSub, claimedBy }) => ({
              uuid: uuid ?? machineId,
              status: status ?? (online ? "online" : "offline"),
              claimed: Boolean(ownerSub ?? claimedBy),
            })),
        );
        return;
      }
      const match = url.pathname.match(/^\/api\/machines\/([0-9a-f-]{36})\/(claim|ticket)$/i);
      if (match && request.method === "POST") {
        const [, id, action] = match;
        const result = await relay(`/_admin/machines/${encodeURIComponent(id)}/${action}`, "POST", {
          ownerSub: session.sub,
        });
        json(response, 200, result);
        return;
      }
      json(response, 404, { error: "Not found" });
    } catch (error) {
      json(response, error.status === 409 ? 409 : 502, {
        error: error.status === 409 ? "Machine already claimed" : "Relay unavailable",
      });
    }
    return;
  }
  const path = resolve(publicRoot, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
  if (path !== publicRoot && !path.startsWith(`${publicRoot}${sep}`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    let body;
    if (path === resolve(publicRoot, "index.html")) {
      const html = await readFile(path, "utf8");
      body = Buffer.from(
        html.replace('name="relay-ws" content=""', `name="relay-ws" content="${relayWsOrigin ?? ""}"`),
      );
    } else {
      body = await readFile(path);
    }
    response.writeHead(200, {
      "Content-Type":
        {
          ".html": "text/html; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".svg": "image/svg+xml",
        }[extname(path)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(body);
  } catch {
    response.writeHead(404).end("Not found");
  }
});

server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0", () =>
  console.log(`GRBL UI listening on ${server.address().port}`),
);
