import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowDownToLine, ArrowUpFromLine, BookOpen, Check, Maximize2, Play, Plus, RotateCcw, Save, Settings2, SlidersHorizontal, X } from 'lucide-react';
import type { Configuration, EditorDocument, Point, SweepResult } from './core/types';
import { examples, starter, defaultWorkspace, clone } from './examples';
import Plot from './Plot';
import Workspace from './Workspace';
import WorkspaceEditor from './WorkspaceEditor';
import { reconcileSweep, sliceSweeps } from './core/variables';
import { compileDocuments, ensureDocuments, syncDocumentVariables } from './core/documents';
import { SweepRunner } from './core/sweepRunner';
import SolverWorker from './core/worker?worker&inline';
import { configForCombination, multiSweepPlan, type MultiSweepPlan } from './core/doubleSweep';
import { normalizeSweep } from './core/sweepPlan';
import { createWorkspace, loadWorkspace, WORKSPACE_STORAGE } from './core/workspace';
import SweepSettings from './SweepSettings';
import SolverSettings from './SolverSettings';
import DiagnosticsPanel from './DiagnosticsPanel';
import ConstantsPanel from './ConstantsPanel';
import SettingsDialog, { type SettingsPane } from './SettingsDialog';
import PointInspector from './PointInspector';
import { formatValue as fmt } from './format';
import ParameterSliders from './ParameterSliders';
import GraphSettings from './GraphSettings';
import { DEFAULT_GRAPH_VIEW, fitGraphBounds, normalizeGraphView, validGraphBounds, type GraphBounds, type GraphView } from './graphView';
import { evaluateTransitionLines } from './core/transitions';
import { formatSampleCount, sampleProduct } from './core/sweepCounts';
import { withPointJacobian } from './core/pointDiagnostics';
const GRAPH_STORAGE = 'node-workbench-graph-view-v1';
function readyConfiguration(config: Configuration): Configuration {
  const documents = ensureDocuments(config);
  try { config = compileDocuments(config, documents); } catch { /* Keep saved drafts visible for correction. */ }
  return normalizeSweep(config);
}
function documentError(config: Configuration): string {
  try { compileDocuments(config, config.documents ?? []); return ''; }
  catch (reason) { return reason instanceof Error ? reason.message : 'Check the editor tabs.'; }
}
function initial(): Configuration { try { const saved = localStorage.getItem(WORKSPACE_STORAGE); return readyConfiguration(saved ? loadWorkspace(JSON.parse(saved)) : clone(defaultWorkspace)); } catch { return readyConfiguration(clone(defaultWorkspace)); } }
function initialGraphView(): GraphView {
  try {
    return normalizeGraphView(JSON.parse(localStorage.getItem(GRAPH_STORAGE) || '{}'));
  } catch { return { ...DEFAULT_GRAPH_VIEW }; }
}
function inputsKey(config: Configuration): string {
  const { transitions: _transitions, ...axes } = config.axes;
  return JSON.stringify({ equations: config.equations, variables: config.variables, constraints: config.constraints, sweep: config.sweep, axes, solver: config.solver });
}
interface SweepSlice { result: SweepResult | null; error?: string }
// Slice results are immutable. A keyed store avoids copying the whole grid for
// every completed combination; React receives small progress snapshots instead.
interface MultiSweepData { config: Configuration; key: string; plan: MultiSweepPlan; slices: Map<number, SweepSlice>; readyCount: number; failedCount: number; complete: boolean; elapsed: number }
export default function App() {
  const [config, setConfig] = useState<Configuration>(initial), [singleResult, setResult] = useState<SweepResult | null>(null), [computed, setComputed] = useState<Configuration | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [help, setHelp] = useState(false), [settings, setSettings] = useState(false), [settingsPane, setSettingsPane] = useState<SettingsPane | null>(null);
  const [sourceError, setSourceError] = useState(() => documentError(config));
  const hasCurves = Boolean(config.axes.x.trim() && config.axes.y.trim());
  const hasTransitions = !sourceError && Boolean(config.axes.transitions?.length);
  const transitionConfig = useMemo(() => sourceError ? { ...config, axes: { ...config.axes, transitions: undefined } } : config, [config, sourceError]);
  const [graphView, setGraphView] = useState<GraphView>(initialGraphView);
  const graphViewport = useRef<GraphBounds | null>(null);
  const graphViewportChange = useCallback((bounds: GraphBounds, mode?: 'auto' | 'manual') => {
    graphViewport.current = bounds;
    if (!mode) return;
    setGraphView(current => {
      const autoscale = mode === 'auto';
      if (current.autoscale === autoscale && current.xMin === bounds.xMin && current.xMax === bounds.xMax && current.yMin === bounds.yMin && current.yMax === bounds.yMax) return current;
      return { ...bounds, autoscale, revision: current.revision + 1 };
    });
  }, []);
  const [selected, setSelected] = useState<Point | null>(null);
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
  const changeGraphView = (update: Partial<Omit<GraphView, 'revision'>>) => {
    let bounds = graphViewport.current;
    if (update.autoscale === false && !bounds) {
      try { bounds = fitGraphBounds(result, evaluateTransitionLines(transitionConfig, result)); }
      catch { bounds = fitGraphBounds(result); }
    }
    setGraphView(current => {
      const next = { ...current, ...(update.autoscale === false && current.autoscale ? bounds : {}), ...update };
      if (!validGraphBounds(next)) return current;
      if (current.autoscale === next.autoscale && current.xMin === next.xMin && current.xMax === next.xMax && current.yMin === next.yMin && current.yMax === next.yMax) return current;
      return { ...next, revision: current.revision + 1 };
    });
  };
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
    try {
      const compiled = compileDocuments(next, next.documents ?? []);
      setConfig(normalizeSweep(compiled)); setSourceError('');
    } catch (reason) {
      setConfig(normalizeSweep(next));
      setSourceError(reason instanceof Error ? reason.message : 'Check the editor tabs.');
      runner.current!.cancel(); setBusy(false); setResult(null); publishDataset(null); setPreview(null); setSelected(null);
    }
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
  const variable = (index: number, value: number) => change(c => {
    const parameter = c.variables[index];
    if (parameter?.kind === 'parameter') parameter.value = value;
  });
  useEffect(() => {
    const manual = revision !== lastRun.current;
    lastRun.current = revision;
    if (sourceError) { runner.current!.cancel(); setBusy(false); return; }
    if (!hasCurves) {
      runner.current!.cancel(); setBusy(false); setError(''); setResult(null); publishDataset(null); setPreview(null);
      setComputed(config); setCompleted(0); setResultComplete(false); setSelected(null);
      return;
    }
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
  useEffect(() => { try { const { revision: _revision, ...preferences } = graphView; localStorage.setItem(GRAPH_STORAGE, JSON.stringify(preferences)); } catch { /* View controls still work when browser storage is unavailable. */ } }, [graphView]);
  const parameters = config.variables.filter(v => v.kind === 'parameter');
  const stale = !!sourceError || (secondary ? !datasetCurrent : !computed || inputsKey(computed) !== configKey);
  const sweepStatus = !hasCurves && hasTransitions ? 'Reference lines' : secondary ? (busy ? `Precomputing · ${readySlices}/${formatSampleCount(totalSlices)} slices`
    : !datasetCurrent ? 'Ready to precompute' : !dataset.complete ? 'Precompute stopped'
    : `${formatSampleCount(totalSlices)} slices complete${failedSlices ? ` · ${failedSlices} failed` : result?.failures.length ? ' · partial' : ''}`)
    : busy ? (completed ? `Computing · ${completed}/${config.sweep.points}` : 'Computing')
    : stale ? 'Settings changed' : !result ? 'Ready' : !resultComplete ? 'Sweep stopped'
    : result.failures.length ? `${result.solved}/${result.total} solved · partial` : 'Sweep complete';
  const save = () => { try { localStorage.setItem(WORKSPACE_STORAGE, JSON.stringify(createWorkspace(config))); setNotice('Workspace saved in this browser.'); } catch { setError('Browser storage is unavailable. Export JSON to save your work.'); } };
  const exportJSON = () => { const url = URL.createObjectURL(new Blob([JSON.stringify(createWorkspace(config), null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = `${config.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`; a.click(); URL.revokeObjectURL(url); };
  const load = (index: number) => { replaceConfig(clone(examples[index])); setError(''); setNumericRevertError(''); setRevision(v => v + 1); };
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
      <input hidden type="file" accept=".json,application/json" ref={file} onChange={async e => { const f = e.target.files?.[0]; if (!f) return; try { if (f.size > 1000000) throw new Error('Please import a JSON file smaller than 1 MB.'); replaceConfig(loadWorkspace(JSON.parse(await f.text()))); setNumericRevertError(''); setRevision(v => v + 1); setNotice('Configuration imported.'); } catch (err) { setError((err as Error).message); } e.target.value = ''; }}/>
      {notice && <div className="notice"><Check size={15}/>{notice}</div>}
      <Workspace><section className="editor-panel panel"><WorkspaceEditor documents={config.documents ?? []} resetKey={editorReset} error={sourceError} onChange={editDocuments}/>
      </section>
      <section className="plot-panel panel"><div className="plot-heading"><div className="plot-actions"><label className="check-label"><input type="checkbox" checked={auto} onChange={e => { setAuto(e.target.checked); }}/>Auto-run</label><button className="button primary compact-run" onClick={run} disabled={Boolean(sourceError) || !hasCurves}><Play size={12} fill="currentColor"/>{busy ? 'Restart' : 'Run'}</button>{busy && secondary && <button className="button subtle compact-run" onClick={stop}>Stop</button>}<button className="icon-button" title="Expand plot" onClick={e => { const panel = e.currentTarget.closest('.plot-panel'); if (document.fullscreenElement) void document.exitFullscreen(); else void panel?.requestFullscreen(); }}><Maximize2 size={15}/></button><div className="workspace-menu" ref={menu}><button className={`icon-button settings-trigger ${settings ? 'selected' : ''}`} aria-label="Workspace settings" aria-expanded={settings} aria-controls="workspace-settings" onClick={() => setSettings(!settings)}><Settings2 size={17}/></button>{settings && <div id="workspace-settings" className="settings-dropdown" role="region" aria-label="Workspace settings menu"><label className="settings-name">Workspace<input aria-label="Workspace name" value={config.name} onChange={e => change(c => { c.name = e.target.value; })}/></label><button onClick={() => { setSettingsPane('diagnostics'); setSettings(false); }}><Activity size={15}/>Diagnostics</button><button onClick={() => { setSettingsPane('sweep'); setSettings(false); }}><SlidersHorizontal size={15}/>Sweep settings</button><button onClick={() => { setSettingsPane('solver'); setSettings(false); }}><Settings2 size={15}/>Solver settings</button><button onClick={() => { setSettingsPane('graph'); setSettings(false); }}><Maximize2 size={15}/>Graph settings</button><div className="menu-divider"/><button onClick={() => { replaceConfig(clone(starter)); setNumericRevertError(''); setSettings(false); setRevision(v => v + 1); }}><Plus size={15}/>New equation workspace</button><label className="settings-examples"><BookOpen size={15}/><select aria-label="Load an example" value="" onChange={e => { load(Number(e.target.value)); setSettings(false); }}><option value="" disabled>Load example</option>{examples.map((e, i) => <option key={e.name} value={i}>{e.name}</option>)}</select></label><button onClick={() => { save(); setSettings(false); }}><Save size={15}/>Save workspace</button><button onClick={() => { file.current?.click(); setSettings(false); }}><ArrowUpFromLine size={15}/>Import JSON</button><button onClick={() => { exportJSON(); setSettings(false); }}><ArrowDownToLine size={15}/>Export JSON</button><div className="menu-divider"/><button onClick={() => { setHelp(true); setSettings(false); }}><BookOpen size={15}/>Quick guide</button></div>}</div></div></div>
        <div className="graph-status"><button className={`calculation-status ${busy ? 'busy' : ''} ${currentError ? 'failed' : result?.failures.length || failedSlices ? 'partial' : ''}`} aria-label={currentError ? 'Open error details' : 'Open sweep diagnostics'} title={currentError ? 'Open error details' : result?.failures[0]?.reason || 'View numerical diagnostics'} onClick={() => setSettingsPane('diagnostics')}><span className="dot"/>{busy || !currentError ? sweepStatus : null}</button></div>
        <>{secondary && <div className="slice-summary"><span>{sliceDescription || 'Slice parameters'}{datasetCurrent ? ` · slice ${sliceIndex + 1}/${formatSampleCount(totalSlices)}` : ' · no computed slices'}</span></div>}</><div className="chart-wrap"><Plot result={result} config={displayed} transitionConfig={transitionConfig} view={graphView} onPoint={inspectPoint} onViewportChange={graphViewportChange}/>{!result?.branches.length && !hasTransitions && <div className="chart-placeholder">{!sourceError && (!config.axes.x || !config.axes.y) ? 'Use set_time_axis t with plot y or plot y x, or add plot_x_transition C / plot_y_transition C.' : currentError ? 'No solution plotted. Select the red status for details.' : secondary ? (datasetCurrent ? 'This slice has not been computed yet.' : auto ? 'Waiting for the sweep…' : 'Select Run to compute the slices.') : busy ? 'Finding operating points…' : 'Run a sweep to explore your equations.'}</div>}</div>

      </section>
      <section className="parameters-panel panel"><div className="panel-heading"><Settings2 size={15}/><h3>Parameters</h3><button className="text-button" onClick={() => setSettingsPane('sweep')}>Sweep settings</button><button className="icon-button" title="Reset parameters to example defaults" onClick={() => { const example = [starter, ...examples].find(e => e.name === config.name); if (!example) { setNotice('Load an example to restore its defaults.'); return; } change(c => { c.variables = c.variables.map(v => v.kind === 'parameter' ? clone(example.variables.find(p => p.name === v.name) ?? v) : v); }); }}><RotateCcw size={13}/></button></div><fieldset className="parameter-controls" disabled={Boolean(sourceError)} title={sourceError ? 'Fix the source error to edit parameter controls.' : undefined}><ParameterSliders config={config} parameters={parameters} update={variable} sliceViews={sliceViews} slicesAvailable={datasetCurrent} onSlice={chooseSlice} onValidity={numericValidity} onRevert={setNumericRevertError} onValid={clearNumericRevertError}/></fieldset></section>

      </Workspace>
    </main>

    {settingsPane && <SettingsDialog pane={settingsPane} onPane={setSettingsPane} onClose={() => setSettingsPane(null)}>
      {settingsPane === 'diagnostics' ? <DiagnosticsPanel config={config} result={result} busy={busy} resultComplete={resultComplete} stale={stale} sourceInvalid={Boolean(sourceError)} error={currentError} sliceError={Boolean(activeSlice?.error && currentError === activeSlice.error)} sliceDescription={sliceDescription} resultParameter={displayed.sweep.parameter}
        grid={datasetCurrent ? { finished: readySlices, failed: failedSlices, total: totalSlices, complete: dataset.complete, elapsed: dataset.elapsed } : undefined}/>
        : settingsPane === 'constants' ? <ConstantsPanel config={config} sourceError={sourceError}/>
        : settingsPane === 'sweep' ? <SweepSettings config={config} onChange={change} onValidity={numericValidity} onRevert={setNumericRevertError} onValid={clearNumericRevertError}/>
        : settingsPane === 'solver' ? <SolverSettings config={config} onChange={change} onValidity={numericValidity} onRevert={setNumericRevertError} onValid={clearNumericRevertError}/>
        : <GraphSettings view={graphView} onChange={changeGraphView}/>}
    </SettingsDialog>}
    {selected && <PointInspector point={selected} config={displayed} equations={result?.equations} unknowns={result?.unknowns} onClose={() => setSelected(null)} onCopy={() => { void navigator.clipboard.writeText(JSON.stringify(selected, null, 2)).then(() => setNotice('Operating point copied.')).catch(() => setNotice('Clipboard unavailable in this browser.')); }}/>}
    {help && <div className="modal-backdrop" onClick={() => setHelp(false)}><section className="modal help" role="dialog" aria-modal="true" aria-label="Quick guide" onClick={e => e.stopPropagation()}><div className="modal-heading"><h2>A small guide to your workbench</h2><button className="icon-button" onClick={() => setHelp(false)}><X size={20}/></button></div><h3>1. Organize your model</h3><p>Use the + button to add editor tabs. Every tab can contain unknowns, parameters, equations, validity checks, and plot commands; all tabs share the same names and solve together. The controls beside the tabs are add, rename, and delete, in that order. Rename with the pencil or a double-click, then press Enter to save or Escape to cancel. The trash button removes the selected tab; nonempty tabs ask for confirmation. Tabs organize the model without creating separate systems.</p><pre>{'unknown y 1\nparameter x 0 0.1 -5 5 sweep\nparameter gain 2\ny = gain*x;\ny >= 0;\nset_time_axis x\nplot y'}</pre><p>Declarations end at a newline or semicolon. End math statements with a semicolon; they may span multiple lines. Comments start with #. Names used in equations are inferred as unknowns with a zero initial guess unless declared as parameters. Unknown declarations are optional and can supply a different initial guess. Declare fixed inputs with parameter name value. Parameter options are value or sweep start, step, minimum, maximum, then optional sweep. Omitted guesses and values default to 0. Complete slider settings create a slider; fewer options keep a numeric control. Wrap numeric options containing spaces in parentheses. Ordinary assignments can introduce computed quantities, and validity checks belong alongside the equations.</p><h3>2. Explore a sweep</h3><p>Append sweep after all four options in a parameter declaration. Use set_time_axis x once to choose the main sweep and the shared order in which curve points connect. Other marked parameters add slice dimensions with independent sliders. This traversal parameter can represent resistance, voltage, or another quantity instead of physical time. All sampled values and counts come from the declaration's start, step, and range. Oversized sweeps report the requested count, limit, and contributing dimensions. Every extra sweep multiplies the work. Point and slice limits and the estimated retained-data budget are listed under Diagnostics → Sweep plan → Limits; plotting and worker scratch memory are additional. Auto-run recomputes after model edits; turn it off for manual Run control. Switching or renaming tabs starts no computation. Slice sliders select exact computed combinations without editing the configured start or starting another solve. Each run starts at its configured values and works outward, lower then higher. Write plot y in any tab to graph y against the parameter selected by set_time_axis. Write plot y x to graph y vertically against x horizontally. The first expression is Y; an optional second expression chooses X for a parametric curve. Every curve can use different X and Y expressions while its points connect in the same traversal order, including loops whose displayed X reverses direction. For example, with a swept t selected as the time axis, plot sin(t) cos(t) draws a circle. Coordinates accept unknowns, parameters, computed quantities, and math, such as plot y*1000 or plot max(y,0). Wrap expressions containing spaces in parentheses in the two-expression form, such as plot (y * 1000) (x * 1000). A comma-separated list such as plot y, y^2 still adds separate Y curves against the traversal parameter. The selected time-axis parameter must already have sweep on its declaration. Add another plot command for each additional curve. Curves share one X scale and one Y scale even when their units differ; labels identify their coordinates. Missing or conflicting set_time_axis selections are editor errors.</p><p>Use plot_x_transition C for a vertical line at X = C, or plot_y_transition C for a horizontal line at Y = C. The expression is constant-folded and may use fixed parameters, chains of derived assignments, and math functions; it does not need to be a numeric literal. For example, plot_x_transition (1/(2*pi*R*C)) draws the cutoff for fixed R and C. Its value must be finite and real without depending on swept parameters or unknowns. Up to 32 lines can appear alongside curves or alone without a sweep or time axis. They span the viewport while zooming or panning, and add no solver constraint. Saved impose/release workspaces retain legacy compatibility; new sweeps use parameter declarations and set_time_axis.</p><h3>3. Inspect the result</h3><p>Drag the thin panel dividers to resize the editor, graph, and parameter tray. Double-click a divider to collapse its panel, then click the visible rail to reopen it at the previous size. Focused dividers also accept Enter or Space to collapse. Panel sizes and collapsed states are remembered. Open Diagnostics for model counts, the complete sweep plan and limits, run progress, and results. The Constants tab beside Diagnostics shows fixed inputs, folded assignment values, and reference-line positions without running a solve. Sweep, Solver, and Graph sections hold their respective settings. The inspector shows solution values first, with fixed inputs, residuals, and the Jacobian in expandable sections. Scroll the graph to zoom, drag to pan, double-click to reset, and click a point for values, residuals, and the Jacobian. Open Graph settings in Settings. Autoscale starts enabled and fits the visible data. Turn it off to enter Minimum X, Maximum X, Minimum Y, and Maximum Y; each minimum must be less than its maximum, and all bounds must be finite. Graph view preferences are remembered locally, and changing them starts no solve.</p><h3>Expression reference</h3><p>Arithmetic: <code>+ - * / ^</code>. Comparisons: <code>&lt; &lt;= &gt; &gt;= == !=</code>. Logic: <code>&amp;&amp; || !</code>. Piecewise: <code>if(condition, a, b)</code> or <code>condition ? a : b</code>. Nest if calls for multiple branches and format their arguments across lines. No braces are needed; the semicolon ends the whole equation. Conditional branches evaluate lazily.</p><p>Functions: abs, sqrt, exp, log/ln, log10, sin, cos, tan, asin, acos, atan, atan2, sinh, cosh, tanh, min, max, pow, floor, ceil, sign. Constants: pi, e. Engineering suffixes: p, n, u, m, k/K, M, G, T. Examples: <code>2.2k</code>, <code>500u</code>, <code>9e-9</code>. Parameter values, bounds, and sweep limits also accept numeric expressions like <code>9*10^(-9)</code>. Internal values are SI; axis scaling can be expressed as <code>ID * 1e3</code>.</p><h3>Complex mode</h3><p>Enable Complex mode in Solver settings to allow complex unknowns while parameters, sweep coordinates, and plot coordinates stay real. Use i or j for the imaginary unit unless those names are declared, and write multiplication explicitly, such as 2*i. Project complex results with real, imag, abs, or arg (phase in radians). The command plot imag(z) real(z) puts the imaginary part on Y and the real part on X; a complex plot coordinate reports an error. sqrt, log, and complex powers use principal branches. Comparisons and interval limits require real expressions. Complex multistart includes imaginary starting components, and the inspector displays each complex unknown as a + bi.</p><h3>Equation conventions</h3><p>The solver has no required transistor or circuit parameters. Define your own symbols, equations, bounds, and validity conditions. Only referenced variables and derived dependencies participate in calculations. Undeclared names inside implicit equations are inferred as unknowns; plot commands alone do not introduce unknowns. If there are more unknowns than equations, declare an intended fixed input as a parameter or add an equation. Inequalities filter roots and do not replace equality equations. Matching equation and unknown counts does not guarantee a solution or uniqueness. Use an unknown declaration to supply an initial guess, and add limits as validity conditions such as x &gt;= 0. Set fixed values and slider ranges in parameter declarations in any tab.</p><p className="muted">DC algebraic analysis only. Failed solves produce gaps. A solved sample has at least one numerical root; it may contain several roots or plotting issues. Branch segments describe connected portions of curves. Multistart searches are finite and may miss roots; folds can split branch segments. Save stores one workspace locally; export JSON for portable copies.</p></section></div>}
  </div>;
}
