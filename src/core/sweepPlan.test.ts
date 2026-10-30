import { describe, expect, it } from 'vitest';
import { clone, starter, validateImport } from '../examples';
import type { Variable } from './types';
import { migrateParameterSweepSettings, normalizeSweep, parameterSweepPlan } from './sweepPlan';
import { sliceSweeps, toggleParameterSweep } from './variables';
import { MAX_PARAMETER_SAMPLES, MAX_SECONDARY_SLICES } from './sweepLimits';

const parameter = (update: Partial<Variable> = {}): Variable => ({ name: 'VDD', kind: 'parameter', value: 5, min: 0, max: 10, step: 1, ...update });

describe('parameter-driven sweep plans', () => {
  it('starts exactly at the configured value and alternates lower then upper', () => {
    const plan = parameterSweepPlan(parameter());
    expect(plan.values).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(plan.startIndex).toBe(5);
    expect(plan.order.map(index => plan.values[index])).toEqual([5, 4, 6, 3, 7, 2, 8, 1, 9, 0, 10]);
  });

  it('finishes the longer side after reaching one range boundary', () => {
    const plan = parameterSweepPlan(parameter({ value: 2 }));
    expect(plan.order.map(index => plan.values[index])).toEqual([2, 1, 3, 0, 4, 5, 6, 7, 8, 9, 10]);
    const lower = parameterSweepPlan(parameter({ value: 0 }));
    expect(lower.order).toEqual(lower.values.map((_, index) => index));
    const upper = parameterSweepPlan(parameter({ value: 10 }));
    expect(upper.order).toEqual(upper.values.map((_, index) => 10 - index));
  });

  it('anchors off-grid starts exactly rather than moving them to a range grid', () => {
    const plan = parameterSweepPlan(parameter({ value: 5.2 }));
    expect(plan.values).toHaveLength(10);
    expect(plan.values[plan.startIndex]).toBe(5.2);
    expect(plan.order.slice(0, 5).map(index => plan.values[index])).toEqual([5.2, 4.2, 6.2, 3.2, 7.2]);
    expect(plan.values[0]).toBeCloseTo(.2);
    expect(plan.values.at(-1)).toBeCloseTo(9.2);
  });

  it('includes aligned decimal endpoints without leaving the bounds', () => {
    const variable = parameter({ value: .3, min: 0, max: .6, step: .1 });
    const plan = parameterSweepPlan(variable);
    expect(plan.values).toHaveLength(7);
    expect(plan.values[0]).toBe(0);
    expect(plan.values.at(-1)).toBe(.6);
    expect(plan.values.every(value => value >= 0 && value <= .6)).toBe(true);
    expect(plan.values[plan.startIndex]).toBe(.3);
  });

  it('supports one exact sample when the step exceeds the range', () => {
    expect(parameterSweepPlan(parameter({ step: 20 }))).toEqual({ values: [5], order: [0], startIndex: 0 });
  });

  it('handles finite wide ranges without overflowing their differences', () => {
    const plan = parameterSweepPlan(parameter({ value: 1e308, min: -1e308, max: 1e308, step: 1e308 }));
    expect(plan.values).toEqual([-1e308, 0, 1e308]);
    expect(plan.order.map(index => plan.values[index])).toEqual([1e308, 0, -1e308]);
  });

  it('rejects invalid metadata and duplicate floating point samples', () => {
    for (const update of [{ min: undefined }, { max: NaN }, { min: 10 }, { step: undefined }, { step: 0 }, { step: -1 }, { step: Infinity }, { value: -1 }, { value: 11 }, { value: NaN }]) {
      expect(() => parameterSweepPlan(parameter(update))).toThrow('VDD');
    }
    expect(() => parameterSweepPlan(parameter({ min: 1, max: 2, value: 1, step: 1e-20 }))).toThrow('distinct');
  });

  it('rejects excessive sample counts without silently changing the step', () => {
    const variable = parameter({ step: 1e-20 });
    expect(() => parameterSweepPlan(variable)).toThrow();
    expect(variable.step).toBe(1e-20);
    expect(() => parameterSweepPlan(parameter(), 10)).toThrow('10 sweep samples');
    expect(parameterSweepPlan(parameter(), 11).values).toHaveLength(11);
  });

  it('supports the larger limit and rejects one extra sample without coarsening', () => {
    const variable = parameter({ value: 25000, min: 0, max: MAX_PARAMETER_SAMPLES - 1, step: 1 });
    const plan = parameterSweepPlan(variable);
    expect(plan.values).toHaveLength(MAX_PARAMETER_SAMPLES);
    expect(plan.values[0]).toBe(0); expect(plan.values.at(-1)).toBe(MAX_PARAMETER_SAMPLES - 1);
    expect(plan.order.slice(0, 3).map(index => plan.values[index])).toEqual([25000, 24999, 25001]);
    variable.max = MAX_PARAMETER_SAMPLES;
    expect(() => parameterSweepPlan(variable)).toThrow(`${MAX_PARAMETER_SAMPLES.toLocaleString('en-US')} sweep samples`);
    expect(variable.step).toBe(1);
  });
});

describe('sampling normalization and migration', () => {
  it('uses the separate slice limit without silently changing an oversized step', () => {
    const config = clone(starter); toggleParameterSweep(config, 'a', true);
    const variable = config.variables.find(variable => variable.name === 'a')!;
    Object.assign(variable, { min: 0, max: MAX_SECONDARY_SLICES - 1, step: 1, value: 0 });
    expect(normalizeSweep(config).sweep.secondary?.points).toBe(MAX_SECONDARY_SLICES);
    variable.max = MAX_SECONDARY_SLICES;
    const invalid = normalizeSweep(config);
    expect(invalid.sweep.secondary?.points).toBe(MAX_SECONDARY_SLICES + 1);
    expect(invalid.sweep.secondary?.step).toBe(1);
  });
  it('uses Parameters range, step, and starting value for both sweeps', () => {
    const config = clone(starter); toggleParameterSweep(config, 'a', true);
    Object.assign(config.sweep, { min: 100, max: 200, points: 999, logarithmic: true });
    Object.assign(config.sweep.secondary!, { min: 200, max: 300, points: 999, logarithmic: true });
    const before = clone(config), normalized = normalizeSweep(config);
    expect(normalized.sweep).toMatchObject({ min: -5, max: 5, step: .1, startAt: 0, points: 101, logarithmic: false });
    expect(normalized.sweep.secondary).toMatchObject({ parameter: 'a', min: -5, max: 5, step: .1, startAt: 1, points: 101, logarithmic: false });
    expect(config).toEqual(before);
    expect(normalized.variables).toBe(config.variables);
  });

  it('normalizes every dimension from its own Parameters fields without mutating saved settings', () => {
    const config = clone(starter); toggleParameterSweep(config, 'a', true); toggleParameterSweep(config, 'b', true);
    Object.assign(config.variables.find(variable => variable.name === 'b')!, { min: -2, max: 4, step: 2, value: 0 });
    const before = clone(config), normalized = normalizeSweep(config);
    expect(sliceSweeps(normalized)).toHaveLength(2);
    expect(normalized.sweep.additional![0]).toMatchObject({ parameter: 'b', min: -2, max: 4, step: 2, startAt: 0, points: 4 });
    expect(config).toEqual(before);
    expect(normalized.sweep.additional![0]).not.toBe(config.sweep.additional![0]);
    Object.assign(config.variables.find(variable => variable.name === 'b')!, { min: 0, max: MAX_SECONDARY_SLICES, step: 1 });
    expect(normalizeSweep(config).sweep.additional![0]).toMatchObject({ points: MAX_SECONDARY_SLICES + 1, step: 1 });
  });

  it('keeps missing steps invalid and carries the marker to the worker', () => {
    const config = clone(starter); delete config.variables.find(variable => variable.name === 'x')!.step;
    const normalized = normalizeSweep(config);
    expect(Object.hasOwn(normalized.sweep, 'step')).toBe(true);
    expect(normalized.sweep.step).toBeUndefined(); expect(normalized.sweep.points).toBe(0);
    expect(() => parameterSweepPlan(config.variables[1])).toThrow('step size');
  });

  it('preserves legacy constrained main sweep settings while deriving parameter slices', () => {
    const config = clone(starter); Object.assign(config.sweep, { mode: 'constrained', parameter: 'y', release: 'b', step: 1, startAt: 0 });
    toggleParameterSweep(config, 'a', true);
    const normalized = normalizeSweep(config);
    expect(normalized.sweep.points).toBe(config.sweep.points);
    expect(Object.hasOwn(normalized.sweep, 'step')).toBe(false);
    expect(normalized.sweep.secondary?.points).toBe(101);
  });

  it('fills only missing metadata from legacy sweep fields during import', () => {
    const config = clone(starter), x = config.variables.find(variable => variable.name === 'x')!;
    delete x.min; delete x.max; delete x.step;
    Object.assign(config.sweep, { min: -2, max: 2, points: 9 });
    migrateParameterSweepSettings(config);
    expect(x).toMatchObject({ min: -2, max: 2, step: .5, value: 0 });
    x.min = -10; x.max = 10; x.step = 0;
    const imported = validateImport(config);
    expect(imported.variables.find(variable => variable.name === 'x')).toMatchObject({ min: -10, max: 10, step: 0 });
  });

  it('migrates missing parameter metadata separately for every selected dimension', () => {
    const config = clone(starter); toggleParameterSweep(config, 'a', true); toggleParameterSweep(config, 'b', true);
    const b = config.variables.find(variable => variable.name === 'b')!;
    delete b.min; delete b.max; delete b.step;
    Object.assign(config.sweep.additional![0], { min: -1, max: 3, points: 9 });
    const imported = validateImport(config);
    expect(imported.variables.find(variable => variable.name === 'b')).toMatchObject({ min: -1, max: 3, step: .5, value: 0 });
    expect(imported.variables.find(variable => variable.name === 'a')).toEqual(config.variables.find(variable => variable.name === 'a'));
    expect(b.step).toBeUndefined();
  });

  it('clears stale sampling markers when replacing a main selection', () => {
    const config = normalizeSweep(clone(starter));
    config.sweep.secondary = { parameter: 'a', min: -2, max: 2, points: 5, logarithmic: false };
    toggleParameterSweep(config, 'x', false);
    expect(Object.hasOwn(config.sweep, 'step')).toBe(false);
    expect(normalizeSweep(config).sweep).toMatchObject({ parameter: 'a', step: .1, startAt: 1, points: 101 });
  });
});
