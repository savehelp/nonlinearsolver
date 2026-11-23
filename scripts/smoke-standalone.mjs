// Run from the project root after building; requires Microsoft Edge on Windows.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deepStrictEqual } from 'node:assert/strict';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = await mkdtemp(join(tmpdir(), 'nonlinear-standalone-'));
const screenshots = process.argv.includes('--screenshots') ? await mkdtemp(join(tmpdir(), 'nonlinear-preview-')) : null;
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
async function capture(name) {
  if (!screenshots) return;
  const { data } = await call('Page.captureScreenshot', { format: 'png' });
  const path = join(screenshots, name + '.png');
  await writeFile(path, Buffer.from(data, 'base64'));
  console.log(JSON.stringify({ screenshot: path }));
}
async function doubleClick(selector) {
  const { x, y } = await evaluate(`(() => { const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()`);
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (const clickCount of [1, 2]) {
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount });
  }
}
async function checkPanelDividers() {
  if (await evaluate(`!!document.querySelector('.panel-collapse-toggle')`)) throw new Error('Obsolete collapse arrows are visible');
  for (const [axis, key] of [['editor', 'ArrowRight'], ['parameters', 'ArrowUp']]) {
    await evaluate(`document.querySelector('.divider-${axis}').dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', shiftKey: true, bubbles: true }))`);
  }
  const sizes = await evaluate(`JSON.parse(localStorage.getItem('node-panel-layout-v1'))`);
  for (const axis of ['editor', 'parameters']) {
    await doubleClick(`.divider-${axis}`);
    await until(() => evaluate(`!!document.querySelector('.${axis}-collapsed .expand-${axis}')`), `${axis} double-click collapse`);
  }
  await capture('collapsed-panels');
  await evaluate('location.reload()');
  await until(() => evaluate(`!!document.querySelector('.editor-collapsed.parameters-collapsed') && document.querySelector('.calculation-status')?.textContent === 'Sweep complete'`), 'remembered panel collapse');
  for (const axis of ['editor', 'parameters']) {
    await evaluate(`document.querySelector('.expand-${axis}').click()`);
    await until(() => evaluate(`!!document.querySelector('.divider-${axis}')`), `${axis} expansion`);
  }
  const restored = await evaluate(`JSON.parse(localStorage.getItem('node-panel-layout-v1'))`);
  if (restored.editor !== sizes.editor || restored.parameters !== sizes.parameters) throw new Error('Panel sizes were reset on collapse');
  for (const [axis, key] of [['editor', 'Enter'], ['parameters', ' ']]) {
    await evaluate(`document.querySelector('.divider-${axis}').dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true }))`);
    await until(() => evaluate(`!!document.querySelector('.expand-${axis}')`), `${axis} keyboard collapse`);
    await evaluate(`document.querySelector('.expand-${axis}').click()`);
  }
  await until(() => evaluate(`(() => { const plot = document.querySelector('.plot'), svg = plot?.querySelector('.main-svg'), rect = plot?.getBoundingClientRect(); return svg && Math.abs(Number(svg.getAttribute('width')) - rect.width) < 1 && Math.abs(Number(svg.getAttribute('height')) - rect.height) < 1; })()`), 'plot resize after reopening panels');
  console.log(JSON.stringify({ stage: 'panels', doubleClickCollapse: true, keyboardCollapse: true, sizesPreserved: true }));
}
async function editModelSource(source) {
  await evaluate(`(() => { const input = document.querySelector('textarea[aria-label="Model source"]'); if (!input) throw new Error('Missing model editor'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(source)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
}
async function checkPlotCommands(source) {
  if (await evaluate(`!!document.querySelector('.plot-panel input:not([type="checkbox"])')`)) throw new Error('Obsolete axis fields are visible');
  const labels = await evaluate(`document.querySelector('.plot').data.map(trace => trace.name)`);
  if (JSON.stringify(labels) !== JSON.stringify(['y', 'y^2'])) throw new Error('Plot commands did not produce both curves');
  await editModelSource(source.replace('plot y^2', 'plot y*1000'));
  await until(() => evaluate(`document.querySelector('.plot')?.data?.[1]?.name === 'y*1000' && document.querySelector('.plot').data[1].y.every((value, index) => Math.abs(value - document.querySelector('.plot').data[0].y[index]*1000) < 1e-8)`), 'Y expression refresh');
  await editModelSource(source.replace('set_time_axis x', 'set_time_axis a'));
  await until(() => evaluate(`document.querySelector('.plot')?.data?.length === 2 && document.querySelector('.plot').data.every(trace => trace.x?.length && trace.x.every((value, index) => value === trace.customdata[index].values.a))`), 'X parameter refresh');
  await editModelSource(source); await waitForGrid(5);
  for (const [description, invalid] of [
    ['conflicting X declarations', source + '\nset_time_axis a'],
    ['unswept X parameter', source.replace('set_time_axis x', 'set_time_axis gain')],
    ['incomplete plot command', source + '\nplot ('],
  ]) {
    const runs = await evaluate('window.__runs');
    await editModelSource(invalid);
    await until(() => evaluate(`!!document.querySelector('#workspace-source-error')?.textContent && !(document.querySelector('.plot')?.data || []).some(trace => trace.x?.length)`), description);
    await pause(300);
    if (await evaluate('window.__runs') !== runs) throw new Error('Invalid plot command started a calculation');
    await editModelSource(source);
    await waitForGrid(5);
  }
  console.log(JSON.stringify({ stage: 'plot-commands', multipleCurves: true, axisAndExpressionEdits: true, invalidSourceRecovery: true }));
}
async function waitForGrid(points) {
  await until(() => evaluate(`!document.querySelector('#workspace-source-error')?.textContent && document.querySelector('.calculation-status')?.textContent === '6 slices complete' && document.querySelector('.plot')?.data?.length === 2 && document.querySelector('.plot').data.every(trace => trace.x?.length === ${points})`), `${points}-point grid`);
}
async function checkResampling(source) {
  const previousRuns = await evaluate('window.__runs');
  await editModelSource(source.replace('parameter x 0 1 -2 2 sweep', 'parameter x 0 2 -2 2 sweep'));
  await waitForGrid(3);
  await editModelSource(source.replace('parameter x 0 1 -2 2 sweep', 'parameter x 0 0.5 -2 2 sweep'));
  await waitForGrid(9);
  await editModelSource(source); await waitForGrid(5);
  if (await evaluate('window.__runs') !== previousRuns + 3) throw new Error('Sweep metadata changes did not start the expected calculations');
  console.log(JSON.stringify({ stage: 'resampling', mainSampleCounts: [3, 9, 5] }));
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
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__runs=0; window.__workers=[];
    const BrowserWorker=window.Worker;
    window.Worker=class extends BrowserWorker {
      constructor(url,options){
        super(url,options); window.__workers.push(String(url));
      }
      postMessage(message,...rest){
        if (message?.type === 'run') window.__runs++;
        return super.postMessage(message,...rest);
      }
    };
  ` });
  await call('Page.navigate', { url: pathToFileURL(resolve('dist/index.html')).href });
  await until(() => evaluate(`document.querySelector('.calculation-status')?.textContent === 'Sweep complete' && document.querySelector('.plot')?.data?.some(trace=>trace.x?.length>0)`), 'starter solve');
  const starter = await evaluate(plotData);
  if (starter.traces.some(trace => trace.values.some(point => Math.abs(point.y-point.x)>1e-8))) throw new Error('Starter plot mismatch');
  if (!starter.workers.every(url => url.startsWith('blob:') || url.startsWith('data:'))) throw new Error('Worker fetched external source');
  console.log(JSON.stringify({ stage: 'starter', status: starter.status, runs: starter.runs, points: starter.traces.reduce((sum,t)=>sum+t.x.length,0), workers: starter.workers }));
  await checkPanelDividers();
  await capture('desktop');
  const config = {
    format: 'nonlinear-workbench', version: 2, name: 'Offline sweep test', description: '',
    tabs: [
      { id:'model', title:'Model', source:'# preserve the model\nunknown y 1\nparameter x 0 1 -2 2 sweep\nparameter gain 2 0.1 0 5\ny = a*x+b;\nset_time_axis x\nplot y\nplot y^2' },
      { id:'inputs', title:'Other inputs', source:'parameter a 1 1 0 2 sweep\n\nparameter b 0 1 0 1 sweep\n# keep this comment' },
    ],
    settings: { sweep: { mode:'free', parameter:'x' }, solver:{tolerance:1e-9,iterations:100,starts:12} },
  };
  await evaluate(`localStorage.setItem('node-workbench-v2', ${JSON.stringify(JSON.stringify(config))}); location.reload();`);
  await until(() => evaluate(`document.querySelector('.calculation-status')?.textContent === '6 slices complete' && document.querySelector('.plot')?.data?.some(trace=>trace.x?.length>0)`), 'multidimensional sweep');
  await checkPlotCommands(config.tabs[0].source);
  await checkResampling(config.tabs[0].source);
  const before = await evaluate(plotData);
  for (const parameter of ['a', 'b']) {
    await evaluate(`document.querySelector('input[aria-label="${parameter} slice slider"]').focus()`);
    await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
  }
  await until(() => evaluate(`document.querySelector('.plot')?.data?.some(trace=>trace.customdata?.some(point=>point?.values?.a===2&&point.values.b===1))`), 'slice switching');
  const after = await evaluate(plotData);
  if (after.runs !== before.runs) throw new Error('Slice switching restarted computation');
  if (after.traces.some((trace, index) => trace.y.some((y, point) => Math.abs(y - (2 * trace.x[point] + 1) ** (index + 1)) > 1e-8))) throw new Error('Switched slice plot mismatch');
  console.log(JSON.stringify({ stage:'multidimensional',status:after.status,runs:after.runs,points:after.traces.reduce((sum,t)=>sum+t.x.length,0),slice:await evaluate(`document.querySelector('.slice-summary')?.textContent`) }));
  await evaluate(`document.querySelector('.plot').emit('plotly_click',{points:[{customdata:document.querySelector('.plot').data[0].customdata[0]}]});`);
  await until(() => evaluate(`!!document.querySelector('[aria-label="Operating point inspector"]')`), 'point inspector');
  const downloadPath=join(profile,'downloads'); await mkdir(downloadPath);
  await call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath});
  await evaluate(`document.querySelector('[aria-label="Workspace settings"]').click()`);
  await until(()=>evaluate(`!!document.querySelector('.settings-dropdown')`),'settings');
  await evaluate(`[...document.querySelectorAll('.settings-dropdown button')].find(button=>button.textContent==='Export ZIP').click()`);
  const exportedPath=await until(async()=>{const files=await readdir(downloadPath);const file=files.find(file=>file.endsWith('.zip'));return file&&join(downloadPath,file)},'ZIP export');
  const entries=unzipSync(await readFile(exportedPath));
  const exported=JSON.parse(strFromU8(entries['workspace.json']));
  if(exported.name!==config.name || exported.version!==3 || !Array.isArray(exported.elementFiles) || exported.elements || JSON.stringify(exported.tabs)!==JSON.stringify(config.tabs) || exported.variables || exported.equations || exported.settings.axes) throw new Error('Exported workspace mismatch');
  exported.name='Imported offline'; exported.tabs[0].source=exported.tabs[0].source.replace('y = a*x+b;','y = a*x+b+7;');
  entries['workspace.json']=strToU8(JSON.stringify(exported));
  const importPath=join(profile,'import.zip'); await writeFile(importPath,zipSync(entries));
  await evaluate(`document.querySelector('[aria-label="Workspace settings"]').click()`);
  await until(()=>evaluate(`!!document.querySelector('.settings-dropdown')`),'settings before import');
  await evaluate(`[...document.querySelectorAll('.settings-dropdown button')].find(button=>button.textContent==='Import').click()`);
  await until(()=>evaluate(`!!document.querySelector('input[aria-label="Workspace ZIP file"]')`),'workspace import panel');
  const document=await call('DOM.getDocument');
  const input=await call('DOM.querySelector',{nodeId:document.root.nodeId,selector:'input[aria-label="Workspace ZIP file"]'});
  await call('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[importPath]});
  await until(()=>evaluate(`document.querySelector('.calculation-status')?.textContent === '6 slices complete' && document.querySelector('.plot')?.data?.some(trace=>trace.customdata?.some(point=>point?.values?.y===point.values.x+7))`),'ZIP import');
  await evaluate(`document.querySelector('[aria-label="Workspace settings"]').click()`);
  await evaluate(`[...document.querySelectorAll('.settings-dropdown button')].find(button=>button.textContent==='Save workspace').click()`);
  const saved = await evaluate(`JSON.parse(localStorage.getItem('node-workbench-v2'))`);
  const {elementFiles,...main}=exported;
  deepStrictEqual(saved,{...main,version:2,elements:elementFiles.flatMap(path=>JSON.parse(strFromU8(entries[path])).elements)});
  await evaluate(`location.reload()`);
  await until(()=>evaluate(`document.querySelector('.calculation-status')?.textContent === '6 slices complete' && document.querySelector('.plot')?.data?.some(trace=>trace.customdata?.some(point=>point?.values?.y===point.values.x+7))`),'saved workspace reload');
  await capture('multiple-tabs');
  await evaluate(`document.querySelector('[aria-label="Workspace settings"]').click()`);
  await evaluate(`[...document.querySelectorAll('.settings-dropdown button')].find(button=>button.textContent==='Graph settings').click()`);
  await capture('graph-settings');
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await pause(300);
  await capture('mobile');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const remoteRequests=network.filter(url=>/^https?:/.test(url));
  if (errors.length || remoteRequests.length) throw new Error(JSON.stringify({errors,remoteRequests}));
  console.log(JSON.stringify({stage:'complete',fileURL:await evaluate('location.href'),errors:errors.length,remoteRequests:remoteRequests.length,inspector:true,zipRoundtrip:true}));
  if (process.argv.includes('--dev')) {
  const {createServer}=await import('vite');
  dev=await createServer({server:{host:'127.0.0.1',port:5174,strictPort:false}}); await dev.listen();
  const address=dev.httpServer.address();
  await call('Page.navigate',{url:`http://127.0.0.1:${address.port}/`});
  await until(() => evaluate(`document.querySelector('.calculation-status')?.textContent === 'Sweep complete' && document.querySelector('.plot')?.data?.some(trace=>trace.x?.length>0)`), 'development solve');
  const development=await evaluate(plotData);
  if(await evaluate(`!!document.querySelector('.plot-panel input:not([type="checkbox"])')`))throw new Error('Development view still has obsolete axis fields');
  if(development.traces.some(trace=>trace.values.some(point=>Math.abs(point.y-point.x)>1e-8)))throw new Error('Development plot mismatch');
  if(errors.length)throw new Error(JSON.stringify(errors));
  console.log(JSON.stringify({stage:'development',status:development.status,workers:development.workers,errors:errors.length}));
  }
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
