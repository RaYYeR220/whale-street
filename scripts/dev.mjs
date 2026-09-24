// Local development: the engine (REPLAY without a Nansen key, LIVE with one) and the web app together.
// Output is prefixed per process; Ctrl+C or either process exiting stops both.
import { spawn, spawnSync } from 'node:child_process';

const ENGINE_URL = process.env.NEXT_PUBLIC_ENGINE_URL ?? 'http://localhost:8787';
const win = process.platform === 'win32';

const procs = [
  { name: 'engine', color: 36, args: ['--filter', '@whale-street/engine', 'dev'], env: {} },
  {
    name: 'web',
    color: 35,
    args: ['--filter', '@whale-street/web', 'dev'],
    env: { NEXT_PUBLIC_ENGINE_URL: ENGINE_URL },
  },
];

let stopping = false;
const children = procs.map((p) => {
  const options = {
    env: { ...process.env, ...p.env, FORCE_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  // Windows needs a shell to find pnpm.cmd; the arguments are fixed strings.
  const child = win
    ? spawn(['pnpm', ...p.args].join(' '), { ...options, shell: true })
    : spawn('pnpm', p.args, options);
  const tag = `\x1b[${p.color}m${p.name.padEnd(6)}\x1b[0m│ `;
  const pipe = (stream, out) => {
    let rest = '';
    stream.on('data', (chunk) => {
      const lines = (rest + chunk.toString()).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) out.write(`${tag}${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (!stopping) {
      process.stderr.write(`${tag}exited with code ${code ?? 'null'}; stopping everything\n`);
      stop(code ?? 1);
    }
  });
  return child;
});

function kill(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  // On Windows the shell wrapper would survive a plain kill; take the whole tree down.
  if (win) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) kill(c);
  process.exit(code);
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
console.log(`engine → ${ENGINE_URL}   web → http://localhost:3000`);
