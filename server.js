'use strict';
// abasthan-mesh-node: Node.js wrapper that runs EasyTier (no-tun leaf) +
// Komari agent inside Abasthan's Node.js Web Service runtime, plus a tiny
// HTTP /health endpoint so the platform sees a live web service.
// No secrets are stored in this repo; everything comes from env vars.
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
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

const status = { easytier: 'starting', komari: 'starting', singbox: 'starting', startedAt: new Date().toISOString() };

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
for (const b of ['easytier-core', 'komari-agent', 'sing-box']) {
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

// sing-box VLESS+WS（可选）：只有配了 VLESS_UUID 才启动；不配就是原来的纯探针版。
// 入站只监听 127.0.0.1:10086，公网入口是 Node 在 $PORT 上做的 WS 中转
// （见下面的 'upgrade' 处理）：Abasthan 边缘终结 TLS 后透传 WebSocket。
// 注意：WS 不像 Reality——边缘能看到 WS 帧里的 VLESS 明文流量；
// 另：UUID 只写进配置文件，不出现在命令行/日志里。
const VLESS_UUID = process.env.VLESS_UUID || '';
const WS_PATH = process.env.VLESS_WS_PATH || '/vless-ws';
const SINGBOX_WS_PORT = parseInt(process.env.SINGBOX_WS_PORT || '10086', 10);
const singboxEnabled = Boolean(VLESS_UUID);
if (!singboxEnabled) status.singbox = 'disabled';

if (singboxEnabled) {
  // 出站：默认直连；SINGBOX_OUTBOUND_PROXY 设了就走 HTTP 代理
  // （本地冒烟用：VM 直连外网不通，要走 198.19.0.1:3128）。
  const proxy = process.env.SINGBOX_OUTBOUND_PROXY || '';
  let outbound = { type: 'direct' };
  if (proxy) {
    const m = proxy.match(/^https?:\/\/([^:/]+):(\d+)$/);
    if (m) outbound = { type: 'http', server: m[1], server_port: parseInt(m[2], 10) };
  }
  const sbConfig = {
    log: { level: 'info' },
    inbounds: [{
      type: 'vless',
      listen: '127.0.0.1',
      listen_port: SINGBOX_WS_PORT,
      users: [{ uuid: VLESS_UUID }],
      transport: { type: 'ws', path: WS_PATH },
    }],
    outbounds: [outbound],
  };
  fs.writeFileSync(path.join(RUN, 'sing-box.json'), JSON.stringify(sbConfig, null, 2));
}

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
const sb = singboxEnabled
  ? runManaged('singbox', path.join(BIN, 'sing-box'), ['run', '-c', path.join(RUN, 'sing-box.json')], { GOGC: '20' })
  : null;

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    const ok = status.easytier === 'running' && status.komari === 'running'
      && (status.singbox === 'disabled' || status.singbox === 'running');
    res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: ok ? 'ok' : 'degraded', ...status, uptimeSec: Math.floor(process.uptime()) }));
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});

// WS 中转：把 WS_PATH 的 WebSocket 升级请求转发给本地 sing-box。
// Node 的 http 解析器已经吃掉了原始 Upgrade 请求头，所以这里按原样
// 重组一份发给 sing-box（Sec-WebSocket-Key 原样透传，sing-box 算出的
// 101 响应才能对上客户端的 key）；之后两边 socket 直通，Node 不再碰数据。
server.on('upgrade', (req, socket, head) => {
  if (!singboxEnabled || req.url !== WS_PATH || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const upstream = net.connect(SINGBOX_WS_PORT, '127.0.0.1', () => {
    upstream.write(
      `GET ${WS_PATH} HTTP/1.1\r\nHost: 127.0.0.1:${SINGBOX_WS_PORT}\r\n` +
      `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});
server.listen(PORT, '0.0.0.0', () => console.log(`health server listening on :${PORT}`));

function shutdown(sig) {
  console.log(`got ${sig}, shutting down children`);
  et.kill();
  ka.kill();
  if (sb) sb.kill();
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
