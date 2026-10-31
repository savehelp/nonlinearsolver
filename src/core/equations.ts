import { equationStatements } from './expression';

export interface EquationProgram { equations: string[]; conditions: string[] }

/** A statement without an assignment is a validity condition when its outer
 * expression is a comparison or a logical operation. Comparisons inside an
 * equation's if()/ternary expression remain part of that equation. */
function condition(source: string): boolean {
  let text = source.trim();
  while (text.startsWith('(') && text.endsWith(')')) {
    let depth = 0, wraps = true;
    for (let i = 0; i < text.length - 1; i++) {
      if (text[i] === '(') depth++;
      if (text[i] === ')') depth--;
      if (depth === 0) { wraps = false; break; }
    }
    if (!wraps) break;
    text = text.slice(1, -1).trim();
  }
  if (text.startsWith('!') && !text.startsWith('!=')) return true;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    else if (!depth && /[<>&|]/.test(text[i])) return true;
    else if (!depth && ['==', '!='].includes(text.slice(i, i + 2))) return true;
  }
  return false;
}

export function equationProgram(source: string): EquationProgram {
  const program: EquationProgram = { equations: [], conditions: [] };
  for (const statement of equationStatements(source)) {
    const explicit = /^valid\s+(.+)$/s.exec(statement);
    if (explicit) { program.conditions.push(explicit[1]); continue; }
    if (!/(?<![<>=!])=(?!=)/.test(statement) && condition(statement)) program.conditions.push(statement);
    else program.equations.push(statement);
  }
  return program;
}

export function equationAssignment(source: string): { name: string; source: string } | null {
  const equalities = [...source.matchAll(/(?<![<>=!])=(?!=)/g)];
  if (equalities.length !== 1) return null;
  const at = equalities[0].index!, name = source.slice(0, at).trim();
  return /^[A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)?$/.test(name) ? { name, source: source.slice(at + 1).trim() } : null;
}
