import { describe, expect, it } from 'vitest';
import { modelDiagnostics } from './diagnostics';
import type { Configuration } from './types';

function model(equations: string, unknowns: string[] = ['y']): Configuration {
  return {
    name: 'Diagnostics', description: '', equations, constraints: '', regions: [],
    documents: [{ id: 'model', title: 'Model', source: equations }],
    variables: [...unknowns.map(name => ({ name, kind: 'unknown' as const, value: 1 })), { name: 'p', kind: 'parameter', value: 2 }],
    sweep: { parameter: 'p', min: 0, max: 3, points: 4, logarithmic: false, mode: 'free', release: '' },
    axes: { x: 'p', y: unknowns[0] ?? 'y' }, solver: { tolerance: 1e-8, iterations: 50, starts: 12 },
  };
}

describe('model diagnostics', () => {
  it('distinguishes declarations, active unknowns, and a direct solve', () => {
    const config = model('y = 2*p;');
    config.variables.push({ name: 'unused', kind: 'unknown', value: 0 }, { name: 'unusedParameter', kind: 'parameter', value: 0 });
    expect(modelDiagnostics(config)).toEqual({
      declaredUnknowns: 2, parameters: 2, declaredDerived: 0, inferredVariables: 0,
      equations: 1, conditions: 0, tabs: 1, activeUnknowns: 1, numericalUnknowns: 0, direct: true,
    });
  });

  it('reports the remaining Newton dimension after partial reduction', () => {
    const config = model('y = x - sin(y); x^2 + y^2 = p^2;', ['x', 'y']);
    expect(modelDiagnostics(config)).toMatchObject({ activeUnknowns: 2, numericalUnknowns: 1, direct: false, equations: 2 });
  });

  it('counts inferred definitions once, including cyclic definitions that remain numerical', () => {
    const config = model('y = x; x = y;', []);
    expect(modelDiagnostics(config)).toMatchObject({ declaredUnknowns: 0, inferredVariables: 2, activeUnknowns: 2, direct: false });
    expect(modelDiagnostics(config).numericalUnknowns).toBeGreaterThan(0);
    config.equations = 'y = p; y = 2*p;';
    expect(modelDiagnostics(config)).toMatchObject({ inferredVariables: 1, equations: 2, issue: expect.stringContaining('Overdetermined') });
  });

  it('counts equation validity checks and legacy constraints separately from residual equations', () => {
    const config = model('y = p; y >= 0; valid y != 1;');
    config.constraints = '# ignored\np > -10\n y < 100 # inline';
    expect(modelDiagnostics(config)).toMatchObject({ equations: 1, conditions: 4, direct: true });
  });

  it('uses the initial sweep value when preprocessing parameter-dependent coefficients', () => {
    const config = model('p*y = 1;');
    config.sweep.startAt = 0;
    expect(modelDiagnostics(config)).toMatchObject({ activeUnknowns: 1, numericalUnknowns: 1, direct: false });
    delete config.sweep.startAt;
    expect(modelDiagnostics(config)).toMatchObject({ numericalUnknowns: 0, direct: true });
  });

  it('reports constrained mode after imposing an unknown and releasing a parameter', () => {
    const config = model('y = p;');
    config.sweep.mode = 'constrained'; config.sweep.parameter = 'y'; config.sweep.release = 'p';
    expect(modelDiagnostics(config)).toMatchObject({ declaredUnknowns: 1, parameters: 1, activeUnknowns: 1, numericalUnknowns: 0, direct: true });
  });

  it('prepares constrained diagnostics at the imposed range start instead of its guess', () => {
    const config = model('y*p = 1;');
    config.sweep.mode = 'constrained'; config.sweep.parameter = 'y'; config.sweep.release = 'p';
    expect(modelDiagnostics(config)).toMatchObject({ numericalUnknowns: 1, direct: false });
  });

  it('keeps large inferred systems countable without preparing them on the UI thread', () => {
    const config = model(Array.from({ length: 150 }, (_, index) => `v${index} = .25*v${(index + 1) % 150} + p;`).join('\n'), []);
    config.axes.y = 'v0';
    expect(modelDiagnostics(config)).toMatchObject({ declaredUnknowns: 0, parameters: 1, inferredVariables: 150, equations: 150, preparationSkipped: true });
    expect(modelDiagnostics(config).numericalUnknowns).toBeUndefined();
  });

  it('does not claim convergence or a unique root for a singular system', () => {
    const summary = modelDiagnostics(model('0*y = p;'));
    expect(summary).toMatchObject({ equations: 1, activeUnknowns: 1, numericalUnknowns: 1, direct: false });
    expect(summary.issue).toBeUndefined();
  });

  it('preserves reliable counts for invalid expressions without throwing', () => {
    const summary = modelDiagnostics(model('y = sin(; y > 0;'));
    expect(summary).toMatchObject({ declaredUnknowns: 1, parameters: 1, equations: 1, conditions: 1, tabs: 1 });
    expect(summary.issue).toBeTruthy();
    expect(summary.activeUnknowns).toBeUndefined();
    expect(summary.numericalUnknowns).toBeUndefined();
  });

  it('leaves statement counts unavailable when malformed terminators make them unreliable', () => {
    const summary = modelDiagnostics(model('y = p; y > 0'));
    expect(summary).toMatchObject({ declaredUnknowns: 1, parameters: 1, inferredVariables: null, equations: null, conditions: null });
    expect(summary.issue).toContain('semicolon');
  });

  it('reports reserved assignment names as issues instead of inferred variables', () => {
    const summary = modelDiagnostics(model('pi = p;', []));
    expect(summary).toMatchObject({ inferredVariables: 0, equations: 1 });
    expect(summary.issue).toContain('reserved');
  });

  it('counts legacy explicit definitions and does not mutate the configuration', () => {
    const config = model('y = gain; y >= 0;');
    config.variables.push({ name: 'gain', kind: 'derived', value: 0, expression: '2*p' });
    const before = JSON.stringify(config);
    expect(modelDiagnostics(config)).toMatchObject({ declaredDerived: 1, inferredVariables: 0, direct: true });
    expect(JSON.stringify(config)).toBe(before);
  });
});
