import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

export function testArguments(argv, environment = process.env) {
  const separator = argv.indexOf('--');
  const options = separator < 0 ? argv : argv.slice(0, separator);
  const selected = separator < 0 ? [] : argv.slice(separator + 1);
  const forwarded = [];
  let jobs = environment.TEST_WORKERS ?? Math.min(4, availableParallelism());
  for (let index = 0; index < options.length; index++) {
    const option = options[index];
    if (option === '--serial') jobs = 1;
    else if (option === '--jobs') jobs = options[++index];
    else if (option.startsWith('--jobs=')) jobs = option.slice(7);
    else forwarded.push(option);
  }
  if (!/^[1-9]\d*$/.test(String(jobs)) || !Number.isSafeInteger(Number(jobs))) {
    throw new Error('--jobs / TEST_WORKERS must be a positive integer');
  }
  // File isolation is intentional: globals, mocks and environment changes stay
  // inside one worker. Tests within each file retain their serial default.
  const files = selected.length ? selected : readdirSync(new URL('../tests/unit/', import.meta.url))
    .filter(name => name.endsWith('.test.mjs')).sort().map(name => `tests/unit/${name}`);
  return ['--test', `--test-concurrency=${jobs}`, ...forwarded, ...files];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--help')) {
    console.log('npm test -- [--jobs N | --serial] [Node test options] [-- test files]\nTEST_WORKERS sets the worker count (default: up to 4 CPUs).');
  } else {
    try {
      const child = spawn(process.execPath, testArguments(process.argv.slice(2)), { cwd: root, stdio: 'inherit' });
      const interrupt = () => child.kill('SIGINT');
      const terminate = () => child.kill('SIGTERM');
      process.on('SIGINT', interrupt);
      process.on('SIGTERM', terminate);
      child.on('error', error => { console.error(error.message); process.exitCode = 1; });
      child.on('exit', (code, signal) => {
        process.off('SIGINT', interrupt);
        process.off('SIGTERM', terminate);
        if (signal) process.kill(process.pid, signal);
        else process.exitCode = code ?? 1;
      });
    } catch (error) {
      console.error(error.message);
      process.exitCode = 2;
    }
  }
}
