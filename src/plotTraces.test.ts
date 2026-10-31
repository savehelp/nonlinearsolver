import { describe, expect, it } from 'vitest';
import { BRANCH_TRACE_THRESHOLD, branchTraces } from './plotTraces';
import type { Branch, Point } from './core/types';

interface Trace {
  x: (number | null)[]; y: (number | null)[]; customdata?: (Point | null)[]; text?: string[];
  mode: string; connectgaps: boolean; name: string; legendgroup?: string; showlegend: boolean;
  line: { color: string }; hovertemplate?: string;
}
function point(branch: number, index: number, y: number | null = index): Point {
  return { branch, index, parameter: index, x: index, y: y ?? NaN, ys: [y, index * 2], values: { x: index, y: y ?? NaN }, residuals: [0], norm: 0, iterations: 1, jacobian: [[1]], region: '' };
}
const tracesFor = (branches: Branch[], labels = ['y']) => branchTraces(branches, labels, 'x') as unknown as Trace[];

describe('bounded branch plot traces', () => {
  it('preserves small branch traces', () => {
    const p = point(42, 3), traces = tracesFor([{ id: 42, points: [p] }]);
    expect(traces).toHaveLength(1); expect(traces[0].mode).toBe('markers');
    expect(traces[0].customdata).toEqual([p]); expect(traces[0].customdata![0]).toBe(p);
    expect(traces[0].hovertemplate).toContain('Branch 42'); expect(traces[0].showlegend).toBe(false);
  });

  it('uses each curve\'s X coordinates without sorting a parametric loop', () => {
    const xs = [1, 0, -1, 0, 1], ys = [0, 1, 0, -1, 0];
    const points = xs.map((x, index) => ({ ...point(1, index), x, xs: [x, index === 2 ? null : index * 10], ys: [ys[index], index * 2] }));
    const traces = branchTraces([{ id: 1, points }], ['sin(t) vs cos(t)', 'z vs a'], ['cos(t)', 'a'], ['sin(t)', 'z']) as unknown as Trace[];
    expect(traces[0].x).toEqual(xs); expect(traces[0].y).toEqual(ys);
    expect(traces[1].x).toEqual([0, 10, null, 30, 40]); expect(traces[1].y).toEqual([0, 2, 4, 6, 8]);
    expect(traces.map(trace => trace.name)).toEqual(['sin(t) vs cos(t)', 'z vs a']);
    expect(traces[0].hovertemplate).toContain('cos(t): %{x');
    expect(traces[0].hovertemplate).toContain('sin(t): %{y');
    expect(traces[1].hovertemplate).toContain('a: %{x');
    expect(traces.every(trace => trace.connectgaps === false)).toBe(true);
    expect(traces[0].customdata![2]).toBe(points[2]);
  });

  it('labels a single parametric curve with both coordinates', () => {
    const traces = branchTraces([{ id: 4, points: [point(4, 0)] }], ['v vs u'], ['u'], ['v']) as unknown as Trace[];
    expect(traces[0].name).toBe('v vs u'); expect(traces[0].showlegend).toBe(true);
    expect(traces[0].hovertemplate).toContain('u: %{x'); expect(traces[0].hovertemplate).toContain('v: %{y');
  });

  it('retains every singleton point and its click/hover branch identity in at most 16 traces', () => {
    const branches = Array.from({ length: 50000 }, (_, index) => ({ id: index + 1, points: [point(index + 1, index)] }));
    const traces = tracesFor(branches);
    expect(traces).toHaveLength(16);
    expect(traces.every(trace => trace.mode === 'markers' && trace.connectgaps === false)).toBe(true);
    const byIndex = new Map<number, Point>();
    for (const trace of traces) {
      expect(trace.x.length).toBe(trace.y.length); expect(trace.x.length).toBe(trace.customdata!.length);
      expect(trace.hovertemplate).toContain('<extra>%{text}</extra>');
      trace.customdata!.forEach((p, index) => {
        expect(p).not.toBeNull(); expect(trace.text![index]).toBe(`Branch ${p!.branch}`);
        byIndex.set(p!.index, p!);
      });
    }
    expect(byIndex.size).toBe(50000);
    for (const index of [0, 27, 49999]) expect(byIndex.get(index)).toBe(branches[index].points[0]);
  });

  it('separates disjoint line branches and preserves existing null Y gaps', () => {
    const branches = Array.from({ length: BRANCH_TRACE_THRESHOLD + 1 }, (_, index) => ({ id: index + 1,
      points: [point(index + 1, index * 10), point(index + 1, index * 10 + 1, null), point(index + 1, index * 10 + 2)] }));
    const traces = tracesFor(branches);
    expect(traces.length).toBeLessThanOrEqual(16);
    let points = 0, separators = 0;
    for (const trace of traces) {
      expect(trace.mode).toBe('lines'); expect(trace.connectgaps).toBe(false);
      trace.customdata!.forEach((p, index) => {
        if (p === null) { separators++; expect(trace.x[index]).toBeNull(); expect(trace.y[index]).toBeNull(); }
        else {
          points++; expect(trace.y[index]).toBe(p.ys[0]);
          if (index && trace.customdata![index - 1] !== null) expect(trace.customdata![index - 1]!.branch).toBe(p.branch);
        }
      });
    }
    expect(points).toBe(branches.length * 3); expect(separators).toBe(branches.length - traces.length);
  });

  it('keeps marker and line groups separate with one legend item per Y expression', () => {
    const branches = Array.from({ length: 160 }, (_, index) => ({ id: index + 1, points: index % 2
      ? [point(index + 1, index)] : [point(index + 1, index), point(index + 1, index + 1)] }));
    const traces = tracesFor(branches, ['y', '2*y']);
    expect(traces).toHaveLength(4);
    expect(traces.filter(trace => trace.showlegend).map(trace => trace.name)).toEqual(['y', '2*y']);
    for (const label of ['y', '2*y']) {
      const group = traces.filter(trace => trace.legendgroup === label);
      expect(group.map(trace => trace.mode).sort()).toEqual(['lines', 'markers']);
      expect(new Set(group.map(trace => trace.line.color)).size).toBe(1);
    }
  });

  it('retains per-curve X gaps and hover labels when combining fragmented branches', () => {
    const branches = Array.from({ length: BRANCH_TRACE_THRESHOLD + 1 }, (_, index) => ({ id: index + 1,
      points: [0, 1, 2].map(sample => ({ ...point(index + 1, sample), xs: [sample, sample === 1 ? null : -sample] })) }));
    const traces = branchTraces(branches, ['y vs x', 'z vs -x'], ['x', '-x'], ['y', 'z']) as unknown as Trace[];
    expect(traces).toHaveLength(2);
    const second = traces.find(trace => trace.name === 'z vs -x')!;
    expect(second.hovertemplate).toContain('-x: %{x'); expect(second.hovertemplate).toContain('z: %{y');
    second.customdata!.forEach((p, index) => {
      if (!p) { expect(second.x[index]).toBeNull(); expect(second.y[index]).toBeNull(); }
      else expect(second.x[index]).toBe(p.xs![1]);
    });
    expect(second.connectgaps).toBe(false);
  });

});
