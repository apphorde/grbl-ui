# GRBL Jog

Mobile-friendly browser controller for GRBL-compatible USB serial machines. The browser talks directly to the USB serial device using the Web Serial API; the Node container only serves the static UI and does **not** proxy serial data.

## Run

```sh
npm start
```

Open `http://localhost:8080` in Chrome or Edge. Remote use requires HTTPS (Web Serial is a secure-context API). The host running the browser needs access to the USB serial device. Serving this UI from a server does not give that server's USB port to a remote browser: to control a board physically attached to a headless server, use a browser on that server or the optional standalone bridge below.

## Standalone serial bridge

The standalone process forwards raw serial bytes to and from the WebSocket relay. The UI creates a random session ID; copy that same ID to the machine host so the browser and bridge join the same relay room. Start the bridge first, then connect in the UI. For the deployed relay:

```sh
npm install
SERIAL_PORT=/dev/ttyUSB0 RELAY_URL=wss://ws.api.apphor.de/<session-id> npm run serial-bridge
```

Set `SERIAL_PORT` to the local serial device and `RELAY_URL` to the relay's `ws://` or `wss://` URL including the session ID. `BAUD_RATE` is optional and defaults to `115200`. WebSocket text frames are encoded as UTF-8 and binary frames remain bytes; serial data is sent in binary WebSocket frames. This bridges an unrestricted raw serial channel; the relay has no authentication, encryption beyond TLS, command filtering, or multi-client arbitration. Anyone who knows the session ID can join and send machine commands. Treat the session ID as a secret, use the TLS URL, and disconnect when done; this is not a safety boundary. Either side closing, serial errors, or excessive WebSocket buffering closes the bridge. Payloads and endpoint URLs are not logged.

## Container

```sh
docker build -t grbl-jog-ui .
docker run --rm -p 8080:8080 grbl-jog-ui
```

## Use and safety

Connect, select the serial device, then jog with press-and-hold controls. Default serial speed is 115200 baud. Status is polled using `?` every 500 ms; GRBL status reports can include state, WPos/MPos, and limit/probe pins (`Pn`). Jog steps use `$J=G91 G21 ... F...`; releasing the control sends real-time feed hold (`!`). Unlock sends `$X`. Commands are sent as entered with a newline. Confirm your controller's baud rate, configuration, axis directions, and physical emergency stop before operating. Jog stop is not a safety-rated emergency stop.

## Browser support

Web Serial requires a supporting Chromium browser and a secure context (HTTPS or localhost). iOS Safari and Firefox do not currently provide this interface. A remote deployment must use HTTPS. Serial permissions are granted by the user per origin and are not transferred to the server container.
