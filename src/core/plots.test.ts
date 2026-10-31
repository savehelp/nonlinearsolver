import { describe, expect, it } from 'vitest';
import { clone, starter } from '../examples';
import { compileDocuments, ensureDocuments, PlotSourceError, syncDocumentVariables } from './documents';
import { prepare, solve, sweep, sweepSteps } from './solver';
import { sliceSweeps } from './variables';
import { createWorkspace, loadWorkspace } from './workspace';
import { createSweepUpdates, mergeSweepUpdate } from './sweepStream';
import type { EditorDocument, SweepResult } from './types';

const tab = (source: string, title = 'Model'): EditorDocument => ({ id: title, title, source });
const inputs = 'unknown y\nparameter x 0 1 -2 2 sweep\ny = 2*x;';
const compile = (source: string) => compileDocuments(clone(starter), [tab(source)]);

describe('source plot commands', () => {
  it('sets X once and derives several curves without changing equations or source text', () => {
    const source = `${inputs}\nset_time_axis x\nplot y # first curve\nplot y^2;`;
    const config = compile(source), result = sweep(config);
    expect(config.axes).toEqual({ x: 'x', y: 'y, y^2' });
    expect(config.equations).toBe('y = 2*x;');
    expect(config.documents![0].source).toBe(source);
    expect(result.total).toBe(5); expect(result.failures).toEqual([]);
    for (const point of result.branches.flatMap(branch => branch.points)) expect(point.ys).toEqual([2 * point.x, 4 * point.x ** 2]);
  });

  it('collects axis and plot commands across tabs independently of declaration order', () => {
    const config = compileDocuments(clone(starter), [
      tab('plot output\nplot max(y, 0)', 'Plots'),
      tab('output = y + 1;\ny = gain*x;\nunknown y', 'Equations'),
      tab('parameter x 0 1 -2 2 sweep\nparameter gain 3\nset_time_axis x', 'Inputs'),
    ]);
    expect(config.axes).toEqual({ x: 'x', y: 'output, max(y, 0)' });
    expect(solve(prepare(config, -2), [], config.solver).values).toMatchObject({ y: -6, output: -5 });
  });

  it('uses the time axis for the main sweep independently of declaration order', () => {
    const source = `${inputs}\nparameter a 1 1 0 2 sweep\nparameter b 0 1 0 2 sweep\nset_time_axis x\nplot y`;
    const before = compile(source), after = compileDocuments(before, [tab(source.replace('set_time_axis x', 'set_time_axis a'))]);
    expect(before.sweep.parameter).toBe('x'); expect(after.sweep.parameter).toBe('a');
    expect(after.axes.x).toBe('a');
    expect(sliceSweeps(after).map(axis => axis.parameter)).toEqual(['x', 'b']);
    expect(after.equations).toBe(before.equations); expect(after.variables).toEqual(before.variables);
  });

  it('reports unswept and unknown X symbols as plotting errors and retains the compiled model', () => {
    for (const [declaration, x] of [['parameter gain 1', 'gain'], ['unknown other', 'other'], ['', 'missing']]) {
      const config = clone(starter), before = structuredClone(config);
      let error: unknown;
      try { compileDocuments(config, [tab(`${inputs}\n${declaration}\nset_time_axis ${x}\nplot y`, 'Plots')]); } catch (reason) { error = reason; }
      expect(error).toBeInstanceOf(PlotSourceError);
      expect((error as PlotSourceError).message).toContain(`“Plots”, line 5: “${x}” must already be selected for a sweep`);
      expect((error as PlotSourceError).config?.equations).toBe('y = 2*x;');
      expect((error as PlotSourceError).config?.variables.some(variable => variable.name === 'x')).toBe(true);
      expect(config).toEqual(before);
    }
    expect(() => compile('parameter x 0 1 -2 2\nunknown y\ny = x;\nset_time_axis x\nplot y')).toThrow('must already be selected for a sweep');
  });

  it('rejects conflicting X declarations and includes the first selection location', () => {
    expect(() => compileDocuments(clone(starter), [
      tab(`${inputs}\nset_time_axis x\nplot y`, 'First'),
      tab('parameter a 1 1 0 2 sweep\n# another axis\nset_time_axis a', 'Second'),
    ])).toThrow('“Second”, line 3: The time axis is already set to “x” in “First”, line 4.');
    expect(compile(`${inputs}\nset_time_axis x; set_time_axis x; plot y`).axes).toEqual({ x: 'x', y: 'y' });
  });

  it('rejects malformed commands, undefined coordinates and invalid expressions', () => {
    for (const command of ['plot', 'plot x y x', 'plot y z', 'plot missing y', 'plot y missing', 'plot missing', 'plot nope(y)', 'plot y,', 'set_time_axis', 'set_time_axis x extra', 'set_time_axis x+1']) {
      expect(() => compile(`${inputs}\nset_time_axis x\n${command}`)).toThrow(PlotSourceError);
    }
    expect(() => compile(`${inputs}\nset_time_axis x\nplot missing`)).toThrow('“missing” is not defined');
    expect(() => compile(`${inputs}\nplot y`)).toThrow('set_time_axis parameter');
  });

  it('mixes time plots and parametric curves while preserving circle traversal order', () => {
    const config = compile('unknown c\nunknown s\nparameter t pi (pi/2) 0 (2*pi) sweep\nc = cos(t);\ns = sin(t);\nset_time_axis t\nplot s c\nplot s\nplot c s');
    expect(config.sweep.parameter).toBe('t');
    expect(config.axes.curves).toEqual([{ x: 'c', y: 's' }, { x: 't', y: 's' }, { x: 's', y: 'c' }]);
    const result = sweep(config);
    expect(result.failures).toEqual([]); expect(result.branches).toHaveLength(1);
    const points = result.branches[0].points;
    expect(points.map(point => point.index)).toEqual([0, 1, 2, 3, 4]);
    points.forEach((point, index) => {
      expect(point.parameter).toBeCloseTo(index * Math.PI / 2, 12);
      expect(point.xs).toEqual([point.values.c, point.parameter, point.values.s]);
      expect(point.ys).toEqual([point.values.s, point.values.s, point.values.c]);
    });
    [1, 0, -1, 0, 1].forEach((value, index) => expect(points[index].x).toBeCloseTo(value, 12));
  });

  it('accepts coordinate expressions and preserves spaced one-expression math', () => {
    const config = compile(`${inputs}\nset_time_axis x\nplot (max(y, 0) * 1000) (y + 1)\nplot sin(x) cos(x)\nplot y * 1000`);
    const result = sweep(config);
    expect(result.failures).toEqual([]);
    for (const point of result.branches.flatMap(branch => branch.points)) {
      expect(point.xs).toEqual([point.values.y + 1, Math.cos(point.parameter), point.parameter]);
      expect(point.ys).toEqual([Math.max(point.values.y, 0) * 1000, Math.sin(point.parameter), point.values.y * 1000]);
    }
  });

  it('isolates invalid X or Y coordinates to the affected curve', () => {
    const config = compile(`${inputs}\nset_time_axis x\nplot y sqrt(x)\nplot sqrt(x) y\nplot y`);
    const result = sweep(config), points = result.branches.flatMap(branch => branch.points);
    expect(result.solved).toBe(5); expect(points).toHaveLength(5); expect(result.failures).toHaveLength(4);
    for (const point of points.filter(point => point.parameter < 0)) {
      expect(point.xs).toEqual([null, point.values.y, point.parameter]);
      expect(point.ys).toEqual([point.values.y, null, point.values.y]);
    }
  });

  it('round-trips mixed curve definitions through source workspaces', () => {
    const config = compile(`${inputs}\nset_time_axis x\nplot y\nplot (y + 1) (y^2)`);
    const file = createWorkspace(config), imported = loadWorkspace(JSON.parse(JSON.stringify(file)));
    expect(imported.axes).toEqual(config.axes); expect(imported.documents).toEqual(config.documents);
    expect(sweep(imported).branches).toEqual(sweep(config).branches);
    expect(createWorkspace(imported)).toEqual(file);
  });

  it('preserves per-curve coordinates when streaming centered sweep updates', () => {
    const config = compile(`${inputs}\nset_time_axis x\nplot y y^2\nplot y`);
    const update = createSweepUpdates(), steps = sweepSteps(config, 0);
    let merged: SweepResult | null = null, step = steps.next();
    while (!step.done) {
      merged = mergeSweepUpdate(merged, update(step.value.result, step.value.completed));
      step = steps.next();
    }
    merged = mergeSweepUpdate(merged, update(step.value.result, step.value.completed));
    expect(merged.branches).toEqual(step.value.result.branches);
    expect(merged.branches[0].points.map(point => point.xs)).toEqual([[16, -2], [4, -1], [0, 0], [4, 1], [16, 2]]);
  });

  it('classifies incomplete plotting syntax without classifying equation errors as plotting', () => {
    for (const statement of ['plot max(y,', 'plot y)', 'set_time_axis (']) {
      expect(() => compile(`${inputs}\n${statement}`)).toThrow(PlotSourceError);
    }
    for (const statement of ['y = sin(', 'unknown broken (', 'parameter gain (']) {
      let error: unknown;
      try { compile(`${inputs}\nplot y\n${statement}`); } catch (reason) { error = reason; }
      expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(PlotSourceError);
    }
  });

  it('validates all model statements before reporting malformed plotting commands', () => {
    let error: unknown;
    try { compile(`${inputs}\nplot\nunknown broken (`); } catch (reason) { error = reason; }
    expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(PlotSourceError);
    expect((error as Error).message).toContain('close every');
  });

  it('accepts expression scaling, constants, multiple targets and multiline expressions', () => {
    const config = compile(`${inputs}\nset_time_axis x\nplot y*1000\nplot y, max(y, 0)\nplot if(\n x > 0,\n y,\n -y\n)\nplot pi`);
    const result = sweep(config);
    expect(result.failures).toEqual([]);
    for (const point of result.branches.flatMap(branch => branch.points)) {
      const expected = [2000 * point.x, 2 * point.x, Math.max(2 * point.x, 0), Math.abs(2 * point.x), Math.PI];
      expected.forEach((value, index) => expect(point.ys[index]).toBeCloseTo(value, 10));
    }
  });

  it('keeps the existing 16-curve limit across every tab and plot command', () => {
    const commands = Array.from({ length: 16 }, (_, index) => `plot y*${index}`).join('\n');
    expect(compile(`${inputs}\nset_time_axis x\n${commands}`).axes.y.split(',')).toHaveLength(16);
    expect(() => compile(`${inputs}\nset_time_axis x\n${commands}\nplot y`)).toThrow('Plot up to 16 Y expressions');
  });

  it('keeps the mathematical model when axis and plot commands are removed', () => {
    const config = compile(`${inputs}\nset_time_axis x\nplot y`), unplotted = compileDocuments(config, [tab(inputs)]);
    expect(unplotted.axes).toEqual({ x: '', y: '' });
    expect(unplotted.equations).toBe(config.equations); expect(unplotted.sweep).toEqual(config.sweep);
    expect(() => prepare(unplotted)).toThrow('Add set_time_axis parameter and plot unknown commands.');
  });

  it('seeds new example syntax and leaves it intact when numeric controls update', () => {
    const config = clone(starter);
    expect(ensureDocuments(config)[0].source).toContain('set_time_axis x\nplot y');
    const before = compileDocuments(config, config.documents!), after = structuredClone(before);
    after.variables.find(variable => variable.name === 'a')!.value = 3;
    syncDocumentVariables(after, before);
    expect(after.documents![0].source).toBe(before.documents![0].source);
    expect(after.documents![1].source).toContain('parameter a 3');
  });

  it('seeds parametric source with Y first and X second', () => {
    const config = clone(starter);
    config.axes.curves = [{ x: 'a', y: 'y' }];
    const documents = ensureDocuments(config);
    expect(documents[0].source).toContain('plot (y) (a)');
    expect(compileDocuments(config, documents).axes.curves).toEqual([{ x: '(a)', y: '(y)' }]);
  });

  it('preserves the configured imposed unknown for constrained sweeps', () => {
    const config = clone(starter);
    Object.assign(config.sweep, { mode: 'constrained', parameter: 'y', release: 'x', min: 0, max: 2, points: 3 });
    const compiled = compileDocuments(config, [tab('unknown y\nparameter x 0\ny = 2*x;\nset_time_axis y\nplot x')]);
    expect(compiled.sweep.mode).toBe('constrained'); expect(compiled.axes).toEqual({ x: 'y', y: 'x' });
    expect(sweep(compiled).branches[0].points.map(point => point.ys)).toEqual([[0], [.5], [1]]);
  });

  it('keeps source sweep selections intact when settings change modes', () => {
    const before = compile(`${inputs}\nparameter gain 2\nset_time_axis x\nplot y`), after = structuredClone(before);
    Object.assign(after.sweep, { mode: 'constrained', parameter: 'y', release: 'gain' });
    syncDocumentVariables(after, before);
    expect(after.documents).toEqual(before.documents);
    expect(() => compileDocuments(after, after.documents!)).toThrow('set_time_axis must select the imposed unknown “y”');
    const compiled = compileDocuments(after, after.documents!.map(document => ({ ...document, source: document.source.replace('set_time_axis x', 'set_time_axis y') })));
    expect(compiled.sweep.parameter).toBe('y'); expect(compiled.sweep.secondary?.parameter).toBe('x');
    expect(compiled.axes).toEqual({ x: 'y', y: 'y' });
  });
});
