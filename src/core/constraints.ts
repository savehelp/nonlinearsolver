import { compile, lines } from './expression';
import type { Configuration, Scope, Variable } from './types';

/** Move old unknown bounds into editable validity conditions without changing parameter slider ranges. */
export function migrateUnknownBounds(config: Configuration): boolean {
  const additions: string[] = [];
  for (const variable of config.variables) {
    if (variable.kind !== 'unknown') continue;
    for (const [key, operator] of [['min', '>='], ['max', '<=']] as const) {
      const value = variable[key];
      if (value === undefined) continue;
      if (!Number.isFinite(value)) continue; // Keep malformed legacy data visible to validation.
      additions.push(`${variable.name} ${operator} ${value}`);
      delete variable[key];
    }
  }
  if (!additions.length) return false;
  config.constraints = [config.constraints.trimEnd(), ...additions].filter(Boolean).join('\n');
  return true;
}

/** Recognize safe, inclusive interval conditions; everything else is still checked as validity. */
export function applyValidityBounds(unknowns: Variable[], source: string, fixed: Scope): void {
  const byName = new Map(unknowns.map(variable => [variable.name, variable]));
  const inferred = new Map<Variable, { min?: number; max?: number }>();
  for (const line of lines(source)) {
    const match = /^\s*(.+?)\s*(<=|>=)\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const [, left, operator, right] = match;
    const leftVariable = byName.get(left), rightVariable = byName.get(right);
    if (Boolean(leftVariable) === Boolean(rightVariable)) continue;
    const variable = leftVariable ?? rightVariable!;
    const constantSide = leftVariable ? right : left;
    try {
      const expression = compile(constantSide);
      if (!expression.variables.every(name => Object.hasOwn(fixed, name))) continue;
      const value = expression.evaluate(fixed);
      const bounds = inferred.get(variable) ?? {};
      const isMinimum = leftVariable ? operator === '>=' : operator === '<=';
      if (isMinimum) bounds.min = Math.max(bounds.min ?? -Infinity, value);
      else bounds.max = Math.min(bounds.max ?? Infinity, value);
      inferred.set(variable, bounds);
    } catch { /* Complex or invalid conditions are handled by the ordinary validity evaluator. */ }
  }
  for (const [variable, bounds] of inferred) {
    const minimum = Math.max(variable.min ?? -Infinity, bounds.min ?? -Infinity);
    const maximum = Math.min(variable.max ?? Infinity, bounds.max ?? Infinity);
    // Contradictory conditions can depend on the sweep parameter. Leave them to
    // validity checks so a failed point becomes a gap, rather than aborting the sweep.
    if (minimum > maximum) continue;
    if (minimum !== -Infinity) variable.min = minimum;
    if (maximum !== Infinity) variable.max = maximum;
  }
}
