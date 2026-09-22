import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { fixture } from './support/chrome.mjs';
import { Cdp } from '../dist/cdp.js';
import { createRun, atomic } from '../dist/journal.js';
import { attachPage, pageJob } from '../dist/page-worker.js';

const key = 'FE2E_RERENDER_SECRET', secret = 'synthetic-private-123';
const formatted = [...secret].join(' '), previous = process.env[key];
process.env[key] = secret;
const f = await fixture(), raw = await Cdp.open(f.session), passed = [];
const worker = fileURLToPath(new URL('../worker', import.meta.url));
function assertPrivate(journal) {
  for (const entry of fs.readdirSync(journal.dir, { recursive: true })) {
    const file = path.join(journal.dir, entry);
    if (fs.statSync(file).isFile()) {
      const text = fs.readFileSync(file, 'utf8');
      assert.equal(text.includes(secret), false, entry);
      assert.equal(text.includes(formatted), false, entry);
    }
  }
}
function checkJevHandoff(journal) {
  // A fresh Python adapter must honor the durable Node suspension even without
  // the original environment. Any capture evaluation would fail this test.
  const env = { ...process.env }; delete env[key];
  execFileSync('python3', ['-c', `import sys
sys.path.insert(0, sys.argv[1])
from jev_runner import Journal, capture
class Page:
    def evaluate(self, expression):
        raise AssertionError('Suspended Jev recovery must not evaluate the page')
capture(Page(), Journal(sys.argv[2], sys.argv[3]))
`, worker, f.directory, journal.runId], { env, timeout: 10_000 });
}
async function scenario(name, variant, reconstruct, check) {
  const { targetId } = await raw.send('Target.createTarget', { url: 'about:blank' });
  const connection = await attachPage(f.session, targetId);
  try {
    const page = connection.page;
    await page.goto(f.url, { waitUntil: 'load' });
    await page.setContent(`<input id="public" class="active-input" value="safe-before"><input id="token"><input id="safe" value="safe-before">
      <script>document.querySelector('#token').oninput=event=>{
        const node=event.target,value=[...node.value].join(' ');
        if(${JSON.stringify(variant)}==='mirror') document.querySelector('#public').value=value;
        else {
          document.querySelector('#public').classList.remove('active-input');
          const next=${JSON.stringify(variant)}==='replace'?node.cloneNode(true):node;
          next.id='renamed';next.classList.add('active-input');next.value=value;
          if(next!==node)node.replaceWith(next);
        }
      };</script>`);
    const step = { kind: 'fill', selector: '#token', valueFromEnv: key };
    const task = { url: f.url, goal: name, steps: [step], recovery: {
      fields: [{ key: 'public', selector: '.active-input' }, { key: 'safe', selector: '#safe' }],
      ...(reconstruct ? { reconstruct: [{ kind: 'navigate', value: f.url, safeToRepeat: true }, { ...step, safeToRepeat: true }] } : {}),
    } };
    const { journal } = createRun(f.directory, task, false, f.profile);
    journal.append('target', { targetId, browserId: f.session.browserId });
    atomic(path.join(f.directory, 'targets', f.session.namespace, `${targetId}.json`), { targetId, browserId: f.session.browserId });
    const invoke = (operation = 'capture', extra = {}) => pageJob({
      root: f.directory, runId: journal.runId, session: f.session, targetId,
      operation, steps: [step], timeoutMs: 20_000, ...extra,
    }, new AbortController().signal);
    await invoke();
    await check({ page, journal, step, invoke });
    assertPrivate(journal); checkJevHandoff(journal);
    passed.push(name);
  } finally {
    await connection.browser.close(); await raw.send('Target.closeTarget', { targetId });
  }
}
try {
  for (const variant of ['retag', 'replace', 'mirror']) for (const reconstruct of [false, true]) {
    await scenario(`Formatted ${variant} value is not retained; reconstruct=${reconstruct}`, variant, reconstruct,
      async ({ page, journal, invoke }) => {
        await invoke('steps', reconstruct ? { saveProgress: false } : {});
        assert.equal(await page.locator('.active-input').inputValue(), formatted);
        const retained = journal.recoveryFields();
        assert.equal(retained.public.value, 'safe-before');
        assert.equal(retained.public.source, 'observed');
        const events = journal.events();
        const boundary = events.find(e => e.type === 'recovery.capture_suspended');
        assert.ok(boundary);
        assert.ok(boundary.seq < events.find(e => e.type === 'action.start').seq);
        // Reattachment, a later capture and loss of the env value cannot undo suspension.
        delete process.env[key];
        try { await invoke(); await invoke(); } finally { process.env[key] = secret; }
        assert.deepEqual(journal.recoveryFields(), retained);
        assert.equal(journal.events().filter(e => e.type === 'recovery.capture_suspended').length, 1);
      });
  }
  await scenario('Explicit public inputs remain recoverable after secret dispatch', 'mirror', false,
    async ({ journal, step, invoke }) => {
      await invoke('steps', { steps: [step, { kind: 'fill', selector: '#safe', value: 'user-provided-public' }] });
      assert.equal(journal.recoveryFields().safe.value, 'user-provided-public');
      assert.equal(journal.recoveryFields().safe.source, 'intent');
      assert.equal(journal.recoveryFields().public.value, 'safe-before');
    });
  await scenario('Legacy dispatch without provenance suspends capture on resume', 'mirror', false,
    async ({ page, journal, invoke }) => {
      journal.append('action.start', { id: 'legacy', kind: 'fill', selector: '#token', step: 0, engine: 'playwright' });
      await page.locator('#token').fill(secret);
      journal.append('action.end', { id: 'legacy' });
      delete process.env[key];
      try { await invoke(); } finally { process.env[key] = secret; }
      assert.equal(journal.recoveryFields().public.value, 'safe-before');
      assert.ok(journal.events().some(e => e.type === 'recovery.capture_suspended'));
    });
} finally {
  await raw.close(); await f.cleanup();
  if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
}
console.log(JSON.stringify({ suite: 'environment retention across dispatch and handoff', passed, paidModelCalls: 0 }));
