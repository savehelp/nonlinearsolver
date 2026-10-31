import { describe, expect, it } from 'vitest';
import { clone, starter } from '../examples';
import { compile, residual } from './expression';
import { equationProgram } from './equations';
import { sweep } from './solver';
import { createWorkspace, loadWorkspace } from './workspace';
import { BUILTIN_ELEMENTS, MAX_ELEMENT_LIBRARY_SIZE, createElementLibrary, elementDefinitions, expandElements, mergeElementDefinitions, parseElementLibrary, type ElementDefinition, type ElementUsage } from './elements';
import type { Configuration, Variable } from './types';

const gain: ElementDefinition = { name: 'Gain', terminals: ['input'], parameters: { gain: { value: 2 } }, equations: ['output = gain*input'] };
const file = (elements: unknown[]) => ({ format: 'nonlinear-elements', version: 1, elements });
const model = (elements: ElementDefinition[] = [gain]): Configuration => ({ ...clone(starter), elementDefinitions: clone(elements) });
const math = (source: string, location?: string): ElementUsage => ({ source, kind: 'math', location });
const display = (source: string, location?: string): ElementUsage => ({ source, kind: 'display', location });
const instance = (name = 'A', type = 'Gain') => ({ type, name, location: '“Devices”, line 2: ' });
const largeDefinition = (name: string): ElementDefinition => ({
  name, description: '', terminals: [], parameters: {},
  // Whitespace inside a valid expression keeps this fixture cheap to parse.
  equations: Array.from({ length: 5 }, () => `output =${' '.repeat(8990)}1`),
});

describe('element JSON libraries', () => {
  it('loads the bundled NMOS equations from a valid portable JSON library', () => {
    expect(BUILTIN_ELEMENTS).toHaveLength(1);
    expect(BUILTIN_ELEMENTS[0]).toMatchObject({ name: 'NMOSFET', mode: 'real', terminals: ['g', 'd', 's'], parameters: { K: { value: .001 } } });
    expect(BUILTIN_ELEMENTS[0].equations).toContain('vgs = g - s');
    const portable = createElementLibrary(BUILTIN_ELEMENTS);
    expect(parseElementLibrary(JSON.parse(JSON.stringify(portable)))).toEqual(BUILTIN_ELEMENTS);
  });

  it('validates generic templates, implicit equations, and local initial guesses', () => {
    const implicit = { name: 'Square', terminals: ['input'], parameters: {}, unknowns: { output: 1 }, equations: ['output^2 = input', 'output >= 0'] };
    const definitions = parseElementLibrary(file([gain, implicit]));
    expect(definitions.map(entry => entry.name)).toEqual(['Gain', 'Square']);
    expect(definitions[1].unknowns).toEqual({ output: 1 });
    expect(definitions[1].equations).toEqual(implicit.equations);
  });

  it('rejects wrong formats, versions, duplicate type names and unknown schema keys', () => {
    for (const invalid of [null, [], { ...file([gain]), format: 'workspace' }, { ...file([gain]), version: 2 }, file([gain, gain]), file([{ ...gain, equatons: [] }])]) {
      expect(() => parseElementLibrary(invalid)).toThrow();
    }
  });

  it('rejects invalid member names, duplicate fields, and undeclared local symbols', () => {
    const invalid = [
      { ...gain, terminals: ['input', 'input'] },
      { ...gain, terminals: ['gain'] },
      { ...gain, unknowns: { input: 1 } },
      { ...gain, equations: ['output = unknown_input * gain'] },
      { ...gain, equations: ['output = External.input'] },
      { ...gain, equations: ['pi = input'] },
      { ...gain, parameters: { constructor: { value: 2 } } },
      { ...gain, name: '__proto__' },
    ];
    for (const entry of invalid) expect(() => parseElementLibrary(file([entry]))).toThrow();
    const malicious = JSON.parse('{"name":"Bad","terminals":[],"parameters":{"__proto__":{"value":1}},"equations":["x=1"]}');
    expect(() => parseElementLibrary(file([malicious]))).toThrow();
  });

  it('rejects commands, executable text and multiple statements in a template entry', () => {
    for (const source of ['parameter x 1', 'element NMOSFET M1', 'plot input', 'output = gain*input; other = 1;', 'output = globalThis.alert(input)', 'output = input[0]', 'output = 1e999']) {
      expect(() => parseElementLibrary(file([{ ...gain, equations: [source] }]))).toThrow();
    }
  });

  it('validates finite defaults, guesses and slider ranges', () => {
    for (const option of [{ value: Infinity }, { value: NaN }, { value: 1, step: 0 }, { value: 1, min: 3, max: 2 }, { value: 1, min: 2 }, { value: 1, max: 0 }, { value: '2' }]) {
      expect(() => parseElementLibrary(file([{ ...gain, parameters: { gain: option } }]))).toThrow();
    }
    expect(() => parseElementLibrary(file([{ ...gain, unknowns: { output: Infinity } }]))).toThrow();
    expect(parseElementLibrary(file([{ ...gain, parameters: { gain: { value: 2, step: .1, min: 1, max: 4 } } }]))[0].parameters.gain).toEqual({ value: 2, step: .1, min: 1, max: 4 });
  });

  it('copies imported data and replaces matching loaded or bundled types by name', () => {
    const input = clone(gain), imported = parseElementLibrary(file([input]));
    imported[0].parameters.gain.value = 7;
    expect(input.parameters.gain.value).toBe(2);
    const merged = mergeElementDefinitions([gain], [{ ...gain, parameters: { gain: { value: 3 } } }]);
    expect(merged).toHaveLength(1); expect(merged[0].parameters.gain.value).toBe(3);
    const customized = clone(BUILTIN_ELEMENTS[0]); customized.parameters.VTH.value = .4;
    const available = elementDefinitions(model([customized]));
    expect(available).toHaveLength(1); expect(available[0].parameters.VTH.value).toBe(.4);
    expect(BUILTIN_ELEMENTS[0].parameters.VTH.value).toBe(.7);
  });

  it('rejects individually valid libraries whose merge exceeds the total limit without damaging prior definitions', () => {
    const first = parseElementLibrary(file(Array.from({ length: 12 }, (_, index) => largeDefinition(`First${index}`))));
    const second = parseElementLibrary(file(Array.from({ length: 12 }, (_, index) => largeDefinition(`Second${index}`))));
    const before = JSON.stringify(first);
    expect(() => mergeElementDefinitions(first, second)).toThrow(/smaller than 1 MB/);
    expect(JSON.stringify(first)).toBe(before);
    expect(elementDefinitions(model(first))).toHaveLength(13);
    expect(parseElementLibrary(createElementLibrary(first))).toEqual(first);
  });

  it('includes bundled definitions in the size limit so accepted workspace snapshots remain loadable', () => {
    const nearLimit = Array.from({ length: 22 }, (_, index) => largeDefinition(`Large${index}`));
    let remaining = MAX_ELEMENT_LIBRARY_SIZE - 32 - JSON.stringify(file(nearLimit)).length;
    expect(remaining).toBeGreaterThan(0);
    for (const entry of nearLimit) {
      const size = Math.min(2000, remaining); entry.description = 'x'.repeat(size); remaining -= size;
    }
    expect(remaining).toBe(0);
    const imported = parseElementLibrary(file(nearLimit));
    expect(JSON.stringify(createElementLibrary(imported)).length).toBe(MAX_ELEMENT_LIBRARY_SIZE - 32);
    expect(() => mergeElementDefinitions(undefined, imported)).toThrow(/smaller than 1 MB/);
    expect(() => elementDefinitions(model(imported))).toThrow(/smaller than 1 MB/);
    expect(() => loadWorkspace({ ...createWorkspace(clone(starter)), elements: imported })).toThrow(/smaller than 1 MB/);
    const accepted = mergeElementDefinitions(undefined, imported.slice(1));
    const snapshot = createElementLibrary(elementDefinitions(model(accepted)));
    expect(() => parseElementLibrary(JSON.parse(JSON.stringify(snapshot)))).not.toThrow();
  });
});

describe('lazy element expansion', () => {
  it('keeps declarations and parameter or guess overrides dormant until a member is used', () => {
    const variables: Variable[] = [{ name: 'A.gain', kind: 'parameter', value: 5 }, { name: 'A.output', kind: 'unknown', value: 1 }];
    expect(expandElements(model(), [instance()], [], variables)).toEqual({ equations: [], variables: [] });
    expect(expandElements(model(), [], [], [])).toEqual({ equations: [], variables: [] });
  });

  it('activates each used instance once and rebuilds the active set on each compilation', () => {
    const config = model(), declarations = [instance()];
    const expanded = expandElements(config, declarations, [math('A.input = x'), display('plot A.output'), display('plot A.output^2')], []);
    expect(expanded.equations).toEqual(['A.output = (A.gain * A.input);']);
    expect(expanded.variables).toEqual([{ name: 'A.gain', kind: 'parameter', value: 2 }]);
    expect(expandElements(config, declarations, [], []).equations).toEqual([]);
  });

  it('isolates members and defaults of multiple cross-connected instances', () => {
    const expanded = expandElements(model(), [instance('A'), instance('B')], [math('A.input = B.output'), math('B.input = x'), display('plot A.output B.output')], []);
    expect(expanded.equations).toEqual(['A.output = (A.gain * A.input);', 'B.output = (B.gain * B.input);']);
    expect(expanded.variables.map(variable => variable.name)).toEqual(['A.gain', 'B.gain']);
    expanded.variables[0].value = 99;
    expect(expanded.variables[1].value).toBe(2);
  });

  it('uses explicit parameter overrides and unknown guesses without duplicate generated defaults', () => {
    const config = model([{ ...gain, unknowns: { output: 0 } }]);
    const variables: Variable[] = [{ name: 'A.gain', kind: 'parameter', value: 5, min: 1, max: 6, step: 1 }, { name: 'A.output', kind: 'unknown', value: 20 }];
    expect(expandElements(config, [instance()], [math('A.input = x')], variables).variables).toEqual([]);
    const onlyParameter = expandElements(config, [instance()], [math('A.input = x')], variables.slice(0, 1));
    expect(onlyParameter.variables).toEqual([{ name: 'A.output', kind: 'unknown', value: 0 }]);
  });

  it('preserves function calls, scientific numbers, builtins and similarly named local variables', () => {
    const definition: ElementDefinition = { name: 'Trig', terminals: ['input'], parameters: { sin: { value: 2 } }, equations: ['output = sin(input) + sin + pi + 1e-3'] };
    const expanded = expandElements(model([definition]), [instance('A', 'Trig')], [math('A.input = x')], []);
    expect(expanded.equations[0]).toContain('sin(A.input)');
    expect(expanded.equations[0]).toContain('A.sin');
    expect(expanded.equations[0]).toContain('pi');
    expect(expanded.equations[0]).not.toContain('A.pi');
    expect(residual(expanded.equations[0].slice(0, -1)).evaluate({ 'A.output': 2 + Math.PI + .001, 'A.input': 0, 'A.sin': 2 })).toBeCloseTo(0, 12);
  });

  it('rejects unknown types, duplicate instance names, namespace collisions and invalid override kinds', () => {
    expect(() => expandElements(model(), [instance('A', 'Missing')], [], [])).toThrow(/not loaded/);
    expect(() => expandElements(model(), [instance(), instance()], [], [])).toThrow(/declared more than once/);
    expect(() => expandElements(model(), [instance()], [], [{ name: 'A', kind: 'parameter', value: 1 }])).toThrow(/both an element/);
    expect(() => expandElements(model(), [instance()], [], [{ name: 'A.gain', kind: 'unknown', value: 1 }])).toThrow(/device parameter/);
    expect(() => expandElements(model(), [instance()], [], [{ name: 'A.output', kind: 'parameter', value: 1 }])).toThrow(/computed member/);
  });

  it('rejects undeclared instances, typo members and bare instance references with source locations', () => {
    for (const source of ['plot Missing.output', 'plot A.ouput', 'plot A']) {
      expect(() => expandElements(model(), [instance()], [display(source, '“Plot”, line 7: ')], [])).toThrow(/“Plot”, line 7: /);
    }
    expect(() => expandElements(model(), [instance()], [], [{ name: 'A.typo', kind: 'unknown', value: 0 }])).toThrow(/not a member/);
    expect(() => expandElements(model(), [instance()], [math('result = A')], [])).toThrow(/Use a member/);
  });

  it('defers malformed display syntax to document plot validation without discarding valid activation', () => {
    const config = model(), declarations = [instance()];
    const expanded = expandElements(config, declarations, [math('A.input = x'), display('plot_x_transition 1 2'), display('plot A.output x broken')], []);
    expect(expanded.equations).toEqual(['A.output = (A.gain * A.input);']);
    expect(() => expandElements(config, declarations, [display('plot A.typo', '“Plot”, line 7: ')], [])).toThrow('“Plot”, line 7: “A.typo” is not a member of Gain.');
  });

  it('requires every active terminal to occur in an external equation rather than only a plot or condition', () => {
    expect(() => expandElements(model(), [instance()], [display('plot A.output')], [])).toThrow(/unconnected terminal: A.input/);
    expect(() => expandElements(model(), [instance()], [math('A.input >= 0'), display('plot A.output')], [])).toThrow(/unconnected terminal/);
    expect(expandElements(model(), [instance()], [math('A.input - x = 0')], []).equations).toHaveLength(1);
  });

  it('checks mode compatibility only for activated instances', () => {
    const config = model(), nmos = [instance('M1', 'NMOSFET')], wired = [math('M1.g = x'), math('M1.d = 2'), math('M1.s = 0')];
    config.solver.complex = true;
    expect(expandElements(config, nmos, [], []).equations).toEqual([]);
    expect(() => expandElements(config, nmos, wired, [])).toThrow(/requires real mode/);
    config.elementDefinitions = [{ ...gain, mode: 'complex' }]; config.solver.complex = false;
    expect(() => expandElements(config, [instance()], [math('A.input = x')], [])).toThrow(/requires complex mode/);
  });

  it('keeps complex units builtin unless explicitly declared as local members', () => {
    const imaginary: ElementDefinition = { name: 'Phasor', terminals: ['input'], parameters: {}, mode: 'complex', equations: ['output = i*input'] };
    const config = model([imaginary]); config.solver.complex = true;
    expect(expandElements(config, [instance('A', 'Phasor')], [math('A.input = x')], []).equations[0]).toBe('A.output = (i * A.input);');
    config.elementDefinitions = [{ ...imaginary, parameters: { i: { value: 2 } } }];
    expect(expandElements(config, [instance('A', 'Phasor')], [math('A.input = x')], []).equations[0]).toBe('A.output = (A.i * A.input);');
  });

  it('provides a working namespaced DC MOSFET model to the unchanged numerical solver', () => {
    const config = model([]), user = ['M1.g = x', 'M1.d = 2', 'M1.s = 0'];
    const expanded = expandElements(config, [instance('M1', 'NMOSFET')], user.map(source => math(source)), []);
    config.equations = [...user.map(source => `${source};`), ...expanded.equations].join('\n');
    config.variables = [{ name: 'x', kind: 'parameter', value: 1 }, ...expanded.variables];
    config.axes = { x: 'x', y: 'M1.id' };
    config.sweep = { parameter: 'x', min: 0, max: 1, points: 3, logarithmic: false, mode: 'free', release: '' };
    const result = sweep(config), last = result.branches.flatMap(branch => branch.points).find(point => point.parameter === 1);
    expect(result.failures).toEqual([]);
    expect(last?.values['M1.id']).toBeCloseTo(.001 / 2 * (1 - .7) ** 2 * (1 + .02 * 2), 12);
    expect(equationProgram(config.equations).conditions).toHaveLength(1);
  });

  it('does not mutate accepted source configuration, declarations, usages, or overrides', () => {
    const config = model(), declarations = [instance()], usages = [math('A.input = x')], variables: Variable[] = [{ name: 'A.gain', kind: 'parameter', value: 4 }];
    const before = JSON.stringify({ config, declarations, usages, variables });
    expandElements(config, declarations, usages, variables);
    expect(JSON.stringify({ config, declarations, usages, variables })).toBe(before);
  });
});
