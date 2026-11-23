import { describe, expect, it } from 'vitest';
import { clone, starter } from '../examples';
import { compileDocuments, syncDocumentVariables } from './documents';
import { configForCombination, multiSweepPlan } from './doubleSweep';
import { sweep } from './solver';
import { createWorkspace, loadWorkspace } from './workspace';

function compile(source: string) {
  return compileDocuments(clone(starter), [{ id: 'model', title: 'Model', source }]);
}

describe('parameter expressions in sweep bounds', () => {
  it('uses each outer sample for the main range, including after a workspace round trip', () => {
    const config = loadWorkspace(createWorkspace(compile(`
parameter vin 0 .5 0 Vdd sweep
parameter Vdd 2 1 1 3 sweep
y = vin;
set_time_axis vin
plot y
`)));
    const plan = multiSweepPlan(config);
    expect(plan.totalSamples).toBe(15);
    for (let index = 0; index < plan.totalSlices; index++) {
      const values = plan.valuesAt(index), result = sweep(configForCombination(config, values));
      expect(result.total).toBe(1 + values.Vdd * 2);
      expect(result.solved).toBe(result.total);
      expect(Math.max(...result.branches.flatMap(branch => branch.points.map(point => point.parameter)))).toBe(values.Vdd);
    }
  });

  it('reevaluates a fixed parameter bound without rewriting the expression', () => {
    const before = compile('parameter vin 0 .5 0 (Vdd / 2) sweep\nparameter Vdd 2 .5 1 4\ny=vin;\nset_time_axis vin\nplot y');
    const next = clone(before);
    next.variables.find(variable => variable.name === 'Vdd')!.value = 4;
    syncDocumentVariables(next, before);
    const compiled = compileDocuments(next, next.documents!);
    expect(compiled.documents![0].source).toContain('(Vdd / 2)');
    expect(sweep(compiled).total).toBe(5);
  });

  it('reports cycles and rejects bounds that use solved values', () => {
    expect(() => compile('parameter a 0 1 0 b sweep\nparameter b 0 1 0 a sweep')).toThrow(/circular sweep bound/);
    expect(() => compile('parameter a 0 1 0 a sweep')).toThrow(/circular sweep bound/);
    expect(() => compile('unknown y 1\nparameter vin 0 1 0 y sweep')).toThrow(/can only reference parameters/);
  });

  it('validates the range at outer samples beyond the starting slice', () => {
    const config = compile('parameter vin 0 1 0 Vdd sweep\nparameter Vdd 1 1 0 2 sweep\ny=vin;\nset_time_axis vin\nplot y');
    expect(() => multiSweepPlan(config)).toThrow(/increasing parameter range.*Vdd = 0/);
  });
});
