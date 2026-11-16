# abasthan-mesh-node

EasyTier no-tun mesh leaf + Komari probe, running on Abasthan's free
Web Service tier via a small Node.js wrapper (`server.js`).

Abasthan's dashboard has no Dockerfile / Docker image deployment path
(only Git Provider / Public Git Repository), so the Railway Docker image
(`ghcr.io/muse-git/mesh-node:latest`) cannot be deployed as-is. This repo
is the rewrite: plain Node.js runtime, the two static binaries in `bin/`,
and a tiny HTTP `/health` endpoint so the Web Service looks like a web
service. No Dockerfile is included on purpose, so the platform takes the
Node.js path.

## What runs

- `easytier-core` — no-tun leaf on `mango-mesh`, mesh IP `10.144.144.86/24`,
  hostname `abasthan`, peers `212.64.10.215:11010` and `104.208.65.233:11010`.
  (Railway's node keeps `10.144.144.110`; this is a separate node, never a
  duplicate — same Komari token / same mesh IP would cause a mutual-kick
  storm.)
- `komari-agent` — reports to the Komari hub as node `[美国]Abasthan`
  (its own client + token, created 2026-11-17).
- `sing-box` — optional VLESS+WS proxy (only starts when `VLESS_UUID`
  is set). Inbound listens on `127.0.0.1:10086`; the public entry is
  the Node wrapper relaying the WebSocket upgrade on `$VLESS_WS_PATH`
  (default `/vless-ws`) — Abasthan's edge terminates TLS and has no
  public TCP port, so VLESS+Reality cannot work here; VLESS+WS through
  the single HTTPS endpoint is the working route (added 2026-11-17,
  user asked to deploy and test it directly).
- `server.js` — spawns all three, restarts any if it exits, serves
  `GET /` and `GET /health` on `$PORT` (default 8080).

## Environment variables (set in the Abasthan dashboard, never in git)

| Variable | Purpose |
| --- | --- |
| `NETWORK_SECRET` | EasyTier `mango-mesh` network secret (same shared secret as the other leaves) |
| `AGENT_ENDPOINT` | Komari hub, e.g. `https://vps.mangoqwq.com` |
| `AGENT_TOKEN` | Token of the `[美国]Abasthan` Komari client (independent token) |
| `VLESS_UUID` | Optional: UUID for the VLESS+WS inbound; unset = probe-only, no sing-box |
| `VLESS_WS_PATH` | Optional, default `/vless-ws` — WebSocket path for the VLESS inbound |
| `SINGBOX_WS_PORT` | Optional, default `10086` — sing-box local WS listen port |
| `SINGBOX_OUTBOUND_PROXY` | Optional: `http://host:port` — sing-box outbound via HTTP proxy (local smoke test only; production leaves it unset = direct) |
| `MESH_IPV4` | Optional, default `10.144.144.86/24` |
| `MESH_HOSTNAME` | Optional, default `abasthan` |

Client link (after setting the env vars):
`vless://<VLESS_UUID>@overload-rare-deer.abasthan.app:443?encryption=none&security=tls&sni=overload-rare-deer.abasthan.app&type=ws&path=/vless-ws#Abasthan-VLESS-WS`

## Notes / limits

- Free Web Service: 512 MB / 0.1 vCPU, sleeps after 90 minutes without
  incoming traffic — the public `/health` URL needs a periodic ping to
  stay awake (the VM health-watch loop does this).
- Memory use is ~75–90 MB for the two binaries plus ~30–50 MB for Node,
  comfortably inside 512 MB.
- Binaries are static x86-64 builds (sing-box is the musl static build:
  Alpine has no glibc, the glibc build will not run).
- VLESS+WS notes: the edge terminates TLS, so after termination it can
  see the plaintext VLESS stream inside the WebSocket frames — weaker
  concealment than Reality, and the platform could identify the traffic
  as proxy traffic. Free tier is 0.1 vCPU, so don't expect much speed.
  The sing-box binary is the musl static build (Alpine has no glibc).
- Logging hygiene (2026-11-17 review fix): the wrapper masks the Komari
  token in its own startup log lines. Known residual: `easytier-core`
  itself dumps its loaded config (including `network_secret`) to stdout
  at startup — that line comes from the binary and cannot be masked from
  the wrapper, so treat platform log retention as inside the same trust
  boundary as the dashboard env vars.
