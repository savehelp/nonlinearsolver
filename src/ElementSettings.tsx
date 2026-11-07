import { useId, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';
import { createElementLibrary, elementLibraryEntries, mergeElementDefinitions, parseElementLibrary, removeElementDefinition, replaceElementDefinition, type ElementDefinition } from './core/elements';
import type { Configuration } from './core/types';
import { formatValue } from './format';

interface Props {
  config: Configuration;
  onChange: (definitions: ElementDefinition[]) => void;
  sourceError?: string;
}

interface ReplacementChoice { target: string; definitions: ElementDefinition[]; selected: string }
interface EditDraft { target: string; source: string }

function downloadLibrary(definitions: ElementDefinition[], filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(createElementLibrary(definitions), null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  URL.revokeObjectURL(url);
}

const modeLabel = (mode: ElementDefinition['mode']) => mode === 'real' ? 'Real mode' : mode === 'complex' ? 'Complex mode' : 'Real or complex';

export default function ElementSettings({ config, onChange, sourceError }: Props) {
  const file = useRef<HTMLInputElement>(null), fileTarget = useRef<string | null>(null);
  const errorId = useId();
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
  const [replacement, setReplacement] = useState<ReplacementChoice | null>(null), [editing, setEditing] = useState<EditDraft | null>(null);
  const { entries, issue } = useMemo(() => {
    try { return { entries: elementLibraryEntries(config), issue: '' }; }
    catch (reason) { return { entries: [], issue: reason instanceof Error ? reason.message : 'The element library could not be read.' }; }
  }, [config]);
  const locked = loading || Boolean(replacement || editing);
  const applyChange = (definitions: ElementDefinition[], message: string) => {
    onChange(definitions); setError(''); setStatus(message); setReplacement(null); setEditing(null);
  };
  const applyReplacement = (target: string, definition: ElementDefinition) => {
    applyChange(replaceElementDefinition(config.elementDefinitions, target, definition), definition.name === target
      ? `Replaced ${target} in this workspace. Existing ${target} instances use this definition.`
      : `Replaced ${target} with ${definition.name} in this workspace, keeping the name ${target} for existing instances.`);
  };
  const chooseFile = (target: string | null) => {
    fileTarget.current = target; setError(''); setStatus(''); file.current?.click();
  };
  const fail = (action: string, reason: unknown) => setError(`${action}: ${reason instanceof Error ? reason.message : 'The element definition could not be updated.'}`);

  return <div className="element-library" role="region" aria-label="Element library">
    <p className="diagnostic-context">Manage default and imported element types for this workspace. Replacing a type updates its existing instances. Save to keep definitions in this browser, or export a workspace ZIP with a separate JSON file for each type.</p>
    <p className="diagnostic-context">Instance parameter declarations, such as <code>parameter M1.VTO .65</code>, override the defaults in the library.</p>
    <div className="element-library-actions">
      <button className="button subtle" type="button" disabled={locked} onClick={() => chooseFile(null)}><ArrowDownToLine size={14}/>{loading ? 'Loading…' : 'Load element JSON'}</button>
      <button className="button subtle" type="button" disabled={!entries.length} onClick={() => downloadLibrary(entries.map(entry => entry.definition), 'element-library.json')}><ArrowUpFromLine size={14}/>Download library JSON</button>
    </div>
    <p className="diagnostic-context">Element files use JSON. Load adds types by name; matching names replace the existing type. Use a type's Replace button to keep its name when loading a differently named definition. Import a complete workspace ZIP or extracted workspace folder from the workspace settings menu.</p>
    <input hidden ref={file} type="file" accept=".json,application/json" aria-label="Element JSON file" onChange={async event => {
      const input = event.currentTarget, selected = input.files?.[0];
      if (!selected) return;
      const target = fileTarget.current; fileTarget.current = null;
      setLoading(true); setError(''); setStatus('');
      try {
        if (selected.size > 1_000_000) throw new Error('Please load an element JSON file smaller than 1 MB.');
        const incoming = parseElementLibrary(JSON.parse(await selected.text()));
        if (!incoming.length) throw new Error('No element types were found in this JSON file.');
        if (target) {
          const matching = incoming.find(definition => definition.name === target);
          if (matching || incoming.length === 1) applyReplacement(target, matching ?? incoming[0]);
          else setReplacement({ target, definitions: incoming, selected: '' });
        } else applyChange(mergeElementDefinitions(config.elementDefinitions, incoming), `Loaded ${incoming.length} element ${incoming.length === 1 ? 'type' : 'types'} into this workspace: ${incoming.map(definition => definition.name).join(', ')}.`);
      } catch (reason) { fail(target ? `Replace ${target}` : 'Load element JSON', reason); }
      finally { setLoading(false); input.value = ''; }
    }}/>
    {(error || issue) && <div className="diagnostic-error" role="alert" id={errorId}><strong>Element library needs attention</strong><p>{error || issue}</p></div>}
    {status && <p className="diagnostic-context" role="status">{status}</p>}
    {sourceError && <div className="diagnostic-error" role="alert"><strong>Workspace needs attention</strong><p>{sourceError}</p><p>Library changes remain applied. Repair the source or restore a compatible definition to resume solving.</p></div>}

    {replacement && <section className="element-replacement-choice" aria-label={`Choose replacement for ${replacement.target}`}>
      <p className="diagnostic-context">This file contains several types. Choose which one should replace <strong>{replacement.target}</strong> in this workspace.</p>
      <label>Replacement element type<select aria-label="Replacement element type" value={replacement.selected} onChange={event => setReplacement({ ...replacement, selected: event.target.value })}>
        <option value="" disabled>Choose a type</option>{replacement.definitions.map(definition => <option key={definition.name} value={definition.name}>{definition.name}</option>)}
      </select></label>
      <div className="element-library-actions">
        <button className="button primary" type="button" disabled={!replacement.selected} onClick={() => {
          const selected = replacement.definitions.find(definition => definition.name === replacement.selected);
          if (!selected) return;
          try { applyReplacement(replacement.target, selected); } catch (reason) { fail(`Replace ${replacement.target}`, reason); }
        }}>Apply replacement</button>
        <button className="button subtle" type="button" onClick={() => { setReplacement(null); setError(''); }}>Cancel replacement</button>
      </div>
    </section>}

    <section className="diagnostic-section" aria-label="Available element types">
      <div className="diagnostic-section-heading"><h3>Element types</h3><span className="diagnostic-tag">{entries.length}</span></div>
      {!entries.length && <p className="diagnostic-empty">No element definitions are available. Load an element JSON library to add one.</p>}
      {entries.map(({ definition, origin }) => <section className="diagnostic-section element-definition" aria-label={`${definition.name} element definition`} key={definition.name}>
        <div className="diagnostic-section-heading"><h3>{definition.name}</h3><span className="diagnostic-tag element-origin" data-origin={origin}>{origin === 'default' ? 'Default' : origin === 'replacement' ? 'Custom replacement' : 'Imported'}</span><span className="diagnostic-tag">{modeLabel(definition.mode)}</span></div>
        {definition.description && <p className="diagnostic-context">{definition.description}</p>}
        <p className="diagnostic-context">Required terminals: {definition.terminals.filter(terminal => !Object.hasOwn(definition.terminalDefaults ?? {}, terminal)).length ? <code>{definition.terminals.filter(terminal => !Object.hasOwn(definition.terminalDefaults ?? {}, terminal)).join(', ')}</code> : 'none'}.</p>
        {Object.entries(definition.terminalDefaults ?? {}).length > 0 && <p className="diagnostic-context">Optional terminals: <code>{Object.entries(definition.terminalDefaults ?? {}).map(([terminal, expression]) => `${terminal} = ${expression}`).join(', ')}</code>. These defaults apply unless the terminal or an alias appears in a circuit equation.</p>}
        <div className="element-library-actions">
          <button className="button subtle" type="button" disabled={locked} onClick={() => chooseFile(definition.name)}><ArrowDownToLine size={14}/>Replace {definition.name} JSON</button>
          <button className="button subtle" type="button" disabled={locked} onClick={() => { setError(''); setStatus(''); setEditing({ target: definition.name, source: JSON.stringify(createElementLibrary([definition]), null, 2) }); }}>Edit {definition.name} JSON</button>
          <button className="button subtle" type="button" onClick={() => downloadLibrary([definition], `${definition.name}.json`)}><ArrowUpFromLine size={14}/>Download {definition.name} JSON</button>
          {origin === 'replacement' && <button className="button subtle" type="button" disabled={locked} onClick={() => {
            try { applyChange(removeElementDefinition(config.elementDefinitions, definition.name), `Restored ${definition.name} to its default in this workspace.`); } catch (reason) { fail(`Restore ${definition.name}`, reason); }
          }}>Restore {definition.name} default</button>}
          {origin === 'imported' && <button className="button subtle" type="button" disabled={locked} onClick={() => {
            try { applyChange(removeElementDefinition(config.elementDefinitions, definition.name), `Removed ${definition.name} from this workspace. Its declarations must be removed or its definition loaded again before use.`); } catch (reason) { fail(`Remove ${definition.name}`, reason); }
          }}>Remove {definition.name}</button>}
        </div>
        {editing?.target === definition.name && <div className="element-json-editor" role="region" aria-label={`Edit ${definition.name} definition`}>
          <label htmlFor={`${errorId}-editor`}>Element JSON for {definition.name}</label>
          <textarea id={`${errorId}-editor`} aria-label={`${definition.name} element JSON`} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} spellCheck={false} rows={16} value={editing.source} onChange={event => setEditing({ ...editing, source: event.target.value })}/>
          <p className="diagnostic-context">Save one definition with the name <code>{definition.name}</code>. To add another type, use Load element JSON instead.</p>
          <div className="element-library-actions">
            <button className="button primary" type="button" onClick={() => {
              try {
                if (new Blob([editing.source]).size > 1_000_000) throw new Error('Keep the element JSON smaller than 1 MB.');
                const parsed = parseElementLibrary(JSON.parse(editing.source));
                if (parsed.length !== 1) throw new Error('Save exactly one element definition when editing a type.');
                if (parsed[0].name !== editing.target) throw new Error(`Keep the name ${editing.target} when editing. Load JSON to add a new type.`);
                applyChange(replaceElementDefinition(config.elementDefinitions, editing.target, parsed[0]), `Saved ${editing.target} changes in this workspace. Existing instances use this definition.`);
              } catch (reason) { fail(`Edit ${editing.target}`, reason); }
            }}>Save changes</button>
            <button className="button subtle" type="button" onClick={() => { setEditing(null); setError(''); }}>Cancel editing</button>
          </div>
        </div>}
        <details className="diagnostic-details"><summary>Parameters and equations</summary>
          {Object.keys(definition.terminalAliases ?? {}).length > 0 && <p className="diagnostic-context">Alternative terminal names: <code>{Object.entries(definition.terminalAliases ?? {}).map(([alias, terminal]) => `${alias} = ${terminal}`).join(', ')}</code>. Existing connections using these names remain supported.</p>}
          {Object.keys(definition.parameters).length > 0 && <div className="diagnostic-table-scroll"><table className="sampling-table" aria-label={`${definition.name} parameter defaults`}>
            <thead><tr><th scope="col">Parameter</th><th scope="col">Default</th></tr></thead><tbody>{Object.entries(definition.parameters).map(([name, parameter]) => <tr key={name}><td><strong>{name}</strong></td><td title={String(parameter.value)}>{formatValue(parameter.value)}</td></tr>)}</tbody>
          </table></div>}
          {definition.unknowns && Object.keys(definition.unknowns).length > 0 && <div className="diagnostic-table-scroll"><table className="sampling-table" aria-label={`${definition.name} initial guesses`}>
            <thead><tr><th scope="col">Unknown</th><th scope="col">Initial guess</th></tr></thead><tbody>{Object.entries(definition.unknowns).map(([name, value]) => <tr key={name}><td><strong>{name}</strong></td><td title={String(value)}>{formatValue(value)}</td></tr>)}</tbody>
          </table></div>}
          <pre aria-label={`${definition.name} equations`}>{definition.equations.map(equation => equation.trim().endsWith(';') ? equation : `${equation};`).join('\n')}</pre>
        </details>
      </section>)}
    </section>

    <details className="diagnostic-details" aria-label="Using elements"><summary>How to use an element</summary>
      <pre>{'element NMOSFET M1\nM1.g = vin;\nM1.s = 0;\nM1.d = Vdd - M1.id*R1;'}</pre>
      <p className="diagnostic-context">An unused declaration adds no equations. Referencing a member activates the complete model; connect every required terminal with an equation. Each instance has its own members and parameter defaults. Override an input with a declaration such as <code>parameter M1.VTO .65</code> or <code>parameter M1.W 2u</code>. Threshold <code>M1.VTH</code> and length-dependent <code>M1.LAMBDA</code> are computed members.</p>
      <p className="diagnostic-context">The supplied NMOSFET and PMOSFET use real DC channel models with body effect; turn off Complex mode to use them. Connect gate <code>M1.g</code>, drain <code>M1.d</code>, and source <code>M1.s</code>. The model automatically swaps its internal source/drain roles according to their voltages. Current <code>M1.id</code> keeps a fixed drain-to-source reference: positive means d to s; negative means s to d. Normal PMOS current is negative with this convention. Body terminal <code>M1.b</code> defaults to the fixed s pin. For bidirectional operation, connect the body explicitly at or below both conduction terminals for NMOS, or at or above both for PMOS. Your equations provide circuit connections and current balance. These models omit capacitances, body-diode currents, subthreshold conduction, and temperature variation.</p>
    </details>
  </div>;
}
