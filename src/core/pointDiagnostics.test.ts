import { describe, expect, it } from 'vitest';
import { clone, starter } from '../examples';
import type { Point } from './types';
import { withPointJacobian } from './pointDiagnostics';
import { sweep } from './solver';

describe('point inspection diagnostics', () => {
  it('uses the inspected sample instead of the configured start without mutating stored data', () => {
    const config = clone(starter);
    config.equations = 'y = x*z; z = x^2;';
    config.variables = [{ name: 'y', kind: 'unknown', value: 1 }, { name: 'z', kind: 'unknown', value: 1 }, { name: 'x', kind: 'parameter', value: 0 }];
    const point: Point = { values: { x: 2, y: 8, z: 4 }, residuals: [0, 0], norm: 0, iterations: 0, jacobian: [], region: '',
      parameter: 2, x: 2, y: 8, ys: [8], index: 2, branch: 1 };
    const inspected = withPointJacobian(config, point);
    expect(inspected).not.toBe(point);
    expect(inspected.jacobian[0][0]).toBeCloseTo(1, 8);
    expect(inspected.jacobian[0][1]).toBeCloseTo(-2, 8);
    expect(inspected.jacobian[1][1]).toBeCloseTo(1, 8);
    expect(inspected.diagnosticUnknowns).toEqual(['y', 'z']);
    expect(inspected.diagnosticEquations).toEqual(['y = x*z', 'z = x^2']);
    expect(point.jacobian).toEqual([]);
    expect(point).not.toHaveProperty('diagnosticUnknowns');
    expect(point).not.toHaveProperty('diagnosticEquations');
    expect(inspected.values).toBe(point.values);
    expect(config.variables[2].value).toBe(0);
  });

  it('adds missing labels to existing matrices and rejects incomplete point data', () => {
    const config = clone(starter);
    const point: Point = { values: { x: 0 }, residuals: [0], norm: 0, iterations: 0, jacobian: [], region: '',
      parameter: 0, x: 0, y: 0, ys: [0], index: 0, branch: 1 };
    expect(() => withPointJacobian(config, point)).toThrow('missing values');
    expect(() => withPointJacobian(config, { ...point, jacobian: [[1]] })).toThrow('missing values');
    const complete = { ...point, values: { x: 0, y: 0, a: 1, b: 0 }, jacobian: [[1]] };
    const inspected = withPointJacobian(config, complete);
    expect(inspected).not.toBe(complete);
    expect(inspected.jacobian).toBe(complete.jacobian);
    expect(inspected.diagnosticUnknowns).toEqual(['y']);
    expect(inspected.diagnosticEquations).toEqual(['y = a*x + b']);
    expect(withPointJacobian(config, inspected)).toBe(inspected);
  });

  it('labels the selected point rather than the first sample when pivots change', () => {
    const config = clone(starter);
    config.equations = 'p*x = y; sin(y) = 0;';
    config.variables = [
      { name: 'x', kind: 'unknown', value: 1 }, { name: 'y', kind: 'unknown', value: 1 },
      { name: 'p', kind: 'parameter', value: 0 },
    ];
    config.axes = { x: 'p', y: 'x, y' };
    config.sweep = { parameter: 'p', min: 0, max: 1, points: 3, logarithmic: false, mode: 'free', release: '' };
    const result = sweep(config);
    expect(result.unknowns).toEqual(['x']);
    const point = result.branches.flatMap(branch => branch.points).find(sample => sample.parameter === 1)!;
    expect(point).toBeDefined();
    const inspected = withPointJacobian(config, point);
    expect(inspected.diagnosticUnknowns).toEqual(['y']);
    expect(inspected.diagnosticEquations).toEqual(['sin(y) = 0']);
    expect(inspected.jacobian).toHaveLength(1);
    expect(inspected.jacobian[0][0]).toBeCloseTo(Math.cos(point.values.y), 7);
    expect(inspected.residuals[0]).toBeCloseTo(Math.sin(point.values.y), 10);
    expect(result.branches.flatMap(branch => branch.points).every(sample => !Object.hasOwn(sample, 'diagnosticUnknowns') && !Object.hasOwn(sample, 'diagnosticEquations'))).toBe(true);
    expect(point.jacobian).toEqual([]);
    expect(inspected.values).toBe(point.values);
  });
});
