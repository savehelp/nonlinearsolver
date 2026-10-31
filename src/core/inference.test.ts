import { describe, expect, it } from 'vitest';
import { clone, rcLowPass, starter } from '../examples';
import { compileDocuments, ensureDocuments, PlotSourceError } from './documents';
import { modelDiagnostics } from './diagnostics';
import { prepare, roots, solve, sweep } from './solver';
import { reconcileSweep } from './variables';
import type { Configuration } from './types';

const parameter = 'parameter p 1 1 0 3 sweep';
function workspace(source: string, complex = false): Configuration {
  const config = clone(starter); config.solver.complex = complex;
  return compileDocuments(config, [{ id: 'model', title: 'Model', source }]);
}

describe('unknown inference from mathematical expressions', () => {
  it('solves a coupled implicit linear system without unknown declarations', () => {
    const source = `${parameter}\nu + v = p;\nu - v = 1;\nset_time_axis p\nplot u\nplot v`;
    const config = workspace(source), system = prepare(config, 3);
    expect(system.allUnknowns?.map(variable => variable.name).sort()).toEqual(['u', 'v']);
    expect(system.allUnknowns?.every(variable => variable.value === 0)).toBe(true);
    expect(solve(system, [], config.solver).values).toMatchObject({ p: 3, u: 2, v: 1 });
    expect(config.documents![0].source).toBe(source);
  });

  it('finds a nonlinear implicit unknown and applies its validity condition', () => {
    const config = workspace(`${parameter}\nz^2 = p;\nz >= 0;\nset_time_axis p\nplot z`);
    const system = prepare(config, 4), found = roots(system, config.solver).roots;
    expect(system.allUnknowns?.map(variable => variable.name)).toEqual(['z']);
    expect(found).toHaveLength(1); expect(found[0].values.z).toBeCloseTo(2, 8);
  });

  it('infers the RC node voltage and recovers the transfer function at cutoff', () => {
    const example = clone(rcLowPass);
    example.variables = example.variables.filter(variable => variable.kind !== 'unknown');
    const documents = ensureDocuments(example), config = compileDocuments(example, documents);
    expect(documents.every(document => !document.source.includes('unknown Vout'))).toBe(true);
    const cutoff = 1 / (2 * Math.PI * 1000 * 100e-9);
    const system = prepare(config, cutoff), found = roots(system, config.solver).roots;
    expect(found).toHaveLength(1);
    const root = found[0];
    expect(system.allUnknowns?.some(variable => variable.name === 'real(Vout)' && variable.value === 0)).toBe(true);
    expect(root.complexValues!.Vout.re).toBeCloseTo(.5, 8);
    expect(root.complexValues!.Vout.im).toBeCloseTo(-.5, 8);
    expect(root.complexValues!.H.re).toBeCloseTo(.5, 8);
    expect(root.complexValues!.H.im).toBeCloseTo(-.5, 8);
  });

  it('infers complex unknowns from implicit and real projection equations', () => {
    const implicit = workspace(`${parameter}\nz^2 + 1 = 0;\nset_time_axis p\nplot imag(z)`, true);
    const found = roots(prepare(implicit), implicit.solver).roots;
    expect(found).toHaveLength(2);
    expect(found.map(root => Math.round(root.complexValues!.z.im)).sort()).toEqual([-1, 1]);
    const projected = workspace(`${parameter}\nreal(z) = 1;\nimag(z) = 2;\nset_time_axis p\nplot imag(z)`, true);
    const root = solve(prepare(projected), [], projected.solver);
    expect(root.complexValues!.z.re).toBeCloseTo(1, 9);
    expect(root.complexValues!.z.im).toBeCloseTo(2, 9);
  });

  it('names inferred unknowns in an underdetermined model and suggests declaring parameters', () => {
    const config = workspace('parameter x 1 1 0 3 sweep\ny = a*x;\nset_time_axis x\nplot y');
    let message = '';
    try { prepare(config); } catch (error) { message = (error as Error).message; }
    expect(message).toContain('Underdetermined');
    expect(message).toMatch(/\by\b/); expect(message).toMatch(/\ba\b/);
    expect(message.toLowerCase()).toContain('parameter');
    const fixed = workspace('parameter x 1 1 0 3 sweep\nparameter a 2\ny = a*x;\nset_time_axis x\nplot y');
    expect(solve(prepare(fixed, 3), [], fixed.solver).values).toMatchObject({ x: 3, a: 2, y: 6 });
  });

  it('counts names introduced only by mathematical validity conditions', () => {
    const config = workspace(`${parameter}\ny = p;\nlimit > y;\nset_time_axis p\nplot y`);
    const diagnostics = modelDiagnostics(config);
    expect(diagnostics.inferredVariables).toBe(2);
    expect(diagnostics.issue).toContain('Underdetermined');
  });

  it('infers dependencies referenced by declared derived quantities', () => {
    const config = clone(starter);
    config.variables = [{ name: 'p', kind: 'parameter', value: 2 }, { name: 'gain', kind: 'derived', value: 0, expression: '2*z' }];
    config.equations = 'z + 1 = p;'; config.constraints = '';
    config.axes = { x: 'p', y: 'gain' }; config.sweep.parameter = 'p';
    const root = solve(prepare(config, 2), [], config.solver);
    expect(root.values).toMatchObject({ z: 1, gain: 2, p: 2 });
    config.equations = 'y = p;';
    expect(() => prepare(config, 2)).toThrow('Underdetermined');
  });

  it('rejects a plot-only typo instead of introducing a new model unknown', () => {
    expect(() => workspace(`${parameter}\n2*y = p;\nset_time_axis p\nplot missing`)).toThrow(PlotSourceError);
    expect(() => workspace(`${parameter}\n2*y = p;\nset_time_axis p\nplot missing`)).toThrow('“missing” is not defined');
  });

  it('keeps constants out of inference and rejects reserved assignment names', () => {
    const config = workspace(`${parameter}\n2*y = pi + e;\nvalid true && !false;\nset_time_axis p\nplot y`);
    const system = prepare(config);
    expect(system.allUnknowns?.map(variable => variable.name)).toEqual(['y']);
    expect(solve(system, [], config.solver).values.y).toBeCloseTo((Math.PI + Math.E) / 2, 12);
    expect(() => prepare(workspace(`${parameter}\npi = p;\nset_time_axis p\nplot pi`))).toThrow('reserved');
  });

  it('uses i and j as complex constants while allowing equation-defined shadowing', () => {
    const config = workspace(`${parameter}\nz = i + j;\nset_time_axis p\nplot imag(z)`, true);
    const system = prepare(config), root = solve(system, [], config.solver);
    expect(system.allUnknowns?.map(variable => variable.name)).toEqual(['real(z)', 'imag(z)']);
    expect(root.complexValues!.z).toEqual({ re: 0, im: 2 });
    const shadowed = workspace(`${parameter}\ni = 2;\nz = i + j;\nset_time_axis p\nplot imag(z)`, true);
    expect(solve(prepare(shadowed), [], shadowed.solver).complexValues!.z).toEqual({ re: 2, im: 1 });
  });

  it('retains an explicit initial guess instead of duplicating an inferred unknown', () => {
    const config = workspace(`${parameter}\nunknown z -2\nz^2 = p;\nset_time_axis p\nplot z`);
    const system = prepare(config, 4);
    expect(system.allUnknowns?.filter(variable => variable.name === 'z')).toEqual([{ name: 'z', kind: 'unknown', value: -2 }]);
    expect(solve(system, [-2], config.solver).values.z).toBe(-2);
  });

  it('allows an inferred implicit unknown to be imposed by real and complex constrained sweeps', () => {
    for (const complex of [false, true]) {
      const config = clone(starter); config.solver.complex = complex;
      Object.assign(config.sweep, { mode: 'constrained', parameter: 'z', release: 'p', min: 1, max: 3, points: 3 });
      const compiled = compileDocuments(config, [{ id: 'model', title: 'Model', source: `parameter p 1\n2*z = p${complex ? ' + 2*i' : ''};\nset_time_axis z\nplot p` }]);
      reconcileSweep(compiled, false);
      expect(compiled.sweep.parameter).toBe('z');
      expect(compiled.variables.some(variable => variable.name === 'z')).toBe(false);
      const result = sweep(compiled);
      expect(result.failures).toEqual([]); expect(result.solved).toBe(3);
      for (const point of result.branches.flatMap(branch => branch.points)) {
        expect(point.x).toBeCloseTo(point.parameter, 8);
        expect(point.y).toBeCloseTo(2 * point.parameter, 8);
        if (complex) expect(point.complexValues!.z.im).toBeCloseTo(1, 8);
      }
    }
  });
});
