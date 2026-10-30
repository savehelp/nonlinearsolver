import type { Configuration, Variable } from './core/types';
import { sliceSweeps } from './core/variables';
import ExpressionInput from './ExpressionInput';

const fmt = (value: number | undefined) => value !== undefined && Number.isFinite(value) ? Number(value.toPrecision(6)).toString() : '—';
interface Props {
  config: Configuration;
  parameters: Variable[];
  update: (index: number, update: Partial<Variable>) => void;
  sliceViews: Record<string, { index: number; values: number[] }>;
  slicesAvailable: boolean;
  onSlice: (parameter: string, index: number) => void;
  onValidity: (id: string, error: string | null) => void;
  onRevert: (error: string) => void;
  onValid: () => void;
}

export default function ParameterSliders({ config, parameters, update, sliceViews, slicesAvailable, onSlice, onValidity, onRevert, onValid }: Props) {
  const dimensions = sliceSweeps(config);
  return <div className="sliders-grid">{parameters.map(variable => {
    const index = config.variables.indexOf(variable);
    const swept = variable.name === config.sweep.parameter || (config.sweep.mode === 'constrained' && variable.name === config.sweep.release);
    const primary = config.sweep.mode === 'free' && variable.name === config.sweep.parameter;
    const slice = dimensions.find(dimension => dimension.parameter === variable.name);
    const secondary = Boolean(slice);
    const view = sliceViews[variable.name];
    const values = view?.values ?? [];
    const sliceIndex = Math.min(Math.max(0, view?.index ?? 0), Math.max(0, values.length - 1));
    const sliceAvailable = slicesAvailable && values.length > 0;
    const hasSlider = Number.isFinite(variable.step) && variable.step! > 0 && Number.isFinite(variable.min) && Number.isFinite(variable.max) && variable.min! < variable.max!;
    const lower = slice ? slice.min : primary ? config.sweep.min : variable.min;
    const upper = slice ? slice.max : primary ? config.sweep.max : variable.max;
    return <div className={`slider-control ${swept ? 'swept' : ''} ${secondary ? 'slice-control' : ''}`} key={variable.name}>
      <div className="slider-label"><label htmlFor={hasSlider ? `slider-${index}` : undefined}>{variable.name}</label>
        {swept ? <span className="swept-badge">{variable.name === config.sweep.release ? 'SOLVED' : 'SWEPT'}</span>
          : secondary ? <output className="slice-value" aria-label={`${variable.name} current value`}>{sliceAvailable ? fmt(values[sliceIndex]) : '—'}</output>
          : <ExpressionInput label={`${variable.name} fixed value`} value={variable.value} onValue={value => { if (value !== undefined) update(index, { value }); }} onValidity={onValidity} onRevert={onRevert} onValid={onValid}/>}
      </div>
      {hasSlider && <><input id={`slider-${index}`} aria-label={`${variable.name} ${secondary ? 'slice slider' : 'slider'}`} type="range"
        aria-valuetext={secondary && sliceAvailable ? `${variable.name} = ${fmt(values[sliceIndex])}` : undefined}
        min={secondary ? 0 : lower} max={secondary ? Math.max(0, values.length - 1) : upper}
        step={secondary ? 1 : variable.step ?? 'any'} value={secondary ? sliceIndex : variable.value}
        disabled={swept || (secondary && !sliceAvailable)}
        title={secondary ? 'Select an exact precomputed slice. No additional calculation.' : undefined}
        onChange={event => secondary ? onSlice(variable.name, Number(event.target.value)) : update(index, { value: Number(event.target.value) })}/>
      <div className="slider-extents"><span>{fmt(lower)}</span><span>{fmt(upper)}</span></div></>}
    </div>;
  })}</div>;
}
