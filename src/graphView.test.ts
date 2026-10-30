import { describe, expect, it } from 'vitest';
import { DEFAULT_GRAPH_VIEW, graphAxisRanges } from './graphView';
import type { Point, SweepResult } from './core/types';

function result(points: [number, number | null][], branch = 1): SweepResult {
  return { branches: [{ id: branch, points: points.map(([x, y], index): Point => ({ x, y: y ?? NaN, ys: [y], index, parameter: x, branch,
    values: { x }, residuals: [], jacobian: [], norm: 0, iterations: 0, region: '' })) }],
    failures: [], solved: points.length, total: points.length, elapsed: 0, unknowns: [], equations: [] };
}

describe('graph view ranges', () => {
  it('leaves 100 percent axes on Plotly autorange and scales axes independently', () => {
    const source = result([[0, -10], [10, 10]]);
    expect(graphAxisRanges(source, null, null, DEFAULT_GRAPH_VIEW)).toEqual({ x: undefined, y: undefined });
    expect(graphAxisRanges(source, null, null, { ...DEFAULT_GRAPH_VIEW, xScale: 200 })).toEqual({ x: [2.5, 7.5], y: undefined });
    expect(graphAxisRanges(source, null, null, { ...DEFAULT_GRAPH_VIEW, yScale: 50 })).toEqual({ x: undefined, y: [-20, 20] });
  });

  it('honors the current branch filter while including the compatible overlay', () => {
    const source = result([[0, 0], [10, 10]]);
    source.branches.push(...result([[-100, -100], [100, 100]], 2).branches);
    const overlay = result([[-10, -20], [10, 20]], 7), view = { ...DEFAULT_GRAPH_VIEW, xScale: 200, yScale: 200 };
    expect(graphAxisRanges(source, overlay, 1, view)).toEqual({ x: [-5, 5], y: [-10, 10] });
    expect(graphAxisRanges(source, null, 2, view)).toEqual({ x: [-50, 50], y: [-50, 50] });
  });

  it('ignores points with no finite visible coordinate pair and fits empty data safely', () => {
    const source = result([[0, 0], [10, 10], [1000, null], [Infinity, 500], [50, NaN]]);
    const view = { ...DEFAULT_GRAPH_VIEW, xScale: 200, yScale: 200 };
    expect(graphAxisRanges(source, null, null, view)).toEqual({ x: [2.5, 7.5], y: [2.5, 7.5] });
    expect(graphAxisRanges(null, null, null, view)).toEqual({ x: undefined, y: undefined });
  });

  it('adds usable padding to constant curves and includes every finite Y series', () => {
    const source = result([[3, 0], [3, 0]]);
    source.branches[0].points[1].ys.push(20);
    const ranges = graphAxisRanges(source, null, null, { ...DEFAULT_GRAPH_VIEW, xScale: 200, yScale: 200 });
    expect(ranges).toEqual({ x: [2.5, 3.5], y: [5, 15] });
  });

  it('keeps very large ranges finite, including when shrinking a wide curve', () => {
    const ranges = graphAxisRanges(result([[-1e308, -1e308], [1e308, 1e308]]), null, null, { ...DEFAULT_GRAPH_VIEW, xScale: 25, yScale: 400 });
    expect(ranges.x).toEqual([-Number.MAX_VALUE, Number.MAX_VALUE]);
    expect(ranges.y).toEqual([-2.5e307, 2.5e307]);
    const constant = graphAxisRanges(result([[Number.MAX_VALUE, Number.MAX_VALUE]]), null, null, { ...DEFAULT_GRAPH_VIEW, xScale: 25, yScale: 25 });
    expect(constant.x!.every(Number.isFinite)).toBe(true); expect(constant.x![0]).toBeLessThan(constant.x![1]);
  });
});
