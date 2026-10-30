import { describe, expect, it } from 'vitest';
import { affineEquation, affineExpression } from './affine';
import { compile, expressionFromNode } from './expression';
import type { Scope } from './types';

function reconstructed(source: string, names: string[], values: Scope): number {
  const form = affineEquation(source, names)!;
  return [...form.coefficients].reduce((sum, [name, coefficient]) => sum + coefficient.evaluate(values) * values[name], form.constant.evaluate(values));
}

describe('conservative affine decomposition', () => {
  it('extracts coupled coefficients from both sides and repeated variables', () => {
    const source = '2*x + y - x/2 = 5 - 3*y', form = affineEquation(source, ['x', 'y'])!;
    expect(form.coefficients.get('x')!.evaluate({})).toBe(1.5);
    expect(form.coefficients.get('y')!.evaluate({})).toBe(4);
    expect(form.constant.evaluate({})).toBe(-5);
    expect(reconstructed(source, ['x', 'y'], { x: 4, y: 2 })).toBe(9);
  });

  it('allows functions and nonlinear expressions independent of the chosen variable', () => {
    const form = affineEquation('y = x - sin(y)', ['x'])!;
    expect(form.coefficients.get('x')!.evaluate({})).toBe(-1);
    expect(form.constant.variables).toEqual(['y']);
    expect(form.constant.evaluate({ y: 1 })).toBeCloseTo(1 + Math.sin(1), 14);
    expect(affineEquation('y = x - sin(y)', ['x', 'y'])).toBeNull();
    expect(reconstructed('2*x = sqrt(y) + y^2', ['x'], { x: 3, y: 4 })).toBe(-12);
  });

  it('retains coefficient dependencies for runtime zero-pivot guards', () => {
    const form = affineEquation('(a - b)*x + c = p', ['x'])!;
    expect(form.coefficients.get('x')!.variables).toEqual(['a', 'b']);
    expect(form.coefficients.get('x')!.evaluate({ a: 2, b: 2 })).toBe(0);
    expect(form.constant.evaluate({ a: 2, b: 2, c: 3, p: 5 })).toBe(-2);
  });

  it('rejects powers, variable denominators, functions and products involving targets', () => {
    for (const source of ['x*x = p', 'x^2 = p', 'sin(x) = p', 'abs(x) = p', '1/x = p', 'x*y = p', 'if(p > 0, x, 0) = 1', 'x > p']) {
      expect(affineEquation(source, ['x', 'y']), source).toBeNull();
    }
  });

  it('retains lazy evaluation of target-independent branches', () => {
    const form = affineEquation('x = if(p == 0, 2, 1/p)', ['x'])!;
    expect(form.constant.evaluate({ p: 0 })).toBe(-2);
    expect(form.constant.evaluate({ p: 4 })).toBe(-.25);
    const coefficient = affineEquation('if(p == 0, 3, 1/p)*x = 6', ['x'])!.coefficients.get('x')!;
    expect(coefficient.evaluate({ p: 0 })).toBe(3);
  });

  it('does not cancel undefined divisions or zero multiplications', () => {
    const cancelled = affineEquation('x/p - x/p = 0', ['x'])!;
    expect(cancelled.coefficients.get('x')!.evaluate({ p: 1 })).toBe(0);
    expect(() => cancelled.coefficients.get('x')!.evaluate({ p: 0 })).toThrow('Non-finite');
    const invalid = affineEquation('x = 0*sqrt(p)', ['x'])!;
    expect(() => invalid.constant.evaluate({ p: -1 })).toThrow('Non-finite');
  });

  it('supports unary signs, engineering constants, and zero-residual expressions', () => {
    const form = affineEquation('-(-x + 2.2k*y)/2 + pi', ['x', 'y'])!;
    expect(form.coefficients.get('x')!.evaluate({})).toBe(.5);
    expect(form.coefficients.get('y')!.evaluate({})).toBe(-1100);
    expect(form.constant.variables).toEqual([]);
    expect(form.constant.evaluate({})).toBe(Math.PI);
  });

  it('reuses parsed nodes and preserves expression evaluation semantics', () => {
    const original = compile('if(p == 0, 1, 1/p) + 2*x');
    const built = expressionFromNode(original.node);
    expect(built.node).toBe(original.node);
    expect(built.variables).toEqual(original.variables);
    expect(built.evaluate({ p: 0, x: 3 })).toBe(7);
    expect(affineExpression(original, ['x'])!.coefficients.get('x')!.evaluate({})).toBe(2);
  });
});
