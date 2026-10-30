import type { SweepResult } from './core/types';

export interface GraphView { xScale: number; yScale: number; revision: number }
export const DEFAULT_GRAPH_VIEW: GraphView = { xScale: 100, yScale: 100, revision: 0 };
export interface GraphAxisRanges { x?: [number, number]; y?: [number, number] }

function scaledRange(min: number, max: number, scale: number): [number, number] | undefined {
  if (scale === 100 || min === Infinity || max === -Infinity) return undefined;
  const factor = 100 / Math.min(400, Math.max(25, Number.isFinite(scale) ? scale : 100));
  const center = min / 2 + max / 2;
  const halfSpan = min === max ? Math.max(Math.abs(center) * .05, 1) : max / 2 - min / 2;
  const radius = halfSpan * factor;
  const lower = Math.max(-Number.MAX_VALUE, center - radius), upper = Math.min(Number.MAX_VALUE, center + radius);
  return Number.isFinite(lower) && Number.isFinite(upper) && lower < upper ? [lower, upper] : undefined;
}

/** A display-only range calculation; no sample arrays or solver inputs change.
 * Overlays are already checked for compatible axis expressions by the caller. */
export function graphAxisRanges(result: SweepResult | null, overlay: SweepResult | null, branch: number | null, view: GraphView): GraphAxisRanges {
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  const collect = (source: SweepResult | null, filter: number | null) => {
    for (const candidate of source?.branches ?? []) {
      if (filter !== null && candidate.id !== filter) continue;
      for (const point of candidate.points) {
        if (!Number.isFinite(point.x)) continue;
        let visible = false;
        for (const value of point.ys ?? [point.y]) {
          if (value === null || !Number.isFinite(value)) continue;
          visible = true; yMin = Math.min(yMin, value); yMax = Math.max(yMax, value);
        }
        if (visible) { xMin = Math.min(xMin, point.x); xMax = Math.max(xMax, point.x); }
      }
    }
  };
  collect(result, branch); collect(overlay, null);
  return { x: scaledRange(xMin, xMax, view.xScale), y: scaledRange(yMin, yMax, view.yScale) };
}
