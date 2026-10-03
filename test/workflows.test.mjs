import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { parseDocument } from 'yaml';
import { parseConfig } from '../src/config.mjs';
import { manifestChanges } from '../src/manifests.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const workflowFiles = [
  '.github/workflows/ci.yml',
  '.github/workflows/prepare.yml',
  '.github/workflows/publish.yml',
  '.github/workflows/release.yml',
  '.github/actions/setup/action.yml',
  'examples/consumer-workflow.yml',
];
const outputNames = ['unit', 'version', 'tag', 'source-sha', 'release-sha', 'pr-number', 'release-id', 'release-url'];
const approvedActions = new Map([
  ['actions/checkout', '3d3c42e5aac5ba805825da76410c181273ba90b1'],
  ['actions/setup-node', '820762786026740c76f36085b0efc47a31fe5020'],
]);
const approvedLocalUses = new Set([
  './.github/actions/setup',
  './release-tool/.github/actions/setup',
  './.github/workflows/prepare.yml',
  './.github/workflows/publish.yml',
]);

async function readYaml(file) {
  const document = parseDocument(await readFile(path.join(root, file), 'utf8'), { uniqueKeys: true, strict: true });
  assert.equal(document.errors.length, 0, `${file}: ${document.errors.map(error => error.message).join('; ')}`);
  return document.toJS();
}

function collectUses(value, results = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectUses(item, results);
  } else if (value && typeof value === 'object') {
    if (typeof value.uses === 'string') results.push(value.uses);
    for (const child of Object.values(value)) collectUses(child, results);
  }
  return results;
}

function atPath(value, keys) {
  return keys.reduce((current, key) => current?.[key], value);
}

function manifestValue(text, manifest) {
  let parsed;
  if (manifest.format === 'json') parsed = JSON.parse(text);
  else if (manifest.format === 'yaml') parsed = parseDocument(text, { uniqueKeys: true, strict: true }).toJS();
  else parsed = parseToml(text);
  return atPath(parsed, manifest.key);
}

test('workflow YAML uses only approved immutable actions', async () => {
  const workflows = await Promise.all(workflowFiles.map(readYaml));
  for (let index = 0; index < workflowFiles.length; index += 1) {
    const file = workflowFiles[index];
    for (const reference of collectUses(workflows[index])) {
      if (reference.startsWith('./')) {
        assert.ok(approvedLocalUses.has(reference), `Unapproved local action or workflow in ${file}: ${reference}`);
        continue;
      }
      if (reference.startsWith('datarose-dev/release/.github/workflows/')) {
        assert.equal(file, 'examples/consumer-workflow.yml');
        assert.match(reference, /^datarose-dev\/release\/\.github\/workflows\/(prepare|publish)\.yml@REPLACE_WITH_40_CHARACTER_SHA$/u);
        continue;
      }

      const match = /^(actions\/(?:checkout|setup-node))@([0-9a-f]{40})$/u.exec(reference);
      assert.ok(match, `Unapproved or unpinned action in ${file}: ${reference}`);
      assert.equal(match[2], approvedActions.get(match[1]), `Unexpected immutable pin for ${match[1]}`);
    }
  }
});

test('reusable workflows keep trusted tool and target checkouts separate', async () => {
  const prepare = await readYaml('.github/workflows/prepare.yml');
  const publish = await readYaml('.github/workflows/publish.yml');

  for (const [workflow, jobName] of [[prepare, 'release'], [publish, 'publish']]) {
    const steps = workflow.jobs[jobName].steps;
    const toolIndex = steps.findIndex(step => step.with?.repository === 'datarose-dev/release');
    const targetIndex = steps.findIndex(step => step.with?.repository === '${{ github.repository }}');
    assert.ok(toolIndex >= 0 && targetIndex > toolIndex);
    assert.equal(steps[toolIndex].with.ref, '${{ inputs.tool-ref }}');
    assert.equal(steps[toolIndex].with.path, 'release-tool');
    assert.equal(steps[toolIndex].with['persist-credentials'], false);
    assert.equal(steps[targetIndex].with.ref, '${{ github.event.repository.default_branch }}');
    assert.equal(steps[targetIndex].with.path, 'release-target');
    assert.equal(steps[targetIndex].with['fetch-depth'], 0);
    assert.equal(steps[targetIndex].with['persist-credentials'], false);
    assert.ok(steps[0].run.includes('TOOL_REF'));
    assert.ok(toolIndex > 0, 'tool SHA validation must precede trusted tool checkout');
    assert.ok(!JSON.stringify(workflow).includes('github.event.pull_request.head'));
    assert.ok(!JSON.stringify(workflow).includes('github.event.pull_request.merge_commit_sha'));
  }
});

test('prepare and publish let helper infer managed unit without blocking check', async () => {
  const prepare = await readYaml('.github/workflows/prepare.yml');
  const publish = await readYaml('.github/workflows/publish.yml');
  const prepareSteps = prepare.jobs.release.steps;
  const publishSteps = publish.jobs.publish.steps;
  const prepareRunner = prepareSteps.find(step => step.id === 'run-release');
  const publishRunner = publishSteps.find(step => step.id === 'run-release');

  assert.match(prepareRunner.run, /cli\.mjs" update/u);
  assert.match(prepareRunner.run, /cli\.mjs" prepare/u);
  assert.match(publishRunner.run, /cli\.mjs" publish/u);
  for (const step of [...prepareSteps, ...publishSteps]) {
    assert.doesNotMatch(step.run ?? '', /cli\.mjs" check/u);
    assert.notEqual(step.name, 'Validate release configuration');
  }
  assert.equal(prepareSteps[0].name, 'Validate trusted tool ref');
  assert.match(prepareSteps[0].run, /\^\[0-9a-fA-F\]\{40\}\$/u);
  assert.equal(publishSteps[0].name, 'Validate trusted tool ref');
  assert.match(publishSteps[0].run, /\^\[0-9a-fA-F\]\{40\}\$/u);
  assert.equal(prepareRunner.env.RELEASE_UNIT, '${{ inputs.unit }}');
  assert.equal(publishRunner.env.RELEASE_UNIT, '${{ inputs.unit }}');
});

test('release permissions, concurrency, helper environments, and outputs stay wired', async () => {
  const ci = await readYaml('.github/workflows/ci.yml');
  const setup = await readYaml('.github/actions/setup/action.yml');
  const prepare = await readYaml('.github/workflows/prepare.yml');
  const publish = await readYaml('.github/workflows/publish.yml');
  const wrapper = await readYaml('.github/workflows/release.yml');

  assert.deepEqual(ci.permissions, { contents: 'read' });
  const ciSetup = ci.jobs.test.steps.find(step => step.uses === './.github/actions/setup');
  assert.ok(ciSetup);
  assert.equal(ciSetup.with['tool-directory'], '${{ github.workspace }}');
  assert.equal(ciSetup.env.GH_TOKEN, '${{ github.token }}');
  assert.ok(!ci.jobs.test.steps.some(step => step.uses?.startsWith('actions/setup-node@')));
  const ciTests = ci.jobs.test.steps.find(step => step.run === 'node --test');
  assert.equal(ciTests.env.REQUIRE_GIT_CLIFF, '1');

  const nodeSetup = setup.runs.steps.find(step => step.uses?.startsWith('actions/setup-node@'));
  assert.equal(nodeSetup.uses, 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020');
  assert.equal(nodeSetup.with['node-version'], 22);
  const setupSource = await readFile(path.join(root, '.github/actions/setup/action.yml'), 'utf8');
  assert.match(setupSource, /24f397c733add5390fdceee3a2088588ab0d5f944ce00d34cb7029b888cf2db4/u);
  assert.match(setupSource, /sha256sum --check --status/u);
  assert.match(setupSource, /--strip-components=1 "git-cliff-\$\{version\}\/git-cliff"/u);
  assert.deepEqual(prepare.jobs.release.permissions, { contents: 'write', 'pull-requests': 'write' });
  assert.deepEqual(publish.jobs.publish.permissions, { contents: 'write', 'pull-requests': 'read' });
  assert.equal(prepare.concurrency.group, publish.concurrency.group);
  assert.equal(prepare.concurrency['cancel-in-progress'], false);
  assert.equal(publish.concurrency['cancel-in-progress'], false);
  assert.match(prepare.concurrency.group, /github\.repository.*inputs\.config/u);

  const prepareStep = prepare.jobs.release.steps.find(step => step.id === 'run-release');
  const publishStep = publish.jobs.publish.steps.find(step => step.id === 'run-release');
  for (const key of ['GH_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_EVENT_PATH', 'RELEASE_REPOSITORY_DIR', 'RELEASE_CONFIG', 'RELEASE_UNIT']) {
    assert.ok(Object.hasOwn(prepareStep.env, key), `prepare helper misses ${key}`);
    assert.ok(Object.hasOwn(publishStep.env, key), `publish helper misses ${key}`);
  }
  for (const key of ['RELEASE_VERSION', 'RELEASE_DRAFT', 'RELEASE_PRERELEASE']) assert.ok(Object.hasOwn(prepareStep.env, key));

  for (const [workflow, jobName] of [[prepare, 'release'], [publish, 'publish']]) {
    const job = workflow.jobs[jobName];
    for (const name of outputNames) {
      assert.equal(job.outputs[name], `\${{ steps.run-release.outputs.${name} }}`);
      const callOutput = workflow.on.workflow_call.outputs[name];
      assert.equal(callOutput.value, `\${{ jobs.${jobName}.outputs.${name} }}`);
    }
    assert.deepEqual(Object.keys(workflow.on.workflow_call.outputs).sort(), [...outputNames].sort());
  }

  assert.equal(wrapper.jobs['prepare-comment-update'].with['tool-ref'], '${{ github.sha }}');
  assert.equal(wrapper.jobs['publish-merged-release'].with['tool-ref'], '${{ github.event.pull_request.base.sha }}');
});

test('consumer build stays read-only and asset upload uses separate write permission', async () => {
  const consumer = await readYaml('examples/consumer-workflow.yml');
  const build = consumer.jobs.build;
  const upload = consumer.jobs['upload-release-assets'];

  assert.equal(build.needs, 'publish');
  assert.deepEqual(build.permissions, { contents: 'read' });
  assert.equal(build.steps[0].with.ref, '${{ needs.publish.outputs.release-sha }}');
  assert.equal(build.steps[0].with['persist-credentials'], false);
  assert.deepEqual(upload.needs, ['build', 'publish']);
  assert.deepEqual(upload.permissions, { contents: 'write' });
  assert.equal(upload.if, "needs.publish.outputs.release-id != ''");
  assert.ok(upload.steps[0].if.includes("hashFiles('dist/*')"));
  assert.equal(upload.steps[0].env.GH_TOKEN, '${{ secrets.RELEASE_TOKEN || github.token }}');
  assert.match(upload.steps[0].run, /^gh release upload "\$RELEASE_TAG" dist\/\* --repo "\$GITHUB_REPOSITORY" --clobber$/u);
  for (const job of Object.values(consumer.jobs).filter(candidate => candidate.uses)) {
    assert.equal(job.uses.split('@').at(-1), job.with['tool-ref']);
  }
});

test('release configurations and their referenced manifest fields are valid', async () => {
  const examples = [
    { config: '.release.json', directory: '.' },
    { config: 'examples/independent-units/.release.json', directory: 'examples/independent-units' },
    { config: 'examples/shared-version-monorepo/.release.json', directory: 'examples/shared-version-monorepo' },
  ];

  for (const example of examples) {
    const config = parseConfig(await readFile(path.join(root, example.config), 'utf8'), example.config);
    for (const [name, unit] of Object.entries(config.units)) {
      const changes = await manifestChanges(path.join(root, example.directory), unit, '0.2.0');
      for (const manifest of unit.manifests) {
        assert.ok(changes.has(manifest.path), `${example.config}:${name} did not update ${manifest.path}`);
        assert.equal(manifestValue(changes.get(manifest.path), manifest), '0.2.0', `${example.config}:${name}:${manifest.path}`);
      }
    }
  }

  const independent = parseConfig(await readFile(path.join(root, examples[1].config), 'utf8'), examples[1].config);
  assert.deepEqual(Object.keys(independent.units).sort(), ['core', 'js']);
  assert.equal(independent.units.js.tagPrefix, 'js/v');
  assert.deepEqual(independent.units.js.paths, ['packages/js']);
  assert.equal(independent.units.core.tagPrefix, 'core/v');
  assert.deepEqual(independent.units.core.paths, ['crates/core']);

  const shared = parseConfig(await readFile(path.join(root, examples[2].config), 'utf8'), examples[2].config);
  assert.deepEqual(shared.units.release.manifests.map(manifest => manifest.path), [
    'packages/js/package.json',
    'packages/php/composer.json',
    'Cargo.toml',
  ]);
  assert.deepEqual(shared.units.release.manifests[2].key, ['workspace', 'package', 'version']);
});
