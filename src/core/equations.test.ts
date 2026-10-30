import { describe, expect, it } from 'vitest';
import { clone, starter } from '../examples';
import { equationProgram } from './equations';
import { prepare, roots, solve, sweep } from './solver';
import { withPointJacobian } from './pointDiagnostics';
import type { Configuration } from './types';

function model(equations: string, unknowns = ['y']): Configuration {
  const config = clone(starter);
  config.equations = equations;
  config.variables = [...unknowns.map(name => ({ name, kind: 'unknown' as const, value: 1 })), { name: 'p', kind: 'parameter', value: 2 }];
  config.constraints = '';
  config.axes = { x: 'p', y: unknowns[0] ?? 'x' };
  config.sweep = { parameter: 'p', min: 1, max: 3, points: 5, logarithmic: false, mode: 'free', release: '' };
  return config;
}

describe('equations and validity in one editor', () => {
  it('separates predicates while keeping comparisons inside equations', () => {
    const program = equationProgram('y = if(p >= 0, p, -p); y >= 0; (y < 10 && p != 0); !(p < 0); valid if(p > 0, y > 0, true);');
    expect(program.equations).toEqual(['y = if(p >= 0, p, -p)']);
    expect(program.conditions).toEqual(['y >= 0', '(y < 10 && p != 0)', '!(p < 0)', 'if(p > 0, y > 0, true)']);
  });

  it('uses inclusive editor conditions as search bounds and checks other predicates', () => {
    const config = model('y^2 = p; y >= 0; valid y > 1.5;');
    const system = prepare(config, 4);
    expect(system.unknowns[0].min).toBe(0);
    expect(roots(system, config.solver).roots.map(root => root.values.y)).toEqual([expect.closeTo(2, 7)]);
    expect(roots(prepare(config, 1), config.solver).roots).toEqual([]);
  });

  it('supports inferred assignments without a separate unknown declaration', () => {
    const config = model('result = gain * x; x = p^2; gain = 2;', []);
    config.axes.y = 'result, x';
    const system = prepare(config, 3), root = solve(system, [], config.solver);
    expect(system.direct).toBeDefined();
    expect(root.values).toMatchObject({ p: 3, gain: 2, x: 9, result: 18 });
    expect(root.iterations).toBe(0);
    const result = sweep(config);
    expect(result.solved).toBe(5);
    expect(result.branches.flatMap(branch => branch.points).every(point => point.ys[0] === 2 * point.parameter ** 2)).toBe(true);
  });

  it('reports missing inputs rather than inventing right-hand-side declarations', () => {
    const config = model('y = missing + p;');
    expect(() => prepare(config)).toThrow('not defined');
    config.equations = 'pi = p;'; config.axes.y = 'pi';
    expect(() => prepare(config)).toThrow('reserved');
  });

  it('retains domain errors as sample gaps for inferred assignments', () => {
    const config = model('x = 1/p;', []);
    config.sweep = { ...config.sweep, min: -1, max: 1, points: 5 };
    expect(() => prepare(config, 0)).not.toThrow();
    expect(roots(prepare(config, 0), config.solver).error).toContain('Non-finite');
    const result = sweep(config);
    expect(result.solved).toBe(4); expect(result.failures).toHaveLength(1);
  });
});

describe('partial assignment elimination', () => {
  it('substitutes an inferred assignment into an implicit equation and reconstructs all roots', () => {
    const config = model('x = 2*y; y^2 + x^2 = p^2;');
    config.axes.y = 'x, y';
    const system = prepare(config, 2);
    expect(system.direct).toBeUndefined();
    expect(system.unknowns.map(variable => variable.name)).toEqual(['y']);
    expect(system.equations).toEqual(['y^2 + x^2 = p^2']);
    const found = roots(system, { ...config.solver, starts: 16 }).roots;
    expect(found).toHaveLength(2);
    for (const root of found) {
      expect(Math.abs(root.values.y)).toBeCloseTo(2 / Math.sqrt(5), 7);
      expect(root.values.x).toBe(2 * root.values.y);
      expect(root.residuals).toHaveLength(1); expect(root.jacobian).toHaveLength(1);
      expect(root.jacobian[0][0]).toBeCloseTo(10 * root.values.y, 6);
    }
  });

  it('also eliminates declared unknown assignments and accepts their original guess vector', () => {
    const config = model('x = 2*y; y^2 + x^2 = p^2;', ['x', 'y']);
    const system = prepare(config, 2), root = solve(system, [100, 1], config.solver);
    expect(system.unknowns.map(variable => variable.name)).toEqual(['y']);
    expect(root.values.y).toBeCloseTo(2 / Math.sqrt(5), 7);
    expect(root.values.x).toBe(2 * root.values.y);
  });

  it('reconstructs chains containing fixed-only calculations and legacy derived variables', () => {
    const config = model('constant = p + 2; x = gain*y; y^2 + x^2 = constant;');
    config.variables.push({ name: 'gain', kind: 'derived', value: 0, expression: 'constant/2' });
    const system = prepare(config, 2), root = solve(system, [1], config.solver);
    expect(system.unknowns.map(variable => variable.name)).toEqual(['y']);
    expect(root.values.constant).toBe(4); expect(root.values.gain).toBe(2);
    expect(root.values.y).toBeCloseTo(2 / Math.sqrt(5), 7);
    expect(system.evaluate([2]).values).toMatchObject({ p: 2, constant: 4, gain: 2, y: 2, x: 4 });
  });

  it('enforces bounds on assigned variables', () => {
    const config = model('x = 2*y; y^2 + x^2 = p^2; x >= 0; x <= 1;');
    let found = roots(prepare(config, 2), config.solver);
    expect(found.roots).toEqual([]); expect(found.error).toContain('configured bounds');
    found = roots(prepare(config, 1), config.solver);
    expect(found.roots).toHaveLength(1); expect(found.roots[0].values.x).toBeCloseTo(2 / Math.sqrt(5), 7);
  });

  it('preserves roots on an inclusive bound of an assigned variable', () => {
    const config = model('x = 2*y; y^2 + x^2 = p^2; x >= 0; x <= 1;');
    const found = roots(prepare(config, Math.sqrt(1.25)), config.solver);
    expect(found.roots).toHaveLength(1);
    expect(found.roots[0].values.x).toBeCloseTo(1, 8);
  });

  it('checks compound validity on reconstructed variables', () => {
    const config = model('x = 2*y; y^2 + x^2 = p^2; valid abs(x) < 1;');
    const system = prepare(config, 2);
    expect(system.unknowns.map(variable => variable.name)).toEqual(['y']);
    const found = roots(system, config.solver);
    expect(found.roots).toEqual([]); expect(found.error).toContain('validity');
  });

  it('solves independent linear cycles and duplicate left-hand definitions directly', () => {
    let config = model('x = y + 1; y = 2*x;', []); config.axes.y = 'x';
    let system = prepare(config);
    expect(system.unknowns.map(variable => variable.name)).toEqual(['x', 'y']);
    expect(system.direct).toBeDefined();
    expect(solve(system, [1, 1], config.solver).values.x).toBeCloseTo(-1, 7);
    config = model('x = y + 1; x = 2*y;', ['x', 'y']);
    system = prepare(config);
    expect(system.unknowns).toHaveLength(2); expect(system.equations).toHaveLength(2);
    expect(solve(system, [1, 1], config.solver).values).toMatchObject({ x: expect.closeTo(2, 7), y: expect.closeTo(1, 7) });
  });

  it('does not eliminate a variable through a cycle containing a legacy derived definition', () => {
    const config = model('y = helper;');
    config.variables.push({ name: 'helper', kind: 'derived', value: 0, expression: '2*y + 1' });
    const system = prepare(config);
    expect(system.unknowns.map(variable => variable.name)).toEqual(['y']);
    expect(system.direct).toBeUndefined();
    expect(solve(system, [1], config.solver).values.y).toBeCloseTo(-1, 7);
  });

  it('computes an inspected point Jacobian for the reduced numerical system', () => {
    const config = model('x = 2*y; y^2 + x^2 = p^2; y >= 0;'); config.axes.y = 'x, y';
    const result = sweep(config), point = result.branches.flatMap(branch => branch.points).find(point => point.parameter === 2)!;
    expect(result.unknowns).toEqual(['y']); expect(result.equations).toHaveLength(1);
    const inspected = withPointJacobian(config, point);
    expect(inspected.jacobian).toHaveLength(1); expect(inspected.jacobian[0][0]).toBeCloseTo(10 * point.values.y, 6);
    expect(point.jacobian).toEqual([]);
  });
});
