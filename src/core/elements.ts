import nmosLibrary from '../../elements/nmosfet.json';
import pmosLibrary from '../../elements/pmosfet.json';
import { compile, residual, type Expression, type ExpressionNode } from './expression';
import { equationAssignment, equationProgram } from './equations';
import { plotArguments } from './axes';
import type { Configuration, Variable } from './types';

export interface ElementParameter { value: number; step?: number; min?: number; max?: number }
export interface ElementDefinition {
  name: string;
  description?: string;
  mode?: 'real' | 'complex' | 'both';
  terminals: string[];
  /** Fallback equations for terminals absent from external math equations. */
  terminalDefaults?: Record<string, string>;
  /** Additional public names for declared terminals; targets are canonical names. */
  terminalAliases?: Record<string, string>;
  parameters: Record<string, ElementParameter>;
  unknowns?: Record<string, number>;
  equations: string[];
}
export interface ElementLibrary { format: 'nonlinear-elements'; version: 1; elements: ElementDefinition[] }
export interface ElementLibraryEntry {
  definition: ElementDefinition;
  origin: 'default' | 'replacement' | 'imported';
  defaultDefinition?: ElementDefinition;
}
export interface ElementDeclaration { type: string; name: string; location?: string }
export interface ElementUsage { source: string; kind: 'math' | 'display'; location?: string }

export const MAX_ELEMENT_TYPES = 64;
export const MAX_ELEMENT_INSTANCES = 64;
export const MAX_ELEMENT_LIBRARY_SIZE = 1_000_000;
const identifier = /^[A-Za-z_][A-Za-z_0-9]*$/;
const reserved = new Set(['pi', 'e', 'true', 'false', '__proto__', 'prototype', 'constructor', 'element', 'unknown', 'parameter', 'plot', 'set_time_axis', 'plot_x_transition', 'plot_y_transition', 'valid']);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const message = (error: unknown) => error instanceof Error ? error.message : 'Invalid element definition.';
const at = (location: string | undefined, text: string) => location ? `${location.replace(/[:\s]+$/u, '')}: ${text}` : text;

function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extra = Object.keys(value).find(key => !allowed.includes(key));
  if (extra) throw new Error(`${label}: unknown field “${extra}”.`);
}

function name(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length > 64 || !identifier.test(value) || reserved.has(value)) throw new Error(`${label} must be a non-reserved identifier of at most 64 characters.`);
}

function parameter(value: unknown, label: string): ElementParameter {
  if (!object(value)) throw new Error(`${label} needs a numeric value and optional step, min, and max.`);
  keys(value, ['value', 'step', 'min', 'max'], label);
  if (!finite(value.value)) throw new Error(`${label}.value must be finite.`);
  const next: ElementParameter = { value: value.value };
  for (const key of ['step', 'min', 'max'] as const) if (Object.hasOwn(value, key)) {
    if (!finite(value[key])) throw new Error(`${label}.${key} must be finite.`);
    next[key] = value[key];
  }
  if (next.step !== undefined && next.step <= 0) throw new Error(`${label}.step must be positive.`);
  if (next.min !== undefined && next.max !== undefined && next.min >= next.max) throw new Error(`${label}.min must be less than max.`);
  if ((next.min !== undefined && next.value < next.min) || (next.max !== undefined && next.value > next.max)) throw new Error(`${label}.value must be within its bounds.`);
  return next;
}

interface ModelStatement { equation?: string; condition?: string }
interface ModelInfo { definition: ElementDefinition; members: Set<string>; statements: ModelStatement[]; defaults: Map<string, Expression>; aliases: Map<string, string> }

function statement(source: string): ModelStatement {
  if (/^(?:element|unknown|parameter|plot(?:_[xy]_transition)?|set_time_axis)(?:\s|$)/.test(source.trim())) throw new Error('Element templates contain only equations and validity checks, not declarations or plot commands.');
  const program = equationProgram(source.endsWith(';') ? source : `${source};`);
  if (program.equations.length + program.conditions.length !== 1) throw new Error('Each equations entry must contain exactly one equation or validity check.');
  return program.equations.length ? { equation: program.equations[0] } : { condition: program.conditions[0] };
}

function visit(node: ExpressionNode, fn: (node: ExpressionNode) => void): void {
  fn(node);
  if (node.type === 'unary') visit(node.arg, fn);
  else if (node.type === 'binary') { visit(node.left, fn); visit(node.right, fn); }
  else if (node.type === 'call') node.args.forEach(arg => visit(arg, fn));
}

function modelInfo(definition: ElementDefinition): ModelInfo {
  const aliases = new Map(Object.entries(definition.terminalAliases ?? {}));
  const members = new Set([...definition.terminals, ...Object.keys(definition.parameters), ...Object.keys(definition.unknowns ?? {}), ...aliases.keys()]);
  const statements = definition.equations.map(statement);
  for (const entry of statements) {
    const assignment = entry.equation && equationAssignment(entry.equation);
    if (assignment) {
      name(assignment.name, `${definition.name} assignment target`);
      if (aliases.has(assignment.name)) throw new Error(`${definition.name}: terminal alias “${assignment.name}” cannot also be an assignment target.`);
      members.add(assignment.name);
    }
  }
  if (members.size > 100) throw new Error(`${definition.name}: use at most 100 members.`);
  const defaults = new Map(definition.terminals.flatMap(terminal => Object.hasOwn(definition.terminalDefaults ?? {}, terminal)
    ? [[terminal, compile(definition.terminalDefaults![terminal])] as const] : []));
  const validate = (expression: Expression) => {
    for (const variable of expression.variables) {
      if (!members.has(variable) && !((definition.mode ?? 'both') !== 'real' && (variable === 'i' || variable === 'j'))) {
        throw new Error(`${definition.name}: “${variable}” is not a declared local member or an assignment target.`);
      }
    }
    visit(expression.node, node => {
      if (node.type === 'number' && !Number.isFinite(node.value)) throw new Error(`${definition.name}: numeric literals must be finite.`);
    });
  };
  for (const entry of statements) validate(entry.equation ? residual(entry.equation) : compile(entry.condition!));
  for (const expression of defaults.values()) validate(expression);
  // Defaults are definitions, so reject circular aliases, including an alias
  // that returns through a computed assignment. Ordinary simultaneous model
  // equations may still contain cycles unrelated to a terminal default.
  const dependencies = new Map<string, Set<string>>();
  const depend = (target: string, variables: string[]) => {
    const entries = dependencies.get(target) ?? new Set<string>();
    variables.forEach(variable => entries.add(variable)); dependencies.set(target, entries);
  };
  for (const entry of statements) {
    const assignment = entry.equation && equationAssignment(entry.equation);
    if (assignment) depend(assignment.name, compile(assignment.source).variables);
  }
  for (const [alias, terminal] of aliases) depend(alias, [terminal]);
  for (const [terminal, expression] of defaults) depend(terminal, expression.variables);
  for (const [terminal, expression] of defaults) {
    const visited = new Set<string>();
    const circular = (variable: string): boolean => {
      if (variable === terminal) return true;
      if (visited.has(variable) || Object.hasOwn(definition.parameters, variable)) return false;
      visited.add(variable);
      return [...dependencies.get(variable) ?? []].some(circular);
    };
    if (expression.variables.some(circular)) throw new Error(`${definition.name}.terminalDefaults.${terminal}: circular terminal default.`);
  }
  return { definition, members, statements, defaults, aliases };
}

function definition(value: unknown): ElementDefinition {
  if (!object(value)) throw new Error('Each element definition must be an object.');
  keys(value, ['name', 'description', 'mode', 'terminals', 'terminalDefaults', 'terminalAliases', 'parameters', 'unknowns', 'equations'], 'Element definition');
  name(value.name, 'Element type name');
  const label = value.name;
  if (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 2000)) throw new Error(`${label}.description must be text of at most 2,000 characters.`);
  if (value.mode !== undefined && !['real', 'complex', 'both'].includes(value.mode as string)) throw new Error(`${label}.mode must be real, complex, or both.`);
  if (!Array.isArray(value.terminals) || value.terminals.length > 100) throw new Error(`${label}.terminals must be an array of at most 100 names.`);
  const occupied = new Set<string>(), terminals: string[] = [];
  const member = (entry: unknown) => {
    name(entry, `${label} member`);
    if (occupied.has(entry)) throw new Error(`${label}: member “${entry}” is defined more than once.`);
    occupied.add(entry); return entry;
  };
  for (const terminal of value.terminals) terminals.push(member(terminal));
  if (value.terminalDefaults !== undefined && !object(value.terminalDefaults)) throw new Error(`${label}.terminalDefaults must be an object of local expressions.`);
  const terminalDefaults: Record<string, string> = Object.create(null);
  for (const [terminal, source] of Object.entries(value.terminalDefaults ?? {})) {
    if (!terminals.includes(terminal)) throw new Error(`${label}.terminalDefaults: “${terminal}” must be a declared terminal.`);
    if (typeof source !== 'string' || !source.trim() || source.length > 10_000) throw new Error(`${label}.terminalDefaults.${terminal} must be a nonempty expression of at most 10,000 characters.`);
    terminalDefaults[terminal] = source.trim();
  }
  if (value.parameters !== undefined && !object(value.parameters)) throw new Error(`${label}.parameters must be an object.`);
  const parameters: Record<string, ElementParameter> = Object.create(null);
  for (const [key, entry] of Object.entries(value.parameters ?? {})) parameters[member(key)] = parameter(entry, `${label}.${key}`);
  if (value.unknowns !== undefined && !object(value.unknowns)) throw new Error(`${label}.unknowns must be an object of initial guesses.`);
  const unknowns: Record<string, number> = Object.create(null);
  for (const [key, entry] of Object.entries(value.unknowns ?? {})) {
    member(key);
    if (!finite(entry)) throw new Error(`${label}.${key} initial guess must be finite.`);
    unknowns[key] = entry;
  }
  if (value.terminalAliases !== undefined && !object(value.terminalAliases)) throw new Error(`${label}.terminalAliases must be an object of alias names and declared terminal names.`);
  const terminalAliases: Record<string, string> = Object.create(null);
  for (const [alias, terminal] of Object.entries(value.terminalAliases ?? {})) {
    member(alias);
    if (typeof terminal !== 'string' || !terminals.includes(terminal)) throw new Error(`${label}.terminalAliases.${alias} must name a declared terminal, not another alias.`);
    terminalAliases[alias] = terminal;
  }
  if (!Array.isArray(value.equations) || !value.equations.length || value.equations.length > 100
    || value.equations.some(source => typeof source !== 'string' || !source.trim() || source.length > 10_000)
    || [...value.equations, ...Object.values(terminalDefaults)].join('\n').length > 50_000) throw new Error(`${label}.equations needs 1–100 mathematical statements; equations and terminal defaults use at most 50,000 characters in total.`);
  const next: ElementDefinition = {
    name: label, terminals, parameters, equations: value.equations.map(source => (source as string).trim()),
    ...(value.description !== undefined ? { description: value.description as string } : {}),
    ...(value.mode !== undefined ? { mode: value.mode as ElementDefinition['mode'] } : {}),
    ...(value.terminalDefaults !== undefined ? { terminalDefaults } : {}),
    ...(value.terminalAliases !== undefined ? { terminalAliases } : {}),
    ...(value.unknowns !== undefined ? { unknowns } : {}),
  };
  modelInfo(next);
  return next;
}

/** Validate and copy a declarative library; equations use the normal safe parser. */
export function parseElementLibrary(data: unknown): ElementDefinition[] {
  if (!object(data)) throw new Error('Expected an element-library JSON object.');
  keys(data, ['format', 'version', 'elements'], 'Element library');
  if (data.format !== 'nonlinear-elements') throw new Error('This is not a nonlinear-elements library.');
  if (data.version !== 1) throw new Error(`Unsupported element-library version: ${String(data.version)}.`);
  if (!Array.isArray(data.elements) || data.elements.length > MAX_ELEMENT_TYPES) throw new Error(`Use at most ${MAX_ELEMENT_TYPES} element types in a library.`);
  let size: number;
  try { size = JSON.stringify(data).length; } catch { throw new Error('Element libraries must contain JSON data.'); }
  if (size > MAX_ELEMENT_LIBRARY_SIZE) throw new Error('Element libraries must be smaller than 1 MB.');
  const names = new Set<string>();
  const definitions = data.elements.map(entry => {
    const next = definition(entry);
    if (names.has(next.name)) throw new Error(`Element type “${next.name}” is defined more than once.`);
    names.add(next.name); return next;
  });
  // Normalization can add omitted fields such as an empty parameters object.
  // The normalized library must satisfy the same limit as its exported form.
  if (JSON.stringify({ format: 'nonlinear-elements', version: 1, elements: definitions }).length > MAX_ELEMENT_LIBRARY_SIZE) throw new Error('Element libraries must be smaller than 1 MB.');
  return definitions;
}

export function createElementLibrary(definitions: readonly ElementDefinition[]): ElementLibrary {
  return { format: 'nonlinear-elements', version: 1, elements: parseElementLibrary({ format: 'nonlinear-elements', version: 1, elements: definitions }) };
}

export const BUILTIN_ELEMENTS = [...parseElementLibrary(nmosLibrary), ...parseElementLibrary(pmosLibrary)];

function effectiveDefinitions(loaded: ElementDefinition[]): ElementDefinition[] {
  const merged = new Map(BUILTIN_ELEMENTS.map(entry => [entry.name, entry]));
  for (const entry of loaded) merged.set(entry.name, entry);
  if (merged.size > MAX_ELEMENT_TYPES) throw new Error(`Use at most ${MAX_ELEMENT_TYPES} loaded and bundled element types.`);
  // This is also the collection embedded in workspace snapshots. Validate it
  // before accepting a load, so every accepted collection can be reimported.
  return createElementLibrary([...merged.values()]).elements;
}

/** A loaded type of the same name deliberately replaces the bundled default. */
export function mergeElementDefinitions(current: ElementDefinition[] | undefined, incoming: ElementDefinition[]): ElementDefinition[] {
  const merged = new Map(createElementLibrary(current ?? []).elements.map(entry => [entry.name, entry]));
  for (const entry of createElementLibrary(incoming).elements) merged.set(entry.name, entry);
  const loaded = createElementLibrary([...merged.values()]).elements;
  effectiveDefinitions(loaded);
  return loaded;
}

export function elementDefinitions(config: Configuration): ElementDefinition[] {
  return effectiveDefinitions(createElementLibrary(config.elementDefinitions ?? []).elements);
}

function canonicalDefinition(entry: ElementDefinition): string {
  const numeric = (value: number | undefined): number | string | null => value === undefined ? null : Object.is(value, -0) ? '-0' : value;
  return JSON.stringify({
    name: entry.name,
    description: entry.description ?? '',
    mode: entry.mode ?? 'both',
    terminals: entry.terminals,
    terminalDefaults: Object.entries(entry.terminalDefaults ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    terminalAliases: Object.entries(entry.terminalAliases ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    parameters: Object.entries(entry.parameters).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) =>
      [key, numeric(value.value), numeric(value.step), numeric(value.min), numeric(value.max)]),
    unknowns: Object.entries(entry.unknowns ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => [key, numeric(value)]),
    equations: entry.equations,
  });
}

/** Workspace snapshots also contain bundled definitions. Classify their actual
 * content rather than treating every saved definition as a custom replacement. */
export function elementLibraryEntries(config: Configuration): ElementLibraryEntry[] {
  const defaults = new Map(createElementLibrary(BUILTIN_ELEMENTS).elements.map(entry => [entry.name, entry]));
  return elementDefinitions(config).map(entry => {
    const bundled = defaults.get(entry.name);
    return {
      definition: entry,
      origin: bundled ? canonicalDefinition(entry) === canonicalDefinition(bundled) ? 'default' : 'replacement' : 'imported',
      ...(bundled ? { defaultDefinition: bundled } : {}),
    };
  });
}

/** Replace the selected type without changing any existing instance type names.
 * Validation and aggregate limits finish before the caller updates its config. */
export function replaceElementDefinition(current: ElementDefinition[] | undefined, targetName: string, replacement: ElementDefinition): ElementDefinition[] {
  name(targetName, 'Element type name');
  const loaded = createElementLibrary(current ?? []).elements;
  if (!effectiveDefinitions(loaded).some(entry => entry.name === targetName)) throw new Error(`Element type “${targetName}” is not available to replace.`);
  const incoming = definition(replacement);
  return mergeElementDefinitions(loaded, [{ ...incoming, name: targetName }]);
}

/** Removing a bundled replacement reveals its original definition. Imported
 * types disappear; the resulting snapshot must still fit the library limits. */
export function removeElementDefinition(current: ElementDefinition[] | undefined, typeName: string): ElementDefinition[] {
  name(typeName, 'Element type name');
  const loaded = createElementLibrary(current ?? []).elements.filter(entry => entry.name !== typeName);
  effectiveDefinitions(loaded);
  return loaded;
}

function displayVariables(source: string): string[] {
  const plot = /^plot\s+([\s\S]+)$/.exec(source.trim());
  if (plot) return plotArguments(plot[1]).flatMap(curve => [curve.y, ...(curve.x === undefined ? [] : [curve.x])].flatMap(expression => compile(expression).variables));
  const command = /^(?:set_time_axis|plot_[xy]_transition)\s+([\s\S]+)$/.exec(source.trim());
  return compile(command?.[1] ?? source).variables;
}

/** Serialize parser nodes with qualified scalar names, preserving functions and
 * built-in constants without substring replacement or JavaScript property access. */
function qualified(node: ExpressionNode, instance: string, members: Set<string>): string {
  if (node.type === 'number') return Object.is(node.value, -0) ? '-0' : String(node.value);
  if (node.type === 'variable') return members.has(node.name) ? `${instance}.${node.name}` : node.name;
  if (node.type === 'call') return `${node.name}(${node.args.map(arg => qualified(arg, instance, members)).join(', ')})`;
  if (node.type === 'unary') return `(${node.op}${qualified(node.arg, instance, members)})`;
  return `(${qualified(node.left, instance, members)} ${node.op} ${qualified(node.right, instance, members)})`;
}

function expandStatement(entry: ModelStatement, instance: string, members: Set<string>): string {
  if (entry.condition) return `valid ${qualified(compile(entry.condition).node, instance, members)};`;
  const source = entry.equation!, equality = /(?<![<>=!])=(?!=)/g, matches = [...source.matchAll(equality)];
  if (!matches.length) return `${qualified(compile(source).node, instance, members)};`;
  const index = matches[0].index!;
  return `${qualified(compile(source.slice(0, index)).node, instance, members)} = ${qualified(compile(source.slice(index + 1)).node, instance, members)};`;
}

/** Expand referenced instances once. This is a fresh source projection on every
 * compilation, so deleting the last reference also removes generated equations. */
export function expandElements(config: Configuration, declarations: ElementDeclaration[], usages: ElementUsage[], variables: Variable[]): { equations: string[]; variables: Variable[] } {
  if (declarations.length > MAX_ELEMENT_INSTANCES) throw new Error(`Use at most ${MAX_ELEMENT_INSTANCES} element instances.`);
  const available = new Map(elementDefinitions(config).map(entry => [entry.name, entry]));
  const instances = new Map<string, { declaration: ElementDeclaration; model: ModelInfo; connected: Set<string> }>();
  for (const declaration of declarations) {
    try {
      name(declaration.name, 'Element instance name');
      if (instances.has(declaration.name)) throw new Error(`Element instance “${declaration.name}” is declared more than once.`);
      const model = available.get(declaration.type);
      if (!model) throw new Error(`Element type “${declaration.type}” is not loaded. Load its element JSON library in Elements settings.`);
      instances.set(declaration.name, { declaration, model: modelInfo(model), connected: new Set() });
    } catch (error) { throw new Error(at(declaration.location, message(error))); }
  }
  const member = (symbol: string, declarationLocation = true) => {
    const [instance, field, extra] = symbol.split('.');
    const entry = instances.get(instance);
    if (!entry) throw new Error(`Element instance “${instance}” is not declared. Use element Type ${instance}.`);
    if (!field || extra !== undefined || !entry.model.members.has(field)) throw new Error(at(declarationLocation ? entry.declaration.location : undefined, `“${symbol}” is not a member of ${entry.declaration.type}.`));
    return { entry, field, instance };
  };
  const overrides = new Map(variables.map(variable => [variable.name, variable]));
  for (const variable of variables) {
    if (instances.has(variable.name)) throw new Error(at(instances.get(variable.name)!.declaration.location, `“${variable.name}” is both an element instance and a variable.`));
    if (!variable.name.includes('.')) continue;
    const { entry, field } = member(variable.name);
    const isParameter = Object.hasOwn(entry.model.definition.parameters, field);
    if ((isParameter && variable.kind !== 'parameter') || (!isParameter && variable.kind !== 'unknown')) {
      throw new Error(at(entry.declaration.location, `“${variable.name}” is ${isParameter ? 'a fixed device parameter; use parameter' : 'a terminal or computed member; use unknown for an initial guess'}.`));
    }
  }
  const active = new Set<string>();
  for (const usage of usages) {
    try {
      let used: string[], connected: string[] = [];
      if (usage.kind === 'math') {
        const program = equationProgram(usage.source.endsWith(';') ? usage.source : `${usage.source};`);
        connected = program.equations.flatMap(source => residual(source).variables);
        used = [...connected, ...program.conditions.flatMap(source => compile(source).variables)];
      } else {
        // The document compiler owns display syntax and reports PlotSourceError
        // with the accepted mathematical model. An incomplete plot must not
        // become an equation-compilation error during activation analysis.
        try { used = displayVariables(usage.source); } catch { continue; }
      }
      for (const symbol of used) {
        if (instances.has(symbol)) throw new Error(`Use a member of “${symbol}”, such as ${symbol}.${instances.get(symbol)!.model.definition.terminals[0] ?? [...instances.get(symbol)!.model.members][0]}.`);
        if (!symbol.includes('.')) continue;
        const { entry, field, instance } = member(symbol, false);
        active.add(instance);
        if (connected.includes(symbol)) entry.connected.add(entry.model.aliases.get(field) ?? field);
      }
    } catch (error) { throw new Error(at(usage.location, message(error))); }
  }
  const equations: string[] = [], generated: Variable[] = [];
  for (const [instance, { declaration, model, connected }] of instances) {
    if (!active.has(instance)) continue;
    const mode = model.definition.mode ?? 'both';
    if ((mode === 'real' && config.solver.complex) || (mode === 'complex' && !config.solver.complex)) throw new Error(at(declaration.location, `Element “${instance}” (${declaration.type}) requires ${mode} mode. ${mode === 'real' ? 'Disable' : 'Enable'} Complex mode in Solver settings.`));
    const missing = model.definition.terminals.filter(terminal => !connected.has(terminal) && !model.defaults.has(terminal));
    if (missing.length) throw new Error(at(declaration.location, `Element “${instance}” has unconnected terminal${missing.length === 1 ? '' : 's'}: ${missing.map(terminal => `${instance}.${terminal}`).join(', ')}. Connect each terminal in an equation.`));
    for (const [field, value] of Object.entries(model.definition.parameters)) {
      const symbol = `${instance}.${field}`;
      if (!overrides.has(symbol)) generated.push({ name: symbol, kind: 'parameter', ...value });
    }
    for (const [field, value] of Object.entries(model.definition.unknowns ?? {})) {
      const symbol = `${instance}.${field}`;
      if (!overrides.has(symbol)) generated.push({ name: symbol, kind: 'unknown', value });
    }
    for (const [terminal, expression] of model.defaults) if (!connected.has(terminal)) {
      equations.push(`${instance}.${terminal} = ${qualified(expression.node, instance, model.members)};`);
    }
    for (const [alias, terminal] of model.aliases) equations.push(`${instance}.${alias} = ${instance}.${terminal};`);
    equations.push(...model.statements.map(entry => expandStatement(entry, instance, model.members)));
  }
  return { equations, variables: generated };
}
