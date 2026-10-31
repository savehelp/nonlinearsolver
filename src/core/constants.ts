import { compile, expressionFromNode, type ExpressionNode } from './expression';
import { evaluateComplexNode } from './complexExpression';
import { realCoordinate, type ComplexValue } from './complex';
import { equationAssignment, equationProgram } from './equations';
import { inferVariables } from './inference';
import { sliceSweeps } from './variables';
import type { ComplexScope, Configuration, Scope, Variable } from './types';

export interface ConstantEntry { name: string; expression?: string; value: ComplexValue }
export interface ConstantIssue { name: string; expression?: string; message: string }
export interface ConstantInspection {
  parameters: ConstantEntry[];
  assignments: ConstantEntry[];
  transitions: Array<{ axis: 'x' | 'y'; expression: string; value?: number; issue?: string }>;
  issues: ConstantIssue[];
}

/** An expression that needs a sampled root is ordinary model output, not a
 * failed constant. Keep this separate from fixed arithmetic/domain failures. */
class NonConstantExpressionError extends Error {}

interface ConstantResolver {
  parameters: Variable[];
  assignments: ReadonlyMap<string, string>;
  resolve(name: string): ComplexValue;
  evaluate(source: string): ComplexValue;
}

/** Shared constant evaluation for inspection and graph reference positions.
 * Unknown guesses and solved samples never enter this resolver's scope. */
export function createConstantResolver(config: Configuration): ConstantResolver {
  const program = equationProgram(config.equations), names = new Set(inferVariables(config, program).map(variable => variable.name));
  const varying = new Set([config.sweep.parameter, ...sliceSweeps(config).map(axis => axis.parameter)].filter(Boolean));
  if (config.sweep.mode === 'constrained') varying.add(config.sweep.release);
  const parameters = config.variables.filter(variable => variable.kind === 'parameter' && !varying.has(variable.name));
  const values: ComplexScope = Object.create(null);
  for (const variable of parameters) values[variable.name] = variable.value;
  const expressions = new Map<string, string>(), repeated = new Set<string>();
  const define = (name: string, source: string) => {
    if (expressions.has(name)) repeated.add(name);
    else expressions.set(name, source);
  };
  for (const variable of config.variables) if (variable.kind === 'derived') define(variable.name, variable.expression ?? '');
  for (const source of program.equations) {
    const assignment = equationAssignment(source);
    if (assignment) define(assignment.name, assignment.source);
  }
  const pending = new Set<string>();
  const literal = (value: ComplexValue): ExpressionNode => typeof value === 'number'
    ? { type: 'number', value }
    : { type: 'call', name: 'complex', args: [{ type: 'number', value: value.re }, { type: 'number', value: value.im }] };
  const constant = (node: ExpressionNode): ComplexValue => {
    let folded = node;
    if (node.type === 'variable') {
      if (!['pi', 'e', 'true', 'false'].includes(node.name)) resolve(node.name);
    } else if (node.type === 'unary') folded = { ...node, arg: literal(constant(node.arg)) };
    else if (node.type === 'call') {
      if (node.name === 'if') {
        const condition = realCoordinate(constant(node.args[0]), 'Condition');
        return constant(node.args[condition ? 1 : 2]);
      }
      folded = { ...node, args: node.args.map(arg => literal(constant(arg))) };
    } else if (node.type === 'binary') {
      const left = constant(node.left);
      // Resolve only the selected branch, as the expression evaluator does.
      if (node.op === '&&' && !realCoordinate(left, 'Logical operand')) return 0;
      if (node.op === '||' && realCoordinate(left, 'Logical operand')) return 1;
      folded = { ...node, left: literal(left), right: literal(constant(node.right)) };
    }
    // Validate every active operation before folding it, so simplification cannot
    // hide an invalid intermediate such as 0 * (1 / 0) or (1 / 0) > 0.
    return config.solver.complex
      ? evaluateComplexNode(folded, values)
      : expressionFromNode(folded).evaluate(values as Scope);
  };
  const resolve = (name: string): ComplexValue => {
    if (varying.has(name)) throw new NonConstantExpressionError(`Transition positions must be constant; “${name}” varies in the sweep.`);
    if (Object.hasOwn(values, name)) return values[name];
    if (config.solver.complex && (name === 'i' || name === 'j') && !names.has(name) && !expressions.has(name)) {
      return evaluateComplexNode({ type: 'variable', name }, values);
    }
    const source = expressions.get(name);
    if (source === undefined) {
      if (names.has(name)) throw new NonConstantExpressionError(`Transition positions must be constant; “${name}” is an unknown. Use a fixed parameter or a parameter-only assignment.`);
      throw new NonConstantExpressionError(`“${name}” is not defined. Use a constant, fixed parameter, or parameter-only assignment.`);
    }
    if (repeated.has(name)) throw new NonConstantExpressionError(`“${name}” has multiple defining equations and cannot set a constant transition.`);
    if (pending.has(name)) throw new NonConstantExpressionError(`“${name}” has a circular definition and cannot set a constant transition.`);
    pending.add(name);
    try {
      return values[name] = constant(compile(source).node);
    } finally {
      pending.delete(name);
    }
  };
  return { parameters, assignments: expressions, resolve, evaluate: source => constant(compile(source).node) };
}

/** Inspect fixed model inputs and folded definitions without running a solve. */
export function inspectConstants(config: Configuration): ConstantInspection {
  const resolver = createConstantResolver(config);
  const inspection: ConstantInspection = { parameters: [], assignments: [], transitions: [], issues: [] };
  for (const parameter of resolver.parameters) {
    try {
      inspection.parameters.push({ name: parameter.name, value: realCoordinate(resolver.resolve(parameter.name), 'Parameter value') });
    } catch (error) {
      inspection.issues.push({ name: parameter.name, message: (error as Error).message });
    }
  }
  const parameterNames = new Set(config.variables.filter(variable => variable.kind === 'parameter').map(variable => variable.name));
  for (const [name, expression] of resolver.assignments) {
    // An equation constraining a declared parameter is not a derived definition.
    if (parameterNames.has(name)) continue;
    try {
      inspection.assignments.push({ name, expression, value: resolver.resolve(name) });
    } catch (error) {
      if (!(error instanceof NonConstantExpressionError)) inspection.issues.push({ name, expression, message: (error as Error).message });
    }
  }
  inspection.transitions = (config.axes.transitions ?? []).map(transition => {
    try {
      if (transition.axis !== 'x' && transition.axis !== 'y') throw new Error('Choose an X or Y transition.');
      return { ...transition, value: realCoordinate(resolver.evaluate(transition.expression), 'Transition position') };
    } catch (error) {
      return { ...transition, issue: (error as Error).message };
    }
  });
  return inspection;
}
