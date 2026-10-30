import { expressionFromNode, residual, type Expression, type ExpressionNode } from './expression';

export interface AffineForm {
  /** The original residual equals sum(coefficients[name] * name) + constant. */
  coefficients: Map<string, Expression>;
  constant: Expression;
}
interface NodeForm { coefficients: Map<string, ExpressionNode>; constant: ExpressionNode }
const zero: ExpressionNode = { type: 'number', value: 0 };
const one: ExpressionNode = { type: 'number', value: 1 };
const binary = (op: string, left: ExpressionNode, right: ExpressionNode): ExpressionNode => ({ type: 'binary', op, left, right });
const negative = (arg: ExpressionNode): ExpressionNode => ({ type: 'unary', op: '-', arg });

/** Recognize arithmetic that is affine in the requested names. All other names
 * and target-independent calls remain opaque expressions. No inverse functions,
 * cancellation, domain assumptions, or expansion of expression trees is used. */
export function affineExpression(expression: Expression, names: readonly string[], source = 'expression'): AffineForm | null {
  const targets = new Set(names), dependency = new Map<ExpressionNode, boolean>();
  function depends(node: ExpressionNode): boolean {
    if (dependency.has(node)) return dependency.get(node)!;
    const result = node.type === 'variable' ? targets.has(node.name)
      : node.type === 'unary' ? depends(node.arg)
      : node.type === 'binary' ? depends(node.left) || depends(node.right)
      : node.type === 'call' ? node.args.some(depends) : false;
    dependency.set(node, result); return result;
  }
  function decompose(node: ExpressionNode): NodeForm | null {
    if (!depends(node)) return { coefficients: new Map(), constant: node };
    if (node.type === 'variable') return { coefficients: new Map([[node.name, one]]), constant: zero };
    if (node.type === 'unary' && (node.op === '+' || node.op === '-')) {
      const form = decompose(node.arg);
      if (!form || node.op === '+') return form;
      return { coefficients: new Map([...form.coefficients].map(([name, coefficient]) => [name, negative(coefficient)])), constant: negative(form.constant) };
    }
    if (node.type !== 'binary') return null;
    if (node.op === '+' || node.op === '-') {
      const left = decompose(node.left), right = decompose(node.right);
      if (!left || !right) return null;
      const coefficients = new Map(left.coefficients);
      for (const [name, coefficient] of right.coefficients) {
        const existing = coefficients.get(name);
        coefficients.set(name, existing ? binary(node.op, existing, coefficient) : node.op === '+' ? coefficient : negative(coefficient));
      }
      return { coefficients, constant: binary(node.op, left.constant, right.constant) };
    }
    if (node.op === '*') {
      const leftDepends = depends(node.left), rightDepends = depends(node.right);
      if (leftDepends && rightDepends) return null;
      const form = decompose(leftDepends ? node.left : node.right);
      if (!form) return null;
      const scalar = leftDepends ? node.right : node.left;
      const multiply = (term: ExpressionNode) => leftDepends ? binary('*', term, scalar) : binary('*', scalar, term);
      return { coefficients: new Map([...form.coefficients].map(([name, coefficient]) => [name, multiply(coefficient)])), constant: multiply(form.constant) };
    }
    if (node.op === '/' && !depends(node.right)) {
      const form = decompose(node.left);
      if (!form) return null;
      return { coefficients: new Map([...form.coefficients].map(([name, coefficient]) => [name, binary('/', coefficient, node.right)])), constant: binary('/', form.constant, node.right) };
    }
    return null;
  }
  const form = decompose(expression.node);
  if (!form) return null;
  return {
    coefficients: new Map([...form.coefficients].map(([name, node]) => [name, expressionFromNode(node, `coefficient of ${name} in ${source}`)])),
    constant: expressionFromNode(form.constant, `constant part of ${source}`),
  };
}

export function affineEquation(source: string, names: readonly string[]): AffineForm | null {
  return affineExpression(residual(source), names, source);
}
