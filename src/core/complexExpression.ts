import { compile, type ExpressionNode } from './expression';
import type { ComplexScope } from './types';
import { asComplex, complexAbs, complexAcos, complexAdd, complexAsin, complexAtan, complexCos, complexCosh, complexDivide, complexExp, complexFinite, complexLog, complexMultiply, complexPow, complexSin, complexSinh, complexSqrt, complexSubtract, complexTan, complexTanh, complexValue, realCoordinate, type ComplexValue } from './complex';

const constants: ComplexScope = { pi: Math.PI, e: Math.E, true: 1, false: 0, i: { re: 0, im: 1 }, j: { re: 0, im: 1 } };
export interface ComplexExpression { evaluate: (scope: ComplexScope) => ComplexValue; variables: string[]; readonly node: ExpressionNode }
export { realCoordinate } from './complex';

export function compileComplex(source: string): ComplexExpression {
  const parsed = compile(source);
  return {
    node: parsed.node, variables: parsed.variables,
    evaluate: scope => {
      const value = evaluateComplexNode(parsed.node, scope);
      if (!complexFinite(value)) throw new Error(`Non-finite result in “${source}”. Check domains and division by zero.`);
      return value;
    },
  };
}

const unary: Record<string, (value: ComplexValue) => ComplexValue> = {
    sqrt: complexSqrt, exp: complexExp, log: complexLog, ln: complexLog,
    sin: complexSin, cos: complexCos, tan: complexTan,
    asin: complexAsin, acos: complexAcos, atan: complexAtan,
    sinh: complexSinh, cosh: complexCosh, tanh: complexTanh,
    abs: complexAbs, mag: complexAbs,
    real: value => asComplex(value).re, re: value => asComplex(value).re,
    imag: value => asComplex(value).im, im: value => asComplex(value).im,
    arg: value => { const z = asComplex(value); return Math.atan2(z.im, z.re); },
    phase: value => { const z = asComplex(value); return Math.atan2(z.im, z.re); },
    conj: value => { const z = asComplex(value); return complexValue(z.re, -z.im); },
    log10: value => complexDivide(complexLog(value), Math.LN10),
};
function call(name: string, args: ComplexValue[]): ComplexValue {
  if (Object.hasOwn(unary, name)) {
    if (args.length !== 1) throw new Error(`${name} expects one argument.`);
    return unary[name](args[0]);
  }
  if (name === 'complex') {
    if (args.length !== 2) throw new Error('Use complex(realPart, imaginaryPart).');
    return complexValue(realCoordinate(args[0], 'Real part'), realCoordinate(args[1], 'Imaginary part'));
  }
  if (name === 'pow') {
    if (args.length !== 2) throw new Error('pow expects two arguments.');
    return complexPow(args[0], args[1]);
  }
  const realArgs = args.map(value => realCoordinate(value, `${name} argument`));
  switch (name) {
    case 'atan2': return Math.atan2(realArgs[0], realArgs[1]);
    case 'min': return Math.min(...realArgs);
    case 'max': return Math.max(...realArgs);
    case 'floor': return Math.floor(realArgs[0]);
    case 'ceil': return Math.ceil(realArgs[0]);
    case 'sign': return Math.sign(realArgs[0]);
    default: throw new Error(`Unknown function “${name}”.`);
  }
}

export function evaluateComplexNode(node: ExpressionNode, scope: ComplexScope): ComplexValue {
  const value = evaluateNode(node, scope);
  if (!complexFinite(value)) throw new Error('Non-finite complex result. Check domains and division by zero.');
  return value;
}

function evaluateNode(node: ExpressionNode, scope: ComplexScope): ComplexValue {
  if (node.type === 'number') return node.value;
  if (node.type === 'variable') {
    const value = Object.hasOwn(scope, node.name) ? scope[node.name] : Object.hasOwn(constants, node.name) ? constants[node.name] : undefined;
    if (value === undefined) throw new Error(`No value defined for “${node.name}”.`);
    return value;
  }
  if (node.type === 'unary') {
    const value = evaluateComplexNode(node.arg, scope);
    return node.op === '-' ? complexMultiply(-1, value) : node.op === '!' ? Number(!realCoordinate(value, 'Logical operand')) : value;
  }
  if (node.type === 'call') {
    if (node.name === 'if') return evaluateComplexNode(node.args[realCoordinate(evaluateComplexNode(node.args[0], scope), 'Condition') ? 1 : 2], scope);
    return call(node.name, node.args.map(arg => evaluateComplexNode(arg, scope)));
  }
  const left = evaluateComplexNode(node.left, scope);
  if (node.op === '&&') return realCoordinate(left, 'Logical operand') ? Number(Boolean(realCoordinate(evaluateComplexNode(node.right, scope), 'Logical operand'))) : 0;
  if (node.op === '||') return realCoordinate(left, 'Logical operand') ? 1 : Number(Boolean(realCoordinate(evaluateComplexNode(node.right, scope), 'Logical operand')));
  const right = evaluateComplexNode(node.right, scope);
  switch (node.op) {
    case '+': return complexAdd(left, right);
    case '-': return complexSubtract(left, right);
    case '*': return complexMultiply(left, right);
    case '/': return complexDivide(left, right);
    case '^': case '**': return complexPow(left, right);
    case '==': { const a = asComplex(left), b = asComplex(right); return Number(a.re === b.re && a.im === b.im); }
    case '!=': { const a = asComplex(left), b = asComplex(right); return Number(a.re !== b.re || a.im !== b.im); }
    default: {
      const a = realCoordinate(left, 'Comparison operand'), b = realCoordinate(right, 'Comparison operand');
      switch (node.op) { case '<': return Number(a < b); case '>': return Number(a > b); case '<=': return Number(a <= b); case '>=': return Number(a >= b); default: throw new Error('Invalid operator.'); }
    }
  }
}
