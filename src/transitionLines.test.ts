import { describe, expect, it } from 'vitest';
import { transitionLineLayout } from './transitionLines';

describe('transition line rendering', () => {
  it('spans the viewport in the perpendicular direction without creating points', () => {
    const layout = transitionLineLayout([{ axis: 'x', expression: 'cutoff_Hz', value: 159.15 }, { axis: 'y', expression: '-3', value: -3 }]);
    expect(layout.shapes).toMatchObject([
      { type: 'line', xref: 'x', x0: 159.15, x1: 159.15, yref: 'paper', y0: 0, y1: 1, line: { dash: 'dash' } },
      { type: 'line', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0: -3, y1: -3, line: { dash: 'dash' } },
    ]);
    expect(layout.annotations).toMatchObject([
      { text: 'x = cutoff_Hz', hovertext: 'x = 159.15', x: 159.15, y: 1, xref: 'x', yref: 'paper' },
      { text: 'y = -3', hovertext: 'y = -3', x: 1, y: -3, xref: 'paper', yref: 'y' },
    ]);
  });

  it('escapes Plotly annotation text and skips nonfinite positions', () => {
    const layout = transitionLineLayout([{ axis: 'y', expression: 'a<b & c>d', value: 0 }, { axis: 'x', expression: 'bad', value: NaN }]);
    expect(layout.shapes).toHaveLength(1);
    expect(layout.annotations[0].text).toBe('y = a&lt;b &amp; c&gt;d');
    expect(transitionLineLayout([])).toEqual({ shapes: [], annotations: [] });
  });
});
