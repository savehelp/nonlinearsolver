import { applyDeclarations, formatDeclarations, parseDeclarations, type DeclarationKind } from './declarations';
import { compile, residual } from './expression';
import { equationProgram } from './equations';
import { parameterSweepRole } from './variables';
import { migrateEquationInputs } from './workspaceSyntax';
import type { Configuration, EditorDocument, Variable } from './types';

export const MAX_EDITOR_DOCUMENTS = 32;
export const MAX_DOCUMENT_SOURCE = 200_000;

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

/** One-time conversion; after this all tabs accept the same mixed syntax. */
export function ensureDocuments(config: Configuration): EditorDocument[] {
  if (config.documents !== undefined) { validateDocuments(config.documents); return config.documents; }
  migrateEquationInputs(config);
  config.documents = [
    { id: 'equations', title: 'Equations', source: config.equations },
    { id: 'definitions', title: 'Definitions', source: [formatDeclarations(config, 'unknown'), formatDeclarations(config, 'parameter')].filter(Boolean).join('\n\n') },
  ];
  return config.documents;
}

interface Statement { start: number; end: number; line: number; clean: string; kind?: DeclarationKind }
const declarationKind = (clean: string): DeclarationKind | undefined => /^(unknown|parameter)(?:\s|$)/.exec(clean)?.[1] as DeclarationKind | undefined;

/** Declarations end at top-level newlines or semicolons. Math uses the existing
 * semicolon convention, including multiline expressions; legacy newline-only
 * tabs still work. Comments and raw source positions remain in the document. */
function statements(source: string): Statement[] {
  const result: Statement[] = [], legacy = !source.replace(/#[^\r\n]*/g, '').includes(';');
  let start = 0, clean = '', depth = 0, comment = false, line = 1, firstLine = 1;
  const flush = (end: number, terminated: boolean) => {
    const text = clean.trim(), kind = declarationKind(text);
    if (text) {
      if (!kind && !legacy && !terminated) throw new Error(`Line ${firstLine}: end each equation or validity check with a semicolon (;).`);
      result.push({ start, end, line: firstLine, clean: text, kind });
    }
    start = end + (terminated ? 1 : 0); clean = ''; firstLine = line;
  };
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '\n') {
      if (depth === 0 && (declarationKind(clean.trim()) || legacy || !clean.trim())) flush(index, false);
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
    if (depth < 0) throw new Error(`Line ${line}: unexpected closing parenthesis.`);
    if (char === ';' && depth === 0) { flush(index, true); firstLine = line; }
    else clean += char;
  }
  if (depth) throw new Error(`Line ${firstLine}: close every parenthesized expression.`);
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
  for (const document of documents) {
    let parts: Statement[];
    try { parts = statements(document.source); }
    catch (error) { throw new Error(`“${document.title}”: ${(error as Error).message}`); }
    for (const part of parts) {
      try {
        if (part.kind) {
          const parsed = parseDeclarations(part.clean, part.kind), variable = parsed.variables[0];
          const previous = declarations.get(variable.name);
          if (previous) throw new Error(`“${variable.name}” is already declared in “${previous.document.title}”, line ${previous.line}.`);
          declarations.set(variable.name, { document, line: part.line });
          (part.kind === 'unknown' ? unknowns : parameters).push(variable); swept.push(...parsed.swept);
        } else {
          const program = equationProgram(part.clean + ';');
          program.equations.forEach(residual); program.conditions.forEach(compile);
          equations.push(part.clean + ';');
        }
      } catch (error) { throw new Error(describe(document, part.line, (error as Error).message)); }
    }
  }
  if (unknowns.length + parameters.length > 100) throw new Error('Use at most 100 unknowns and parameters across all tabs.');
  const math = equations.join('\n');
  if (math.length > 50_000) throw new Error('Equations across all tabs exceed 50,000 characters.');
  const next = structuredClone(config);
  next.variables = []; next.constraints = ''; next.equations = math;
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

/** Reflect controls in their existing declaration locations. Only fields that
 * changed externally are rewritten; untouched expressions/comments and invalid
 * drafts elsewhere remain byte-for-byte intact. */
export function syncDocumentVariables(config: Configuration, previous?: Configuration): void {
  if (!config.documents) return;
  const byName = new Map(config.variables.map(variable => [variable.name, variable]));
  for (const document of config.documents) {
    let parts: Statement[];
    try { parts = statements(document.source); } catch { continue; }
    const edits: { start: number; end: number; text: string }[] = [];
    for (const part of parts) {
      if (!part.kind) continue;
      let parsed: Variable;
      try { parsed = parseDeclarations(part.clean, part.kind).variables[0]; } catch { continue; }
      const variable = byName.get(parsed.name);
      if (!variable || variable.kind !== part.kind) continue;
      const before = previous?.variables.find(candidate => candidate.name === variable.name);
      const desiredSweep = part.kind === 'parameter' && !!parameterSweepRole(config, variable.name);
      const oldSweep = previous && part.kind === 'parameter' && !!parameterSweepRole(previous, variable.name);
      if (before && keys.every(key => before[key] === variable[key]) && desiredSweep === oldSweep) continue;
      const raw = document.source.slice(part.start, part.end), pieces = tokens(raw);
      if (pieces.length < 2) continue;
      const suffix = raw.slice(pieces.at(-1)!.start, pieces.at(-1)!.end).trim() === 'sweep' ? pieces.pop() : undefined;
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
      if (desiredSweep && !suffix) insertion += ' sweep';
      if (insertion) {
        const at = oldOptions.at(-1)?.end ?? pieces[1].end;
        edits.push({ start: part.start + at, end: part.start + at, text: insertion });
      }
      if (!desiredSweep && suffix) edits.push({ start: part.start + suffix.start, end: part.start + suffix.end, text: '' });
    }
    for (const edit of edits.sort((left, right) => right.start - left.start || right.end - left.end)) document.source = document.source.slice(0, edit.start) + edit.text + document.source.slice(edit.end);
  }
}
