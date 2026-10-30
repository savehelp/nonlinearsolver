import { compile } from './expression';

/** Evaluate a numeric-only expression without exposing JavaScript or variable lookup. */
export function numericExpression(source: string): number {
  const expression = compile(source);
  if (expression.variables.length) throw new Error(`Use numbers and mathematical functions only; “${expression.variables[0]}” is not a number.`);
  return expression.evaluate({});
}
