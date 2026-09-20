import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import * as fs from 'node:fs';
import { fixture } from './support/chrome.mjs';
import { Cdp } from '../dist/cdp.js';
import { createRun } from '../dist/journal.js';
import { attachPage, pageJob } from '../dist/page-worker.js';

// Real Midscene SDK and browser. Only the HTTP model response is controlled.
const f = await fixture();
let count = 0, phase = 'act', bbox, lastModelImage;
const model = createServer(async (req, res) => {
  let text = ''; for await (const chunk of req) text += chunk;
  const body = JSON.parse(text); count++;
  for (const message of body.messages ?? []) for (const part of Array.isArray(message.content) ? message.content : []) {
    if (part.type === 'image_url' && part.image_url?.url.startsWith('data:image/')) lastModelImage = Buffer.from(part.image_url.url.split(',')[1], 'base64');
  }
  res.setHeader('Content-Type', 'application/json');
  if (phase === 'unauthorized') { res.writeHead(401); res.end(JSON.stringify({ error: { message: 'PRIVATE_PROVIDER_DETAIL' } })); return; }
  const content = phase === 'check'
    ? '<observation>The requested fixture outcome is visible.</observation><data-json>{"Boolean":true}</data-json>'
    : count === 1
      ? '<planning>Tap the canvas.</planning><action-type>Tap</action-type><action-param-json>' + JSON.stringify({ locate: { prompt: 'canvas button', bbox } }) + '</action-param-json>'
      : '<planning>Finished.</planning><complete success="true">Done</complete>';
  res.end(JSON.stringify({ id: 'mock', object: 'chat.completion', created: 1, model: 'mock', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const originalEnv = { ...process.env };
Object.assign(process.env, {
  FASTEST_E2E_VISION_ENABLED: '1', MIDSCENE_MODEL_API_KEY: 'test-only', MIDSCENE_MODEL_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`,
  MIDSCENE_MODEL_NAME: 'mock', MIDSCENE_MODEL_FAMILY: 'gpt-5', MIDSCENE_RUN_DIR: `${f.directory}/midscene`, MIDSCENE_MODEL_RETRY_COUNT: '0',
});
const cdp = await Cdp.open(f.session); let browser;
try {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const connected = await attachPage(f.session, targetId); browser = connected.browser;
  await connected.page.setContent('<h1>Ready</h1><canvas id="canvas" width="120" height="60"></canvas><output></output><script>document.querySelector("canvas").onclick=()=>document.querySelector("output").textContent="Canvas clicked"</script>');
  const rect = await connected.page.locator('#canvas').boundingBox(); bbox = [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height];
  const make = (task = {}) => { const { journal } = createRun(f.directory, { url: f.url, goal: 'Click the canvas', maxModelCalls: 6, ...task }, false, f.profile); journal.append('target', { targetId, browserId: f.session.browserId }); return journal; };
  const job = (j, input) => pageJob({ root: f.directory, runId: j.runId, session: f.session, targetId, timeoutMs: 20_000, ...input }, new AbortController().signal);
  const j = make();
  await job(j, { operation: 'vision', goal: 'Click the canvas button once.' });
  assert.equal(await connected.page.locator('output').innerText(), 'Canvas clicked');
  assert.equal(j.events().filter(e => e.type === 'action.start').length, 1);
  assert.equal(j.events().filter(e => e.type === 'call.start').length, count);
  assert.equal(j.state().pendingAction, null);
  phase = 'check';
  const check = await job(j, { operation: 'checks', checks: [{ kind: 'visual', value: 'Canvas clicked is visible' }] });
  assert.equal(check.results[0].passed, true); assert.equal(check.results[0].method, 'vision');
  const imageRef = check.results[0].evidenceRef;
  const artifact = fs.readdirSync(`${j.dir}/evidence`).find(name => name.startsWith(imageRef) && !name.endsWith('.json'));
  assert.ok(artifact); assert.deepEqual(fs.readFileSync(`${j.dir}/evidence/${artifact}`), lastModelImage);
  const oldCount = count;
  await assert.rejects(job(make({ maxModelCalls: 0 }), { operation: 'checks', checks: [{ kind: 'visual', value: 'Ready is visible' }] }), /budget/i);
  assert.equal(count, oldCount, 'budget exhaustion must stop the HTTP call');
  process.env.FASTEST_E2E_VISION_ENABLED = '0';
  await assert.rejects(job(make(), { operation: 'vision', goal: 'Click once' }), /[Ee]nable vision|vision_disabled/);
  assert.equal(count, oldCount); process.env.FASTEST_E2E_VISION_ENABLED = '1';
  phase = 'unauthorized'; const failed = make();
  await assert.rejects(job(failed, { operation: 'checks', checks: [{ kind: 'visual', value: 'Ready' }] }), error => !String(error).includes('PRIVATE_PROVIDER_DETAIL'));
  assert.equal(count, oldCount + 1, 'provider errors must not be retried');
  assert.equal(failed.state().pendingAction, null);
  console.log(JSON.stringify({ suite: 'Midscene integration', paidModelCalls: 0, controlledProviderCalls: count, passed: ['real visual action loop', 'exact request-image evidence', 'shared model budget', 'disabled vision', 'no provider retry or private error leak'] }));
} finally {
  await browser?.close(); await cdp.close(); await new Promise(resolve => model.close(resolve)); await f.cleanup();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]; Object.assign(process.env, originalEnv);
}
