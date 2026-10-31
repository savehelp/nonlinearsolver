import { Copy, X } from 'lucide-react';
import { useMemo } from 'react';
import type { Configuration, Point } from './core/types';
import { formatValue } from './format';
import { inferVariables } from './core/inference';
import { equationAssignment, equationProgram } from './core/equations';

function formatComplex(value: { re: number; im: number }): string {
  if (!Number.isFinite(value.re) || !Number.isFinite(value.im)) return '—';
  if (value.im === 0) return formatValue(value.re);
  const imaginary = `${formatValue(Math.abs(value.im))}i`;
  if (value.re === 0) return `${value.im < 0 ? '−' : ''}${imaginary}`;
  return `${formatValue(value.re)} ${value.im < 0 ? '−' : '+'} ${imaginary}`;
}

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
  const implicitUnknowns = useMemo(() => {
    try {
      const program = equationProgram(config.equations), assigned = new Set(program.equations.map(equationAssignment).filter(assignment => assignment !== null).map(assignment => assignment.name));
      const declared = new Set(config.variables.map(variable => variable.name));
      return new Set(inferVariables(config, program).filter(variable => variable.kind === 'unknown' && !declared.has(variable.name) && !assigned.has(variable.name)).map(variable => variable.name));
    } catch { return new Set<string>(); }
  }, [config]);
  const constrained = config.sweep.mode === 'constrained';
  const fixed = (name: string) => constrained && name === config.sweep.parameter && !Object.hasOwn(point.complexValues ?? {}, name)
    || variables.get(name)?.kind === 'parameter' && !(constrained && name === config.sweep.release);
  const complexValues = point.complexValues ?? {};
  const components = new Set(Object.keys(complexValues).flatMap(name => [`real(${name})`, `imag(${name})`]));
  const values: [string, string][] = [
    ...Object.entries(point.values).filter(([name]) => !components.has(name) && !Object.hasOwn(complexValues, name))
      .map(([name, value]): [string, string] => [name, formatValue(value)]),
    ...Object.entries(complexValues).map(([name, value]): [string, string] => [name, formatComplex(value)]),
  ];
  const primary = values.filter(([name]) => !fixed(name));
  const inputs = values.filter(([name]) => fixed(name));
  const role = (name: string) => variables.get(name)?.kind === 'unknown' || implicitUnknowns.has(name) || constrained && name === config.sweep.release ? 'Unknown' : 'Computed';
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
        <tbody>{primary.map(([name, value]) => <tr key={name}><td>{name}</td><td className="mono">{value}</td><td>{role(name)}</td></tr>)}</tbody>
      </table></div>
      {inputs.length > 0 && <details className="inspector-inputs"><summary>Fixed inputs ({inputs.length})</summary>
        <div className="table-scroll"><table><thead><tr><th>Variable</th><th>Value (SI)</th></tr></thead>
          <tbody>{inputs.map(([name, value]) => <tr key={name}><td>{name}</td><td className="mono">{value}</td></tr>)}</tbody>
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
