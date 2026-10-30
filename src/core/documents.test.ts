import { describe, expect, it } from 'vitest';
import { clone, starter, validateImport } from '../examples';
import { compileDocuments, ensureDocuments, syncDocumentVariables, validateDocuments } from './documents';
import { prepare, solve } from './solver';
import type { EditorDocument } from './types';

const document = (source: string, title = 'Model', id = title): EditorDocument => ({ source, title, id });

describe('mixed editor documents', () => {
  it('migrates legacy definitions into one shared tab without changing the model', () => {
    const config = clone(starter), before = clone(config);
    const documents = ensureDocuments(config);
    expect(documents.map(document => document.title)).toEqual(['Equations', 'Definitions']);
    expect(documents[1].source).toContain('unknown y 1');
    expect(documents[1].source).toContain('parameter x 0 0.1 -5 5 sweep');
    expect(ensureDocuments(config)).toBe(documents);
    const compiled = compileDocuments(config, documents);
    expect(compiled.variables).toEqual(before.variables);
    expect(compiled.sweep.parameter).toBe('x');
    expect(compiled.equations).toBe(before.equations);
  });

  it('compiles declarations, equations, derived assignments and validity in the same tab', () => {
    const config = clone(starter), source = '# Entire model\nunknown y 1\nparameter x 2 1 0 4 sweep\nparameter gain (1 + 1)\ny^2 = gain*x;\ntwice = 2*y;\ny >= 0;';
    const compiled = compileDocuments(config, [document(source)]);
    expect(compiled.variables.map(variable => variable.name)).toEqual(['y', 'x', 'gain']);
    const root = solve(prepare(compiled, 2), [1], compiled.solver);
    expect(root.values.y).toBeCloseTo(2, 7); expect(root.values.twice).toBeCloseTo(4, 7);
    expect(compiled.documents![0].source).toBe(source);
    expect(config).toEqual(starter);
  });

  it('shares one global namespace across any organizational tab layout', () => {
    const config = compileDocuments(clone(starter), [
      document('unknown y\nparameter gain 3', 'Inputs'),
      document('parameter x 1 1 0 2 sweep\ny = gain*x;', 'Relationships'),
      document('output = y + 1;\nvalid output > 0;', 'Outputs'),
    ]);
    const root = solve(prepare(config, 2), [], config.solver);
    expect(root.values).toMatchObject({ x: 2, gain: 3, y: 6, output: 7 });
  });

  it('preserves multiline math and parenthesized declaration options with comments', () => {
    const config = compileDocuments(clone(starter), [document('# first line\nunknown y 1; parameter x (1 +\n 1) 1 0 4 sweep;\ny = if(\n x > 0, # active branch\n x*2,\n 0\n);')]);
    expect(solve(prepare(config, 2), [], config.solver).values.y).toBe(4);
    expect(config.variables.find(variable => variable.name === 'x')!.value).toBe(2);
  });

  it('keeps legacy newline-separated math tabs usable', () => {
    const config = compileDocuments(clone(starter), [document('unknown y\nparameter x 1 1 0 2 sweep\ny = x\noutput = y*2')]);
    expect(config.equations).toBe('y = x;\noutput = y*2;');
  });

  it('reports duplicate names with both tab names and source line numbers', () => {
    expect(() => compileDocuments(clone(starter), [document('# comments\nunknown y', 'A'), document('# comments\n\nparameter y', 'B')])).toThrow('“B”, line 3: “y” is already declared in “A”, line 2.');
  });

  it('reports incomplete declarations and math at their tab and line', () => {
    expect(() => compileDocuments(clone(starter), [document('# comment\nunknown', 'Inputs')])).toThrow('“Inputs”, line 2');
    expect(() => compileDocuments(clone(starter), [document('# comment\ny = x;\ny +', 'Broken')])).toThrow('“Broken”: Line 3: end each equation');
    expect(() => compileDocuments(clone(starter), [document('unknown y\ny = sin(1;', 'Broken')])).toThrow('“Broken”: Line 2: close every');
    expect(() => compileDocuments(clone(starter), [document('unknown y\ny = nope(1);', 'Broken')])).toThrow('“Broken”, line 2: Unknown function');
  });

  it('clears deleted declarations and sweep suffixes while retaining a still-marked main sweep', () => {
    const before = clone(starter);
    let next = compileDocuments(before, [document('unknown y\nparameter a 1 1 0 2 sweep\nparameter x 0 1 0 2 sweep\ny = x + a;')]);
    expect(next.sweep.parameter).toBe('x'); expect(next.sweep.secondary!.parameter).toBe('a');
    next = compileDocuments(next, [document('unknown y\nparameter a\ny = a;')]);
    expect(next.sweep.parameter).toBe(''); expect(next.sweep.secondary).toBeUndefined();
    expect(next.variables.map(variable => variable.name)).toEqual(['y', 'a']);
  });

  it('allows declarations to change kind atomically across tabs', () => {
    const next = compileDocuments(clone(starter), [document('parameter y 2 1 0 4 sweep\nunknown x 1\nx^2 = y;')]);
    expect(next.variables.find(variable => variable.name === 'y')!.kind).toBe('parameter');
    expect(next.variables.find(variable => variable.name === 'x')!.kind).toBe('unknown');
  });

  it('validates bounded source size, tab shape and unique stable IDs', () => {
    for (const value of [[], null, [document('', '', 'a')], [document('', 'A', 'x'), document('', 'B', 'x')], [document('x'.repeat(200_001))], Array.from({ length: 33 }, (_, index) => document('', String(index)))]) {
      expect(() => validateDocuments(value)).toThrow();
    }
  });
});

describe('document persistence and controls', () => {
  it('imports source tabs as authoritative while preserving their names and formatting', () => {
    const config = clone(starter);
    config.documents = [document('unknown y\nparameter x 2 1 0 4 sweep\ny = x*3;', 'Custom model', 'stable')];
    const imported = validateImport(JSON.parse(JSON.stringify(config)));
    expect(imported.documents).toEqual(config.documents);
    expect(imported.variables.find(variable => variable.name === 'x')!.value).toBe(2);
    expect(solve(prepare(imported, 2), [], imported.solver).values.y).toBe(6);
  });

  it('preserves invalid drafts through import with the accepted model intact', () => {
    const config = clone(starter);
    config.documents = [document('parameter x (', 'Draft')];
    const imported = validateImport(JSON.parse(JSON.stringify(config)));
    expect(imported.documents).toEqual(config.documents);
    expect(imported.variables).toEqual(config.variables);
    expect(() => compileDocuments(imported, imported.documents!)).toThrow('“Draft”');
    expect(() => validateImport({ ...config, documents: [] })).toThrow('editor tabs');
  });

  it('updates a slider value in place while preserving comments, expressions and organization', () => {
    const before = compileDocuments(clone(starter), [document('# inputs\nparameter x 1 1 0 4 sweep\nparameter gain (1 + 1) .5 0 5 # preserve me\nunknown y 1\ny = x*gain;', 'Circuit')]);
    const next = structuredClone(before); next.variables.find(variable => variable.name === 'gain')!.value = 3;
    syncDocumentVariables(next, before);
    expect(next.documents![0].source).toContain('parameter gain 3 .5 0 5 # preserve me');
    expect(next.documents![0].source).toContain('# inputs'); expect(next.documents![0].title).toBe('Circuit');
    expect(next.documents![0].source).toContain('y = x*gain;');
  });

  it('inserts an omitted default and rewrites changed range fields without losing a comment', () => {
    const before = compileDocuments(clone(starter), [document('parameter gain # default\nunknown y\ny = gain;')]);
    const next = structuredClone(before); Object.assign(next.variables[1], { value: 2, step: .5, min: 0, max: 3 });
    syncDocumentVariables(next, before);
    expect(next.documents![0].source).toContain('parameter gain 2 0.5 0 3 # default');
  });

  it('preserves unrelated invalid draft declarations when a different control changes', () => {
    const before = compileDocuments(clone(starter), [document('unknown y\nparameter x 1 1 0 4 sweep\nparameter gain 2\ny = gain*x;')]);
    before.documents![0].source = before.documents![0].source.replace('unknown y', 'unknown y 10') + '\nunknown broken (';
    const next = structuredClone(before); next.variables.find(variable => variable.name === 'gain')!.value = 3;
    syncDocumentVariables(next, before);
    // An unclosed statement leaves this whole tab untouched, preserving the draft.
    expect(next.documents![0].source).toBe(before.documents![0].source);
  });

  it('keeps unchanged numeric expression spellings when another declaration changes', () => {
    const before = compileDocuments(clone(starter), [document('unknown y\nparameter x 1 1 0 4 sweep\nparameter gain (2 * pi)\ny = gain*x;')]);
    const next = structuredClone(before); next.variables.find(variable => variable.name === 'x')!.value = 2;
    syncDocumentVariables(next, before);
    expect(next.documents![0].source).toContain('parameter gain (2 * pi)');
    expect(next.documents![0].source).toContain('parameter x 2 1 0 4 sweep');
  });
});
