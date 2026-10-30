import { Copy, X } from 'lucide-react';
import type { Configuration, Point } from './core/types';
import { formatValue } from './format';

interface Props {
  point: Point;
  config: Configuration;
  equations?: string[];
  unknowns?: string[];
  onClose: () => void;
  onCopy: () => void;
}

export default function PointInspector({ point, config, equations, unknowns, onClose, onCopy }: Props) {
  const variables = new Map(config.variables.map(variable => [variable.name, variable]));
  const constrained = config.sweep.mode === 'constrained';
  const fixed = (name: string) => constrained && name === config.sweep.parameter
    || variables.get(name)?.kind === 'parameter' && !(constrained && name === config.sweep.release);
  const values = Object.entries(point.values);
  const primary = values.filter(([name]) => !fixed(name));
  const inputs = values.filter(([name]) => fixed(name));
  const role = (name: string) => variables.get(name)?.kind === 'unknown' || constrained && name === config.sweep.release ? 'Unknown' : 'Computed';
  const equationLabels = point.diagnosticEquations ?? equations ?? [];
  const unknownLabels = point.diagnosticUnknowns ?? unknowns ?? [];
  const columns = point.jacobian.reduce((count, row) => Math.max(count, row.length), 0);

  return <div className="modal-backdrop" onClick={onClose}>
    <section className="modal inspector" role="dialog" aria-modal="true" aria-label="Operating point inspector" onClick={event => event.stopPropagation()}>
      <div className="modal-heading">
        <div><h2>Operating point</h2><p className="inspector-context">{config.sweep.parameter} = {formatValue(point.parameter)} <span>· Segment {point.branch}</span></p></div>
        <button className="icon-button" aria-label="Close operating point inspector" onClick={onClose}><X size={20}/></button>
      </div>
      <div className="inspector-badges"><span>{point.iterations} iterations · residual {formatValue(point.norm)}</span></div>
      <div className="table-scroll"><table>
        <thead><tr><th>Variable</th><th>Value (SI)</th><th>Role</th></tr></thead>
        <tbody>{primary.map(([name, value]) => <tr key={name}><td>{name}</td><td className="mono">{formatValue(value)}</td><td>{role(name)}</td></tr>)}</tbody>
      </table></div>
      {inputs.length > 0 && <details className="inspector-inputs"><summary>Fixed inputs ({inputs.length})</summary>
        <div className="table-scroll"><table><thead><tr><th>Variable</th><th>Value (SI)</th></tr></thead>
          <tbody>{inputs.map(([name, value]) => <tr key={name}><td>{name}</td><td className="mono">{formatValue(value)}</td></tr>)}</tbody>
        </table></div>
      </details>}
      <details><summary>Equation residuals</summary>{point.residuals.map((residual, index) => <div className="residual-row" key={index}><code>{equationLabels[index] ?? `F${index + 1}`}</code><span>{formatValue(residual)}</span></div>)}</details>
      <details><summary>Numerical Jacobian · ∂F / ∂unknown</summary><div className="table-scroll"><table>
        <thead><tr><th>Equation</th>{Array.from({ length: columns }, (_, index) => <th key={index}>{unknownLabels[index] ?? `x${index + 1}`}</th>)}</tr></thead>
        <tbody>{point.jacobian.map((row, index) => <tr key={index}><td>F{index + 1}</td>{row.map((value, column) => <td key={column} className="mono">{formatValue(value)}</td>)}</tr>)}</tbody>
      </table></div></details>
      <button className="button subtle" onClick={onCopy}><Copy size={14}/>Copy point JSON</button>
    </section>
  </div>;
}
