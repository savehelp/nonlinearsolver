import { describe, expect, it } from 'vitest';
import { clone, starter } from '../examples';
import { parameterSampleCount, parameterSweepPlan, normalizeSweep } from './sweepPlan';
import { formatSampleCount, gridLimitMessage, sampleProduct } from './sweepCounts';
import { multiSweepPlan } from './doubleSweep';
import { toggleParameterSweep } from './variables';
import type { Variable } from './types';

describe('requested sweep counts above allocation limits', () => {
  const variable: Variable = { name: 'VDD', kind: 'parameter', value: 500, min: 0, max: 1000, step: .001 };

  it('counts an oversized centered range and reports an actionable safe step', () => {
    expect(parameterSampleCount(variable)).toBe(1_000_001);
    let message = '';
    try { parameterSweepPlan(variable); } catch (error) { message = (error as Error).message; }
    expect(message).toContain('VDD: requested 1,000,001 sweep samples');
    expect(message).toContain('limit is 50,000 sweep samples');
    const suggestion = /step of at least (\S+)/.exec(message);
    expect(suggestion).not.toBeNull();
    expect(parameterSampleCount({ ...variable, step: Number(suggestion![1]) })).toBeLessThanOrEqual(50_000);
    expect(variable.step).toBe(.001);
  });

  it('retains requested counts in settings instead of using zero or a cap sentinel', () => {
    const config = clone(starter);
    Object.assign(config.variables.find(variable => variable.name === 'x')!, { value: 500, min: 0, max: 1000, step: .001 });
    expect(normalizeSweep(config).sweep.points).toBe(1_000_001);
  });

  it('reports the complete grid and every axis rather than the first overflowing prefix', () => {
    const config = clone(starter); toggleParameterSweep(config, 'a', true); toggleParameterSweep(config, 'b', true);
    let message = '';
    try { multiSweepPlan(normalizeSweep(config)); } catch (error) { message = (error as Error).message; }
    expect(message).toContain('requests 1,030,301 samples');
    expect(message).toContain('limit is 250,000 samples');
    for (const name of ['x', 'a', 'b']) expect(message).toContain(`${name}: 101`);
    expect(message).toContain('at most 24 samples');
  });

  it('keeps large multidimensional products exact before allocating plans', () => {
    const config = clone(starter);
    config.variables = [{ name: 'x', kind: 'parameter', value: 0, min: 0, max: 49_999, step: 1 },
      ...Array.from({ length: 4 }, (_, index): Variable => ({ name: `a${index}`, kind: 'parameter', value: 0, min: 0, max: 9_999, step: 1 }))];
    config.sweep.secondary = { parameter: 'a0', min: 0, max: 9_999, points: 10_000, step: 1, startAt: 0, logarithmic: false };
    config.sweep.additional = [1, 2, 3].map(index => ({ ...config.sweep.secondary!, parameter: `a${index}` }));
    expect(() => multiSweepPlan(normalizeSweep(config))).toThrow('500,000,000,000,000,000,000 samples');
  });

  it('distinguishes exact integer products from approximate individual huge counts', () => {
    const product = sampleProduct([50_000, 10_000, 10_000, 10_000, 10_000]);
    expect(product).toBe(500_000_000_000_000_000_000n);
    expect(formatSampleCount(product)).toBe('500,000,000,000,000,000,000');
    expect(formatSampleCount(1e20)).toContain('approximately');
    expect(formatSampleCount(Infinity)).toBe('beyond the finite numeric range');
    expect(gridLimitMessage([{ name: 'x', count: 1000 }, { name: 'a', count: 1000 }], 250_000)).toContain('1,000,000 samples');
  });
});
