import { describe, expect, it } from 'vitest';
import { clone, starter, validateImport } from '../examples';
import { deleteVariable, reconcileSweep, sliceSweeps, toggleParameterSweep, updateVariable, usedVariables } from './variables';

function configured() {
  const config = clone(starter);
  config.sweep.secondary = { parameter: 'a', min: -2, max: 2, points: 5, logarithmic: false };
  return config;
}

describe('secondary sweep variable selections', () => {
  it('tracks a renamed secondary parameter', () => {
    const config = configured();
    updateVariable(config, config.variables.findIndex(variable => variable.name === 'a'), { name: 'gain' });
    expect(config.sweep.secondary!.parameter).toBe('gain');
  });

  it('tracks renames and clears deleted or reclassified selections across all dimensions', () => {
    const config = configured(); toggleParameterSweep(config, 'b', true);
    config.variables.push({ name: 'c', kind: 'parameter', value: 0, min: -1, max: 1, step: 1 });
    toggleParameterSweep(config, 'c', true);
    updateVariable(config, config.variables.findIndex(variable => variable.name === 'b'), { name: 'offset' });
    expect(sliceSweeps(config).map(dimension => dimension.parameter)).toEqual(['a', 'offset', 'c']);
    deleteVariable(config, config.variables.findIndex(variable => variable.name === 'offset'));
    updateVariable(config, config.variables.findIndex(variable => variable.name === 'c'), { kind: 'unknown' });
    expect(sliceSweeps(config).map(dimension => dimension.parameter)).toEqual(['a', '', '']);
    expect(config.sweep.parameter).toBe('x');
  });

  it('clears a deleted or reclassified secondary parameter without replacing it', () => {
    const removed = configured();
    deleteVariable(removed, removed.variables.findIndex(variable => variable.name === 'a'));
    expect(removed.sweep.secondary!.parameter).toBe('');
    const changed = configured();
    updateVariable(changed, changed.variables.findIndex(variable => variable.name === 'a'), { kind: 'unknown' });
    expect(changed.sweep.secondary!.parameter).toBe('');
    expect(changed.sweep.secondary!.points).toBe(5);
  });

  it('clears the secondary choice if it becomes the primary or released parameter', () => {
    const config = configured();
    config.sweep.parameter = 'a'; reconcileSweep(config);
    expect(config.sweep.secondary!.parameter).toBe('');
    config.sweep.mode = 'constrained'; config.sweep.parameter = 'y'; config.sweep.release = 'a'; config.sweep.secondary!.parameter = 'a';
    reconcileSweep(config);
    expect(config.sweep.secondary!.parameter).toBe('');
    config.sweep.secondary!.parameter = 'b'; reconcileSweep(config);
    expect(config.sweep.secondary!.parameter).toBe('b');
  });

  it('does not auto-select another variable when the second choice is missing', () => {
    const config = configured();
    config.sweep.secondary!.parameter = 'missing';
    config.variables = config.variables.filter(variable => variable.name !== 'b');
    reconcileSweep(config);
    expect(config.sweep.secondary!.parameter).toBe('');
  });

  it('retains a selected secondary parameter even when no expression references it', () => {
    const config = configured(); config.equations = 'y = x;';
    expect(usedVariables(config).has('a')).toBe(true);
    config.sweep.secondary!.parameter = '';
    expect(usedVariables(config).has('a')).toBe(false);
    expect(usedVariables(config).has('')).toBe(false);
  });

  it('clears extra dimensions that conflict with the main, released, or another selected parameter', () => {
    const config = configured(); toggleParameterSweep(config, 'b', true);
    config.sweep.additional!.push({ ...config.sweep.secondary! });
    reconcileSweep(config);
    expect(sliceSweeps(config).map(dimension => dimension.parameter)).toEqual(['a', 'b', '']);
    config.sweep.parameter = 'b'; reconcileSweep(config);
    expect(sliceSweeps(config).map(dimension => dimension.parameter)).toEqual(['a', '', '']);
    Object.assign(config.sweep, { mode: 'constrained', parameter: 'y', release: 'a' });
    reconcileSweep(config);
    expect(sliceSweeps(config).every(dimension => dimension.parameter === '')).toBe(true);
  });

  it('keeps parameters used only by later slice dimensions active', () => {
    const config = configured(); config.equations = 'y = x;'; toggleParameterSweep(config, 'b', true);
    expect(usedVariables(config).has('b')).toBe(true);
    toggleParameterSweep(config, 'b', false);
    expect(usedVariables(config).has('b')).toBe(false);
  });
});

describe('secondary sweep imports', () => {
  it('round-trips settings and permits a not-yet-selected parameter', () => {
    const config = configured();
    expect(validateImport(JSON.parse(JSON.stringify(config))).sweep.secondary).toEqual(config.sweep.secondary);
    config.sweep.secondary!.parameter = '';
    expect(validateImport(config).sweep.secondary!.parameter).toBe('');
    expect(validateImport(clone(starter)).sweep.secondary).toBeUndefined();
  });

  it('round-trips any number of extra sweep dimensions and their starting values', () => {
    const config = configured(); toggleParameterSweep(config, 'b', true);
    Object.assign(config.sweep.additional![0], { step: .25, startAt: 0 });
    expect(validateImport(JSON.parse(JSON.stringify(config))).sweep).toEqual(config.sweep);
    const noncanonical = clone(config); delete noncanonical.sweep.secondary;
    expect(validateImport(noncanonical).sweep.additional).toEqual(config.sweep.additional);
  });

  it('rejects malformed settings before JSON cloning can erase non-finite values', () => {
    const invalid = [null, [], 'a', 1, { parameter: 1, min: 0, max: 1, points: 2, logarithmic: false },
      { parameter: 'a', min: 0, max: 1, points: 2 },
      { parameter: 'a', min: 0, max: 1, points: '2', logarithmic: false },
      { parameter: 'a', min: NaN, max: 1, points: 2, logarithmic: false },
      { parameter: 'a', min: 0, max: Infinity, points: 2, logarithmic: false },
      { parameter: 'a', min: 0, max: 1, points: 2, logarithmic: 'false' }];
    for (const secondary of invalid) {
      const config = configured(); Object.assign(config.sweep, { secondary });
      expect(() => validateImport(config)).toThrow('second sweep');
    }
  });

  it('rejects malformed additional dimensions and excessive dimension counts before cloning', () => {
    const valid = configured().sweep.secondary!;
    for (const additional of [null, {}, 'b', [null], [1], [[valid]], [{ ...valid, min: NaN }], [{ ...valid, step: Infinity }], [{ ...valid, startAt: '0' }], Array(1)]) {
      const config = configured(); Object.assign(config.sweep, { additional });
      expect(() => validateImport(config)).toThrow('additional sweep');
    }
    const config = configured(); config.sweep.additional = Array.from({ length: 100 }, () => ({ ...valid }));
    expect(() => validateImport(config)).toThrow('sweep dimensions');
  });
});
