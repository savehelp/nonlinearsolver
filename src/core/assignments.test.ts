import { describe, expect, it } from 'vitest';
import { clone, starter } from '../examples';
import resistorNoise from './fixtures/resistor-noise.json';
import { prepare, roots, solve, sweep } from './solver';
import type { Configuration } from './types';

function model(equations: string, unknowns = ['x']): Configuration {
  const config = clone(starter);
  config.equations = equations;
  config.variables = [...unknowns.map(name => ({ name, kind: 'unknown' as const, value: 1 })), { name: 'p', kind: 'parameter', value: 1 }];
  config.axes = { x: 'p', y: unknowns.join(', ') };
  config.sweep = { parameter: 'p', min: 0, max: 2, points: 3, logarithmic: false, mode: 'free', release: '' };
  return config;
}
const noiseModel = (): Configuration => clone(resistorNoise as Configuration);
function relative(actual: number, expected: number) {
  if (expected === 0) expect(actual).toBe(0);
  else expect(Math.abs((actual - expected) / expected)).toBeLessThan(1e-12);
}

describe('complete acyclic assignment systems', () => {
  it('resolves reordered unknown and derived dependencies without using the initial guesses', () => {
    const config = model('y = gain*x; x = input;', ['y', 'x']);
    config.variables.push({ name: 'gain', kind: 'derived', value: 0, expression: 'p + 1' }, { name: 'input', kind: 'derived', value: 0, expression: 'p^2' });
    const system = prepare(config, 3);
    expect(system.direct).toBeDefined();
    const root = solve(system, [-1e100, 1e100], config.solver);
    expect(root.values.y).toBe(36); expect(root.values.x).toBe(9);
    expect(root.values.gain).toBe(4); expect(root.values.input).toBe(9);
    expect(root.iterations).toBe(0); expect(root.residuals).toEqual([0, 0]);
    expect(root.jacobian[0][0]).toBeCloseTo(1); expect(root.jacobian[0][1]).toBeCloseTo(-4);
  });

  it('returns the single assignment root once even with many starts and continuation seeds', () => {
    const config = model('x = p*1e-15;');
    const system = prepare(config, 2), direct = system.direct!;
    let evaluations = 0;
    system.direct = () => { evaluations++; return direct(); };
    const found = roots(system, { ...config.solver, starts: 64 }, [[-1000], [0], [1000]], false);
    expect(found.error).toBe(''); expect(found.roots).toHaveLength(1); expect(evaluations).toBe(1);
    relative(found.roots[0].values.x, 2e-15); expect(found.roots[0].jacobian).toEqual([]);
  });

  it('preserves inclusive bounds and rejects roots outside them rather than clamping', () => {
    const config = model('x = p;'); config.constraints = 'x >= 0\nx <= 2';
    for (const parameter of [0, 2]) expect(solve(prepare(config, parameter), [1], config.solver).values.x).toBe(parameter);
    const invalid = roots(prepare(config, 3), config.solver);
    expect(invalid.roots).toEqual([]); expect(invalid.error).toContain('configured bounds'); expect(invalid.error).toContain('maximum (2)');
    config.constraints = 'x > 0 && x != 1';
    expect(roots(prepare(config, 0), config.solver).roots).toEqual([]);
    expect(roots(prepare(config, 1), config.solver).roots).toEqual([]);
  });

  it('solves linear cycles directly while leaving singular and nonlinear systems numerical', () => {
    let config = model('x = y + 1; y = 2*x;', ['x', 'y']);
    expect(prepare(config).direct).toBeDefined();
    let root = solve(prepare(config), [1, 1], config.solver); expect(root.values.x).toBeCloseTo(-1, 8); expect(root.values.y).toBeCloseTo(-2, 8);
    config = model('x = p; x = 2*p;', ['x', 'y']); expect(prepare(config).direct).toBeUndefined();
    config = model('x = a;'); config.variables.push({ name: 'a', kind: 'derived', value: 0, expression: 'x + 1' });
    expect(prepare(config).direct).toBeUndefined();
    config = model('x^3 - x = 0;'); expect(prepare(config).direct).toBeUndefined();
    const found = roots(prepare(config), { ...config.solver, starts: 24 }).roots;
    expect(found).toHaveLength(3); expect(found.map(candidate => Math.round(candidate.values.x)).sort()).toEqual([-1, 0, 1]);
    root = solve(prepare(config), [1], config.solver); expect(root.jacobian[0][0]).toBeCloseTo(2);
  });

  it('uses the safe expression parser and supports names inherited by ordinary objects', () => {
    const config = model('__proto__ = p + 1; constructor = __proto__*2;', ['__proto__', 'constructor']);
    const root = solve(prepare(config, 2), [0, 0], config.solver);
    expect(root.values.__proto__).toBe(3); expect(root.values.constructor).toBe(6);
    config.equations = '__proto__ = window.alert(1); constructor = 1;'; expect(() => prepare(config)).toThrow();
    config.equations = '__proto__ = constructor(1); constructor = 1;'; expect(() => prepare(config)).toThrow('Unknown function');
  });

  it('retains physical residuals and optional Jacobians on both solver paths', () => {
    for (const equations of ['x = p;', 'x^2 = p + 1;']) {
      const config = model(equations), system = prepare(config);
      const full = solve(system, [1], config.solver);
      const compact = solve(system, [1], config.solver, false);
      expect(full.jacobian).toHaveLength(1); expect(compact.jacobian).toEqual([]);
      expect(compact.residuals).toEqual(full.residuals); expect(compact.norm).toBe(full.norm);
      expect(sweep(config).branches.flatMap(branch => branch.points).every(point => point.jacobian.length === 0)).toBe(true);
    }
  });
});

describe('supplied resistor noise workspace', () => {
  it('computes tiny noise signals accurately with the original all-one initial guesses', () => {
    const config = noiseModel();
    config.variables.find(variable => variable.name === 'R3')!.value = 40;
    config.variables.find(variable => variable.name === 'R4')!.value = 60;
    expect(config.variables.filter(variable => variable.kind === 'unknown').every(variable => variable.value === 1)).toBe(true);
    const found = roots(prepare(config, 50), config.solver);
    expect(found.error).toBe(''); expect(found.roots).toHaveLength(1);
    const root = found.roots[0], thermal = 1.38e-23 * 300 / 1e-8, a = 100, b = 24, sum = a + b;
    relative(root.values.S1, thermal * b * 50 / (a * sum));
    relative(root.values.S2, thermal * b * 50 / (a * sum));
    relative(root.values.S3, thermal * a * b / (sum * 40));
    relative(root.values.S4, thermal * a * b / (sum * 60));
    relative(root.values.Stot, thermal); relative(root.values.S3 / root.values.S4, 1.5);
    expect(root.residuals).toEqual(Array(13).fill(0)); expect(root.norm).toBe(0);
  });

  it('draws all 101 valid samples as one accurate, flat-total curve without false roots', () => {
    const config = noiseModel(), result = sweep(config), thermal = 1.38e-23 * 300 / 1e-8;
    expect(result.solved).toBe(101); expect(result.failures).toEqual([]); expect(result.branches).toHaveLength(1);
    const points = result.branches[0].points; expect(points).toHaveLength(101);
    for (const [index, point] of points.entries()) {
      expect(point.index).toBe(index); expect(point.iterations).toBe(0); expect(point.jacobian).toEqual([]);
      relative(point.values.Stot, thermal); relative(point.values.S3, point.values.S4);
      relative(point.values.S1, thermal * 25 * point.parameter / ((point.parameter + 50) * (point.parameter + 75)));
    }
  });

  it('keeps genuinely undefined zero-resistance combinations as gaps', () => {
    const config = noiseModel(); config.variables.find(variable => variable.name === 'R2')!.value = 0;
    const result = sweep(config);
    expect(result.solved).toBe(100); expect(result.failures).toHaveLength(1); expect(result.failures[0].index).toBe(0);
    expect(result.failures[0].reason).toContain('Non-finite');
    expect(result.branches.flatMap(branch => branch.points).every(point => point.parameter > 0)).toBe(true);
    for (const name of ['R3', 'R4']) {
      const singular = noiseModel(); singular.variables.find(variable => variable.name === name)!.value = 0;
      const found = roots(prepare(singular, 50), singular.solver, [], false);
      expect(found.roots).toEqual([]); expect(found.error).toContain('Non-finite');
    }
  });

  it('breaks the unique assignment branch at an undefined sample', () => {
    const config = model('x = 1/p;'); config.sweep = { ...config.sweep, min: -1, max: 1, points: 5, step: .5, startAt: .5 };
    const result = sweep(config);
    expect(result.solved).toBe(4); expect(result.failures).toHaveLength(1); expect(result.branches).toHaveLength(2);
    for (const branch of result.branches) expect(branch.points.every(point => point.parameter < 0) || branch.points.every(point => point.parameter > 0)).toBe(true);
  });

  it('retains jump gaps for piecewise and step-function assignments', () => {
    for (const expression of ['if(p < 0, 0, 100)', 'p < 0 ? 0 : 100', '100*floor(p)', '100*ceil(p)', '100*sign(p)']) {
      const config = model(`x = ${expression};`); config.sweep = { ...config.sweep, min: -1, max: 1, points: 5 };
      expect(prepare(config).directContinuous).toBe(false);
      const result = sweep(config); expect(result.solved).toBe(5); expect(result.branches.length).toBeGreaterThan(1);
      for (const branch of result.branches) expect(new Set(branch.points.map(point => point.y)).size).toBe(1);
    }
  });
});
