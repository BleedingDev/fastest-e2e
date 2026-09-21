import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connect, findChrome } from '../../dist/host.js';

export async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fe2e-fixture-'));
  const previous = process.env.FASTEST_E2E_HOME;
  process.env.FASTEST_E2E_HOME = directory;
  const profile = path.join(directory, 'chrome'); await fs.mkdir(profile);
  const chromePath = await findChrome();
  await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({ version: 1, profileDir: profile, chromeExecutable: chromePath }), { mode: 0o600 });
  let writes = 0;
  const route = (req,res) => {
    res.setHeader('Content-Type','text/html; charset=utf-8');
    if (req.url.startsWith('/save')) { writes++; res.end('saved'); return; }
    if (req.url.startsWith('/recovery-race')) { res.end(`<!doctype html><html><body>
      <h1>Recovery race</h1><input id="public" class="active-input" value="public-sentinel"><input id="token">
      <script>
        let switched=false;
        const patch=proto=>{const original=proto.querySelectorAll;proto.querySelectorAll=function(selector){
          const result=original.call(this,selector);
          if(selector==='.active-input'&&!switched&&document.querySelector('#token').value){
            switched=true;document.querySelector('#public').classList.remove('active-input');document.querySelector('#token').classList.add('active-input');
          }
          return result;
        }};
        patch(Document.prototype);patch(Element.prototype);patch(ShadowRoot.prototype);
      </script></body></html>`); return; }
    if (req.url.startsWith('/protected-replacement-race')) { res.end(`<!doctype html><html><body>
      <h1>Protected replacement race</h1><input id="public" class="active-input" value="public-sentinel"><input id="token">
      <script>
        let replaced=false;
        const original=Document.prototype.querySelectorAll;
        Document.prototype.querySelectorAll=function(selector){
          const result=original.call(this,selector);
          if(selector==='#token'&&!replaced&&document.querySelector('#token').value){
            replaced=true;
            const current=document.querySelector('#token'),next=current.cloneNode(true);
            next.classList.add('active-input');document.querySelector('#public').classList.remove('active-input');current.replaceWith(next);
          }
          return result;
        };
      </script></body></html>`); return; }
    if (req.url.startsWith('/nested')) { res.end('<h2>Nested</h2><input id="nestedName"><button onclick="document.querySelector(\'output\').textContent=\'Nested saved\'">Save</button><output></output>'); return; }
    if (req.url.startsWith('/frame')) { res.end(`<h2>Remote frame</h2><input id="frameName"><button id="frameSave" onclick="document.querySelector('output').textContent='Frame saved'">Save</button><output></output><iframe id="nested" src="${url}/nested"></iframe>`); return; }
    res.end(`<!doctype html><html><head><title>Fixture</title><style>body{font:16px sans-serif}input,button{margin:8px}iframe{width:600px;height:210px}canvas{border:1px solid}</style></head><body>
      <h1>Settings</h1><input id="name" name="displayName"><button id="save">Save</button><output role="status" id="status"></output>
      <input id="other"><input type="password" id="password"><input autocomplete="one-time-code" id="otp"><input id="file" type="file">
      <input id="check" type="checkbox"><select id="select"><option value="a">Alpha</option><option value="b">Beta</option></select>
      <span id="hidden" style="display:none">invisible</span><open-host></open-host><closed-host></closed-host>
      <iframe id="remote" src="http://localhost:${other.address().port}/frame"></iframe>
      <a id="popup" href="/nested" target="_blank">Open popup</a><canvas id="canvas" width="100" height="40"></canvas><output id="canvasResult"></output>
      <script>
        nameInput=document.querySelector('#name');nameInput.value=localStorage.getItem('name')||'';
        document.querySelector('#save').onclick=async()=>{const value=nameInput.value;await fetch('/save?name='+encodeURIComponent(value));localStorage.setItem('name',value);document.querySelector('#status').textContent='Saved: '+value};
        for(const mode of ['open','closed']){const r=document.querySelector(mode+'-host').attachShadow({mode});r.innerHTML='<label>'+mode+'<input id="shadowInput"></label><button id="shadowSave">Save shadow</button><output id="shadowResult"></output>';r.querySelector('button').onclick=()=>r.querySelector('output').textContent=r.querySelector('input').value;}
        const c=document.querySelector('canvas'),ctx=c.getContext('2d');ctx.fillText('Canvas button',5,25);c.onclick=()=>document.querySelector('#canvasResult').textContent='Canvas clicked';
      </script></body></html>`);
  };
  const server = createServer(route), other = createServer(route);
  await new Promise(r => other.listen(0,r)); await new Promise(r => server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${server.address().port}`;
  let child;
  const alive = () => child && child.exitCode === null && child.signalCode === null;
  async function kill() {
    if (!alive()) return;
    const closed = new Promise(resolve => child.once('close', resolve));
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    let timer;
    try { await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 2_000); })]); }
    finally { clearTimeout(timer); }
  }
  async function launch() {
    if (alive()) throw new Error('Stop the fixture browser before launching another process for this profile');
    await fs.rm(path.join(profile, 'DevToolsActivePort'), { force: true });
    let diagnostic = '', spawnError;
    child = spawn(chromePath, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--headless=new', '--no-first-run', '--no-default-browser-check', '--site-per-process', '--window-size=1280,900', ...(process.getuid?.()===0 ? ['--no-sandbox'] : []), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-8_192); });
    child.once('error', error => { spawnError = error; });
    const deadline = Date.now() + 30_000;
    let last;
    while (Date.now() < deadline && alive() && !spawnError) {
      try { return await connect(); } catch (error) { last = error; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await kill();
    throw new Error(`Fixture Chrome failed readiness: ${spawnError?.message ?? last?.message ?? 'process exited'}\n${diagnostic}`);
  }
  async function cleanup() {
    await kill();
    for (const s of [server, other]) s.closeAllConnections();
    await Promise.all([new Promise(r => server.close(r)), new Promise(r => other.close(r))]);
    if (previous === undefined) delete process.env.FASTEST_E2E_HOME;
    else process.env.FASTEST_E2E_HOME = previous;
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
  let session;
  try { session = await launch(); } catch (error) { await cleanup(); throw error; }
  return { directory, profile, session, url, get writes(){return writes}, launch, kill, cleanup };
}
