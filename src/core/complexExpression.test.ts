import { describe, expect, it } from 'vitest';
import { compile } from './expression';
import { compileComplex, evaluateComplexNode, realCoordinate } from './complexExpression';
import { asComplex, complexDivide, complexLog, complexSqrt } from './complex';
import type { ComplexScope } from './types';

const evaluate = (source: string, scope: ComplexScope = {}) => compileComplex(source).evaluate(scope);
function close(source: string, re: number, im: number, digits = 12): void {
  const value = asComplex(evaluate(source));
  expect(value.re).toBeCloseTo(re, digits); expect(value.im).toBeCloseTo(im, digits);
}

describe('complex arithmetic and expressions', () => {
  it('reuses the expression grammar and supports complex arithmetic', () => {
    close('(2+3*i)*(4-i)', 11, 10);
    close('(2+3*i)/(4-i)', 5 / 17, 14 / 17);
    close('i^2', -1, 0); close('j^3', 0, -1);
    close('(1+i)^(-2)', 0, -.5);
    close('pow(1+i, 2)', 0, 2);
    expect(evaluate('0^0')).toBe(1);
    expect(evaluate('0^0.5')).toBe(0);
  });

  it('keeps imaginary units shadowable by ordinary variables', () => {
    expect(compileComplex('i + j').variables).toEqual(['i', 'j']);
    expect(evaluate('i + j', { i: 2, j: 3 })).toBe(5);
    expect(compile('i + j').evaluate({ i: 2, j: 3 })).toBe(5);
    expect(() => compile('i').evaluate({})).toThrow('No value defined');
  });

  it('uses principal square-root, logarithm and power branches', () => {
    close('sqrt(-4)', 0, 2);
    close('sqrt(-3-4*i)', 1, -2);
    close('log(-1)', 0, Math.PI);
    close('(-1)^0.5', 0, 1);
    close('log(exp(0.2+0.3*i))', .2, .3);
    close('log10(100*i)', 2, Math.PI / (2 * Math.LN10));
  });

  it('evaluates complex trigonometric, hyperbolic and inverse trigonometric functions', () => {
    close('sin(i)', 0, Math.sinh(1));
    close('cos(i)', Math.cosh(1), 0);
    close('tan(i)', 0, Math.tanh(1));
    close('sinh(i)', 0, Math.sin(1));
    close('cosh(i)', Math.cos(1), 0);
    close('tanh(i)', 0, Math.tan(1));
    close('sin(asin(0.2+0.3*i))', .2, .3);
    close('cos(acos(0.2+0.3*i))', .2, .3);
    close('tan(atan(0.2+0.3*i))', .2, .3);
    close('tan(1000*i)', 0, 1);
    close('tanh(1000+i)', 1, 0);
  });

  it('uses signed-zero sides of the principal branch cuts', () => {
    close('asin(2)', Math.PI / 2, Math.acosh(2));
    close('acos(2)', 0, -Math.acosh(2));
    close('asin(complex(2,-0))', Math.PI / 2, -Math.acosh(2));
    close('acos(complex(2,-0))', 0, Math.acosh(2));
    close('asin(-2)', -Math.PI / 2, Math.acosh(2));
    close('sqrt(complex(-4,-0))', 0, -2);
    close('log(complex(-1,-0))', 0, -Math.PI);
    close('atan(complex(0,2))', Math.PI / 2, Math.log(3) / 2);
    close('atan(complex(-0,2))', -Math.PI / 2, Math.log(3) / 2);
  });

  it('retains small imaginary derivatives and finite large inverse-function values', () => {
    const sineInverse = asComplex(evaluate('asin(complex(0.2,1e-200))'));
    expect(sineInverse.im / 1e-200).toBeCloseTo(1 / Math.sqrt(.96), 12);
    const tangentInverse = asComplex(evaluate('atan(complex(0.2,1e-200))'));
    expect(tangentInverse.im / 1e-200).toBeCloseTo(1 / 1.04, 12);
    const huge = asComplex(evaluate('asin(1e200*i)'));
    expect(huge.re).toBe(0); expect(huge.im).toBeCloseTo(Math.log(1e200) + Math.LN2, 12);
  });

  it('projects real and imaginary parts, magnitude and phase explicitly', () => {
    const scope = { z: { re: 3, im: 4 } };
    expect(evaluate('real(z)', scope)).toBe(3); expect(evaluate('re(z)', scope)).toBe(3);
    expect(evaluate('imag(z)', scope)).toBe(4); expect(evaluate('im(z)', scope)).toBe(4);
    expect(evaluate('abs(z)', scope)).toBe(5); expect(evaluate('mag(z)', scope)).toBe(5);
    expect(evaluate('arg(z)', scope)).toBe(Math.atan2(4, 3)); expect(evaluate('phase(z)', scope)).toBe(Math.atan2(4, 3));
    close('conj(3+4*i)', 3, -4); close('complex(3,4)', 3, 4);
    close('(3+4*i)*conj(3+4*i)', 25, 0);
  });

  it('keeps projection functions useful on real inputs in ordinary mode', () => {
    expect(compile('real(3) + imag(4) + mag(-2)').evaluate({})).toBe(5);
    expect(compile('arg(-1)').evaluate({})).toBe(Math.PI);
    expect(compile('conj(3)').evaluate({})).toBe(3);
    expect(compile('complex(3,0)').evaluate({})).toBe(3);
    expect(() => compile('complex(3,4)').evaluate({})).toThrow('Enable complex mode');
    expect(() => compile('imag(1/0)').evaluate({})).toThrow('Non-finite');
    expect(() => compile('imag()').evaluate({})).toThrow('expects one');
    expect(() => compile('sqrt(-1)').evaluate({})).toThrow('Non-finite');
  });

  it('uses real comparisons and conditions with complex equality predicates', () => {
    expect(evaluate('(1+i)==complex(1,1)')).toBe(1);
    expect(evaluate('i != -i')).toBe(1);
    expect(evaluate('abs(3+4*i) >= 5')).toBe(1);
    close('if(imag(i)>0, i, sqrt(-1)/0)', 0, 1);
    expect(evaluate('0 && 1/0')).toBe(0); expect(evaluate('1 || 1/0')).toBe(1);
    expect(evaluate('imag(i)>0 ? real(2+i) : 1/0')).toBe(2);
    for (const source of ['i > 0', 'max(i, 2)', 'floor(i)', 'atan2(i, 1)', 'if(i, 1, 0)', '!i', 'i && 1']) {
      expect(() => evaluate(source)).toThrow('must be real');
    }
  });

  it('rejects nonreal plot coordinates and invalid components', () => {
    expect(realCoordinate(3)).toBe(3);
    expect(realCoordinate({ re: 3, im: 0 })).toBe(3);
    expect(() => realCoordinate({ re: 3, im: 1 })).toThrow('Use real(...), imag(...), abs(...) or arg(...)');
    expect(() => realCoordinate(Infinity)).toThrow('Non-finite');
    expect(() => evaluate('complex(i,1)')).toThrow('Real part must be real');
    expect(() => evaluate('complex(1,i)')).toThrow('Imaginary part must be real');
  });

  it('rejects invalid evaluated domains even when an outer projection would hide them', () => {
    for (const source of ['1/0', 'i/0', 'log(0)', '0^(-1)', '0^i', 'imag(1/0)', 'real(log(0))', 'exp(1000+i)', '1e309', 'imag(infinite)']) {
      expect(() => evaluate(source)).toThrow();
    }
    expect(() => evaluate('window.alert(1)')).toThrow();
    expect(() => evaluate('constructor(1)')).toThrow();
    expect(() => evaluate('complex(1)')).toThrow('Use complex');
    expect(() => evaluate('sin(1,2)')).toThrow('expects one');
  });

  it('avoids avoidable overflow and underflow in division, square roots and logs', () => {
    expect(complexDivide({ re: 1e308, im: 1e308 }, { re: 1e308, im: 1e308 })).toBe(1);
    expect(complexDivide({ re: 1e-308, im: 1e-308 }, { re: 1e-308, im: 1e-308 })).toBe(1);
    const quotient = asComplex(complexDivide(1e308, { re: .5, im: .5 }));
    expect(quotient.re).toBe(1e308); expect(quotient.im).toBe(-1e308);
    const root = asComplex(complexSqrt({ re: 1e308, im: 1e308 }));
    expect(Number.isFinite(root.re)).toBe(true); expect(Number.isFinite(root.im)).toBe(true);
    expect(root.re / 1e154).toBeCloseTo(Math.sqrt((Math.SQRT2 + 1) / 2), 12);
    const logarithm = asComplex(complexLog({ re: 1e308, im: 1e308 }));
    expect(logarithm.re).toBeCloseTo(Math.log(1e308) + Math.log(2) / 2, 12);
    expect(logarithm.im).toBeCloseTo(Math.PI / 4, 12);
  });

  it('can evaluate existing parser nodes without reparsing residual expressions', () => {
    const parsed = compile('z^2 + 1');
    expect(evaluateComplexNode(parsed.node, { z: { re: 0, im: 1 } })).toBe(0);
  });
});
