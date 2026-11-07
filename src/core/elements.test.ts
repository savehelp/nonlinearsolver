import { describe, expect, it } from 'vitest';
import { clone, starter } from '../examples';
import { compile, residual } from './expression';
import { equationProgram } from './equations';
import { sweep } from './solver';
import { createWorkspace, loadWorkspace } from './workspace';
import { BUILTIN_ELEMENTS, MAX_ELEMENT_LIBRARY_SIZE, createElementLibrary, elementDefinitions, elementLibraryEntries, expandElements, mergeElementDefinitions, parseElementLibrary, removeElementDefinition, replaceElementDefinition, type ElementDefinition, type ElementUsage } from './elements';
import type { Configuration, Variable } from './types';

const gain: ElementDefinition = { name: 'Gain', terminals: ['input'], parameters: { gain: { value: 2 } }, equations: ['output = gain*input'] };
const withBody: ElementDefinition = {
  name: 'WithBody', terminals: ['g', 'd', 's', 'b'], terminalDefaults: { b: 's' }, parameters: { gain: { value: 2 } },
  equations: ['output = gain*(g-s)+(d-s)+(b-s)'],
};
const withAliases: ElementDefinition = { ...withBody, terminalAliases: { t1: 'd', t2: 's', bulk: 'b' } };
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
function nearLimitLibrary(first: ElementDefinition): ElementDefinition[] {
  const fillers = Array.from({ length: 22 }, (_, index) => largeDefinition(`Filler${index}`));
  const entries = [clone(first), ...clone(BUILTIN_ELEMENTS.filter(entry => entry.name !== first.name)), ...fillers];
  let remaining = MAX_ELEMENT_LIBRARY_SIZE - 32 - JSON.stringify(file(entries)).length;
  expect(remaining).toBeGreaterThan(0);
  for (const entry of fillers) {
    const size = Math.min(2000, remaining); entry.description = 'x'.repeat(size); remaining -= size;
  }
  expect(remaining).toBe(0);
  return parseElementLibrary(file(entries));
}

describe('element JSON libraries', () => {
  it('validates and copies terminal aliases through library serialization', () => {
    const source = clone(withAliases), definitions = parseElementLibrary(file([source]));
    expect(definitions[0].terminalAliases).toEqual({ t1: 'd', t2: 's', bulk: 'b' });
    expect(parseElementLibrary(JSON.parse(JSON.stringify(createElementLibrary(definitions))))).toEqual(definitions);
    definitions[0].terminalAliases!.t1 = 's';
    expect(source.terminalAliases!.t1).toBe('d');
  });

  it('rejects malformed aliases, nonterminal targets, chains and collisions with declared or computed members', () => {
    const invalid: unknown[] = [null, [], { t1: 0 }, { t1: 'missing' }, { t1: 'Other.d' }, { t1: 't2', t2: 's' },
      { t1: 't1' }, { d: 's' }, { gain: 'g' }, { output: 'd' }, { '1': 'd' }, { 'x.y': 'd' }, { constructor: 'd' }];
    for (const terminalAliases of invalid) expect(() => parseElementLibrary(file([{ ...withBody, terminalAliases }]))).toThrow();
    expect(() => parseElementLibrary(file([{ ...withBody, unknowns: { t1: 0 }, terminalAliases: { t1: 'd' } }]))).toThrow(/defined more than once/);
    expect(() => parseElementLibrary(file([{ ...withBody, terminalAliases: JSON.parse('{"__proto__":"d"}') }]))).toThrow(/non-reserved/);
    const many = Object.fromEntries(Array.from({ length: 95 }, (_, index) => [`pin${index}`, 'd']));
    expect(() => parseElementLibrary(file([{ ...withBody, terminalAliases: many }]))).toThrow(/at most 100 members/);
  });

  it('follows aliases when checking terminal fallback cycles and scopes aliases inside model expressions', () => {
    expect(() => parseElementLibrary(file([{ ...withAliases, terminalDefaults: { b: 'bulk' } }]))).toThrow(/circular terminal default/);
    expect(() => parseElementLibrary(file([{ ...withAliases, terminalDefaults: { b: 'helper' }, equations: [...withAliases.equations, 'helper = bulk'] }]))).toThrow(/circular terminal default/);
    const definition = { ...withAliases, terminalDefaults: { b: 't2' }, equations: ['output = gain*(g-t2)+(t1-t2)+(bulk-t2)'] };
    const expanded = expandElements(model([definition]), [instance('M1', 'WithBody')], [math('M1.g = x'), math('M1.t1 = 2'), math('M1.t2 = 0')], []);
    expect(expanded.equations[0]).toBe('M1.b = M1.t2;');
    expect(expanded.equations.at(-1)).toContain('M1.bulk');
    expect(expanded.equations.at(-1)).toContain('M1.t1');
  });

  it('validates, scopes and copies optional terminal expressions through library serialization', () => {
    const source = { ...clone(withBody), terminalDefaults: { b: ' s + sin(pi) ' } };
    const definitions = parseElementLibrary(file([source]));
    expect(definitions[0].terminalDefaults).toEqual({ b: 's + sin(pi)' });
    expect(parseElementLibrary(JSON.parse(JSON.stringify(createElementLibrary(definitions))))).toEqual(definitions);
    definitions[0].terminalDefaults!.b = 'g';
    expect(source.terminalDefaults.b).toBe(' s + sin(pi) ');
  });

  it('rejects invalid terminal fallback schema, unscoped symbols, commands and nonfinite literals', () => {
    const invalid: unknown[] = [null, [], { missing: 's' }, { gain: 's' }, { b: 0 }, { b: '' }, { b: 'missing' }, { b: 'Other.s' },
      { b: 'parameter s 0' }, { b: 's = 0' }, { b: 's; g' }, { b: 'plot s' }, { b: '1e999' }, { b: `s${' '.repeat(10_000)}` }];
    for (const terminalDefaults of invalid) expect(() => parseElementLibrary(file([{ ...withBody, terminalDefaults }]))).toThrow();
    expect(() => parseElementLibrary(file([{ ...withBody, terminalDefaults: JSON.parse('{"__proto__":"s"}') }]))).toThrow(/declared terminal/);
  });

  it('rejects circular terminal defaults directly, across defaults, and through computed assignments', () => {
    for (const entry of [
      { ...withBody, terminalDefaults: { b: 'b' } },
      { ...withBody, terminalDefaults: { b: 's', s: 'b' } },
      { ...withBody, terminalDefaults: { b: 'helper' }, equations: [...withBody.equations, 'helper = b'] },
      { ...withBody, terminalDefaults: { b: 'helper' }, equations: [...withBody.equations, 'helper = other', 'other = b'] },
    ]) expect(() => parseElementLibrary(file([entry]))).toThrow(/circular terminal default/);
    expect(() => parseElementLibrary(file([{ ...withBody, equations: [...withBody.equations, 'x = y^2', 'y = x+1'] }]))).not.toThrow();
  });

  it('loads the bundled NFET4 and PFET4 equations with geometry and optional body terminals', () => {
    expect(BUILTIN_ELEMENTS.map(entry => entry.name)).toEqual(['NMOSFET', 'PMOSFET']);
    for (const [index, expected] of [
      { VTO: .7, GAMMA: .45, PHI: .9, LD: .08e-6, UO: 350, CLM_C: .034e-6 },
      { VTO: -.8, GAMMA: .4, PHI: .8, LD: .09e-6, UO: 100, CLM_C: .064e-6 },
    ].entries()) {
      const definition = BUILTIN_ELEMENTS[index];
      expect(definition).toMatchObject({ mode: 'real', terminals: ['g', 'd', 's', 'b'], terminalDefaults: { b: 's' } });
      for (const [name, value] of Object.entries({ ...expected, W: 1e-6, L: .5e-6, TOX: 9e-9 })) {
        expect(definition.parameters[name].value).toBe(value);
      }
      for (const name of ['VTH', 'K', 'LAMBDA']) {
        expect(Object.hasOwn(definition.parameters, name)).toBe(false);
        expect(definition.equations.some(source => source.startsWith(`${name} =`))).toBe(true);
      }
    }
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
    const customized = clone(BUILTIN_ELEMENTS[0]); customized.parameters.VTO.value = .4;
    const available = elementDefinitions(model([customized]));
    expect(available).toHaveLength(BUILTIN_ELEMENTS.length); expect(available[0].parameters.VTO.value).toBe(.4);
    expect(BUILTIN_ELEMENTS[0].parameters.VTO.value).toBe(.7);
  });

  it('rejects individually valid libraries whose merge exceeds the total limit without damaging prior definitions', () => {
    const first = parseElementLibrary(file(Array.from({ length: 12 }, (_, index) => largeDefinition(`First${index}`))));
    const second = parseElementLibrary(file(Array.from({ length: 12 }, (_, index) => largeDefinition(`Second${index}`))));
    const before = JSON.stringify(first);
    expect(() => mergeElementDefinitions(first, second)).toThrow(/smaller than 1 MB/);
    expect(JSON.stringify(first)).toBe(before);
    expect(elementDefinitions(model(first))).toHaveLength(first.length + BUILTIN_ELEMENTS.length);
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

describe('element library management', () => {
  it('includes terminal aliases in canonical origins independently of key order and empty metadata', () => {
    const originalLength = BUILTIN_ELEMENTS.length;
    BUILTIN_ELEMENTS.push(clone(withAliases));
    try {
      const same = { ...clone(withAliases), terminalAliases: { bulk: 'b', t2: 's', t1: 'd' } };
      expect(elementLibraryEntries(model([same])).find(entry => entry.definition.name === same.name)!.origin).toBe('default');
      same.terminalAliases.t1 = 's';
      expect(elementLibraryEntries(model([same])).find(entry => entry.definition.name === same.name)!.origin).toBe('replacement');
      const empty = { ...clone(gain), name: 'EmptyAliases' }; BUILTIN_ELEMENTS.push(empty);
      expect(elementLibraryEntries(model([{ ...empty, terminalAliases: {} }])).find(entry => entry.definition.name === empty.name)!.origin).toBe('default');
    } finally { BUILTIN_ELEMENTS.splice(originalLength); }
  });

  it('includes terminal default metadata in canonical origins independently of key order', () => {
    const originalLength = BUILTIN_ELEMENTS.length;
    const optional = { ...clone(withBody), terminalDefaults: { b: 's', d: 's' } };
    BUILTIN_ELEMENTS.push(optional);
    try {
      const same = { ...clone(optional), terminalDefaults: { d: 's', b: 's' } };
      expect(elementLibraryEntries(model([same])).find(entry => entry.definition.name === optional.name)!.origin).toBe('default');
      same.terminalDefaults.b = 'g';
      expect(elementLibraryEntries(model([same])).find(entry => entry.definition.name === optional.name)!.origin).toBe('replacement');
      const empty = { ...clone(gain), name: 'EmptyDefaults' }; BUILTIN_ELEMENTS.push(empty);
      expect(elementLibraryEntries(model([{ ...empty, terminalDefaults: {} }])).find(entry => entry.definition.name === empty.name)!.origin).toBe('default');
    } finally { BUILTIN_ELEMENTS.splice(originalLength); }
  });

  it('identifies defaults in fresh configurations and saved builtin snapshots', () => {
    const config = model([]), fresh = elementLibraryEntries(config);
    expect(fresh.map(entry => [entry.definition.name, entry.origin])).toEqual([['NMOSFET', 'default'], ['PMOSFET', 'default']]);
    expect(fresh[0].defaultDefinition).toEqual(BUILTIN_ELEMENTS[0]);
    expect(fresh[0].defaultDefinition).not.toBe(BUILTIN_ELEMENTS[0]);
    fresh[0].defaultDefinition!.parameters.UO.value = 99;
    expect(BUILTIN_ELEMENTS[0].parameters.UO.value).toBe(350);
    config.documents = [{ id: 'devices', title: 'Devices', source: 'element NMOSFET M1' }];
    const restored = loadWorkspace(JSON.parse(JSON.stringify(createWorkspace(config))));
    expect(restored.elementDefinitions).toHaveLength(BUILTIN_ELEMENTS.length);
    expect(elementLibraryEntries(restored)[0].origin).toBe('default');
  });

  it('compares definition content independently of parameter/unknown key order and empty optional fields', () => {
    const originalLength = BUILTIN_ELEMENTS.length;
    const keyed: ElementDefinition = {
      name: 'KeyedDefault', terminals: ['input'], parameters: { a: { value: 1, min: 0, max: 2, step: .1 }, b: { value: 2 } },
      unknowns: { y: 0, z: 1 }, equations: ['output = a*input+b', 'y = 1', 'z = 2'],
    };
    const empty: ElementDefinition = { ...clone(gain), name: 'EmptyDefault' };
    // Include future-style defaults so normalization rules are exercised even
    // though the currently bundled NMOS happens to specify real mode explicitly.
    BUILTIN_ELEMENTS.push(keyed, empty);
    try {
      const equivalent: ElementDefinition = {
        ...clone(keyed), description: '', mode: 'both',
        parameters: { b: { value: 2 }, a: { max: 2, step: .1, min: 0, value: 1 } }, unknowns: { z: 1, y: 0 },
      };
      const entries = elementLibraryEntries(model([equivalent, { ...clone(empty), description: '', mode: 'both', unknowns: {} }]));
      expect(entries.filter(entry => [keyed.name, empty.name].includes(entry.definition.name)).map(entry => entry.origin)).toEqual(['default', 'default']);
      equivalent.parameters.a.value = 1.5;
      expect(elementLibraryEntries(model([equivalent])).find(entry => entry.definition.name === keyed.name)!.origin).toBe('replacement');
    } finally { BUILTIN_ELEMENTS.splice(originalLength); }
  });

  it('distinguishes bundled replacements from independently imported types', () => {
    const customized = clone(BUILTIN_ELEMENTS[0]); customized.parameters.VTO.value = .4;
    const entries = elementLibraryEntries(model([gain, customized]));
    expect(entries.map(entry => [entry.definition.name, entry.origin])).toEqual([['NMOSFET', 'replacement'], ['PMOSFET', 'default'], ['Gain', 'imported']]);
    expect(entries[0].definition.parameters.VTO.value).toBe(.4);
    expect(entries[0].defaultDefinition!.parameters.VTO.value).toBe(.7);
    expect(entries[2].defaultDefinition).toBeUndefined();
  });

  it('replaces a selected type while retaining its name and leaving the imported source model unchanged', () => {
    const current = [clone(gain)], replacement = { ...clone(gain), name: 'CustomTransistor', parameters: { gain: { value: 5 } } };
    const before = JSON.stringify({ current, replacement });
    const replaced = replaceElementDefinition(current, 'NMOSFET', replacement);
    const entries = elementLibraryEntries(model(replaced));
    expect(entries.map(entry => [entry.definition.name, entry.origin])).toEqual([['NMOSFET', 'replacement'], ['PMOSFET', 'default'], ['Gain', 'imported']]);
    expect(entries[0].definition.terminals).toEqual(['input']);
    expect(entries[0].definition.parameters.gain.value).toBe(5);
    expect(entries[2].definition.parameters.gain.value).toBe(2);
    expect(entries.some(entry => entry.definition.name === 'CustomTransistor')).toBe(false);
    expect(JSON.stringify({ current, replacement })).toBe(before);
    expect(() => replaceElementDefinition(current, 'Missing', replacement)).toThrow(/not available/);
    expect(() => replaceElementDefinition(current, '__proto__', replacement)).toThrow(/non-reserved/);
    expect(() => replaceElementDefinition(current, 'Gain', { ...replacement, equations: ['output = missing'] })).toThrow(/not a declared local/);
  });

  it('removes imported types, restores bundled models, and keeps unrelated definitions', () => {
    const custom = clone(BUILTIN_ELEMENTS[0]); custom.parameters.UO.value = 700;
    const current = [clone(gain), custom], before = JSON.stringify(current);
    const restored = removeElementDefinition(current, 'NMOSFET');
    expect(restored.map(entry => entry.name)).toEqual(['Gain']);
    expect(elementLibraryEntries(model(restored)).map(entry => entry.origin)).toEqual(['default', 'default', 'imported']);
    const removed = removeElementDefinition(current, 'Gain');
    expect(removed.map(entry => entry.name)).toEqual(['NMOSFET']);
    expect(elementLibraryEntries(model(removed))[0].origin).toBe('replacement');
    expect(removeElementDefinition(undefined, 'NMOSFET')).toEqual([]);
    expect(removeElementDefinition(current, 'Missing')).toEqual(current);
    expect(JSON.stringify(current)).toBe(before);
  });

  it('retains correct origins and management behavior across workspace save/reload', () => {
    const custom = clone(BUILTIN_ELEMENTS[0]); custom.parameters.VTO.value = .5;
    const config = model([gain, custom]);
    const restored = loadWorkspace(JSON.parse(JSON.stringify(createWorkspace(config))));
    expect(elementLibraryEntries(restored).map(entry => entry.origin)).toEqual(['replacement', 'default', 'imported']);
    restored.elementDefinitions = removeElementDefinition(restored.elementDefinitions, 'NMOSFET');
    const reset = loadWorkspace(JSON.parse(JSON.stringify(createWorkspace(restored))));
    expect(elementLibraryEntries(reset).map(entry => entry.origin)).toEqual(['default', 'default', 'imported']);
    reset.elementDefinitions = removeElementDefinition(reset.elementDefinitions, 'Gain');
    const cleared = loadWorkspace(JSON.parse(JSON.stringify(createWorkspace(reset))));
    expect(elementLibraryEntries(cleared).map(entry => [entry.definition.name, entry.origin])).toEqual([['NMOSFET', 'default'], ['PMOSFET', 'default']]);
  });

  it('rejects oversized replacements before changing the accepted library', () => {
    const current = nearLimitLibrary(BUILTIN_ELEMENTS[0]), before = JSON.stringify(current);
    expect(() => elementDefinitions(model(current))).not.toThrow();
    expect(() => replaceElementDefinition(current, 'NMOSFET', largeDefinition('LargerModel'))).toThrow(/smaller than 1 MB/);
    expect(JSON.stringify(current)).toBe(before);
    expect(elementLibraryEntries(model(current))[0].origin).toBe('default');
  });

  it('rejects restoring a larger builtin when the resulting effective library would exceed the limit', () => {
    const compact: ElementDefinition = { name: 'NMOSFET', terminals: [], parameters: {}, equations: ['output = 1'] };
    const current = nearLimitLibrary(compact), before = JSON.stringify(current);
    expect(elementLibraryEntries(model(current))[0].origin).toBe('replacement');
    expect(() => removeElementDefinition(current, 'NMOSFET')).toThrow(/smaller than 1 MB/);
    expect(JSON.stringify(current)).toBe(before);
    expect(() => elementDefinitions(model(current))).not.toThrow();
  });
});

describe('lazy element expansion', () => {
  it('connects canonical terminals through neutral aliases while keeping both public names', () => {
    const expanded = expandElements(model([withAliases]), [instance('M1', 'WithBody')], [math('M1.g = x'), math('M1.t1 = 2'), math('M1.t2 = 0'), display('plot M1.t1')], []);
    expect(expanded.equations).toEqual([
      'M1.b = M1.s;', 'M1.t1 = M1.d;', 'M1.t2 = M1.s;', 'M1.bulk = M1.b;',
      'M1.output = (((M1.gain * (M1.g - M1.s)) + (M1.d - M1.s)) + (M1.b - M1.s));',
    ]);
    for (const binding of ['M1.bulk = -1', 'body = M1.bulk', 'M1.bulk + offset = 0']) {
      const explicit = expandElements(model([withAliases]), [instance('M1', 'WithBody')], [math('M1.g = x'), math('M1.d = 2'), math('M1.s = 0'), math(binding)], []);
      expect(explicit.equations).not.toContain('M1.b = M1.s;');
      expect(explicit.equations.filter(source => source === 'M1.bulk = M1.b;')).toHaveLength(1);
    }
  });

  it('keeps aliases dormant for guesses and does not treat plots or conditions as connections', () => {
    const config = model([withAliases]), declarations = [instance('M1', 'WithBody')];
    const guess: Variable = { name: 'M1.t1', kind: 'unknown', value: 2 };
    expect(expandElements(config, declarations, [], [guess])).toEqual({ equations: [], variables: [] });
    for (const usage of [display('plot M1.t1'), math('M1.t1 >= 0')]) {
      expect(() => expandElements(config, declarations, [math('M1.g = x'), math('M1.t2 = 0'), usage], [guess])).toThrow(/unconnected terminal: M1\.d/);
    }
    const defaultBody = expandElements(config, declarations, [math('M1.g = x'), math('M1.t1 = 2'), math('M1.t2 = 0'), display('plot M1.bulk'), math('M1.bulk >= -1')], []);
    expect(defaultBody.equations).toContain('M1.b = M1.s;');
    expect(() => expandElements(config, declarations, [], [{ ...guess, kind: 'parameter' }])).toThrow(/terminal or computed member/);
    expect(() => expandElements(config, declarations, [math('M1.T1 = 2')], [])).toThrow(/not a member/);
  });

  it('preserves alias bindings and results through a workspace snapshot', () => {
    const config = model([withAliases]); config.solver.complex = false;
    const source = 'parameter x 1 1 0 2 sweep\nelement WithBody M1\nM1.g = x; M1.t1 = 2; M1.t2 = 0; M1.bulk = -1;\nset_time_axis x\nplot M1.output\nplot M1.t1';
    config.documents = [{ id: 'circuit', title: 'Circuit', source }];
    const snapshot = createWorkspace(config), restored = loadWorkspace(JSON.parse(JSON.stringify(snapshot)));
    expect(snapshot.elements!.find(entry => entry.name === 'WithBody')!.terminalAliases).toEqual(withAliases.terminalAliases);
    expect(restored.documents![0].source).toBe(source);
    const result = sweep(restored);
    expect(result.failures).toEqual([]); expect(result.solved).toBe(3);
    for (const point of result.branches.flatMap(branch => branch.points)) {
      expect(point.values['M1.t1']).toBeCloseTo(point.values['M1.d'], 12);
      expect(point.values['M1.t2']).toBeCloseTo(point.values['M1.s'], 12);
      expect(point.values['M1.bulk']).toBeCloseTo(point.values['M1.b'], 12);
      expect(point.values['M1.output']).toBeCloseTo(2 * point.parameter + 1, 10);
    }
  });

  it('generates an optional body alias only when absent from external mathematical equations', () => {
    const config = model([withBody]), declaration = instance('M1', 'WithBody');
    const wired = [math('M1.g = x'), math('M1.d = 2'), math('M1.s = 0')];
    const fallback = expandElements(config, [declaration], wired, []);
    expect(fallback.equations[0]).toBe('M1.b = M1.s;');
    expect(fallback.equations).toHaveLength(2);
    for (const binding of ['M1.b = -1', 'bulk = M1.b', 'M1.b + bias = 0']) {
      const explicit = expandElements(config, [declaration], [...wired, math(binding)], []);
      expect(explicit.equations).toHaveLength(1);
      expect(explicit.equations.some(source => source.startsWith('M1.b ='))).toBe(false);
    }
    expect(expandElements(config, [declaration], wired, []).equations).toEqual(fallback.equations);
    expect(expandElements(config, [declaration], [], [])).toEqual({ equations: [], variables: [] });
  });

  it('keeps optional defaults active for plot references, validity checks and unknown guesses', () => {
    const config = model([withBody]), declarations = [instance('M1', 'WithBody')];
    const wired = [math('M1.g = x'), math('M1.d = 2'), math('M1.s = 0')];
    const expanded = expandElements(config, declarations, [...wired, display('plot M1.b'), math('M1.b >= -1')], [{ name: 'M1.b', kind: 'unknown', value: -1 }]);
    expect(expanded.equations[0]).toBe('M1.b = M1.s;');
    expect(() => expandElements(config, declarations, [math('M1.g = x'), math('M1.d = 2'), display('plot M1.s')], [])).toThrow(/unconnected terminal: M1\.s/);
    expect(expandElements(config, declarations, [], [{ name: 'M1.b', kind: 'unknown', value: -1 }]).equations).toEqual([]);
  });

  it('qualifies default expressions while preserving functions and builtins', () => {
    const definition = { ...clone(withBody), terminalDefaults: { b: 's + gain*sin(pi)' } };
    const expanded = expandElements(model([definition]), [instance('M1', 'WithBody')], [math('M1.g = x'), math('M1.d = 2'), math('M1.s = 0')], []);
    expect(expanded.equations[0]).toBe('M1.b = (M1.s + (M1.gain * sin(pi)));');
  });

  it('preserves optional terminal behavior and exact source across workspace snapshots', () => {
    const config = model([withBody]);
    config.solver.complex = false;
    const source = 'parameter x 1 1 0 2 sweep\nelement WithBody M1\nM1.g = x; M1.d = 2; M1.s = 0;\nset_time_axis x\nplot M1.output';
    config.documents = [{ id: 'circuit', title: 'Circuit', source }];
    const snapshot = createWorkspace(config), restored = loadWorkspace(JSON.parse(JSON.stringify(snapshot)));
    expect(snapshot.elements!.find(entry => entry.name === 'WithBody')!.terminalDefaults).toEqual({ b: 's' });
    expect(restored.documents![0].source).toBe(source);
    expect(restored.equations).toContain('M1.b = M1.s;');
    const result = sweep(restored);
    expect(result.failures).toEqual([]); expect(result.solved).toBe(3);
    for (const point of result.branches.flatMap(branch => branch.points)) {
      expect(point.values['M1.b']).toBe(0);
      expect(point.values['M1.output']).toBeCloseTo(2 * point.parameter + 2, 10);
    }
  });

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
    const leff = .5e-6 - 2 * .08e-6;
    const k = 350e-4 * (3.9 * 8.854214871e-12 / 9e-9) * 1e-6 / leff;
    expect(last?.values['M1.id']).toBeCloseTo(k / 2 * (1 - .7) ** 2 * (1 + .034e-6 / leff * 2), 12);
    expect(equationProgram(config.equations).conditions.length).toBeGreaterThan(1);
  });

  it('does not mutate accepted source configuration, declarations, usages, or overrides', () => {
    const config = model(), declarations = [instance()], usages = [math('A.input = x')], variables: Variable[] = [{ name: 'A.gain', kind: 'parameter', value: 4 }];
    const before = JSON.stringify({ config, declarations, usages, variables });
    expandElements(config, declarations, usages, variables);
    expect(JSON.stringify({ config, declarations, usages, variables })).toBe(before);
  });
});
