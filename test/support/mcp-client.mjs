import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
export async function mcpClient() {
  const child=spawn(process.execPath,['dist/cli.js','mcp'],{stdio:'pipe'});const pending=new Map();let next=0, diagnostics='';
  child.stderr.on('data',c=>diagnostics+=c);const closed=new Promise(r=>child.once('close',r));
  const lines=createInterface({input:child.stdout});lines.on('line',line=>{let response;try{response=JSON.parse(line)}catch{throw new Error(`MCP emitted non-JSON: ${line}`)}const waiter=pending.get(response.id);if(waiter){pending.delete(response.id);waiter(response)}});
  const request=(method,params)=>new Promise((resolve,reject)=>{const id=++next;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`MCP timeout: ${diagnostics}`))},15000);pending.set(id,r=>{clearTimeout(timer);resolve(r)});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')});
  await request('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'integration-test',version:'1'}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  return {request,async close(){child.kill('SIGTERM');await closed;lines.close()}};
}
