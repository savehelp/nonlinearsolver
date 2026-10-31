import { realCoordinate } from './complex';
import { createConstantResolver } from './constants';
import type { Configuration, SweepResult } from './types';

export const MAX_TRANSITION_LINES = 32;
export interface TransitionLine { axis: 'x' | 'y'; expression: string; value: number }
export class TransitionExpressionError extends Error {
  constructor(message: string, readonly index: number) { super(message); this.name = 'TransitionExpressionError'; }
}

/** Reference positions depend only on fixed inputs, never a sampled root. */
export function evaluateTransitionLines(config: Configuration, _result?: SweepResult | null): TransitionLine[] {
  const transitions = config.axes.transitions ?? [];
  if (!transitions.length) return [];
  if (transitions.length > MAX_TRANSITION_LINES) throw new TransitionExpressionError(`Use at most ${MAX_TRANSITION_LINES} transition lines.`, MAX_TRANSITION_LINES);
  const resolver = createConstantResolver(config);
  return transitions.map((transition, index) => {
    try {
      if (transition.axis !== 'x' && transition.axis !== 'y') throw new Error('Choose an X or Y transition.');
      return { ...transition, value: realCoordinate(resolver.evaluate(transition.expression), 'Transition position') };
    } catch (error) { throw new TransitionExpressionError((error as Error).message, index); }
  });
}
