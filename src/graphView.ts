import type { SweepResult } from './core/types';
import type { TransitionLine } from './transitionLines';

export interface GraphBounds { xMin: number; xMax: number; yMin: number; yMax: number }
export interface GraphView extends GraphBounds { autoscale: boolean; revision: number }
export const DEFAULT_GRAPH_VIEW: GraphView = { autoscale: true, xMin: -1, xMax: 1, yMin: -1, yMax: 1, revision: 0 };
export interface GraphAxisRanges { x?: [number, number]; y?: [number, number] }

export function validGraphBounds(bounds: GraphBounds): boolean {
  return [bounds.xMin, bounds.xMax, bounds.yMin, bounds.yMax].every(Number.isFinite)
    && bounds.xMin < bounds.xMax && bounds.yMin < bounds.yMax;
}

/** Old stretch preferences have no equivalent; start them in Autoscale. */
export function normalizeGraphView(saved: unknown): GraphView {
  if (!saved || typeof saved !== 'object') return { ...DEFAULT_GRAPH_VIEW };
  const value = saved as Partial<GraphView>, next = { ...DEFAULT_GRAPH_VIEW };
  if (typeof value.autoscale === 'boolean') next.autoscale = value.autoscale;
  for (const axis of ['x', 'y'] as const) {
    const min = value[`${axis}Min`], max = value[`${axis}Max`];
    if (typeof min === 'number' && typeof max === 'number' && Number.isFinite(min) && Number.isFinite(max) && min < max) {
      next[`${axis}Min`] = min; next[`${axis}Max`] = max;
    }
  }
  return next;
}

function extents(result: SweepResult | null, transitions: readonly TransitionLine[]) {
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const candidate of result?.branches ?? []) {
    for (const point of candidate.points) {
      const ys = point.ys ?? [point.y];
      for (let series = 0; series < ys.length; series++) {
        const x = point.xs ? point.xs[series] : point.x, y = ys[series];
        if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
        xMin = Math.min(xMin, x); xMax = Math.max(xMax, x);
        yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
      }
    }
  }
  const hasCurveData = xMin !== Infinity;
  for (const { axis, value } of transitions) {
    if (!Number.isFinite(value)) continue;
    if (axis === 'x') { xMin = Math.min(xMin, value); xMax = Math.max(xMax, value); }
    else { yMin = Math.min(yMin, value); yMax = Math.max(yMax, value); }
  }
  return { xMin, xMax, yMin, yMax, hasCurveData };
}

function paddedRange(min: number, max: number): [number, number] | undefined {
  if (min === Infinity || max === -Infinity) return undefined;
  const center = min / 2 + max / 2;
  const radius = min === max ? Math.max(Math.abs(center) * .05, 1) : (max / 2 - min / 2) * 1.1;
  const lower = Math.max(-Number.MAX_VALUE, center - radius), upper = Math.min(Number.MAX_VALUE, center + radius);
  return Number.isFinite(lower) && Number.isFinite(upper) && lower < upper ? [lower, upper] : undefined;
}

/** A fallback before Plotly has reported the actual visible viewport. */
export function fitGraphBounds(result: SweepResult | null, transitions: readonly TransitionLine[] = []): GraphBounds {
  const { xMin, xMax, yMin, yMax } = extents(result, transitions);
  const x = paddedRange(xMin, xMax) ?? [-1, 1], y = paddedRange(yMin, yMax) ?? [-1, 1];
  return { xMin: x[0], xMax: x[1], yMin: y[0], yMax: y[1] };
}

/** Display-only ranges; manual bounds never change with data or reference lines. */
export function graphAxisRanges(result: SweepResult | null, view: GraphView, transitions: readonly TransitionLine[] = []): GraphAxisRanges {
  if (!view.autoscale) return { x: [view.xMin, view.xMax], y: [view.yMin, view.yMax] };
  const { xMin, xMax, yMin, yMax, hasCurveData } = extents(result, transitions);
  // Plotly fits traces and reference shapes together, but ignores shapes alone.
  return hasCurveData ? { x: undefined, y: undefined } : { x: paddedRange(xMin, xMax), y: paddedRange(yMin, yMax) };
}
