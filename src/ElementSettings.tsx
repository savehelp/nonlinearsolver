import { useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';
import { createElementLibrary, elementDefinitions, parseElementLibrary, type ElementDefinition } from './core/elements';
import type { Configuration } from './core/types';
import { formatValue } from './format';

interface Props {
  config: Configuration;
  onLoad: (definitions: ElementDefinition[]) => void;
}

function downloadLibrary(definitions: ElementDefinition[], filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(createElementLibrary(definitions), null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  URL.revokeObjectURL(url);
}

const modeLabel = (mode: ElementDefinition['mode']) => mode === 'real' ? 'Real mode' : mode === 'complex' ? 'Complex mode' : 'Real or complex';

export default function ElementSettings({ config, onLoad }: Props) {
  const file = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
  const { definitions, issue } = useMemo(() => {
    try { return { definitions: elementDefinitions(config), issue: '' }; }
    catch (reason) { return { definitions: [], issue: reason instanceof Error ? reason.message : 'The element library could not be read.' }; }
  }, [config]);

  return <div className="element-library" role="region" aria-label="Element library">
    <p className="diagnostic-context">Load a JSON library to add element types. Loaded definitions are included when you save or export the workspace. A type with an existing name replaces that type in this workspace.</p>
    <div className="element-library-actions">
      <button className="button subtle" type="button" disabled={loading} onClick={() => file.current?.click()}><ArrowUpFromLine size={14}/>{loading ? 'Loading…' : 'Load element JSON'}</button>
      <button className="button subtle" type="button" disabled={!definitions.length} onClick={() => downloadLibrary(definitions, 'element-library.json')}><ArrowDownToLine size={14}/>Download library JSON</button>
    </div>
    <input hidden ref={file} type="file" accept=".json,application/json" aria-label="Element JSON file" onChange={async event => {
      const input = event.currentTarget, selected = input.files?.[0];
      if (!selected) return;
      setLoading(true); setError(''); setStatus('');
      try {
        if (selected.size > 1_000_000) throw new Error('Please load an element JSON file smaller than 1 MB.');
        const incoming = parseElementLibrary(JSON.parse(await selected.text()));
        onLoad(incoming);
        setStatus(`Loaded ${incoming.length} element ${incoming.length === 1 ? 'type' : 'types'}: ${incoming.map(definition => definition.name).join(', ')}.`);
      } catch (reason) { setError(reason instanceof Error ? reason.message : 'The element JSON could not be loaded.'); }
      finally { setLoading(false); input.value = ''; }
    }}/>
    {(error || issue) && <div className="diagnostic-error" role="alert"><strong>Element library needs attention</strong><p>{error || issue}</p></div>}
    {status && <p className="diagnostic-context" role="status">{status}</p>}

    <section className="diagnostic-section" aria-label="Using elements">
      <div className="diagnostic-section-heading"><h3>Use an element</h3></div>
      <pre>{'element NMOSFET M1\nM1.g = vin;\nM1.s = 0;\nM1.d = Vdd - M1.id*R1;'}</pre>
      <p className="diagnostic-context">An unused declaration adds no equations. Referencing a member activates the complete model; connect every required terminal with an equation. Each instance has its own members and parameter defaults. Override a default with a declaration such as <code>parameter M1.VTH .65</code>.</p>
      <p className="diagnostic-context">The supplied NMOSFET uses real DC voltages and drain-to-source current <code>M1.id</code>; turn off Complex mode to use it. Your equations provide the surrounding circuit connections and current balance.</p>
    </section>

    <section className="diagnostic-section" aria-label="Available element types">
      <div className="diagnostic-section-heading"><h3>Available types</h3><span className="diagnostic-tag">{definitions.length}</span></div>
      {!definitions.length && <p className="diagnostic-empty">No element definitions are available. Load an element JSON library to add one.</p>}
      {definitions.map(definition => <section className="diagnostic-section" aria-label={`${definition.name} element definition`} key={definition.name}>
        <div className="diagnostic-section-heading"><h3>{definition.name}</h3><span className="diagnostic-tag">{modeLabel(definition.mode)}</span></div>
        {definition.description && <p className="diagnostic-context">{definition.description}</p>}
        <p className="diagnostic-context">Required terminals: {definition.terminals.length ? <code>{definition.terminals.join(', ')}</code> : 'none'}.</p>
        <details className="diagnostic-details"><summary>Parameters and equations</summary>
          {Object.keys(definition.parameters).length > 0 && <div className="diagnostic-table-scroll"><table className="sampling-table" aria-label={`${definition.name} parameter defaults`}>
            <thead><tr><th scope="col">Parameter</th><th scope="col">Default</th></tr></thead><tbody>{Object.entries(definition.parameters).map(([name, parameter]) => <tr key={name}><td><strong>{name}</strong></td><td title={String(parameter.value)}>{formatValue(parameter.value)}</td></tr>)}</tbody>
          </table></div>}
          {definition.unknowns && Object.keys(definition.unknowns).length > 0 && <div className="diagnostic-table-scroll"><table className="sampling-table" aria-label={`${definition.name} initial guesses`}>
            <thead><tr><th scope="col">Unknown</th><th scope="col">Initial guess</th></tr></thead><tbody>{Object.entries(definition.unknowns).map(([name, value]) => <tr key={name}><td><strong>{name}</strong></td><td title={String(value)}>{formatValue(value)}</td></tr>)}</tbody>
          </table></div>}
          <pre aria-label={`${definition.name} equations`}>{definition.equations.map(equation => equation.trim().endsWith(';') ? equation : `${equation};`).join('\n')}</pre>
        </details>
        <div className="element-library-actions"><button className="button subtle" type="button" onClick={() => downloadLibrary([definition], `${definition.name}.json`)}><ArrowDownToLine size={14}/>Download {definition.name} JSON</button></div>
      </section>)}
    </section>
  </div>;
}
