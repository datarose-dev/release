#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
import { ReleaseEngine } from './engine.mjs';
import { redact } from './runner.mjs';

try {
  const command = process.argv[2];
  if (!['prepare', 'update', 'publish', 'check'].includes(command) || process.argv.length !== 3) throw new Error('Usage: node src/cli.mjs prepare|update|publish|check');
  const engine = new ReleaseEngine();
  const outputs = await engine[command]();
  for (const [key, value] of Object.entries(outputs)) {
    if (typeof value !== 'string' || /[\r\n]/u.test(value)) throw new Error(`Unsafe output: ${key}`);
  }
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
  process.stdout.write(JSON.stringify(outputs) + '\n');
} catch (error) {
  process.stderr.write(`Release failed: ${redact(error.message)}\n`);
  process.exitCode = 1;
}
