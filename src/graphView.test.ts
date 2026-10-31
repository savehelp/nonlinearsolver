import { describe, expect, it } from 'vitest';
import { DEFAULT_GRAPH_VIEW, fitGraphBounds, graphAxisRanges, normalizeGraphView, validGraphBounds } from './graphView';
import type { GraphBounds } from './graphView';
import type { Point, SweepResult } from './core/types';
import type { TransitionLine } from './transitionLines';

function result(points: [number, number | null][], branch = 1): SweepResult {
  return { branches: [{ id: branch, points: points.map(([x, y], index): Point => ({ x, y: y ?? NaN, ys: [y], index, parameter: x, branch,
    values: { x }, residuals: [], jacobian: [], norm: 0, iterations: 0, region: '' })) }],
    failures: [], solved: points.length, total: points.length, elapsed: 0, unknowns: [], equations: [] };
}

function transition(axis: 'x' | 'y', value: number): TransitionLine {
  return { axis, value, expression: String(value) };
}

function expectBounds(actual: GraphBounds, expected: GraphBounds) {
  for (const key of ['xMin', 'xMax', 'yMin', 'yMax'] as const) expect(actual[key]).toBeCloseTo(expected[key]);
}

describe('graph view ranges', () => {
  it('uses exact manual bounds even when curves and reference lines are outside them', () => {
    const view = { ...DEFAULT_GRAPH_VIEW, autoscale: false, xMin: 2, xMax: 4, yMin: -3, yMax: 7 };
    const source = result([[-100, -500], [1000, 1000]]);
    const transitions = [transition('x', -1e6), transition('y', 1e6)];
    expect(graphAxisRanges(source, view, transitions)).toEqual({ x: [2, 4], y: [-3, 7] });
    expect(graphAxisRanges(null, view)).toEqual({ x: [2, 4], y: [-3, 7] });
  });

  it('lets Plotly autoscale normal curves independently of stored manual bounds', () => {
    const view = { ...DEFAULT_GRAPH_VIEW, xMin: 200, xMax: 400, yMin: 300, yMax: 500 };
    expect(graphAxisRanges(result([[0, -10], [10, 10]]), view, [transition('x', 30)])).toEqual({ x: undefined, y: undefined });
  });

  it('fits reference-only graphs without adding an artificial coordinate on the other axis', () => {
    expect(graphAxisRanges(null, DEFAULT_GRAPH_VIEW, [transition('x', 30)])).toEqual({ x: [28.5, 31.5], y: undefined });
    expect(graphAxisRanges(null, DEFAULT_GRAPH_VIEW, [transition('y', -10)])).toEqual({ x: undefined, y: [-11, -9] });
    expect(graphAxisRanges(null, DEFAULT_GRAPH_VIEW, [transition('x', 30), transition('y', -10)])).toEqual({ x: [28.5, 31.5], y: [-11, -9] });
  });

  it('ignores nonfinite reference values and treats all-gap curves as reference-only', () => {
    const source = result([[1000, null], [Infinity, 5], [8, NaN]]);
    expect(graphAxisRanges(source, DEFAULT_GRAPH_VIEW, [transition('x', 0), transition('y', Infinity), transition('x', NaN)])).toEqual({ x: [-1, 1], y: undefined });
    expect(graphAxisRanges(null, DEFAULT_GRAPH_VIEW)).toEqual({ x: undefined, y: undefined });
  });
});

describe('fitting graph bounds', () => {
  it('fits every branch rather than just the first solution', () => {
    const source = result([[0, 0], [10, 10]]);
    source.branches.push(...result([[-100, -200], [100, 200]], 2).branches);
    expectBounds(fitGraphBounds(source), { xMin: -110, xMax: 110, yMin: -220, yMax: 220 });
  });

  it('uses all finite per-curve coordinate pairs while preserving gaps', () => {
    const source = result([[9999, 9999], [10000, 10000], [500, null]]);
    Object.assign(source.branches[0].points[0], { xs: [null, -20], ys: [9999, 2] });
    Object.assign(source.branches[0].points[1], { xs: [NaN, 40], ys: [10000, 10] });
    Object.assign(source.branches[0].points[2], { xs: [500, 400], ys: [null, null] });
    expectBounds(fitGraphBounds(source), { xMin: -23, xMax: 43, yMin: 1.6, yMax: 10.4 });
  });

  it('does not fall back to the legacy x coordinate when a curve x is null', () => {
    const source = result([[1e6, 1e6]]);
    Object.assign(source.branches[0].points[0], { xs: [null], ys: [1e6] });
    expect(fitGraphBounds(source)).toEqual({ xMin: -1, xMax: 1, yMin: -1, yMax: 1 });
  });

  it('fits every finite Y series sharing a legacy x coordinate', () => {
    const source = result([[3, 0], [3, 0]]);
    source.branches[0].points[1].ys.push(20);
    expectBounds(fitGraphBounds(source), { xMin: 2, xMax: 4, yMin: -1, yMax: 21 });
  });

  it('expands only the relevant axis for each reference line', () => {
    const source = result([[0, 0], [10, 10]]);
    expectBounds(fitGraphBounds(source, [transition('x', 30)]), { xMin: -1.5, xMax: 31.5, yMin: -.5, yMax: 10.5 });
    expectBounds(fitGraphBounds(source, [transition('y', -10)]), { xMin: -.5, xMax: 10.5, yMin: -11, yMax: 11 });
  });

  it('pads constant coordinates and supplies a usable default for missing axes', () => {
    expect(fitGraphBounds(result([[0, 0]]))).toEqual({ xMin: -1, xMax: 1, yMin: -1, yMax: 1 });
    expect(fitGraphBounds(null, [transition('x', 100)])).toEqual({ xMin: 95, xMax: 105, yMin: -1, yMax: 1 });
    expect(fitGraphBounds(null)).toEqual({ xMin: -1, xMax: 1, yMin: -1, yMax: 1 });
  });

  it('keeps extremely wide and constant finite coordinates finite and ordered', () => {
    const wide = fitGraphBounds(result([[-Number.MAX_VALUE, -1e308], [Number.MAX_VALUE, 1e308]]));
    expect(wide.xMin).toBe(-Number.MAX_VALUE);
    expect(wide.xMax).toBe(Number.MAX_VALUE);
    expect(wide.yMin / 1e308).toBeCloseTo(-1.1, 12);
    expect(wide.yMax / 1e308).toBeCloseTo(1.1, 12);
    expect(validGraphBounds(wide)).toBe(true);
    const constant = fitGraphBounds(result([[Number.MAX_VALUE, -Number.MAX_VALUE]]));
    expect(validGraphBounds(constant)).toBe(true);
    expect(constant.xMax).toBe(Number.MAX_VALUE);
    expect(constant.yMin).toBe(-Number.MAX_VALUE);
  });
});

describe('graph preferences', () => {
  it('accepts only finite and strictly ordered manual bounds', () => {
    expect(validGraphBounds(DEFAULT_GRAPH_VIEW)).toBe(true);
    for (const bounds of [
      { ...DEFAULT_GRAPH_VIEW, xMin: 1, xMax: 1 },
      { ...DEFAULT_GRAPH_VIEW, yMin: 5, yMax: -5 },
      { ...DEFAULT_GRAPH_VIEW, xMax: Infinity },
      { ...DEFAULT_GRAPH_VIEW, yMin: NaN },
    ]) expect(validGraphBounds(bounds)).toBe(false);
  });

  it('roundtrips manual bounds and autoscale while resetting the session revision', () => {
    const saved = { autoscale: false, xMin: -7, xMax: 20, yMin: 1e-12, yMax: 3e-9, revision: 42 };
    expect(normalizeGraphView(JSON.parse(JSON.stringify(saved)))).toEqual({ ...saved, revision: 0 });
    expect(normalizeGraphView({ ...saved, autoscale: true }).autoscale).toBe(true);
  });

  it('recovers malformed axis pairs independently and keeps valid preferences', () => {
    expect(normalizeGraphView({ autoscale: false, xMin: 5, xMax: 5, yMin: 4, yMax: 8 })).toEqual({ ...DEFAULT_GRAPH_VIEW, autoscale: false, yMin: 4, yMax: 8 });
    expect(normalizeGraphView({ autoscale: 'false', xMin: -8, xMax: 8, yMin: -Infinity, yMax: 4, revision: -1 })).toEqual({ ...DEFAULT_GRAPH_VIEW, xMin: -8, xMax: 8 });
    expect(normalizeGraphView({ xMin: '-2', xMax: 2, yMin: 3, yMax: NaN })).toEqual(DEFAULT_GRAPH_VIEW);
  });

  it('migrates legacy percentage settings and empty preferences to autoscale defaults', () => {
    for (const saved of [undefined, null, false, 12, '', [], {}, { xScale: 400, yScale: 25, revision: 7 }]) {
      const normalized = normalizeGraphView(saved);
      expect(normalized).toEqual(DEFAULT_GRAPH_VIEW);
      expect(normalized).not.toBe(DEFAULT_GRAPH_VIEW);
    }
  });
});
