import { describe, expect, it } from 'vitest';
import { clone, starter } from '../examples';
import { prepareComplex } from './complexSolver';
import { prepare, roots, solve, variableScale } from './solver';
import type { Configuration } from './types';

function model(equations: string, names = ['z']): Configuration {
  const config = clone(starter);
  config.equations = equations;
  config.variables = [...names.map(name => ({ name, kind: 'unknown' as const, value: 1 })), { name: 'p', kind: 'parameter', value: 0 }];
  config.axes = { x: 'p', y: `imag(${names[0]})` };
  config.sweep = { mode: 'free', parameter: 'p', release: '', min: 0, max: 2, points: 3, logarithmic: false };
  config.solver = { ...config.solver, complex: true, starts: 24 };
  return config;
}

describe('complex equations as real numerical components', () => {
  it('expands one complex unknown and residual into real and imaginary components', () => {
    const system = prepareComplex(model('z^2 + 1 = 0;'));
    expect(system.unknowns.map(variable => variable.name)).toEqual(['real(z)', 'imag(z)']);
    expect(system.equations).toHaveLength(2);
    const state = system.evaluate([1, 2]);
    expect(state.residuals).toEqual([-2, 4]);
    expect(state.complexValues?.z).toEqual({ re: 1, im: 2 });
    expect(state.values).toMatchObject({ p: 0, 'real(z)': 1, 'imag(z)': 2 });
    expect(state.values).not.toHaveProperty('z');
  });

  it('finds and deduplicates the two nonreal roots of z squared plus one', () => {
    const config = model('z^2 + 1 = 0;');
    const found = roots(prepareComplex(config), config.solver).roots;
    expect(found).toHaveLength(2);
    expect(found.map(root => Math.round(root.complexValues!.z.im)).sort()).toEqual([-1, 1]);
    for (const root of found) {
      expect(root.complexValues!.z.re).toBeCloseTo(0, 8);
      expect(Math.abs(root.complexValues!.z.im)).toBeCloseTo(1, 8);
    }
  });

  it('discovers four complex branches with real coefficients', () => {
    const config = model('z^4 + 1 = 0;');
    const found = roots(prepareComplex(config), config.solver).roots;
    expect(found).toHaveLength(4);
    for (const root of found) {
      expect(Math.abs(root.complexValues!.z.re)).toBeCloseTo(Math.SQRT1_2, 7);
      expect(Math.abs(root.complexValues!.z.im)).toBeCloseTo(Math.SQRT1_2, 7);
    }
  });

  it('shares logical scales to discover distinct tiny and large imaginary roots', () => {
    for (const magnitude of [1e-6, 1e6]) {
      const config = model(`z^2 + ${magnitude * magnitude} = 0;`); config.variables[0].value = magnitude;
      const system = prepareComplex(config), found = roots(system, config.solver).roots;
      expect(system.unknowns.map(variableScale)).toEqual([magnitude, magnitude]);
      expect(found).toHaveLength(2);
      for (const root of found) {
        expect(root.complexValues!.z.re / magnitude).toBeCloseTo(0, 8);
        expect(Math.abs(root.complexValues!.z.im) / magnitude).toBeCloseTo(1, 8);
      }
    }
  });

  it('keeps acyclic complex assignment chains direct and parameters real', () => {
    const config = model('z = 1/(1 + i*p); w = z*conj(z);', ['z', 'w']);
    const system = prepareComplex(config, 2), root = solve(system, [], config.solver);
    expect(system.direct).toBeDefined(); expect(root.iterations).toBe(0);
    expect(root.complexValues!.z.re).toBeCloseTo(.2, 12);
    expect(root.complexValues!.z.im).toBeCloseTo(-.4, 12);
    expect(root.complexValues!.w.re).toBeCloseTo(.2, 12);
    expect(root.complexValues!.w.im).toBe(0);
    expect(root.values.p).toBe(2);
    expect(root.complexValues).not.toHaveProperty('p');
    expect(root.residuals).toEqual([0, 0, 0, 0]);
  });

  it('continues smooth polynomial assignments while keeping branch cuts conservative', () => {
    expect(prepareComplex(model('z = (p+i)^2;')).directContinuous).toBe(true);
    expect(prepareComplex(model('z = pow(p+i, -2);')).directContinuous).toBe(true);
    expect(prepareComplex(model('z = log(complex(-1,p));')).directContinuous).toBe(false);
    expect(prepareComplex(model('z = (p+i)^0.5;')).directContinuous).toBe(false);
  });

  it('solves coupled affine complex equations without Newton iterations', () => {
    const config = model('2*z + w = 1+i; z-w = 2-i;', ['z', 'w']);
    const system = prepareComplex(config), root = solve(system, [], config.solver);
    expect(system.direct).toBeDefined(); expect(root.iterations).toBe(0);
    expect(root.complexValues!.z).toEqual({ re: 1, im: 0 });
    expect(root.complexValues!.w).toEqual({ re: -1, im: 1 });
  });

  it('reconstructs partial assignments while solving only the nonlinear block', () => {
    const config = model('w = 2*z; z^2 = -1;', ['z', 'w']);
    const system = prepareComplex(config), found = roots(system, config.solver).roots;
    expect(system.direct).toBeUndefined();
    expect(system.unknowns.map(variable => variable.name)).toEqual(['real(z)', 'imag(z)']);
    expect(found).toHaveLength(2);
    for (const root of found) {
      expect(root.complexValues!.w.re).toBeCloseTo(2 * root.complexValues!.z.re, 12);
      expect(root.complexValues!.w.im).toBeCloseTo(2 * root.complexValues!.z.im, 12);
      expect(root.values['imag(w)']).toBe(root.complexValues!.w.im);
    }
  });

  it('handles a nonanalytic equation involving conjugation', () => {
    const config = model('z + 2*conj(z) = 3-i;');
    const root = solve(prepareComplex(config), [1, .5], config.solver);
    expect(root.complexValues!.z.re).toBeCloseTo(1, 9);
    expect(root.complexValues!.z.im).toBeCloseTo(1, 9);
  });

  it('accepts two explicit real projection equations for one complex unknown', () => {
    const config = model('real(z) = 1; imag(z) = 2;');
    const system = prepareComplex(config), root = solve(system, [0, 0], config.solver);
    expect(system.equations).toHaveLength(2);
    expect(root.complexValues!.z.re).toBeCloseTo(1, 10);
    expect(root.complexValues!.z.im).toBeCloseTo(2, 10);
  });

  it('reports a magnitude-only equation as one constraint on two real components', () => {
    expect(() => prepareComplex(model('abs(z) = 1;'))).toThrow('1 real equations for 2 real degrees of freedom');
  });

  it('applies conditions to real projections of complex roots', () => {
    const config = model('z^2 = -1; imag(z) > 0;');
    const found = roots(prepareComplex(config), config.solver).roots;
    expect(found).toHaveLength(1);
    expect(found[0].complexValues!.z.im).toBeCloseTo(1, 8);
  });

  it('requires an explicit validity condition to be real-valued', () => {
    const config = model('z = i; valid i;');
    expect(() => solve(prepareComplex(config), [], config.solver)).toThrow('Validity condition must be real');
  });

  it('keeps the existing real solver path when complex mode is off', () => {
    const config = model('z^2 + 1 = 0;'); config.solver.complex = false;
    expect(roots(prepare(config), config.solver).roots).toEqual([]);
  });

  it('allows a declared real parameter to shadow the imaginary-unit alias', () => {
    const config = model('z = i + j;');
    config.variables.push({ name: 'i', kind: 'parameter', value: 3 });
    const root = solve(prepareComplex(config), [], config.solver);
    expect(root.complexValues!.z).toEqual({ re: 3, im: 1 });
  });

  it('rejects ordered bounds on complex unknowns and nonreal parameter data', () => {
    const config = model('z = i;'); config.variables[0].min = 0;
    expect(() => prepareComplex(config)).toThrow('conditions on real(z), imag(z), or abs(z)');
    delete config.variables[0].min;
    config.variables[1].value = { re: 1, im: 2 } as unknown as number;
    expect(() => prepareComplex(config)).toThrow('finite real numbers');
  });

  it('constrains a real component and releases a parameter as one real unknown', () => {
    const config = model('z = p + i;');
    Object.assign(config.sweep, { mode: 'constrained', parameter: 'z', release: 'p' });
    config.axes = { x: 'z', y: 'imag(z)' };
    const system = prepareComplex(config, 2), root = solve(system, [], config.solver);
    expect(system.unknowns.map(variable => variable.name)).toEqual(['imag(z)', 'p']);
    expect(root.complexValues!.z).toEqual({ re: 2, im: 1 });
    expect(root.values.p).toBe(2); expect(root.values['real(z)']).toBe(2);
    expect(root.complexValues).not.toHaveProperty('p');
  });
});
