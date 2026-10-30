import { affineExpression } from './affine';
import { expressionFromNode, type Expression } from './expression';
import type { Assignment, SubstitutionPlan } from './assignments';
import type { Scope } from './types';

/** Solve only a fully affine, full-rank system. Coefficients and constants must
 * depend exclusively on this point's fixed inputs. Row scaling and pivoting
 * guard poorly conditioned systems; unsupported/degenerate cases use Newton. */
export function affineRoot(expressions: Expression[], names: string[], fixed: Scope, tolerance: number): Scope | null {
  if (!names.length || expressions.length !== names.length) return null;
  try {
    const forms = expressions.map(expression => affineExpression(expression, names));
    if (forms.some(form => !form || [...form.coefficients.values(), form.constant].some(expression => expression.variables.some(name => !Object.hasOwn(fixed, name))))) return null;
    const coefficients = forms.map(form => names.map(name => form!.coefficients.get(name)?.evaluate(fixed) ?? 0));
    const constants = forms.map(form => form!.constant.evaluate(fixed));
    const matrix = coefficients.map((row, index) => {
      const scale = Math.max(...row.map(Math.abs));
      return scale ? [...row.map(value => value / scale), -constants[index] / scale] : [];
    });
    if (matrix.some(row => !row.length || row.some(value => !Number.isFinite(value)))) return null;
    const count = names.length;
    for (let column = 0; column < count; column++) {
      let pivot = column;
      for (let row = column + 1; row < count; row++) if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row;
      if (Math.abs(matrix[pivot][column]) <= 1e-12) return null;
      [matrix[pivot], matrix[column]] = [matrix[column], matrix[pivot]];
      for (let row = column + 1; row < count; row++) {
        const factor = matrix[row][column] / matrix[column][column];
        matrix[row][column] = 0;
        for (let entry = column + 1; entry <= count; entry++) matrix[row][entry] -= factor * matrix[column][entry];
      }
    }
    const solution = Array<number>(count).fill(0);
    for (let row = count - 1; row >= 0; row--) {
      let value = matrix[row][count];
      for (let column = row + 1; column < count; column++) value -= matrix[row][column] * solution[column];
      solution[row] = value / matrix[row][row];
    }
    if (!solution.every(Number.isFinite)) return null;
    const values: Scope = Object.assign(Object.create(null), fixed);
    names.forEach((name, index) => values[name] = solution[index]);
    // Check the user's original expressions, including domains that algebraic
    // reassociation must never erase. Reject an inaccurate reduction up front.
    if (!expressions.every((expression, row) => {
      const scale = Math.max(Number.MIN_VALUE, Math.abs(constants[row]), ...coefficients[row].map((coefficient, index) => Math.abs(coefficient * solution[index])));
      return Number.isFinite(scale) && Math.abs(expression.evaluate(values)) <= tolerance * scale;
    })) return null;
    return values;
  } catch { return null; }
}

export interface AffineSubstitutions extends SubstitutionPlan { validate: (values: Scope, tolerance: number) => boolean }

/** Greedy, bounded isolation: select a fixed nonzero coefficient, remove that
 * row/unknown, and reconstruct in reverse selection order. Later pivot rows
 * cannot reference an already removed name, so no substitution tree expansion
 * or branch search is required. Existing assignment planning can do better on
 * chains; callers retain whichever safe plan removes more unknowns. */
export function affineSubstitutions(equations: string[], expressions: Expression[], unknowns: string[], fixed: Scope, bounded: Set<string>): AffineSubstitutions | null {
  const names = new Set<string>(), rows = new Set<number>();
  const candidates: { row: number; assignment: Assignment; dependencies: number; coefficient: number; constant: Expression }[] = [];
  for (let row = 0; row < equations.length; row++) {
      for (const name of unknowns) {
        if (bounded.has(name) || !expressions[row].variables.includes(name)) continue;
        const form = affineExpression(expressions[row], [name], equations[row]);
        const coefficient = form?.coefficients.get(name);
        if (!form || !coefficient || coefficient.variables.some(variable => !Object.hasOwn(fixed, variable))) continue;
        let value: number;
        try { value = coefficient.evaluate(fixed); } catch { continue; }
        // Extreme reassociation can overflow B before dividing by A even when
        // the original grouped expression is finite. Leave such scales alone.
        const safeScale = Math.sqrt(Number.MAX_VALUE);
        if (Math.abs(value) < 1 / safeScale || Math.abs(value) > safeScale) continue;
        const expression = expressionFromNode({ type: 'binary', op: '/', left: {
          type: 'unary', op: '-', arg: form.constant.node,
        }, right: { type: 'number', value } }, `isolating ${name} in ${equations[row]}`);
        if (expression.variables.includes(name)) continue;
        const dependencies = expression.variables.filter(variable => unknowns.includes(variable)).length;
        candidates.push({ row, assignment: { name, source: equations[row], expression }, dependencies, coefficient: value, constant: form.constant });
      }
  }
  candidates.sort((left, right) => left.dependencies - right.dependencies);
  const selected: typeof candidates = [];
  for (const candidate of candidates) {
    if (rows.has(candidate.row) || names.has(candidate.assignment.name) || expressions[candidate.row].variables.some(name => names.has(name))) continue;
    names.add(candidate.assignment.name); rows.add(candidate.row); selected.push(candidate);
  }
  return names.size ? {
    names, equations: equations.filter((_, row) => !rows.has(row)), ordered: [...selected].reverse().map(candidate => candidate.assignment), circular: false,
    validate: (values, tolerance) => selected.every(candidate => {
      const error = expressions[candidate.row].evaluate(values);
      const scale = Math.max(Number.MIN_VALUE, Math.abs(candidate.coefficient * values[candidate.assignment.name]), Math.abs(candidate.constant.evaluate(values)));
      return Number.isFinite(scale) && Math.abs(error) <= tolerance * scale;
    }),
  } : null;
}
