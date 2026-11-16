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

// 日志脱敏：-t/--token 后面的值是 Komari token，绝不能打进日志
// （2026-11-17 review：旧版把完整命令行含 token 打到了平台日志流）。
// 注意：easytier-core 启动时自己会把含 network_secret 的配置打到 stdout，
// 那一行拦不住——属于已知残留，见 README。
function maskArgs(args) {
  const out = [...args];
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i] === '-t' || out[i] === '--token') out[i + 1] = '***';
  }
  return out;
}

function runManaged(name, cmd, args, extraEnv) {
  let child = null;
  let stopped = false;
  let restartTimer = null;
  // 5 秒后重起；带 guard：'error' 与 'exit' 可能先后都触发，只排一次。
  const scheduleRestart = () => {
    if (stopped || restartTimer) return;
    restartTimer = setTimeout(() => { restartTimer = null; start(); }, 5000);
  };
  const start = () => {
    if (stopped) return;
    console.log(`starting ${name}: ${cmd} ${maskArgs(args).join(' ')}`);
    child = spawn(cmd, args, { env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    status[name] = 'running';
    child.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
    child.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
    child.on('exit', (code, signal) => {
      status[name] = `exited(${code === null ? signal : code})`;
      if (stopped) return;
      console.error(`${name} exited code=${code} signal=${signal}; restarting in 5s`);
      scheduleRestart();
    });
    child.on('error', (err) => {
      // spawn 失败（如二进制缺失）时 'exit' 未必触发：必须自己置状态并安排重起，
      // 否则 /health 会一直撒谎报 running。
      status[name] = `spawn-error(${err.code || err.message})`;
      console.error(`${name} spawn error:`, err.message);
      if (!stopped) scheduleRestart();
    });
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
