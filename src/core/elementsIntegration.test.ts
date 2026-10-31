import { describe, expect, it } from 'vitest';
import { clone, starter } from '../examples';
import { compileDocuments, syncDocumentVariables } from './documents';
import { createElementLibrary, parseElementLibrary, type ElementDefinition } from './elements';
import { inspectConstants } from './constants';
import { createWorkspace, loadWorkspace } from './workspace';
import { prepare, roots, sweep } from './solver';
import type { Configuration, EditorDocument } from './types';

const tab = (source: string, title = 'Circuit'): EditorDocument => ({ id: title, title, source });
function compile(source: string | EditorDocument[], definitions?: ElementDefinition[], complex = false): Configuration {
  const config = clone(starter);
  config.solver.complex = complex;
  if (definitions) config.elementDefinitions = definitions;
  return compileDocuments(config, typeof source === 'string' ? [tab(source)] : source);
}

const circuit = `# A resistor-loaded transistor instance
element NMOSFET M1
parameter vin 0 .5 0 2 sweep
parameter Vdd 3.3
parameter Rd 1000
M1.g = vin;
M1.s = 0;
M1.d = Vdd - M1.id*Rd;
set_time_axis vin
plot M1.id
plot M1.d`;

const gain: ElementDefinition = parseElementLibrary({ format: 'nonlinear-elements', version: 1, elements: [{
  name: 'Gain', mode: 'both', description: 'A user-supplied gain model.', terminals: ['input'], parameters: { gain: { value: 2 } },
  equations: ['output = gain*input'],
}] })[0];

describe('element workspaces and solver integration', () => {
  it('sweeps a resistor-loaded NMOS and matches its analytic saturation current and KCL', () => {
    const config = compile(circuit), result = sweep(config);
    expect(result.solved).toBe(5); expect(result.total).toBe(5); expect(result.failures).toEqual([]);
    const points = result.branches.flatMap(branch => branch.points);
    expect(points).toHaveLength(5);
    for (const point of points) {
      const overdrive = Math.max(0, point.parameter - .7), coefficient = .001 / 2 * overdrive ** 2;
      const expected = coefficient * (1 + .02 * 3.3) / (1 + coefficient * .02 * 1000);
      expect(point.values['M1.id']).toBeCloseTo(expected, 9);
      expect(point.values['M1.d']).toBeCloseTo(3.3 - point.values['M1.id'] * 1000, 7);
      expect(point.values['M1.s']).toBe(0);
      expect(point.values['M1.g']).toBeCloseTo(point.parameter, 10);
      expect(point.ys).toEqual([point.values['M1.id'], point.values['M1.d']]);
    }
    const constants = inspectConstants(config);
    expect(constants.parameters).toEqual(expect.arrayContaining([
      { name: 'M1.VTH', value: .7 }, { name: 'M1.K', value: .001 }, { name: 'M1.LAMBDA', value: .02 },
    ]));
    expect(constants.parameters.some(entry => entry.name === 'vin' || entry.name === 'M1.id')).toBe(false);
  });

  it('resolves instance declarations across tabs and keeps two devices independent', () => {
    const config = compile([
      tab(`parameter vin 1.5 .5 0 2 sweep
parameter M2.VTH 1
parameter M2.K .002
M1.g = vin; M1.s = 0; M1.d = 3.3;
M2.g = vin; M2.s = 0; M2.d = 3.3;
set_time_axis vin
plot M1.id
plot M2.id`, 'Connections'),
      tab('element NMOSFET M2\nelement NMOSFET M1', 'Devices'),
    ]);
    const found = roots(prepare(config, 1.5), config.solver);
    expect(found.error).toBe(''); expect(found.roots).toHaveLength(1);
    const values = found.roots[0].values;
    expect(values['M1.id']).toBeCloseTo(.001 / 2 * .8 ** 2 * 1.066, 10);
    expect(values['M2.id']).toBeCloseTo(.002 / 2 * .5 ** 2 * 1.066, 10);
    expect(values['M1.VTH']).toBe(.7); expect(values['M2.VTH']).toBe(1);
    expect(config.variables.filter(variable => variable.name === 'M2.K')).toHaveLength(1);
  });

  it('materializes an edited default as a source override that survives compilation and saving', () => {
    const before = compile(circuit), changed = structuredClone(before);
    changed.variables.find(variable => variable.name === 'M1.VTH')!.value = 1.1;
    syncDocumentVariables(changed, before);
    expect(changed.documents![0].source).toContain('parameter M1.VTH 1.1');
    expect(before.documents![0].source).toBe(circuit);
    const recompiled = compileDocuments(changed, changed.documents!);
    expect(recompiled.variables.filter(variable => variable.name === 'M1.VTH')).toEqual([{ name: 'M1.VTH', kind: 'parameter', value: 1.1 }]);
    const file = createWorkspace(recompiled), restored = loadWorkspace(JSON.parse(JSON.stringify(file)));
    expect(file.elements?.some(definition => definition.name === 'NMOSFET')).toBe(true);
    expect(restored.documents).toEqual(recompiled.documents);
    expect(restored.variables.find(variable => variable.name === 'M1.VTH')?.value).toBe(1.1);
    expect(sweep(restored).solved).toBe(5);
  });

  it('uses a qualified device parameter as the real traversal axis', () => {
    const config = compile(`element NMOSFET M1
parameter M1.VTH .5 .25 .5 1.5 sweep
M1.g = 2; M1.s = 0; M1.d = 3.3;
set_time_axis M1.VTH
plot M1.id`);
    expect(config.sweep.parameter).toBe('M1.VTH');
    expect(config.axes.x).toBe('M1.VTH');
    const result = sweep(config);
    expect(result.solved).toBe(5); expect(result.failures).toEqual([]);
    for (const point of result.branches.flatMap(branch => branch.points)) {
      expect(point.values['M1.VTH']).toBe(point.parameter);
      expect(point.values['M1.id']).toBeCloseTo(.001 / 2 * (2 - point.parameter) ** 2 * 1.066, 10);
    }
    expect(inspectConstants(config).parameters.some(entry => entry.name === 'M1.VTH')).toBe(false);
  });

  it('loads a generic JSON model, snapshots its equations, and solves after a workspace roundtrip', () => {
    const definitions = parseElementLibrary(JSON.parse(JSON.stringify(createElementLibrary([gain]))));
    const config = compile(`# Keep user source exact
parameter t 0 1 -1 1 sweep
element Gain A1
A1.input = t;
set_time_axis t
plot A1.output`, definitions);
    const file = createWorkspace(config), restored = loadWorkspace(JSON.parse(JSON.stringify(file)));
    expect(file.elements?.find(definition => definition.name === 'Gain')).toEqual(gain);
    expect(restored.documents).toEqual(config.documents);
    expect(createWorkspace(restored)).toEqual(file);
    const result = sweep(restored);
    expect(result.solved).toBe(3); expect(result.failures).toEqual([]);
    expect(result.branches.flatMap(branch => branch.points).every(point => point.values['A1.output'] === 2 * point.parameter)).toBe(true);
  });

  it('removes generated equations and defaults when the final instance reference disappears', () => {
    const active = compile(circuit);
    const source = 'element NMOSFET M1\nparameter vin 0 .5 0 2 sweep\ny = vin;\nset_time_axis vin\nplot y';
    const dormant = compileDocuments(active, [tab(source)]);
    expect(dormant.equations).toBe('y = vin;');
    expect(dormant.variables.some(variable => variable.name.startsWith('M1.'))).toBe(false);
    expect(sweep(dormant).solved).toBe(5);
    expect(dormant.documents![0].source).toBe(source);
  });

  it('reports unconnected plot-only instances, undeclared instances, typo fields, and incompatible modes', () => {
    expect(() => compile('element NMOSFET M1\nparameter vin 0 1 0 2 sweep\nset_time_axis vin\nplot M1.id')).toThrow(/unconnected terminals.*M1\.g.*M1\.d.*M1\.s/);
    expect(() => compile('parameter vin 0 1 0 2 sweep\nset_time_axis vin\nplot Missing.id')).toThrow(/Missing.*not declared/);
    expect(() => compile(circuit.replace('M1.g =', 'M1.gaet ='))).toThrow(/M1\.gaet.*not a member/);
    expect(() => compile(circuit, undefined, true)).toThrow(/requires real mode/);
  });

  it('uses a user-supplied both-mode model with complex unknowns and real plot projections', () => {
    const config = compile(`element Gain A1
parameter t 0 1 0 2 sweep
A1.input = complex(t, 1);
set_time_axis t
plot real(A1.output)
plot imag(A1.output)`, [gain], true);
    const result = sweep(config);
    expect(result.solved).toBe(3); expect(result.failures).toEqual([]);
    for (const point of result.branches.flatMap(branch => branch.points)) {
      expect(point.complexValues?.['A1.output']).toEqual({ re: 2 * point.parameter, im: 2 });
      expect(point.ys).toEqual([2 * point.parameter, 2]);
    }
  });

  it('preserves input configuration and exact source on successful and failed element compilation', () => {
    const config = clone(starter), documents = [tab(circuit)], oldConfig = structuredClone(config), oldDocuments = structuredClone(documents);
    const compiled = compileDocuments(config, documents);
    expect(config).toEqual(oldConfig); expect(documents).toEqual(oldDocuments);
    expect(compiled.documents).toEqual(documents);
    expect(() => compileDocuments(config, [tab(circuit.replace('M1.g = vin;', ''))])).toThrow(/unconnected terminal/);
    expect(config).toEqual(oldConfig);
  });
});
