import { describe, expect, it } from 'vitest';
import { clone, starter } from '../examples';
import { projectSweep, solverConfiguration, solveKey, viewConfiguration, viewDimensions } from './projection';
import { sweep } from './solver';
import type { Configuration } from './types';

function model(): Configuration {
  const config = clone(starter);
  config.equations = 'y = sin(x); z = cos(x);';
  config.variables.push({ name: 'z', kind: 'unknown', value: 1 });
  Object.assign(config.sweep, { min: 0, max: 2 * Math.PI, points: 9 });
  config.axes = { x: 'x', y: 'y', curves: [{ x: 'z', y: 'y' }] };
  return config;
}

describe('parametric sweep projection', () => {
  it('keeps a closed loop in parameter order when the displayed X coordinate reverses', () => {
    const config = model(), raw = sweep(solverConfiguration(config));
    const projected = projectSweep(raw, config), points = projected.branches[0].points;
    expect(projected.branches).toHaveLength(1);
    expect(projected.failures).toEqual([]);
    expect(points.map(point => point.parameter)).toEqual(raw.branches[0].points.map(point => point.parameter));
    expect(points.map(point => point.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    for (const point of points) {
      expect(point.x).toBeCloseTo(Math.cos(point.parameter), 12);
      expect(point.y).toBeCloseTo(Math.sin(point.parameter), 12);
      expect(point.xs).toEqual([point.x]); expect(point.ys).toEqual([point.y]);
    }
    expect(points[0].x).toBeCloseTo(1, 12);
    expect(points[4].x).toBeCloseTo(-1, 12);
    expect(points[8].x).toBeCloseTo(1, 12);
    expect(raw.branches[0].points.every(point => point.y === 0)).toBe(true);
  });

  it('projects mixed ordinary and parametric curves from the same retained roots', () => {
    const config = model();
    config.axes = { x: 'x', y: 'y, y, z', curves: [{ x: 'x', y: 'y' }, { x: 'z', y: 'y' }, { x: 'y', y: 'z' }] };
    const raw = sweep(solverConfiguration(config)), projected = projectSweep(raw, config);
    for (const point of projected.branches[0].points) {
      expect(point.xs).toEqual([point.parameter, point.values.z, point.values.y]);
      expect(point.ys).toEqual([point.values.y, point.values.y, point.values.z]);
      expect(point.x).toBe(point.parameter);
    }
    expect(projected.solved).toBe(raw.solved); expect(projected.total).toBe(raw.total);
  });

  it('limits a coordinate domain error to its own curve while retaining every raw sample', () => {
    const config = model(); config.equations = 'y = x; z = x^2;';
    Object.assign(config.sweep, { min: -2, max: 2, points: 5 });
    config.axes = { x: 'x', y: 'y, z, sqrt(y)', curves: [
      { x: 'sqrt(y)', y: 'y' }, { x: 'x', y: 'z' }, { x: 'y', y: 'sqrt(y)' },
    ] };
    const raw = sweep(solverConfiguration(config)), projected = projectSweep(raw, config);
    const negative = projected.branches[0].points.filter(point => point.parameter < 0);
    expect(negative).toHaveLength(2);
    for (const point of negative) {
      expect(point.xs).toEqual([null, point.parameter, point.parameter]);
      expect(point.ys).toEqual([point.parameter, point.parameter ** 2, null]);
      expect(point.x).toBeNaN();
    }
    expect(projected.failures).toHaveLength(4);
    expect(projected.failures.filter(failure => failure.reason.startsWith('X expression'))).toHaveLength(2);
    expect(projected.failures.filter(failure => failure.reason.startsWith('Y expression'))).toHaveLength(2);
    expect(projected.branches[0].points).toHaveLength(5);
    expect(raw.failures).toEqual([]); expect(raw.branches[0].points).toHaveLength(5);
  });

  it('strips displayed curves from numerical configurations and leaves traversal dimensions unchanged', () => {
    const config = model(), raw = solverConfiguration(config), key = solveKey(config);
    expect(raw.axes).toEqual({ x: 'x', y: '0' });
    expect(viewConfiguration(config)).toBe(config);
    expect(viewDimensions(config)).toEqual([]);
    config.axes.curves = [{ x: 'y', y: 'z' }]; config.axes.y = 'z';
    expect(solveKey(config)).toBe(key);
    expect(viewConfiguration(config)).toBe(config);
    expect(viewDimensions(config)).toEqual([]);
  });
});
