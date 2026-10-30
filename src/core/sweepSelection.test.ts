import { describe, expect, it } from 'vitest';
import { clone, starter } from '../examples';
import { parameterSweepRole, reconcileSweep, sliceSweeps, toggleParameterSweep } from './variables';

describe('parameter sweep checkboxes', () => {
  it('adds a second parameter using its slider range without changing the main sweep or axes', () => {
    const config = clone(starter), sweep = { ...config.sweep }, axes = { ...config.axes };
    toggleParameterSweep(config, 'a', true);
    expect(parameterSweepRole(config, 'x')).toBe('primary');
    expect(parameterSweepRole(config, 'a')).toBe('secondary');
    expect(config.sweep.secondary).toEqual({ parameter: 'a', min: -5, max: 5, points: 11, logarithmic: false });
    const { secondary: _secondary, ...main } = config.sweep;
    expect(main).toEqual(sweep); expect(config.axes).toEqual(axes);
  });

  it('uses value-based defaults when a slider has no explicit range', () => {
    const config = clone(starter), a = config.variables.find(variable => variable.name === 'a')!;
    delete a.min; delete a.max; a.value = 8;
    toggleParameterSweep(config, 'a', true);
    expect(config.sweep.secondary).toMatchObject({ min: 0, max: 16 });
  });

  it('allows a new main choice when none is selected, preserving its point count', () => {
    const config = clone(starter); config.sweep.parameter = ''; config.sweep.points = 53; config.sweep.logarithmic = true;
    toggleParameterSweep(config, 'a', true);
    expect(config.sweep).toMatchObject({ parameter: 'a', min: -5, max: 5, points: 53, logarithmic: false });
    expect(config.sweep.secondary).toBeUndefined();
  });

  it('adds more sweep dimensions while repeated checks preserve each selection', () => {
    const config = clone(starter); toggleParameterSweep(config, 'a', true);
    config.sweep.secondary!.points = 7;
    toggleParameterSweep(config, 'b', true); toggleParameterSweep(config, 'a', true); toggleParameterSweep(config, 'x', true);
    expect(config.sweep.parameter).toBe('x');
    expect(config.sweep.secondary).toMatchObject({ parameter: 'a', points: 7 });
    expect(config.sweep.additional).toEqual([{ parameter: 'b', min: -5, max: 5, points: 11, logarithmic: false }]);
    expect(parameterSweepRole(config, 'b')).toBe('secondary');
    toggleParameterSweep(config, 'a', false);
    expect(config.sweep.secondary?.parameter).toBe('b');
    expect(config.sweep.additional).toBeUndefined();
  });

  it('removes secondary selection and preserves the final required main choice', () => {
    const config = clone(starter); toggleParameterSweep(config, 'a', true);
    toggleParameterSweep(config, 'a', false);
    expect(config.sweep.secondary).toBeUndefined(); expect(parameterSweepRole(config, 'x')).toBe('primary');
    toggleParameterSweep(config, 'x', false);
    expect(config.sweep.parameter).toBe('x');
  });

  it('promotes the secondary parameter with all its sampling settings when main is unchecked', () => {
    const config = clone(starter), axes = clone(config.axes);
    config.sweep.secondary = { parameter: 'a', min: .1, max: 10, points: 9, logarithmic: true };
    toggleParameterSweep(config, 'x', false); reconcileSweep(config);
    expect(config.sweep).toMatchObject({ parameter: 'a', min: .1, max: 10, points: 9, logarithmic: true });
    expect(config.sweep.secondary).toBeUndefined(); expect(parameterSweepRole(config, 'a')).toBe('primary');
    expect(config.axes).toEqual(axes);
  });

  it('preserves remaining dimensions when promoting or removing an extra selection', () => {
    const config = clone(starter); toggleParameterSweep(config, 'a', true); toggleParameterSweep(config, 'b', true);
    config.variables.push({ name: 'c', kind: 'parameter', value: 3, min: 1, max: 5, step: 1 });
    toggleParameterSweep(config, 'c', true);
    toggleParameterSweep(config, 'b', false);
    expect(sliceSweeps(config).map(dimension => dimension.parameter)).toEqual(['a', 'c']);
    toggleParameterSweep(config, 'x', false);
    expect(config.sweep.parameter).toBe('a');
    expect(sliceSweeps(config).map(dimension => dimension.parameter)).toEqual(['c']);
    expect(parameterSweepRole(config, 'x')).toBeNull();
    expect(parameterSweepRole(config, 'a')).toBe('primary');
    expect(parameterSweepRole(config, 'c')).toBe('secondary');
  });

  it('rejects unknowns, derived variables, and missing definitions as parameter choices', () => {
    const config = clone(starter); config.variables.push({ name: 'derived', kind: 'derived', value: 0, expression: 'a + 1' });
    for (const name of ['y', 'derived', 'missing']) {
      toggleParameterSweep(config, name, true); expect(parameterSweepRole(config, name)).toBeNull();
    }
    expect(config.sweep.secondary).toBeUndefined(); expect(config.sweep.parameter).toBe('x');
  });

  it('supports multiple extra parameters in constrained mode without selecting the released parameter', () => {
    const config = clone(starter);
    Object.assign(config.sweep, { mode: 'constrained', parameter: 'y', release: 'a' });
    toggleParameterSweep(config, 'a', true); expect(config.sweep.secondary).toBeUndefined();
    toggleParameterSweep(config, 'x', true); expect(parameterSweepRole(config, 'x')).toBe('secondary');
    toggleParameterSweep(config, 'b', true); expect(sliceSweeps(config).map(dimension => dimension.parameter)).toEqual(['x', 'b']);
    toggleParameterSweep(config, 'x', false);
    expect(config.sweep.secondary?.parameter).toBe('b'); expect(config.sweep.parameter).toBe('y'); expect(config.sweep.release).toBe('a');
    toggleParameterSweep(config, 'b', false);
    expect(sliceSweeps(config)).toEqual([]);
  });
});
