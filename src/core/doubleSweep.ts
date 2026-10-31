import type { Configuration, Point, Scope, SweepResult } from './types';
import type { SweepSample } from './solver';
import { parameterSampleCount, parameterSweepPlan, validateParameterSampleCount, type SweepPlan } from './sweepPlan';
import { DEFAULT_SWEEP_BYTES, MAX_DOUBLE_SWEEP_SAMPLES, MAX_PARAMETER_SAMPLES, MAX_SECONDARY_SLICES } from './sweepLimits';
import { sliceSweeps } from './variables';
import { formatSampleCount, gridLimitMessage, sampleCountExceeds, sampleProduct } from './sweepCounts';

export { MAX_DOUBLE_SWEEP_SAMPLES, MAX_SECONDARY_SLICES } from './sweepLimits';

export interface MultiSweepPlan {
  dimensions: { parameter: string; plan: SweepPlan }[];
  /** The first extra parameter is the fastest-changing selector index. */
  strides: number[];
  totalSlices: number;
  mainPoints: number;
  startIndices: number[];
  startIndex: number;
  indicesAt(index: number): number[];
  indexOf(indices: number[]): number;
  valuesAt(index: number): Scope;
  order: Iterable<number>;
}

function mainSampleCount(config: Configuration): number {
  const { min, max, logarithmic } = config.sweep, { tolerance, starts, iterations } = config.solver;
  if (![tolerance, starts, iterations].every(Number.isFinite)) throw new Error('Sweep and solver settings must be finite numbers.');
  if (tolerance <= 0 || tolerance > .1 || iterations < 1 || iterations > 1000 || starts < 1 || starts > 64) {
    throw new Error('Use tolerance in (0, 0.1], 1–1000 iterations, and 1–64 starts.');
  }

  let mainPoints = config.sweep.points;
  if (Object.hasOwn(config.sweep, 'step')) {
    const main = config.variables.find(variable => variable.name === config.sweep.parameter);
    if (!main) throw new Error('Choose a main sweep parameter.');
    const variable = { ...main, min, max, step: config.sweep.step, value: config.sweep.startAt ?? main.value };
    mainPoints = parameterSampleCount(variable);
    validateParameterSampleCount(variable, mainPoints, MAX_PARAMETER_SAMPLES);
  } else {
    if (!Number.isInteger(mainPoints) || mainPoints < 2 || mainPoints > MAX_PARAMETER_SAMPLES) throw new Error(`Use 2–${MAX_PARAMETER_SAMPLES.toLocaleString('en-US')} integer points for the main sweep; requested ${formatSampleCount(mainPoints)} points.`);
    if (![min, max].every(Number.isFinite)) throw new Error('Sweep and solver settings must be finite numbers.');
    if (min >= max) throw new Error('Use an increasing main sweep range.');
    if (logarithmic && min <= 0) throw new Error('Logarithmic sweeps require positive limits.');
  }

  return mainPoints;
}

/** Build only the per-parameter plans. Combinations are indexed and visited lazily. */
export function multiSweepPlan(config: Configuration): MultiSweepPlan {
  const mainPoints = mainSampleCount(config), selected = sliceSweeps(config);
  const names = new Set([config.sweep.parameter]);
  if (config.sweep.mode === 'constrained') names.add(config.sweep.release);
  const requested = selected.map(secondary => {
    const parameter = config.variables.find(variable => variable.name === secondary.parameter);
    if (parameter?.kind !== 'parameter' || names.has(secondary.parameter)) {
      throw new Error('Choose distinct fixed parameters for additional sweeps, excluding the main sweep and released parameter.');
    }
    names.add(secondary.parameter);
    let count: number;
    if (Object.hasOwn(secondary, 'step')) {
      const variable = { ...parameter, min: secondary.min, max: secondary.max, step: secondary.step, value: secondary.startAt ?? parameter.value };
      count = parameterSampleCount(variable);
      validateParameterSampleCount(variable, count, MAX_SECONDARY_SLICES);
    } else {
      validateLegacySecondary(secondary);
      count = secondary.points;
    }
    return { secondary, parameter, count };
  });
  const axes = [{ name: config.sweep.parameter, count: mainPoints }, ...requested.map(({ secondary, count }) => ({ name: secondary.parameter, count }))];
  if (sampleCountExceeds(sampleProduct(axes.map(axis => axis.count)), MAX_DOUBLE_SWEEP_SAMPLES)) throw new Error(gridLimitMessage(axes, MAX_DOUBLE_SWEEP_SAMPLES));
  const dimensions: MultiSweepPlan['dimensions'] = [], strides: number[] = [];
  let totalSlices = 1;
  for (const { secondary, parameter } of requested) {
    const plan = Object.hasOwn(secondary, 'step')
      ? parameterSweepPlan({ ...parameter, min: secondary.min, max: secondary.max, step: secondary.step, value: secondary.startAt ?? parameter.value }, MAX_SECONDARY_SLICES)
      : legacySecondaryPlan(secondary);
    strides.push(totalSlices);
    totalSlices *= plan.values.length;
    dimensions.push({ parameter: secondary.parameter, plan });
  }
  const lengths = dimensions.map(dimension => dimension.plan.values.length);
  const startIndices = dimensions.map(dimension => dimension.plan.startIndex);
  const startIndex = startIndices.reduce((sum, index, dimension) => sum + index * strides[dimension], 0);
  const indicesAt = (index: number): number[] => {
    if (!Number.isInteger(index) || index < 0 || index >= totalSlices) throw new Error('Invalid sweep combination index.');
    return lengths.map((length, dimension) => Math.floor(index / strides[dimension]) % length);
  };
  const indexOf = (indices: number[]): number => {
    if (indices.length !== dimensions.length || indices.some((index, dimension) => !Number.isInteger(index) || index < 0 || index >= lengths[dimension])) {
      throw new Error('Invalid sweep selector indices.');
    }
    return indices.reduce((sum, index, dimension) => sum + index * strides[dimension], 0);
  };
  const valuesAt = (index: number): Scope => Object.fromEntries(indicesAt(index).map((sampleIndex, dimension) => [dimensions[dimension].parameter, dimensions[dimension].plan.values[sampleIndex]]));
  const order: Iterable<number> = dimensions.length === 1 ? dimensions[0].plan.order
    : { [Symbol.iterator]: () => centeredCombinations(lengths, strides, startIndices, startIndex) };
  return { dimensions, strides, totalSlices, mainPoints, startIndices, startIndex, indicesAt, indexOf, valuesAt, order };
}

interface FrontierEntry { index: number; distance: number; sequence: number }

/** A binary min-heap keeps Manhattan shells ordered without building the grid. */
function* centeredCombinations(lengths: number[], strides: number[], startIndices: number[], startIndex: number): Generator<number> {
  const heap: FrontierEntry[] = [], seen = new Set<number>();
  let sequence = 0;
  const before = (a: FrontierEntry, b: FrontierEntry) => a.distance < b.distance || (a.distance === b.distance && a.sequence < b.sequence);
  const push = (index: number, distance: number) => {
    if (seen.has(index)) return;
    seen.add(index);
    const entry = { index, distance, sequence: sequence++ };
    let position = heap.length; heap.push(entry);
    while (position > 0) {
      const parent = Math.floor((position - 1) / 2);
      if (!before(entry, heap[parent])) break;
      heap[position] = heap[parent]; position = parent;
    }
    heap[position] = entry;
  };
  const pop = (): FrontierEntry => {
    const first = heap[0], last = heap.pop()!;
    if (heap.length) {
      let position = 0;
      while (position * 2 + 1 < heap.length) {
        const left = position * 2 + 1, right = left + 1;
        const child = right < heap.length && before(heap[right], heap[left]) ? right : left;
        if (!before(heap[child], last)) break;
        heap[position] = heap[child]; position = child;
      }
      heap[position] = last;
    }
    return first;
  };
  push(startIndex, 0);
  while (heap.length) {
    const current = pop();
    yield current.index;
    for (let dimension = 0; dimension < lengths.length; dimension++) {
      const index = Math.floor(current.index / strides[dimension]) % lengths[dimension];
      for (const direction of [-1, 1]) {
        const next = index + direction;
        if (next < 0 || next >= lengths[dimension]) continue;
        const distance = current.distance + Math.abs(next - startIndices[dimension]) - Math.abs(index - startIndices[dimension]);
        push(current.index + direction * strides[dimension], distance);
      }
    }
  }
}

function validateLegacySecondary(secondary: NonNullable<Configuration['sweep']['secondary']>): void {
  if (![secondary.min, secondary.max, secondary.points].every(Number.isFinite)
    || secondary.min >= secondary.max || !Number.isInteger(secondary.points)
    || secondary.points < 2 || secondary.points > MAX_SECONDARY_SLICES) {
    throw new Error(`Use an increasing second sweep range and 2–${MAX_SECONDARY_SLICES.toLocaleString('en-US')} integer slices; ${secondary.parameter} requested ${formatSampleCount(secondary.points)} slices.`);
  }
  if (secondary.logarithmic && secondary.min <= 0) throw new Error('Logarithmic second sweeps require positive limits.');
}

function legacySecondaryPlan(secondary: NonNullable<Configuration['sweep']['secondary']>): SweepPlan {
  validateLegacySecondary(secondary);
  const values = Array.from({ length: secondary.points }, (_, index) => {
    const t = index / (secondary.points - 1);
    // Log-space interpolation avoids overflowing max/min for very wide ranges.
    return secondary.logarithmic
      ? Math.exp(Math.log(secondary.min) * (1 - t) + Math.log(secondary.max) * t)
      : secondary.min * (1 - t) + secondary.max * t;
  });
  values[0] = secondary.min; values[values.length - 1] = secondary.max;
  if (values.some((value, index) => !Number.isFinite(value) || (index > 0 && value <= values[index - 1]))) {
    throw new Error('Second sweep values must be finite and distinct. Widen the range or reduce slices.');
  }
  return { values, order: values.map((_, index) => index), startIndex: 0 };
}

export function configForCombination(config: Configuration, values: Scope): Configuration {
  const selected = new Set(sliceSweeps(config).map(sweep => sweep.parameter));
  const { secondary: _secondary, additional: _additional, ...sweep } = config.sweep;
  return { ...config, sweep, variables: config.variables.map(variable => selected.has(variable.name) && Object.hasOwn(values, variable.name)
    ? { ...variable, value: values[variable.name] } : variable) };
}

/** Conservative estimate, including object/property/array overhead and strings.
 * Stops immediately when the remaining budget is exceeded. */
export function retainedBytes(value: unknown, limit: number): number {
  if (typeof value === 'string') return 64 + value.length * 2;
  if (value === null || typeof value !== 'object') return 16;
  let bytes = Array.isArray(value) ? 64 + value.length * 16 : 96;
  if (bytes > limit) return bytes;
  if (Array.isArray(value)) {
    for (const item of value) {
      bytes += retainedBytes(item, limit - bytes);
      if (bytes > limit) break;
    }
  } else {
    for (const key of Object.keys(value)) {
      bytes += 64 + key.length * 2 + retainedBytes((value as Record<string, unknown>)[key], limit - bytes);
      if (bytes > limit) break;
    }
  }
  return bytes;
}

export class DoubleSweepMemoryError extends Error {
  constructor() {
    super('The sweep exceeds its memory budget. Increase parameter step sizes, reduce ranges or multistart guesses, and run it again.');
    this.name = 'DoubleSweepMemoryError';
  }
}

/** Counts only newly appended data. Completed slices are never evicted, since
 * every requested slice must remain available to its selector. */
export class DoubleSweepBudget {
  private used = 4096;
  private points = new Map<number, number>();
  private failures = 0;
  private readonly sliceOverhead: number;

  constructor(config: Configuration, private readonly maxBytes = DEFAULT_SWEEP_BYTES) {
    this.sliceOverhead = 4096 + retainedBytes({ equations: [config.equations], unknowns: config.variables.map(variable => variable.name) }, maxBytes);
    this.add(retainedBytes(config, maxBytes));
    const plannedCount = (value: number | undefined, limit: number) => Number.isFinite(value) ? Math.max(0, Math.min(limit, Math.floor(value!))) : 0;
    const selected = sliceSweeps(config);
    // Reserve per-dimension sample plans and the main sweep's transfer cursors.
    this.add(64 * (plannedCount(config.sweep.points, MAX_PARAMETER_SAMPLES)
      + selected.reduce((count, sweep) => count + plannedCount(sweep.points, MAX_SECONDARY_SLICES), 0)));
    if (selected.length > 1) {
      // Bound the heap, visited set, result-map entries, and selector bookkeeping
      // against all combinations, retaining the same overall memory allowance.
      const plan = multiSweepPlan(config);
      this.add(192 * plan.totalSlices);
    }
  }
  get bytes(): number { return this.used; }
  startSlice(): void { this.points.clear(); this.failures = 0; this.add(this.sliceOverhead); }
  recordError(error: string): void { this.add(256 + retainedBytes(error, this.maxBytes - this.used)); }
  /** Per-sample accounting touches only new data, even if every sample starts a
   * new branch. Historical branches are scanned just once at slice completion. */
  observeSample(sample: SweepSample): void {
    for (const point of sample.points) this.appendPoint(point);
    for (const failure of sample.failures) this.add(32 + retainedBytes(failure, this.maxBytes - this.used));
    this.failures += sample.failures.length;
  }
  observe(result: SweepResult): void {
    for (const branch of result.branches) {
      const count = this.points.get(branch.id) ?? 0;
      for (let index = count; index < branch.points.length; index++) this.appendPoint(branch.points[index]);
    }
    for (; this.failures < result.failures.length; this.failures++) {
      this.add(32 + retainedBytes(result.failures[this.failures], this.maxBytes - this.used));
    }
  }
  private appendPoint(point: Point): void {
    const count = this.points.get(point.branch);
    if (count === undefined) this.add(256);
    this.add(32 + retainedBytes(point, this.maxBytes - this.used));
    this.points.set(point.branch, (count ?? 0) + 1);
  }
  private add(bytes: number): void {
    this.used += bytes;
    if (!Number.isFinite(this.maxBytes) || this.maxBytes <= 0 || this.used > this.maxBytes) throw new DoubleSweepMemoryError();
  }
}

// The same retained-data accounting protects a single sweep and a slice grid.
export { DoubleSweepBudget as SweepBudget, DoubleSweepMemoryError as SweepMemoryError };
