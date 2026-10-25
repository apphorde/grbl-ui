# GRBL Jog

Mobile-friendly GRBL control UI with local Web Serial and authenticated remote bridge connectors. The server protects all UI and API routes with OIDC; remote controls are never available through an unauthenticated room ID.

## Configuration and run

Required environment variables: `OIDC_ISSUER` (issuer URL), `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and `APP_URL` (public origin, for example `https://grbl.example.com`, with no trailing slash). Register the exact redirect URI `${APP_URL}/oidc/callback` with the provider. Set `RELAY_API_TOKEN` to a server-side admin token; `RELAY_API_URL` optionally overrides the default `https://ws.api.apphor.de`. Do not put relay credentials in browser configuration. Without OIDC configuration the UI fails closed; `/health` reports readiness only.

```sh
npm install
npm start
```

The server uses `openid-client` v6 authorization-code PKCE, state/nonce validation and library token validation. Sessions are opaque, in-memory, HttpOnly, Secure, SameSite=Lax cookies, expiring within eight hours. Logout clears the local session. Mutating endpoints require same-origin `Origin`.

## Relay contract

`GET /api/machines` lists only unclaimed machines and machines owned by the authenticated OIDC `sub`; records owned by other accounts and their UUIDs are omitted. `POST /api/machines/{uuid}/claim` makes an immutable one-time claim; `POST /api/machines/{uuid}/ticket` issues a one-time short-lived (at most 60 seconds) ticket. Both derive `ownerSub` from the session. The UI connects to `wss://ws.api.apphor.de/{uuid}` and sends `{ "type": "authorize", "ticket": "…" }` immediately after opening, then forwards raw binary GRBL data. The relay admin API uses `Authorization: Bearer RELAY_API_TOKEN` server-side: `GET /_admin/machines`, and POST `/_admin/machines/{uuid}/claim` or `/ticket` with `{ownerSub}`. The relay must enforce immutable claims and ticket ownership/expiry.

## Local serial and safety

The local USB button uses browser Web Serial (Chrome/Edge, HTTPS or localhost) and remains independent of remote relay control. Choose the USB device explicitly. Status is polled every 500 ms; jog release sends feed hold. Commands can move the machine: verify baud rate, configuration, axis directions, and physical emergency stop. Jog stop is not safety-rated.

## Bridge host

The bridge connects to `RELAY_URL` (default `wss://ws.api.apphor.de`) at `/bridge/register` using `Authorization: Bearer BRIDGE_REGISTRATION_TOKEN`. Configure the exact hardware `SERIAL_PORT` and obtain `BRIDGE_REGISTRATION_TOKEN` from your secret store; never log or expose the token. `BAUD_RATE` defaults to 115200. The bridge stores a persistent UUID in `MACHINE_ID_PATH` (default `/var/lib/grbl-bridge/machine-id`). A successful authenticated registration is required before serial data is forwarded.

The optional systemd template is `deploy/grbl-bridge.service`. Install and configure it only when the hardware is attached. Set `SERIAL_PORT` to the exact present device path (for example `/dev/ttyUSB0`); do not start the hardware service if that port is absent. The unit uses `dialout` and permits ttyUSB/ttyACM devices; change `SupplementaryGroups` to the device's owning group when needed. Create `/etc/grbl-bridge.env` readable only by root and set `SERIAL_PORT` and the secret-store-provided `BRIDGE_REGISTRATION_TOKEN` there. Do not use the former public room/session ID mode.
