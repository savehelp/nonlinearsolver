import { describe, expect, it } from 'vitest';
import { clone, starter } from '../examples';
import { compileDocuments, ensureDocuments, PlotSourceError, syncDocumentVariables } from './documents';
import { inferVariables } from './inference';
import { modelDiagnostics } from './diagnostics';
import { sweep } from './solver';
import { evaluateTransitionLines } from './transitions';
import { createWorkspace, loadWorkspace } from './workspace';
import type { Configuration, EditorDocument } from './types';

const tab = (source: string, title = 'Model'): EditorDocument => ({ id: title, title, source });
const compile = (source: string, complex = false) => {
  const config = clone(starter);
  config.solver.complex = complex;
  return compileDocuments(config, [tab(source)]);
};
const plottedModel = 'parameter t 0 1 -2 2 sweep\ny = 2*t;\nset_time_axis t\nplot y';

describe('source transition lines', () => {
  it('uses X for a vertical line and Y for a horizontal line without requiring a curve', () => {
    const config = compile('plot_x_transition 2\nplot_y_transition -3');
    expect(config.axes).toEqual({
      x: '', y: '', transitions: [{ axis: 'x', expression: '2' }, { axis: 'y', expression: '-3' }],
    });
    expect(evaluateTransitionLines(config)).toEqual([
      { axis: 'x', value: 2, expression: '2' },
      { axis: 'y', value: -3, expression: '-3' },
    ]);
    expect(config.equations).toBe('');
    expect(inferVariables(config)).toEqual([]);
    expect(modelDiagnostics(config).issue).toBeUndefined();
  });

  it('accepts real constant arithmetic, mathematical constants and bounded fixed parameters', () => {
    const config = compile('parameter level 2 .5 -4 4\nplot_x_transition (2*pi)\nplot_y_transition level + sqrt(9)');
    const lines = evaluateTransitionLines(config);
    expect(lines.map(line => line.axis)).toEqual(['x', 'y']);
    expect(lines[0].value).toBeCloseTo(2 * Math.PI, 12);
    expect(lines[1].value).toBe(5);
  });

  it('resolves fixed parameter assignments transitively and independently of tab order', () => {
    const config = compileDocuments(clone(starter), [
      tab('plot_x_transition cutoff_Hz\nplot_y_transition twice', 'Graph'),
      tab('twice = 2*cutoff_Hz;\ncutoff_Hz = 1/(2*pi*R*C);', 'Derived'),
      tab('parameter R 1000\nparameter C 100e-9', 'Inputs'),
    ]);
    const lines = evaluateTransitionLines(config);
    expect(lines[0]).toMatchObject({ axis: 'x', expression: 'cutoff_Hz' });
    expect(lines[0].value).toBeCloseTo(1 / (2 * Math.PI * 1000 * 100e-9), 10);
    expect(lines[1].value).toBeCloseTo(2 * lines[0].value, 10);
    expect(config.equations).toBe('twice = 2*cutoff_Hz;\ncutoff_Hz = 1/(2*pi*R*C);');
    expect(config.variables.map(variable => variable.name)).toEqual(['R', 'C']);
  });

  it('honors comments, semicolons and parenthesized multiline expressions', () => {
    const source = '# reference lines\nparameter limit 3; plot_x_transition (\n limit + # offset\n 2\n); plot_y_transition -1 # baseline\n';
    const config = compile(source);
    expect(evaluateTransitionLines(config).map(({ axis, value }) => ({ axis, value }))).toEqual([
      { axis: 'x', value: 5 }, { axis: 'y', value: -1 },
    ]);
    expect(config.documents![0].source).toBe(source);
    expect(config.equations).toBe('');
    expect(inferVariables(config).map(variable => variable.name)).toEqual(['limit']);
  });

  it('keeps transition directives out of equations and ordinary curve counting', () => {
    const curves = Array.from({ length: 16 }, (_, index) => `plot y*${index}`).join('\n');
    const transitions = Array.from({ length: 32 }, (_, index) => `plot_${index % 2 ? 'y' : 'x'}_transition ${index}`).join('\n');
    const config = compile(`parameter t 0 1 -2 2 sweep\ny = 2*t;\nset_time_axis t\n${curves}\n${transitions}`);
    expect(config.axes.y.split(',')).toHaveLength(16);
    expect(config.axes.transitions).toHaveLength(32);
    expect(config.equations).toBe('y = 2*t;');
    expect(inferVariables(config).map(variable => variable.name)).toEqual(['t', 'y']);
    expect(sweep(config).failures).toEqual([]);
  });

  it('limits transition lines across all tabs separately from the curve limit', () => {
    const lines = Array.from({ length: 32 }, (_, index) => `plot_x_transition ${index}`).join('\n');
    expect(compile(lines).axes.transitions).toHaveLength(32);
    expect(() => compileDocuments(clone(starter), [tab(lines, 'First'), tab('plot_y_transition 0', 'Second')])).toThrow(PlotSourceError);
    expect(() => compile(`${plottedModel}\n${Array.from({ length: 16 }, () => 'plot y').join('\n')}\nplot_y_transition 0`)).toThrow('Plot up to 16 Y expressions');
  });

  it('reports empty, malformed and incomplete transition commands as plotting errors', () => {
    for (const command of [
      'plot_x_transition', 'plot_y_transition # blank', 'plot_x_transition 1 2',
      'plot_y_transition 1, 2', 'plot_x_transition x = 2',
      'plot_y_transition sin(', 'plot_x_transition 1)', 'plot_y_transition nope(2)',
    ]) {
      expect(() => compile(command), command).toThrow(PlotSourceError);
    }
  });

  it('retains the compiled model and source location when a transition is invalid', () => {
    const input = clone(starter), before = structuredClone(input);
    let error: unknown;
    try {
      compileDocuments(input, [tab(`${plottedModel}\n# reference\nplot_x_transition missing`, 'Graph')]);
    } catch (reason) { error = reason; }
    expect(error).toBeInstanceOf(PlotSourceError);
    expect((error as Error).message).toContain('Graph');
    expect((error as Error).message).toContain('line 6');
    expect((error as PlotSourceError).config?.equations).toBe('y = 2*t;');
    expect(input).toEqual(before);
  });

  it('removes deleted transition directives while preserving the mathematical model', () => {
    const source = `${plottedModel}\nplot_x_transition 1\nplot_y_transition 0`;
    const before = compile(source), after = compileDocuments(before, [tab(plottedModel)]);
    expect(after.axes.transitions ?? []).toEqual([]);
    expect(after.equations).toBe(before.equations);
    expect(after.variables).toEqual(before.variables);
    expect(evaluateTransitionLines(after)).toEqual([]);
  });

  it('round-trips exact transition source and evaluated values through workspace JSON', () => {
    const config = compileDocuments(clone(starter), [
      tab('plot_x_transition threshold # vertical\nplot_y_transition -3', 'References'),
      tab('parameter threshold (1 + 1)', 'Inputs'),
    ]);
    const file = createWorkspace(config), imported = loadWorkspace(JSON.parse(JSON.stringify(file)));
    expect(imported.documents).toEqual(config.documents);
    expect(imported.axes).toEqual(config.axes);
    expect(evaluateTransitionLines(imported)).toEqual(evaluateTransitionLines(config));
    expect(createWorkspace(imported)).toEqual(file);
  });

  it('seeds reference line source from configurations without editor documents', () => {
    const config = clone(starter);
    config.axes.transitions = [{ axis: 'x', expression: 'a + 1' }, { axis: 'y', expression: '0' }];
    const documents = ensureDocuments(config);
    expect(documents[0].source).toContain('plot_x_transition a + 1');
    expect(documents[0].source).toContain('plot_y_transition 0');
    expect(compileDocuments(config, documents).axes.transitions).toEqual(config.axes.transitions);
  });

  it('recomputes parameter-only references after numeric controls change without editing commands', () => {
    const before = compile('parameter level 2 .5 -4 4\nthreshold = level*2;\nplot_x_transition threshold # keep\nplot_y_transition level');
    const next = structuredClone(before);
    next.variables.find(variable => variable.name === 'level')!.value = 3;
    syncDocumentVariables(next, before);
    expect(next.documents![0].source).toContain('parameter level 3 .5 -4 4');
    expect(next.documents![0].source).toContain('plot_x_transition threshold # keep\nplot_y_transition level');
    expect(evaluateTransitionLines(next).map(line => line.value)).toEqual([6, 3]);
    expect(evaluateTransitionLines(compileDocuments(next, next.documents!))).toEqual(evaluateTransitionLines(next));
  });
});

describe('constant transition evaluation', () => {
  it('folds nested arithmetic and functions through fixed assignment chains', () => {
    const config = compile('parameter a 3\nparameter b 2\nradius = sqrt(pow(a, 2) + pow(b + 2, 2));\nlevel = max(radius, min(10, 8));\nplot_x_transition level + log10(100)\nplot_y_transition floor(pi) + cos(0)');
    expect(evaluateTransitionLines(config).map(line => line.value)).toEqual([10, 4]);
  });

  it('folds fixed conditions before resolving if and ternary branches in either solver mode', () => {
    for (const complex of [false, true]) {
      const config = compile(`${plottedModel}\nparameter choice 2\nthreshold = if(choice > 1, (2 + 3)^2, y);\nplot_x_transition if((1 + 1) == 2, threshold, t)\nplot_y_transition false ? t : threshold + 1`, complex);
      expect(evaluateTransitionLines(config).map(line => line.value)).toEqual([25, 26]);
    }
  });

  it('short-circuits fixed logical conditions without requiring unused unknown values', () => {
    for (const complex of [false, true]) {
      const config = compile(`${plottedModel}\nplot_x_transition (2 < 1) && t\nplot_y_transition (2 > 1) || missing`, complex);
      expect(evaluateTransitionLines(config).map(line => line.value)).toEqual([0, 1]);
      expect(inferVariables(config).some(variable => variable.name === 'missing')).toBe(false);
    }
  });

  it('ignores invalid domains and circular references only in unused branches', () => {
    for (const complex of [false, true]) {
      const config = compile('a = if(true, sqrt(25), b);\nb = a + 1;\nplot_x_transition a\nplot_y_transition if(false, 1/0, 3)', complex);
      expect(evaluateTransitionLines(config).map(line => line.value)).toEqual([5, 3]);
    }
  });

  it('rejects undefined names without inferring new mathematical unknowns', () => {
    expect(() => evaluateTransitionLines(compile('plot_x_transition missing'))).toThrow();
    const config = compile(plottedModel);
    config.axes.transitions = [{ axis: 'y', expression: 'missing' }];
    expect(() => evaluateTransitionLines(config)).toThrow();
    expect(inferVariables(config).some(variable => variable.name === 'missing')).toBe(false);
  });

  it('rejects direct or indirect dependencies on unknowns and the time sweep', () => {
    for (const expression of ['y', 't', 'threshold']) {
      expect(() => evaluateTransitionLines(compile(`${plottedModel}\nthreshold = y + 1;\nplot_x_transition ${expression}`)), expression).toThrow();
    }
  });

  it('rejects unknown dependencies in selected branches and algebraic cancellations', () => {
    for (const complex of [false, true]) for (const expression of [
      'if(false, 4, t)', 'if(true, y, 4)', 'true ? t : 5', 'true && t', 'false || y',
      't - t', 'y - y', '0*t', 't^0',
    ]) {
      expect(() => compile(`${plottedModel}\nplot_x_transition ${expression}`, complex), expression).toThrow();
    }
  });

  it('rejects every selected secondary and additional sweep dimension', () => {
    const inputs = 'parameter t 0 1 0 2 sweep\nparameter a 1 1 0 2 sweep\nparameter b 1 1 0 2 sweep\ny = t + a + b;\nset_time_axis t\nplot y';
    for (const expression of ['a', 'b', 'limit']) {
      expect(() => evaluateTransitionLines(compile(`${inputs}\nlimit = a + b;\nplot_y_transition ${expression}`)), expression).toThrow();
    }
  });

  it('does not use a solved sample to treat an unknown coordinate as a constant', () => {
    const config = compile(plottedModel), result = sweep(config);
    config.axes.transitions = [{ axis: 'x', expression: 'y' }];
    expect(() => evaluateTransitionLines(config, result)).toThrow();
  });

  it('rejects cyclic fixed assignments instead of evaluating an arbitrary initial value', () => {
    expect(() => evaluateTransitionLines(compile('a = b + 1;\nb = a - 1;\nplot_x_transition a'))).toThrow();
  });

  it('rejects nonfinite constants and values outside the real domain', () => {
    for (const expression of ['1/0', '0/0', 'sqrt(-1)', 'exp(1000)']) {
      expect(() => evaluateTransitionLines(compile(`plot_y_transition ${expression}`)), expression).toThrow();
    }
  });

  it('preserves invalid intermediate domains while folding active operations', () => {
    for (const complex of [false, true]) for (const expression of [
      '0*(1/0)', '(1/0) > 0', 'if(1/0, 2, 3)', '0/(1/0)', '!(1/0)', '(1/0)^0',
    ]) {
      expect(() => compile(`plot_x_transition ${expression}`, complex), expression).toThrow();
    }
  });

  it('accepts complex intermediates when the final coordinate is explicitly real', () => {
    const config = compile('z = 2 + 3*i;\nplot_x_transition abs(z)\nplot_y_transition real(z)', true);
    const lines = evaluateTransitionLines(config);
    expect(lines[0].value).toBeCloseTo(Math.sqrt(13), 12);
    expect(lines[1].value).toBe(2);
  });

  it('rejects a nonreal coordinate in complex mode and accepts zero imaginary parts', () => {
    expect(() => evaluateTransitionLines(compile('plot_x_transition 2 + 3*i', true))).toThrow();
    expect(evaluateTransitionLines(compile('plot_x_transition complex(2, 0)', true))).toEqual([
      { axis: 'x', value: 2, expression: 'complex(2, 0)' },
    ]);
  });

  it('does not mutate configuration while evaluating references', () => {
    const config: Configuration = compile('parameter limit 2\ntwice = limit*2;\nplot_x_transition twice');
    const before = structuredClone(config);
    evaluateTransitionLines(config);
    expect(config).toEqual(before);
  });
});
