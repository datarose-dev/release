import { spawn } from 'node:child_process';
import { ReleaseError } from './errors.mjs';

export function redact(text, env = process.env) {
  let result = String(text);
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN']) if (env[key]) result = result.replaceAll(env[key], '[redacted]');
  return result.replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gu, 'https://[redacted]@');
}

export class CommandError extends ReleaseError {
  constructor(executable, code, stderr, env) {
    const safe = redact(stderr, env).trim().slice(0, 2000);
    super(`${executable} failed (exit ${code})${safe ? `: ${safe}` : '.'}`);
    this.code = code;
    this.stderr = safe;
  }
}

export async function run(executable, args, { cwd, input, env = process.env, timeoutMs = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let overflow = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    timer.unref();
    const capture = (chunks, chunk) => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) { overflow = true; child.kill(); } else chunks.push(chunk);
    };
    child.stdout.on('data', chunk => capture(stdout, chunk));
    child.stderr.on('data', chunk => capture(stderr, chunk));
    child.on('error', error => { clearTimeout(timer); reject(new ReleaseError(`Cannot run ${executable}: ${redact(error.message, env)}`)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) reject(new ReleaseError(`${executable} timed out after ${timeoutMs} ms.`));
      else if (overflow) reject(new ReleaseError(`${executable} exceeded the 16 MiB output limit.`));
      else if (code !== 0) reject(new CommandError(executable, code, Buffer.concat(stderr).toString('utf8'), env));
      else resolve(Buffer.concat(stdout).toString('utf8'));
    });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(input);
  });
}
