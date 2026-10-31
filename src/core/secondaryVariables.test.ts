import { describe, expect, it } from 'vitest';
import { clone, starter } from '../examples';
import { compileDocuments } from './documents';
import { reconcileSweep, setSliceSweeps, sliceSweeps, usedVariables } from './variables';

function configured() {
  const config = clone(starter);
  config.sweep.secondary = { parameter: 'a', min: -2, max: 2, points: 5, logarithmic: false };
  return config;
}

describe('secondary sweep variable selections', () => {
  it('selects a renamed parameter from its edited source declaration', () => {
    const config = compileDocuments(clone(starter), [{ id: 'model', title: 'Model', source: 'unknown y\nparameter x 0 1 -2 2 sweep\nparameter a 1 1 0 2 sweep\ny = a*x;\nset_time_axis x\nplot y' }]);
    const edited = compileDocuments(config, [{ ...config.documents![0], source: config.documents![0].source.replace(/\ba\b/g, 'gain') }]);
    expect(sliceSweeps(edited).map(dimension => dimension.parameter)).toEqual(['gain']);
    expect(edited.variables.some(variable => variable.name === 'a')).toBe(false);
  });

  it('clears deleted or reclassified selections across all dimensions', () => {
    const config = configured();
    setSliceSweeps(config, [...sliceSweeps(config), { parameter: 'b', min: -5, max: 5, points: 101, logarithmic: false }]);
    config.variables.push({ name: 'c', kind: 'parameter', value: 0, min: -1, max: 1, step: 1 });
    setSliceSweeps(config, [...sliceSweeps(config), { parameter: 'c', min: -1, max: 1, points: 3, logarithmic: false }]);
    config.variables = config.variables.filter(variable => variable.name !== 'b');
    config.variables.find(variable => variable.name === 'c')!.kind = 'unknown';
    reconcileSweep(config);
    expect(sliceSweeps(config).map(dimension => dimension.parameter)).toEqual(['a', '', '']);
    expect(config.sweep.parameter).toBe('x');
  });

  it('clears a deleted or reclassified secondary parameter without replacing it', () => {
    const removed = configured();
    removed.variables = removed.variables.filter(variable => variable.name !== 'a'); reconcileSweep(removed);
    expect(removed.sweep.secondary!.parameter).toBe('');
    const changed = configured();
    changed.variables.find(variable => variable.name === 'a')!.kind = 'unknown'; reconcileSweep(changed);
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
    const config = configured();
    setSliceSweeps(config, [...sliceSweeps(config), { parameter: 'b', min: -5, max: 5, points: 101, logarithmic: false }]);
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
    const config = configured(); config.equations = 'y = x;';
    setSliceSweeps(config, [...sliceSweeps(config), { parameter: 'b', min: -5, max: 5, points: 101, logarithmic: false }]);
    expect(usedVariables(config).has('b')).toBe(true);
    setSliceSweeps(config, sliceSweeps(config).filter(dimension => dimension.parameter !== 'b'));
    expect(usedVariables(config).has('b')).toBe(false);
  });
});
