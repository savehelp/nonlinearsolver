/** Split the Y list only at top-level commas, preserving function arguments. */
export function yExpressions(source: string): string[] {
  const expressions: string[] = []; let depth = 0, start = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '(') depth++;
    if (source[i] === ')') depth--;
    if (source[i] === ',' && depth === 0) { expressions.push(source.slice(start, i).trim()); start = i + 1; }
  }
  expressions.push(source.slice(start).trim());
  if (expressions.some(expression => !expression)) throw new Error('Enter Y expressions separated by commas, for example: y, y^2, max(y, 0).');
  if (expressions.length > 16) throw new Error('Plot up to 16 Y expressions at a time.');
  return expressions;
}
