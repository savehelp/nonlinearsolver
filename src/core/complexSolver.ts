import { compileComplex, evaluateComplexNode } from './complexExpression';
import { asComplex, complexMultiply, realCoordinate } from './complex';
import { affineExpression } from './affine';
import { lines, residual, type ExpressionNode } from './expression';
import { equationAssignment, equationProgram } from './equations';
import { plotCurves } from './axes';
import { usedVariables } from './variables';
import { inferVariables } from './inference';
import { applyValidityBounds } from './constraints';
import type { System } from './solver';
import type { Complex, ComplexScope, Configuration, Scope, Variable } from './types';

type ComplexExpression = ReturnType<typeof compileComplex>;
interface Definition { name: string; source: string; expression: ComplexExpression }
interface Component extends Variable { logical: string; part: 're' | 'im' | 'real'; scale?: number }
interface ComplexEvaluation { values: Scope; residuals: number[]; complexValues: Record<string, Complex> }
const reserved = new Set(['pi', 'e', 'true', 'false']);
const implicit = new Set(['i', 'j']);
const fullResidual = (source: string): ComplexExpression => {
  // Keep equality parsing and validation shared with the real evaluator.
  residual(source);
  const match = /(?<![<>=!])=(?!=)/.exec(source);
  return compileComplex(match ? `(${source.slice(0, match.index)})-(${source.slice(match.index + 1)})` : source);
};

function integerLiteral(node: ExpressionNode | undefined): boolean {
  return !!node && (node.type === 'number' ? Number.isInteger(node.value)
    : node.type === 'unary' && ['+', '-'].includes(node.op) && node.arg.type === 'number' && Number.isInteger(node.arg.value));
}

function continuousExpression(node: ExpressionNode): boolean {
  if (node.type === 'number' || node.type === 'variable') return true;
  if (node.type === 'unary') return node.op !== '!' && continuousExpression(node.arg);
  if (node.type === 'binary') return !['<', '<=', '>', '>=', '==', '!=', '&&', '||'].includes(node.op)
    && (!['^', '**'].includes(node.op) || integerLiteral(node.right))
    && continuousExpression(node.left) && continuousExpression(node.right);
  if (['if', 'floor', 'ceil', 'sign', 'arg', 'phase', 'sqrt', 'log', 'ln', 'log10', 'asin', 'acos', 'atan'].includes(node.name)) return false;
  return (node.name !== 'pow' || integerLiteral(node.args[1])) && node.args.every(continuousExpression);
}

/** Only omit an imaginary equation when its syntax proves it is real-valued. */
function provenReal(node: ExpressionNode | undefined, realNames: Set<string>): boolean {
  if (!node) return false;
  if (node.type === 'number') return true;
  if (node.type === 'variable') return realNames.has(node.name) || reserved.has(node.name);
  if (node.type === 'unary') return node.op === '!' || provenReal(node.arg, realNames);
  if (node.type === 'binary') {
    if (['<', '<=', '>', '>=', '==', '!=', '&&', '||'].includes(node.op)) return true;
    if (node.op === '^' || node.op === '**') return provenReal(node.left, realNames) && integerLiteral(node.right);
    return provenReal(node.left, realNames) && provenReal(node.right, realNames);
  }
  if (['real', 're', 'imag', 'im', 'abs', 'mag', 'arg', 'phase', 'min', 'max', 'floor', 'ceil', 'sign', 'atan2'].includes(node.name)) return true;
  if (node.name === 'if') return provenReal(node.args[1], realNames) && provenReal(node.args[2], realNames);
  if (node.name === 'pow') return provenReal(node.args[0], realNames) && integerLiteral(node.args[1]);
  if (node.name === 'complex') return provenReal(node.args[0], realNames) && node.args[1]?.type === 'number' && node.args[1].value === 0;
  return ['exp', 'sin', 'cos', 'tan', 'sinh', 'cosh', 'tanh', 'atan', 'conj'].includes(node.name) && node.args.every(arg => provenReal(arg, realNames));
}

function orderedDefinitions(pending: Definition[], available: Set<string>): Definition[] | null {
  const ordered: Definition[] = [];
  while (pending.length) {
    const ready = pending.filter(definition => definition.expression.variables.every(name => available.has(name)));
    if (!ready.length) return null;
    for (const definition of ready) { ordered.push(definition); available.add(definition.name); }
    pending = pending.filter(definition => !ready.includes(definition));
  }
  return ordered;
}

/** Scaled dense solve for the real block system of an affine complex model. */
function solveLinear(matrix: number[][], rhs: number[]): number[] | null {
  const count = rhs.length;
  const rows = matrix.map((row, index) => {
    const scale = Math.max(...row.map(Math.abs));
    return scale ? [...row.map(value => value / scale), rhs[index] / scale] : [];
  });
  if (rows.some(row => !row.length || row.some(value => !Number.isFinite(value)))) return null;
  for (let column = 0; column < count; column++) {
    let pivot = column;
    for (let row = column + 1; row < count; row++) if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    if (Math.abs(rows[pivot][column]) <= 1e-12) return null;
    [rows[pivot], rows[column]] = [rows[column], rows[pivot]];
    for (let row = column + 1; row < count; row++) {
      const factor = rows[row][column] / rows[column][column];
      rows[row][column] = 0;
      for (let entry = column + 1; entry <= count; entry++) rows[row][entry] -= factor * rows[column][entry];
    }
  }
  const solution = Array<number>(count).fill(0);
  for (let row = count - 1; row >= 0; row--) {
    let value = rows[row][count];
    for (let column = row + 1; column < count; column++) value -= rows[row][column] * solution[column];
    solution[row] = value / rows[row][row];
  }
  return solution.every(Number.isFinite) ? solution : null;
}

/** Compile complex equations to real components; Newton itself stays real. */
export function prepareComplex(config: Configuration, parameter?: number): System {
  if (!config.axes.x.trim() || !config.axes.y.trim()) throw new Error('Add set_time_axis parameter and plot unknown commands.');
  const program = equationProgram(config.equations), used = usedVariables(config);
  const definitions = inferVariables(config, program).map(variable => ({ ...variable }));
  const variables = definitions.filter(variable => used.has(variable.name));
  const names = new Set<string>();
  for (const variable of variables) {
    if (!/^[A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)?$/.test(variable.name) || reserved.has(variable.name)) throw new Error(`Invalid or reserved variable name “${variable.name}”.`);
    if (names.has(variable.name)) throw new Error(`Variable “${variable.name}” is defined twice.`);
    names.add(variable.name);
    if (!Number.isFinite(variable.value) || (variable.min !== undefined && !Number.isFinite(variable.min)) || (variable.max !== undefined && !Number.isFinite(variable.max))) throw new Error(`Values and bounds for ${variable.name} must be finite real numbers.`);
    if (variable.min !== undefined && variable.max !== undefined && variable.min >= variable.max) throw new Error(`${variable.name}: minimum must be less than maximum.`);
    if (variable.kind === 'unknown' && (variable.min !== undefined || variable.max !== undefined)) throw new Error(`Complex unknown “${variable.name}” cannot have an ordered interval. Use conditions on real(${variable.name}), imag(${variable.name}), or abs(${variable.name}).`);
  }
  const logicalUnknowns = variables.filter(variable => variable.kind === 'unknown');
  if (!logicalUnknowns.length && !variables.some(variable => variable.kind === 'derived')) throw new Error('Define an unknown or an assignment in Equations.');
  const constrained = config.sweep.mode === 'constrained';
  const imposed = constrained ? logicalUnknowns.find(variable => variable.name === config.sweep.parameter) : undefined;
  const released = constrained ? variables.find(variable => variable.name === config.sweep.release && variable.kind === 'parameter') : undefined;
  if (constrained && (!imposed || !released)) throw new Error('A constrained sweep imposes the real part of an unknown and releases one real parameter.');
  if (!constrained && !variables.some(variable => variable.name === config.sweep.parameter && variable.kind === 'parameter')) throw new Error('Select a real sweep parameter by adding sweep after its value, step, minimum and maximum.');
  const imposedValue = parameter ?? imposed?.value ?? 0;
  const fixed: Scope = Object.create(null);
  for (const variable of variables) if (variable.kind === 'parameter' && variable !== released) fixed[variable.name] = variable.name === config.sweep.parameter && parameter !== undefined ? parameter : variable.value;
  const expressions = program.equations.map(fullResidual);
  const derived: Definition[] = variables.filter(variable => variable.kind === 'derived').map(variable => ({ name: variable.name, source: variable.expression ?? '', expression: compileComplex(variable.expression ?? '') }));
  const conditions = [...program.conditions, ...lines(config.constraints)].map(compileComplex);
  for (const expression of [...expressions, ...derived.map(definition => definition.expression), ...conditions,
    compileComplex(config.axes.x), ...plotCurves(config.axes).flatMap(curve => [compileComplex(curve.x), compileComplex(curve.y)])]) {
    for (const name of expression.variables) if (!names.has(name) && !implicit.has(name)) throw new Error(`“${name}” is not defined. Add it under Unknowns or Parameters.`);
  }
  const fullComponents: Component[] = logicalUnknowns.flatMap(variable => {
    // Both components describe the same quantity even though the imaginary
    // starting guess is zero. Share its characteristic scale for derivatives,
    // root matching, and multistart discovery.
    const scale = variable.value === 0 ? 1 : Math.max(Math.abs(variable.value), 1e-6);
    return [
      ...(variable === imposed ? [] : [{ name: `real(${variable.name})`, kind: 'unknown' as const, value: variable.value, scale, logical: variable.name, part: 're' as const }]),
      { name: `imag(${variable.name})`, kind: 'unknown' as const, value: 0, scale, logical: variable.name, part: 'im' as const },
    ];
  });
  if (released) fullComponents.push({ ...released, kind: 'unknown', logical: released.name, part: 'real' });
  const realNames = new Set(variables.filter(variable => variable.kind === 'parameter').map(variable => variable.name));
  const complexRows = expressions.map(expression => !provenReal(expression.node, realNames));
  const scalarRows = complexRows.reduce((count, complex) => count + (complex ? 2 : 1), 0);
  if (scalarRows !== fullComponents.length) throw new Error(`${scalarRows < fullComponents.length ? 'Underdetermined' : 'Overdetermined'} complex system: ${scalarRows} real equations for ${fullComponents.length} real degrees of freedom. Unknowns: ${[...logicalUnknowns.map(variable => variable.name), ...(released ? [released.name] : [])].join(', ')}. Declare intended fixed inputs with parameter name value, or add/remove equations. Each complex unknown has real and imaginary components; use one complex equality or two real projection equalities.`);
  applyValidityBounds(fullComponents, [...program.conditions, ...lines(config.constraints)].join('\n'), fixed);
  const availableFixed = new Set(Object.keys(fixed));
  for (const name of implicit) if (!names.has(name)) availableFixed.add(name);
  const assignments = program.equations.map(equationAssignment);
  const counts = new Map<string, number>();
  for (const assignment of assignments) if (assignment) counts.set(assignment.name, (counts.get(assignment.name) ?? 0) + 1);
  const candidates: Definition[] = assignments.flatMap(assignment => assignment && counts.get(assignment.name) === 1 && logicalUnknowns.some(variable => variable.name === assignment.name && variable !== imposed)
    ? [{ ...assignment, expression: compileComplex(assignment.source) }] : []);
  const dependencies = new Map([...candidates, ...derived].map(definition => [definition.name, definition]));
  const visited = new Set<string>(), stack: string[] = [], cyclic = new Set<string>();
  const visit = (name: string) => {
    const cycle = stack.indexOf(name);
    if (cycle >= 0) { stack.slice(cycle).forEach(member => cyclic.add(member)); return; }
    if (visited.has(name)) return;
    visited.add(name); stack.push(name);
    for (const dependency of dependencies.get(name)!.expression.variables) if (dependencies.has(dependency)) visit(dependency);
    stack.pop();
  };
  for (const name of dependencies.keys()) visit(name);
  const removed = candidates.filter(definition => !cyclic.has(definition.name));
  const removedNames = new Set(removed.map(definition => definition.name));
  const numericalNames = logicalUnknowns.filter(variable => !removedNames.has(variable.name)).map(variable => variable.name);
  if (released) numericalNames.push(released.name);
  const reconstruction = orderedDefinitions([...removed, ...derived], new Set([...availableFixed, ...numericalNames]));
  if (!reconstruction) throw new Error('Derived expressions contain a circular dependency.');
  const completeAssignments = !constrained && removedNames.size === logicalUnknowns.length;
  const derivedOnly = orderedDefinitions(derived, new Set([...availableFixed, ...logicalUnknowns.map(variable => variable.name), ...(released ? [released.name] : [])]));
  if (!derivedOnly) throw new Error('Derived expressions contain a circular dependency.');
  const reducedIndices = program.equations.flatMap((_, index) => assignments[index] && removedNames.has(assignments[index]!.name) ? [] : [index]);
  const reducedComponents = fullComponents.filter(component => !removedNames.has(component.logical));
  const logicalValues = [...logicalUnknowns, ...variables.filter(variable => variable.kind === 'derived')];

  const scopeAt = (x: number[], components: Component[], reconstructionOrder: Definition[]): ComplexScope => {
    const scope: ComplexScope = Object.assign(Object.create(null), fixed);
    if (imposed) scope[imposed.name] = { re: imposedValue, im: 0 };
    components.forEach((component, index) => {
      if (component.part === 'real') scope[component.logical] = x[index];
      else {
        const value = asComplex(scope[component.logical] ?? 0);
        scope[component.logical] = { ...value, [component.part]: x[index] };
      }
    });
    for (const definition of reconstructionOrder) scope[definition.name] = definition.expression.evaluate(scope);
    return scope;
  };
  const pack = (scope: ComplexScope, indices: number[]): ComplexEvaluation => {
    const values: Scope = Object.assign(Object.create(null), fixed), complexValues: Record<string, Complex> = Object.create(null);
    if (released) {
      const value = asComplex(scope[released.name]);
      if (value.im !== 0) throw new Error(`Released parameter “${released.name}” must remain real.`);
      values[released.name] = value.re;
    }
    for (const variable of logicalValues) {
      const value = asComplex(scope[variable.name]);
      complexValues[variable.name] = value;
      values[`real(${variable.name})`] = value.re; values[`imag(${variable.name})`] = value.im;
      if (value.im === 0) values[variable.name] = value.re;
    }
    const residuals = indices.flatMap(index => { const value = asComplex(expressions[index].evaluate(scope)); return complexRows[index] ? [value.re, value.im] : [value.re]; });
    return { values, complexValues, residuals };
  };
  const allIndices = program.equations.map((_, index) => index);
  const evaluateFull = (x: number[]) => pack(scopeAt(x, fullComponents, derivedOnly), allIndices);
  const valid = (values: Scope): boolean => {
    const scope: ComplexScope = Object.assign(Object.create(null), fixed);
    if (released) scope[released.name] = values[released.name];
    for (const variable of logicalValues) scope[variable.name] = { re: values[`real(${variable.name})`], im: values[`imag(${variable.name})`] };
    return conditions.every(condition => Boolean(realCoordinate(condition.evaluate(scope), 'Validity condition')));
  };
  const labels = (indices: number[]) => indices.flatMap(index => complexRows[index] ? [`real(${program.equations[index]})`, `imag(${program.equations[index]})`] : [`real(${program.equations[index]})`]);
  if (completeAssignments) {
    const direct = () => {
      const scope: ComplexScope = Object.assign(Object.create(null), fixed);
      for (const definition of reconstruction) scope[definition.name] = definition.expression.evaluate(scope);
      return pack(scope, allIndices);
    };
    return { unknowns: fullComponents, allUnknowns: fullComponents, equations: labels(allIndices), evaluate: evaluateFull,
      direct, directContinuous: reconstruction.every(definition => continuousExpression(definition.expression.node)), valid, region: () => '' };
  }

  // Preserve the affine shortcut by solving its real block matrix directly.
  if (!derived.length) try {
    const unknownNames = [...logicalUnknowns.map(variable => variable.name), ...(released ? [released.name] : [])];
    const forms = program.equations.map(source => affineExpression(residual(source), unknownNames));
    if (forms.every(form => form && [...form.coefficients.values(), form.constant].every(expression => expression.variables.every(name => availableFixed.has(name))))) {
      const constants = forms.map(form => asComplex(evaluateComplexNode(form!.constant.node, fixed)));
      const coefficients = forms.map(form => new Map([...form!.coefficients].map(([name, expression]) => [name, asComplex(evaluateComplexNode(expression.node, fixed))])));
      const matrix = coefficients.flatMap((row, index) => {
        const entries = fullComponents.map(component => {
          const coefficient = row.get(component.logical) ?? { re: 0, im: 0 };
          return component.part === 'im' ? { re: -coefficient.im, im: coefficient.re } : coefficient;
        });
        return complexRows[index] ? [entries.map(value => value.re), entries.map(value => value.im)] : [entries.map(value => value.re)];
      });
      const rhs = constants.flatMap((constant, index) => {
        const imposedTerm = imposed ? asComplex(complexMultiply(coefficients[index].get(imposed.name) ?? 0, imposedValue)) : { re: 0, im: 0 };
        return complexRows[index] ? [-constant.re - imposedTerm.re, -constant.im - imposedTerm.im] : [-constant.re - imposedTerm.re];
      });
      const solution = solveLinear(matrix, rhs);
      if (solution && fullComponents.every((component, index) => solution[index] >= (component.min ?? -Infinity) && solution[index] <= (component.max ?? Infinity))) {
        const state = evaluateFull(solution);
        if (state.residuals.every((value, row) => Math.abs(value) <= config.solver.tolerance * Math.max(Number.MIN_VALUE, Math.abs(rhs[row]), ...matrix[row].map((coefficient, column) => Math.abs(coefficient * solution[column]))))) {
          return { unknowns: fullComponents, allUnknowns: fullComponents, equations: labels(allIndices), evaluate: evaluateFull,
            direct: () => state, directContinuous: expressions.every(expression => continuousExpression(expression.node)), valid, region: () => '' };
        }
      }
    }
  } catch { /* Unsupported or unsafe affine reduction retains the numerical path. */ }
  return { unknowns: reducedComponents, allUnknowns: fullComponents, equations: labels(reducedIndices),
    evaluate: x => pack(scopeAt(x, reducedComponents, reconstruction), reducedIndices), valid, region: () => '' };
}

