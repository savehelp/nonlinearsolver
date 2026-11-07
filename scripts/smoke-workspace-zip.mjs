// Run from the project root after building. Uses file:// and never starts an app server.
// Requires Microsoft Edge on Windows and Node.js 22+.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const profile = await mkdtemp(join(tmpdir(), 'nonlinear-workspace-zip-'));
const downloads = join(profile, 'downloads');
await mkdir(downloads);
const browser = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--in-process-gpu', '--disable-gpu',
  '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
], { windowsHide: true, stdio: 'ignore' });
let socket, sequence = 0;
const pending = new Map(), errors = [], remoteRequests = [];

function assert(condition, message) { if (!condition) throw new Error(message); }
async function until(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await pause(100);
  }
  throw new Error(`Timed out: ${label}`);
}
function call(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const response = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  return response.result.value;
}
async function openMenu() {
  if (!await evaluate(`!!document.querySelector('.settings-dropdown')`)) {
    await evaluate(`document.querySelector('[aria-label="Workspace settings"]').click()`);
  }
}
async function clickMenu(label) {
  await openMenu();
  await evaluate(`(() => { const button = [...document.querySelectorAll('.settings-dropdown button')].find(button => button.textContent === ${JSON.stringify(label)}); if (!button) throw new Error('Missing menu item'); button.click(); })()`);
}
async function openImport() {
  if (!await evaluate(`!!document.querySelector('[role="dialog"][aria-label="Import workspace"]')`)) {
    await clickMenu('Import');
  }
  await until(() => evaluate(`!!document.querySelector('[role="dialog"][aria-label="Import workspace"]')`), 'workspace import dialog');
}
async function closeImport() {
  await evaluate(`(() => { const dialog = document.querySelector('[role="dialog"][aria-label="Import workspace"]'); const button = [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Cancel'); if (!button) throw new Error('Missing import Cancel action'); button.click(); })()`);
  await until(() => evaluate(`!document.querySelector('[role="dialog"][aria-label="Import workspace"]')`), 'closing import dialog');
}
async function selectFile(selector, path) {
  if (selector.includes('Workspace ZIP file') || selector.includes('Workspace folder')) await openImport();
  const document = await call('DOM.getDocument');
  const input = await call('DOM.querySelector', { nodeId: document.root.nodeId, selector });
  assert(input.nodeId, `Missing file input: ${selector}`);
  await call('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [path] });
}
async function exportArchive() {
  const previous = new Set(await readdir(downloads));
  await clickMenu('Export ZIP');
  const path = await until(async () => {
    const name = (await readdir(downloads)).find(name => name.endsWith('.zip') && !previous.has(name));
    return name && join(downloads, name);
  }, 'workspace ZIP download');
  return { path, files: unzipSync(new Uint8Array(await readFile(path))) };
}
const parse = bytes => JSON.parse(strFromU8(bytes));
const encode = value => strToU8(JSON.stringify(value, null, 2));
const source = () => evaluate(`document.querySelector('.source-code textarea').value`);
const plotSnapshot = () => evaluate(`JSON.stringify(document.querySelector('.plot').data.map(trace => ({ x: trace.x, y: trace.y, customdata: trace.customdata })))`);
const sampleValues = () => evaluate(`document.querySelector('.plot').data.flatMap(trace => trace.customdata ?? []).filter(point => point?.values?.['M1.id'] !== undefined).map(point => point.values)`);

try {
  const port = await until(async () => {
    try { return (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; }
    catch { return null; }
  }, 'Edge CDP port');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (message.error) waiting.reject(new Error(JSON.stringify(message.error)));
      else waiting.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    if (message.method === 'Network.requestWillBeSent' && /^https?:/.test(message.params.request.url)) remoteRequests.push(message.params.request.url);
  });
  await call('Runtime.enable'); await call('Page.enable'); await call('Network.enable');
  await call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  await call('Page.navigate', { url: pathToFileURL(resolve('dist/index.html')).href });
  await until(() => evaluate(`document.querySelector('.calculation-status')?.textContent === 'Sweep complete'`), 'initial RC solve');
  await openMenu();
  const importActions = await evaluate(`[...document.querySelectorAll('.settings-dropdown button')].filter(button => button.textContent.startsWith('Import')).map(button => ({ label: button.textContent, down: !!button.querySelector('.lucide-arrow-down-to-line') }))`);
  assert(importActions.length === 1 && importActions[0].label === 'Import' && importActions[0].down, 'Import action or icon mismatch');
  assert(await evaluate(`!![...document.querySelectorAll('.settings-dropdown button')].find(button => button.textContent === 'Export ZIP')?.querySelector('.lucide-arrow-up-from-line')`), 'Export icon was not swapped');
  await openImport();
  const accept = await evaluate(`document.querySelector('input[aria-label="Workspace ZIP file"]')?.accept`);
  assert(accept?.includes('.zip') && !accept.includes('.json'), 'Workspace ZIP picker does not select ZIP files');
  assert(await evaluate(`document.querySelector('input[aria-label="Workspace folder"]')?.hasAttribute('webkitdirectory')`), 'Missing extracted-workspace folder picker');
  await closeImport();
  await openMenu();
  await evaluate(`(() => { const select = document.querySelector('[aria-label="Load an example"]'); const option = [...select.options].find(option => option.textContent.includes('bidirectional channel')); if (!option) throw new Error('Missing bidirectional MOS example'); select.value = option.value; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await until(() => evaluate(`document.querySelector('.source-code textarea')?.value.includes('N1.d = left') && document.querySelector('.calculation-status')?.textContent === 'Sweep complete' && document.querySelector('.plot')?.data?.some(trace => trace.customdata?.some(point => point.values?.['P1.channel_vds'] !== undefined))`), 'bidirectional MOS sweep');
  const reversed = await evaluate(`document.querySelector('.plot').data[0].customdata.map(point => point.values)`);
  assert(reversed.length === 41, 'Missing bidirectional sweep samples');
  for (const point of reversed) {
    const low = Math.min(point.left, point.right), high = Math.max(point.left, point.right);
    assert(point['N1.source_voltage'] === low && point['P1.source_voltage'] === high, 'Electrical source did not follow pin voltages');
    for (const name of ['N1', 'P1']) {
      assert(point[`${name}.d`] === point.left && point[`${name}.s`] === point.right, 'Fixed drain/source connection changed during reversal');
      assert(Math.abs(point.delta) < 1e-12 ? Math.abs(point[`${name}.id`]) < 1e-10 : point[`${name}.id`] * point.delta > 0, 'Bidirectional current polarity mismatch');
    }
  }
  await openMenu();
  await evaluate(`(() => { const select = document.querySelector('[aria-label="Load an example"]'); const option = [...select.options].find(option => option.textContent.startsWith('NMOS element')); if (!option) throw new Error('Missing NMOS example'); select.value = option.value; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await until(() => evaluate(`document.querySelector('.source-code textarea')?.value.includes('element NMOSFET M1') && document.querySelector('.calculation-status')?.textContent === 'Sweep complete' && document.querySelector('.plot')?.data?.some(trace => trace.customdata?.some(point => point.values?.['M1.VTH'] === .7))`), 'NMOS example');
  const originalSource = await source();
  const first = await exportArchive();
  const main = parse(first.files['workspace.json']);
  assert(main.format === 'nonlinear-workbench' && main.version === 3, 'Wrong archive workspace format');
  assert(!Object.hasOwn(main, 'elements'), 'Main workspace JSON still embeds element definitions');
  assert(main.tabs[0].source === originalSource, 'Export did not preserve exact editor text');
  assert(main.elementFiles.length === 2 && main.elementFiles.every(path => path.startsWith('elements/') && first.files[path]), 'Missing separate element files');
  const nmosPath = main.elementFiles.find(path => parse(first.files[path]).elements?.[0]?.name === 'NMOSFET');
  assert(nmosPath, 'Missing NMOS JSON file');
  for (const path of main.elementFiles) {
    const library = parse(first.files[path]);
    assert(library.format === 'nonlinear-elements' && library.version === 1 && library.elements.length === 1, 'Element file is not reusable library JSON');
  }

  const modified = { ...first.files };
  const nmos = parse(modified[nmosPath]);
  nmos.elements[0].parameters.VTO.value = .9;
  modified[nmosPath] = encode(nmos);
  main.name = 'Edited ZIP workspace';
  main.tabs[0].source = '# Imported with its separate NMOS model\n' + originalSource;
  modified['workspace.json'] = encode(main);
  const editedPath = join(profile, 'edited-workspace.zip');
  await writeFile(editedPath, zipSync(modified));
  await selectFile('input[aria-label="Workspace ZIP file"]', editedPath);
  await until(() => evaluate(`document.querySelector('.calculation-status')?.textContent === 'Sweep complete' && document.querySelector('.plot')?.data?.some(trace => trace.customdata?.some(point => point.values?.['M1.VTH'] === .9))`), 'separate NMOS model import');
  assert(await source() === main.tabs[0].source, 'ZIP import changed source text');
  const importedPoints = await sampleValues();
  assert(importedPoints.length === 134 && importedPoints.every(point => point['M1.VTH'] === .9 && point['M1.VTO'] === .9), 'Imported model did not supply every NMOS sample');
  await clickMenu('Save workspace');
  const saved = await evaluate(`JSON.parse(localStorage.getItem('node-workbench-v2'))`);
  assert(saved.version === 2 && saved.name === main.name && saved.elements.find(element => element.name === 'NMOSFET').parameters.VTO.value === .9, 'Browser save did not retain imported model');
  await evaluate('location.reload()');
  await until(() => evaluate(`document.querySelector('.calculation-status')?.textContent === 'Sweep complete' && document.querySelector('.plot')?.data?.some(trace => trace.customdata?.some(point => point.values?.['M1.VTH'] === .9))`), 'ZIP workspace browser-save reload');

  await clickMenu('Elements');
  const entries = await evaluate(`[...document.querySelectorAll('.element-definition')].map(section => ({ name: section.querySelector('h3').textContent, origin: section.querySelector('.element-origin').dataset.origin }))`);
  assert(entries.some(entry => entry.name === 'NMOSFET' && entry.origin === 'replacement') && entries.some(entry => entry.name === 'PMOSFET' && entry.origin === 'default'), 'Model manager does not reflect archive definitions');
  const gain = { format: 'nonlinear-elements', version: 1, elements: [{ name: 'ArchiveGain', terminals: ['input'], parameters: { gain: { value: 3 } }, equations: ['output = gain*input'] }] };
  const gainPath = join(profile, 'gain.json');
  await writeFile(gainPath, JSON.stringify(gain));
  const elementAccept = await evaluate(`document.querySelector('input[aria-label="Element JSON file"]').accept`);
  assert(elementAccept.includes('.json') && !elementAccept.includes('.zip'), 'Individual element file picker no longer selects JSON');
  await selectFile('input[aria-label="Element JSON file"]', gainPath);
  await until(() => evaluate(`!!document.querySelector('[aria-label="ArchiveGain element definition"]')`), 'individual element JSON import');
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await until(() => evaluate(`document.querySelector('.calculation-status')?.textContent === 'Sweep complete'`), 'solve after individual element import');
  const second = await exportArchive();
  const secondMain = parse(second.files['workspace.json']);
  assert(secondMain.elementFiles.length === 3, 'ZIP export dropped an unused imported element');
  const exportedNmos = secondMain.elementFiles.map(path => parse(second.files[path]).elements[0]).find(element => element.name === 'NMOSFET');
  assert(exportedNmos.parameters.VTO.value === .9 && secondMain.name === main.name, 'ZIP re-export changed imported model or workspace');
  const sourceBeforeInvalid = await source(), plotBeforeInvalid = await plotSnapshot();
  const invalid = { ...second.files };
  delete invalid[secondMain.elementFiles[0]];
  const invalidPath = join(profile, 'missing-element.zip');
  await writeFile(invalidPath, zipSync(invalid));
  await selectFile('input[aria-label="Workspace ZIP file"]', invalidPath);
  await until(() => evaluate(`!!document.querySelector('[role="dialog"][aria-label="Import workspace"] [role="alert"]')`), 'missing element import error');
  assert(await source() === sourceBeforeInvalid && await plotSnapshot() === plotBeforeInvalid, 'Failed ZIP import replaced the current workspace or plotted results');
  await closeImport();
  await clickMenu('Save workspace');
  const savedAfterInvalid = await evaluate(`JSON.parse(localStorage.getItem('node-workbench-v2'))`);
  assert(savedAfterInvalid.name === main.name && savedAfterInvalid.elements.find(element => element.name === 'NMOSFET').parameters.VTO.value === .9, 'Failed ZIP import changed model parameters');

  const extracted = join(profile, 'extracted-workspace');
  await mkdir(extracted);
  const folderFiles = { ...second.files };
  const folderMain = parse(folderFiles['workspace.json']);
  folderMain.name = 'Edited folder workspace';
  folderMain.tabs[0].source = '# Imported as an extracted workspace folder\n' + originalSource;
  folderFiles['workspace.json'] = encode(folderMain);
  const folderNmos = parse(folderFiles[nmosPath]);
  folderNmos.elements[0].parameters.VTO.value = .95;
  folderFiles[nmosPath] = encode(folderNmos);
  for (const [relative, contents] of Object.entries(folderFiles)) {
    const destination = join(extracted, ...relative.split('/'));
    assert(resolve(destination).startsWith(resolve(extracted) + '\\'), 'Extracted test path escaped its temporary folder');
    await mkdir(resolve(destination, '..'), { recursive: true });
    await writeFile(destination, contents);
  }
  await selectFile('input[aria-label="Workspace folder"]', extracted);
  await until(() => evaluate(`!document.querySelector('[role="dialog"][aria-label="Import workspace"]') && document.querySelector('.calculation-status')?.textContent === 'Sweep complete' && document.querySelector('.plot')?.data?.some(trace => trace.customdata?.some(point => point.values?.['M1.VTH'] === .95))`), 'extracted workspace folder import');
  assert(await source() === folderMain.tabs[0].source, 'Folder import changed source text');
  const folderPoints = await sampleValues();
  assert(folderPoints.length === 134 && folderPoints.every(point => point['M1.VTO'] === .95 && point['M1.VTH'] === .95), 'Folder import did not apply its separate NMOS JSON');
  assert(await evaluate(`Number(document.querySelector('input[aria-label="M1.VTO fixed value"]')?.value) === .95`), 'Folder import did not update the model parameter control');
  const third = await exportArchive();
  const thirdMain = parse(third.files['workspace.json']);
  const thirdNmos = thirdMain.elementFiles.map(path => parse(third.files[path]).elements[0]).find(element => element.name === 'NMOSFET');
  assert(thirdMain.name === folderMain.name && thirdMain.tabs[0].source === folderMain.tabs[0].source && thirdNmos.parameters.VTO.value === .95, 'Folder-to-ZIP roundtrip changed the workspace or model');
  assert(thirdMain.elementFiles.length === 3, 'Folder import dropped an unused custom element');

  const droppedFiles = { ...third.files };
  const droppedMain = parse(droppedFiles['workspace.json']);
  droppedMain.name = 'Dropped ZIP workspace';
  droppedMain.tabs[0].source = '# Imported by dropping a workspace ZIP\n' + originalSource;
  droppedFiles['workspace.json'] = encode(droppedMain);
  const droppedNmosPath = droppedMain.elementFiles.find(path => parse(droppedFiles[path]).elements[0].name === 'NMOSFET');
  const droppedNmos = parse(droppedFiles[droppedNmosPath]);
  droppedNmos.elements[0].parameters.VTO.value = .97;
  droppedFiles[droppedNmosPath] = encode(droppedNmos);
  const droppedBytes = zipSync(droppedFiles);
  await openImport();
  await evaluate(`(() => { const target = document.querySelector('[aria-label="Workspace import drop area"]'); if (!target) throw new Error('Missing workspace drop area'); const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(${JSON.stringify([...droppedBytes])})], 'dropped-workspace.zip', { type: 'application/zip' })); target.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true })); target.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true })); })()`);
  await until(() => evaluate(`!document.querySelector('[role="dialog"][aria-label="Import workspace"]') && document.querySelector('.calculation-status')?.textContent === 'Sweep complete' && document.querySelector('.plot')?.data?.some(trace => trace.customdata?.some(point => point.values?.['M1.VTH'] === .97))`), 'automatic ZIP drag/drop import');
  assert(await source() === droppedMain.tabs[0].source, 'ZIP drag/drop changed source text');
  const droppedPoints = await sampleValues();
  assert(droppedPoints.length === 134 && droppedPoints.every(point => point['M1.VTO'] === .97), 'ZIP drag/drop did not apply its model');

  const droppedFolderMain = parse(folderFiles['workspace.json']);
  droppedFolderMain.name = 'Dropped folder workspace';
  droppedFolderMain.tabs[0].source = '# Imported by dropping an extracted workspace folder\n' + originalSource;
  const droppedFolderNmos = parse(folderFiles[nmosPath]);
  droppedFolderNmos.elements[0].parameters.VTO.value = .99;
  await writeFile(join(extracted, 'workspace.json'), encode(droppedFolderMain));
  await writeFile(join(extracted, ...nmosPath.split('/')), encode(droppedFolderNmos));
  await openImport();
  const dropPoint = await evaluate(`(() => { const rect = document.querySelector('[aria-label="Workspace import drop area"]').getBoundingClientRect(); return { x: rect.x + rect.width/2, y: rect.y + rect.height/2 }; })()`);
  const folderDrag = { items: [], files: [extracted], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await call('Input.dispatchDragEvent', { type, ...dropPoint, data: folderDrag });
  await until(() => evaluate(`!document.querySelector('[role="dialog"][aria-label="Import workspace"]') && document.querySelector('.calculation-status')?.textContent === 'Sweep complete' && document.querySelector('.plot')?.data?.some(trace => trace.customdata?.some(point => point.values?.['M1.VTH'] === .99))`), 'automatic native folder drag/drop import');
  assert(await source() === droppedFolderMain.tabs[0].source, 'Folder drag/drop changed source text');
  const droppedFolderPoints = await sampleValues();
  assert(droppedFolderPoints.length === 134 && droppedFolderPoints.every(point => point['M1.VTO'] === .99), 'Folder drag/drop did not apply its model');
  assert(errors.length === 0 && remoteRequests.length === 0, JSON.stringify({ errors, remoteRequests }));
  console.log(JSON.stringify({ fileURL: await evaluate('location.href'), zipEntries: Object.keys(third.files), bidirectionalSamples: reversed.length, sourceDrainSwapping: true, samples: importedPoints.length / 2, editedModelThreshold: .9, folderSamples: folderPoints.length / 2, folderModelThreshold: .95, folderToZipRoundtrip: true, zipDropAutodetect: true, droppedModelThreshold: .97, nativeFolderDropAutodetect: true, droppedFolderModelThreshold: .99, importExportIcons: true, browserSaveReload: true, individualElementJSON: true, failedImportPreservesWorkspace: true, runtimeErrors: errors.length, externalRequests: remoteRequests.length }));
} catch (error) {
  console.error(error);
  if (socket?.readyState === WebSocket.OPEN) {
    console.error(JSON.stringify({ body: await evaluate('document.body.innerText').catch(() => ''), errors }));
  }
  process.exitCode = 1;
} finally {
  socket?.close(); browser.kill(); await pause(500);
  const temporaryRoot = resolve(tmpdir()) + '\\';
  if (resolve(profile).startsWith(temporaryRoot) && basename(profile).startsWith('nonlinear-workspace-zip-')) {
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}
