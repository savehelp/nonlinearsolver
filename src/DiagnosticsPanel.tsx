import { useMemo } from 'react';
import type { Configuration, SweepResult } from './core/types';
import { modelDiagnostics } from './core/diagnostics';
import { sliceSweeps } from './core/variables';
import { formatSampleCount, gridLimitMessage, sampleCountExceeds, sampleProduct, type SampleCount } from './core/sweepCounts';
import { DEFAULT_SWEEP_BYTES, MAX_DOUBLE_SWEEP_SAMPLES, MAX_PARAMETER_SAMPLES, MAX_SECONDARY_SLICES } from './core/sweepLimits';
import { formatValue } from './format';

interface GridProgress { finished: number; failed: number; total: SampleCount; complete: boolean; elapsed: number }
interface Props {
  config: Configuration;
  result: SweepResult | null;
  busy: boolean;
  resultComplete: boolean;
  stale: boolean;
  sourceInvalid: boolean;
  error?: string;
  sliceError?: boolean;
  sliceDescription?: string;
  resultParameter?: string;
  grid?: GridProgress;
}
const count = (value: number | null | undefined) => value === null || value === undefined ? '—' : formatSampleCount(value);

export default function DiagnosticsPanel({ config, result, busy, resultComplete, stale, sourceInvalid, error, sliceError, sliceDescription, resultParameter, grid }: Props) {
  const model = useMemo(() => modelDiagnostics(config), [config]);
  const plan = useMemo(() => {
    const additional = sliceSweeps(config);
    const axes = [config.sweep, ...additional].map((axis, index) => ({
      ...axis, role: index === 0 ? 'Main' : 'Slice',
      start: axis.startAt ?? (index === 0 && config.sweep.mode === 'constrained' ? axis.min : config.variables.find(variable => variable.name === axis.parameter)?.value),
      limit: index === 0 ? MAX_PARAMETER_SAMPLES : MAX_SECONDARY_SLICES,
    })).filter(axis => axis.parameter);
    const total = axes.length ? sampleProduct(axes.map(axis => axis.points)) : 0;
    const slices = sampleProduct(additional.map(axis => axis.points));
    const issue = sampleCountExceeds(total, MAX_DOUBLE_SWEEP_SAMPLES)
      ? gridLimitMessage(axes.map(axis => ({ name: axis.parameter, count: axis.points })), MAX_DOUBLE_SWEEP_SAMPLES) : undefined;
    return { axes, total, slices, issue, exceeds: sampleCountExceeds(total, MAX_DOUBLE_SWEEP_SAMPLES) || axes.some(axis => axis.points > axis.limit) };
  }, [config]);
  // Only the displayed curve is inspected, once per immutable result update.
  // Diagnostics never walk the grid's retained slice map or estimate its heap.
  const maximumResidual = useMemo(() => result ? result.branches.reduce((maximum, branch) => branch.points.reduce((value, point) => Math.max(value, point.norm), maximum), 0) : undefined, [result]);
  const issue = error || model.issue || plan.issue;

  return <div className="diagnostics-overview">
    {issue && <div className="diagnostic-error" role="alert"><strong>{sliceError ? 'Selected slice' : sourceInvalid ? 'Source error' : 'Needs attention'}</strong><p>{issue}</p></div>}

    <section className="diagnostic-section" aria-label="Model diagnostics"><div className="diagnostic-section-heading"><h3>Model</h3>{sourceInvalid && <span className="diagnostic-tag">Last valid inputs</span>}</div>
      <dl className="diagnostic-facts">
        <div><dt>Declared unknowns</dt><dd>{count(model.declaredUnknowns)}</dd></div>
        <div><dt>Parameters</dt><dd>{count(model.parameters)}</dd></div>
        <div><dt>Equations</dt><dd>{count(model.equations)}</dd></div>
        <div><dt>Validity checks</dt><dd>{count(model.conditions)}</dd></div>
      </dl>
      <details className="diagnostic-details"><summary>Model details</summary><dl className="diagnostic-list">
        <div><dt>Source tabs</dt><dd>{count(model.tabs)}</dd></div>
        <div><dt>Inferred unknowns</dt><dd>{count(model.inferredVariables)}</dd></div>
        {!!model.declaredDerived && <div><dt>Legacy derived definitions</dt><dd>{count(model.declaredDerived)}</dd></div>}
        {model.preparationSkipped ? <div><dt>Reduction analysis</dt><dd>Available per point</dd></div> : <>
          <div><dt>Active unknowns at start</dt><dd>{count(model.activeUnknowns)}</dd></div>
          <div><dt>Numerical variables at start</dt><dd>{model.direct ? '0 · direct evaluation' : count(model.numericalUnknowns)}</dd></div>
        </>}
      </dl></details>
    </section>

    <section className="diagnostic-section" aria-label="Sweep plan"><div className="diagnostic-section-heading"><h3>Sweep plan</h3><span className={`diagnostic-tag${plan.exceeds ? ' warning' : ''}`}>{sourceInvalid ? 'Last valid · ' : ''}{formatSampleCount(plan.total)} sample positions</span></div>
      {plan.axes.length ? <div className="diagnostic-table-scroll"><table className="sampling-table"><thead><tr><th>Axis</th><th>Range</th><th>Start</th><th>Step</th><th>Samples</th></tr></thead><tbody>{plan.axes.map((axis, index) => <tr key={`${axis.parameter}:${index}`}>
        <td><strong>{axis.parameter}</strong><span className="diagnostic-cell-note">{axis.role}</span></td>
        <td>{formatValue(axis.min)} … {formatValue(axis.max)}</td><td>{formatValue(axis.start)}</td>
        <td>{axis.logarithmic ? 'Log' : axis.step === undefined ? 'Linear' : formatValue(axis.step)}</td>
        <td className={axis.points > axis.limit ? 'diagnostic-warning' : undefined}>{formatSampleCount(axis.points)}</td>
      </tr>)}</tbody></table></div> : <p className="diagnostic-empty">No sweep selected.</p>}
      {plan.axes.length > 1 && <p className="diagnostic-context">{formatSampleCount(plan.slices)} combinations × {formatSampleCount(config.sweep.points)} main samples</p>}
      <details className="diagnostic-details" open={plan.exceeds || undefined}><summary>Limits</summary><dl className="diagnostic-list">
        <div><dt>Main axis</dt><dd>{formatSampleCount(MAX_PARAMETER_SAMPLES)} samples</dd></div>
        <div><dt>Each slice axis</dt><dd>{formatSampleCount(MAX_SECONDARY_SLICES)} samples</dd></div>
        <div><dt>Entire grid</dt><dd>{formatSampleCount(MAX_DOUBLE_SWEEP_SAMPLES)} sample positions</dd></div>
        <div><dt>Estimated sweep-data budget</dt><dd>{formatSampleCount(DEFAULT_SWEEP_BYTES / 1024 / 1024)} MiB</dd></div>
      </dl></details>
    </section>

    {grid && <section className="diagnostic-section" aria-label="Grid progress"><div className="diagnostic-section-heading"><h3>Grid run</h3><span className="diagnostic-tag">{busy ? 'Computing' : grid.complete ? grid.failed ? 'Complete with issues' : 'Complete' : 'Stopped'}</span></div>
      <dl className="diagnostic-facts grid-facts">
        <div><dt>Finished slices</dt><dd>{count(grid.finished)} <small>/ {formatSampleCount(grid.total)}</small></dd></div>
        <div><dt>Failed slices</dt><dd>{count(grid.failed)}</dd></div>
        <div><dt>Total elapsed</dt><dd>{grid.complete ? `${formatSampleCount(Math.round(grid.elapsed))} ms` : '—'}</dd></div>
      </dl>
    </section>}

    <section className="diagnostic-section" aria-label="Result diagnostics"><div className="diagnostic-section-heading"><h3>{grid ? 'Selected curve' : 'Run result'}</h3><span className="diagnostic-tag">{sliceError ? 'Failed' : stale && result ? 'Previous settings' : result ? !resultComplete ? busy ? 'Computing' : 'Stopped' : result.failures.length ? 'With issues' : 'Complete' : busy ? 'Computing' : 'Not computed'}</span></div>
      {grid && sliceDescription && <p className="diagnostic-context">{sliceDescription}</p>}
      {stale && result && <p className="diagnostic-context warning">These results are from previous settings.</p>}
      {result ? <>
        <dl className="diagnostic-facts">
          <div><dt>Solved samples</dt><dd>{count(result.solved)} <small>/ {count(result.total)}</small></dd></div>
          <div><dt>Branch segments</dt><dd>{count(result.branches.length)}</dd></div>
          <div><dt>Maximum residual</dt><dd className="mono">{formatValue(maximumResidual)}</dd></div>
          <div><dt>{grid ? 'Curve solve time' : 'Solve time'}</dt><dd>{formatSampleCount(Math.round(result.elapsed))} <small>ms</small></dd></div>
        </dl>
        {result.failures.length > 0 && <details className="diagnostic-details failure-details"><summary>{count(result.failures.length)} calculation issues</summary><ol className="diagnostic-failures">{result.failures.slice(0, 30).map((failure, index) => <li key={index}><span className="mono">{resultParameter ?? config.sweep.parameter} = {formatValue(failure.parameter)}</span><p>{failure.reason}</p></li>)}</ol>{result.failures.length > 30 && <p className="diagnostic-context">Showing the first 30 issues.</p>}</details>}
      </> : <p className="diagnostic-empty">{sliceError ? 'No valid result for this slice.' : grid && busy ? 'This combination has not finished yet.' : 'No result available.'}</p>}
    </section>
  </div>;
}
