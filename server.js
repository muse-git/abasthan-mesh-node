'use strict';
// abasthan-mesh-node: Node.js wrapper that runs EasyTier (no-tun leaf) +
// Komari agent inside Abasthan's Node.js Web Service runtime, plus a tiny
// HTTP /health endpoint so the platform sees a live web service.
// No secrets are stored in this repo; everything comes from env vars.
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8080', 10);
const MESH_IPV4 = process.env.MESH_IPV4 || '10.144.144.86/24';
const HOSTNAME = process.env.MESH_HOSTNAME || 'abasthan';
const RPC_PORTAL = process.env.RPC_PORTAL || '127.0.0.1:15888';
const SOCKS5 = process.env.SOCKS5_PROXY || 'socks5://127.0.0.1:11080';
const BIN = path.join(__dirname, 'bin');
const RUN = path.join(__dirname, 'run');
fs.mkdirSync(RUN, { recursive: true });
if (process.env.PID_FILE) fs.writeFileSync(process.env.PID_FILE, String(process.pid));

const status = { easytier: 'starting', komari: 'starting', startedAt: new Date().toISOString() };

function need(name) {
  const v = process.env[name];
  if (!v) { console.error(`missing required env ${name}`); process.exit(1); }
  return v;
}
const NETWORK_SECRET = need('NETWORK_SECRET');
const AGENT_ENDPOINT = need('AGENT_ENDPOINT');
const AGENT_TOKEN = need('AGENT_TOKEN');

function tomlEscape(s) { return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

// Ensure exec bits (git usually preserves them, but be safe on any runtime).
for (const b of ['easytier-core', 'komari-agent']) {
  try { fs.chmodSync(path.join(BIN, b), 0o755); } catch (e) { console.error('chmod failed', b, e.message); }
}

const toml = `instance_name = "${HOSTNAME}"
hostname = "${HOSTNAME}"
ipv4 = "${MESH_IPV4}"
listeners = []
socks5_proxy = "${SOCKS5}"
rpc_portal = "${RPC_PORTAL}"

[network_identity]
network_name = "mango-mesh"
network_secret = "${tomlEscape(NETWORK_SECRET)}"

[[peer]]
uri = "tcp://212.64.10.215:11010"

[[peer]]
uri = "tcp://104.208.65.233:11010"

[flags]
default_protocol = "tcp"
no_tun = true
`;
fs.writeFileSync(path.join(RUN, 'easytier.toml'), toml);

function runManaged(name, cmd, args, extraEnv) {
  let child = null;
  let stopped = false;
  const start = () => {
    if (stopped) return;
    console.log(`starting ${name}: ${cmd} ${args.join(' ')}`);
    child = spawn(cmd, args, { env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    status[name] = 'running';
    child.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
    child.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
    child.on('exit', (code, signal) => {
      status[name] = `exited(${code === null ? signal : code})`;
      if (stopped) return;
      console.error(`${name} exited code=${code} signal=${signal}; restarting in 5s`);
      setTimeout(start, 5000);
    });
    child.on('error', (err) => { console.error(`${name} spawn error:`, err.message); });
  };
  start();
  return {
    kill: () => { stopped = true; try { if (child) child.kill('SIGTERM'); } catch (e) { /* ignore */ } },
  };
}

const et = runManaged('easytier', path.join(BIN, 'easytier-core'), ['-c', path.join(RUN, 'easytier.toml')], {});
const ka = runManaged('komari', path.join(BIN, 'komari-agent'), [
  '-e', AGENT_ENDPOINT,
  '-t', AGENT_TOKEN,
  '--disable-web-ssh',
  '--disable-auto-update',
  '--prefer-cgroup-limits',
  '--force-memory-total', '512000000',
], { GOGC: '20', GOMEMLIMIT: '24MiB' });

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    const ok = status.easytier === 'running' && status.komari === 'running';
    res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: ok ? 'ok' : 'degraded', ...status, uptimeSec: Math.floor(process.uptime()) }));
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});
server.listen(PORT, '0.0.0.0', () => console.log(`health server listening on :${PORT}`));

function shutdown(sig) {
  console.log(`got ${sig}, shutting down children`);
  et.kill();
  ka.kill();
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
