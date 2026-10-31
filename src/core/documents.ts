import { applyDeclarations, formatDeclarations, parseDeclarations, type DeclarationKind } from './declarations';
import { compile, residual } from './expression';
import { equationProgram } from './equations';
import { inferVariables } from './inference';
import { plotArguments, plotCurves, yExpressions } from './axes';
import { evaluateTransitionLines, MAX_TRANSITION_LINES, TransitionExpressionError } from './transitions';
import { expandElements, type ElementDeclaration, type ElementUsage } from './elements';
import type { Configuration, EditorDocument, PlotTransition, Variable } from './types';

export const MAX_EDITOR_DOCUMENTS = 32;
export const MAX_DOCUMENT_SOURCE = 200_000;

/** Plot drafts must not cancel a numerical solve or discard computed roots. */
export class PlotSourceError extends Error {
  readonly kind = 'plot';
  constructor(message: string, readonly config?: Configuration) { super(message); this.name = 'PlotSourceError'; }
}

export function validateDocuments(documents: unknown): asserts documents is EditorDocument[] {
  if (!Array.isArray(documents) || documents.length < 1 || documents.length > MAX_EDITOR_DOCUMENTS) throw new Error(`Use 1–${MAX_EDITOR_DOCUMENTS} editor tabs.`);
  const names = new Set<string>(); let length = 0;
  for (const document of documents) {
    if (!document || typeof document !== 'object' || typeof document.id !== 'string' || !document.id || document.id.length > 100 || typeof document.title !== 'string' || !document.title.trim() || document.title.length > 100 || typeof document.source !== 'string') throw new Error('Each editor tab needs a unique ID, a name, and text.');
    if (names.has(document.id)) throw new Error('Editor tab IDs must be unique.');
    names.add(document.id); length += document.source.length;
  }
  if (length > MAX_DOCUMENT_SOURCE) throw new Error(`Editor tabs exceed ${MAX_DOCUMENT_SOURCE.toLocaleString('en-US')} characters in total.`);
}

/** Seed source tabs for built-in models that use the engine representation. */
export function ensureDocuments(config: Configuration): EditorDocument[] {
  if (config.documents !== undefined) { validateDocuments(config.documents); return config.documents; }
  config.documents = [
    { id: 'equations', title: 'Equations', source: [config.equations, [
      ...(config.axes.x && config.axes.y ? [`set_time_axis ${config.axes.x}`, ...plotCurves(config.axes).map(curve => config.axes.curves ? `plot (${curve.y}) (${curve.x})` : `plot ${curve.y}`)] : []),
      ...(config.axes.transitions ?? []).map(transition => `plot_${transition.axis}_transition ${transition.expression}`),
    ].join('\n')].filter(Boolean).join('\n\n') },
    { id: 'definitions', title: 'Definitions', source: [formatDeclarations(config, 'unknown'), formatDeclarations(config, 'parameter')].filter(Boolean).join('\n\n') },
  ];
  return config.documents;
}

type StatementKind = DeclarationKind | 'element' | 'plot' | 'set_time_axis' | 'plot_x_transition' | 'plot_y_transition';
interface Statement { start: number; end: number; line: number; clean: string; kind?: StatementKind }
const statementKind = (clean: string): StatementKind | undefined => /^(unknown|parameter|element|plot_x_transition|plot_y_transition|plot|set_time_axis)(?:\s|$)/.exec(clean)?.[1] as StatementKind | undefined;
const plotting = (kind?: StatementKind) => kind === 'plot' || kind === 'set_time_axis' || kind === 'plot_x_transition' || kind === 'plot_y_transition';

/** Declarations and plot commands end at top-level newlines or semicolons. Math uses the existing
 * semicolon convention, including multiline expressions; legacy newline-only
 * tabs still work. Comments and raw source positions remain in the document. */
function statements(source: string): Statement[] {
  const result: Statement[] = [], legacy = !source.replace(/#[^\r\n]*/g, '').includes(';');
  let start = 0, clean = '', depth = 0, comment = false, line = 1, firstLine = 1;
  const syntaxError = (message: string) => plotting(statementKind(clean.trim())) ? new PlotSourceError(message) : new Error(message);
  const flush = (end: number, terminated: boolean) => {
    const text = clean.trim(), kind = statementKind(text);
    if (text) {
      if (!kind && !legacy && !terminated) throw new Error(`Line ${firstLine}: end each equation or validity check with a semicolon (;).`);
      result.push({ start, end, line: firstLine, clean: text, kind });
    }
    start = end + (terminated ? 1 : 0); clean = ''; firstLine = line;
  };
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '\n') {
      if (depth === 0 && (statementKind(clean.trim()) || legacy || !clean.trim())) flush(index, false);
      else clean += char;
      comment = false; line++;
      if (!clean.trim()) { start = index + 1; firstLine = line; }
      continue;
    }
    if (comment) continue;
    if (char === '#') { comment = true; continue; }
    if (!clean.trim() && char.trim()) firstLine = line;
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (depth < 0) throw syntaxError(`Line ${line}: unexpected closing parenthesis.`);
    if (char === ';' && depth === 0) { flush(index, true); firstLine = line; }
    else clean += char;
  }
  if (depth) throw syntaxError(`Line ${firstLine}: close every parenthesized expression.`);
  flush(source.length, false);
  return result;
}

const describe = (document: EditorDocument, line: number, message: string) => `“${document.title}”, line ${line}: ${message}`;

/** Compile atomically. Invalid drafts stay in config.documents under the UI's
 * control; this function never mutates accepted engine inputs or source text. */
export function compileDocuments(config: Configuration, documents: EditorDocument[]): Configuration {
  validateDocuments(documents);
  const unknowns: Variable[] = [], parameters: Variable[] = [], swept: string[] = [], equations: string[] = [];
  const declarations = new Map<string, { document: EditorDocument; line: number }>();
  const elements: ElementDeclaration[] = [], usages: ElementUsage[] = [];
  const display: { part: Statement; document: EditorDocument }[] = [];
  for (const document of documents) {
    let parts: Statement[];
    try { parts = statements(document.source); }
    catch (error) {
      const message = `“${document.title}”: ${(error as Error).message}`;
      throw error instanceof PlotSourceError ? new PlotSourceError(message) : new Error(message);
    }
    for (const part of parts) {
      try {
        if (plotting(part.kind)) {
          display.push({ part, document });
          usages.push({ source: part.clean, kind: 'display', location: describe(document, part.line, '') });
        } else if (part.kind === 'element') {
          const match = /^element\s+([A-Za-z_][A-Za-z_0-9]*)\s+([A-Za-z_][A-Za-z_0-9]*)$/.exec(part.clean);
          if (!match) throw new Error('Use element Type Instance, for example element NMOSFET M1.');
          elements.push({ type: match[1], name: match[2], location: describe(document, part.line, '') });
        }
        else if (part.kind === 'unknown' || part.kind === 'parameter') {
          const parsed = parseDeclarations(part.clean, part.kind), variable = parsed.variables[0];
          const previous = declarations.get(variable.name);
          if (previous) throw new Error(`“${variable.name}” is already declared in “${previous.document.title}”, line ${previous.line}.`);
          declarations.set(variable.name, { document, line: part.line });
          (part.kind === 'unknown' ? unknowns : parameters).push(variable); swept.push(...parsed.swept);
        } else {
          const program = equationProgram(part.clean + ';');
          program.equations.forEach(residual); program.conditions.forEach(compile);
          equations.push(part.clean + ';');
          usages.push({ source: part.clean, kind: 'math', location: describe(document, part.line, '') });
        }
      } catch (error) { throw new Error(describe(document, part.line, (error as Error).message)); }
    }
  }
  const expanded = expandElements(config, elements, usages, [...unknowns, ...parameters]);
  equations.push(...expanded.equations);
  unknowns.push(...expanded.variables.filter(variable => variable.kind === 'unknown'));
  parameters.push(...expanded.variables.filter(variable => variable.kind === 'parameter'));
  if (unknowns.length + parameters.length > 100) throw new Error('Use at most 100 unknowns and parameters across all tabs.');
  const math = equations.join('\n');
  if (math.length > 50_000) throw new Error('Equations across all tabs exceed 50,000 characters.');
  const next = structuredClone(config);
  next.variables = []; next.constraints = ''; next.equations = math;
  next.axes = { x: '', y: '' };
  // The time selection controls the traced sweep, independently of each
  // curve's displayed X expression and of declaration order.
  const timeCommand = display.find(({ part }) => part.kind === 'set_time_axis');
  const timeName = timeCommand && /^set_time_axis\s+([A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)?)$/.exec(timeCommand.part.clean)?.[1];
  if (next.sweep.mode === 'free' && timeName && swept.includes(timeName)) next.sweep.parameter = timeName;
  applyDeclarations(next, 'unknown', { variables: unknowns, swept: [] });
  try { applyDeclarations(next, 'parameter', { variables: parameters, swept }); }
  catch (error) {
    // Sweep count errors name their parameter. Locate its declaration as well.
    const message = (error as Error).message;
    const match = parameters.find(variable => message.startsWith(`${variable.name}:`) || message.includes(`“${variable.name}”`));
    const at = match && declarations.get(match.name);
    throw new Error(at ? describe(at.document, at.line, message) : message);
  }
  next.documents = documents.map(document => ({ ...document }));
  // Plotting is validated only after the mathematical model. Even an invalid
  // display command can carry a valid model for the computation lifecycle.
  const definitions = inferVariables(next), names = new Set(definitions.map(variable => variable.name));
  const plotted: { x?: string; y: string }[] = [];
  const transitions: PlotTransition[] = [], transitionLocations: { document: EditorDocument; line: number }[] = [];
  let selected: { parameter: string; document: EditorDocument; line: number } | undefined;
  let firstPlot: { document: EditorDocument; line: number } | undefined;
  for (const { part, document } of display) {
    try {
      if (part.kind === 'set_time_axis') {
        const match = /^set_time_axis\s+([A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)?)$/.exec(part.clean);
        if (!match) throw new Error('Use set_time_axis parameter, for example set_time_axis x.');
        const parameter = match[1];
        if (selected && parameter !== selected.parameter) throw new Error(`The time axis is already set to “${selected.parameter}” in “${selected.document.title}”, line ${selected.line}. Use one traversal parameter across all tabs.`);
        if (next.sweep.mode === 'constrained' && parameter !== next.sweep.parameter) throw new Error(`In constrained mode, set_time_axis must select the imposed unknown “${next.sweep.parameter}”. Use plot y x to choose other displayed coordinates.`);
        const imposed = next.sweep.mode === 'constrained' && parameter === next.sweep.parameter && definitions.some(variable => variable.kind === 'unknown' && variable.name === parameter);
        if (!swept.includes(parameter) && !imposed) throw new Error(`“${parameter}” must already be selected for a sweep. Add sweep after its parameter value, step, minimum and maximum.`);
        if (next.sweep.mode === 'constrained' && parameter === next.sweep.release) throw new Error(`“${parameter}” is released by the constrained sweep and cannot also be swept.`);
        selected ??= { parameter, document, line: part.line };
      } else if (part.kind === 'plot_x_transition' || part.kind === 'plot_y_transition') {
        const match = /^plot_([xy])_transition\s+([\s\S]+)$/.exec(part.clean);
        if (!match) throw new Error(`Use ${part.kind} constant, for example ${part.kind} 0.`);
        compile(match[2]);
        transitions.push({ axis: match[1] as 'x' | 'y', expression: match[2].trim() });
        transitionLocations.push({ document, line: part.line });
        if (transitions.length > MAX_TRANSITION_LINES) throw new Error(`Use at most ${MAX_TRANSITION_LINES} transition lines.`);
      } else {
        const match = /^plot\s+([\s\S]+)$/.exec(part.clean);
        if (!match) throw new Error('Use plot y or plot y x.');
        firstPlot ??= { document, line: part.line };
        for (const curve of plotArguments(match[1])) {
          for (const expression of [curve.x, curve.y]) if (expression !== undefined) {
            for (const name of compile(expression).variables) if (!names.has(name) && !(next.solver.complex && (name === 'i' || name === 'j'))) throw new Error(`“${name}” is not defined. Declare it or define it in an equation.`);
          }
          plotted.push(curve);
        }
        yExpressions(plotted.map(curve => curve.y).join(', '));
      }
    } catch (error) { throw new PlotSourceError(describe(document, part.line, (error as Error).message), next); }
  }
  if (firstPlot && !selected) throw new PlotSourceError(describe(firstPlot.document, firstPlot.line, 'Set the traversal axis with set_time_axis parameter, for example set_time_axis x.'), next);
  const realImposedAxis = next.solver.complex && next.sweep.mode === 'constrained';
  next.axes = { x: selected?.parameter ?? '', y: plotted.map(curve => curve.y).join(', '),
    ...(plotted.length && (realImposedAxis || plotted.some(curve => curve.x !== undefined)) ? { curves: plotted.map(curve => ({ x: curve.x ?? (realImposedAxis ? `real(${selected!.parameter})` : selected!.parameter), y: curve.y })) } : {}),
    ...(transitions.length ? { transitions } : {}),
  };
  try { evaluateTransitionLines(next); }
  catch (error) {
    const location = transitionLocations[error instanceof TransitionExpressionError ? error.index : 0];
    throw new PlotSourceError(location ? describe(location.document, location.line, (error as Error).message) : (error as Error).message, next);
  }
  return next;
}

interface Token { start: number; end: number }
function tokens(source: string): Token[] {
  const result: Token[] = []; let start = -1, depth = 0, comment = false;
  const finish = (end: number) => { if (start >= 0) result.push({ start, end }); start = -1; };
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '\n') comment = false;
    if (comment) continue;
    if (char === '#') { if (!depth) finish(index); comment = true; continue; }
    if (!depth && (/\s/.test(char) || char === ',')) { finish(index); continue; }
    if (start < 0) start = index;
    if (char === '(') depth++;
    if (char === ')') depth--;
  }
  finish(source.length); return result;
}
const keys = ['value', 'step', 'min', 'max'] as const;

/** Reflect numeric controls in their existing declaration locations. Only fields that
 * changed externally are rewritten; untouched expressions/comments and invalid
 * drafts elsewhere remain byte-for-byte intact. */
export function syncDocumentVariables(config: Configuration, previous?: Configuration): void {
  if (!config.documents) return;
  const byName = new Map(config.variables.map(variable => [variable.name, variable]));
  const represented = new Set<string>();
  for (const document of config.documents) {
    let parts: Statement[];
    try { parts = statements(document.source); } catch { continue; }
    const edits: { start: number; end: number; text: string }[] = [];
    for (const part of parts) {
      if (part.kind !== 'unknown' && part.kind !== 'parameter') continue;
      let parsed: Variable;
      try { parsed = parseDeclarations(part.clean, part.kind).variables[0]; } catch { continue; }
      represented.add(parsed.name);
      const variable = byName.get(parsed.name);
      if (!variable || variable.kind !== part.kind) continue;
      const before = previous?.variables.find(candidate => candidate.name === variable.name);
      if (before && keys.every(key => before[key] === variable[key])) continue;
      const raw = document.source.slice(part.start, part.end), pieces = tokens(raw);
      if (pieces.length < 2) continue;
      if (raw.slice(pieces.at(-1)!.start, pieces.at(-1)!.end).trim() === 'sweep') pieces.pop();
      const values = [variable.value];
      if (part.kind === 'parameter') for (const value of [variable.step, variable.min, variable.max]) { if (value === undefined) break; values.push(value); }
      const oldOptions = pieces.slice(2);
      // A zero default can remain implicit unless other options require it.
      if (!oldOptions.length && values.length === 1 && values[0] === 0) values.length = 0;
      for (let index = 0; index < oldOptions.length; index++) {
        const token = oldOptions[index], key = keys[index];
        if (index >= values.length) edits.push({ start: part.start + token.start, end: part.start + token.end, text: '' });
        else if (parsed[key] !== values[index]) edits.push({ start: part.start + token.start, end: part.start + token.end, text: String(values[index]) });
      }
      let insertion = '';
      if (values.length > oldOptions.length) insertion += ' ' + values.slice(oldOptions.length).join(' ');
      if (insertion) {
        const at = oldOptions.at(-1)?.end ?? pieces[1].end;
        edits.push({ start: part.start + at, end: part.start + at, text: insertion });
      }
    }
    for (const edit of edits.sort((left, right) => right.start - left.start || right.end - left.end)) document.source = document.source.slice(0, edit.start) + edit.text + document.source.slice(edit.end);
  }
  // Device defaults are generated from the library. Editing one in the input
  // tray creates a source override so the value survives recompilation/saving.
  for (const variable of config.variables) {
    if (!variable.name.includes('.') || variable.kind === 'derived' || represented.has(variable.name)) continue;
    const before = previous?.variables.find(candidate => candidate.name === variable.name);
    if (!before || keys.every(key => before[key] === variable[key])) continue;
    const instance = variable.name.split('.')[0];
    const document = config.documents.find(document => new RegExp(`\\belement\\s+[A-Za-z_][A-Za-z_0-9]*\\s+${instance}\\b`).test(document.source.replace(/#[^\r\n]*/g, ''))) ?? config.documents[0];
    const declaration = formatDeclarations({ ...config, variables: [variable] }, variable.kind);
    document.source += `${document.source.endsWith('\n') ? '' : '\n'}${declaration}\n`;
  }
}
