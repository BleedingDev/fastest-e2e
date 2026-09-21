import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { Effect } from 'effect';
import { fixture } from './support/chrome.mjs';
import { runTask, closeRun } from '../dist/workflows.js';
import { Journal } from '../dist/journal.js';

const f = await fixture(), execute = task => Effect.runPromise(runTask(task, true));
const key = 'FE2E_REVIEW_PRIVATE_INPUT', previous = process.env[key];
const secret = 'secret-sentinel-never-retain';
process.env[key] = secret;
const passed = [];
try {
  for (const [source, field] of [
    [{ selector: 'input[name=displayName]' }, { selector: '#name' }],
    [{ selector: '#frameName', frames: ['iframe#remote'] }, { selector: '#frameName', frames: ['#remote'] }],
    [{ selector: 'open-host input', shadow: 'open' }, { selector: '#shadowInput', shadow: 'open' }],
  ]) {
    const result = await execute({ name: 'Environment alias cannot be retained', url: f.url, goal: 'Fill an environment-backed field', keepTab: true,
      steps: [{ kind: 'fill', ...source, valueFromEnv: key }],
      checks: [{ kind: 'text', selector: 'h1', value: 'Settings' }],
      recovery: { fields: [{ key: 'private', ...field }] },
    });
    assert.equal(result.status, 'blocked', JSON.stringify(result));
    assert.equal(result.execution.reasonCode, 'retention_forbidden');
    const j = new Journal(f.directory, result.runId);
    assert.deepEqual(j.recoveryFields(), {});
    const files = fs.readdirSync(j.dir, { recursive: true }).filter(file => fs.statSync(path.join(j.dir, file)).isFile());
    for (const file of files) assert.equal(fs.readFileSync(path.join(j.dir, file), 'utf8').includes(secret), false, file);
    assert.equal(j.events().some(e => e.type === 'action.start' && e.data.kind === 'fill'), false);
    await Effect.runPromise(closeRun(result.runId));
  }
  passed.push('alias selectors, frame aliases, and open-root aliases cannot retain environment values');

  const raced = await execute({ name: 'Recovery selector cannot swap after identity guard', url: f.url + '/recovery-race', goal: 'Fill an environment-backed field', keepTab: true,
    steps: [{ kind: 'fill', selector: '#token', valueFromEnv: key }],
    checks: [{ kind: 'text', selector: 'h1', value: 'Recovery race' }],
    recovery: { fields: [{ key: 'active', selector: '.active-input' }] },
  });
  assert.equal(raced.status, 'passed', JSON.stringify(raced));
  const racedJournal = new Journal(f.directory, raced.runId);
  assert.equal(racedJournal.recoveryFields().active.value, 'public-sentinel');
  const racedFiles = fs.readdirSync(racedJournal.dir, { recursive: true }).filter(file => fs.statSync(path.join(racedJournal.dir, file)).isFile());
  for (const file of racedFiles) assert.equal(fs.readFileSync(path.join(racedJournal.dir, file), 'utf8').includes(secret), false, file);
  await Effect.runPromise(closeRun(raced.runId));
  passed.push('recovery target identity is pinned atomically with its value read');

  const unrelated = await execute({ name: 'Independent recovery stays usable', url: f.url, goal: 'Fill independent controls', keepTab: true,
    steps: [{ kind: 'fill', selector: '#other', valueFromEnv: key }, { kind: 'fill', selector: '#name', value: 'Recoverable' }],
    checks: [{ kind: 'value', selector: '#name', value: 'Recoverable' }],
    recovery: { fields: [{ key: 'name', selector: '#name' }] },
  });
  assert.equal(unrelated.status, 'passed', JSON.stringify(unrelated));
  assert.equal(new Journal(f.directory, unrelated.runId).recoveryFields().name.value, 'Recoverable');
  passed.push('unrelated allowlisted fields still capture correctly');

  const input = { name: 'Retry preflight without replaying Save', url: f.url, goal: 'Save once', requestId: 'recover-preflight', keepTab: true,
    steps: [{ kind: 'fill', selector: '#name', value: 'Preflight recovered' }, { kind: 'click', selector: '#save' }],
    checks: [{ kind: 'text', selector: '#status', value: 'Saved: Preflight recovered' }],
  };
  const activeFile = path.join(f.profile, 'DevToolsActivePort'), active = fs.readFileSync(activeFile);
  fs.rmSync(activeFile);
  let first;
  try {
    first = await execute(input);
    assert.equal(first.status, 'blocked');
    assert.equal(first.targetId, '');
    assert.equal(first.attempts.length, 0);
    const second = await execute(input);
    assert.equal(second.runId, first.runId);
    assert.ok(second.revision > first.revision, 'failed preflight must be retried, not cached');
  } finally { fs.writeFileSync(activeFile, active); }
  const writes = f.writes;
  const success = await execute(input);
  assert.equal(success.runId, first.runId);
  assert.equal(success.status, 'passed', JSON.stringify(success));
  assert.equal(success.attempts.length, 1);
  assert.equal(f.writes, writes + 1);
  // A cached success needs neither the live endpoint nor another Save.
  fs.rmSync(activeFile);
  try {
    const duplicate = await execute(input);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.revision, success.revision);
    assert.equal(f.writes, writes + 1);
  } finally { fs.writeFileSync(activeFile, active); }
  passed.push('same request survives failed preflight, then dispatches Save exactly once');
  console.log(JSON.stringify({ suite: 'PR review regressions', passed, paidModelCalls: 0 }));
} finally {
  if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  await f.cleanup();
}
