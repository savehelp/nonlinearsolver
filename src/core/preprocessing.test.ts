import { describe, expect, it } from 'vitest';
import { clone, starter } from '../examples';
import { prepare, roots, solve } from './solver';
import type { Configuration } from './types';

function model(equations: string, names: string[]): Configuration {
  const config = clone(starter);
  config.equations = equations;
  config.constraints = '';
  config.variables = [...names.map(name => ({ name, kind: 'unknown' as const, value: 1 })), { name: 'p', kind: 'parameter', value: .5 }];
  config.axes = { x: 'p', y: names.join(', ') };
  config.sweep = { parameter: 'p', min: 0, max: 1, points: 3, logarithmic: false, mode: 'free', release: '' };
  config.solver.starts = 24;
  return config;
}

describe('sine solution multiplicity', () => {
  it('reports a free sine argument as underdetermined', () => {
    const config = model('z = sin(y);', ['y', 'z']);
    expect(() => prepare(config)).toThrow('Underdetermined');
  });

  it('keeps distinct arguments with the same sine output as distinct roots', () => {
    const config = model('z = sin(y); z = p;', ['y', 'z']);
    const found = roots(prepare(config, .5), config.solver).roots;
    expect(found.length).toBeGreaterThanOrEqual(2);
    for (const root of found) {
      expect(root.values.z).toBeCloseTo(.5, 7);
      expect(Math.sin(root.values.y)).toBeCloseTo(.5, 7);
    }
    const argumentsFound = found.map(root => root.values.y);
    expect(Math.max(...argumentsFound) - Math.min(...argumentsFound)).toBeGreaterThan(1);
  });

  it('restricts sine roots to the selected monotone interval', () => {
    const config = model('z = sin(y); z = p; y >= -pi/2; y <= pi/2;', ['y', 'z']);
    const found = roots(prepare(config, .5), config.solver).roots;
    expect(found).toHaveLength(1);
    expect(found[0].values.y).toBeCloseTo(Math.PI / 6, 7);
    expect(found[0].values.z).toBeCloseTo(.5, 7);
  });

  it('evaluates sine directly when another assignment fixes its argument', () => {
    const config = model('z = sin(y); y = p;', ['y', 'z']);
    const system = prepare(config, .5), root = solve(system, [], config.solver);
    expect(system.direct).toBeDefined();
    expect(root.iterations).toBe(0);
    expect(root.values.y).toBe(.5);
    expect(root.values.z).toBe(Math.sin(.5));
  });

  it('does not infer periodic copies for y + sin(y) = p', () => {
    const config = model('y = p - sin(y);', ['y']);
    const found = roots(prepare(config, 1), config.solver).roots;
    expect(found).toHaveLength(1);
    expect(found[0].values.y + Math.sin(found[0].values.y)).toBeCloseTo(1, 7);
  });
});

describe('affine preprocessing integration', () => {
  it('isolates a scaled unknown and evaluates its unique root without Newton', () => {
    const config = model('2*x = p;', ['x']);
    const system = prepare(config, 3), root = solve(system, [100], config.solver);
    expect(system.direct).toBeDefined();
    expect(root.values.x).toBe(1.5);
    expect(root.iterations).toBe(0);
    expect(root.residuals).toEqual([0]);
    expect(root.jacobian[0][0]).toBeCloseTo(2, 7);
  });

  it('resolves a cyclic linear system and reconstructs each named output', () => {
    const config = model('y = 2*x; z = 2*x; x = y + z + p;', ['x', 'y', 'z']);
    const system = prepare(config, 3), root = solve(system, [100, 100, 100], config.solver);
    expect(system.direct).toBeDefined();
    expect(root.iterations).toBe(0);
    expect(root.values).toMatchObject({ x: -1, y: -2, z: -2 });
    expect(root.residuals.every(value => Math.abs(value) < 1e-12)).toBe(true);
    expect(root.jacobian).toHaveLength(3);
  });

  it('isolates x from an equation with nonlinear y and keeps all remaining roots', () => {
    const config = model('y = x - sin(y); x^2 + y^2 = p^2;', ['x', 'y']);
    const system = prepare(config, 2), found = roots(system, config.solver).roots;
    expect(system.unknowns.map(variable => variable.name)).toEqual(['y']);
    expect(found).toHaveLength(2);
    for (const root of found) {
      expect(root.values.x).toBeCloseTo(root.values.y + Math.sin(root.values.y), 7);
      expect(root.values.x ** 2 + root.values.y ** 2).toBeCloseTo(4, 7);
    }
  });

  it('falls back when a parameter coefficient becomes zero', () => {
    const config = model('p*x = 1;', ['x']);
    expect(roots(prepare(config, 0), config.solver).roots).toEqual([]);
    const system = prepare(config, 2), root = solve(system, [100], config.solver);
    expect(system.direct).toBeDefined();
    expect(root.values.x).toBe(.5);
  });

  it('does not turn a zero-coefficient identity into a unique solution', () => {
    const config = model('p*x = 0;', ['x']);
    const system = prepare(config, 0), found = roots(system, config.solver).roots;
    expect(system.direct).toBeUndefined();
    expect(found.length).toBeGreaterThan(1);
    expect(found.every(root => root.residuals[0] === 0)).toBe(true);
  });

  it('preserves undefined original denominators', () => {
    const config = model('x / p = 1;', ['x']);
    const found = roots(prepare(config, 0), config.solver);
    expect(found.roots).toEqual([]);
    expect(found.error).toContain('Non-finite');
  });

  it('keeps both nonlinear branches when an apparent coefficient is an unknown', () => {
    const config = model('x*y = 0; y^2 = 1;', ['x', 'y']);
    const found = roots(prepare(config), config.solver).roots;
    expect(found).toHaveLength(2);
    expect(found.map(root => Math.round(root.values.y)).sort()).toEqual([-1, 1]);
    for (const root of found) expect(root.values.x).toBeCloseTo(0, 7);
  });

  it('does not evaluate an inactive piecewise domain during preprocessing', () => {
    const config = model('if(p == 0, x, x/p) = 1;', ['x']);
    const found = roots(prepare(config, 0), config.solver).roots;
    expect(found).toHaveLength(1);
    expect(found[0].values.x).toBeCloseTo(1, 7);
  });

  it('solves for a released parameter in a constrained sweep', () => {
    const config = model('2*x = p;', ['x']);
    Object.assign(config.sweep, { mode: 'constrained', parameter: 'x', release: 'p' });
    const system = prepare(config, 3), root = solve(system, [100], config.solver);
    expect(system.unknowns.map(variable => variable.name)).toEqual(['p']);
    expect(system.direct).toBeDefined();
    expect(root.values).toMatchObject({ x: 3, p: 6 });
    expect(root.iterations).toBe(0);
    expect(root.jacobian[0][0]).toBeCloseTo(-1, 7);
  });

  it('respects released-parameter bounds when the affine solution is outside them', () => {
    const config = model('2*x = p;', ['x']);
    Object.assign(config.sweep, { mode: 'constrained', parameter: 'x', release: 'p' });
    Object.assign(config.variables.find(variable => variable.name === 'p')!, { min: 0, max: 10 });
    const system = prepare(config, 10), found = roots(system, config.solver);
    expect(system.direct).toBeUndefined();
    expect(found.roots).toEqual([]);
    expect(found.error).toContain('configured bounds');
  });

  it('keeps a bounded unknown numerical while reconstructing its affine dependent', () => {
    const config = model('2*x = y; y^2 = p^2; x >= 0; x <= 1;', ['x', 'y']);
    const system = prepare(config, 2), found = roots(system, config.solver).roots;
    expect(system.unknowns.map(variable => variable.name)).toEqual(['x']);
    expect(found).toHaveLength(1);
    expect(found[0].values.x).toBe(1);
    expect(found[0].values.y).toBe(2);
    expect(roots(prepare(config, 3), config.solver).roots).toEqual([]);
  });

  it('reconstructs a chain of scaled equations in reverse elimination order', () => {
    const config = model('2*a = b; 3*b = c; 4*c = d; 5*d = x; x^2 = p^2;', ['a', 'b', 'c', 'd', 'x']);
    const system = prepare(config, 2), found = roots(system, config.solver).roots;
    expect(system.unknowns.map(variable => variable.name)).toEqual(['x']);
    expect(found).toHaveLength(2);
    for (const root of found) {
      expect(root.values.d).toBeCloseTo(root.values.x / 5, 10);
      expect(root.values.c).toBeCloseTo(root.values.x / 20, 10);
      expect(root.values.b).toBeCloseTo(root.values.x / 60, 10);
      expect(root.values.a).toBeCloseTo(root.values.x / 120, 10);
    }
  });

  it('preserves an existing assignment plan when it handles a reordered long chain', () => {
    const config = model('d = 5*c; c = 4*b; b = 3*a; a = 2*x; x^2 = p^2;', ['a', 'b', 'c', 'd', 'x']);
    const system = prepare(config, 2), found = roots(system, config.solver).roots;
    expect(system.unknowns.map(variable => variable.name)).toEqual(['x']);
    expect(found).toHaveLength(2);
    for (const root of found) expect(root.values.d).toBeCloseTo(120 * root.values.x, 10);
  });

  it('does not accept inconsistent duplicate affine definitions', () => {
    const config = model('2*x = 1; 2*x = 2;', ['x', 'y']);
    const system = prepare(config), found = roots(system, config.solver);
    expect(system.direct).toBeUndefined();
    expect(found.roots).toEqual([]);
  });

  it('does not claim uniqueness for redundant equations with a free unknown', () => {
    const config = model('2*x = 1; 4*x = 2;', ['x', 'y']);
    const system = prepare(config), found = roots(system, config.solver).roots;
    expect(system.direct).toBeUndefined();
    expect(found.length).toBeGreaterThan(1);
    for (const root of found) expect(root.values.x).toBe(.5);
    expect(new Set(found.map(root => root.values.y)).size).toBeGreaterThan(1);
  });

  it('does not divide by a coefficient that cancels to zero in floating point', () => {
    const config = model('(1e16 + 1)*x - 1e16*x = p;', ['x']);
    const system = prepare(config, 1);
    expect(system.direct).toBeUndefined();
    expect(roots(system, config.solver).roots).toEqual([]);
  });

  it('rejects a rounded affine root that fails the original equation', () => {
    const config = model('(1e16*x + 1) - 1e16*x = x;', ['x']);
    const system = prepare(config);
    expect(system.direct).toBeUndefined();
    const found = roots(system, config.solver).roots;
    for (const root of found) expect(Math.abs((1e16 * root.values.x + 1) - 1e16 * root.values.x - root.values.x)).toBeLessThanOrEqual(config.solver.tolerance);
  });

  it('does not accept an inaccurate direct root through an overflowing error scale', () => {
    const config = model('1e308*(x+y) = 1; x-y = 20;', ['x', 'y']);
    expect(prepare(config).direct).toBeUndefined();
  });

  it('keeps extreme mixed coefficients on the original numerical path', () => {
    const config = model('1e308*(x+y) = 0; y^2 = 100;', ['x', 'y']);
    config.variables.find(variable => variable.name === 'x')!.value = -10;
    config.variables.find(variable => variable.name === 'y')!.value = 10;
    const system = prepare(config), root = solve(system, [-10, 10], config.solver, false);
    expect(system.unknowns.map(variable => variable.name)).toEqual(['x', 'y']);
    expect(root.values).toMatchObject({ x: -10, y: 10 });
    expect(root.residuals).toEqual([0, 0]);
    expect(root.iterations).toBe(0);
  });
});
