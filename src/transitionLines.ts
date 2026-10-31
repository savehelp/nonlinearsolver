import type { Annotations, Shape } from 'plotly.js';

export interface TransitionLine { axis: 'x' | 'y'; expression: string; value: number }

const escapeLabel = (source: string) => source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The paper coordinate spans the viewport, so panning and zooming cannot turn
 * a reference line into a finite segment or connect it to solution branches. */
export function transitionLineLayout(lines: readonly TransitionLine[]): { shapes: Partial<Shape>[]; annotations: Partial<Annotations>[] } {
  const shapes: Partial<Shape>[] = [], annotations: Partial<Annotations>[] = [];
  for (const transition of lines) {
    if (!Number.isFinite(transition.value)) continue;
    const { axis, expression, value } = transition, vertical = axis === 'x';
    const color = vertical ? '#e7a868' : '#a6b2ee';
    shapes.push({
      type: 'line', xref: vertical ? 'x' : 'paper', yref: vertical ? 'paper' : 'y',
      x0: vertical ? value : 0, x1: vertical ? value : 1,
      y0: vertical ? 0 : value, y1: vertical ? 1 : value,
      line: { color, width: 1.5, dash: 'dash' }, layer: 'above',
    });
    annotations.push({
      xref: vertical ? 'x' : 'paper', yref: vertical ? 'paper' : 'y',
      x: vertical ? value : 1, y: vertical ? 1 : value,
      text: `${axis} = ${escapeLabel(expression)}`, hovertext: `${axis} = ${value}`,
      showarrow: false, xanchor: vertical ? 'left' : 'right', yanchor: 'bottom',
      xshift: vertical ? 4 : -4, yshift: 3,
      font: { color, size: 10 }, bgcolor: '#11191f', borderpad: 2,
    });
  }
  return { shapes, annotations };
}
