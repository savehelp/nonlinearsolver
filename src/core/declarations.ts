import { numericExpression } from './numeric';
import { MAX_PARAMETER_SAMPLES, MAX_SECONDARY_SLICES } from './sweepLimits';
import type { Configuration, SecondarySweep, Variable } from './types';
import { parameterSweepRole, setSliceSweeps } from './variables';
import { parameterSampleCount, validateParameterSampleCount } from './sweepPlan';

export type DeclarationKind = 'unknown' | 'parameter';
export interface ParsedDeclarations { variables: Variable[]; swept: string[] }

const identifier = /^[A-Za-z_][A-Za-z_0-9]*$/;
const reserved = new Set(['pi', 'e', 'true', 'false']);

/** Whitespace and commas separate options outside parenthesized expressions. */
function options(source: string): string[] {
  const values: string[] = []; let current = '', depth = 0;
  for (const char of source) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (depth < 0) throw new Error('Unexpected closing parenthesis.');
    if ((/\s/.test(char) || char === ',') && depth === 0) {
      if (current) values.push(current);
      current = '';
    } else current += char;
  }
  if (depth) throw new Error('Close every parenthesized numeric option.');
  if (current) values.push(current);
  return values;
}

function statements(source: string): string[] {
  const clean = source.replace(/#[^\r\n]*/g, '');
  const result: string[] = []; let current = '', depth = 0;
  for (const char of clean) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if ((char === ';' || char === '\n' || char === '\r') && depth === 0) {
      if (current.trim()) result.push(current.trim());
      current = '';
    } else current += char;
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

export function parseDeclarations(source: string, kind: DeclarationKind): ParsedDeclarations {
  const variables: Variable[] = [], swept: string[] = [], names = new Set<string>();
  for (const [index, statement] of statements(source).entries()) {
    try {
      const tokens = options(statement);
      if (tokens.shift() !== kind) throw new Error(`Start this declaration with “${kind}”.`);
      const name = tokens.shift() ?? '';
      if (!identifier.test(name) || reserved.has(name)) throw new Error(`Use a valid, non-reserved name after “${kind}”.`);
      if (names.has(name)) throw new Error(`“${name}” is defined twice.`);
      names.add(name);
      const sweep = tokens.at(-1) === 'sweep';
      if (sweep) tokens.pop();
      if (kind === 'unknown' && sweep) throw new Error('Use sweep on a parameter declaration. Configure an imposed unknown in Sweep settings.');
      const maximum = kind === 'unknown' ? 1 : 4;
      if (tokens.length > maximum) throw new Error(kind === 'unknown'
        ? 'Use unknown name [initial guess].'
        : 'Use parameter name [value [step [minimum [maximum]]]] [sweep]. Wrap numeric expressions containing spaces in parentheses.');
      if (sweep && tokens.length !== 4) throw new Error('A swept parameter needs value, step, minimum and maximum before sweep.');
      const values = tokens.map(numericExpression);
      const variable: Variable = { name, kind, value: values[0] ?? 0 };
      if (kind === 'parameter') {
        if (values.length > 1) variable.step = values[1];
        if (values.length > 2) variable.min = values[2];
        if (values.length > 3) variable.max = values[3];
        if (variable.step !== undefined && variable.step <= 0) throw new Error(`${name}: step must be positive.`);
        if (variable.min !== undefined && variable.max !== undefined) {
          if (variable.min >= variable.max) throw new Error(`${name}: minimum must be less than maximum.`);
          if (variable.value < variable.min || variable.value > variable.max) throw new Error(`${name}: the value must be within the slider range.`);
        }
      }
      variables.push(variable);
      if (sweep) swept.push(name);
    } catch (error) {
      throw new Error(`Declaration ${index + 1}: ${error instanceof Error ? error.message : 'Invalid declaration.'}`);
    }
  }
  return { variables, swept };
}

export function formatDeclarations(config: Configuration, kind: DeclarationKind): string {
  return config.variables.filter(variable => variable.kind === kind).map(variable => {
    const values = [variable.value];
    if (kind === 'parameter') {
      // Options are positional: do not invent absent slider fields.
      for (const value of [variable.step, variable.min, variable.max]) {
        if (value === undefined) break;
        values.push(value);
      }
    }
    const suffix = kind === 'parameter' && parameterSweepRole(config, variable.name) ? ' sweep' : '';
    const numeric = values.length === 1 && values[0] === 0 && !suffix ? '' : ` ${values.join(' ')}`;
    return `${kind} ${variable.name}${numeric}${suffix}`;
  }).join('\n');
}

/** Count before creating any per-sample storage; parsing a long sweep stays cheap. */
function dimension(variable: Variable, limit: number): SecondarySweep {
  const { min, max, step, value: start, name } = variable;
  if (min === undefined || max === undefined || step === undefined || min >= max || step <= 0 || start < min || start > max) {
    throw new Error(`${name}: sweep needs a positive step and a starting value within an increasing range.`);
  }
  const points = parameterSampleCount(variable);
  validateParameterSampleCount(variable, points, limit);
  if ((start > min && start - step === start) || (start < max && start + step === start)) {
    throw new Error(`${name}: the step is too small to produce distinct samples.`);
  }
  return { parameter: name, min, max, step, startAt: start, points, logarithmic: false };
}

/** Apply only a successfully parsed editor; unrelated declarations stay intact. */
export function applyDeclarations(config: Configuration, kind: DeclarationKind, parsed: ParsedDeclarations): void {
  const retained = config.variables.filter(variable => variable.kind !== kind);
  const occupied = new Set(retained.map(variable => variable.name));
  for (const variable of parsed.variables) {
    if (variable.kind !== kind) throw new Error(`Expected ${kind} declarations.`);
    if (occupied.has(variable.name)) throw new Error(`“${variable.name}” is already defined in another declaration.`);
    occupied.add(variable.name);
  }
  if (retained.length + parsed.variables.length > 100) throw new Error('Use at most 100 unknowns and parameters.');
  const selected = new Set(parsed.swept);
  if (selected.size !== parsed.swept.length || parsed.swept.some(name => !parsed.variables.some(variable => variable.name === name))) {
    throw new Error('Every swept name must have exactly one parameter declaration.');
  }
  let main: string | undefined, dimensions: SecondarySweep[] | undefined, primary: SecondarySweep | undefined;
  if (kind === 'parameter') {
    if (config.sweep.mode === 'constrained') {
      if (selected.has(config.sweep.release)) throw new Error(`“${config.sweep.release}” is released by the constrained sweep and cannot also be swept.`);
      dimensions = parsed.swept.map(name => dimension(parsed.variables.find(variable => variable.name === name)!, MAX_SECONDARY_SLICES));
    } else {
      main = selected.has(config.sweep.parameter) ? config.sweep.parameter : parsed.swept[0] ?? '';
      if (main) primary = dimension(parsed.variables.find(variable => variable.name === main)!, MAX_PARAMETER_SAMPLES);
      dimensions = parsed.swept.filter(name => name !== main).map(name => dimension(parsed.variables.find(variable => variable.name === name)!, MAX_SECONDARY_SLICES));
    }
  }
  const insertion = config.variables.findIndex(variable => variable.kind === kind);
  const before = insertion < 0 ? retained.length : config.variables.slice(0, insertion).filter(variable => variable.kind !== kind).length;
  config.variables = [...retained.slice(0, before), ...parsed.variables.map(variable => ({ ...variable })), ...retained.slice(before)];
  if (kind === 'parameter') {
    if (main !== undefined) {
      config.sweep.parameter = main;
      delete config.sweep.step; delete config.sweep.startAt;
      if (primary) Object.assign(config.sweep, primary);
    }
    setSliceSweeps(config, dimensions!);
  }
}
