import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';
import { runTask } from '../dist/workflows.js';
import { Journal } from '../dist/journal.js';
import { validateTask } from '../dist/task.js';

const base = { url: 'https://example.com/settings', goal: 'Use a local credential',
  steps: [{ kind: 'fill', selector: '#token', valueFromEnv: 'FE2E_PRIVATE_INPUT' }] };

for (const scope of [{}, { frames: ['#frame'] }, { frames: ['#frame', '#nested'], shadow: 'open' }]) {
  test(`environment input and recovery cannot overlap: ${JSON.stringify(scope)}`, () => {
    const task = { ...base, steps: [{ ...base.steps[0], ...scope }],
      recovery: { fields: [{ key: 'token', selector: '#token', ...scope }] } };
    assert.throws(() => validateTask(task, false), /environment-backed/i);
  });
}
test('scope defaults and selector whitespace do not bypass retention validation', () => {
  assert.throws(() => validateTask({ ...base,
    recovery: { fields: [{ key: 'token', selector: ' #token ', frames: [], shadow: 'none' }] },
  }, false), /environment-backed/i);
});
test('reconstruction environment inputs obey the same retention rule', () => {
  assert.throws(() => validateTask({ ...base, steps: undefined, recovery: {
    fields: [{ key: 'token', selector: '#token' }], reconstruct: [
      { kind: 'navigate', value: base.url, safeToRepeat: true },
      { ...base.steps[0], safeToRepeat: true },
    ],
  } }, false), /environment-backed/i);
});
test('unrelated recovery fields and distinct frame scopes remain usable', () => {
  for (const field of [{ key: 'name', selector: '#name' }, { key: 'token', selector: '#token', frames: ['#frame'] }]) {
    validateTask({ ...base, recovery: { fields: [field] } }, false);
  }
});

function isolatedHome(t) {
  const previous = process.env.FASTEST_E2E_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fe2e-preflight-'));
  const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ version: 1, profileDir: profile, chromeExecutable: process.execPath }));
  process.env.FASTEST_E2E_HOME = root;
  t.after(() => {
    if (previous === undefined) delete process.env.FASTEST_E2E_HOME;
    else process.env.FASTEST_E2E_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
const execute = input => Effect.runPromise(runTask(input));

test('duplicate request retries failed preflight in the same never-started run', async t => {
  const root = isolatedHome(t);
  const input = { ...base, requestId: 'preflight-once' };
  const first = await execute(input), j = new Journal(root, first.runId);
  assert.equal(first.status, 'blocked');
  assert.deepEqual(j.events().map(e => e.type), ['created', 'preflight.failed']);
  for (let n = 2; n <= 3; n++) {
    const retry = await execute(input);
    assert.equal(retry.runId, first.runId);
    assert.equal(j.events().filter(e => e.type === 'preflight.failed').length, n);
    assert.deepEqual(j.state().attempts, []);
    assert.equal(j.state().actionsUsed, 0);
    assert.equal(j.state().modelCallsUsed, 0);
  }
  await assert.rejects(execute({ ...input, goal: 'Conflicting request' }), /different inputs/);
});

test('duplicates cannot retry once any execution boundary or unknown event exists', async t => {
  const root = isolatedHome(t);
  for (const event of [
    ['attempt.start', { mode: 'new', engine: 'jev', allocatedMs: 1000 }],
    ['target', { targetId: 'owned', browserId: 'original' }],
    ['action.start', { id: 'save', safeToRepeat: false }],
    ['call.start', { engine: 'jev' }],
    ['future.execution.event', {}],
  ]) {
    const input = { ...base, requestId: event[0] };
    const first = await execute(input), j = new Journal(root, first.runId);
    j.append(...event);
    const revision = j.state().revision;
    const duplicate = await execute(input);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.runId, first.runId);
    assert.equal(j.state().revision, revision, `${event[0]} must prevent redispatch`);
  }
});
