import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { fixture } from './support/chrome.mjs';
import { Cdp } from '../dist/cdp.js';
import { createRun, atomic } from '../dist/journal.js';
import { attachPage, pageJob, checkOne } from '../dist/page-worker.js';

// All secrets and hostile pages in this suite are synthetic and local.
const key = 'FE2E_CAPTURE_PRIVATE_INPUT', previous = process.env[key];
const secret = 'capture-secret-not-for-other-documents';
process.env[key] = secret;
const f = await fixture(), raw = await Cdp.open(f.session);
const passed = [], failures = [];
const retentionError = error => error?.code === 'retention_forbidden';

function assertNotRetained(journal, value = secret) {
  for (const file of fs.readdirSync(journal.dir, { recursive: true })) {
    const full = path.join(journal.dir, file);
    if (fs.statSync(full).isFile()) assert.equal(fs.readFileSync(full, 'utf8').includes(value), false, file);
  }
}
async function scenario(name, task, markup, check) {
  const { targetId } = await raw.send('Target.createTarget', { url: 'about:blank' });
  const connection = await attachPage(f.session, targetId);
  try {
    const page = connection.page;
    page.setDefaultTimeout(5_000);
    await page.goto(f.url, { waitUntil: 'load' });
    const remoteUrl = await page.locator('#remote').getAttribute('src');
    await page.setContent(typeof markup === 'function' ? markup(remoteUrl) : markup);
    const input = { url: f.url, goal: name, ...task };
    const { journal } = createRun(f.directory, input, false, f.profile);
    journal.append('target', { targetId, browserId: f.session.browserId });
    atomic(path.join(f.directory, 'targets', f.session.namespace, `${targetId}.json`), { targetId, browserId: f.session.browserId });
    const invoke = (operation = 'capture', extra = {}) => pageJob({
      root: f.directory, runId: journal.runId, session: f.session, targetId,
      operation, steps: input.steps, timeoutMs: 20_000, ...extra,
    }, new AbortController().signal);
    await check({ page, journal, invoke });
    passed.push(name);
  } catch (error) {
    failures.push(name);
    console.error(`${name}: ${error.stack ?? error}`);
  } finally {
    await connection.browser.close();
    await raw.send('Target.closeTarget', { targetId });
  }
}
async function watchEvaluationArrays(page) {
  await page.evaluate(() => {
    globalThis.evaluatedStrings = [];
    const original = Array.prototype.includes;
    Array.prototype.includes = function (...args) {
      for (let i = 0; i < this.length; i++) if (typeof this[i] === 'string') globalThis.evaluatedStrings.push(this[i]);
      return Reflect.apply(original, this, args);
    };
  });
}
const futurePage = remoteUrl => `<h1>Before frame</h1><input id="public" value="keep me"><button id="reveal">Open frame</button>
  <script>document.querySelector('#reveal').onclick=()=>{const frame=document.createElement('iframe');frame.id='late';frame.src=${JSON.stringify(remoteUrl)};document.body.append(frame)};</script>`;
try {
  for (const scope of ['same document', 'other origin']) {
    await scenario(`No environment values enter recovery evaluations: ${scope}`, {
      steps: [{ kind: 'fill', selector: '#token', valueFromEnv: key, ...(scope === 'other origin' ? { frames: ['#remote'] } : {}) }],
      recovery: { fields: [{ key: 'public', selector: '#public' }] },
    }, remote => `<input id="public" value="public value"><input id="token"><iframe id="remote" src="${remote}"></iframe>`, async ({ page, journal, invoke }) => {
      await watchEvaluationArrays(page);
      await invoke();
      assert.equal((await page.evaluate(() => globalThis.evaluatedStrings)).includes(secret), false, 'Unrelated page learned an environment secret');
      assert.equal(journal.recoveryFields().public.value, 'public value');
      assertNotRetained(journal);
    });
  }
  await scenario('Host-side comparison rejects a reflected environment value', {
    steps: [{ kind: 'fill', selector: '#frameName', frames: ['#remote'], valueFromEnv: key }],
    recovery: { fields: [{ key: 'public', selector: '#public' }] },
  }, remote => `<input id="public"><iframe id="remote" src="${remote}"></iframe>`, async ({ page, journal, invoke }) => {
    // Simulate a value the site already knows. It must not be persisted as public input.
    await page.locator('#public').fill(secret);
    await watchEvaluationArrays(page);
    await assert.rejects(() => invoke(), retentionError);
    assert.equal((await page.evaluate(() => globalThis.evaluatedStrings)).includes(secret), false);
    assert.deepEqual(journal.recoveryFields(), {});
    assertNotRetained(journal);
  });

  for (const retain of [false, true]) for (const nested of [false, true]) {
    const frames = nested ? ['#late', '#nested'] : ['#late'];
    const selector = nested ? '#nestedName' : '#frameName';
    await scenario(`Future ${nested ? 'nested ' : ''}frame does not block its creation; recovery=${retain}`, {
      steps: [{ kind: 'click', selector: '#reveal' }, { kind: 'fill', selector, frames, valueFromEnv: key }],
      ...(retain ? { recovery: { fields: [{ key: 'public', selector: '#public' }] } } : {}),
    }, futurePage, async ({ page, journal, invoke }) => {
      await invoke('steps');
      let scope = page;
      for (const frame of frames) scope = scope.frameLocator(frame);
      assert.equal(await scope.locator(selector).inputValue(), secret);
      assert.equal(journal.events().filter(e => e.type === 'action.start').length, 2);
      if (retain) assert.equal(journal.recoveryFields().public.value, 'keep me');
      assertNotRetained(journal);
    });
  }
  for (const reconstruct of [false, true]) {
    const steps = [{ kind: 'click', selector: '#reveal' }, { kind: 'fill', selector: '#frameName', frames: ['iframe#late'], valueFromEnv: key }];
    await scenario(`Late-frame aliases are rejected before secret dispatch; reconstruct=${reconstruct}`, {
      steps: reconstruct ? [] : steps,
      recovery: { fields: [{ key: 'private', selector: 'input#frameName', frames: ['#late'] }], ...(reconstruct ? { reconstruct: steps } : {}) },
    }, futurePage, async ({ journal, invoke }) => {
      await assert.rejects(() => invoke('steps', { steps, ...(reconstruct ? { saveProgress: false } : {}) }), retentionError);
      assert.equal(journal.events().some(e => e.type === 'action.start' && e.data.kind === 'click'), true, 'Frame creation should be allowed');
      assert.equal(journal.events().some(e => e.type === 'action.start' && e.data.kind === 'fill'), false);
      assert.deepEqual(journal.recoveryFields(), {});
      assertNotRetained(journal);
    });
  }
  await scenario('A future reconstruction-only scope does not block navigation', {
    steps: [{ kind: 'click', selector: '#reveal' }],
    recovery: { fields: [{ key: 'public', selector: '#public' }], reconstruct: [{ kind: 'fill', selector: '#frameName', frames: ['#late'], valueFromEnv: key }] },
  }, futurePage, async ({ journal, invoke }) => {
    await invoke('steps');
    assert.equal(journal.recoveryFields().public.value, 'keep me');
    assertNotRetained(journal);
  });

  for (const type of ['password', 'file', 'otp']) for (const protectedTarget of [false, true]) {
    const getterSecret = `synthetic-${type}-getter-value`;
    await scenario(`Sensitive ${type} getter is never invoked; protected locator=${protectedTarget}`, {
      steps: protectedTarget ? [{ kind: 'fill', selector: '#other', valueFromEnv: key }] : [],
      recovery: { fields: [{ key: 'private', selector: '#private' }] },
    }, `<input id="private" ${type === 'otp' ? 'autocomplete="one-time-code"' : `type="${type}"`}><input id="other">`, async ({ page, journal, invoke }) => {
      await page.evaluate(value => {
        globalThis.valueReads = 0;
        const node = document.querySelector('#private');
        Object.defineProperty(node, 'value', { configurable: true, get() {
          globalThis.valueReads++; node.removeAttribute('type'); node.removeAttribute('autocomplete'); return value;
        } });
      }, getterSecret);
      let error;
      try { await invoke(); } catch (caught) { error = caught; }
      assert.equal(await page.evaluate(() => globalThis.valueReads), 0, 'Classification must happen before the value getter');
      assert.equal(error?.code, 'retention_forbidden');
      assert.deepEqual(journal.recoveryFields(), {});
      assertNotRetained(journal, getterSecret);
    });
  }
  await scenario('An environment-protected getter is not read', {
    steps: [{ kind: 'fill', selector: 'input#token', valueFromEnv: key }],
    recovery: { fields: [{ key: 'private', selector: '#token' }] },
  }, '<input id="token">', async ({ page, journal, invoke }) => {
    await page.evaluate(() => { globalThis.valueReads = 0; Object.defineProperty(document.querySelector('#token'), 'value', { get() { globalThis.valueReads++; return 'must-not-read'; } }); });
    await assert.rejects(() => invoke(), retentionError);
    assert.equal(await page.evaluate(() => globalThis.valueReads), 0);
    assert.deepEqual(journal.recoveryFields(), {});
  });

  for (const [label, frames, markup] of [
    ['ambiguous', ['.ambiguous'], '<input id="public"><iframe class="ambiguous"></iframe><iframe class="ambiguous"></iframe>'],
    ['non-frame', ['#notAFrame'], '<input id="public"><div id="notAFrame"></div>'],
    ['invalid selector', ['['], '<input id="public">'],
  ]) {
    await scenario(`Invalid protected scopes still fail closed: ${label}`, {
      steps: [{ kind: 'fill', selector: '#token', frames, valueFromEnv: key }],
      recovery: { fields: [{ key: 'public', selector: '#public' }] },
    }, markup, async ({ journal, invoke }) => {
      await assert.rejects(() => invoke());
      assert.deepEqual(journal.recoveryFields(), {});
    });
  }
  await scenario('Required assertion scopes remain strict', { steps: [] }, '<h1>No iframe</h1>', async ({ page }) => {
    await assert.rejects(() => checkOne(page, { kind: 'count', frames: ['#missing'], selector: 'input', value: '0' }), error => error.code === 'unsupported_scope');
    assert.equal((await checkOne(page, { kind: 'visible', selector: '#missing', value: 'false' })).passed, true);
  });

  const publicFields = Array.from({ length: 8 }, (_, i) => ({ key: `public${i}`, selector: `#public${i}` }));
  await scenario('Protected frame traversal is shared within, not across, snapshots', {
    steps: Array.from({ length: 20 }, (_, i) => ({ kind: 'fill', valueFromEnv: key,
      selector: i % 2 ? '#nestedName' : '#frameName', frames: i % 2 ? ['#remote', '#nested'] : ['#remote'] })),
    recovery: { fields: publicFields },
  }, remote => publicFields.map((_, i) => `<input id="public${i}" value="public-${i}">`).join('') + `<iframe id="remote" src="${remote}"></iframe>`, async ({ page, journal, invoke }) => {
    // Count real frame-path lookups, not timing: added fields/duplicate steps
    // must not multiply browser round trips. The second snapshot must be fresh.
    const prototype = Object.getPrototypeOf(page.mainFrame()), original = prototype.locator;
    let queries = 0;
    prototype.locator = function (selector, ...options) {
      if (selector === 'css:light=#remote' || selector === 'css:light=#nested') queries++;
      return Reflect.apply(original, this, [selector, ...options]);
    };
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        queries = 0;
        await invoke();
        assert.equal(queries, 3, 'Resolve the two distinct paths once each per snapshot');
        assert.equal(Object.keys(journal.recoveryFields()).length, 8);
      }
    } finally { prototype.locator = original; }
    assertNotRetained(journal);
  });
} finally {
  await raw.close(); await f.cleanup();
  if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
}
console.log(JSON.stringify({ suite: 'recovery capture review regressions', passed, failures, paidModelCalls: 0 }));
assert.equal(failures.length, 0, `${failures.length} recovery-capture regressions failed`);
