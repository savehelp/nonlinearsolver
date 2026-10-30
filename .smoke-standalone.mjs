import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = await mkdtemp(join(tmpdir(), 'nonlinear-standalone-'));
const browser = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--in-process-gpu', '--disable-gpu',
  '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
], { windowsHide: true, stdio: 'ignore' });
let socket;
let dev;
const pending = new Map(), errors = [], network = [];
let nextId = 0;
async function until(check, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check(); if (value) return value;
    await pause(100);
  }
  throw new Error(`Timed out: ${message}`);
}
async function call(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const response = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
  return response.result.value;
}
const plotData = `(() => {
  const plot = document.querySelector('.plot');
  return { status: document.querySelector('.calculation-status')?.textContent,
    runs: window.__runs, workers: window.__workers,
    traces: (plot?.data || []).map(trace => ({ x: Array.from(trace.x || []), y: Array.from(trace.y || []),
      values: (trace.customdata || []).filter(Boolean).map(point => ({x:point.values.x,y:point.values.y,a:point.values.a,b:point.values.b})) })) };
})()`;
try {
  const port = await until(async () => {
    try { return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { return false; }
  }, 'browser startup');
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = pages.find(item => item.type === 'page');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id); pending.delete(message.id);
      if (request) message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') errors.push(message.params.entry);
    else if (message.method === 'Network.requestWillBeSent') network.push(message.params.request.url);
  });
  await call('Runtime.enable'); await call('Page.enable'); await call('Log.enable'); await call('Network.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__runs=0; window.__workers=[];
    const BrowserWorker=window.Worker;
    window.Worker=class extends BrowserWorker {
      constructor(url,options){ super(url,options); window.__workers.push(String(url)); }
      postMessage(message,...rest){ if(message?.type==='run') window.__runs++; return super.postMessage(message,...rest); }
    };
  ` });
  await call('Page.navigate', { url: pathToFileURL(resolve('dist/index.html')).href });
  await until(() => evaluate(`document.querySelector('.calculation-status')?.textContent === 'Sweep complete' && document.querySelector('.plot')?.data?.some(trace=>trace.x?.length>0)`), 'starter solve');
  const starter = await evaluate(plotData);
  if (starter.traces.some(trace => trace.values.some(point => Math.abs(point.y-point.x)>1e-8))) throw new Error('Starter plot mismatch');
  if (!starter.workers.every(url => url.startsWith('blob:') || url.startsWith('data:'))) throw new Error('Worker fetched external source');
  console.log(JSON.stringify({ stage: 'starter', status: starter.status, runs: starter.runs, points: starter.traces.reduce((sum,t)=>sum+t.x.length,0), workers: starter.workers }));
  const config = {
    name: 'Offline sweep test', description: '', equations: 'y = a*x+b;', constraints: '', regions: [],
    variables: [{ name:'y',kind:'unknown',value:1 },{ name:'x',kind:'parameter',value:0,step:1,min:-2,max:2 },
      { name:'a',kind:'parameter',value:1,step:1,min:0,max:2 },{ name:'b',kind:'parameter',value:0,step:1,min:0,max:1 }],
    documents: [{ id:'model', title:'Model', source:'unknown y 1\nparameter x 0 1 -2 2 sweep\nparameter a 1 1 0 2 sweep\nparameter b 0 1 0 1 sweep\ny = a*x+b;' }],
    sweep: { parameter:'x',min:-2,max:2,points:5,step:1,startAt:0,logarithmic:false,mode:'free',release:'',
      secondary:{parameter:'a',min:0,max:2,points:3,step:1,startAt:1,logarithmic:false},
      additional:[{parameter:'b',min:0,max:1,points:2,step:1,startAt:0,logarithmic:false}] },
    axes:{x:'x',y:'y'},solver:{tolerance:1e-9,iterations:100,starts:12},
  };
  await evaluate(`localStorage.setItem('node-workbench-v1', ${JSON.stringify(JSON.stringify(config))}); location.reload();`);
  await until(() => evaluate(`document.querySelector('.calculation-status')?.textContent === '6 slices complete' && document.querySelector('.plot')?.data?.some(trace=>trace.x?.length>0)`), 'multidimensional sweep');
  const before = await evaluate(plotData);
  for (const [parameter, value] of [['a',2],['b',1]]) {
    await evaluate(`(() => { const el=document.querySelector('input[aria-label="${parameter} slice slider"]'); if(!el)throw new Error('Missing slider'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(String(value))}); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  }
  await until(() => evaluate(`document.querySelector('.plot')?.data?.some(trace=>trace.customdata?.some(point=>point?.values?.a===2&&point.values.b===1))`), 'slice switching');
  const after = await evaluate(plotData);
  if (after.runs !== before.runs) throw new Error('Slice switching restarted computation');
  if (after.traces.some(trace => trace.values.some(point => Math.abs(point.y-(2*point.x+1))>1e-8))) throw new Error('Switched slice plot mismatch');
  console.log(JSON.stringify({ stage:'multidimensional',status:after.status,runs:after.runs,points:after.traces.reduce((sum,t)=>sum+t.x.length,0),slice:await evaluate(`document.querySelector('.slice-summary')?.textContent`) }));
  await evaluate(`document.querySelector('.plot').emit('plotly_click',{points:[{customdata:document.querySelector('.plot').data[0].customdata[0]}]});`);
  await until(() => evaluate(`!!document.querySelector('[aria-label="Operating point inspector"]')`), 'point inspector');
  const downloadPath=join(profile,'downloads'); await mkdir(downloadPath);
  await call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath});
  await evaluate(`document.querySelector('[aria-label="Workspace settings"]').click()`);
  await until(()=>evaluate(`!!document.querySelector('.settings-dropdown')`),'settings');
  await evaluate(`[...document.querySelectorAll('.settings-dropdown button')].find(button=>button.textContent==='Export JSON').click()`);
  const exportedPath=await until(async()=>{const files=await readdir(downloadPath);const file=files.find(file=>file.endsWith('.json'));return file&&join(downloadPath,file)},'JSON export');
  const exported=JSON.parse(await readFile(exportedPath,'utf8'));
  if(exported.name!==config.name || exported.sweep.additional?.length!==1) throw new Error('Exported workspace mismatch');
  exported.name='Imported offline'; exported.documents[0].source=exported.documents[0].source.replace('y = a*x+b;','y = a*x+b+7;');
  const importPath=join(profile,'import.json'); await writeFile(importPath,JSON.stringify(exported));
  const document=await call('DOM.getDocument');
  const input=await call('DOM.querySelector',{nodeId:document.root.nodeId,selector:'input[type="file"]'});
  await call('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[importPath]});
  await until(()=>evaluate(`document.querySelector('.calculation-status')?.textContent === '6 slices complete' && document.querySelector('.plot')?.data?.some(trace=>trace.customdata?.some(point=>point?.values?.y===point.values.x+7))`),'JSON import');
  const remoteRequests=network.filter(url=>/^https?:/.test(url));
  if (errors.length || remoteRequests.length) throw new Error(JSON.stringify({errors,remoteRequests}));
  console.log(JSON.stringify({stage:'complete',fileURL:await evaluate('location.href'),errors:errors.length,remoteRequests:remoteRequests.length,inspector:true,jsonRoundtrip:true}));
  const {createServer}=await import('vite');
  dev=await createServer({server:{host:'127.0.0.1',port:0,strictPort:true}}); await dev.listen();
  const address=dev.httpServer.address();
  await call('Page.navigate',{url:`http://127.0.0.1:${address.port}/`});
  await until(() => evaluate(`document.querySelector('.calculation-status')?.textContent === 'Sweep complete' && document.querySelector('.plot')?.data?.some(trace=>trace.x?.length>0)`), 'development solve');
  const development=await evaluate(plotData);
  if(development.traces.some(trace=>trace.values.some(point=>Math.abs(point.y-point.x)>1e-8)))throw new Error('Development plot mismatch');
  if(errors.length)throw new Error(JSON.stringify(errors));
  console.log(JSON.stringify({stage:'development',status:development.status,workers:development.workers,errors:errors.length}));
} catch(error) {
  console.error(error);
  if (socket?.readyState === WebSocket.OPEN) console.error(JSON.stringify({body:await evaluate('document.body.innerText').catch(()=>''),data:await evaluate(plotData).catch(()=>null),errors}));
  process.exitCode=1;
} finally {
  socket?.close(); browser.kill();
  await dev?.close();
  await pause(500);
  if (resolve(profile).startsWith(resolve(tmpdir())+'\\') && profile.includes('nonlinear-standalone-')) await rm(profile,{recursive:true,force:true}).catch(()=>{});
}
