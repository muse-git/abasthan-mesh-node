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
- `server.js` — spawns both, restarts either if it exits, serves
  `GET /` and `GET /health` on `$PORT` (default 8080).

## Environment variables (set in the Abasthan dashboard, never in git)

| Variable | Purpose |
| --- | --- |
| `NETWORK_SECRET` | EasyTier `mango-mesh` network secret (same shared secret as the other leaves) |
| `AGENT_ENDPOINT` | Komari hub, e.g. `https://vps.mangoqwq.com` |
| `AGENT_TOKEN` | Token of the `[美国]Abasthan` Komari client (independent token) |
| `MESH_IPV4` | Optional, default `10.144.144.86/24` |
| `MESH_HOSTNAME` | Optional, default `abasthan` |

## Notes / limits

- Free Web Service: 512 MB / 0.1 vCPU, sleeps after 90 minutes without
  incoming traffic — the public `/health` URL needs a periodic ping to
  stay awake (the VM health-watch loop does this).
- Memory use is ~75–90 MB for the two binaries plus ~30–50 MB for Node,
  comfortably inside 512 MB.
- No sing-box in this build (probe-only, same as the current Railway
  entrypoint v8). Binaries are static x86-64 builds.
- Logging hygiene (2026-11-17 review fix): the wrapper masks the Komari
  token in its own startup log lines. Known residual: `easytier-core`
  itself dumps its loaded config (including `network_secret`) to stdout
  at startup — that line comes from the binary and cannot be masked from
  the wrapper, so treat platform log retention as inside the same trust
  boundary as the dashboard env vars.
