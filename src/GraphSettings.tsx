import { useCallback, useEffect, useState } from 'react';
import ExpressionInput from './ExpressionInput';
import type { GraphView } from './graphView';

type Bounds = Pick<GraphView, 'xMin' | 'xMax' | 'yMin' | 'yMax'>;

interface Props {
  view: GraphView;
  onChange: (update: Partial<Omit<GraphView, 'revision'>>) => void;
}

function boundsOf(view: GraphView): Bounds {
  return { xMin: view.xMin, xMax: view.xMax, yMin: view.yMin, yMax: view.yMax };
}

function boundsErrors(bounds: Bounds): string[] {
  const errors: string[] = [];
  for (const axis of ['x', 'y'] as const) {
    const min = bounds[`${axis}Min`];
    const max = bounds[`${axis}Max`];
    if (!Number.isFinite(min) || !Number.isFinite(max)) errors.push(`${axis.toUpperCase()} bounds must be finite numbers.`);
    else if (min >= max) errors.push(`Minimum ${axis.toUpperCase()} must be less than maximum ${axis.toUpperCase()}.`);
  }
  return errors;
}

const ignore = () => {};

export default function GraphSettings({ view, onChange }: Props) {
  const [draft, setDraft] = useState<Bounds>(() => boundsOf(view));
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    setDraft(boundsOf(view));
  }, [view.autoscale, view.xMin, view.xMax, view.yMin, view.yMax, view.revision]);

  const onValidity = useCallback((id: string, error: string | null) => {
    setInputErrors(current => {
      if (current[id] === error || (!error && !(id in current))) return current;
      const next = { ...current };
      if (error) next[id] = error;
      else delete next[id];
      return next;
    });
  }, []);

  const updateBound = (key: keyof Bounds, value: number | undefined) => {
    if (value === undefined) return;
    const next = { ...draft, [key]: value };
    setDraft(next);
    if (!boundsErrors(next).length) onChange(next);
  };

  const errors = [...Object.values(inputErrors), ...boundsErrors(draft)];

  return <section className="settings-content graph-settings" aria-label="Graph settings">
    <label className="check-label"><input type="checkbox" checked={view.autoscale} onChange={event => onChange({ autoscale: event.target.checked })}/>Autoscale</label>
    <p className="field-hint">{view.autoscale ? 'Fit both axes to the plotted data.' : 'Enter the visible range for each axis. Numeric expressions are supported.'}</p>
    {!view.autoscale && <>
      <div className="settings-fields">
        {([
          ['xMin', 'Minimum X'], ['xMax', 'Maximum X'],
          ['yMin', 'Minimum Y'], ['yMax', 'Maximum Y'],
        ] as const).map(([key, label]) => <label key={key}>{label}<ExpressionInput label={label} value={draft[key]} onValue={value => updateBound(key, value)} onValidity={onValidity} onRevert={ignore} onValid={ignore}/></label>)}
      </div>
      {errors.length > 0 && <div className="failure-details" role="alert">{errors.map(error => <div key={error}>{error}</div>)}</div>}
    </>}
  </section>;
}
