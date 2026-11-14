// `pnpm dev`: the server (cargo, release) and the client (Vite) together; Ctrl-C stops both.
// Ports: CLIENT_PORT (default 4710) and SERVER_PORT (default 4711). The page is told where the
// server is through VITE_ARENA_SERVER.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientPort = process.env.CLIENT_PORT ?? '4710';
const serverPort = process.env.SERVER_PORT ?? '4711';
const host = '127.0.0.1';

const children = [];
function run(name, cmd, args, env = {}) {
  const child = spawn(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  child.on('exit', (code) => {
    console.log(`[dev] ${name} exited (${code ?? 'signal'}); stopping`);
    stop(code ?? 0);
  });
  children.push(child);
}

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill('SIGINT');
  process.exitCode = code;
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

run('server', 'cargo', [
  'run',
  '--release',
  '--manifest-path',
  'server/Cargo.toml',
  '--',
  'serve',
  '--host',
  host,
  '--port',
  serverPort,
]);
run('client', 'pnpm', ['exec', 'vite', '--host', host, '--port', clientPort, '--strictPort'], {
  VITE_ARENA_SERVER: `ws://${host}:${serverPort}`,
});
console.log(`[dev] open http://${host}:${clientPort}/ in two windows (the server builds first)`);
