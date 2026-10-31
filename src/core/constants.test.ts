import { describe, expect, it } from 'vitest';
import { clone, rcLowPass, starter } from '../examples';
import { inspectConstants } from './constants';
import { evaluateTransitionLines } from './transitions';
import type { Configuration } from './types';

const model = (equations = '', complex = false): Configuration => {
  const config = clone(starter);
  config.equations = equations;
  config.variables = [];
  config.solver.complex = complex;
  config.sweep.parameter = 't';
  config.axes = { x: 't', y: '' };
  return config;
};

describe('constant inspection', () => {
  it('finds the RC cutoff and reference positions while excluding frequency-dependent outputs', () => {
    const config = clone(rcLowPass), constants = inspectConstants(config);
    expect(constants.parameters).toEqual([
      { name: 'R', value: 1000 }, { name: 'C', value: 100e-9 }, { name: 'Vin', value: 1 },
    ]);
    expect(constants.assignments.map(entry => entry.name)).toEqual(['cutoff_Hz']);
    expect(constants.assignments[0].value).toBeCloseTo(1 / (2 * Math.PI * 1000 * 100e-9), 10);
    expect(constants.transitions).toEqual(evaluateTransitionLines(config));
    expect(constants.issues).toEqual([]);
  });

  it('includes unused fixed inputs and never treats unknown initial guesses as constants', () => {
    const config = model('root^2 = t;\ndynamic = root + 1;\nfixed = 2 + 3;');
    config.variables = [
      { name: 'root', kind: 'unknown', value: 123 },
      { name: 'unused', kind: 'parameter', value: 4, min: 0, max: 10 },
    ];
    const constants = inspectConstants(config);
    expect(constants.parameters).toEqual([{ name: 'unused', value: 4 }]);
    expect(constants.assignments).toEqual([{ name: 'fixed', expression: '2 + 3', value: 5 }]);
    expect(constants.issues).toEqual([]);
  });

  it('keeps a declared parameter value separate from equations that constrain it', () => {
    const config = model('input = 9;\noutput = input*2;');
    config.variables = [{ name: 'input', kind: 'parameter', value: 3 }];
    const constants = inspectConstants(config);
    expect(constants.parameters).toEqual([{ name: 'input', value: 3 }]);
    expect(constants.assignments).toEqual([{ name: 'output', expression: 'input*2', value: 6 }]);
    expect(constants.issues).toEqual([]);
  });

  it('folds transitive assignments and lazy branches independently of source order', () => {
    const config = model('twice = base*2;\nbase = gain + sqrt(9);\nlazy = if(true, twice, root);\nternary = false ? t : lazy + 1;\nlogical = (0 && root) + (1 || missing);');
    config.variables = [{ name: 'gain', kind: 'parameter', value: 2 }];
    expect(inspectConstants(config).assignments).toEqual([
      { name: 'twice', expression: 'base*2', value: 10 },
      { name: 'base', expression: 'gain + sqrt(9)', value: 5 },
      { name: 'lazy', expression: 'if(true, twice, root)', value: 10 },
      { name: 'ternary', expression: 'false ? t : lazy + 1', value: 11 },
      { name: 'logical', expression: '(0 && root) + (1 || missing)', value: 1 },
    ]);
  });

  it('excludes all sweep dimensions, including a legacy released parameter', () => {
    const config = model('released = k + 1;\nmain = imposed;\nsecondary = a*2;\nadditional = b*2;\nfixed = gain^2;');
    config.variables = ['k', 'a', 'b', 'gain'].map(name => ({ name, kind: 'parameter' as const, value: 4 }));
    config.variables.push({ name: 'imposed', kind: 'unknown', value: 17 });
    config.sweep = {
      ...config.sweep, mode: 'constrained', parameter: 'imposed', release: 'k',
      secondary: { parameter: 'a', min: 0, max: 2, points: 3, logarithmic: false },
      additional: [{ parameter: 'b', min: 0, max: 2, points: 3, logarithmic: false }],
    };
    const constants = inspectConstants(config);
    expect(constants.parameters).toEqual([{ name: 'gain', value: 4 }]);
    expect(constants.assignments).toEqual([{ name: 'fixed', expression: 'gain^2', value: 16 }]);
    expect(constants.issues).toEqual([]);
  });

  it('excludes the primary parameter and algebraic expressions that still need its value', () => {
    const config = model('cancelled = t-t;\nzero = 0*t;\npower = t^0;\nconstant = 4;');
    config.variables = [{ name: 't', kind: 'parameter', value: 2 }];
    const constants = inspectConstants(config);
    expect(constants.parameters).toEqual([]);
    expect(constants.assignments).toEqual([{ name: 'constant', expression: '4', value: 4 }]);
    expect(constants.issues).toEqual([]);
  });

  it('supports legacy derived expressions without using their stored guesses', () => {
    const config = model('next = legacy + 1;');
    config.variables = [
      { name: 'input', kind: 'parameter', value: 3 },
      { name: 'legacy', kind: 'derived', expression: 'input*2', value: 999 },
    ];
    expect(inspectConstants(config).assignments).toEqual([
      { name: 'legacy', expression: 'input*2', value: 6 },
      { name: 'next', expression: 'legacy + 1', value: 7 },
    ]);
  });

  it('omits repeated definitions and active cycles without reporting dynamic models as broken', () => {
    const config = model('repeated = 1;\nrepeated = 2;\nfromRepeated = repeated + 1;\na = b + 1;\nb = a - 1;\nsafe = if(true, 5, a);\ngood = 2*pi;');
    const constants = inspectConstants(config);
    expect(constants.assignments.map(entry => entry.name)).toEqual(['safe', 'good']);
    expect(constants.assignments[0].value).toBe(5);
    expect(constants.assignments[1].value).toBe(2 * Math.PI);
    expect(constants.issues).toEqual([]);
  });

  it('treats a repeated legacy derived definition as ambiguous too', () => {
    const config = model('legacy = 3;\nother = legacy + 1;');
    config.variables = [{ name: 'legacy', kind: 'derived', expression: '2', value: 99 }];
    expect(inspectConstants(config)).toEqual({ parameters: [], assignments: [], transitions: [], issues: [] });
  });

  it('keeps finite complex constants while requiring real graph references', () => {
    const config = model('z = 2 + 3*i;\nmagnitude = abs(z);\nimaginary = imag(z);', true);
    config.axes.transitions = [
      { axis: 'x', expression: 'z' }, { axis: 'y', expression: 'magnitude' }, { axis: 'x', expression: '1/0' },
    ];
    const constants = inspectConstants(config);
    expect(constants.assignments).toEqual([
      { name: 'z', expression: '2 + 3*i', value: { re: 2, im: 3 } },
      { name: 'magnitude', expression: 'abs(z)', value: Math.hypot(2, 3) },
      { name: 'imaginary', expression: 'imag(z)', value: 3 },
    ]);
    expect(constants.transitions[0].issue).toContain('must be real');
    expect(constants.transitions[1]).toEqual({ axis: 'y', expression: 'magnitude', value: Math.hypot(2, 3) });
    expect(constants.transitions[2].issue).toMatch(/non-finite/i);
    expect(constants.issues).toEqual([]);
  });

  it('honors declared i and j instead of substituting implicit complex units', () => {
    const config = model('scaled = i*3;\ndynamic = j;', true);
    config.variables = [{ name: 'i', kind: 'parameter', value: 2 }, { name: 'j', kind: 'unknown', value: 9 }];
    const constants = inspectConstants(config);
    expect(constants.parameters).toEqual([{ name: 'i', value: 2 }]);
    expect(constants.assignments).toEqual([{ name: 'scaled', expression: 'i*3', value: 6 }]);
    expect(constants.issues).toEqual([]);
  });

  it('reports fixed domain failures and clears pending recursion before inspecting other definitions', () => {
    for (const complex of [false, true]) {
      const config = model('first = bad + 1;\nbad = 1/0;\nafter = bad + 2;\ngood = 5;\nlazy = if(false, bad, 9);', complex);
      const constants = inspectConstants(config);
      expect(constants.assignments.map(entry => [entry.name, entry.value])).toEqual([['good', 5], ['lazy', 9]]);
      expect(constants.issues.map(issue => issue.name)).toEqual(['first', 'bad', 'after']);
      for (const issue of constants.issues) expect(issue.message).toMatch(/non-finite/i);
    }
  });

  it('reports invalid fixed inputs without suppressing independent inputs and assignments', () => {
    const config = model('fromBad = bad + 1;\ngood = input*2;');
    config.variables = [{ name: 'bad', kind: 'parameter', value: Infinity }, { name: 'input', kind: 'parameter', value: 4 }];
    const constants = inspectConstants(config);
    expect(constants.parameters).toEqual([{ name: 'input', value: 4 }]);
    expect(constants.assignments).toEqual([{ name: 'good', expression: 'input*2', value: 8 }]);
    expect(constants.issues.map(issue => issue.name)).toEqual(['bad', 'fromBad']);
  });

  it('requires real complex-mode conditions and preserves invalid active intermediate domains', () => {
    const config = model('condition = if(i, 1, 2);\nlogical = i || missing;\ncomparison = (1/0) > 0;\ngood = 3;', true);
    const constants = inspectConstants(config);
    expect(constants.assignments).toEqual([{ name: 'good', expression: '3', value: 3 }]);
    expect(constants.issues.map(issue => issue.name)).toEqual(['condition', 'logical', 'comparison']);
    expect(constants.issues[0].message).toContain('must be real');
    expect(constants.issues[1].message).toContain('must be real');
    expect(constants.issues[2].message).toMatch(/non-finite/i);
  });

  it('lets invalid model syntax reach the UI error handler', () => {
    for (const source of ['a = sin(;', 'a = nope(2);', 'pi = 2;']) {
      expect(() => inspectConstants(model(source)), source).toThrow();
    }
  });

  it('returns failures independently for reference expressions', () => {
    const config = model('bad = 1/0;\ngood = 7;');
    config.axes.transitions = [
      { axis: 'x', expression: 'bad' }, { axis: 'y', expression: 'bad + 1' },
      { axis: 'x', expression: 't' }, { axis: 'y', expression: 'good' },
    ];
    const references = inspectConstants(config).transitions;
    expect(references[0].issue).toMatch(/non-finite/i);
    expect(references[1].issue).toMatch(/non-finite/i);
    expect(references[2].issue).toContain('varies');
    expect(references[3]).toEqual({ axis: 'y', expression: 'good', value: 7 });
  });

  it('does not mutate configuration or use guesses while inspecting values', () => {
    const config = clone(rcLowPass), before = structuredClone(config);
    inspectConstants(config);
    expect(config).toEqual(before);
  });
});
