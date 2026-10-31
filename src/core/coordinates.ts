import { compile } from './expression';
import { compileComplex } from './complexExpression';
import { realCoordinate } from './complex';
import type { Complex, Scope } from './types';

/** Plot coordinates are real even when the underlying solution is complex. */
export function coordinateExpression(source: string, complexMode = false): {
  variables: string[];
  evaluate: (values: Scope, complexValues?: Record<string, Complex>) => number;
} {
  if (!complexMode) return compile(source);
  const expression = compileComplex(source);
  return { variables: expression.variables, evaluate: (values, complexValues) =>
    realCoordinate(expression.evaluate({ ...values, ...complexValues })) };
}
