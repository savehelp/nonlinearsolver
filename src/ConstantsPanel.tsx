import { useMemo } from 'react';
import { inspectConstants, type ConstantEntry, type ConstantInspection } from './core/constants';
import type { ComplexValue } from './core/complex';
import type { Configuration } from './core/types';
import { formatValue } from './format';

interface Props {
  config: Configuration;
  sourceError?: string;
}

function exactNumber(value: number): string {
  return Object.is(value, -0) ? '-0' : String(value);
}

function exactValue(value: ComplexValue): string {
  if (typeof value === 'number') return exactNumber(value);
  return `${exactNumber(value.re)} ${value.im < 0 || Object.is(value.im, -0) ? '-' : '+'} ${exactNumber(Math.abs(value.im))}i`;
}

function formatConstant(value: ComplexValue): string {
  if (typeof value === 'number') return formatValue(value);
  if (!Number.isFinite(value.re) || !Number.isFinite(value.im)) return '\u2014';
  if (value.im === 0) return formatValue(value.re);
  const imaginary = `${formatValue(Math.abs(value.im))}i`;
  if (value.re === 0) return `${value.im < 0 ? '\u2212' : ''}${imaginary}`;
  return `${formatValue(value.re)} ${value.im < 0 ? '\u2212' : '+'} ${imaginary}`;
}

function ConstantTable({ entries, label, expressions = false }: { entries: ConstantEntry[]; label: string; expressions?: boolean }) {
  return <div className="diagnostic-table-scroll"><table className="sampling-table" aria-label={label}>
    <thead><tr><th scope="col">Name</th>{expressions && <th scope="col">Expression</th>}<th scope="col">Value</th></tr></thead>
    <tbody>{entries.map(entry => <tr key={entry.name}>
      <td><strong>{entry.name}</strong></td>
      {expressions && <td><code>{entry.expression || '\u2014'}</code></td>}
      <td title={exactValue(entry.value)}>{formatConstant(entry.value)}</td>
    </tr>)}</tbody>
  </table></div>;
}

export default function ConstantsPanel({ config, sourceError }: Props) {
  const { inspection, error } = useMemo(() => {
    try { return { inspection: inspectConstants(config), error: '' }; }
    catch (reason) {
      const inspection: ConstantInspection = { parameters: [], assignments: [], transitions: [], issues: [] };
      // Keep independent fixed inputs visible even if mathematical source cannot be parsed.
      try {
        const inputs = inspectConstants({ ...config, equations: '', constraints: '', variables: config.variables.filter(variable => variable.kind === 'parameter'), axes: { ...config.axes, transitions: undefined } });
        inspection.parameters = inputs.parameters;
        inspection.issues = inputs.issues;
      } catch { /* The parse message below also covers malformed configuration. */ }
      return { inspection, error: reason instanceof Error ? reason.message : 'The constants could not be evaluated.' };
    }
  }, [config]);

  return <div className="constants-overview" role="region" aria-label="Model constants">
    {sourceError && <div className="diagnostic-error" role="alert"><strong>Last valid inputs</strong><p>The source has an error. These values use the last valid model and will update when the source is valid.</p><p>{sourceError}</p></div>}
    {error && <div className="diagnostic-error" role="alert"><strong>Constants need attention</strong><p>{error}</p></div>}
    <p className="diagnostic-context">{sourceError ? 'Constants from the last valid fixed inputs.' : 'Evaluated from the current fixed inputs. Values update as you edit without running a solve.'}</p>

    <section className="diagnostic-section" aria-label="Fixed inputs"><div className="diagnostic-section-heading"><h3>Fixed inputs</h3><span className="diagnostic-tag">{inspection.parameters.length}</span></div>
      {inspection.parameters.length ? <ConstantTable entries={inspection.parameters} label="Fixed input values"/> : <p className="diagnostic-empty">No fixed parameters.</p>}
    </section>

    <section className="diagnostic-section" aria-label="Folded assignments"><div className="diagnostic-section-heading"><h3>Folded assignments</h3><span className="diagnostic-tag">{inspection.assignments.length}</span></div>
      {inspection.assignments.length ? <ConstantTable entries={inspection.assignments} label="Folded assignment values" expressions/> : <p className="diagnostic-empty">No assignments reduce to constants with these fixed inputs.</p>}
      <p className="diagnostic-context">Swept parameters and values that depend on unknowns are omitted. Hover a value to see its full precision.</p>
    </section>

    {inspection.transitions.length > 0 && <section className="diagnostic-section" aria-label="Graph reference constants"><div className="diagnostic-section-heading"><h3>Graph references</h3></div>
      <div className="diagnostic-table-scroll"><table className="sampling-table" aria-label="Graph reference positions"><thead><tr><th scope="col">Axis</th><th scope="col">Expression</th><th scope="col">Position</th></tr></thead>
        <tbody>{inspection.transitions.map((entry, index) => <tr key={`${entry.axis}:${index}`}>
          <td><strong>{entry.axis.toUpperCase()}</strong></td><td><code>{entry.expression}</code></td>
          <td title={entry.value === undefined ? undefined : `${entry.axis.toUpperCase()} = ${exactNumber(entry.value)}`}>{entry.issue ? <span className="diagnostic-warning">{entry.issue}</span> : `${entry.axis.toUpperCase()} = ${formatValue(entry.value)}`}</td>
        </tr>)}</tbody>
      </table></div>
    </section>}

    {inspection.issues.length > 0 && <section className="diagnostic-section" aria-label="Constant evaluation issues"><div className="diagnostic-section-heading"><h3>Evaluation issues</h3></div>
      <ul className="diagnostic-failures">{inspection.issues.map((issue, index) => <li key={`${issue.name}:${index}`}><span className="mono">{issue.name}{issue.expression ? ` = ${issue.expression}` : ''}</span><p>{issue.message}</p></li>)}</ul>
    </section>}
  </div>;
}
