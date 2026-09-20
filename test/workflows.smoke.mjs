import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { Effect } from 'effect';
import { fixture } from './support/chrome.mjs';
import { Cdp, checkpoint } from '../dist/cdp.js';
import { Journal, createRun } from '../dist/journal.js';
import { runTask, inspectRun, resumeRun, verifyRun, closeRun, screenshotRun } from '../dist/workflows.js';
import { attachPage } from '../dist/page-worker.js';

const f = await fixture(), run = effect => Effect.runPromise(effect), passed = [];
const testTask = (extra = {}) => ({ url: f.url, goal: 'Exercise the fixture UI', name: 'fixture', maxSteps: 50, timeoutMs: 120_000, checkTimeoutMs: 300, keepTab: true, ...extra });
let browser;
try {
  const basic = testTask({ requestId: 'save-once', steps: [{ kind: 'fill', selector: '#name', value: 'First result' }, { kind: 'click', selector: '#save' }], checks: [{ kind: 'text', selector: '#status', value: 'Saved: First result' }], extract: [{ name: 'displayName', kind: 'value', selector: '#name' }] });
  const result = await run(runTask(basic, true)); assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(result.extraction.displayName.value, 'First result'); assert.ok(result.extraction.displayName.evidenceRef);
  const writes = f.writes;
  const duplicate = await run(runTask(basic, true)); assert.equal(duplicate.runId, result.runId); assert.equal(duplicate.duplicate, true); assert.equal(f.writes, writes);
  await assert.rejects(run(runTask({ ...basic, goal: 'different' }, true)), /different inputs/);
  passed.push('public deterministic task, extraction, exact request deduplication');

  const scoped = await run(runTask(testTask({ steps: [
    { kind: 'fill', selector: '#shadowInput', shadow: 'open', value: 'Shadow' }, { kind: 'click', selector: '#shadowSave', shadow: 'open' },
    { kind: 'fill', frames: ['#remote'], selector: '#frameName', value: 'Remote' }, { kind: 'click', frames: ['#remote'], selector: '#frameSave' },
    { kind: 'fill', frames: ['#remote', '#nested'], selector: '#nestedName', value: 'Nested' },
  ], checks: [
    { kind: 'text', shadow: 'open', selector: '#shadowResult', value: 'Shadow' }, { kind: 'text', frames: ['#remote'], selector: 'output', value: 'Frame saved' },
    { kind: 'value', frames: ['#remote', '#nested'], selector: '#nestedName', value: 'Nested' },
  ] }), true)); assert.equal(scoped.status, 'passed', JSON.stringify(scoped));
  passed.push('nested cross-origin frames and open shadow assertions');

  const broken = await run(runTask(testTask({ steps: [{ kind: 'fill', selector: '#name', value: 'Actual' }], checks: [{ kind: 'value', selector: '#name', value: 'Wrong expectation' }] }), true));
  assert.equal(broken.status, 'failed');
  await assert.rejects(run(resumeRun({ runId: broken.runId, expectedRevision: broken.revision })), /already has a verdict/);
  const recheck = await run(verifyRun(broken.runId)); assert.equal(recheck.originalStatus, 'failed'); assert.equal(recheck.recheckPassed, false);
  assert.equal(recheck.revision, new Journal(f.directory, broken.runId).state().revision);
  passed.push('failed checks cannot be repaired by resume or overwritten by verify');

  const makeHalf = value => testTask({
    goal: 'Fill two independent, non-autosaving fixture fields',
    steps: [{ kind: 'fill', selector: '#name', value, safeToRepeat: true }, { kind: 'fill', selector: '#other', valueFromEnv: 'FE2E_TEST_INPUT', safeToRepeat: true }],
    checks: [{ kind: 'value', selector: '#name', value }, { kind: 'value', selector: '#other', value: 'Continued' }],
    recovery: { restartSafe: true, fields: [{ key: 'name', selector: '#name' }], reconstruct: [
      { kind: 'navigate', value: f.url, safeToRepeat: true },
      { kind: 'fill', selector: '#name', valueFromRecovery: 'name', safeToRepeat: true },
      { kind: 'checkpoint', safeToRepeat: true, checks: [{ kind: 'value', selector: '#name', value }] },
    ] },
  });
  delete process.env.FE2E_TEST_INPUT;
  const half = await run(runTask(makeHalf('Half entered'), true)); assert.equal(half.status, 'blocked', JSON.stringify(half));
  const j = new Journal(f.directory, half.runId); assert.equal(j.state().nextStep, 1); assert.equal(j.recoveryFields().name.value, 'Half entered');
  const conn = await attachPage(f.session, half.targetId); browser = conn.browser;
  await conn.page.reload({ waitUntil: 'domcontentloaded' });
  await assert.rejects(run(resumeRun({ runId: half.runId, expectedRevision: j.state().revision })), /state changed|Requested recovery|frame's live state/i);
  process.env.FE2E_TEST_INPUT = 'Continued';
  const rebuilt = await run(resumeRun({ runId: half.runId, expectedRevision: j.state().revision, mode: 'reconstruct' }));
  assert.equal(rebuilt.status, 'passed', JSON.stringify(rebuilt)); assert.equal(rebuilt.recovered, true); assert.equal(rebuilt.attempts[0].status, 'blocked');
  assert.equal(j.recoveryFields().name.value, 'Half entered');
  await browser.close(); browser = undefined;
  passed.push('same-tab reload is state loss; frozen allowlisted inputs reconstruct through UI');

  delete process.env.FE2E_TEST_INPUT;
  const renderer = await run(runTask(makeHalf('Renderer crash'), true));
  const cdp = await Cdp.open(f.session), sid = await cdp.attach(renderer.targetId);
  await cdp.send('Page.crash', {}, sid).catch(() => {}); await cdp.close();
  process.env.FE2E_TEST_INPUT = 'Continued';
  const rendererResult = await run(resumeRun({ runId: renderer.runId, expectedRevision: new Journal(f.directory, renderer.runId).state().revision, mode: 'reconstruct' }));
  assert.equal(rendererResult.status, 'passed', JSON.stringify(rendererResult));
  const afterCrash = await Cdp.open(f.session);
  assert.equal((await afterCrash.send('Target.getTargets')).targetInfos.some(t => t.targetId === renderer.targetId), false, 'explicit reconstruction retires its abandoned task tab');
  await afterCrash.close(); passed.push('real renderer crash, owned-tab retirement, and explicit reconstruction');

  delete process.env.FE2E_TEST_INPUT;
  const browserCrash = await run(runTask(makeHalf('Browser crash'), true)); const oldId = browserCrash.browserId;
  await f.kill(); f.session = await f.launch(); assert.notEqual(f.session.browserId, oldId);
  const lost = await run(inspectRun({ runId: browserCrash.runId, view: 'page' })); assert.equal(lost.page, null);
  process.env.FE2E_TEST_INPUT = 'Continued';
  const restored = await run(resumeRun({ runId: browserCrash.runId, expectedRevision: new Journal(f.directory, browserCrash.runId).state().revision, mode: 'reconstruct' }));
  assert.equal(restored.status, 'passed', JSON.stringify(restored)); assert.equal(restored.browserId, f.session.browserId);
  passed.push('actual browser termination, generation rebinding, and recovered attempt history');

  delete process.env.FE2E_TEST_INPUT;
  const missing = await run(runTask(makeHalf('Lost input'), true)), missingJournal = new Journal(f.directory, missing.runId);
  fs.rmSync(path.join(missingJournal.dir, 'recovery.json'));
  const c = await Cdp.open(f.session); await c.send('Target.closeTarget', { targetId: missing.targetId }); await c.close();
  await assert.rejects(run(resumeRun({ runId: missing.runId, expectedRevision: missingJournal.state().revision, mode: 'reconstruct' })), /not retained/);
  assert.equal(missingJournal.state().attempts.length, 1);
  const forbidden = await run(runTask(testTask({ steps: [{ kind: 'fill', selector: '#name', value: 'unused' }], checks: [{ kind: 'text', selector: 'h1', value: 'Settings' }], recovery: { fields: [{ key: 'secret', selector: '#password' }] } }), true));
  assert.equal(forbidden.status, 'blocked'); assert.equal(forbidden.execution.reasonCode, 'retention_forbidden');
  assert.deepEqual(new Journal(f.directory, forbidden.runId).recoveryFields(), {});
  passed.push('lost or forbidden inputs block reconstruction without inventing state');

  // Actual Save, then construct the durable boundary left by a lost completion receipt.
  const observed = await run(runTask(testTask({ steps: [{ kind: 'fill', selector: '#name', value: 'Saved once' }], checks: [{ kind: 'value', selector: '#name', value: 'Saved once' }] }), true));
  const attached = await attachPage(f.session, observed.targetId); browser = attached.browser;
  const pendingTask = testTask({ steps: [{ kind: 'click', selector: '#save', checks: [{ kind: 'text', selector: '#status', value: 'Saved: Saved once' }] }, { kind: 'checkpoint', checks: [{ kind: 'value', selector: '#name', value: 'Saved once' }] }], checks: [{ kind: 'text', selector: '#status', value: 'Saved: Saved once' }], recovery: { reconcile: [{ kind: 'text', selector: '#status', value: 'Saved: Saved once' }], reconcileOutcome: 'completed' } });
  const pending = createRun(f.directory, pendingTask, true, f.profile).journal;
  pending.append('target', { targetId: observed.targetId, browserId: f.session.browserId });
  pending.append('attempt.start', { mode: 'new', engine: 'playwright', allocatedMs: 120_000 });
  pending.append('action.start', { id: 'save-lost-receipt', kind: 'click', step: 0, safeToRepeat: false });
  const dispatch = await Cdp.open(f.session);
  try {
    const focused = await dispatch.attach(observed.targetId);
    await dispatch.send('Emulation.setFocusEmulationEnabled', { enabled: true }, focused);
    await attached.page.locator('#save').click();
    await attached.page.locator('#status').getByText('Saved: Saved once', { exact: true }).waitFor();
  } finally { await dispatch.close(); }
  pending.append('attempt.end', { status: 'blocked', reasonCode: 'interrupted', durationMs: 10 });
  const countBefore = f.writes;
  await assert.rejects(run(resumeRun({ runId: pending.runId, expectedRevision: pending.state().revision })), /no replay occurred/);
  const reconciled = await run(verifyRun(pending.runId, true)); assert.equal(reconciled.recheckPassed, true); assert.equal(pending.state().nextStep, 1);
  const continued = await run(resumeRun({ runId: pending.runId, expectedRevision: reconciled.revision }));
  assert.equal(continued.status, 'passed', JSON.stringify(continued)); assert.equal(f.writes, countBefore, 'Save must not run twice');
  await browser.close(); browser = undefined;
  passed.push('actual UI submission, lost receipt, reconciliation, and no duplicate mutation');
  console.log(JSON.stringify({ suite: 'public workflows and crash recovery', passed, paidModelCalls: 0 }));
} finally {
  await browser?.close(); delete process.env.FE2E_TEST_INPUT; await f.cleanup();
}
