import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowDownToLine, ArrowUpFromLine, BookOpen, Check, Maximize2, Play, Plus, RotateCcw, Save, Settings2, SlidersHorizontal } from 'lucide-react';
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
import { createWorkspaceArchive } from './core/workspaceArchive';
import WorkspaceImport from './WorkspaceImport';
import QuickGuide from './QuickGuide';
import SweepSettings from './SweepSettings';
import SolverSettings from './SolverSettings';
import DiagnosticsPanel from './DiagnosticsPanel';
import ConstantsPanel from './ConstantsPanel';
import ElementSettings from './ElementSettings';
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
  const [importing, setImporting] = useState(false);
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
  const [auto, setAuto] = useState(true), [revision, setRevision] = useState(0); const lastRun = useRef(0);
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
      try { bounds = fitGraphBounds(result, evaluateTransitionLines(transitionConfig)); }
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
  const save = () => { try { localStorage.setItem(WORKSPACE_STORAGE, JSON.stringify(createWorkspace(config))); setNotice('Workspace saved in this browser.'); } catch { setError('Browser storage is unavailable. Export ZIP to save your work.'); } };
  const exportZIP = () => {
    try {
      const archive = createWorkspaceArchive(config);
      const url = URL.createObjectURL(new Blob([archive], { type: 'application/zip' }));
      const link = document.createElement('a');
      link.href = url; link.download = `${config.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'workspace'}.zip`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The workspace ZIP could not be exported.'); }
  };
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
      {notice && <div className="notice"><Check size={15}/>{notice}</div>}
      <Workspace><section className="editor-panel panel"><WorkspaceEditor documents={config.documents ?? []} resetKey={editorReset} error={sourceError} onChange={editDocuments}/>
      </section>
      <section className="plot-panel panel"><div className="plot-heading"><div className="plot-actions"><label className="check-label"><input type="checkbox" checked={auto} onChange={e => { setAuto(e.target.checked); }}/>Auto-run</label><button className="button primary compact-run" onClick={run} disabled={Boolean(sourceError) || !hasCurves}><Play size={12} fill="currentColor"/>{busy ? 'Restart' : 'Run'}</button>{busy && secondary && <button className="button subtle compact-run" onClick={stop}>Stop</button>}<button className="icon-button" title="Expand plot" onClick={e => { const panel = e.currentTarget.closest('.plot-panel'); if (document.fullscreenElement) void document.exitFullscreen(); else void panel?.requestFullscreen(); }}><Maximize2 size={15}/></button><div className="workspace-menu" ref={menu}><button className={`icon-button settings-trigger ${settings ? 'selected' : ''}`} aria-label="Workspace settings" aria-expanded={settings} aria-controls="workspace-settings" onClick={() => setSettings(!settings)}><Settings2 size={17}/></button>{settings && <div id="workspace-settings" className="settings-dropdown" role="region" aria-label="Workspace settings menu"><label className="settings-name">Workspace<input aria-label="Workspace name" value={config.name} onChange={e => change(c => { c.name = e.target.value; })}/></label><button onClick={() => { setSettingsPane('diagnostics'); setSettings(false); }}><Activity size={15}/>Diagnostics</button><button onClick={() => { setSettingsPane('sweep'); setSettings(false); }}><SlidersHorizontal size={15}/>Sweep settings</button><button onClick={() => { setSettingsPane('elements'); setSettings(false); }}><BookOpen size={15}/>Elements</button><button onClick={() => { setSettingsPane('solver'); setSettings(false); }}><Settings2 size={15}/>Solver settings</button><button onClick={() => { setSettingsPane('graph'); setSettings(false); }}><Maximize2 size={15}/>Graph settings</button><div className="menu-divider"/><button onClick={() => { replaceConfig(clone(defaultWorkspace)); setNumericRevertError(''); setSettings(false); setRevision(v => v + 1); }}><Plus size={15}/>New equation workspace</button><label className="settings-examples"><BookOpen size={15}/><select aria-label="Load an example" value="" onChange={e => { load(Number(e.target.value)); setSettings(false); }}><option value="" disabled>Load example</option>{examples.map((e, i) => <option key={e.name} value={i}>{e.name}</option>)}</select></label><button onClick={() => { save(); setSettings(false); }}><Save size={15}/>Save workspace</button><button onClick={() => { setImporting(true); setSettings(false); }}><ArrowDownToLine size={15}/>Import</button><button onClick={() => { exportZIP(); setSettings(false); }}><ArrowUpFromLine size={15}/>Export ZIP</button><div className="menu-divider"/><button onClick={() => { setHelp(true); setSettings(false); }}><BookOpen size={15}/>Quick guide</button></div>}</div></div></div>
        <div className="graph-status"><button className={`calculation-status ${busy ? 'busy' : ''} ${currentError ? 'failed' : result?.failures.length || failedSlices ? 'partial' : ''}`} aria-label={currentError ? 'Open error details' : 'Open sweep diagnostics'} title={currentError ? 'Open error details' : result?.failures[0]?.reason || 'View numerical diagnostics'} onClick={() => setSettingsPane('diagnostics')}><span className="dot"/>{busy || !currentError ? sweepStatus : null}</button></div>
        <>{secondary && <div className="slice-summary"><span>{sliceDescription || 'Slice parameters'}{datasetCurrent ? ` · slice ${sliceIndex + 1}/${formatSampleCount(totalSlices)}` : ' · no computed slices'}</span></div>}</><div className="chart-wrap"><Plot result={result} config={displayed} transitionConfig={transitionConfig} view={graphView} onPoint={inspectPoint} onViewportChange={graphViewportChange}/>{!result?.branches.length && !hasTransitions && <div className="chart-placeholder">{!sourceError && (!config.axes.x || !config.axes.y) ? 'Use set_time_axis t with plot y or plot y x, or add plot_x_transition C / plot_y_transition C.' : currentError ? 'No solution plotted. Select the red status for details.' : secondary ? (datasetCurrent ? 'This slice has not been computed yet.' : auto ? 'Waiting for the sweep…' : 'Select Run to compute the slices.') : busy ? 'Finding operating points…' : 'Run a sweep to explore your equations.'}</div>}</div>

      </section>
      <section className="parameters-panel panel"><div className="panel-heading"><Settings2 size={15}/><h3>Parameters</h3><button className="text-button" onClick={() => setSettingsPane('sweep')}>Sweep settings</button><button className="icon-button" title="Reset parameters to example defaults" onClick={() => { const example = [starter, ...examples].find(e => e.name === config.name); if (!example) { setNotice('Load an example to restore its defaults.'); return; } change(c => { c.variables = c.variables.map(v => v.kind === 'parameter' ? clone(example.variables.find(p => p.name === v.name) ?? v) : v); }); }}><RotateCcw size={13}/></button></div><fieldset className="parameter-controls" disabled={Boolean(sourceError)} title={sourceError ? 'Fix the source error to edit parameter controls.' : undefined}><ParameterSliders config={config} parameters={parameters} update={variable} sliceViews={sliceViews} slicesAvailable={datasetCurrent} onSlice={chooseSlice} onValidity={numericValidity} onRevert={setNumericRevertError} onValid={clearNumericRevertError}/></fieldset></section>

      </Workspace>
    </main>

    {importing && <WorkspaceImport onImport={imported => {
      replaceConfig(imported); setNumericRevertError(''); setError(''); setRevision(value => value + 1); setNotice('Workspace imported.');
    }} onClose={() => setImporting(false)}/>}
    {settingsPane && <SettingsDialog pane={settingsPane} onPane={setSettingsPane} onClose={() => setSettingsPane(null)}>
      {settingsPane === 'diagnostics' ? <DiagnosticsPanel config={config} result={result} busy={busy} resultComplete={resultComplete} stale={stale} sourceInvalid={Boolean(sourceError)} error={currentError} sliceError={Boolean(activeSlice?.error && currentError === activeSlice.error)} sliceDescription={sliceDescription} resultParameter={displayed.sweep.parameter}
        grid={datasetCurrent ? { finished: readySlices, failed: failedSlices, total: totalSlices, complete: dataset.complete, elapsed: dataset.elapsed } : undefined}/>
        : settingsPane === 'constants' ? <ConstantsPanel config={config} sourceError={sourceError}/>
        : settingsPane === 'elements' ? <ElementSettings config={config} sourceError={sourceError} onChange={definitions => change(current => { current.elementDefinitions = definitions; })}/>
        : settingsPane === 'sweep' ? <SweepSettings config={config}/>
        : settingsPane === 'solver' ? <SolverSettings config={config} onChange={change} onValidity={numericValidity} onRevert={setNumericRevertError} onValid={clearNumericRevertError}/>
        : <GraphSettings view={graphView} onChange={changeGraphView}/>}
    </SettingsDialog>}
    {selected && <PointInspector point={selected} config={displayed} equations={result?.equations} unknowns={result?.unknowns} onClose={() => setSelected(null)} onCopy={() => { void navigator.clipboard.writeText(JSON.stringify(selected, null, 2)).then(() => setNotice('Operating point copied.')).catch(() => setNotice('Clipboard unavailable in this browser.')); }}/>}
    {help && <QuickGuide onClose={() => setHelp(false)}/>}
  </div>;
}
