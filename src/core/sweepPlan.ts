import type { Configuration, Variable } from './types';
import { MAX_PARAMETER_SAMPLES } from './sweepLimits';
import { setSliceSweeps, sliceSweeps } from './variables';
import { formatSampleCount } from './sweepCounts';

export interface SweepPlan { values: number[]; order: number[]; startIndex: number }
export { MAX_PARAMETER_SAMPLES } from './sweepLimits';

/** Count the requested grid without allocating sample arrays or applying a cap. */
function parameterIntervals(variable: Variable): { below: number; above: number; count: number } {
  const { name, min, max, step, value: start } = variable;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min! >= max!) {
    throw new Error(`${name}: set a finite increasing parameter range.`);
  }
  if (!Number.isFinite(step) || step! <= 0) throw new Error(`${name}: set a finite positive parameter step size.`);
  if (!Number.isFinite(start) || start < min! || start > max!) {
    throw new Error(`${name}: the sweep starting value must be within the parameter range.`);
  }
  // Divide differences directly when possible; fall back to scaled subtraction
  // when two finite endpoints have a difference larger than Number.MAX_VALUE.
  const intervals = (a: number, b: number) => {
    const difference = a - b;
    const ratio = Number.isFinite(difference) ? difference / step! : a / step! - b / step!;
    const tolerance = Math.min(1e-7, Number.EPSILON * 8 * Math.max(1, Math.abs(ratio)));
    return Math.max(0, Math.floor(ratio + tolerance));
  };
  const below = intervals(start, min!), above = intervals(max!, start), count = below + above + 1;
  return { below, above, count };
}

export function parameterSampleCount(variable: Variable): number { return parameterIntervals(variable).count; }

export function validateParameterSampleCount(variable: Variable, count: number, limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('The sweep sample limit must be a positive integer.');
  if (count <= limit) return;
  const { name, min, max, step, value: start } = variable;
  const candidate = limit > 1 ? (max! / (limit - 1) - min! / (limit - 1)) * (1 + 1e-8) : NaN;
  const suggestion = Number.isFinite(candidate) && candidate > 0
    ? `Try a step of at least ${Number(candidate.toPrecision(12))} or narrow the range.`
    : 'Increase the step size or narrow the range.';
  const distinct = (start > min! && start - step! === start) || (start < max! && start + step! === start)
    ? ' This step is also too small to produce distinct samples near the starting point.' : '';
  throw new Error(`${name}: requested ${formatSampleCount(count)} sweep samples; the limit is ${formatSampleCount(limit)} sweep samples. Range ${min} to ${max}, step ${step}. ${suggestion}${distinct}`);
}

/** Samples are anchored at the configured starting value, not at the range's
 * minimum. Indices remain ascending while the solve order expands outward. */
export function parameterSweepPlan(variable: Variable, limit = MAX_PARAMETER_SAMPLES): SweepPlan {
  const { name, min, max, step, value: start } = variable;
  const { below, count } = parameterIntervals(variable);
  validateParameterSampleCount(variable, count, limit);
  if ((start > min! && start - step! === start) || (start < max! && start + step! === start)) {
    throw new Error(`${name}: the step size is too small to produce distinct sample values.`);
  }
  const values = Array.from({ length: count }, (_, index) => {
    const offset = index - below;
    if (!offset) return start;
    const delta = offset * step!;
    const sample = Number.isFinite(delta) ? start + delta : (start / step! + offset) * step!;
    // Only endpoint rounding can leave the range: interval counts were checked
    // first, so clamping restores an aligned endpoint without adding a sample.
    return Math.min(max!, Math.max(min!, sample));
  });
  if (values.some((value, index) => !Number.isFinite(value) || (index > 0 && value <= values[index - 1]))) {
    throw new Error(`${name}: the step size is too small to produce distinct sample values.`);
  }
  const order = [below];
  for (let distance = 1; order.length < count; distance++) {
    if (below - distance >= 0) order.push(below - distance);
    if (below + distance < count) order.push(below + distance);
  }
  return { values, order, startIndex: below };
}

/** Project the Parameters fields into the engine's sweep settings. Invalid
 * in-progress edits remain representable; the worker reports the plan error. */
export function normalizeSweep(config: Configuration): Configuration {
  const sweep = { ...config.sweep };
  const project = (variable: Variable) => {
    let points = 0;
    try { points = parameterSampleCount(variable); } catch { /* Preserve the invalid fields for diagnostics. */ }
    return { min: variable.min ?? NaN, max: variable.max ?? NaN, step: variable.step, startAt: variable.value, points, logarithmic: false };
  };
  const main = config.variables.find(variable => variable.name === sweep.parameter && variable.kind === 'parameter');
  if (config.sweep.mode === 'free' && main) Object.assign(sweep, project(main));
  else { delete sweep.step; delete sweep.startAt; }
  const normalized = { ...config, sweep };
  setSliceSweeps(normalized, sliceSweeps(config).map(dimension => {
    const secondary = { ...dimension };
    const variable = config.variables.find(variable => variable.name === secondary.parameter && variable.kind === 'parameter');
    if (variable) Object.assign(secondary, project(variable));
    return secondary;
  }));
  return normalized;
}

/** Older saved workspaces could keep sweep limits/counts separately and omit
 * slider fields. Fill only missing fields once; explicit Parameters values win. */
export function migrateParameterSweepSettings(config: Configuration): void {
  const fill = (name: string, legacy: { min: number; max: number; points: number }) => {
    const variable = config.variables.find(variable => variable.name === name && variable.kind === 'parameter');
    if (!variable) return;
    if (variable.min === undefined) variable.min = Number.isFinite(legacy.min) ? legacy.min : Math.min(0, variable.value);
    if (variable.max === undefined) variable.max = Number.isFinite(legacy.max) ? legacy.max : Math.max(10, variable.value * 2);
    if (variable.step === undefined) {
      const intervals = Number.isInteger(legacy.points) && legacy.points > 1 ? legacy.points - 1 : 100;
      variable.step = (variable.max - variable.min) / intervals;
      if (!Number.isFinite(variable.step)) variable.step = variable.max / intervals - variable.min / intervals;
    }
  };
  if (config.sweep.mode === 'free') fill(config.sweep.parameter, config.sweep);
  for (const dimension of sliceSweeps(config)) fill(dimension.parameter, dimension);
}
