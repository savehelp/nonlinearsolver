import type { Scope } from './types';
export type ExpressionNode = { type: 'number'; value: number } | { type: 'variable'; name: string } | { type: 'unary'; op: string; arg: ExpressionNode } | { type: 'binary'; op: string; left: ExpressionNode; right: ExpressionNode } | { type: 'call'; name: string; args: ExpressionNode[] };
type Node = ExpressionNode;
const constants: Scope = { pi: Math.PI, e: Math.E, true: 1, false: 0 };
const functions: Record<string, (...args: number[]) => number> = { abs: Math.abs, sqrt: Math.sqrt, exp: Math.exp, log: Math.log, ln: Math.log, log10: Math.log10, sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2, sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, min: Math.min, max: Math.max, pow: Math.pow, floor: Math.floor, ceil: Math.ceil, sign: Math.sign };
const prefixes: Scope = { p: 1e-12, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };
const precedence: Record<string, number> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '^': 8, '**': 8 };
export interface Expression { evaluate: (scope: Scope) => number; variables: string[]; readonly node: ExpressionNode }
export function compile(source: string): Expression {
  const tokens: string[] = []; let offset = 0;
  while (offset < source.length) {
    if (/\s/.test(source[offset])) { offset++; continue; }
    const match = /^(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[pnumkKMGT]?|[A-Za-z_][A-Za-z_0-9]*|<=|>=|==|!=|&&|\|\||\*\*|[+\-*/^(),<>!?:])/.exec(source.slice(offset));
    if (!match) throw new Error(`Unexpected character “${source[offset]}” in “${source}”.`);
    tokens.push(match[0]); offset += match[0].length;
  }
  let pos = 0; const vars = new Set<string>();
  const take = (expected: string) => { if (tokens[pos++] !== expected) throw new Error(`Expected “${expected}” in “${source}”.`); };
  function parse(min = 0): Node {
    const token = tokens[pos++]; let left: Node;
    if (!token) throw new Error('Incomplete expression.');
    if (token === '-' || token === '+' || token === '!') left = { type: 'unary', op: token, arg: parse(7) };
    else if (token === '(') { left = parse(); take(')'); }
    else if (/^(\d|\.)/.test(token)) { const suffix = token.slice(-1); left = { type: 'number', value: Object.hasOwn(prefixes, suffix) ? Number(token.slice(0, -1)) * prefixes[suffix] : Number(token) }; }
    else if (/^[A-Za-z_]/.test(token)) {
      if (tokens[pos] === '(') {
        pos++; const args: Node[] = [];
        if (tokens[pos] !== ')') { args.push(parse()); while (tokens[pos] === ',') { pos++; args.push(parse()); } }
        take(')');
        if (token !== 'if' && !Object.hasOwn(functions, token)) throw new Error(`Unknown function “${token}”.`);
        if (token === 'if' && args.length !== 3) throw new Error('Use if(condition, whenTrue, whenFalse).');
        left = { type: 'call', name: token, args };
      } else { if (!Object.hasOwn(constants, token)) vars.add(token); left = { type: 'variable', name: token }; }
    } else throw new Error(`Unexpected token “${token}”.`);
    while (pos < tokens.length && (precedence[tokens[pos]] ?? -1) >= min) {
      const op = tokens[pos++], prec = precedence[op]; left = { type: 'binary', op, left, right: parse(prec + (op === '^' || op === '**' ? 0 : 1)) };
    }
    if (min === 0 && tokens[pos] === '?') { pos++; const yes = parse(); take(':'); left = { type: 'call', name: 'if', args: [left, yes, parse()] }; }
    return left;
  }
  const root = parse(); if (pos !== tokens.length) throw new Error(`Unexpected token “${tokens[pos]}”. Use * for multiplication.`);
  return expressionFromNode(root, source, [...vars]);
}

/** Build a safe expression from existing parser nodes, sharing subexpressions
 * rather than expanding/reparsing equation strings during preprocessing. */
export function expressionFromNode(node: ExpressionNode, source = 'generated expression', variables = nodeVariables(node)): Expression {
  return { node, variables, evaluate: scope => { const value = evaluate(node, scope); if (!Number.isFinite(value)) throw new Error(`Non-finite result in “${source}”. Check domains and division by zero.`); return value; } };
}

function nodeVariables(node: ExpressionNode): string[] {
  const variables = new Set<string>(), seen = new Set<ExpressionNode>();
  function visit(current: ExpressionNode): void {
    if (seen.has(current)) return;
    seen.add(current);
    if (current.type === 'variable') { if (!Object.hasOwn(constants, current.name)) variables.add(current.name); }
    else if (current.type === 'unary') visit(current.arg);
    else if (current.type === 'binary') { visit(current.left); visit(current.right); }
    else if (current.type === 'call') current.args.forEach(visit);
  }
  visit(node); return [...variables];
}

function evaluate(node: Node, scope: Scope): number {
    if (node.type === 'number') return node.value;
    if (node.type === 'variable') { const v = Object.hasOwn(scope, node.name) ? scope[node.name] : Object.hasOwn(constants, node.name) ? constants[node.name] : undefined; if (v === undefined) throw new Error(`No value defined for “${node.name}”.`); return v; }
    if (node.type === 'unary') { const v = evaluate(node.arg, scope); return node.op === '-' ? -v : node.op === '!' ? Number(!v) : v; }
    if (node.type === 'call') { if (node.name === 'if') return evaluate(node.args[evaluate(node.args[0], scope) ? 1 : 2], scope); return functions[node.name](...node.args.map(n => evaluate(n, scope))); }
    const a = evaluate(node.left, scope);
    if (node.op === '&&') return a ? Number(Boolean(evaluate(node.right, scope))) : 0;
    if (node.op === '||') return a ? 1 : Number(Boolean(evaluate(node.right, scope)));
    const b = evaluate(node.right, scope);
    switch (node.op) { case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return a / b; case '^': case '**': return a ** b; case '<': return +(a < b); case '>': return +(a > b); case '<=': return +(a <= b); case '>=': return +(a >= b); case '==': return +(a === b); case '!=': return +(a !== b); default: throw new Error('Invalid operator.'); }
}
export function lines(source: string): string[] { return source.split('\n').map(s => s.split('#')[0].trim()).filter(Boolean); }
/** Semicolons delimit equations; newlines within a statement are just whitespace.
 * Legacy input without any semicolons retains top-level newline separators. */
export function equationStatements(source: string): string[] {
  const clean = source.replace(/#[^\r\n]*/g, '');
  if (clean.includes(';')) {
    const parts = clean.split(';');
    if (parts.pop()!.trim()) throw new Error('End every equation with a semicolon (;). Equations may span multiple lines.');
    return parts.map(part => part.trim()).filter(Boolean);
  }
  const statements: string[] = []; let depth = 0, statement = '';
  for (const char of clean) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === '\n' && depth === 0) { if (statement.trim()) statements.push(statement.trim()); statement = ''; }
    else statement += char;
  }
  if (statement.trim()) statements.push(statement.trim());
  return statements;
}
export function equationCount(source: string): number | '—' { try { return equationStatements(source).length; } catch { return '—'; } }
export function residual(source: string): Expression {
  const equality = /(?<![<>=!])=(?!=)/g; const matches = [...source.matchAll(equality)];
  if (matches.length > 1) throw new Error('Use one equality per equation and end each equation with a semicolon (;).');
  if (!matches.length) return compile(source);
  const i = matches[0].index!; return compile(`(${source.slice(0, i)})-(${source.slice(i + 1)})`);
}
