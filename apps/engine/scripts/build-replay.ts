import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { filterSessionLines } from '../src/replay/filter';

// Usage: pnpm --filter @whale-street/engine build-replay <session.ndjson...> [--out replay/session.ndjson] [--window <startMs>,<endMs>]
const args = process.argv.slice(2);
let out = 'replay/session.ndjson';
let window: [number, number] | undefined;
const inputs: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--out') out = args[++i] ?? out;
  else if (a === '--window') {
    const [start, end] = (args[++i] ?? '').split(',').map(Number);
    if (
      start === undefined ||
      end === undefined ||
      !Number.isFinite(start) ||
      !Number.isFinite(end)
    ) {
      throw new Error('--window expects <startMs>,<endMs>');
    }
    window = [start, end];
  } else if (a) inputs.push(a);
}
if (inputs.length === 0) throw new Error('give at least one recorded session file');

const lines = inputs.flatMap((f) => readFileSync(f, 'utf8').split(/\r?\n/));
const kept = filterSessionLines(lines, window);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${kept.join('\n')}\n`);
console.log(
  `kept ${kept.length} of ${lines.filter((l) => l.trim() !== '').length} records -> ${out}`,
);
