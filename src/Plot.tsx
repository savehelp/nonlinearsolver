import { memo, useEffect, useRef } from 'react';
import Plotly from 'plotly.js-basic-dist-min';
import type { Data, Layout, PlotMouseEvent, PlotlyHTMLElement } from 'plotly.js';
import type { Configuration, Point, SweepResult } from './core/types';
import { yExpressions } from './core/axes';
import { LatestTaskQueue } from './latestTaskQueue';
import { branchTraces } from './plotTraces';
import { graphAxisRanges, type GraphView } from './graphView';
function Plot({ result, config, overlay, onPoint, view }: { result: SweepResult | null; config: Configuration; overlay: { result: SweepResult; config: Configuration } | null; onPoint: (p: Point) => void; view: GraphView }) {
  const element = useRef<HTMLDivElement>(null); const callback = useRef(onPoint); callback.current = onPoint;
  const mounted = useRef(false), generation = useRef(0), plotElement = useRef<HTMLDivElement | null>(null);
  const queue = useRef<LatestTaskQueue<() => Promise<void>> | null>(null);
  const ranges = useRef<{ x?: { key: string; range?: [number, number] }; y?: { key: string; range?: [number, number] } }>({});
  if (!queue.current) queue.current = new LatestTaskQueue(task => task(), () => {
    if (!mounted.current && plotElement.current) { Plotly.purge(plotElement.current); plotElement.current = null; }
  });
  useEffect(() => {
    const el = element.current!; plotElement.current = el; mounted.current = true; generation.current++;
    const observer = new ResizeObserver(() => { if (mounted.current) void Plotly.Plots.resize(el); }); observer.observe(el);
    return () => {
      observer.disconnect(); mounted.current = false; generation.current++; queue.current!.clear();
      // Let an active Plotly operation settle before purging its DOM. StrictMode
      // can mount again in the meantime and reuse the same serialized lane.
      if (!queue.current!.busy) { Plotly.purge(el); plotElement.current = null; }
    };
  }, []);
  useEffect(() => {
    const el = element.current!, version = generation.current;
    queue.current!.submit(async () => {
      const traces: Data[] = [];
      let labels: string[]; try { labels = yExpressions(config.axes.y); } catch { labels = [config.axes.y]; }
      const multiple = labels.length > 1;
      const compatibleOverlay = overlay && overlay.config.axes.x === config.axes.x && overlay.config.axes.y === config.axes.y ? overlay.result : null;
      if (compatibleOverlay) traces.push(...branchTraces(compatibleOverlay.branches, labels, config.axes.x, true));
      traces.push(...branchTraces(result?.branches ?? [], labels, config.axes.x));
      const xKey = `${config.name}:${config.axes.x}:${view.xScale}:${view.revision}`;
      const yKey = `${config.name}:${config.axes.y}:${view.yScale}:${view.revision}`;
      const needsX = ranges.current.x?.key !== xKey || (view.xScale !== 100 && !ranges.current.x?.range);
      const needsY = ranges.current.y?.key !== yKey || (view.yScale !== 100 && !ranges.current.y?.range);
      if (needsX || needsY) {
        const next = graphAxisRanges(result, compatibleOverlay, null, view);
        if (needsX) ranges.current.x = { key: xKey, range: next.x };
        if (needsY) ranges.current.y = { key: yKey, range: next.y };
      }
      const layout: Partial<Layout> = { paper_bgcolor: 'transparent', plot_bgcolor: 'transparent', font: { family: 'Inter, Segoe UI, sans-serif', color: '#8d9da7', size: 11 }, margin: { l: 65, r: 28, t: multiple ? 50 : 25, b: 55 }, xaxis: { title: { text: config.axes.x, standoff: 20 }, gridcolor: '#253139', zerolinecolor: '#3a4a54', ticks: 'outside', tickcolor: '#3a4a54', automargin: true }, yaxis: { title: { text: multiple ? 'Value' : config.axes.y, standoff: 15 }, gridcolor: '#253139', zerolinecolor: '#3a4a54', ticks: 'outside', tickcolor: '#3a4a54', automargin: true }, showlegend: multiple, legend: { orientation: 'h', x: 0, y: 1.02, xanchor: 'left', yanchor: 'bottom', groupclick: 'togglegroup' }, hovermode: 'closest', dragmode: 'pan', uirevision: `${config.axes.x}:${config.axes.y}:${config.name}`, autosize: true };
      Object.assign(layout.xaxis!, { uirevision: xKey, autorange: !ranges.current.x?.range, range: ranges.current.x?.range });
      Object.assign(layout.yaxis!, { uirevision: yKey, autorange: !ranges.current.y?.range, range: ranges.current.y?.range });
      await Plotly.react(el, traces, layout, { responsive: true, displaylogo: false, scrollZoom: true, modeBarButtonsToRemove: ['select2d', 'lasso2d'], toImageButtonOptions: { filename: 'nonlinear-sweep', format: 'svg' } });
      if (!mounted.current || version !== generation.current) return;
      const plot = el as unknown as PlotlyHTMLElement; plot.removeAllListeners('plotly_click');
      plot.on('plotly_click', (event: PlotMouseEvent) => { const point = event.points[0]?.customdata as unknown as Point; if (point?.values) callback.current(point); });
    });
  }, [result, config, overlay, view]);
  return <div ref={element} className="plot" aria-label="Interactive solution plot" />;
}
export default memo(Plot);
