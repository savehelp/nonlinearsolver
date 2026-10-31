import { describe, expect, it } from 'vitest';
import { clone, defaultWorkspace, rcLowPass, starter } from '../examples';
import { compileDocuments, ensureDocuments } from './documents';
import { prepare, roots, sweep, sweepSteps } from './solver';
import { projectSweep, solverConfiguration } from './projection';
import { SampleReuseCache, prepareSweepReuse } from './sampleReuse';
import { withPointJacobian } from './pointDiagnostics';
import { modelDiagnostics } from './diagnostics';
import { createWorkspace, loadWorkspace } from './workspace';
import { createSweepUpdates, mergeSweepUpdate } from './sweepStream';
import type { Configuration, SweepResult } from './types';

function model(source: string): Configuration {
  const config = clone(starter); config.solver.complex = true;
  return compileDocuments(config, [{ id: 'model', title: 'Model', source }]);
}
const circle = 'parameter t pi (pi/2) 0 (2*pi) sweep\nz = exp(i*t);\nset_time_axis t\nplot imag(z) real(z)\nplot abs(z)';

describe('complex workspaces and real plotting', () => {
  it('loads the RC frequency-response example and matches its analytic transfer function', () => {
    expect(defaultWorkspace).toBe(rcLowPass);
    const example = clone(rcLowPass), config = compileDocuments(example, ensureDocuments(example)), result = sweep(config);
    expect(config.solver.complex).toBe(true); expect(config.sweep.parameter).toBe('f');
    expect(result.total).toBe(401); expect(result.failures).toEqual([]); expect(result.branches).toHaveLength(1);
    for (const point of result.branches[0].points) {
      const ratio = 2 * Math.PI * point.parameter * 1000 * 100e-9;
      expect(point.complexValues!.H.re).toBeCloseTo(1 / (1 + ratio * ratio), 8);
      expect(point.complexValues!.H.im).toBeCloseTo(-ratio / (1 + ratio * ratio), 8);
      // Conversion to dB/degrees amplifies the solver's voltage tolerance.
      expect(point.ys[0]).toBeCloseTo(-10 * Math.log10(1 + ratio * ratio), 6);
      expect(point.ys[1]).toBeCloseTo(-Math.atan(ratio) * 180 / Math.PI, 5);
      expect(point.x).toBe(point.parameter);
    }
    const cutoff = 1 / (2 * Math.PI * 1000 * 100e-9), found = roots(prepare(config, cutoff), config.solver).roots;
    expect(found).toHaveLength(1);
    const root = found[0];
    expect(root.complexValues!.H.re).toBeCloseTo(.5, 9);
    expect(root.complexValues!.H.im).toBeCloseTo(-.5, 9);
    expect(root.complexValues!.gain_dB.re).toBeCloseTo(-10 * Math.log10(2), 8);
    expect(root.complexValues!.phase_deg.re).toBeCloseTo(-45, 8);
  });

  it('draws complex trajectories in time order with Y-first coordinate expressions', () => {
    const config = model(circle), result = sweep(config);
    expect(result.failures).toEqual([]); expect(result.branches).toHaveLength(1);
    result.branches[0].points.forEach((point, index) => {
      expect(point.parameter).toBeCloseTo(index * Math.PI / 2, 12);
      expect(point.xs![0]).toBeCloseTo(Math.cos(point.parameter), 12);
      expect(point.ys[0]).toBeCloseTo(Math.sin(point.parameter), 12);
      expect(point.xs![1]).toBe(point.parameter); expect(point.ys[1]).toBeCloseTo(1, 12);
      expect(point.complexValues!.z.re).toBeCloseTo(Math.cos(point.parameter), 12);
      expect(point.complexValues!.z.im).toBeCloseTo(Math.sin(point.parameter), 12);
      expect(point.values.t).toBe(point.parameter);
    });
    const inspected = withPointJacobian(config, result.branches[0].points[1]);
    expect(inspected.complexValues).toEqual(result.branches[0].points[1].complexValues);
    expect(inspected.jacobian).toHaveLength(inspected.diagnosticEquations!.length);
    expect(inspected.diagnosticUnknowns!.every(name => name === 'real(z)' || name === 'imag(z)')).toBe(true);
  });

  it('isolates complex plot coordinates without silently dropping imaginary parts', () => {
    const config = model('parameter t 0 1 0 1 sweep\nz = sqrt(-1);\nset_time_axis t\nplot z\nplot abs(z) z\nplot imag(z)');
    const result = sweep(config), points = result.branches.flatMap(branch => branch.points);
    expect(result.solved).toBe(2); expect(points).toHaveLength(2); expect(result.failures).toHaveLength(4);
    for (const point of points) {
      expect(point.ys).toEqual([null, 1, 1]);
      expect(point.xs).toEqual([point.parameter, null, point.parameter]);
    }
    expect(result.failures.every(failure => failure.reason.includes('must be real'))).toBe(true);
  });

  it('keeps parameter declarations real and implicit imaginary constants opt-in', () => {
    expect(() => model('parameter t complex(1,2) 1 0 2 sweep\nz = t;\nset_time_axis t\nplot abs(z)')).toThrow();
    const config = model('parameter t 0 1 0 1 sweep\nz = j;\nset_time_axis t\nplot imag(j)\nplot abs(z)');
    expect(sweep(config).branches[0].points[0].ys).toEqual([1, 1]);
    const disabled = clone(config); disabled.solver.complex = false;
    const realModel = compileDocuments(disabled, disabled.documents!);
    expect(() => prepare(realModel)).toThrow('Underdetermined');
  });

  it('round-trips mode and exact source text through saved workspaces', () => {
    const config = model(circle), file = createWorkspace(config), restored = loadWorkspace(JSON.parse(JSON.stringify(file)));
    expect(restored.solver.complex).toBe(true); expect(restored.axes).toEqual(config.axes);
    expect(restored.documents).toEqual(config.documents); expect(createWorkspace(restored)).toEqual(file);
    expect(sweep(restored).branches).toEqual(sweep(config).branches);
  });

  it('retains complex roots through raw projection, resampling reuse, and streamed updates', () => {
    const config = model(circle), rawConfig = solverConfiguration(config), raw = sweep(rawConfig);
    const data = prepareSweepReuse(rawConfig, { config: rawConfig, slices: [{ values: {}, result: raw }] });
    expect(data).toBeDefined();
    const cache = new SampleReuseCache(rawConfig, data), update = createSweepUpdates();
    const steps = sweepSteps(rawConfig, 0, undefined, cache.forConfig(rawConfig));
    let merged: SweepResult | null = null, step = steps.next();
    while (!step.done) { merged = mergeSweepUpdate(merged, update(step.value.result, step.value.completed)); step = steps.next(); }
    merged = mergeSweepUpdate(merged, update(step.value.result, step.value.completed));
    expect(merged.computed).toBe(0); expect(merged.reused).toBe(5);
    expect(merged.branches).toEqual(raw.branches);
    expect(projectSweep(merged, config).branches).toEqual(sweep(config).branches);
  });

  it('uses the imposed real component for default constrained plot coordinates', () => {
    const config = clone(starter); config.solver.complex = true;
    Object.assign(config.sweep, { mode: 'constrained', parameter: 'z', release: 'gain', min: 1, max: 3, points: 3 });
    const compiled = compileDocuments(config, [{ id: 'model', title: 'Model', source: 'unknown z\nparameter gain 1\nz = gain + i;\nset_time_axis z\nplot imag(z)' }]);
    const result = sweep(compiled);
    expect(result.failures).toEqual([]);
    for (const point of result.branches.flatMap(branch => branch.points)) {
      expect(point.x).toBeCloseTo(point.parameter, 8); expect(point.y).toBeCloseTo(1, 8);
      expect(point.values.gain).toBeCloseTo(point.parameter, 8);
    }
    const diagnostics = modelDiagnostics(compiled);
    expect(diagnostics.issue).toBeUndefined();
  });
});
