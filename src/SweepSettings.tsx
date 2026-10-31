import type { Configuration } from './core/types';
import { sliceSweeps } from './core/variables';

interface Props {
  config: Configuration;
  onChange: (update: (config: Configuration) => void) => void;
  onValidity: (id: string, error: string | null) => void;
  onRevert: (error: string) => void;
  onValid: () => void;
}

export default function SweepSettings({ config }: Props) {
  const additional = sliceSweeps(config).map(dimension => dimension.parameter).filter(Boolean);
  const legacy = config.sweep.mode === 'constrained';

  return <section className="settings-content" aria-label="Sweep settings">
    {legacy && <p className="field-hint">Impose/release sweeps are deprecated. This saved workspace keeps its existing settings for compatibility. Use a new equation workspace to start a parameter sweep.</p>}
    {!legacy && <p className="field-hint">Mark a parameter with sweep in its declaration, then choose the main time axis with set_time_axis. The declaration controls its starting value, step, and range; other marked parameters add slice dimensions.</p>}
    <dl className="settings-summary">
      <div><dt>{legacy ? 'Legacy imposed unknown' : 'Time axis'}</dt><dd>{config.sweep.parameter || 'None'}</dd></div>
      {legacy && <div><dt>Legacy released parameter</dt><dd>{config.sweep.release || 'None'}</dd></div>}
      <div><dt>Additional sweeps</dt><dd>{additional.join(', ') || 'None'}</dd></div>
      {!legacy && config.sweep.parameter && <>
        <div><dt>Main range</dt><dd>{config.sweep.min} to {config.sweep.max}</dd></div>
        <div><dt>Main step</dt><dd>{config.sweep.step ?? 'Set in the parameter declaration'}</dd></div>
        <div><dt>Starting value</dt><dd>{config.sweep.startAt ?? config.variables.find(variable => variable.name === config.sweep.parameter)?.value ?? 'Set in the parameter declaration'}</dd></div>
      </>}
    </dl>
  </section>;
}
