import type { Data } from 'plotly.js';
import type { Branch, Point } from './core/types';

export const BRANCH_TRACE_THRESHOLD = 128;
const colors = ['#53d9bd', '#c6a3ff', '#f0be73', '#7eb7ff', '#f88f9b', '#b6db72', '#f098db', '#65d4ee', '#e88d58', '#8398ff', '#cad795', '#edb6b8', '#a3c4ff', '#ac9c7c', '#c26fe0', '#6cba9b'];
const yValue = (point: Point, series: number) => point.ys ? point.ys[series] : series === 0 ? point.y : null;

/** Large fragmented sweeps keep every point, but share a bounded number of
 * Plotly traces. Null separators preserve the original branch boundaries. */
export function branchTraces(branches: Branch[], labels: string[], xLabel: string, overlay = false): Data[] {
  const multiple = labels.length > 1;
  const colorFor = (branch: number, series: number) => overlay && !multiple ? '#61747e' : colors[(multiple ? series : branch) % colors.length];
  if (branches.length <= BRANCH_TRACE_THRESHOLD) {
    return branches.flatMap((branch, index) => labels.map((label, series): Data => {
      const color = colorFor(index, series);
      if (overlay) return {
        x: branch.points.map(point => point.x), y: branch.points.map(point => yValue(point, series)),
        type: 'scatter', mode: 'lines', connectgaps: false,
        line: { color, dash: 'dot', width: 1.5 }, opacity: .45,
        name: `Overlay · ${label}`, hoverinfo: 'skip', showlegend: false,
      };
      return {
        x: branch.points.map(point => point.x), y: branch.points.map(point => yValue(point, series)),
        customdata: branch.points as never, type: 'scatter', mode: branch.points.length === 1 ? 'markers' : 'lines', connectgaps: false,
        line: { color, width: 2.5 }, marker: { size: 5, color }, name: multiple ? label : `Branch ${branch.id}`,
        legendgroup: label, showlegend: multiple && index === 0,
        hovertemplate: `${xLabel}: %{x:.5g}<br>${label}: %{y:.5g}<extra>Branch ${branch.id}</extra>`,
      };
    }));
  }

  interface Group {
    series: number; color: string; mode: 'markers' | 'lines';
    x: (number | null)[]; y: (number | null)[]; points: (Point | null)[]; text: string[];
  }
  const groups = new Map<string, Group>();
  branches.forEach((branch, index) => labels.forEach((_label, series) => {
    const color = colorFor(index, series), mode = !overlay && branch.points.length === 1 ? 'markers' : 'lines';
    const key = `${series}:${color}:${mode}`;
    let group = groups.get(key);
    if (!group) {
      group = { series, color, mode, x: [], y: [], points: [], text: [] };
      groups.set(key, group);
    }
    if (mode === 'lines' && group.x.length) {
      group.x.push(null); group.y.push(null); group.points.push(null); group.text.push('');
    }
    for (const point of branch.points) {
      group.x.push(point.x); group.y.push(yValue(point, series));
      // Overlay points cannot be inspected; avoid retaining duplicate hover data.
      if (!overlay) { group.points.push(point); group.text.push(`Branch ${branch.id}`); }
    }
  }));
  const legend = new Set<number>();
  return [...groups.values()].map((group): Data => {
    const label = labels[group.series], showlegend = !overlay && multiple && !legend.has(group.series);
    legend.add(group.series);
    if (overlay) return {
      x: group.x, y: group.y, type: 'scatter', mode: 'lines', connectgaps: false,
      line: { color: group.color, dash: 'dot', width: 1.5 }, opacity: .45,
      name: `Overlay · ${label}`, hoverinfo: 'skip', showlegend: false,
    };
    return {
      x: group.x, y: group.y, customdata: group.points as never, text: group.text,
      type: 'scatter', mode: group.mode, connectgaps: false,
      line: { color: group.color, width: 2.5 }, marker: { size: 5, color: group.color },
      name: multiple ? label : 'Branches', legendgroup: label, showlegend,
      hovertemplate: `${xLabel}: %{x:.5g}<br>${label}: %{y:.5g}<extra>%{text}</extra>`,
    };
  });
}
