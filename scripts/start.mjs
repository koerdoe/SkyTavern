// 一键启动：检查 Node 版本 → 需要时安装依赖 → 需要时构建前端 → 启动服务 → 打开浏览器。
// 用法：node scripts/start.mjs [--no-open] [--rebuild]

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const isWin = process.platform === 'win32';

const log = (msg) => console.log(`\x1b[36m[SkyTavern]\x1b[0m ${msg}`);
const fail = (msg) => {
  console.error(`\x1b[31m[SkyTavern]\x1b[0m ${msg}`);
  process.exit(1);
};

// ---------- Node 版本 ----------
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  fail(`需要 Node.js 22.18 或更新的版本，当前是 ${process.versions.node}。下载：https://nodejs.org/`);
}

// ---------- 工具 ----------
const mtime = (p) => (existsSync(p) ? statSync(p).mtimeMs : 0);

/** 目录（递归）或文件里最新的修改时间。 */
function newest(p) {
  if (!existsSync(p)) return 0;
  const s = statSync(p);
  if (!s.isDirectory()) return s.mtimeMs;
  return readdirSync(p).reduce((m, name) => Math.max(m, newest(join(p, name))), s.mtimeMs);
}

function run(cmd, cmdArgs) {
  return new Promise((resolve, reject) => {
    // Windows 上 npm 是 npm.cmd，需要经过 shell
    const child = spawn(cmd, cmdArgs, { cwd: root, stdio: 'inherit', shell: isWin });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${cmdArgs.join(' ')} 失败（退出码 ${code}）`))));
    child.on('error', reject);
  });
}

// ---------- 依赖 ----------
// npm install 会写 node_modules/.package-lock.json；package.json 比它新就说明依赖有变化。
const installedAt = mtime(join(root, 'node_modules', '.package-lock.json'));
if (installedAt === 0 || mtime(join(root, 'package.json')) > installedAt || mtime(join(root, 'package-lock.json')) > installedAt) {
  log('安装依赖…');
  await run('npm', ['install']).catch((e) => fail(e.message));
}

// ---------- 前端 ----------
const builtAt = mtime(join(root, 'web', 'dist', 'index.html'));
const sourcesAt = Math.max(
  newest(join(root, 'web', 'src')),
  newest(join(root, 'web', 'index.html')),
  newest(join(root, 'web', 'vite.config.ts')),
  newest(join(root, 'src', 'core')),
);
if (args.has('--rebuild') || builtAt === 0 || sourcesAt > builtAt) {
  log('构建前端…');
  await run('npm', ['run', 'build']).catch((e) => fail(e.message));
}

// ---------- 启动 ----------
const { loadConfig } = await import('../src/server/config.ts');
let config;
try {
  config = loadConfig(join(root, 'config.json'));
} catch (e) {
  fail(e.message);
}
const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
const url = `http://${host}:${config.port}/`;

log(`启动服务：${url}（按 Ctrl+C 停止）`);
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server/main.ts'], { cwd: root, stdio: 'inherit' });
server.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.kill(sig));

// 服务就绪后打开浏览器（开启认证时返回 401 也算就绪）。
if (!args.has('--no-open')) {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const ok = await fetch(url).then(
      () => true,
      () => false,
    );
    if (!ok) continue;
    const [opener, openerArgs] = isWin ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(opener, openerArgs, { stdio: 'ignore', detached: true }).on('error', () => log(`请手动打开 ${url}`)).unref();
    break;
  }
}
