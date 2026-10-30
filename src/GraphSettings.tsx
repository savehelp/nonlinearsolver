import type { GraphView } from './graphView';

interface Props {
  view: GraphView;
  onScale: (axis: 'xScale' | 'yScale', percentage: number) => void;
  onFit: () => void;
}

export default function GraphSettings({ view, onScale, onFit }: Props) {
  return <section className="graph-settings" aria-label="Graph scale controls">
    {([['xScale', 'Horizontal stretch (X)', 'Horizontal graph scale'], ['yScale', 'Vertical stretch (Y)', 'Vertical graph scale']] as const).map(([axis, title, label]) => <div className="slider-control graph-scale-control" key={axis}>
      <label htmlFor={`graph-${axis}`}>{title}<output htmlFor={`graph-${axis}`}>{view[axis]}%</output></label>
      <input id={`graph-${axis}`} aria-label={label} aria-valuetext={`${view[axis]}%`} type="range" min={25} max={400} step={5} value={view[axis]} onChange={event => onScale(axis, Number(event.target.value))}/>
    </div>)}
    <button className="button" onClick={onFit}>Fit graph</button>
  </section>;
}
