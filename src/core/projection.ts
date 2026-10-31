import { compile, type Expression } from './expression';
import { equationAssignment, equationProgram } from './equations';
import { configurationCurves } from './axes';
import { coordinateExpression } from './coordinates';
import { normalizeSweep, parameterSweepPlan, type SweepPlan } from './sweepPlan';
import { setSliceSweeps, sliceSweeps, usedVariables } from './variables';
import type { MultiSweepPlan } from './doubleSweep';
import type { Branch, Configuration, Point, Scope, SecondarySweep, SweepResult, Variable } from './types';

const rawAxes = (config: Configuration) => ({ x: config.sweep.parameter || '0', y: '0' });
const activeNames = (config: Configuration) => usedVariables({ ...config, axes: rawAxes(config) });
const sampledNames = (config: Configuration) => new Set([config.sweep.parameter, ...sliceSweeps(config).map(axis => axis.parameter)].filter(Boolean));

/** Slider bounds and steps on a fixed input do not alter the numerical model. */
function numericalVariable(config: Configuration, variable: Variable): Variable {
  const released = config.sweep.mode === 'constrained' && variable.name === config.sweep.release;
  if (variable.kind === 'parameter' && !released) return { name: variable.name, kind: variable.kind, value: variable.value };
  if (variable.kind === 'derived') return { name: variable.name, kind: variable.kind, value: variable.value, expression: variable.expression };
  return { name: variable.name, kind: variable.kind, value: variable.value, min: variable.min, max: variable.max };
}

/** The worker retains solutions independently of the current graph definitions. */
export function solverConfiguration(config: Configuration): Configuration {
  const names = activeNames(config);
  return {
    ...config, name: '', description: '', documents: undefined, regions: [], axes: rawAxes(config),
    variables: config.variables.filter(variable => names.has(variable.name)).map(variable => numericalVariable(config, variable)),
  };
}

/** Compatible root sets may be reused at the same coordinates after resampling. */
export function modelKey(config: Configuration): string {
  const numerical = solverConfiguration(config), sampled = sampledNames(config);
  return JSON.stringify({
    program: equationProgram(numerical.equations), constraints: numerical.constraints,
    variables: numerical.variables.map(variable => sampled.has(variable.name) ? { name: variable.name, kind: variable.kind } : variable),
    sweep: { mode: config.sweep.mode, parameter: config.sweep.parameter,
      release: config.sweep.mode === 'constrained' ? config.sweep.release : '', dimensions: [...sampled] },
    solver: numerical.solver,
  });
}

const sampleDefinition = (axis: Configuration['sweep'] | SecondarySweep) => Object.hasOwn(axis, 'step')
  ? { parameter: axis.parameter, min: axis.min, max: axis.max, step: axis.step, startAt: axis.startAt, centered: true }
  : { parameter: axis.parameter, min: axis.min, max: axis.max, points: axis.points, logarithmic: axis.logarithmic };

/** Plot expressions, tab organization, and fixed-slider metadata never start a solve. */
export function solveKey(config: Configuration): string {
  return JSON.stringify({ model: modelKey(config), samples: [config.sweep, ...sliceSweeps(config)].map(axis => ({
    ...sampleDefinition(axis),
    ...(Object.hasOwn(axis, 'step') ? { startAt: axis.startAt ?? config.variables.find(variable => variable.name === axis.parameter)?.value } : {}),
  })) });
}

function pointScope(point: Point, config: Configuration, active: Set<string>, coordinates: Scope): Scope {
  const values: Scope = { ...coordinates, ...point.values };
  for (const variable of config.variables) if (variable.kind === 'parameter' && (!active.has(variable.name) || !Object.hasOwn(values, variable.name))) {
    values[variable.name] = Object.hasOwn(coordinates, variable.name) ? coordinates[variable.name] : variable.value;
  }
  return values;
}

/** Evaluate only expressions over retained roots. Domain errors produce gaps,
 * leaving all numerical roots available for the next view change. */
export function projectSweep(raw: SweepResult, config: Configuration, coordinates: Scope = {}): SweepResult {
  if (!config.axes.x.trim() || !config.axes.y.trim()) throw new Error('Add set_time_axis parameter and a plot command, for example plot y.');
  const curves = configurationCurves(config).map(curve => ({ ...curve, xExpression: coordinateExpression(curve.x, config.solver.complex), yExpression: coordinateExpression(curve.y, config.solver.complex) }));
  const active = activeNames(config), failures = [...raw.failures];
  const project = (point: Point): Point => {
    const values = pointScope(point, config, active, coordinates);
    const evaluate = (expression: ReturnType<typeof coordinateExpression>, label: string, axis: 'X' | 'Y'): number | null => {
      try { return expression.evaluate(values, point.complexValues); }
      catch (error) { failures.push({ index: point.index, parameter: point.parameter, reason: `${axis} expression “${label}”: ${(error as Error).message}` }); return null; }
    };
    const xs = curves.map(curve => evaluate(curve.xExpression, curve.x, 'X'));
    const ys = curves.map(curve => evaluate(curve.yExpression, curve.y, 'Y'));
    return { ...point, values, x: xs[0] ?? NaN, y: ys[0] ?? NaN, xs, ys };
  };
  return { ...raw, branches: raw.branches.map(branch => ({ id: branch.id, points: branch.points.map(project) })), failures };
}

/** A different X dimension changes the displayed cross-section, not the stored grid. */
export function viewConfiguration(config: Configuration): Configuration {
  if (config.sweep.mode !== 'free' || config.axes.x === config.sweep.parameter) return config;
  const dimensions = sliceSweeps(config), main = dimensions.find(axis => axis.parameter === config.axes.x);
  if (!main) return config;
  const { secondary: _secondary, additional: _additional, ...previous } = config.sweep;
  const next = { ...config, sweep: { ...previous, ...main } };
  const original: SecondarySweep = { parameter: previous.parameter, min: previous.min, max: previous.max,
    points: previous.points, logarithmic: previous.logarithmic,
    ...(Object.hasOwn(previous, 'step') ? { step: previous.step, startAt: previous.startAt } : {}) };
  setSliceSweeps(next, [original, ...dimensions.filter(axis => axis.parameter !== main.parameter)]);
  return normalizeSweep(next);
}

export interface RetainedSlice { result: SweepResult | null; error?: string }
export interface ViewSweep { result: SweepResult | null; error?: string }

function mainPlan(config: Configuration): SweepPlan {
  const axis = config.sweep;
  if (Object.hasOwn(axis, 'step')) return parameterSweepPlan({ name: axis.parameter, kind: 'parameter',
    value: axis.startAt ?? config.variables.find(variable => variable.name === axis.parameter)?.value ?? axis.min,
    min: axis.min, max: axis.max, step: axis.step });
  const values = Array.from({ length: axis.points }, (_, index) => {
    const t = index / (axis.points - 1);
    return axis.logarithmic ? axis.min * (axis.max / axis.min) ** t : axis.min + (axis.max - axis.min) * t;
  });
  return { values, order: values.map((_, index) => index), startIndex: 0 };
}

/** Selector plans are views of existing coordinates. A former main dimension
 * keeps its full main-sweep capacity when it becomes a displayed selector. */
export function viewDimensions(config: Configuration, rawPlan: MultiSweepPlan | null = null): MultiSweepPlan['dimensions'] {
  const x = config.axes.x || config.sweep.parameter;
  const dimensions = [{ parameter: config.sweep.parameter, plan: mainPlan(config) }, ...(rawPlan?.dimensions ?? [])];
  return dimensions.filter(dimension => dimension.parameter !== x);
}

function exactIndex(values: number[], value: number): number {
  let low = 0, high = values.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (values[middle] === value) return middle;
    if (values[middle] < value) low = middle + 1; else high = middle - 1;
  }
  return -1;
}

/** Raw branch points are already sorted by their original sampled coordinate. */
function pointAt(points: Point[], parameter: number): Point | undefined {
  let low = 0, high = points.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1, candidate = points[middle];
    if (candidate.parameter === parameter) return candidate;
    if (candidate.parameter < parameter) low = middle + 1; else high = middle - 1;
  }
  return undefined;
}

const failureIndices = new WeakMap<SweepResult, Map<number, SweepResult['failures']>>();
function failuresAt(result: SweepResult, parameter: number): SweepResult['failures'] {
  if (!result.failures.length) return [];
  let byParameter = failureIndices.get(result);
  if (!byParameter) {
    byParameter = new Map();
    for (const failure of result.failures) {
      const list = byParameter.get(failure.parameter) ?? [];
      list.push(failure); byParameter.set(failure.parameter, list);
    }
    failureIndices.set(result, byParameter);
  }
  return byParameter.get(parameter) ?? [];
}

/** Use the same conservative jump threshold as numerical branch continuation,
 * except for acyclic smooth assignment chains whose roots are continuous. */
function smoothAssignments(config: Configuration): boolean {
  const equations = equationProgram(config.equations).equations, dependencies = new Map<string, Expression>();
  for (const source of equations) {
    const assignment = equationAssignment(source);
    if (!assignment || /\b(?:if|floor|ceil|sign)\s*\(|[?:<>=!&|]/.test(assignment.source)) return false;
    dependencies.set(assignment.name, compile(assignment.source));
  }
  const done = new Set<string>(), active = new Set<string>();
  const visit = (name: string): boolean => {
    if (done.has(name) || !dependencies.has(name)) return true;
    if (active.has(name)) return false;
    active.add(name);
    if (!dependencies.get(name)!.variables.every(visit)) return false;
    active.delete(name); done.add(name); return true;
  };
  return equations.length > 0 && [...dependencies.keys()].every(visit);
}

function rootDistance(left: Point, right: Point, unknowns: string[], config: Configuration): number {
  return Math.sqrt(unknowns.reduce((sum, name) => {
    const variable = config.variables.find(candidate => candidate.name === name);
    const value = variable?.value ?? 0;
    const span = variable?.min !== undefined && variable.max !== undefined ? (variable.max - variable.min) / 2 : 0;
    const candidate = Math.max(Math.abs(value), span), scale = candidate === 0 ? 1 : Math.max(candidate, 1e-6);
    return sum + ((left.values[name] - right.values[name]) / scale) ** 2;
  }, 0));
}

/** Select only the slices and original sample coordinates needed for this view.
 * Switching a grid's X dimension never rescans the full retained point grid. */
export function viewSweep(rawConfig: Configuration, rawPlan: MultiSweepPlan | null,
  slices: ReadonlyMap<number, RetainedSlice>, viewConfig: Configuration, selectedValues: Scope = {}): ViewSweep {
  if (!rawPlan) {
    const slice = slices.get(0);
    return slice?.result ? { result: projectSweep(slice.result, viewConfig) } : { result: null, error: slice?.error };
  }
  const indices = rawPlan.dimensions.map(dimension => Object.hasOwn(selectedValues, dimension.parameter)
    ? exactIndex(dimension.plan.values, selectedValues[dimension.parameter]) : dimension.plan.startIndex);
  if (indices.some(index => index < 0)) return { result: null, error: 'Choose an exact computed slice value.' };
  const viewAxis = rawPlan.dimensions.findIndex(dimension => dimension.parameter === viewConfig.axes.x);
  if (viewAxis < 0 || viewConfig.axes.x === rawConfig.sweep.parameter) {
    const index = rawPlan.indexOf(indices), slice = slices.get(index);
    return slice?.result ? { result: projectSweep(slice.result, viewConfig, rawPlan.valuesAt(index)) } : { result: null, error: slice?.error };
  }
  const mainValue = selectedValues[rawConfig.sweep.parameter] ?? rawConfig.sweep.startAt
    ?? (rawConfig.sweep.mode === 'constrained' ? rawConfig.sweep.min : rawConfig.variables.find(variable => variable.name === rawConfig.sweep.parameter)?.value)
    ?? rawConfig.sweep.min;
  const values = rawPlan.dimensions[viewAxis].plan.values, branches: Branch[] = [], failures: SweepResult['failures'] = [];
  let previous: { branch: Branch; point: Point }[] = [], nextId = 1, solved = 0, template: SweepResult | undefined;
  const continuous = smoothAssignments(rawConfig);
  for (let index = 0; index < values.length; index++) {
    indices[viewAxis] = index;
    const rawIndex = rawPlan.indexOf(indices), slice = slices.get(rawIndex), raw = slice?.result;
    if (!raw) {
      previous = [];
      if (slice?.error) failures.push({ index, parameter: values[index], reason: slice.error });
      continue;
    }
    template ??= raw;
    const coordinates = { ...rawPlan.valuesAt(rawIndex), [rawConfig.sweep.parameter]: mainValue };
    const points = raw.branches.flatMap(branch => {
      const point = pointAt(branch.points, mainValue);
      return point ? [{ ...point, index, parameter: values[index], values: { ...coordinates, ...point.values } }] : [];
    });
    failures.push(...failuresAt(raw, mainValue).map(failure => ({ ...failure, index, parameter: values[index] })));
    if (points.length) solved++;
    const available = new Set(previous), current: typeof previous = [], matches = new Map<number, Branch>();
    const pairs = points.flatMap((point, root) => previous.map(candidate => ({ root, candidate, distance: rootDistance(point, candidate.point, raw.unknowns, rawConfig) })))
      .sort((left, right) => left.distance - right.distance);
    for (const pair of pairs) if ((continuous || pair.distance < .65) && available.has(pair.candidate) && !matches.has(pair.root)) {
      matches.set(pair.root, pair.candidate.branch); available.delete(pair.candidate);
    }
    points.forEach((point, root) => {
      const branch = matches.get(root) ?? { id: nextId++, points: [] };
      if (!branch.points.length) branches.push(branch);
      const next = { ...point, branch: branch.id }; branch.points.push(next); current.push({ branch, point: next });
    });
    previous = current;
  }
  if (!template) return { result: null, error: failures[0]?.reason };
  const rawView: SweepResult = { ...template, branches, failures, solved, total: values.length };
  return { result: projectSweep(rawView, viewConfig) };
}
