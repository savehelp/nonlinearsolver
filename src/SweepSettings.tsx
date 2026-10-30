import ExpressionInput from './ExpressionInput';
import type { Configuration } from './core/types';
import { sliceSweeps } from './core/variables';

interface Props {
  config: Configuration;
  onChange: (update: (config: Configuration) => void) => void;
  onValidity: (id: string, error: string | null) => void;
  onRevert: (error: string) => void;
  onValid: () => void;
}

export default function SweepSettings({ config, onChange, onValidity, onRevert, onValid }: Props) {
  const additional = sliceSweeps(config).map(dimension => dimension.parameter).filter(Boolean);

  return <section className="settings-content" aria-label="Sweep settings">
    <div className="settings-fields">
      <label>Sweep mode<select aria-label="Sweep mode" value={config.sweep.mode} onChange={event => onChange(current => {
        current.sweep.mode = event.target.value as Configuration['sweep']['mode'];
        current.sweep.parameter = current.variables.find(variable => variable.kind === (current.sweep.mode === 'free' ? 'parameter' : 'unknown'))?.name ?? '';
        current.sweep.release = current.variables.find(variable => variable.kind === 'parameter')?.name ?? '';
      })}>
        <option value="free">Free parameter sweep</option>
        <option value="constrained">Impose unknown, release parameter</option>
      </select></label>
      {config.sweep.mode === 'constrained' && <>
        <label>Imposed unknown<select aria-label="Imposed unknown" value={config.sweep.parameter} onChange={event => onChange(current => { current.sweep.parameter = event.target.value; })}>
          <option value="" disabled>Choose an unknown</option>
          {config.variables.filter(variable => variable.kind === 'unknown').map(variable => <option key={variable.name}>{variable.name}</option>)}
        </select></label>
        <label>Released parameter<select aria-label="Released parameter" value={config.sweep.release} onChange={event => onChange(current => { current.sweep.release = event.target.value; })}>
          <option value="" disabled>Choose a parameter</option>
          {config.variables.filter(variable => variable.kind === 'parameter').map(variable => <option key={variable.name}>{variable.name}</option>)}
        </select></label>
        <label>Sample spacing<select aria-label="Sample spacing" value={config.sweep.logarithmic ? 'log' : 'linear'} onChange={event => onChange(current => { current.sweep.logarithmic = event.target.value === 'log'; })}>
          <option value="linear">Linear</option>
          <option value="log">Logarithmic</option>
        </select></label>
        {([['min', 'Minimum'], ['max', 'Maximum'], ['points', 'Samples']] as const).map(([key, label]) => <label key={key}>{label}<ExpressionInput label={label} value={config.sweep[key]} onValue={value => {
          if (value !== undefined) onChange(current => { current.sweep[key] = value; });
        }} onValidity={onValidity} onRevert={onRevert} onValid={onValid}/></label>)}
      </>}
    </div>
    <dl className="settings-summary">
      {config.sweep.mode === 'free' && <div><dt>Main sweep</dt><dd>{config.sweep.parameter || 'None'}</dd></div>}
      <div><dt>Additional sweeps</dt><dd>{additional.join(', ') || 'None'}</dd></div>
    </dl>
  </section>;
}
