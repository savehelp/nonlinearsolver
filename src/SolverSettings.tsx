import ExpressionInput from './ExpressionInput';
import type { Configuration } from './core/types';

interface Props {
  config: Configuration;
  onChange: (update: (config: Configuration) => void) => void;
  onValidity: (id: string, error: string | null) => void;
  onRevert: (error: string) => void;
  onValid: () => void;
}

export default function SolverSettings({ config, onChange, onValidity, onRevert, onValid }: Props) {
  return <section className="settings-content" aria-label="Solver settings">
    <div className="settings-fields">
      {([
        ['tolerance', 'Tolerance', 'Greater than 0, up to 0.1'],
        ['iterations', 'Maximum iterations', '1–1,000 per starting guess'],
        ['starts', 'Multistart guesses', '1–64'],
      ] as const).map(([key, label, range]) => <label key={key}>{label}<ExpressionInput label={label} value={config.solver[key]} onValue={value => {
        if (value !== undefined) onChange(current => { current.solver[key] = value; });
      }} onValidity={onValidity} onRevert={onRevert} onValid={onValid}/><small className="field-hint">{range}</small></label>)}
    </div>
  </section>;
}
