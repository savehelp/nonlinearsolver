import { describe, expect, it } from 'vitest';
import { clone, starter } from '../examples';
import { compileDocuments } from './documents';
import { createWorkspace, loadWorkspace } from './workspace';
import { sliceSweeps } from './variables';
import { prepare, solve } from './solver';

function model() {
  return compileDocuments(clone(starter), [
    { id: 'inputs', title: 'Inputs', source: '# keep this spacing\nparameter a (1 + 1) 1 0 3 sweep\n\nunknown y 1\n# end\n' },
    { id: 'model', title: 'Equations', source: 'y = a*x + b; # relation\nparameter x 0 1 -2 2 sweep\nunknown z\nz = y * 2;\nset_time_axis x\nplot y\n' },
    { id: 'bias', title: 'Bias', source: '# mixed tab\nparameter b 0 1 0 1 sweep\ny >= -10;\nplot z' },
  ]);
}

describe('source workspace format', () => {
  it('stores source once and preserves tab IDs, names, order, locations and exact text', () => {
    const config = model(), file = createWorkspace(config);
    expect(file.format).toBe('nonlinear-workbench'); expect(file.version).toBe(2);
    expect(Object.keys(file)).toEqual(['format', 'version', 'name', 'description', 'tabs', 'settings']);
    expect(file).not.toHaveProperty('variables'); expect(file).not.toHaveProperty('equations');
    expect(file.settings).not.toHaveProperty('axes');
    expect(file.settings.sweep).toEqual({ mode: 'free', parameter: 'x' });
    const imported = loadWorkspace(JSON.parse(JSON.stringify(file)));
    expect(imported.documents).toEqual(config.documents);
    expect(createWorkspace(imported)).toEqual(file);
    expect(imported.variables).toEqual(config.variables);
    expect(imported.axes).toEqual(config.axes);
    expect(imported.sweep).toEqual(config.sweep);
    expect(sliceSweeps(imported).map(sweep => sweep.parameter)).toEqual(['a', 'b']);
    expect(solve(prepare(imported, 2), [], imported.solver).values).toMatchObject({ y: 4, z: 8 });
  });

  it('does not allow duplicate engine fields to override source tabs', () => {
    const file = createWorkspace(model());
    const imported = loadWorkspace({ ...file, equations: 'y = 999;', variables: [{ name: 'a', value: 999 }], settings: { ...file.settings, axes: { x: 'b', y: '999' } } });
    expect(solve(prepare(imported, 2), [], imported.solver).values.y).toBe(4);
    expect(imported.axes).toEqual(model().axes);
  });

  it('retains comments, blank tabs and incomplete drafts through repeated round trips', () => {
    const config = model();
    config.documents![1].source += 'unknown unfinished (\n';
    config.documents!.push({ id: 'blank', title: 'Scratch', source: '\n# notes only\n\n' });
    const file = createWorkspace(config), imported = loadWorkspace(file);
    expect(imported.documents).toEqual(config.documents);
    expect(imported.variables).toEqual([]);
    expect(() => compileDocuments(imported, imported.documents!)).toThrow('Equations');
    expect(createWorkspace(loadWorkspace(JSON.parse(JSON.stringify(createWorkspace(imported)))))).toEqual(file);
  });

  it('preserves constrained sweeps, released parameters, slices, axes and solver options', () => {
    const config = clone(starter);
    Object.assign(config.sweep, { mode: 'constrained', parameter: 'y', release: 'x', min: .1, max: 10, points: 7, logarithmic: true });
    config.solver = { tolerance: 1e-11, starts: 20, iterations: 200 };
    const compiled = compileDocuments(config, [{ id: 'all', title: 'All', source: 'unknown y\nparameter x 0\nparameter a 1 1 0 2 sweep\ny = a + x;\nset_time_axis y\nplot x\nplot x^2' }]);
    const file = createWorkspace(compiled), imported = loadWorkspace(file);
    expect(imported.sweep).toEqual(compiled.sweep);
    expect(imported.axes).toEqual(compiled.axes); expect(imported.solver).toEqual(config.solver);
    expect(solve(prepare(imported, 2), [], imported.solver).values).toMatchObject({ y: 2, x: 1 });
    expect(createWorkspace(imported)).toEqual(file);
  });

  it('rejects unversioned and previous workspace JSON formats', () => {
    expect(() => loadWorkspace(clone(starter))).toThrow('not a nonlinear workbench workspace');
    expect(() => loadWorkspace(model())).toThrow('not a nonlinear workbench workspace');
    expect(() => loadWorkspace({ ...createWorkspace(model()), version: 1 })).toThrow('Unsupported workspace version');
  });

  it('preserves optional complex mode without changing existing real workspace settings', () => {
    const config = model(), original = createWorkspace(config);
    expect(loadWorkspace(original).solver).not.toHaveProperty('complex');
    for (const complex of [true, false]) {
      config.solver.complex = complex;
      const file = createWorkspace(config), imported = loadWorkspace(JSON.parse(JSON.stringify(file)));
      expect(imported.solver.complex).toBe(complex);
      expect(createWorkspace(imported)).toEqual(file);
      expect(imported.documents).toEqual(config.documents);
    }
  });

  it('rejects unknown versions, malformed tabs and invalid settings with useful messages', () => {
    const file = createWorkspace(model());
    for (const value of [null, [], 'text']) expect(() => loadWorkspace(value)).toThrow('workspace JSON object');
    expect(() => loadWorkspace({ ...file, version: 3 })).toThrow('Unsupported workspace version');
    expect(() => loadWorkspace({ ...file, format: 'other' })).toThrow('not a nonlinear');
    expect(() => loadWorkspace({ ...file, name: null })).toThrow('name and description');
    for (const tabs of [[], [file.tabs[0], file.tabs[0]], [{ ...file.tabs[0], source: 123 }], [{ ...file.tabs[0], source: 'x'.repeat(200_001) }]]) {
      expect(() => loadWorkspace({ ...file, tabs })).toThrow();
    }
    for (const settings of [null,
      { ...file.settings, solver: { tolerance: Infinity, iterations: 10, starts: 1 } },
      { ...file.settings, solver: { tolerance: 1e-9, iterations: '10', starts: 1 } },
      { ...file.settings, solver: { tolerance: 1e-9, iterations: 100, starts: 12, complex: 'true' } },
      { ...file.settings, solver: { tolerance: 1e-9, iterations: 100, starts: 12, complex: null } },
      { ...file.settings, sweep: { mode: 'other', parameter: 'x' } },
      { ...file.settings, sweep: { mode: ['constrained'], parameter: 'x' } },
      { ...file.settings, sweep: { mode: 'constrained', parameter: 'y', release: 'x', min: 0, max: 1, points: '5', logarithmic: true } }]) {
      expect(() => loadWorkspace({ ...file, settings })).toThrow();
    }
  });

  it('preserves finite settings that still need correction instead of discarding the workspace', () => {
    const file = createWorkspace(model());
    file.settings.solver = { tolerance: -1, iterations: 0, starts: 2.5 };
    file.settings.sweep = { mode: 'constrained', parameter: 'y', release: 'x', min: 2, max: 1, points: 1, logarithmic: true };
    expect(createWorkspace(loadWorkspace(JSON.parse(JSON.stringify(file))))).toEqual(file);
  });

  it('copies imported and exported tabs so callers cannot mutate the live workspace', () => {
    const config = model(), file = createWorkspace(config), imported = loadWorkspace(file);
    file.tabs[0].source = 'changed'; file.settings.solver.tolerance = 1e-3;
    expect(imported.documents).toEqual(config.documents);
    expect(imported.axes).toEqual(config.axes);
    expect(imported.solver).toEqual(config.solver);
  });
});
