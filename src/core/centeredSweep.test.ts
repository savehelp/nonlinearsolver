import { describe, expect, it } from 'vitest';
import { clone, starter } from '../examples';
import { sweep, sweepSteps } from './solver';
import { createSweepUpdates, mergeSweepUpdate } from './sweepStream';
import type { Configuration, SweepResult } from './types';

function configuration(value = 5, min = 0, max = 10, step = 1): Configuration {
  const config = clone(starter);
  config.equations = 'y = x;';
  config.variables = [{ name: 'y', kind: 'unknown', value: 10 }, { name: 'x', kind: 'parameter', value, min, max, step }];
  config.sweep = { ...config.sweep, min, max, points: 2, step, startAt: value };
  return config;
}

const withoutTime = (result: SweepResult) => ({ ...result, elapsed: 0 });

describe('centered primary sweeps', () => {
  it('computes the exact starting value first and alternates outward while keeping the curve ordered', () => {
    const config = configuration(), parameters: number[] = [], completed: number[] = [];
    const steps = sweepSteps(config, 0, (_result, sample) => parameters.push(sample.points[0].parameter));
    let step = steps.next();
    while (!step.done) {
      completed.push(step.value.completed);
      step = steps.next();
    }
    completed.push(step.value.completed);
    expect(parameters).toEqual([5, 4, 6, 3, 7, 2, 8, 1, 9, 0, 10]);
    expect(completed).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(step.value.result.total).toBe(11);
    expect(step.value.result.branches).toHaveLength(1);
    const points = step.value.result.branches[0].points;
    expect(points.map(point => point.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(points.map(point => point.parameter)).toEqual(points.map(point => point.index));
    expect(points.every(point => Math.abs(point.y - point.parameter) < 1e-7)).toBe(true);
  });

  it('supports an edge start and one sample when the step is wider than the range', () => {
    const order: number[] = [], config = configuration(0);
    const steps = sweepSteps(config, Infinity, (_result, sample) => order.push(sample.points[0].parameter));
    expect(steps.next().done).toBe(true);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const one = sweep(configuration(.5, 0, 1, 2));
    expect(one.solved).toBe(1); expect(one.total).toBe(1);
    expect(one.branches[0].points[0].parameter).toBe(.5);
  });

  it('keeps the other continuation frontier connected after one side fails', () => {
    const config = configuration(); config.constraints = 'x != 4';
    const result = sweep(config);
    expect(result.failures).toEqual([{ index: 4, parameter: 4, reason: expect.stringContaining('validity') }]);
    expect(result.branches).toHaveLength(2);
    expect(result.branches[0].points.map(point => point.parameter)).toEqual([5, 6, 7, 8, 9, 10]);
    expect(result.branches[1].points.map(point => point.parameter)).toEqual([0, 1, 2, 3]);
    for (const branch of result.branches) for (let i = 1; i < branch.points.length; i++) {
      expect(branch.points[i].index - branch.points[i - 1].index).toBe(1);
    }
  });

  it('does not connect across a failed starting point', () => {
    const config = configuration(); config.constraints = 'x != 5';
    const result = sweep(config);
    expect(result.solved).toBe(10);
    expect(result.branches).toHaveLength(2);
    for (const branch of result.branches) {
      expect(branch.points.every(point => point.parameter < 5) || branch.points.every(point => point.parameter > 5)).toBe(true);
    }
  });

  it('requires a valid step instead of silently reverting to a legacy point count', () => {
    const config = configuration(); config.sweep.step = undefined;
    expect(() => sweep(config)).toThrow(/step/i);
  });
});

describe('centered sweep streaming', () => {
  it('transfers both left prepends and right appends once, preserving old previews', () => {
    const config = configuration(), steps = sweepSteps(config, 0), update = createSweepUpdates();
    let assembled: SweepResult | null = null;
    const snapshots: SweepResult[] = [], transmitted: number[] = [];
    let step = steps.next();
    while (true) {
      const delta = update(step.value.result, step.value.completed);
      transmitted.push(...delta.branches.flatMap(branch => branch.points.map(point => point.index)));
      assembled = mergeSweepUpdate(assembled, delta); snapshots.push(assembled);
      if (step.done) break;
      step = steps.next();
    }
    expect(transmitted).toEqual([5, 4, 6, 3, 7, 2, 8, 1, 9, 0, 10]);
    expect(snapshots[0].branches[0].points.map(point => point.index)).toEqual([5]);
    expect(snapshots[1].branches[0].points.map(point => point.index)).toEqual([4, 5]);
    expect(snapshots[2].branches[0].points.map(point => point.index)).toEqual([4, 5, 6]);
    expect(withoutTime(assembled!)).toEqual(withoutTime(step.value.result));
    expect(withoutTime(assembled!)).toEqual(withoutTime(sweep(config)));
    expect(update(step.value.result, step.value.completed).branches).toEqual([]);
  });

  it('preserves multi-root gaps and failed Y expressions in accumulated previews', () => {
    const config = configuration(.5, -1, 1, .25);
    config.equations = 'y^2 = x^2 - 0.1;';
    config.variables[0] = { name: 'y', kind: 'unknown', value: .8, min: -5, max: 5 };
    config.axes.y = 'sqrt(x), y';
    const steps = sweepSteps(config, 0), update = createSweepUpdates();
    let assembled: SweepResult | null = null, step = steps.next();
    while (true) {
      assembled = mergeSweepUpdate(assembled, update(step.value.result, step.value.completed));
      if (step.done) break;
      step = steps.next();
    }
    expect(withoutTime(assembled!)).toEqual(withoutTime(step.value.result));
    expect(withoutTime(assembled!)).toEqual(withoutTime(sweep(config)));
    expect(assembled!.failures.some(failure => failure.reason.includes('Y expression'))).toBe(true);
    expect(assembled!.branches.flatMap(branch => branch.points).some(point => point.ys[0] === null)).toBe(true);
    for (const branch of assembled!.branches) {
      expect(branch.points.every(point => point.parameter < 0) || branch.points.every(point => point.parameter > 0)).toBe(true);
      for (let i = 1; i < branch.points.length; i++) expect(branch.points[i].index - branch.points[i - 1].index).toBe(1);
    }
  });
});
