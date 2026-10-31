import { compile } from './expression';
import type { Configuration, PlotCurve } from './types';

/** Split the Y list only at top-level commas, preserving function arguments. */
export function yExpressions(source: string): string[] {
  const expressions: string[] = []; let depth = 0, start = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '(') depth++;
    if (source[i] === ')') depth--;
    if (source[i] === ',' && depth === 0) { expressions.push(source.slice(start, i).trim()); start = i + 1; }
  }
  expressions.push(source.slice(start).trim());
  if (expressions.some(expression => !expression)) throw new Error('Enter Y expressions separated by commas, for example: y, y^2, max(y, 0).');
  if (expressions.length > 16) throw new Error('Plot up to 16 Y expressions at a time.');
  return expressions;
}
/** Legacy engine configurations share X; source commands may override X per curve. */
export function plotCurves(axes: Configuration['axes']): PlotCurve[] {
  return axes.curves ?? yExpressions(axes.y).map(y => ({ x: axes.x, y }));
}

/** A constrained complex sweep imposes the real component of its unknown. */
export function configurationCurves(config: Configuration): PlotCurve[] {
  const curves = plotCurves(config.axes);
  return config.solver.complex && config.sweep.mode === 'constrained' && !config.axes.curves && config.axes.x === config.sweep.parameter
    ? curves.map(curve => ({ ...curve, x: `real(${config.sweep.parameter})` })) : curves;
}

/** A valid whole expression keeps its existing meaning, including spaces in math.
 * Otherwise Y followed by X selects a parametric curve; parentheses group any
 * spaces within a coordinate. */
export function plotArguments(source: string): { x?: string; y: string }[] {
  source = source.trim();
  const targets = yExpressions(source);
  if (targets.length > 1) {
    targets.forEach(compile);
    return targets.map(y => ({ y }));
  }
  let expressionError: unknown;
  try { compile(source); return [{ y: source.trim() }]; }
  catch (error) { expressionError = error; }
  const coordinates: string[] = [];
  let depth = 0, start = 0;
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '(') depth++;
    else if (source[index] === ')') depth--;
    else if (depth === 0 && /\s/.test(source[index])) {
      coordinates.push(source.slice(start, index));
      while (index + 1 < source.length && /\s/.test(source[index + 1])) index++;
      start = index + 1;
    }
  }
  coordinates.push(source.slice(start));
  if (coordinates.length === 2) {
    const [y, x] = coordinates;
    compile(x); compile(y);
    return [{ x, y }];
  }
  if (coordinates.length > 2) throw new Error('Use plot y or plot y x. Wrap each coordinate expression containing spaces in parentheses.');
  throw expressionError;
}
