import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { run, redact, CommandError } from '../src/runner.mjs';
import { GitHub, managedPr, isNotFound } from '../src/github.mjs';
import { parsePlan } from '../src/engine.mjs';
import { fixture } from './fixtures.mjs';

test('runner never interpolates shell strings and redacts credentials from errors', async () => {
  const value = '; echo must-not-run $(exit 99)';
  assert.equal(await run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', value]), value);
  const env = { ...process.env, GH_TOKEN: 'private-token' };
  await assert.rejects(run(process.execPath, ['-e', 'process.stderr.write(process.env.GH_TOKEN); process.exit(3)'], { env }), error => error instanceof CommandError && error.code === 3 && !error.message.includes('private-token') && error.message.includes('[redacted]'));
  assert.equal(redact('https://user:secret@example.com'), 'https://[redacted]@example.com');
});

test('runner reports bounded command timeouts', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 50 }), /timed out after 50 ms/);
});

test('GitHub only treats explicit 404 errors as absent releases', async () => {
  assert.equal(isNotFound(new CommandError('gh', 1, 'gh: Not Found (HTTP 404)')), true);
  const github = new GitHub('owner/repo', async () => { throw new CommandError('gh', 1, 'gh: Forbidden (HTTP 403)'); });
  await assert.rejects(github.release('v1.0.0'), /403/);
  assert.throws(() => new GitHub('../repo'), /GITHUB_REPOSITORY/);
  assert.throws(() => managedPr({ user: { login: 'attacker' } }, { repository: 'owner/repo', releaseAuthor: 'github-actions[bot]' }), /authored by/);
});

test('GitHub encodes tag and user inputs, and transports notes only through stdin', async () => {
  const calls = [];
  const github = new GitHub('owner/repo', async (...args) => { calls.push(args); return '{"permission":"maintain"}'; });
  assert.equal(await github.permission('build[bot]'), 'maintain');
  await github.api('repos/owner/repo/releases', { method: 'POST', body: { body: '$(malicious notes)' } });
  assert.match(calls[0][1][1], /build%5Bbot%5D/);
  assert.ok(!calls[1][1].includes('$(malicious notes)'));
  assert.equal(JSON.parse(calls[1][2].input).body, '$(malicious notes)');
});

test('state schema rejects malformed dates, unknown data and executable plan fields', () => {
  for (const text of ['null', '{}', '{"schemaVersion":1,"command":"evil"}', '{"releaseDate":"bad"}']) assert.throws(() => parsePlan(text));
});

test('publish skips unrelated merged PR safely without a release write', async t => {
  const f = await fixture(t);
  f.prs.set(8, { number: 8, user: { login: 'human' }, state: 'closed', merged_at: '2026-10-03', body: 'Normal PR', head: { ref: 'master', sha: await f.git.sha('HEAD') } });
  await f.event({ action: 'closed', pull_request: { number: 8, merged: true } });
  assert.deepEqual(await f.engine().publish(), {});
  assert.equal(f.calls.filter(call => call.input).length, 0);
});

test('event repository mismatch and bot-author spoof fail before mutation', async t => {
  const f = await fixture(t);
  await writeFile(f.env.GITHUB_EVENT_PATH, JSON.stringify({ action: 'created', repository: { full_name: 'attacker/repo' } }));
  await assert.rejects(f.engine().update(), /Event repository/);
  await f.engine().prepare();
  f.prs.get(1).user.login = 'attacker';
  await f.event({ action: 'created', issue: { number: 1, pull_request: {} }, comment: { body: '@datarose-release update', user: { login: 'writer' } } });
  await assert.rejects(f.engine().update(), /authored by/);
});
