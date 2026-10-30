import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowDownToLine, ArrowUpFromLine, BookOpen, Check, Layers, Maximize2, Play, Plus, RotateCcw, Save, Settings2, SlidersHorizontal, X } from 'lucide-react';
import type { Configuration, EditorDocument, Point, SweepResult, Variable } from './core/types';
import { examples, starter, clone, validateImport } from './examples';
import Plot from './Plot';
import Workspace from './Workspace';
import WorkspaceEditor from './WorkspaceEditor';
import { migrateUnknownBounds } from './core/constraints';
import { updateVariable, reconcileSweep, sliceSweeps } from './core/variables';
import { compileDocuments, ensureDocuments, syncDocumentVariables } from './core/documents';
import { migrateEquationInputs } from './core/workspaceSyntax';
import { SweepRunner } from './core/sweepRunner';
import SolverWorker from './core/worker?worker&inline';
import { configForCombination, multiSweepPlan, type MultiSweepPlan } from './core/doubleSweep';
import { migrateParameterSweepSettings, normalizeSweep } from './core/sweepPlan';
import SweepSettings from './SweepSettings';
import SolverSettings from './SolverSettings';
import DiagnosticsPanel from './DiagnosticsPanel';
import SettingsDialog, { type SettingsPane } from './SettingsDialog';
import PointInspector from './PointInspector';
import { formatValue as fmt } from './format';
import ParameterSliders from './ParameterSliders';
import GraphSettings from './GraphSettings';
import { DEFAULT_GRAPH_VIEW, type GraphView } from './graphView';
import { formatSampleCount, sampleProduct } from './core/sweepCounts';
import { withPointJacobian } from './core/pointDiagnostics';
const STORAGE = 'node-workbench-v1';
const GRAPH_STORAGE = 'node-workbench-graph-view-v1';
function readyConfiguration(config: Configuration): Configuration {
  migrateUnknownBounds(config); reconcileSweep(config, false); migrateParameterSweepSettings(config); migrateEquationInputs(config);
  const documents = ensureDocuments(config);
  try { config = compileDocuments(config, documents); } catch { /* Keep saved drafts visible for correction. */ }
  return normalizeSweep(config);
}
function documentError(config: Configuration): string {
  try { compileDocuments(config, config.documents ?? []); return ''; }
  catch (reason) { return reason instanceof Error ? reason.message : 'Check the editor tabs.'; }
}
function initial(): Configuration { try { const saved = localStorage.getItem(STORAGE); return readyConfiguration(saved ? validateImport(JSON.parse(saved)) : clone(starter)); } catch { return readyConfiguration(clone(starter)); } }
function initialGraphView(): GraphView {
  try {
    const saved = JSON.parse(localStorage.getItem(GRAPH_STORAGE) || '{}');
    const scale = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(25, Math.min(400, value)) : 100;
    return { xScale: scale(saved?.xScale), yScale: scale(saved?.yScale), revision: 0 };
  } catch { return { ...DEFAULT_GRAPH_VIEW }; }
}
function inputsKey(config: Configuration): string {
  return JSON.stringify({ equations: config.equations, variables: config.variables, constraints: config.constraints, sweep: config.sweep, axes: config.axes, solver: config.solver });
}
interface SweepSlice { result: SweepResult | null; error?: string }
// Slice results are immutable. A keyed store avoids copying the whole grid for
// every completed combination; React receives small progress snapshots instead.
interface MultiSweepData { config: Configuration; key: string; plan: MultiSweepPlan; slices: Map<number, SweepSlice>; readyCount: number; failedCount: number; complete: boolean; elapsed: number }
export default function App() {
  const [config, setConfig] = useState<Configuration>(initial), [singleResult, setResult] = useState<SweepResult | null>(null), [computed, setComputed] = useState<Configuration | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [help, setHelp] = useState(false), [settings, setSettings] = useState(false), [settingsPane, setSettingsPane] = useState<SettingsPane | null>(null);
  const [sourceError, setSourceError] = useState(() => documentError(config));
  const [graphView, setGraphView] = useState<GraphView>(initialGraphView);
  const [selected, setSelected] = useState<Point | null>(null), [overlay, setOverlay] = useState<{ result: SweepResult; config: Configuration } | null>(null);
  const [auto, setAuto] = useState(true), [revision, setRevision] = useState(0); const file = useRef<HTMLInputElement>(null), lastRun = useRef(0);
  const [completed, setCompleted] = useState(0), [singleComplete, setResultComplete] = useState(false);
  const [dataset, setDataset] = useState<MultiSweepData | null>(null), [sliceIndices, setSliceIndices] = useState<number[]>([]);
  const datasetRef = useRef<MultiSweepData | null>(null);
  const publishDataset = (next: MultiSweepData | null) => { datasetRef.current = next; setDataset(next); };
  const [preview, setPreview] = useState<{ index: number; result: SweepResult; completed: number } | null>(null);
  const configKey = inputsKey(config), dimensions = sliceSweeps(config), secondary = dimensions[0];
  const datasetCurrent = !!secondary && dataset?.key === configKey;
  const sliceIndex = useMemo(() => datasetCurrent ? dataset.plan.indexOf(dataset.plan.dimensions.map((dimension, index) =>
    Math.max(0, Math.min(dimension.plan.values.length - 1, sliceIndices[index] ?? dimension.plan.startIndex)))) : 0, [datasetCurrent, dataset?.plan, sliceIndices]);
  const activeSlice = datasetCurrent ? dataset.slices.get(sliceIndex) : undefined;
  const activePreview = datasetCurrent && preview?.index === sliceIndex ? preview : null;
  const result = secondary ? activeSlice?.result ?? activePreview?.result ?? null : singleResult;
  const resultComplete = secondary ? !!activeSlice?.result : singleComplete;
  const readySlices = datasetCurrent ? dataset.readyCount : 0;
  const failedSlices = datasetCurrent ? dataset.failedCount : 0;
  const totalSlices = datasetCurrent ? dataset.plan.totalSlices : sampleProduct(dimensions.map(dimension => Math.max(0, dimension.points)));
  const runner = useRef<SweepRunner | null>(null);
  if (!runner.current) runner.current = new SweepRunner(
    () => new SolverWorker(),
    event => {
      setError('');
      if (event.type === 'pending') { setBusy(true); setCompleted(0); setPreview(null); setSelected(null); }
      else if (event.type === 'error') { setBusy(false); setError(event.error); setResult(null); publishDataset(null); setPreview(null); setComputed(event.config); setCompleted(0); setResultComplete(false); setSelected(null); }
      else if (event.type === 'result') { setBusy(!event.complete); setResult(event.result); setComputed(event.config); setCompleted(event.completed); setResultComplete(event.complete); }
      else if (event.type === 'slice') {
        if (!event.complete) setPreview({ index: event.index, result: event.result, completed: event.completed });
        else {
          setPreview(null);
          const current = datasetRef.current;
          if (current && current.key === inputsKey(event.config)) {
            const previous = current.slices.get(event.index);
            current.slices.set(event.index, { result: event.result });
            publishDataset({ ...current, readyCount: current.readyCount + (previous ? 0 : 1), failedCount: current.failedCount - (previous?.error ? 1 : 0) });
          }
        }
      } else if (event.type === 'slice-error') {
        setPreview(null);
        const current = datasetRef.current;
        if (current && current.key === inputsKey(event.config)) {
          const previous = current.slices.get(event.index);
          current.slices.set(event.index, { result: null, error: event.error });
          publishDataset({ ...current, readyCount: current.readyCount + (previous ? 0 : 1), failedCount: current.failedCount + (previous?.error ? 0 : 1) });
        }
      } else {
        setBusy(false); setPreview(null);
        const current = datasetRef.current;
        if (current && current.key === inputsKey(event.config)) publishDataset({ ...current, complete: true, elapsed: event.elapsed });
      }
    });
  const menu = useRef<HTMLDivElement>(null);
  const [numericErrors, setNumericErrors] = useState<Record<string, string>>({});
  const [numericRevertError, setNumericRevertError] = useState('');
  const [editorReset, setEditorReset] = useState(0);
  const clearNumericRevertError = useCallback(() => setNumericRevertError(''), []);
  const numericValidity = useCallback((id: string, message: string | null) => setNumericErrors(current => {
    if (message === current[id] || (!message && !(id in current))) return current;
    const next = { ...current }; if (message) next[id] = message; else delete next[id]; return next;
  }), []);
  const currentError = sourceError || Object.values(numericErrors)[0] || numericRevertError || error || activeSlice?.error;
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (menu.current && !menu.current.contains(event.target as Node)) setSettings(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setSettings(false); setSettingsPane(null); setHelp(false); setSelected(null); menu.current?.querySelector<HTMLButtonElement>('.settings-trigger')?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, []);
  const change = (update: (c: Configuration) => void) => {
    setNumericRevertError('');
    const next = clone(config); update(next); reconcileSweep(next, false); syncDocumentVariables(next, config);
    if (next.documents?.some((document, index) => document.source !== config.documents?.[index]?.source)) {
      const problem = documentError(next); setSourceError(problem);
      if (problem) { runner.current!.cancel(); setBusy(false); setResult(null); publishDataset(null); setPreview(null); setSelected(null); }
    }
    setConfig(normalizeSweep(next));
  };
  const replaceConfig = (next: Configuration) => { const ready = readyConfiguration(next); setConfig(ready); setSourceError(documentError(ready)); setEditorReset(value => value + 1); setNumericErrors({}); };
  const editDocuments = (documents: EditorDocument[]) => {
    setNumericRevertError('');
    try {
      const next = compileDocuments(config, documents); reconcileSweep(next, false);
      setConfig(normalizeSweep(next)); setSourceError(''); setError('');
    } catch (reason) {
      setConfig(current => ({ ...current, documents }));
      setSourceError(reason instanceof Error ? reason.message : 'Check the editor tabs.');
      runner.current!.cancel(); setBusy(false); setResult(null); publishDataset(null); setPreview(null); setSelected(null);
    }
  };
  const variable = (index: number, update: Partial<Variable>) => change(c => updateVariable(c, index, update, false));
  useEffect(() => {
    const manual = revision !== lastRun.current;
    lastRun.current = revision;
    if (sourceError) { runner.current!.cancel(); setBusy(false); return; }
    if (datasetRef.current?.key !== configKey || !secondary) publishDataset(null); setPreview(null);
    if (secondary) setResult(null);
    if (!auto && !manual) { setBusy(false); return; }
    if (secondary) {
      try {
        const plan = multiSweepPlan(config);
        publishDataset({ config, key: configKey, plan, slices: new Map(), readyCount: 0, failedCount: 0, complete: false, elapsed: 0 });
        setSliceIndices(plan.startIndices);
      } catch { publishDataset(null); /* The worker reports validation errors. */ }
    }
    runner.current!.run(config, manual ? 0 : 220);
    return () => runner.current!.cancel();
  }, [configKey, sourceError, auto, revision]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 4000); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => { try { localStorage.setItem(GRAPH_STORAGE, JSON.stringify({ xScale: graphView.xScale, yScale: graphView.yScale })); } catch { /* View controls still work when browser storage is unavailable. */ } }, [graphView]);
  const parameters = config.variables.filter(v => v.kind === 'parameter');
  const stale = !!sourceError || (secondary ? !datasetCurrent : !computed || inputsKey(computed) !== configKey);
  const sweepStatus = secondary ? (busy ? `Precomputing · ${readySlices}/${formatSampleCount(totalSlices)} slices`
    : !datasetCurrent ? 'Ready to precompute' : !dataset.complete ? 'Precompute stopped'
    : `${formatSampleCount(totalSlices)} slices complete${failedSlices ? ` · ${failedSlices} failed` : result?.failures.length ? ' · partial' : ''}`)
    : busy ? (completed ? `Computing · ${completed}/${config.sweep.points}` : 'Computing')
    : stale ? 'Settings changed' : !result ? 'Ready' : !resultComplete ? 'Sweep stopped'
    : result.failures.length ? `${result.solved}/${result.total} solved · partial` : 'Sweep complete';
  const save = () => { try { localStorage.setItem(STORAGE, JSON.stringify(config)); setNotice('Workspace saved in this browser.'); } catch { setError('Browser storage is unavailable. Export JSON to save your work.'); } };
  const exportJSON = () => { const url = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = `${config.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`; a.click(); URL.revokeObjectURL(url); };
  const load = (index: number) => { replaceConfig(clone(examples[index])); setOverlay(null); setError(''); setNumericRevertError(''); setRevision(v => v + 1); };
  const run = () => { if (!sourceError) setRevision(v => v + 1); };
  const stop = () => { runner.current!.cancel(); setBusy(false); setPreview(null); setSelected(null); };
  const sliceConfig = useMemo(() => dataset ? configForCombination(dataset.config, dataset.plan.valuesAt(sliceIndex)) : null, [dataset?.config, dataset?.plan, sliceIndex]);
  const displayed = secondary ? (datasetCurrent ? sliceConfig ?? config : config) : computed ?? config;
  const inspectPoint = useCallback((point: Point) => {
    try { setSelected(withPointJacobian(displayed, point)); }
    catch (error) { setSelected(point); setNotice(`Jacobian unavailable: ${error instanceof Error ? error.message : 'Calculation failed.'}`); }
  }, [displayed]);
  const chooseSlice = (parameter: string, index: number) => {
    if (!datasetCurrent) return;
    const dimensionIndex = dataset.plan.dimensions.findIndex(dimension => dimension.parameter === parameter);
    if (dimensionIndex < 0) return;
    setSliceIndices(current => dataset.plan.dimensions.map((dimension, offset) => offset === dimensionIndex ? index : current[offset] ?? dimension.plan.startIndex));
    setSelected(null);
  };
  const sliceViews = useMemo(() => datasetCurrent ? Object.fromEntries(dataset.plan.dimensions.map((dimension, index) => [dimension.parameter, {
    values: dimension.plan.values, index: sliceIndices[index] ?? dimension.plan.startIndex,
  }])) : {}, [datasetCurrent, dataset?.plan, sliceIndices]);
  const sliceDescription = datasetCurrent ? Object.entries(dataset.plan.valuesAt(sliceIndex)).map(([name, value]) => `${name} = ${fmt(value)}`).join(' · ') : dimensions.map(dimension => dimension.parameter).filter(Boolean).join(', ');
  return <div className="app-shell">
    <main>
      <input hidden type="file" accept=".json,application/json" ref={file} onChange={async e => { const f = e.target.files?.[0]; if (!f) return; try { if (f.size > 1000000) throw new Error('Please import a JSON file smaller than 1 MB.'); replaceConfig(validateImport(JSON.parse(await f.text()))); setNumericRevertError(''); setRevision(v => v + 1); setOverlay(null); setNotice('Configuration imported.'); } catch (err) { setError((err as Error).message); } e.target.value = ''; }}/>
      {notice && <div className="notice"><Check size={15}/>{notice}</div>}
      <Workspace><section className="editor-panel panel"><WorkspaceEditor documents={config.documents ?? []} resetKey={editorReset} error={sourceError} onChange={editDocuments}/>
      </section>
      <section className="plot-panel panel"><div className="plot-heading"><div className="plot-actions"><label className="check-label"><input type="checkbox" checked={auto} onChange={e => { setAuto(e.target.checked); }}/>Auto-run</label><button className="button primary compact-run" onClick={run} disabled={Boolean(sourceError)}><Play size={12} fill="currentColor"/>{busy ? 'Restart' : 'Run'}</button>{busy && secondary && <button className="button subtle compact-run" onClick={stop}>Stop</button>}<button className={`icon-button ${overlay ? 'selected' : ''}`} title={overlay ? 'Remove overlay' : 'Keep current curve as overlay'} disabled={!result || !resultComplete || busy} onClick={() => setOverlay(overlay ? null : result ? { result, config: clone(displayed) } : null)}><Layers size={16}/></button><button className="icon-button" title="Expand plot" onClick={e => { const panel = e.currentTarget.closest('.plot-panel'); if (document.fullscreenElement) void document.exitFullscreen(); else void panel?.requestFullscreen(); }}><Maximize2 size={15}/></button><div className="workspace-menu" ref={menu}><button className={`icon-button settings-trigger ${settings ? 'selected' : ''}`} aria-label="Workspace settings" aria-expanded={settings} aria-controls="workspace-settings" onClick={() => setSettings(!settings)}><Settings2 size={17}/></button>{settings && <div id="workspace-settings" className="settings-dropdown" role="region" aria-label="Workspace settings menu"><label className="settings-name">Workspace<input aria-label="Workspace name" value={config.name} onChange={e => change(c => { c.name = e.target.value; })}/></label><button onClick={() => { setSettingsPane('diagnostics'); setSettings(false); }}><Activity size={15}/>Diagnostics</button><button onClick={() => { setSettingsPane('sweep'); setSettings(false); }}><SlidersHorizontal size={15}/>Sweep settings</button><button onClick={() => { setSettingsPane('solver'); setSettings(false); }}><Settings2 size={15}/>Solver settings</button><button onClick={() => { setSettingsPane('graph'); setSettings(false); }}><Maximize2 size={15}/>Graph scale</button><div className="menu-divider"/><button onClick={() => { replaceConfig(clone(starter)); setNumericRevertError(''); setOverlay(null); setSettings(false); setRevision(v => v + 1); }}><Plus size={15}/>New equation workspace</button><label className="settings-examples"><BookOpen size={15}/><select aria-label="Load an example" value="" onChange={e => { load(Number(e.target.value)); setSettings(false); }}><option value="" disabled>Load example</option>{examples.map((e, i) => <option key={e.name} value={i}>{e.name}</option>)}</select></label><button onClick={() => { save(); setSettings(false); }}><Save size={15}/>Save workspace</button><button onClick={() => { file.current?.click(); setSettings(false); }}><ArrowUpFromLine size={15}/>Import JSON</button><button onClick={() => { exportJSON(); setSettings(false); }}><ArrowDownToLine size={15}/>Export JSON</button><div className="menu-divider"/><button onClick={() => { setHelp(true); setSettings(false); }}><BookOpen size={15}/>Quick guide</button></div>}</div></div></div>
        <div className="plot-config"><label>X axis<input value={config.axes.x} onChange={e => change(c => { c.axes.x = e.target.value; })}/></label><span className="axis-divider"/><label className="y-axis-control">Y axis<input placeholder="y, y^2, max(y, 0)" title="Separate Y expressions with commas. Commas inside function calls are preserved." value={config.axes.y} onChange={e => change(c => { c.axes.y = e.target.value; })}/></label><span className="plot-config-spacer"/><button className={`calculation-status ${busy ? 'busy' : ''} ${currentError ? 'failed' : result?.failures.length || failedSlices ? 'partial' : ''}`} aria-label={currentError ? 'Open error details' : 'Open sweep diagnostics'} title={currentError ? 'Open error details' : result?.failures[0]?.reason || 'View numerical diagnostics'} onClick={() => setSettingsPane('diagnostics')}><span className="dot"/>{busy || !currentError ? sweepStatus : null}</button></div>
        <>{secondary && <div className="slice-summary"><span>{sliceDescription || 'Slice parameters'}{datasetCurrent ? ` · slice ${sliceIndex + 1}/${formatSampleCount(totalSlices)}` : ' · no computed slices'}</span></div>}</><div className="chart-wrap"><Plot result={result} config={displayed} view={graphView} overlay={overlay} onPoint={inspectPoint}/>{!result?.branches.length && <div className="chart-placeholder">{currentError ? 'No solution plotted. Select the red status for details.' : secondary ? (datasetCurrent ? 'This slice has not been computed yet.' : auto ? 'Waiting for the sweep…' : 'Select Run to compute the slices.') : busy ? 'Finding operating points…' : 'Run a sweep to explore your equations.'}</div>}</div>

      </section>
      <section className="parameters-panel panel"><div className="panel-heading"><Settings2 size={15}/><h3>Parameters</h3><button className="text-button" onClick={() => setSettingsPane('sweep')}>Sweep settings</button><button className="icon-button" title="Reset parameters to example defaults" onClick={() => { const example = [starter, ...examples].find(e => e.name === config.name); if (!example) { setNotice('Load an example to restore its defaults.'); return; } change(c => { c.variables = c.variables.map(v => v.kind === 'parameter' ? clone(example.variables.find(p => p.name === v.name) ?? v) : v); }); }}><RotateCcw size={13}/></button></div><fieldset className="parameter-controls" disabled={Boolean(sourceError)} title={sourceError ? 'Fix the source error to edit parameter controls.' : undefined}><ParameterSliders config={config} parameters={parameters} update={variable} sliceViews={sliceViews} slicesAvailable={datasetCurrent} onSlice={chooseSlice} onValidity={numericValidity} onRevert={setNumericRevertError} onValid={clearNumericRevertError}/></fieldset></section>

      </Workspace>
    </main>

    {settingsPane && <SettingsDialog pane={settingsPane} onPane={setSettingsPane} onClose={() => setSettingsPane(null)}>
      {settingsPane === 'diagnostics' ? <DiagnosticsPanel config={config} result={result} busy={busy} resultComplete={resultComplete} stale={stale} sourceInvalid={Boolean(sourceError)} error={currentError} sliceError={Boolean(activeSlice?.error && currentError === activeSlice.error)} sliceDescription={sliceDescription} resultParameter={displayed.sweep.parameter}
        grid={datasetCurrent ? { finished: readySlices, failed: failedSlices, total: totalSlices, complete: dataset.complete, elapsed: dataset.elapsed } : undefined}/>
        : settingsPane === 'sweep' ? <SweepSettings config={config} onChange={change} onValidity={numericValidity} onRevert={setNumericRevertError} onValid={clearNumericRevertError}/>
        : settingsPane === 'solver' ? <SolverSettings config={config} onChange={change} onValidity={numericValidity} onRevert={setNumericRevertError} onValid={clearNumericRevertError}/>
        : <GraphSettings view={graphView} onScale={(axis, percentage) => setGraphView(current => ({ ...current, [axis]: percentage }))} onFit={() => setGraphView(current => ({ ...DEFAULT_GRAPH_VIEW, revision: current.revision + 1 }))}/>}
    </SettingsDialog>}
    {selected && <PointInspector point={selected} config={displayed} equations={result?.equations} unknowns={result?.unknowns} onClose={() => setSelected(null)} onCopy={() => { void navigator.clipboard.writeText(JSON.stringify(selected, null, 2)).then(() => setNotice('Operating point copied.')).catch(() => setNotice('Clipboard unavailable in this browser.')); }}/>}
    {help && <div className="modal-backdrop" onClick={() => setHelp(false)}><section className="modal help" role="dialog" aria-modal="true" aria-label="Quick guide" onClick={e => e.stopPropagation()}><div className="modal-heading"><h2>A small guide to your workbench</h2><button className="icon-button" onClick={() => setHelp(false)}><X size={20}/></button></div><h3>1. Organize your model</h3><p>Use the + button to add editor tabs. Every tab can contain unknowns, parameters, equations, and validity checks; all tabs share the same names and solve together. The controls beside the tabs are add, rename, and delete, in that order. Rename with the pencil or a double-click, then press Enter to save or Escape to cancel. The trash button removes the selected tab; nonempty tabs ask for confirmation. Tabs organize the model without creating separate systems.</p><pre>{'unknown y 1\nparameter x 0 0.1 -5 5 sweep\nparameter gain 2\ny = gain*x;\ny >= 0;'}</pre><p>Declarations end at a newline or semicolon. End math statements with a semicolon; they may span multiple lines. Comments start with #. Unknowns accept an optional initial guess. Parameter options are value or sweep start, step, minimum, maximum, then optional sweep. Omitted guesses and values default to 0. Complete slider settings create a slider; fewer options keep a numeric control. Wrap numeric options containing spaces in parentheses. Ordinary assignments can introduce computed quantities, and validity checks belong alongside the equations.</p><h3>2. Explore a sweep</h3><p>Append sweep after all four options in a parameter declaration. The current main selection stays main while marked; otherwise the first marked parameter becomes main. Additional marked parameters add slice dimensions with independent sliders. All sampled values and counts come from the declaration's start, step, and range. Oversized sweeps report the requested count, limit, and contributing dimensions. Every extra sweep multiplies the work. Point and slice limits and the estimated retained-data budget are listed under Diagnostics → Sweep plan → Limits; plotting and worker scratch memory are additional. Auto-run recomputes after model edits; turn it off for manual Run control. Switching or renaming tabs starts no computation. Slice sliders select exact computed combinations without editing the configured start or starting another solve. Each run starts at its configured values and works outward, lower then higher. Axis expressions are independent of the swept parameter. In constrained mode, an unknown is imposed and a parameter is released for solving.</p><h3>3. Inspect the result</h3><p>Drag the thin panel dividers to resize the editor, graph, and parameter tray. Double-click a divider to restore its default size. Use the divider chevrons to collapse either panel and the visible rails to reopen it. Panel sizes and collapsed states are remembered. Open Diagnostics for model counts, the complete sweep plan and limits, run progress, and results. Sweep, Solver, and Graph sections hold their respective settings. The inspector shows solution values first, with fixed inputs, residuals, and the Jacobian in expandable sections. Scroll the graph to zoom, drag to pan, double-click to reset, and click a point for values, residuals, and the Jacobian. The layers button keeps a previous curve as an overlay when axis expressions match. Open Graph scale in Settings to shrink or stretch each axis independently, or choose Fit graph to reset the view.</p><h3>Expression reference</h3><p>Arithmetic: <code>+ - * / ^</code>. Comparisons: <code>&lt; &lt;= &gt; &gt;= == !=</code>. Logic: <code>&amp;&amp; || !</code>. Piecewise: <code>if(condition, a, b)</code> or <code>condition ? a : b</code>. Nest if calls for multiple branches and format their arguments across lines. No braces are needed; the semicolon ends the whole equation. Conditional branches evaluate lazily.</p><p>Functions: abs, sqrt, exp, log/ln, log10, sin, cos, tan, asin, acos, atan, atan2, sinh, cosh, tanh, min, max, pow, floor, ceil, sign. Constants: pi, e. Engineering suffixes: p, n, u, m, k/K, M, G, T. Examples: <code>2.2k</code>, <code>500u</code>, <code>9e-9</code>. Parameter values, bounds, and sweep limits also accept numeric expressions like <code>9*10^(-9)</code>. Internal values are SI; axis scaling can be expressed as <code>ID * 1e3</code>.</p><h3>Equation conventions</h3><p>The solver has no required transistor or circuit parameters. Define your own symbols, equations, bounds, and validity conditions. Only referenced variables and derived dependencies participate in calculations. Unknowns have initial guesses; add limits as validity conditions, such as x &gt;= 0. Set fixed values and slider ranges in parameter declarations in any tab.</p><p className="muted">DC algebraic analysis only. Failed solves produce gaps. A solved sample has at least one numerical root; it may contain several roots or plotting issues. Branch segments describe connected portions of curves. Multistart searches are finite and may miss roots; folds can split branch segments. Save stores one workspace locally; export JSON for portable copies.</p></section></div>}
  </div>;
}
