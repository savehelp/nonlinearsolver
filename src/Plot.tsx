import { memo, useEffect, useRef } from 'react';
import Plotly from 'plotly.js-basic-dist-min';
import type { Data, Layout, PlotMouseEvent, PlotlyHTMLElement } from 'plotly.js';
import type { Configuration, PlotCurve, Point, SweepResult } from './core/types';
import { configurationCurves } from './core/axes';
import { evaluateTransitionLines } from './core/transitions';
import { LatestTaskQueue } from './latestTaskQueue';
import { branchTraces } from './plotTraces';
import { graphAxisRanges, validGraphBounds, type GraphBounds, type GraphView } from './graphView';
import { transitionLineLayout, type TransitionLine } from './transitionLines';

function visibleBounds(element: HTMLDivElement): GraphBounds | null {
  const layout = (element as unknown as { _fullLayout?: { xaxis?: { range?: number[] }; yaxis?: { range?: number[] } } })._fullLayout;
  const x = layout?.xaxis?.range, y = layout?.yaxis?.range;
  if (!x || !y) return null;
  const bounds = { xMin: x[0], xMax: x[1], yMin: y[0], yMax: y[1] };
  return validGraphBounds(bounds) ? bounds : null;
}

interface Props {
  result: SweepResult | null; config: Configuration; transitionConfig?: Configuration;
  onPoint: (p: Point) => void; view: GraphView;
  onViewportChange: (bounds: GraphBounds, mode?: 'auto' | 'manual') => void;
}

function Plot({ result, config, transitionConfig = config, onPoint, view, onViewportChange }: Props) {
  const element = useRef<HTMLDivElement>(null); const callback = useRef(onPoint); callback.current = onPoint;
  const viewportCallback = useRef(onViewportChange); viewportCallback.current = onViewportChange;
  const mounted = useRef(false), generation = useRef(0), plotElement = useRef<HTMLDivElement | null>(null);
  const updating = useRef(false);
  const queue = useRef<LatestTaskQueue<() => Promise<void>> | null>(null);
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
      let curves: PlotCurve[]; try { curves = configurationCurves(config); } catch { curves = config.axes.y.trim() ? [{ x: config.axes.x, y: config.axes.y }] : []; }
      let transitions: TransitionLine[] = [];
      try { transitions = evaluateTransitionLines(transitionConfig, result); } catch { /* Source validation reports incomplete transition expressions. */ }
      const xLabels = curves.map(curve => curve.x), yLabels = curves.map(curve => curve.y);
      const labels = config.axes.curves ? curves.map(curve => `${curve.y} vs ${curve.x}`) : yLabels;
      const multiple = labels.length > 1 || (!!config.axes.curves && labels.length > 0);
      traces.push(...branchTraces(result?.branches ?? [], labels, config.axes.curves ? xLabels : config.axes.x, yLabels));
      const curveKey = JSON.stringify(curves);
      const xTransitionKey = JSON.stringify(transitions.filter(line => line.axis === 'x'));
      const yTransitionKey = JSON.stringify(transitions.filter(line => line.axis === 'y'));
      const xTitle = [...new Set(xLabels)].join(', ') || 'x', yTitle = [...new Set(yLabels)].join(', ') || 'y';
      const xKey = `${config.name}:${curveKey}:${xTransitionKey}:${view.autoscale}:${view.xMin}:${view.xMax}:${view.revision}`;
      const yKey = `${config.name}:${curveKey}:${yTransitionKey}:${view.autoscale}:${view.yMin}:${view.yMax}:${view.revision}`;
      const ranges = graphAxisRanges(result, view, transitions);
      const layout: Partial<Layout> = { paper_bgcolor: 'transparent', plot_bgcolor: 'transparent', font: { family: 'Inter, Segoe UI, sans-serif', color: '#8d9da7', size: 11 }, margin: { l: 65, r: 28, t: multiple ? 50 : 25, b: 55 }, xaxis: { title: { text: xTitle, standoff: 20 }, gridcolor: '#253139', zerolinecolor: '#3a4a54', ticks: 'outside', tickcolor: '#3a4a54', automargin: true }, yaxis: { title: { text: yTitle, standoff: 15 }, gridcolor: '#253139', zerolinecolor: '#3a4a54', ticks: 'outside', tickcolor: '#3a4a54', automargin: true }, showlegend: multiple, legend: { orientation: 'h', x: 0, y: 1.02, xanchor: 'left', yanchor: 'bottom', groupclick: 'togglegroup' }, hovermode: 'closest', dragmode: 'pan', uirevision: `${curveKey}:${config.name}`, autosize: true };
      Object.assign(layout, transitionLineLayout(transitions));
      Object.assign(layout.xaxis!, { uirevision: xKey, autorange: !ranges.x, range: ranges.x });
      Object.assign(layout.yaxis!, { uirevision: yKey, autorange: !ranges.y, range: ranges.y });
      updating.current = true;
      try {
        await Plotly.react(el, traces, layout, { responsive: true, displaylogo: false, scrollZoom: true, modeBarButtonsToRemove: ['select2d', 'lasso2d'], toImageButtonOptions: { filename: 'nonlinear-sweep', format: 'svg' } });
      } finally { updating.current = false; }
      if (!mounted.current || version !== generation.current) return;
      const bounds = visibleBounds(el); if (bounds) viewportCallback.current(bounds);
      const plot = el as unknown as PlotlyHTMLElement; plot.removeAllListeners('plotly_click');
      plot.on('plotly_click', (event: PlotMouseEvent) => { const point = event.points[0]?.customdata as unknown as Point; if (point?.values) callback.current(point); });
      plot.removeAllListeners('plotly_afterplot');
      plot.on('plotly_afterplot', () => {
        // Resize and legend visibility can change the automatic range too.
        const next = visibleBounds(el);
        if (mounted.current && next) viewportCallback.current(next);
      });
      plot.removeAllListeners('plotly_relayout');
      plot.on('plotly_relayout', event => {
        if (updating.current || !mounted.current) return;
        const automatic = Object.entries(event).some(([key, value]) => /^(x|y)axis\.autorange$/.test(key) && value === true);
        const manual = Object.keys(event).some(key => /^(x|y)axis\.range(?:\[[01]\])?$/.test(key));
        const next = visibleBounds(el);
        if (next && (automatic || manual)) viewportCallback.current(next, automatic ? 'auto' : 'manual');
      });
    });
  }, [result, config, transitionConfig, view]);
  return <div ref={element} className="plot" aria-label="Interactive solution plot" />;
}
export default memo(Plot);
