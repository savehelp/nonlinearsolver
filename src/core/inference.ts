import { compile, lines, residual } from './expression';
import { equationAssignment, equationProgram, type EquationProgram } from './equations';
import type { Configuration, Variable } from './types';

const constants = new Set(['pi', 'e', 'true', 'false']);

/** Infer mathematical unknowns without rewriting declarations or source text.
 * Plotting and sweep settings cannot introduce additional unknowns. */
export function inferVariables(config: Configuration, program: EquationProgram = equationProgram(config.equations)): Variable[] {
  const declared = new Set(config.variables.map(variable => variable.name));
  const assigned = new Set<string>();
  for (const source of program.equations) {
    const assignment = equationAssignment(source);
    if (!assignment) continue;
    if (constants.has(assignment.name)) throw new Error(`Invalid or reserved variable name “${assignment.name}”.`);
    assigned.add(assignment.name);
  }
  const inferred: Variable[] = [], known = new Set(declared);
  const include = (name: string) => {
    if (known.has(name) || constants.has(name) || (config.solver.complex && (name === 'i' || name === 'j') && !assigned.has(name))) return;
    known.add(name); inferred.push({ name, kind: 'unknown', value: 0 });
  };
  // Keep assignment targets in their existing source order before adding other
  // symbols, preserving initial-vector order for previously supported models.
  assigned.forEach(include);
  for (const source of program.equations) residual(source).variables.forEach(include);
  for (const source of [...program.conditions, ...lines(config.constraints)]) compile(source).variables.forEach(include);
  for (const variable of config.variables) if (variable.kind === 'derived') compile(variable.expression ?? '').variables.forEach(include);
  return [...config.variables, ...inferred];
}
