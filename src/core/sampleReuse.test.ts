import { describe, expect, it } from 'vitest';
import { clone, starter } from '../examples';
import { prepareSweepReuse, SampleReuseCache, type SweepReuse } from './sampleReuse';
import { sweep, sweepSteps } from './solver';
import { normalizeSweep } from './sweepPlan';
import { configForCombination } from './doubleSweep';
import type { Configuration, SweepResult } from './types';

function configuration(): Configuration {
  const config = clone(starter);
  config.equations = 'y^2 = x + a;\ny >= 0;';
  config.axes = { x: 'x', y: '0' };
  Object.assign(config.variables.find(variable => variable.name === 'x')!, { min: 0, max: 4, value: 0, step: 1 });
  config.solver.starts = 4;
  return normalizeSweep(config);
}
function resample(config: Configuration, previous: SweepReuse): SweepResult {
  const cache = new SampleReuseCache(config, prepareSweepReuse(config, previous));
  const steps = sweepSteps(config, Infinity, undefined, cache.forConfig(config));
  let step = steps.next(); while (!step.done) step = steps.next();
  return step.value.result;
}
const source = (config: Configuration): SweepReuse => ({ config, slices: [{ values: {}, result: sweep(config) }] });

describe('numerical sample reuse during resampling', () => {
  it('coarsens an existing grid without another numerical root search', () => {
    const before = configuration(), previous = source(before), config = clone(before);
    config.variables.find(variable => variable.name === 'x')!.step = 2;
    const result = resample(normalizeSweep(config), previous);
    expect(result.total).toBe(3); expect(result.reused).toBe(3); expect(result.computed).toBe(0);
    const points = result.branches.flatMap(branch => branch.points);
    expect(points.map(point => point.parameter)).toEqual([0, 2, 4]);
    for (const point of points) expect(point.values.y).toBeCloseTo(Math.sqrt(point.parameter + 1), 8);
  });

  it('solves only coordinates missing from the previous grid when refining', () => {
    const before = configuration(), previous = source(before), config = clone(before);
    config.variables.find(variable => variable.name === 'x')!.step = .5;
    const result = resample(normalizeSweep(config), previous);
    expect(result.total).toBe(9); expect(result.reused).toBe(5); expect(result.computed).toBe(4);
    for (const point of result.branches.flatMap(branch => branch.points)) expect(point.values.y).toBeCloseTo(Math.sqrt(point.parameter + 1), 8);
  });

  it('matches exact coordinates without interpolating off-grid starts', () => {
    const before = configuration(), previous = source(before), config = clone(before);
    config.variables.find(variable => variable.name === 'x')!.value = .25;
    const result = resample(normalizeSweep(config), previous);
    expect(result.total).toBe(4); expect(result.reused).toBe(0); expect(result.computed).toBe(4);
    expect(result.branches.flatMap(branch => branch.points).map(point => point.parameter)).toEqual([.25, 1.25, 2.25, 3.25]);
  });

  it('does not reuse roots after model, fixed-value, guess, or solver changes', () => {
    const before = configuration(), previous = source(before);
    const changes: ((config: Configuration) => void)[] = [
      config => { config.equations = 'y^2 = x + a + 1;\ny >= 0;'; },
      config => { config.constraints = 'y < 10'; },
      config => { config.variables.find(variable => variable.name === 'a')!.value = 2; },
      config => { config.variables.find(variable => variable.name === 'y')!.value = 2; },
      config => { config.solver.starts++; },
      config => { config.solver.tolerance /= 10; },
    ];
    for (const change of changes) {
      const config = clone(before); change(config);
      expect(prepareSweepReuse(config, previous)).toBeUndefined();
      const result = resample(config, previous);
      expect(result.reused).toBe(0); expect(result.computed).toBe(5);
    }
  });

  it('retries failed coordinates rather than treating failure as a reusable root', () => {
    const before = configuration(); before.equations = 'y^2 = x - 1;\ny >= 0;';
    const previous = source(before), cache = new SampleReuseCache(before, prepareSweepReuse(before, previous));
    expect(previous.slices[0].result.failures[0].parameter).toBe(0);
    expect(cache.forConfig(before)(0)).toBeUndefined();
    const result = resample(before, previous);
    expect(result.computed).toBe(1); expect(result.reused).toBe(4);
    expect(result.failures.map(failure => failure.parameter)).toEqual([0]);
  });

  it('can reuse completed coordinates from a partial sweep', () => {
    const config = configuration(), previous = source(config);
    previous.slices[0].result.branches = previous.slices[0].result.branches.map(branch => ({ ...branch, points: branch.points.filter(point => point.index <= 2) }));
    const result = resample(config, previous);
    expect(result.reused).toBe(3); expect(result.computed).toBe(2);
  });

  it('keys multidimensional samples by every selected parameter and prunes removed coordinates', () => {
    const before = configuration();
    Object.assign(before.variables.find(variable => variable.name === 'a')!, { min: 0, max: 2, value: 0, step: 1 });
    before.sweep.secondary = { parameter: 'a', min: 0, max: 2, points: 3, step: 1, startAt: 0, logarithmic: false };
    const previous: SweepReuse = { config: before, slices: [0, 1, 2].map(a => ({ values: { a }, result: sweep(configForCombination(before, { a })) })) };
    const config = clone(before); config.variables.find(variable => variable.name === 'a')!.step = 2;
    const normalized = normalizeSweep(config), data = prepareSweepReuse(normalized, previous)!;
    expect(data.samples).toHaveLength(10);
    const cache = new SampleReuseCache(normalized, data);
    for (const a of [0, 2]) {
      const slice = configForCombination(normalized, { a });
      const steps = sweepSteps(slice, Infinity, undefined, cache.forConfig(slice));
      let step = steps.next(); while (!step.done) step = steps.next();
      expect(step.value.result.computed).toBe(0); expect(step.value.result.reused).toBe(5);
      for (const point of step.value.result.branches.flatMap(branch => branch.points)) expect(point.values.y).toBeCloseTo(Math.sqrt(point.parameter + a), 8);
    }
    expect(cache.forConfig(configForCombination(normalized, { a: 1 }))(0)).toBeUndefined();
  });

  it('caps payload size without sending partial root sets', () => {
    const before = configuration(); before.equations = 'y^2 = x + a;'; before.solver.starts = 12;
    const previous = source(before), counts = new Map<number, number>();
    for (const branch of previous.slices[0].result.branches) for (const point of branch.points) counts.set(point.parameter, (counts.get(point.parameter) ?? 0) + 1);
    expect([...counts.values()].every(count => count === 2)).toBe(true);
    const data = prepareSweepReuse(before, previous, 12_000)!;
    expect(data).toBeDefined(); expect(data.bytes).toBeLessThanOrEqual(12_000);
    for (const sample of data.samples) expect(sample.roots).toHaveLength(2);
    expect(prepareSweepReuse(before, previous, 100)).toBeUndefined();
  });

  it('does not seed from a projected graph that could have filtered numerical roots', () => {
    const config = configuration(), previous = source(config);
    previous.config = { ...config, axes: { x: 'x', y: 'sqrt(y)' } };
    expect(prepareSweepReuse(config, previous)).toBeUndefined();
  });
});
